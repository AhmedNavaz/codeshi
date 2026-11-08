import { createHash, randomUUID } from 'node:crypto';
import { routingNote } from './broker.mjs';
import { openPlan } from './orchestration.mjs';
import { isAntigravityACP } from './antigravity.mjs';
import { resolveBinary } from './resolve-binary.mjs';

// Prompts queued for a workspace (#32). They run one after another: each with the agent, model, effort, access and
// permission setting chosen when it was queued, never more. A run that reaches a usage limit waits for a reset and
// the queue carries on; any other stop pauses the queue, as does a restart, so queued work never continues blindly.
// The queue lives in the conversation journal, so it survives restarts and runs while the window is closed.
//
// A handoff moves the prompts queued for the agent that ran out to the agent that took over (#93). A moved prompt keeps
// its access and permission setting and takes the new agent's model and effort. Only what the person was shown moves: each
// prompt is matched by a digest of what it was when the offer was made, so one that changed since stays where it is.
export const QUEUE_LIMIT = 20;
const queueDigest = item => createHash('sha256').update(JSON.stringify([item.id, item.text, item.provider, item.model, item.effort, item.mode, item.approvalPolicy, item.attachments, item.billingConfirmed, item.routing || null, item.execution || null])).digest('hex').slice(0, 24);

export class PromptQueue {
  constructor(broker) { this.broker = broker; this.closed = false; this.held = new Set(); }

  // Work queued when the app last closed waits for the person to resume it.
  restore() {
    for (const c of this.broker.conversations.values()) {
      // A prompt whose run was saved before the restart may have reached its agent, and nobody can say. It is never sent
      // again by itself, and saying so leaves the choice with the person (#93).
      for (const item of [...c.queue]) {
        const sent = c.requests[`queue-${item.id}`];
        if (!sent) continue;
        this.broker.record(c, { type: 'queue_started', id: item.id, runId: sent.runId, uncertain: true });
        this.broker.message(c, 'system', `A queued prompt was being sent when Codeshi stopped, so it wasn't sent again: “${item.text.slice(0, 80)}”. Check its run before sending it yourself.`, item.provider);
      }
      if (c.queue.length && !c.queuePaused) this.pause(c, 'Codeshi restarted while prompts were queued.');
    }
  }

  pause(c, reason) {
    this.broker.record(c, { type: 'queue_pause', reason: String(reason).slice(0, 300) });
    this.broker.emit('update', { conversationId: c.id });
  }

  item(c, id) {
    const item = c.queue.find(entry => entry.id === id);
    if (!item) throw Object.assign(new Error('This queued prompt has already started or been removed.'), { status: 409 });
    return item;
  }

  act(c, input = {}) {
    const broker = this.broker, action = input.action;
    if (action === 'add') {
      if (c.queue.length >= QUEUE_LIMIT) throw Object.assign(new Error(`A workspace can queue up to ${QUEUE_LIMIT} prompts.`), { status: 409 });
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 100000) throw Object.assign(new Error('Enter a message between 1 and 100,000 characters.'), { status: 400 });
      const provider = input.provider || c.provider, mode = input.mode || c.mode, approvalPolicy = input.approvalPolicy || c.approvalPolicy || 'ask';
      const model = input.model || null, effort = input.effort || null, attachments = Array.isArray(input.attachments) ? input.attachments : [];
      broker.checkRunSettings(provider, mode, approvalPolicy);
      broker.validateSelection(model, 'auto', effort);
      broker.attachments.select(attachments);
      const routing = routingNote(input.routing);
      broker.execution.expect(broker.execution.defaults(c).revision, input.executionRevision);
      const taskId = randomUUID(); broker.execution.ensure(c, taskId, { requestId: input.requestId });
      const execution = broker.execution.token(c, taskId);
      broker.execution.assert(c, execution, { action: routing ? 'routing' : 'manual', provider, model, effort });
      broker.record(c, { type: 'queue_add', item: { id: randomUUID(), execution, text, provider, model, effort, mode, approvalPolicy, attachments, billingConfirmed: input.billingConfirmed === true, ...(routing ? { routing } : {}), createdAt: new Date().toISOString() } });
    } else if (action === 'update') {
      const item = this.item(c, input.id);
      const text = typeof input.text === 'string' ? input.text.trim() : item.text;
      if (!text || text.length > 100000) throw Object.assign(new Error('Enter a message between 1 and 100,000 characters.'), { status: 400 });
      const model = input.model !== undefined ? (input.model || null) : item.model;
      const effort = input.effort !== undefined ? (input.effort || null) : item.effort;
      broker.validateSelection(model, 'auto', effort);
      const clearRouting = Boolean(item.routing && (input.clearRouting || (input.model !== undefined && input.model !== item.model)));
      if (clearRouting && item.execution) {
        const previous = broker.execution.current(c, item.execution.taskId);
        if (previous) broker.record(c, { type: 'execution_policy', policy: { ...previous, mode: 'normal', automation: Object.fromEntries(Object.keys(previous.automation).map(action => [action, false])), revision: previous.revision + 1, authorization: { source: 'explicit-queue-selection', at: new Date().toISOString() } } });
        broker.record(c, { type: 'queue_execution', id: item.id, execution: broker.execution.token(c, item.execution.taskId) });
      }
      broker.record(c, { type: 'queue_update', id: input.id, text, ...(input.model !== undefined ? { model } : {}), ...(input.effort !== undefined ? { effort } : {}), ...(clearRouting ? { clearRouting: true } : {}) });
    } else if (action === 'move') {
      this.item(c, input.id);
      const index = Number(input.index);
      if (!Number.isInteger(index) || index < 0 || index >= c.queue.length) throw Object.assign(new Error('Choose a position in the queue.'), { status: 400 });
      broker.record(c, { type: 'queue_move', id: input.id, index });
    } else if (action === 'remove') {
      this.item(c, input.id);
      broker.record(c, { type: 'queue_remove', id: input.id });
    } else if (action === 'pause') {
      if (!c.queuePaused) this.pause(c, 'You paused the queue.');
    } else if (action === 'resume') {
      if (c.queuePaused) broker.record(c, { type: 'queue_resume' });
    } else throw Object.assign(new Error('Choose add, update, move, remove, pause or resume.'), { status: 400 });
    // An open handoff offer keeps saying what would really move.
    if (c.handoffOffer) c.handoffOffer.queue = this.cover(c, c.handoffOffer.from.provider, c.handoffOffer.to);
    broker.emit('update', { conversationId: c.id });
    this.tick(c);
    return broker.view(c);
  }

  // Starts the next prompt when the workspace is free: nothing running, no wait for a reset, and the queue not paused.
  async tick(c) {
    const broker = this.broker;
    // An open plan holds the queue until it is approved or put away (#12); a message sent by hand still goes ahead.
    if (this.closed || !c.queue.length || c.queuePaused || broker.running || c.resume || this.held.has(c.id) || openPlan(c) || c.runs.some(run => ['building', 'reviewing'].includes(run.automaticReview?.status))) return;
    const item = c.queue[0];
    const digest = queueDigest(item);
    this.held.add(c.id);
    try {
      const input = { text: item.text, provider: item.provider, model: item.model, effort: item.effort, mode: item.mode, approvalPolicy: item.approvalPolicy, attachments: item.attachments, billingConfirmed: item.billingConfirmed, routing: item.routing || null, requestId: `queue-${item.id}` };
      const options = { execution: item.execution, queued: item.id, verifyExecution: () => { const current = c.queue.find(row => row.id === item.id); if (c.queuePaused || current && queueDigest(current) !== digest || !current && !c.requests[`queue-${item.id}`]) throw Object.assign(new Error('The queue changed or was paused before the provider started.'), { status: 409 }); }, verifyRouting: () => { const current = c.queue.find(row => row.id === item.id); if (c.queuePaused || !current || queueDigest(current) !== digest) throw Object.assign(new Error('The queued prompt changed or the queue was paused during assessment.'), { status: 409 }); } };
      const { runId } = item.routing ? await broker.dispatch(c, input, options) : broker.start(c, input, options);
      broker.record(c, { type: 'queue_started', id: item.id, runId });
      broker.emit('update', { conversationId: c.id });
    } catch (error) {
      if (error.status === 409 && broker.running) return;
      this.pause(c, `The next prompt could not start: ${error.message}`);
      broker.emit('notify', { conversationId: c.id, kind: 'stopped', title: 'Queue paused', body: 'The next queued prompt could not start. Open the workspace to see why.' });
    } finally { this.held.delete(c.id); }
  }

  // After a run: carry on when it finished, wait for a reset when it reached a limit, and pause otherwise.
  runEnded(c, run, status) {
    // A handoff stops a run on purpose and continues the task, so the queue waits for that run instead of pausing.
    // A planning run leads to a plan, which holds the queue; it never waits for a reset with planning's read-only access.
    if (run.review || run.orchestrate || run.handoff || !c.queue.length || c.queuePaused) return;
    if (status === 'complete') { setTimeout(() => this.tick(c), 0); return; }
    if (run.errorCategory === 'quota') {
      if (!c.resume) {
        try { this.broker.resume.schedule(c, { providers: this.broker.execution.allows(c, run.execution, { action: 'wait' }) ? this.broker.availableProviders() : [run.provider], execution: run.execution, mode: run.mode, approvalPolicy: run.approvalPolicy, billingConfirmed: run.billingConfirmed === true }); }
        catch (error) { this.pause(c, `Waiting for a reset could not start: ${error.message}`); }
      }
      return;
    }
    this.pause(c, run.budgetStop ? run.budgetStop.message : run.stopped ? 'You stopped the run.' : 'The last run did not finish.');
  }

  // Which prompts a handoff from one agent to another would move, for the offer to name. Prompts for other agents aren't
  // part of it, and neither is one the destination can't run with its access unchanged, which stays and is counted.
  cover(c, from, to) {
    const items = [];
    let stays = 0;
    for (const item of c.queue) {
      if (item.provider !== from) continue;
      if (this.canRun(to.provider, item)) items.push({ id: item.id, digest: queueDigest(item) });
      else stays++;
    }
    if (!items.length && !stays) return null;
    return { count: items.length, stays, items, billingRequired: to.billingSource !== 'subscription' && items.length > 0, digest: createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 24) };
  }
  canRun(provider, item) {
    try { this.broker.checkRunSettings(provider, item.mode, item.approvalPolicy); } catch { return false; }
    if (provider !== 'gemini' || item.mode !== 'read') return true;
    return !isAntigravityACP(resolveBinary('gemini', { override: this.broker.configuredBins.gemini, googleRoot: this.broker.googleRoot }));
  }

  // Moves prompts to the agent that took over, in one record. `covered` is what the person accepted; without it (a handoff
  // already allowed in advance) it is everything queued for that agent right now. An earlier confirmation of charges was
  // for the old agent, so it never carries over: a destination billed per use needs the person's own yes for these prompts.
  // `choose` picks a routed prompt's model again for the new agent.
  async move(c, { from, to, covered = null, billingConfirmed = false, choose = null, verifyExecution = () => {} }) {
    const charged = to.billingSource !== 'subscription';
    this.held.add(c.id);
    try {
      verifyExecution();
      const wanted = (covered || this.cover(c, from, to)?.items || []);
      const routed = new Map();
      if (choose && !(charged && !billingConfirmed)) for (const entry of wanted) {
        const item = c.queue.find(row => row.id === entry.id);
        if (item?.routing && this.broker.execution.allows(c, item.execution, { action: 'routing' })) routed.set(item.id, await choose(item));
      }
      verifyExecution();
      // Nothing is awaited from here until the move is saved, so what's checked is what moves.
      const moves = [], changed = [], stayed = [];
      for (const entry of wanted) {
        const item = c.queue.find(row => row.id === entry.id);
        if (!item) continue;
        if (!this.broker.execution.allows(c, item.execution, { action: covered ? 'manual' : 'handoff', provider: to.provider, model: routed.get(item.id)?.model ?? to.model, effort: routed.get(item.id)?.effort ?? c.efforts[to.provider]?.[to.model || 'default'] ?? null })) { changed.push(item.id); continue; }
        if (item.provider !== from || queueDigest(item) !== entry.digest || !this.canRun(to.provider, item)) { changed.push(item.id); continue; }
        if (charged && !billingConfirmed) { stayed.push(item.id); continue; }
        const choice = routed.get(item.id);
        moves.push({ id: item.id, provider: to.provider, model: choice ? choice.model : to.model ?? null, effort: choice ? choice.effort : c.efforts[to.provider]?.[to.model || 'default'] ?? null, billingConfirmed: charged, movedFrom: from,
          ...(item.routing ? { routing: (({ escalation, ...note }) => ({ ...note, ...(choice ? { tier: choice.tier || note.tier, reason: `Moved at a handoff · ${choice.reason || note.reason}`.slice(0, 300), ...(choice.escalation ? { escalation: choice.escalation } : {}) } : { reason: 'Moved at a handoff' }) }))(item.routing) } : {}) });
      }
      if (moves.length) this.broker.record(c, { type: 'queue_moved', from, to: to.provider, moves });
      return { moved: moves.length, changed: changed.length, stayed: stayed.length };
    } finally { this.held.delete(c.id); }
  }

  close() { this.closed = true; }
}

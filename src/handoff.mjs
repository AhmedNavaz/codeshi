import { createHash, randomUUID } from 'node:crypto';
import { assessQuota } from './task-budget.mjs';
import { continuationRequest } from './context.mjs';
import { accountStatus, listModels, providerUsage } from './providers.mjs';
import { usualWindowSpend } from './usage-watch.mjs';
import '../public/routing.js';
import { limitState, windowApplies } from './resume.mjs';

// Budget-aware handoff (#17). While a cloud run works, its agent's plan usage is checked. Past the threshold, the
// person is offered a switch to another connected agent with room, showing the destination, its model, billing and
// the task it would continue. Switching is never silent: it is an offer unless automatic handoff was allowed in
// advance, and automatic handoff only goes to subscription-billed agents. A destination billed any other way needs
// its own explicit confirmation of charges, separate from accepting the switch.
//
// An offer is bound to the run, the workspace's folders, the saved project context and the destination's settings,
// and is checked again just before switching. A changed task, folder set, destination model, access or billing makes
// it stale: the switch is refused, nothing is started on the destination, and a fresh offer replaces it.
//
// Usage can also jump between checks, or an offer can be missed, so a run may reach its limit anyway (#91). With
// automatic handoff allowed, it then continues on a subscription-billed agent with room, working from what the journal
// saved before the failure. If no agent has room, the task waits for the first reset under the wait's own rules. With
// it off, the person keeps today's choices.
// Checked early, so an agent that is already nearly out is offered before it does much, and often enough that a jump in
// usage rarely reaches the limit between checks.
export const HANDOFF_FIRST_CHECK_MS = 10000;
export const HANDOFF_CHECK_MS = 60000;
// Where a Flow run hands off, by routing mode: the share of a limit used before the task moves to another agent (#107, #128).
export const FLOW_HANDOFF = globalThis.relayRouting.handoffThresholds;
const names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// The task as the offer names it: its first line, cut at a word so it stays short and reads as cut.
const TASK_LENGTH = 100;
export const taskLine = text => {
  const line = String(text || '').trim().split('\n')[0];
  return line.length <= TASK_LENGTH ? line : `${line.slice(0, TASK_LENGTH).replace(/\s+\S*$/, '').replace(/[\s,;:.!?-]+$/, '')}…`;
};
export const highest = (usage, model) => {
  const windows = (usage?.available && Array.isArray(usage.windows) ? usage.windows : []).filter(row => !row.disabled && Number.isFinite(row.usedPercent) && windowApplies(row, model));
  return windows.reduce((top, row) => !top || row.usedPercent > top.usedPercent ? row : top, null);
};

export class HandoffMonitor {
  constructor(broker, { usage = providerUsage, account = accountStatus, models = listModels, preferences = () => ({ threshold: 90, automatic: false }), firstCheckMs = HANDOFF_FIRST_CHECK_MS, checkMs = HANDOFF_CHECK_MS } = {}) {
    Object.assign(this, { broker, usage, account, models, preferences, firstCheckMs, checkMs });
    this.timers = new Map(); this.closed = false;
  }

  watch(run) {
    // Planning never hands off (#12): it is planned again, by whichever agent routing then picks.
    if (this.closed || run.review || run.local || run.orchestrate) return;
    const schedule = delay => { const timer = setTimeout(async () => { await this.check(run).catch(() => {}); if (this.broker.running === run) schedule(this.checkMs); }, delay); timer.unref(); this.timers.set(run.id, timer); };
    schedule(this.firstCheckMs);
  }
  unwatch(run) { clearTimeout(this.timers.get(run.id)); this.timers.delete(run.id); if (run.c.handoffOffer) { run.c.handoffOffer = null; } }

  // The scope an offer is bound to. Progress within the run does not change it; a new task, folders or project context does.
  scope(c, run) { return createHash('sha256').update(JSON.stringify([run.id, this.broker.workspaceSignature, c.context, this.broker.execution.current(c, run.taskId)?.revision])).digest('hex'); }

  // A reading that can't be saved must never get in the way of a handoff.
  observe(c, provider, usage) { try { this.broker.observeQuota(c, provider, usage); } catch (error) { console.error('Codeshi could not save a usage reading:', error.message); } }

  // In Flow a routed run hands off by its mode, with no separate setting (#107, #128): Saver moves the task on early,
  // Ultra holds the strongest model longest, and all three move without asking. Other runs use Settings.
  policy(run) {
    const allowed = this.broker.execution.allows(run.c, run.execution, { action: 'handoff' });
    const mode = allowed ? globalThis.relayRouting.normalizeMode(run?.routing?.mode) || run?.routing?.mode : null;
    if (!allowed) return { ...this.preferences(), automatic: false };
    return mode && FLOW_HANDOFF[mode] ? { threshold: FLOW_HANDOFF[mode], automatic: true, mode } : this.preferences();
  }
  async modelRows(provider, limitMs = 5000) {
    let timer;
    try {
      const result = await Promise.race([this.models(provider, this.broker.usageOptions(provider)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Model lookup timed out.')), limitMs); timer.unref?.(); })]);
      const rows = result?.models || result?.data || result || [];
      return Array.isArray(rows) ? rows : [];
    } finally { clearTimeout(timer); }
  }
  supportsWorkspace(provider, account, run) {
    if (provider !== 'gemini') return true;
    return account.source === 'antigravity-acp' || account.authMode === 'google-oauth'
      ? run.mode !== 'read' && (this.broker.workspaces.length <= 1 || account.capabilities?.additionalDirectories === true)
      : this.broker.workspaces.length <= 6;
  }
  async routedDestination(c, run, exclude) {
    const candidates = [], { mode, threshold } = this.policy(run);
    // Continue the original task, rather than classifying the synthetic "continue" prompt as a new request.
    const request = c.messages.find(message => message.role === 'user' && message.text !== continuationRequest &&
      (message.runId === run.taskId || c.taskOfRun?.[message.runId] === run.taskId)) || c.messages.find(message => message.role === 'user' && message.runId === run.id);
    for (const provider of this.broker.availableProviders().filter(value => value !== run.provider && !exclude.includes(value))) {
      const options = this.broker.usageOptions(provider);
      let account, usage, models;
      try {
        account = await this.account(provider, { bin: options.bin, workspace: this.broker.workspace, googleRoot: this.broker.googleRoot });
        // Automatic moves need subscription billing and a runtime that can see this workspace's folders.
        if (!account?.installed || account.authenticated === false || account.billingSource !== 'subscription' ||
          !this.supportsWorkspace(provider, account, run)) continue;
        usage = await this.usage(provider, options);
        this.observe(c, provider, usage);
        models = await this.modelRows(provider);
      } catch { continue; }
      const allowed = model => this.broker.execution.allows(c, run.execution, { action: 'manual', provider, model }) && !this.broker.budget.refusal(c, { task: { id: run.taskId, relation: 'continuation' }, provider, model, previousProvider: run.provider });
      const allowedModels = models.map(row => row.id || row.model || row.value).filter(id => id && allowed(id));
      if (models.length ? !allowedModels.length : !allowed(null)) continue;
      const usualSpend = usualWindowSpend(c, provider);
      candidates.push({ provider, models, billingSource: account.billingSource, usage, eligible: true, ...(models.length ? { allowedModels } : {}), ...(usualSpend ? { usualSpend } : {}) });
    }
    const choice = globalThis.relayRouting.route({ text: request?.text || '', attachments: request?.attachments?.length || 0, assessment: run.routing?.assessment || null, mode, candidates, quotaThreshold: threshold });
    if (choice.error || choice.quota.state !== 'ok') return null;
    const { quota, bindingWindow, ...routing } = choice;
    return { provider: choice.provider, model: choice.model, effort: choice.effort, routing, mode: run.mode, approvalPolicy: run.approvalPolicy,
      billingSource: 'subscription', usedPercent: quota.usedPercent, quota: quota.state, quotaEvidence: quota };
  }
  async destination(c, run, exclude = []) {
    if (this.policy(run).mode) return this.routedDestination(c, run, exclude);
    const threshold = this.policy(run).threshold;
    let best = null;
    for (const provider of this.broker.availableProviders().filter(value => value !== run.provider && !exclude.includes(value))) {
      const model = c.models[provider] || null, options = this.broker.usageOptions(provider);
      // Never offer a move the task's limits would refuse: the old agent is stopped before the new one starts (#87).
      if (!this.broker.execution.allows(c, run.execution, { action: 'manual', provider, model }) || this.broker.budget.refusal(c, { task: { id: run.taskId, relation: 'continuation' }, provider, model, previousProvider: run.provider })) continue;
      let usage = null; try { usage = await this.usage(provider, options); } catch {}
      this.observe(c, provider, usage);
      const assessment = assessQuota(usage, model, { threshold });
      if (assessment.state === 'exhausted' || assessment.state === 'near') continue;
      let account = null; try { account = await this.account(provider, { bin: options.bin, workspace: this.broker.workspace, googleRoot: this.broker.googleRoot }); } catch {}
      if (!account?.installed || account.authenticated === false || !this.supportsWorkspace(provider, account, run)) continue;
      const binding = globalThis.relayRouting.bindingWindow(assessment);
      const spendability = binding ? binding.spendability : Math.max(0, 100 - (assessment.usedPercent ?? 100));
      const candidate = { provider, model, mode: run.mode, approvalPolicy: run.approvalPolicy, billingSource: account.billingSource || 'unknown', usedPercent: assessment.usedPercent, quota: assessment.state, quotaEvidence: assessment, spendability };
      // Prefer subscription allowance, then the agent with the highest spendability.
      const rank = value => (value.billingSource === 'subscription' ? 0 : 2000) + (value.quota === 'ok' ? 1000 - value.spendability : 1000);
      if (!best || rank(candidate) < rank(best)) best = candidate;
    }
    if (best) delete best.spendability;
    return best;
  }

  async prepareOffer(c, run, usedWindow) {
    const to = await this.destination(c, run);
    if (!to || this.broker.running !== run || !this.broker.execution.allows(c, run.execution, { action: 'manual' })) return null;
    const request = c.messages.find(message => message.runId === run.id && message.role === 'user');
    return {
      id: randomUUID(), createdAt: new Date().toISOString(), runId: run.id, execution: run.execution, scope: this.scope(c, run),
      from: { provider: run.provider, usedPercent: usedWindow.usedPercent, window: usedWindow.label || null, resetsAt: usedWindow.resetsAt || null },
      to, task: taskLine(request?.text), queue: this.broker.queue.cover(c, run.provider, to),
    };
  }

  async offer(c, run, usedWindow) {
    const offer = await this.prepareOffer(c, run, usedWindow);
    if (!offer) return null;
    c.handoffOffer = offer;
    this.broker.emit('update', { conversationId: c.id });
    return c.handoffOffer;
  }

  async check(run) {
    const { c } = run, preferences = this.policy(run);
    if (this.closed || this.broker.running !== run || run.handoffDismissed || run.handoff || c.handoffOffer || !(preferences.threshold > 0)) return;
    let usage = null; try { usage = await this.usage(run.provider, this.broker.usageOptions(run.provider)); } catch {}
    this.observe(c, run.provider, usage);
    // The model the run is really using, which is known once it starts even when the agent's default was left selected.
    const model = c.activeRun?.effectiveModel || c.model || usage?.defaultModel;
    const assessment = assessQuota(usage, model, { threshold: preferences.threshold, now: Date.now(), tier: run.routing?.tier || null });
    const top = highest(usage, model);
    if (!top || !['near', 'exhausted'].includes(assessment.state)) return;
    const offer = await this.prepareOffer(c, run, top);
    if (!offer) return;
    if (preferences.automatic && !run.automaticReview && offer.to.billingSource === 'subscription' && offer.to.quota === 'ok') {
      try {
        await this.executeOffer(c, run, offer, { automatic: true });
        return;
      } catch (err) {}
    }
    if (preferences.automatic && preferences.mode && offer.to.billingSource === 'subscription') return;
    c.handoffOffer = offer;
    this.broker.emit('update', { conversationId: c.id });
    this.broker.emit('notify', { conversationId: c.id, kind: 'handoff', title: 'Usage limit is close', body: `${names[run.provider]} has used ${Math.round(top.usedPercent)}% of its limit. Hand off to ${names[offer.to.provider]}?` });
  }

  async executeOffer(c, run, offer, { billingConfirmed = false, queueBillingConfirmed = false, queueDigest, automatic = false } = {}) {
    const stale = async reason => {
      if (c.handoffOffer === offer) c.handoffOffer = null;
      const top = run && this.broker.running === run ? { usedPercent: offer.from.usedPercent, label: offer.from.window, resetsAt: offer.from.resetsAt } : null;
      const fresh = top ? await this.offer(c, run, top) : null;
      throw Object.assign(new Error(`${reason} Review the updated offer before switching.`), { status: 409, offer: fresh });
    };
    if (!run || run.id !== offer.runId || run.c !== c) await stale('The task changed since this offer was made.');
    if (automatic && run.automaticReview) throw Object.assign(new Error('This build has an approved reviewer. Choose a handoff explicitly to cancel that review sequence.'), { status: 409 });
    if (this.scope(c, run) !== offer.scope) await stale('The task, its folders or the saved project context changed since this offer was made.');
    // The person agreed to the prompts they were shown.
    if (queueDigest !== undefined && queueDigest !== (offer.queue?.digest ?? null)) await stale('The queued prompts changed since this offer was made.');
    const current = await this.destination(c, run);
    if (!current || current.provider !== offer.to.provider || current.model !== offer.to.model || current.effort !== offer.to.effort || current.mode !== offer.to.mode || current.approvalPolicy !== offer.to.approvalPolicy || current.billingSource !== offer.to.billingSource) await stale(`${names[offer.to.provider]} is no longer available with the same settings.`);
    if (automatic && current.quota !== 'ok') await stale(`${names[offer.to.provider]}'s current allowance could not be confirmed.`);
    if (current.quota !== offer.to.quota) await stale(`${names[offer.to.provider]}'s allowance reading changed.`);
    if (offer.to.billingSource !== 'subscription' && (automatic || billingConfirmed !== true)) throw Object.assign(new Error(`${names[offer.to.provider]} is not billed to a subscription. Confirm its charges separately to hand off.`), { status: 409, offer, billingRequired: true });

    this.broker.execution.assert(c, offer.execution, { action: automatic ? 'handoff' : 'manual', provider: offer.to.provider, model: offer.to.model, effort: offer.to.effort });
    run.handoff = offer;
    if (c.handoffOffer === offer) c.handoffOffer = null;
    this.broker.stop(c.id);
    await run.done;
    this.broker.execution.assert(c, offer.execution, { action: automatic ? 'handoff' : 'manual' });
    const queue = await this.moveQueue(c, offer.from.provider, offer.to, { covered: offer.queue?.items || [], billingConfirmed: queueBillingConfirmed === true, verifyExecution: () => this.broker.execution.assert(c, offer.execution, { action: automatic ? 'handoff' : 'manual' }) });
    this.broker.message(c, 'system', `${names[offer.from.provider]} was close to its usage limit, so ${automatic ? 'Codeshi handed' : 'you handed'} the task to ${names[offer.to.provider]}.${this.queueNote(queue, offer.from.provider, offer.to.provider)}`);
    const result = this.broker.start(c, { provider: offer.to.provider, model: offer.to.model, ...(offer.to.routing ? { effort: offer.to.effort, routing: offer.to.routing } : {}), mode: offer.to.mode, approvalPolicy: offer.to.approvalPolicy, fresh: true, text: continuationRequest, billingConfirmed: offer.to.billingSource !== 'subscription' && billingConfirmed === true, requestId: `handoff-${offer.id}` }, { execution: offer.execution, executionAction: automatic ? 'handoff' : 'manual' });
    if (automatic) this.broker.emit('notify', { conversationId: c.id, kind: 'started', title: `Handed off to ${names[offer.to.provider]}`, body: `${names[offer.from.provider]} was close to its usage limit, so the task continues with ${names[offer.to.provider]}.` });
    return result;
  }

  // Revalidates the offer immediately before switching, then stops the run and continues on the destination.
  async accept(c, { offerId, billingConfirmed = false, queueBillingConfirmed = false, queueDigest, automatic = false } = {}) {
    const offer = c.handoffOffer;
    if (!offer || offer.id !== offerId) throw Object.assign(new Error('This handoff offer is no longer current.'), { status: 409, offer: c.handoffOffer || null });
    return this.executeOffer(c, this.broker.running, offer, { billingConfirmed, queueBillingConfirmed, queueDigest, automatic });
  }

  // Moves queued prompts to the agent that took over. A failure here leaves each prompt where it was and the handoff goes on.
  async moveQueue(c, from, to, options = {}) {
    const choose = async item => {
      const fallback = { model: to.model ?? null, effort: c.efforts[to.provider]?.[to.model || 'default'] ?? null };
      try {
        const result = await Promise.race([this.models(to.provider, this.broker.usageOptions(to.provider)), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Timed out')), 5000); timer.unref?.(); })]);
        return globalThis.relayRouting.routeTo(to.provider, result?.models || result?.data || result || [], { text: item.text, attachments: item.attachments?.length || 0, mode: item.routing?.mode }) || fallback;
      } catch { return fallback; }
    };
    try { return await this.broker.queue.move(c, { from, to, choose, ...options }); }
    catch (error) { console.error('Codeshi could not move the queued prompts:', error.message); return { moved: 0, changed: 0, stayed: 0 }; }
  }
  // What the conversation says about the move, so nothing about the queue changes silently.
  queueNote({ moved, changed, stayed }, from, to) {
    const parts = [];
    if (moved) parts.push(`${plural(moved, 'queued prompt')} moved to ${names[to]}.`);
    if (changed) parts.push(`${plural(changed, 'queued prompt')} changed after the offer, so ${changed === 1 ? 'it stays' : 'they stay'} with ${names[from]}.`);
    if (stayed) parts.push(`${plural(stayed, 'queued prompt')} ${stayed === 1 ? 'stays' : 'stay'} with ${names[from]}, because ${names[to]}'s charges weren't accepted for ${stayed === 1 ? 'it' : 'them'}.`);
    return parts.length ? ` ${parts.join(' ')}` : '';
  }
  // Continue with another agent after a limit. Without a separate yes to charges, only a subscription agent takes the prompts.
  async followContinue(c, from, run) {
    if (!c.queue.some(item => item.provider === from)) return;
    const account = await this.account(run.provider, { bin: this.broker.usageOptions(run.provider).bin, workspace: this.broker.workspace, googleRoot: this.broker.googleRoot }).catch(() => null);
    const to = { provider: run.provider, model: c.models[run.provider] || null, billingSource: account?.billingSource || 'unknown' };
    const queue = await this.moveQueue(c, from, to);
    const note = this.queueNote(queue, from, run.provider).trim();
    if (note) this.broker.message(c, 'system', note);
    this.broker.emit('update', { conversationId: c.id });
  }

  // Whether a run that reaches a limit continues by itself: only if allowed in advance, and not for a run the person
  // stopped, a review, a planning run, a local model, a build-then-review sequence, or a run that continued after a
  // reset, which waits again under its own rules.
  atLimit(run) {
    const { threshold, automatic } = this.policy(run);
    return automatic === true && threshold > 0 && !this.closed && !run.stopped && !run.handoff && !run.review && !run.orchestrate && !run.local && !run.automaticReview && !run.resume;
  }

  // Connected agents billed to a subscription, the only ones a task goes to without asking.
  async subscriptionAgents() {
    const rows = await Promise.all(this.broker.availableProviders().map(async provider => {
      const account = await this.account(provider, { bin: this.broker.usageOptions(provider).bin, workspace: this.broker.workspace, googleRoot: this.broker.googleRoot }).catch(() => null);
      return account?.installed && account.authenticated !== false && account.billingSource === 'subscription' ? provider : null;
    }));
    return rows.filter(Boolean);
  }

  // When the limit resets, in words for the conversation: from the stop itself, or else from the agent's plan usage.
  async resetsAt(c, run) {
    let at = run.limitResetsAt || null;
    if (!at) { try { at = limitState(await this.usage(run.provider, this.broker.usageOptions(run.provider)), c.lastRun?.effectiveModel || c.model).resetsAt; } catch {} }
    const time = at ? new Date(at) : null;
    return time && Number.isFinite(time.getTime()) ? time.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
  }

  // After a run stops on a limit: continue on an agent with room, or wait for the first reset. Returns false if neither
  // is possible, so the run ends as any limit does. An agent that already reached its limit during this task is not
  // tried again, so a task can't bounce between two agents whose usage isn't reported.
  async continueAfterLimit(c, run) {
    const done = result => { c.limitSwitching = null; this.broker.emit('update', { conversationId: c.id }); return result; };
    const from = names[run.provider], tried = [...(run.limitChain || []), run.provider];
    try {
      const [to, resets] = await Promise.all([this.destination(c, run, tried), this.resetsAt(c, run)]);
      const limit = `${from} reached its usage limit${resets ? `, which resets ${resets}` : ''}`;
      // The person may have sent something while this was being worked out; theirs goes ahead.
      if (this.closed || this.broker.running || c.lastRun?.id !== run.id || !this.broker.execution.allows(c, run.execution, { action: 'handoff' })) return done(true);
      if (to?.billingSource === 'subscription' && to.quota === 'ok') {
        c.limitSwitching = null;
        // Queued prompts wait for the run that takes over, as after any handoff.
        run.handoff = { atLimit: true };
        const queue = await this.moveQueue(c, run.provider, to, { verifyExecution: () => this.broker.execution.assert(c, run.execution, { action: 'handoff' }) });
        // The person may have sent something while the prompts moved; theirs still goes ahead.
        if (this.closed || this.broker.running || c.lastRun?.id !== run.id || !this.broker.execution.allows(c, run.execution, { action: 'handoff' })) return done(true);
        this.broker.message(c, 'system', `${limit}, so Codeshi handed the task to ${names[to.provider]}.${this.queueNote(queue, run.provider, to.provider)}`);
        this.broker.start(c, { provider: to.provider, model: to.model, ...(to.routing ? { effort: to.effort, routing: to.routing } : {}), mode: to.mode, approvalPolicy: to.approvalPolicy, fresh: true, text: continuationRequest, requestId: `limit-${run.id}` }, { limitChain: tried, execution: run.execution, executionAction: 'handoff' });
        this.broker.emit('notify', { conversationId: c.id, kind: 'started', title: `Handed off to ${names[to.provider]}`, body: `${from} reached its usage limit, so the task continues with ${names[to.provider]}.` });
        return done(true);
      }
      const providers = await this.subscriptionAgents();
      if (this.closed || this.broker.running || c.lastRun?.id !== run.id || !this.broker.execution.allows(c, run.execution, { action: 'handoff' })) return done(true);
      if (!providers.length) return done(false);
      this.broker.resume.schedule(c, { providers, execution: run.execution, mode: run.mode, approvalPolicy: run.approvalPolicy, limited: providers, requireQuota: true });
      this.broker.message(c, 'system', `${limit}, and no other agent has confirmed room, so the task waits for a fresh allowance reading after a reset.`);
      this.broker.emit('notify', { conversationId: c.id, kind: 'waiting', title: 'Waiting for a reset', body: `${from} reached its usage limit and no other agent has room. Codeshi will continue when one does.` });
      return done(true);
    } catch (error) {
      run.handoff = null;
      console.error('Codeshi could not continue after a usage limit:', error.message);
      return done(false);
    }
  }

  dismiss(c, offerId) {
    const run = this.broker.running;
    if (c.handoffOffer?.id === offerId) { c.handoffOffer = null; if (run?.c === c) run.handoffDismissed = true; this.broker.emit('update', { conversationId: c.id }); }
  }

  close() { this.closed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}

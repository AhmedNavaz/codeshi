import { createHash, randomUUID } from 'node:crypto';
import { continuationRequest } from './context.mjs';
import { accountStatus, providerUsage } from './providers.mjs';
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
const names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
// The task as the offer names it: its first line, cut at a word so it stays short and reads as cut.
const TASK_LENGTH = 100;
export const taskLine = text => {
  const line = String(text || '').trim().split('\n')[0];
  return line.length <= TASK_LENGTH ? line : `${line.slice(0, TASK_LENGTH).replace(/\s+\S*$/, '').replace(/[\s,;:.!?-]+$/, '')}…`;
};
export const highest = (usage, model) => {
  const windows = (usage?.available && Array.isArray(usage.windows) ? usage.windows : []).filter(row => typeof row.usedPercent === 'number' && windowApplies(row, model));
  return windows.reduce((top, row) => !top || row.usedPercent > top.usedPercent ? row : top, null);
};

export class HandoffMonitor {
  constructor(broker, { usage = providerUsage, account = accountStatus, preferences = () => ({ threshold: 90, automatic: false }), firstCheckMs = HANDOFF_FIRST_CHECK_MS, checkMs = HANDOFF_CHECK_MS } = {}) {
    Object.assign(this, { broker, usage, account, preferences, firstCheckMs, checkMs });
    this.timers = new Map(); this.closed = false;
  }

  watch(run) {
    if (this.closed || run.review || run.local) return;
    const schedule = delay => { const timer = setTimeout(async () => { await this.check(run).catch(() => {}); if (this.broker.running === run) schedule(this.checkMs); }, delay); timer.unref(); this.timers.set(run.id, timer); };
    schedule(this.firstCheckMs);
  }
  unwatch(run) { clearTimeout(this.timers.get(run.id)); this.timers.delete(run.id); if (run.c.handoffOffer) { run.c.handoffOffer = null; } }

  // The scope an offer is bound to. Progress within the run does not change it; a new task, folders or project context does.
  scope(c, run) { return createHash('sha256').update(JSON.stringify([run.id, this.broker.workspaceSignature, c.context])).digest('hex'); }

  async destination(c, run, exclude = []) {
    const threshold = this.preferences().threshold;
    let best = null;
    for (const provider of this.broker.availableProviders().filter(value => value !== run.provider && !exclude.includes(value))) {
      const model = c.models[provider] || null, options = this.broker.usageOptions(provider);
      let usage = null; try { usage = await this.usage(provider, options); } catch {}
      if (limitState(usage, model).limited === true) continue;
      const top = highest(usage, model);
      if (top && top.usedPercent >= threshold) continue;
      let account = null; try { account = await this.account(provider, { bin: options.bin, workspace: this.broker.workspace, googleRoot: this.broker.googleRoot }); } catch {}
      if (!account?.installed || account.authenticated === false) continue;
      const candidate = { provider, model, mode: run.mode, approvalPolicy: run.approvalPolicy, billingSource: account.billingSource || 'unknown', usedPercent: top?.usedPercent ?? null };
      // Prefer subscription allowance, then the agent with the most room left.
      const rank = value => (value.billingSource === 'subscription' ? 0 : 1000) + (value.usedPercent ?? 50);
      if (!best || rank(candidate) < rank(best)) best = candidate;
    }
    return best;
  }

  async offer(c, run, usedWindow) {
    const to = await this.destination(c, run);
    if (!to || this.broker.running !== run) return null;
    const request = c.messages.find(message => message.runId === run.id && message.role === 'user');
    c.handoffOffer = {
      id: randomUUID(), createdAt: new Date().toISOString(), runId: run.id, scope: this.scope(c, run),
      from: { provider: run.provider, usedPercent: usedWindow.usedPercent, window: usedWindow.label || null, resetsAt: usedWindow.resetsAt || null },
      to, task: taskLine(request?.text),
    };
    this.broker.emit('update', { conversationId: c.id });
    return c.handoffOffer;
  }

  async check(run) {
    const { c } = run, preferences = this.preferences();
    if (this.closed || this.broker.running !== run || run.handoffDismissed || run.handoff || c.handoffOffer || !(preferences.threshold > 0)) return;
    let usage = null; try { usage = await this.usage(run.provider, this.broker.usageOptions(run.provider)); } catch {}
    // The model the run is really using, which is known once it starts even when the agent's default was left selected.
    const top = highest(usage, c.activeRun?.effectiveModel || c.model);
    if (!top || top.usedPercent < preferences.threshold) return;
    const offer = await this.offer(c, run, top);
    if (!offer) return;
    if (preferences.automatic && !run.automaticReview && offer.to.billingSource === 'subscription') {
      try { await this.accept(c, { offerId: offer.id, automatic: true }); return; } catch {}
    }
    this.broker.emit('notify', { conversationId: c.id, kind: 'handoff', title: 'Usage limit is close', body: `${names[run.provider]} has used ${Math.round(top.usedPercent)}% of its limit. Hand off to ${names[offer.to.provider]}?` });
  }

  // Revalidates the offer immediately before switching, then stops the run and continues on the destination.
  async accept(c, { offerId, billingConfirmed = false, automatic = false } = {}) {
    const run = this.broker.running, offer = c.handoffOffer;
    if (!offer || offer.id !== offerId) throw Object.assign(new Error('This handoff offer is no longer current.'), { status: 409, offer: c.handoffOffer || null });
    const stale = async reason => {
      c.handoffOffer = null;
      const top = run && this.broker.running === run ? { usedPercent: offer.from.usedPercent, label: offer.from.window, resetsAt: offer.from.resetsAt } : null;
      const fresh = top ? await this.offer(c, run, top) : null;
      throw Object.assign(new Error(`${reason} Review the updated offer before switching.`), { status: 409, offer: fresh });
    };
    if (!run || run.id !== offer.runId || run.c !== c) await stale('The task changed since this offer was made.');
    if (automatic && run.automaticReview) throw Object.assign(new Error('This build has an approved reviewer. Choose a handoff explicitly to cancel that review sequence.'), { status: 409 });
    if (this.scope(c, run) !== offer.scope) await stale('The task, its folders or the saved project context changed since this offer was made.');
    const current = await this.destination(c, run);
    if (!current || current.provider !== offer.to.provider || current.model !== offer.to.model || current.mode !== offer.to.mode || current.approvalPolicy !== offer.to.approvalPolicy || current.billingSource !== offer.to.billingSource) await stale(`${names[offer.to.provider]} is no longer available with the same settings.`);
    if (offer.to.billingSource !== 'subscription' && (automatic || billingConfirmed !== true)) throw Object.assign(new Error(`${names[offer.to.provider]} is not billed to a subscription. Confirm its charges separately to hand off.`), { status: 409, offer, billingRequired: true });

    run.handoff = offer; c.handoffOffer = null;
    this.broker.stop(c.id);
    await run.done;
    this.broker.message(c, 'system', `${names[offer.from.provider]} was close to its usage limit, so ${automatic ? 'Codeshi handed' : 'you handed'} the task to ${names[offer.to.provider]}.`);
    const result = this.broker.start(c, { provider: offer.to.provider, model: offer.to.model, mode: offer.to.mode, approvalPolicy: offer.to.approvalPolicy, fresh: true, text: continuationRequest, billingConfirmed: offer.to.billingSource !== 'subscription' && billingConfirmed === true, requestId: `handoff-${offer.id}` });
    if (automatic) this.broker.emit('notify', { conversationId: c.id, kind: 'started', title: `Handed off to ${names[offer.to.provider]}`, body: `${names[offer.from.provider]} was close to its usage limit, so the task continues with ${names[offer.to.provider]}.` });
    return result;
  }

  // Whether a run that reaches a limit continues by itself: only if allowed in advance, and not for a run the person
  // stopped, a review, a local model, a build-then-review sequence, or a run that continued after a reset, which waits
  // again under its own rules.
  atLimit(run) {
    const { threshold, automatic } = this.preferences();
    return automatic === true && threshold > 0 && !this.closed && !run.stopped && !run.handoff && !run.review && !run.local && !run.automaticReview && !run.resume;
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
      if (this.closed || this.broker.running || c.lastRun?.id !== run.id) return done(true);
      if (to?.billingSource === 'subscription') {
        c.limitSwitching = null;
        // Queued prompts wait for the run that takes over, as after any handoff.
        run.handoff = { atLimit: true };
        this.broker.message(c, 'system', `${limit}, so Codeshi handed the task to ${names[to.provider]}.`);
        this.broker.start(c, { provider: to.provider, model: to.model, mode: to.mode, approvalPolicy: to.approvalPolicy, fresh: true, text: continuationRequest, requestId: `limit-${run.id}` }, { limitChain: tried });
        this.broker.emit('notify', { conversationId: c.id, kind: 'started', title: `Handed off to ${names[to.provider]}`, body: `${from} reached its usage limit, so the task continues with ${names[to.provider]}.` });
        return done(true);
      }
      const providers = await this.subscriptionAgents();
      if (this.closed || this.broker.running || c.lastRun?.id !== run.id) return done(true);
      if (!providers.length) return done(false);
      this.broker.resume.schedule(c, { providers, mode: run.mode, approvalPolicy: run.approvalPolicy, limited: tried });
      this.broker.message(c, 'system', `${limit}, and no other agent has room, so the task continues at the first reset.`);
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

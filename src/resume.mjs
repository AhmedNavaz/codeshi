import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { continuationRequest } from './context.mjs';
import '../public/routing.js';
import { providerUsage } from './providers.mjs';

// Resuming after a usage limit (#32). When a run stops on a limit, the conversation can wait for an agent to have room
// again and then continue the unfinished task on whichever agent is ready first, from the shared conversation.
//
// - Reset times come from each agent's plan usage. An agent that reports no reset time is checked again every ten
//   minutes; reading usage does not use the allowance.
// - The resumed run uses the access and permission setting chosen when it was scheduled. It is never raised: with
//   "Ask for permission" the run pauses at its first approval and the person is notified.
// - A wait ends after a day, and a resumed run that stops on a limit again waits again, at most three times.
export const RESUME_CHECK_MS = 10 * 60 * 1000;
export const RESUME_EXPIRES_MS = 24 * 60 * 60 * 1000;
export const RESUME_ATTEMPTS = 3;
const names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };

// Whether plan usage shows the agent limited for this model, and when every full window resets.
// `limited` is null when the agent reports no usage, so its state is unknown.
// Whether a usage window limits this model. A window can name one model (scope) or several (scopes, where an empty list
// matches none); with neither it covers the whole account. An exhausted window for another model says nothing about this one.
export function windowApplies(row, model) {
  const name = String(model || '').toLowerCase();
  return Array.isArray(row.scopes) ? row.scopes.some(scope => name.includes(String(scope).toLowerCase())) : !row.scope || name.includes(String(row.scope).toLowerCase());
}

export function limitState(usage, model = null) {
  const windows = (usage?.available && Array.isArray(usage.windows) ? usage.windows : []).filter(row => !row.disabled && windowApplies(row, model));
  if (!windows.length) return { limited: null, resetsAt: null };
  const full = windows.filter(row => typeof row.usedPercent === 'number' && row.usedPercent >= 100);
  if (!full.length) return { limited: false, resetsAt: null };
  const times = full.map(row => Date.parse(row.resetsAt)).filter(Number.isFinite);
  return { limited: true, resetsAt: times.length === full.length ? new Date(Math.max(...times)).toISOString() : null };
}

export class ResumeScheduler {
  constructor(broker, { usage = providerUsage, now = () => Date.now(), checkMs = RESUME_CHECK_MS, tickMs = 30000 } = {}) {
    Object.assign(this, { broker, usage, now, checkMs, tickMs });
    this.status = new Map(); this.timer = null; this.checking = null; this.closed = false;
    this.marker = path.join(broker.dataDir, 'resume-pending');
  }

  pending() { return [...this.broker.conversations.values()].filter(c => c.resume); }
  get waiting() { return this.pending().length; }

  // The marker lets the app reopen this workspace at startup, so a wait survives a restart.
  arm() {
    if (this.closed) return;
    const waiting = this.pending().length > 0;
    try { if (waiting) fs.writeFileSync(this.marker, ''); else fs.rmSync(this.marker, { force: true }); } catch {}
    if (waiting && !this.timer) { this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref(); }
    if (!waiting && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // limited: agents that also reached a limit during this task, which aren't taken as ready just for reporting no usage.
  schedule(c, { providers, mode = c.mode, approvalPolicy = c.approvalPolicy || 'ask', billingConfirmed = false, limited = [], requireQuota = false, execution = null } = {}) {
    if (c.lastRun?.errorCategory !== 'quota' || this.broker.running?.c.id === c.id) throw Object.assign(new Error('Waiting for a reset is available after a run stops on a usage limit.'), { status: 409 });
    const chosen = [...new Set(Array.isArray(providers) ? providers : [])].filter(provider => this.broker.availableProviders().includes(provider));
    execution ||= this.broker.execution.token(c, c.lastRun?.taskId || c.lastRun?.id);
    this.broker.execution.assert(c, execution, { action: 'manual' });
    const delegated = this.broker.execution.allows(c, execution, { action: 'wait' });
    if (!delegated && (chosen.length !== 1 || chosen[0] !== c.lastRun.provider)) throw Object.assign(new Error('Normal can wait only for the explicitly selected agent. Choose Flow to delegate reset selection.'), { status: 409 });
    if (!chosen.length) throw Object.assign(new Error('Choose at least one connected agent to continue with.'), { status: 400 });
    for (const provider of chosen) this.broker.checkRunSettings(provider, mode, approvalPolicy);
    if (c.resume) this.end(c, 'replaced');
    const at = this.now();
    const resume = { id: randomUUID(), createdAt: new Date(at).toISOString(), expiresAt: new Date(at + RESUME_EXPIRES_MS).toISOString(), providers: chosen, execution, selection: { provider: c.lastRun.provider, model: c.lastRun.model, effort: c.lastRun.effort ?? null }, delegated, mode, approvalPolicy, billingConfirmed: billingConfirmed === true, attempts: c.resumeAttempts || 0, ...(limited.length ? { limited } : {}), ...(requireQuota ? { requireQuota: true } : {}) };
    this.broker.record(c, { type: 'resume', resume });
    this.status.delete(c.id);
    this.arm(); this.tick();
    return this.broker.view(c);
  }

  cancel(c) { if (c.resume) this.end(c, 'cancelled'); return this.broker.view(c); }

  end(c, outcome, details = {}) {
    if (!c.resume) return;
    this.broker.record(c, { type: 'resume_end', id: c.resume.id, outcome, ...details });
    this.status.delete(c.id);
    this.broker.emit('update', { conversationId: c.id });
    this.arm();
  }

  // What the person sees while waiting: each agent's state and the next check.
  view(c) {
    const status = this.status.get(c.id);
    return status ? { agents: Object.fromEntries(status.agents), nextCheckAt: status.nextCheckAt ? new Date(status.nextCheckAt).toISOString() : null } : { agents: {}, nextCheckAt: null };
  }

  tick() {
    if (this.closed) return Promise.resolve();
    this.checking ||= this.check().finally(() => { this.checking = null; this.arm(); });
    return this.checking;
  }

  async check() {
    for (const c of this.pending()) {
      if (this.closed) return;
      if (this.now() >= Date.parse(c.resume.expiresAt)) {
        this.broker.message(c, 'error', 'Codeshi stopped waiting for a usage limit to reset after a day. Continue when you are ready.');
        this.notify(c, 'expired', 'Stopped waiting for a reset', 'No agent had room within a day. Continue when you are ready.');
        this.end(c, 'expired'); continue;
      }
      if (this.broker.running) continue;
      const waitingId = c.resume.id, provider = await this.firstReady(c);
      if (provider && c.resume?.id === waitingId && !this.broker.running) this.launch(c, provider);
    }
  }

  async firstReady(c) {
    const resume = c.resume, status = this.status.get(c.id) || { agents: new Map(), checks: new Map(), nextCheckAt: null };
    this.status.set(c.id, status);
    const now = this.now();
    let ready = null;
    for (const provider of resume.providers) {
      const known = status.agents.get(provider), due = status.checks.get(provider) ?? 0;
      let state = known;
      if (!known || now >= due) {
        const model = resume.selection?.provider === provider ? resume.selection.model : provider === c.provider ? c.model : c.models[provider] || null;
        const effort = resume.selection?.provider === provider ? resume.selection.effort : c.efforts[provider]?.[model || 'default'] ?? null;
        if (!this.broker.execution.allows(c, resume.execution, { action: resume.delegated ? 'wait' : 'manual', provider, model, effort }) || !this.broker.budget.allows(c, provider, model).allowed) continue;
        let usage = null;
        try { usage = await this.usage(provider, this.broker.usageOptions(provider)); } catch {}
        state = { ...limitState(usage, model), checkedAt: new Date(now).toISOString() };
        if (resume.requireQuota) {
          const quota = globalThis.relayRouting.assessQuota(usage, model, { now, threshold: 95 });
          state.quota = quota.state;
          if (quota.state !== 'ok') state.limited = true;
        }
        // An agent that reports no usage is judged by the limit that stopped it, if it reported one.
        if (state.limited === null && (c.lastRun?.provider === provider || resume.limited?.includes(provider))) {
          const reset = c.lastRun?.provider === provider ? Number(c.lastRun.rateLimit?.resetsAt) * 1000 : NaN;
          state = Number.isFinite(reset) && reset > 0 ? { ...state, limited: now < reset, resetsAt: new Date(reset).toISOString() } : { ...state, limited: now < Date.parse(resume.createdAt) + this.checkMs };
        }
        status.agents.set(provider, state);
        const reset = Date.parse(state.resetsAt);
        status.checks.set(provider, state.limited && Number.isFinite(reset) && reset > now ? Math.min(reset + 15000, now + this.checkMs) : now + this.checkMs);
      }
      if (!ready && state.limited !== true) ready = provider;
    }
    status.nextCheckAt = status.checks.size ? Math.min(...status.checks.values()) : now + this.checkMs;
    this.broker.emit('update', { conversationId: c.id });
    return ready;
  }

  launch(c, provider) {
    const resume = c.resume, model = resume.selection?.provider === provider ? resume.selection.model : provider === c.provider ? c.model : c.models[provider] || null;
    const effort = resume.selection?.provider === provider ? resume.selection.effort : c.efforts[provider]?.[model || 'default'] ?? null;
    try {
      this.broker.execution.assert(c, resume.execution, { action: resume.delegated ? 'wait' : 'manual', provider, model, effort });
      this.broker.message(c, 'system', `${names[provider]} has room again, so Codeshi is continuing the task.`);
      const { runId } = this.broker.start(c, { provider, mode: resume.mode, approvalPolicy: resume.approvalPolicy, fresh: true, text: continuationRequest, model, effort, billingConfirmed: resume.billingConfirmed, requestId: `resume-${resume.id}` }, { resume, execution: resume.execution, executionAction: resume.delegated ? 'wait' : 'manual' });
      this.end(c, 'started', { provider, runId });
      this.notify(c, 'started', `Continuing with ${names[provider]}`, `${names[provider]} has room again, so the unfinished task is continuing.`);
    } catch (error) {
      if (error.status === 409 && this.broker.running) return;
      this.broker.message(c, 'error', `Codeshi could not continue with ${names[provider]}: ${error.message}`);
      this.notify(c, 'failed', 'Could not continue the task', error.message);
      this.end(c, 'failed', { provider, reason: String(error.message).slice(0, 500) });
    }
  }

  // A resumed run that reaches another limit waits again while attempts remain. Returns whether it is waiting,
  // so the broker does not also report the run as stopped.
  runEnded(c, run) {
    if (!this.broker.execution.allows(c, run.execution, { action: run.resume?.delegated ? 'wait' : 'manual' }) || !run.resume || run.errorCategory !== 'quota' || (run.resume.attempts || 0) + 1 >= RESUME_ATTEMPTS || Date.parse(run.resume.expiresAt) <= this.now()) return false;
    const provider = names[run.provider] || run.provider;
    const resume = { ...run.resume, id: randomUUID(), attempts: (run.resume.attempts || 0) + 1 };
    this.broker.record(c, { type: 'resume', resume });
    this.notify(c, 'waiting', 'Waiting for another reset', `${provider} reached a limit again. Codeshi will continue when an agent has room.`);
    this.arm();
    return true;
  }

  notify(c, kind, title, body) { this.broker.emit('notify', { conversationId: c.id, kind, title, body }); }

  close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}

import { randomUUID } from 'node:crypto';

// Execution authority is independent of layout, tool access and billing. Policies live in the existing journal;
// every asynchronous decision carries a revision and checks it again immediately before starting a process.
const fail = message => Object.assign(new Error(message), { status: 409, category: 'execution-policy' });
const actions = ['routing', 'handoff', 'retry', 'review', 'check', 'wait', 'children'];
const providers = ['codex', 'claude', 'gemini'];
const routingMode = value => ({ saving: 'saver', balanced: 'smart', quality: 'ultra' })[value] || value;

export function executionConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Choose a task execution policy.');
  const mode = input.mode || 'normal', routing = routingMode(input.routingMode || 'smart');
  if (!['normal', 'flow'].includes(mode) || !['saver', 'smart', 'ultra'].includes(routing)) throw fail('Choose Normal or Flow and a supported routing preference.');
  const allowedProviders = input.allowedProviders ?? null, allowedModels = input.allowedModels || {};
  if (allowedProviders !== null && (!Array.isArray(allowedProviders) || !allowedProviders.length || allowedProviders.some(value => !providers.includes(value)))) throw fail('Choose supported providers for this task.');
  if (typeof allowedModels !== 'object' || Array.isArray(allowedModels) || Object.entries(allowedModels).some(([key, list]) => !providers.includes(key) || !Array.isArray(list) || !list.length || list.some(value => typeof value !== 'string' || !value.trim() || value.length > 200))) throw fail('Choose model identifiers for this task.');
  const override = input.override || null;
  if (override && (!['step', 'pinned'].includes(override.scope) || !providers.includes(override.provider) || (override.model != null && (typeof override.model !== 'string' || override.model.length > 200)) || (override.effort != null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(override.effort)))) throw fail('Choose a one-step or pinned provider, model and effort override.');
  return { version: 1, mode, routingMode: routing, automation: Object.fromEntries(actions.map(action => [action, mode === 'flow' && input.automation?.[action] !== false])), allowedProviders: allowedProviders ? [...new Set(allowedProviders)] : null, allowedModels: structuredClone(allowedModels), override: override ? { scope: override.scope, provider: override.provider, model: override.model || null, effort: override.effort || null } : null };
}

export class ExecutionPolicies {
  constructor(broker) { this.broker = broker; }
  defaults(c) { return c.executionDefault || { ...executionConfig(), revision: 0 }; }
  current(c, taskId) { return c.executionPolicies?.[taskId] || null; }
  active(c) { return this.current(c, c.routingPending?.taskId || c.activeRun?.taskId || c.lastRun?.taskId); }
  view(c) { return { defaults: this.defaults(c), active: this.active(c), policies: Object.values(c.executionPolicies || {}).slice(-50) }; }
  expect(actual, expected) { if (expected !== undefined && actual !== expected) throw fail('Execution policy changed. Refresh this task before authorizing more work.'); }
  setDefault(c, input, { expectedRevision, source = 'user' } = {}) {
    const previous = this.defaults(c); this.expect(previous.revision, expectedRevision);
    const policy = { ...executionConfig(input), revision: previous.revision + 1, authorization: { source, at: new Date().toISOString() } };
    this.broker.record(c, { type: 'execution_default', policy });
    return policy;
  }
  ensure(c, taskId, { config = this.defaults(c), source = 'user', requestId = null } = {}) {
    if (this.current(c, taskId)) return this.current(c, taskId);
    const policy = { ...executionConfig(config), taskId, revision: 1, authorization: { source, requestId, at: new Date().toISOString() } };
    this.broker.record(c, { type: 'execution_policy', policy }); return policy;
  }
  token(c, taskId) { const policy = this.current(c, taskId); return policy ? { taskId, revision: policy.revision } : null; }
  assert(c, token, { action = 'manual', provider, model, effort, sequence = false } = {}, prospective = null) {
    const policy = token && (this.current(c, token.taskId) || prospective);
    if (!policy || policy.revision !== token.revision) throw fail('Task authority changed. This pending decision was revoked; choose the next action manually.');
    if (action !== 'manual' && !(sequence && ['review', 'check'].includes(action)) && !policy.automation[action]) throw fail(`${policy.mode === 'normal' ? 'Normal requires an explicit next action' : 'This task does not authorize ' + action}. Choose the agent or update its execution policy.`);
    if (provider && (policy.allowedProviders && !policy.allowedProviders.includes(provider) || policy.allowedModels[provider] && !policy.allowedModels[provider].includes(model))) throw fail('This provider or model is outside the task execution policy.');
    const override = policy.override;
    if (provider && override && (override.scope === 'pinned' || !policy.overrideUsed) && (provider !== override.provider || (model || null) !== override.model || (effort ?? null) !== override.effort)) throw fail('This task has an explicit provider, model and effort override.');
    return policy;
  }
  allows(c, token, options) { try { this.assert(c, token, options); return true; } catch { return false; } }
  change(c, { taskId, revision, policy: input, action } = {}) {
    if (!taskId && !Number.isSafeInteger(revision)) throw fail('Refresh the execution defaults before changing them.');
    if (!taskId) { this.setDefault(c, input || {}, { expectedRevision: revision }); this.broker.emit('update', { conversationId: c.id }); return this.broker.view(c); }
    const previous = this.current(c, taskId);
    if (!previous) throw fail('Select a recorded task before changing its execution policy.');
    this.expect(previous.revision, revision);
    if (!Number.isSafeInteger(revision)) throw fail('Refresh the task policy before changing it.');
    const policy = { ...executionConfig(action === 'takeover' ? { ...previous, mode: 'normal', override: null } : input), taskId, revision: revision + 1, authorization: { source: action === 'takeover' ? 'manual-takeover' : 'user', at: new Date().toISOString() } };
    this.broker.record(c, { type: 'execution_policy', policy });
    // Revoking a task never stops an already running native turn. Pending routing is only a selection, so cancel it.
    if (c.resume?.execution?.taskId === taskId) this.broker.resume.cancel(c);
    c.handoffOffer = null;
    if (c.retryOffer) this.broker.record(c, { type: 'retry_offer_end', id: c.retryOffer.id, outcome: 'policy-changed' });
    if (action === 'takeover') {
      this.setDefault(c, { ...this.defaults(c), mode: 'normal', override: null });
      this.broker.record(c, { type: 'routing', routing: null });
      for (const item of c.queue.filter(item => item.routing && item.execution)) {
        const queued = this.current(c, item.execution.taskId);
        if (queued && queued.taskId !== taskId) this.broker.record(c, { type: 'execution_policy', policy: { ...queued, mode: 'normal', automation: Object.fromEntries(actions.map(action => [action, false])), revision: queued.revision + 1, authorization: policy.authorization } });
      }
    }
    if (c.queue.some(item => item.routing) && !c.queuePaused) this.broker.queue.pause(c, 'Task authority changed. Review automatic queued decisions before resuming.');
    for (const run of c.runs.filter(run => run.taskId === taskId)) this.broker.automaticReviews?.invalidate(c, run, 'Task authority changed. Choose the next review manually.');
    const pending = this.broker.running;
    if (pending?.purpose === 'routing' && pending.taskId === taskId) { pending.stopped = true; if (pending.child) this.broker.cancel(pending); }
    this.broker.emit('update', { conversationId: c.id });
    return this.broker.view(c);
  }
  // Migrate only work already authorized before this version. New sends use Normal until explicitly delegated.
  migrate(c) {
    if (c.executionMigrated) return;
    if (!c.runs.some(run => !this.current(c, run.taskId || run.id)) && !c.queue.some(item => !item.execution) && !(c.resume && !c.resume.execution)) return;
    const runs = c.runs.map(run => run.id === c.lastRun?.id ? { ...run, ...c.lastRun } : run.id === c.activeRun?.id ? { ...run, ...c.activeRun } : run);
    for (const run of runs) {
      const taskId = run.taskId || run.id;
      this.ensure(c, taskId, { source: 'legacy-recovery', config: { mode: run.routing || this.broker.handoffPreferences?.().automatic ? 'flow' : 'normal', routingMode: run.routing?.mode, automation: run.routing ? undefined : { routing: false, retry: false, review: false, check: false, children: false } } });
    }
    for (const item of c.queue) if (!item.execution) {
      const taskId = randomUUID(); this.ensure(c, taskId, { source: 'legacy-queue', config: { mode: item.routing ? 'flow' : 'normal', routingMode: item.routing?.mode } });
      this.broker.record(c, { type: 'queue_execution', id: item.id, execution: this.token(c, taskId) });
    }
    if (c.resume && !c.resume.execution) {
      const taskId = c.lastRun?.taskId || c.lastRun?.id;
      if (taskId) this.broker.record(c, { type: 'resume', resume: { ...c.resume, execution: this.token(c, taskId), legacy: true } });
    }
    this.broker.record(c, { type: 'execution_migrated' });
  }
}

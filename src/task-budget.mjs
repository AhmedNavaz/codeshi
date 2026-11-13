import { createHash } from 'node:crypto';
import path from 'node:path';
import { commandOutcome } from './tool-outcomes.mjs';
import { normalizeUsage } from './task-ledger.mjs';
import '../public/routing.js';

// One policy for a whole task (#87), however many agents, retries and reviews it takes. Every run starts through the broker,
// and the broker asks here first, so no caller can go around it. All counters are worked out from journal records, which
// means they survive a restart and belong to the task, not the agent: changing agents can't reset them.
//
// A new prompt is a new task, so it only meets the rules on which agents are allowed. The limits apply to what follows it.
// With measured limits, a run is stopped as soon as an agent reports going over. Agents report as they go, so a run can
// overshoot a little, and what it really used is shown rather than hidden.
export const defaultPolicy = () => ({ allowedProviders: null, allowedModels: null, maxConcurrent: 2, maxWorkingMinutes: null, maxTokens: null, maxSpendUSD: null, maxRetries: 3, maxReviews: 5, maxHandoffs: 4, maxRepeatedFailures: 5 });
const COUNT_LIMITS = ['maxConcurrent', 'maxRetries', 'maxReviews', 'maxHandoffs', 'maxRepeatedFailures'], MEASURED_LIMITS = ['maxWorkingMinutes', 'maxTokens', 'maxSpendUSD'];
const EXTEND = { maxRetries: 2, maxReviews: 2, maxHandoffs: 2, maxRepeatedFailures: 3 }, TASK_LIMIT = 60, FAILURE_LIMIT = 50;
const PROVIDER_KEYS = ['codex', 'claude', 'gemini', 'local'], NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', local: 'Local models' };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function validatePolicy(input = {}, current = defaultPolicy()) {
  const next = { ...defaultPolicy(), ...current };
  for (const key of COUNT_LIMITS) if (input[key] !== undefined) {
    if (!Number.isInteger(input[key]) || input[key] < (key === 'maxConcurrent' || key === 'maxRepeatedFailures' ? 1 : 0) || input[key] > 1000) throw fail('Limits must be whole numbers.');
    next[key] = input[key];
  }
  for (const key of MEASURED_LIMITS) if (input[key] !== undefined) {
    if (input[key] !== null && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] <= 0)) throw fail('Limits must be positive numbers, or empty for no limit.');
    next[key] = input[key];
  }
  if (input.allowedProviders !== undefined) {
    if (input.allowedProviders !== null && (!Array.isArray(input.allowedProviders) || !input.allowedProviders.length || input.allowedProviders.some(item => !PROVIDER_KEYS.includes(item)))) throw fail('Choose at least one agent, or allow them all.');
    next.allowedProviders = input.allowedProviders;
  }
  if (input.allowedModels !== undefined) {
    const bad = input.allowedModels !== null && (typeof input.allowedModels !== 'object' || Array.isArray(input.allowedModels) || Object.entries(input.allowedModels).some(([provider, models]) => !PROVIDER_KEYS.includes(provider) || !Array.isArray(models) || !models.length || models.some(model => typeof model !== 'string')));
    if (bad) throw fail('Allowed models must list at least one model for each agent named.');
    next.allowedModels = input.allowedModels;
  }
  return next;
}

// Each usage limit that applies, on its own: room in one never makes up for another that is full. "stale" and "unknown" say
// that Codeshi can't tell, which is different from there being room.
export const assessQuota = (...args) => globalThis.relayRouting.assessQuota(...args);

const emptyState = taskId => ({ taskId, runs: 0, retries: 0, reviews: 0, handoffs: 0, workingMs: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, spendUSD: 0, runsWithoutUsage: 0, runsWithPartialUsage: 0, runsWithoutCost: 0, spendCaps: { native: 0, reported: 0 }, failures: {}, active: {}, extra: {}, stopped: null, startedAt: null });
const newTokens = usage => (usage?.input || 0) + (usage?.output || 0) + (usage?.cacheWrite || 0);
const knownCost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function stateFor(c, taskId) {
  c.taskBudgets ||= {};
  if (!c.taskBudgets[taskId]) {
    c.taskBudgets[taskId] = emptyState(taskId);
    const ids = Object.keys(c.taskBudgets);
    // Finished tasks age out, in the same order every time the journal is read.
    if (ids.length > TASK_LIMIT) for (const id of ids.slice(0, ids.length - TASK_LIMIT)) if (!Object.keys(c.taskBudgets[id].active).length) delete c.taskBudgets[id];
  }
  return c.taskBudgets[taskId];
}
const relationOf = (relation, provider, previousProvider) => relation === 'retry' ? 'retries' : relation === 'review' ? 'reviews' : relation === 'continuation' && previousProvider && previousProvider !== provider ? 'handoffs' : null;
function addFailure(state, { signature, kind, what, how, provider, runId, at }) {
  const known = state.failures[signature];
  if (known) { known.count++; known.lastAt = at; known.how = how; if (provider && !known.agents.includes(provider)) known.agents.push(provider); known.lastRunId = runId; return; }
  if (Object.keys(state.failures).length >= FAILURE_LIMIT) return;
  state.failures[signature] = { kind, what, how, count: 1, agents: provider ? [provider] : [], firstAt: at, lastAt: at, lastRunId: runId };
}

// Called for every journal record, when a run happens and again when the journal is read at startup, so both always agree.
export function applyBudgetRecord(c, record) {
  // Assessments share the task's measured budget, without counting as a review or a handoff. Reuse the auxiliary-run
  // accounting path so reported usage, partial results and interrupted runs have the same semantics as reviewers.
  if (record.type === 'routing_assessment_start') record = { ...record, type: 'background_review', review: { id: record.id, provider: record.provider, model: record.model, assessment: true } };
  else if (record.type === 'routing_assessment_metadata') record = { ...record, type: 'review_budget', began: record.metadata?.began };
  else if (record.type === 'routing_assessment_end') record = { ...record, type: 'review_result' };
  if (['submission', 'run_end', 'background_review', 'review_budget', 'review_result', 'task_policy', 'task_failure', 'task_budget_stop', 'task_budget_extend', 'task_budget_reset'].includes(record.type) || record.type === 'run_metadata' && (record.metadata?.usage || record.metadata?.costUSD !== undefined || record.metadata?.account || record.metadata?.budgetEnforcement || record.metadata?.routingFallback)) c.taskBudgetRevision = record.seq;
  if (record.type === 'task_policy') { c.taskPolicy = record.policy; return; }
  if (record.type === 'submission') {
    if (c.taskOfRun?.[record.id]) return;
    const taskId = record.task?.id || record.id, state = stateFor(c, taskId), kind = record.review ? 'review' : record.task?.relation || null;
    const counted = relationOf(kind, record.provider, record.previousProvider || c.budgetLast?.provider);
    state.runs++; if (counted) state[counted]++;
    state.startedAt ||= record.at;
    state.active[record.id] = { provider: record.provider, startedAt: record.at, counted, began: false, usage: null, costUSD: null, billing: null };
    c.taskOfRun ||= {}; c.taskOfRun[record.id] = taskId;
    c.budgetActive = record.id;
    c.budgetTotals ||= {};
    if (record.resetSession || record.context?.sessionMode !== 'resumed') delete c.budgetTotals[record.provider];
    else if (!c.budgetTotals[record.provider]) c.budgetTotals[record.provider] = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costEstimateUSD: null };
    return;
  }
  const activeState = () => { const taskId = c.budgetActive && c.taskOfRun?.[c.budgetActive]; return taskId ? c.taskBudgets?.[taskId] : null; };
  if (record.type === 'run_process') { const entry = activeState()?.active[c.budgetActive]; if (entry) entry.began = true; return; }
  if (record.type === 'review_process' || record.type === 'review_budget') {
    const state = c.taskBudgets?.[c.taskOfRun?.[record.id]], entry = state?.active[record.id];
    if (!entry?.background) return;
    if (record.type === 'review_process' || record.began || record.metadata?.effectiveModel || record.metadata?.usage) entry.began = true;
    const metadata = record.metadata || {};
    if (metadata.budgetEnforcement) entry.budgetEnforcement = metadata.budgetEnforcement;
    if (metadata.usage) entry.usage = normalizeUsage(entry.provider, metadata.usage);
    if (entry.usage?.source === 'claude-model-usage-total') entry.costUSD = entry.usage.costEstimateUSD;
    else if (typeof metadata.costUSD === 'number') entry.costUSD = metadata.costUSD;
    if (metadata.account?.billingSource) entry.billing = metadata.account.billingSource;
    return;
  }
  if (record.type === 'run_metadata') {
    const state = activeState(), entry = state?.active[c.budgetActive], metadata = record.metadata || {};
    if (!entry) return;
    // Routing switched agents before this run started (#144). Its usage is the new agent's, read by that agent's rules,
    // and the next run's handoff count follows the agent that really worked. A fresh session has no earlier total.
    const switched = metadata.routingFallback;
    if (switched?.to && switched.to !== entry.provider) {
      entry.provider = switched.to;
      if (switched.freshSession !== false) delete c.budgetTotals?.[switched.to];
      else if (c.budgetTotals && !c.budgetTotals[switched.to]) c.budgetTotals[switched.to] = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costEstimateUSD: null };
    }
    if (metadata.budgetEnforcement) entry.budgetEnforcement = metadata.budgetEnforcement;
    if (metadata.effectiveModel || metadata.usage) entry.began = true;
    if (metadata.account?.billingSource) entry.billing = metadata.account.billingSource;
    if (metadata.usage) entry.usage = normalizeUsage(entry.provider, metadata.usage, { previous: c.budgetTotals?.[entry.provider] });
    if (entry.usage?.source === 'claude-model-usage-total') entry.costUSD = entry.usage.costEstimateUSD;
    else if (typeof metadata.costUSD === 'number') entry.costUSD = metadata.costUSD;
    return;
  }
  if (record.type === 'run_end' || (record.type === 'review_result' && c.taskOfRun?.[record.id] && c.taskBudgets?.[c.taskOfRun[record.id]]?.active[record.id]?.background)) {
    const id = record.type === 'run_end' ? c.budgetActive : record.id, taskId = id && c.taskOfRun?.[id], state = taskId && c.taskBudgets?.[taskId], entry = state?.active[id];
    if (record.type === 'run_end') { c.budgetLast = entry ? { provider: entry.provider } : c.budgetLast; c.budgetActive = null; }
    if (!entry) return;
    if (record.type === 'review_result') { const result = record.result || {}; if (result.usage) entry.usage = normalizeUsage(entry.provider, result.usage); if (entry.usage?.source === 'claude-model-usage-total') entry.costUSD = entry.usage.costEstimateUSD; else if (typeof result.costUSD === 'number') entry.costUSD = result.costUSD; if (result.billingSource) entry.billing = result.billingSource; if (result.budgetEnforcement) entry.budgetEnforcement = result.budgetEnforcement; if (result.usage || result.status === 'complete') entry.began = true; }
    delete state.active[id];
    // A run refused before anything started used nothing, so what it reserved goes back.
    if (!entry.began) { state.runs--; if (entry.counted) state[entry.counted]--; return; }
    state.workingMs += Math.max(0, new Date(record.at).getTime() - new Date(entry.startedAt).getTime());
    if (!entry.background) c.budgetTotals[entry.provider] = entry.usage?.sessionTotal || { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costEstimateUSD: null };
    if (entry.usage?.reported?.length) {
      for (const key of ['input', 'output', 'cacheWrite', 'cacheRead']) state.tokens[key] += entry.usage[key] || 0;
      if (entry.usage.partial || entry.usage.input == null || entry.usage.output == null) state.runsWithPartialUsage++;
    }
    else state.runsWithoutUsage++;
    if (entry.billing === 'api' && knownCost(entry.costUSD)) state.spendUSD += entry.costUSD;
    else if (entry.billing === 'api' || entry.billing === 'unknown') state.runsWithoutCost++;
    if (entry.budgetEnforcement) state.spendCaps[entry.budgetEnforcement.spend === 'native' ? 'native' : 'reported']++;
    return;
  }
  if (record.type === 'background_review') {
    const review = record.review || {}, taskId = record.taskId || review.id, state = stateFor(c, taskId);
    if (c.taskOfRun?.[review.id]) return;
    state.runs++; if (!review.assessment) state.reviews++; state.startedAt ||= record.at;
    state.active[review.id] = { provider: review.provider, startedAt: record.at, counted: review.assessment ? null : 'reviews', began: false, background: true, usage: null, costUSD: null, billing: record.billingSource || null };
    c.taskOfRun ||= {}; c.taskOfRun[review.id] = taskId;
    return;
  }
  if (record.type === 'task_failure') {
    // Old versions also counted words in command inputs. Recheck their diagnostics when replaying the journal.
    if ((record.kind === 'command' || record.kind === 'probe') && !record.toolOutcome && !commandOutcome({ text: `$ ${String(record.what).replace(/\n/g, ' ')}\n${record.how}` })?.failed) return;
    const state = c.taskBudgets?.[record.taskId]; if (state) addFailure(state, { ...record }); return;
  }
  if (record.type === 'check' && record.check?.status === 'failed') {
    const taskId = c.taskOfRun?.[record.runId], state = taskId && c.taskBudgets?.[taskId];
    if (state) addFailure(state, { signature: hash(`check\0${record.check.command}\0${record.check.exitCode}`), kind: 'check', what: `Tests: ${record.check.command || 'test command'}`, how: `Exit code ${record.check.exitCode ?? 'unknown'}`, provider: null, runId: record.runId, at: record.at });
    return;
  }
  if (record.type === 'task_budget_stop') { const state = c.taskBudgets?.[record.taskId]; if (state) state.stopped = { kind: record.kind, runId: record.runId, at: record.at, ...(record.native ? { native: true } : {}) }; return; }
  if (record.type === 'task_budget_extend') { const state = c.taskBudgets?.[record.taskId]; if (state) { state.extra[record.limit] = (state.extra[record.limit] || 0) + record.add; state.stopped = null; } return; }
  if (record.type === 'task_budget_reset') { const state = c.taskBudgets?.[record.taskId]; if (state) { state.failures = {}; state.stopped = null; } }
}

const PROBE_PROGRAMS = new Set([
  'curl', 'wget', 'ping', 'nc', 'netcat', 'telnet', 'traceroute',
  'host', 'dig', 'nslookup', 'http', 'https', 'whoami', 'uptime',
  'which', 'type', 'ps', 'pgrep', 'top', 'htop', 'lsof', 'netstat', 'ss'
]);
const PROBE_GH_SUBCOMMANDS = new Set(['view', 'watch', 'list', 'status', 'checks']);
const PROBE_GIT_SUBCOMMANDS = new Set(['ls-remote', 'fetch', 'status', 'log', 'show', 'diff', 'rev-parse', 'describe', 'cat-file']);

export function isDiagnosticProbe(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const unwrapped = String(command).replace(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/, '$2').trim();
  if (/(?:-o\s+\/dev\/null|-o\s+nul|>+\s*\/dev\/null|2>&1\s*>\s*\/dev\/null|--head|-I\b|%{http_code})/i.test(unwrapped)) return true;
  const firstSegment = unwrapped.split(/[|;&\n]/)[0].trim();
  const tokens = firstSegment.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let idx = 0;
  while (idx < tokens.length && (tokens[idx].includes('=') || tokens[idx] === 'env' || tokens[idx] === 'sudo')) idx++;
  if (idx >= tokens.length) return false;
  const prog = path.basename(tokens[idx]).toLowerCase();
  if (PROBE_PROGRAMS.has(prog)) return true;
  const sub = (tokens[idx + 1] || '').toLowerCase(), sub2 = (tokens[idx + 2] || '').toLowerCase();
  if (prog === 'gh') {
    if (PROBE_GH_SUBCOMMANDS.has(sub) || PROBE_GH_SUBCOMMANDS.has(sub2)) return true;
    if (sub === 'api' && !tokens.slice(idx + 1).some(t => ['-x', '-X', '--method'].includes(t) && /^(POST|PUT|PATCH|DELETE)$/i.test(t))) return true;
  }
  if (prog === 'git' && (PROBE_GIT_SUBCOMMANDS.has(sub) || PROBE_GIT_SUBCOMMANDS.has(sub2))) return true;
  if (/\b(?:curl|wget|ping|nc|netcat)\b/i.test(unwrapped)) return true;
  return false;
}

export function isExplicitRetry(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return /^(?:retry|try\s+again|restart|dismiss\s+and\s+retry|run\s+again|retry\s+task)\b/i.test(trimmed);
}

// What a step says about the work: a command that failed, or an edit, identified so the same one can be recognized again.
// Numbers and timings are ignored, since they differ between otherwise identical failures.
const normalize = text => String(text).toLowerCase().replace(/\b[\da-f]{7,}\b/g, '#').replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();
export function classifyStep(input) {
  const message = typeof input === 'string' ? { text: input } : input;
  const value = String(message?.text || ''), lines = value.split('\n');
  if (/^(?:Edit|MultiEdit)$/.test(lines[0]) && lines[1]) return { kind: 'edit', signature: hash(`edit\0${lines[1]}`), what: `The same edit: ${(() => { try { return JSON.parse(lines[1]).file_path || 'a file'; } catch { return 'a file'; } })()}`, how: 'Made again with the same change' };
  const outcome = commandOutcome(message);
  if (!outcome?.failed) return null;
  const { command: what, output } = outcome;
  // Agents wrap the same command differently, so the shell around it doesn't count: otherwise changing agents would reset the count.
  const command = String(what).replace(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/, '$2').trim();
  const tail = output.trim().split('\n').slice(-3).join(' ') || `Exit code ${outcome.exitCode ?? 'unknown'}`;
  const kind = isDiagnosticProbe(command) ? 'probe' : 'command';
  return { kind, signature: hash(`${kind}\0${normalize(command)}\0${normalize(tail)}`), what: command.slice(0, 200), how: tail.slice(-300), ...(message.toolOutcome ? { toolOutcome: message.toolOutcome } : {}) };
}

export class TaskBudgets {
  constructor(broker) { this.broker = broker; this.timers = new Map(); this.watches = new Map(); this.shared = null; }
  // A part of a split message (#107 stage 2) shares the message's limits with the other parts (#87). The coordinator sets
  // shared on the part's lane: it returns what the message and the other parts have used, or null for a task of its own.
  sharedOf(c, state) {
    const extra = c && state && this.shared ? this.shared(c, state.taskId) : null;
    return extra ? { workingMs: 0, tokens: 0, spendUSD: 0, retries: 0, reviews: 0, handoffs: 0, runsWithoutUsage: 0, runsWithPartialUsage: 0, runsWithoutCost: 0, ...extra } : null;
  }

  policy(c) { return { ...defaultPolicy(), ...(c.taskPolicy || {}) }; }
  setPolicy(c, input) {
    const current = this.policy(c), policy = validatePolicy(input, current);
    if (MEASURED_LIMITS.some(key => policy[key] !== null && policy[key] !== current[key]) && Object.values(c.taskBudgets || {}).some(state => Object.keys(state.active).length > 1)) throw fail('Wait until only one agent is working on each task before changing its measured limits.', 409);
    this.broker.record(c, { type: 'task_policy', policy });
    for (const { run, ...context } of this.watches.values()) if (context.c === c) { this.check(run); this.watch(run, context); }
    return this.view(c);
  }
  limits(c, state) { const policy = this.policy(c), limits = { ...policy }; for (const [key, add] of Object.entries(state?.extra || {})) if (typeof limits[key] === 'number') limits[key] += add; return limits; }
  allows(c, provider, model) {
    const { allowedProviders, allowedModels } = this.policy(c);
    if (allowedProviders && !allowedProviders.includes(provider)) return { allowed: false, reason: `${NAMES[provider] || provider} isn't allowed by this workspace's task limits.` };
    const models = allowedModels?.[provider];
    if (models && (!model || !models.includes(model))) return { allowed: false, reason: `${model ? `The model ${model}` : `${NAMES[provider] || provider}'s default model`} isn't allowed by this workspace's task limits.` };
    return { allowed: true };
  }
  used(state, c = null) {
    const live = Object.values(state.active), now = Date.now(), extra = this.sharedOf(c, state) || { workingMs: 0, tokens: 0, spendUSD: 0 };
    return { workingMs: extra.workingMs + state.workingMs + live.reduce((sum, entry) => sum + Math.max(0, now - new Date(entry.startedAt).getTime()), 0),
      tokens: extra.tokens + state.tokens.input + state.tokens.output + state.tokens.cacheWrite + live.reduce((sum, entry) => sum + newTokens(entry.usage), 0),
      spendUSD: extra.spendUSD + state.spendUSD + live.reduce((sum, entry) => sum + (entry.billing === 'api' && knownCost(entry.costUSD) ? entry.costUSD : 0), 0) };
  }
  // The first limit a task has used up, if any.
  exceeded(c, state) {
    const limits = this.limits(c, state), used = this.used(state, c), extra = this.sharedOf(c, state);
    const repeated = Object.values(state.failures).filter(item => item.kind !== 'probe' && !isDiagnosticProbe(item.what) && item.count >= limits.maxRepeatedFailures).sort((a, b) => b.count - a.count)[0];
    if (repeated) return { limit: 'maxRepeatedFailures', used: repeated.count, allowed: limits.maxRepeatedFailures, message: `The same step has gone wrong ${repeated.count} times in this task: ${repeated.what}` };
    if (limits.maxWorkingMinutes !== null && used.workingMs >= limits.maxWorkingMinutes * 60000) return { limit: 'maxWorkingMinutes', used: Math.round(used.workingMs / 60000), allowed: limits.maxWorkingMinutes, message: `This task has reached its limit of ${limits.maxWorkingMinutes} working minutes.` };
    if (limits.maxTokens !== null && used.tokens >= limits.maxTokens) return { limit: 'maxTokens', used: used.tokens, allowed: limits.maxTokens, message: `This task has used ${used.tokens.toLocaleString('en-US')} tokens, over its limit of ${limits.maxTokens.toLocaleString('en-US')}.` };
    if (limits.maxSpendUSD !== null && used.spendUSD >= limits.maxSpendUSD) return { limit: 'maxSpendUSD', used: used.spendUSD, allowed: limits.maxSpendUSD, message: `This task has reached its API spending limit of $${limits.maxSpendUSD}.` };
    if (limits.maxTokens !== null && (state.runsWithoutUsage || state.runsWithPartialUsage || extra?.runsWithoutUsage || extra?.runsWithPartialUsage)) return { limit: 'tokenUsageUnknown', message: 'Earlier runs did not report complete token usage. The remaining token allowance is unknown. Review task limits before continuing.' };
    if (limits.maxSpendUSD !== null && (state.runsWithoutCost || extra?.runsWithoutCost)) return { limit: 'spendUsageUnknown', message: 'Earlier API runs did not report a cost or confirmed billing. The remaining spending allowance is unknown. Review task limits before continuing.' };
    return null;
  }
  // Why this run can't start, or null. Nothing is reserved here: the record that saves the run does that, in the same step.
  // `runId` names a run already saved and reserved that is choosing again before it starts, such as routing switching
  // agents near a limit: its own reservation is not another worker.
  refusal(c, { task, provider, model, local = false, previousProvider = null, runId = null }) {
    const key = local ? 'local' : provider, permitted = this.allows(c, key, model);
    if (!permitted.allowed) return { limit: 'allowed', message: permitted.reason };
    if (!task?.id) return null;
    const state = c.taskBudgets?.[task.id];
    if (!state) return null;
    const limits = this.limits(c, state), counted = relationOf(task.relation, key, previousProvider ?? c.lastRun?.provider), others = Object.keys(state.active).filter(id => id !== runId).length;
    if (others >= limits.maxConcurrent) return { limit: 'maxConcurrent', used: others, allowed: limits.maxConcurrent, message: `This task already has ${limits.maxConcurrent} agents working.` };
    // No adapter offers a reliable estimate for an entire run. Reserve the remaining measured allowance for one worker,
    // rather than giving the same remaining tokens/dollars/minutes to a builder and reviewer at once. Other tasks are independent.
    if (others && MEASURED_LIMITS.some(key => limits[key] !== null)) return { limit: 'reservation', message: 'This task’s remaining time, token or spending allowance is reserved by its running agent. Wait for it to finish before continuing or reviewing the same task.' };
    if (counted) {
      const limit = { retries: 'maxRetries', reviews: 'maxReviews', handoffs: 'maxHandoffs' }[counted], words = { retries: 'retries', reviews: 'reviews', handoffs: 'handoffs' }[counted];
      const total = state[counted] + (this.sharedOf(c, state)?.[counted] || 0);
      if (total >= limits[limit]) return { limit, used: total, allowed: limits[limit], message: `This task has used its ${limits[limit]} ${words}${total > state[counted] ? ', counting the other parts of its split' : ''}.` };
    }
    return this.exceeded(c, state);
  }
  assertCanStart(c, plan) {
    const refused = this.refusal(c, plan);
    if (!refused) return;
    const taskId = plan.task?.id || null;
    throw Object.assign(new Error(refused.message), { status: 409, category: 'budget', details: { budget: { ...refused, taskId, canExtend: Boolean(plan.task?.relation) && !['allowed', 'maxConcurrent', 'reservation', 'tokenUsageUnknown', 'spendUsageUnknown'].includes(refused.limit) } } });
  }
  extend(c, { taskId, limit }) {
    const state = c.taskBudgets?.[taskId], policy = this.policy(c);
    if (!state) throw fail('That task is no longer tracked.', 404);
    const base = this.limits(c, state)[limit];
    const add = EXTEND[limit] ?? (MEASURED_LIMITS.includes(limit) && typeof base === 'number' ? Math.ceil(base / 2 * 100) / 100 : null);
    if (add === null || (MEASURED_LIMITS.includes(limit) && policy[limit] === null)) throw fail('That limit can not be raised for a task.');
    this.broker.record(c, { type: 'task_budget_extend', taskId, limit, add });
    return this.view(c);
  }
  reset(c, { taskId } = {}) {
    const id = taskId || c.routingPending?.taskId || c.activeRun?.taskId || c.lastRun?.taskId || c.lastRun?.id;
    const state = id && c.taskBudgets?.[id];
    if (!state) throw fail('That task is no longer tracked.', 404);
    this.broker.record(c, { type: 'task_budget_reset', taskId: id });
    return this.view(c);
  }
  // The most an API-billed run may spend, for agents that can enforce it themselves.
  remainingSpend(c, taskId) {
    const state = c.taskBudgets?.[taskId], { maxSpendUSD } = this.limits(c, state);
    return maxSpendUSD === null ? null : state?.runsWithoutCost || this.sharedOf(c, state)?.runsWithoutCost ? 0 : Math.max(0, maxSpendUSD - (state ? this.used(state, c).spendUSD : 0));
  }

  // While a run works: the working-time limit, stopped on time, whatever the agent is doing. A quiet run is left alone otherwise.
  watch(run, { owner = this.broker, c = run.c, taskId = run.taskId, recordRunId = run.id } = {}) {
    clearTimeout(this.timers.get(run.id)); this.timers.delete(run.id);
    if (run.stopped || owner.running !== run) return;
    this.watches.set(run.id, { run, owner, c, taskId, recordRunId });
    const state = c.taskBudgets?.[taskId], { maxWorkingMinutes } = this.limits(c, state);
    if (!state || maxWorkingMinutes === null) return;
    const delay = Math.max(0, maxWorkingMinutes * 60000 - this.used(state, c).workingMs) / Math.max(1, Object.keys(state.active).length + (this.sharedOf(c, state)?.running || 0)), timer = setTimeout(() => { this.check(run); this.watch(run, { owner, c, taskId, recordRunId }); }, delay + 50);
    timer.unref(); this.timers.set(run.id, timer);
  }
  unwatch(run) { clearTimeout(this.timers.get(run.id)); this.timers.delete(run.id); this.watches.delete(run.id); }
  check(run) {
    const context = this.watches.get(run.id) || { owner: this.broker, c: run.c, taskId: run.taskId }, { owner, c, taskId } = context, state = c.taskBudgets?.[taskId];
    if (!state || run.budgetStop || run.ending || owner.running !== run) return;
    const over = this.exceeded(c, state);
    if (over) this.stop(run, over, context);
  }
  // Saves why, then stops the usual way, so the run's checkpoint is taken and its workers and leases are released.
  stop(run, over, { owner = this.broker, c = run.c, taskId = run.taskId, recordRunId = run.id } = {}) {
    run.budgetStop = over; run.errorCategory = 'budget';
    this.broker.record(c, { type: 'task_budget_stop', taskId, runId: recordRunId, kind: over.limit, used: over.used, allowed: over.allowed });
    this.broker.emit('notify', { conversationId: c.id, kind: 'stopped', title: 'Task limit reached', body: over.message });
    owner.stop(run.c.id);
  }
  // An agent ended itself at the spending cap Codeshi gave it, such as Claude's --max-budget-usd. It has already stopped,
  // so this only saves why: the run ends as a task-limit stop, not as an agent error.
  nativeStop(run, { limit = 'maxSpendUSD', allowed = null, agent = 'The agent' } = {}) {
    const message = `${agent} stopped itself at this task's API spending cap${typeof allowed === 'number' ? ` ($${allowed.toFixed(2)} was left when it started)` : ''}. Raise the spending limit in Task limits to continue.`;
    run.budgetStop = { limit, allowed, message, native: true }; run.errorCategory = 'budget';
    this.broker.record(run.c, { type: 'task_budget_stop', taskId: run.taskId, runId: run.id, kind: limit, allowed, native: true });
    this.broker.emit('notify', { conversationId: run.c.id, kind: 'stopped', title: 'Task limit reached', body: message });
  }
  // A step as it is saved. The same failure counts across runs and agents, because it is kept on the task.
  observeStep(c, message) {
    const run = this.broker.running;
    if (!run || run.c !== c || run.review || message.role !== 'activity' || message.runId !== run.id) return;
    const step = classifyStep(message);
    if (!step) return;
    run.countedSteps ||= new Set();
    if (run.countedSteps.has(message.id)) return;
    run.countedSteps.add(message.id);
    this.broker.record(c, { type: 'task_failure', taskId: run.taskId, runId: run.id, provider: run.provider, ...step });
    this.check(run);
  }

  // The current task for the panel.
  view(c) {
    const policy = this.policy(c), review = c.reviews?.find(item => c.taskOfRun?.[item.id]), taskId = c.routingPending?.taskId || c.activeRun?.taskId || Object.keys(c.taskBudgets || {}).at(-1) || c.lastRun?.taskId || c.lastRun?.id || c.taskOfRun?.[review?.id], state = taskId ? c.taskBudgets?.[taskId] : null;
    if (!state) return { policy, defaults: defaultPolicy(), task: null, quota: this.quota(c) };
    const limits = this.limits(c, state), used = this.used(state, c), exceeded = this.exceeded(c, state);
    return { policy, defaults: defaultPolicy(), quota: this.quota(c), task: { taskId, limits, runs: state.runs, retries: state.retries, reviews: state.reviews, handoffs: state.handoffs, workingMs: used.workingMs, tokens: used.tokens, cacheRead: state.tokens.cacheRead, spendUSD: used.spendUSD, runsWithoutUsage: state.runsWithoutUsage, active: Object.keys(state.active).length,
      runsWithPartialUsage: state.runsWithPartialUsage, runsWithoutCost: state.runsWithoutCost,
      enforcement: { tokens: 'reported-usage', spendCaps: { ...state.spendCaps }, activeSpendCaps: Object.values(state.active).map(entry => entry.budgetEnforcement).filter(Boolean) },
      overages: { tokens: limits.maxTokens === null ? 0 : Math.max(0, used.tokens - limits.maxTokens), spendUSD: limits.maxSpendUSD === null ? 0 : Math.max(0, used.spendUSD - limits.maxSpendUSD), workingMs: limits.maxWorkingMinutes === null ? 0 : Math.max(0, used.workingMs - limits.maxWorkingMinutes * 60000) },
      failures: Object.values(state.failures).filter(item => (item.kind !== 'edit' || item.count > 1) && item.kind !== 'probe' && !isDiagnosticProbe(item.what)).sort((a, b) => b.count - a.count).slice(0, 8), stopped: state.stopped, exceeded } };
  }
  quota(c) { return Object.fromEntries(Object.entries(c.quotaReadings || {}).map(([provider, reading]) => [provider, assessQuota({ available: true, windows: reading.windows, fetchedAt: reading.observedAt }, c.models?.[provider] || null)])); }
}

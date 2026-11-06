import fs from 'node:fs';
import { continuationRequest } from './context.mjs';
import { runSteps } from './recap.mjs';

// The task-efficiency ledger (#84): what each task cost and how it ended, worked out from the conversation's journal, so
// there is no second store to keep in step. It holds counts, times and identities. Prompts and check commands only appear
// when asked for, so an export can be shared as it is, and nothing here is ever sent anywhere.
//
// Three things are kept apart because they mean different things:
// - Tokens a run reported. A value an agent did not report is unknown (null), never zero.
// - Usage limit readings. These are account-wide and include other tools, so they are never attributed to a task.
// - Cost. An agent's dollar figure is an estimate, and on a subscription nothing is charged per run, so tokens are never
//   turned into a price here.
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

// A run's identity within its task. A retry, a continuation and a review belong to the task they follow; anything else starts one.
export function taskIdentity(c, { runId, text, retryOf = null, review = null }) {
  const follows = retryOf ? (c.runs || []).findLast(run => run.id === retryOf) : review || text === continuationRequest ? c.lastRun : null;
  if (!follows?.id) return { id: runId, parentRunId: null, relation: null };
  return { id: follows.taskId || follows.id, parentRunId: follows.id, relation: retryOf ? 'retry' : review ? 'review' : 'continuation' };
}

// One shape for what the agents report. input is what was read fresh, without what came from the cache, and output includes
// reasoning. previous is the same session's earlier total, for an agent that reports a running total for the whole session.
export function normalizeUsage(provider, raw, { previous = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  let tokens = {}, source = 'unknown', context = null, sessionTotal = null, coverage = null, costEstimateUSD = null;
  const models = raw.modelUsage && typeof raw.modelUsage === 'object' ? Object.values(raw.modelUsage) : [];
  if (provider === 'claude' && models.some(model => number(model?.inputTokens) !== null || number(model?.outputTokens) !== null)) {
    // The SDK's usage is main-loop, per-turn usage. modelUsage is a cumulative session counter covering the query
    // pipeline, including subagents, sidechains and compaction. Prefer it, and never add it to main-loop usage.
    source = 'claude-model-usage-total';
    const names = { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadInputTokens', cacheWrite: 'cacheCreationInputTokens', reasoning: 'thinkingTokens', costEstimateUSD: 'costUSD' };
    sessionTotal = {}; coverage = { scope: 'query-pipeline', excluded: ['helpers-outside-query-pipeline'], models: models.length, reportedBy: {} };
    for (const [field, key] of Object.entries(names)) {
      const values = models.map(model => number(model?.[key])).filter(value => value !== null);
      coverage.reportedBy[field] = values.length;
      // A partially reported field cannot be safely differenced against an earlier session total.
      sessionTotal[field] = values.length === models.length ? values.reduce((sum, value) => sum + value, 0) : null;
      if (raw.pendingUsage && field !== 'costEstimateUSD') {
        const pending = number(raw.pendingUsage[key]);
        sessionTotal[field] = sessionTotal[field] !== null && pending !== null ? sessionTotal[field] + pending : null;
      }
      const delta = sessionTotal[field] === null || previous && previous[field] == null ? null : sessionTotal[field] - (previous?.[field] ?? 0);
      if (field === 'costEstimateUSD') costEstimateUSD = delta !== null && delta >= 0 ? delta : null;
      else tokens[field] = delta !== null && delta >= 0 ? delta : null;
    }
    if (raw.pendingUsage) {
      coverage.scope = 'query-pipeline-plus-observed-messages'; costEstimateUSD = null;
      // Observed messages are a lower bound, not a complete native-session reading suitable for the next run's baseline.
      sessionTotal = Object.fromEntries(Object.keys(names).map(key => [key, null]));
    }
  } else if (typeof raw.input_tokens === 'number' || typeof raw.output_tokens === 'number') {
    source = 'claude-result';
    coverage = { scope: raw.partial ? 'observed-messages' : 'main-agent-turn', excluded: ['separate-subagent-and-auxiliary-calls'] };
    tokens = { input: number(raw.input_tokens), output: number(raw.output_tokens), cacheRead: number(raw.cache_read_input_tokens), cacheWrite: number(raw.cache_creation_input_tokens), reasoning: null };
  } else if (raw.total && typeof raw.total === 'object') {
    source = 'codex-thread-total';
    const total = raw.total, cached = number(total.cachedInputTokens);
    sessionTotal = { input: number(total.inputTokens), output: number(total.outputTokens), cacheRead: cached, cacheWrite: number(total.cacheWriteInputTokens), reasoning: number(total.reasoningOutputTokens) };
    // An earlier missing counter cannot supply a baseline for a resumed session. A decreasing counter means a reset
    // we cannot attribute, not negative consumption.
    const since = key => {
      if (sessionTotal[key] === null || previous && previous[key] == null) return null;
      const delta = sessionTotal[key] - (previous?.[key] ?? 0);
      return delta >= 0 ? delta : null;
    };
    const input = since('input'), cacheRead = since('cacheRead');
    tokens = { input: input === null || cacheRead === null || input < cacheRead ? null : input - cacheRead, output: since('output'), cacheRead, cacheWrite: since('cacheWrite'), reasoning: since('reasoning') };
    // The last request is a separate provider reading, not a session total or a measurement of the entire native context.
    context = { size: number(raw.modelContextWindow), lastRequest: raw.last && Object.keys(raw.last).length ? raw.last : null };
  } else if (typeof raw.used === 'number') {
    // The context the session is holding, which is not what the run used, so its tokens stay unknown.
    source = 'acp-context';
    context = { used: raw.used, size: number(raw.size) };
    tokens = Object.fromEntries(FIELDS.map(key => [key, null]));
  } else return { provider, source, ...Object.fromEntries(FIELDS.map(key => [key, null])), reported: [], raw };
  return { provider, source, ...tokens, ...(raw.partial ? { partial: true } : {}), reported: FIELDS.filter(key => tokens[key] !== null), ...(coverage ? { coverage } : {}), ...(source === 'claude-model-usage-total' ? { costEstimateUSD } : {}), ...(context ? { context } : {}), ...(sessionTotal ? { sessionTotal } : {}), raw };
}

// Adds runs up field by field. A field no run reported stays unknown, and reportedBy says how many of the runs each sum covers.
export function sumUsage(entries) {
  const total = Object.fromEntries(FIELDS.map(key => [key, null])), reportedBy = Object.fromEntries(FIELDS.map(key => [key, 0]));
  for (const usage of entries) for (const key of FIELDS) if (usage && typeof usage[key] === 'number') { total[key] = (total[key] || 0) + usage[key]; reportedBy[key]++; }
  return { ...total, reportedBy, runs: entries.length, runsWithTokens: entries.filter(usage => usage?.reported?.length).length, partialRuns: entries.filter(usage => usage?.partial).length };
}

// Agents write their steps as text, so counting them goes by how each kind of step starts.
function countStep(entry, text) {
  const value = String(text || '');
  if (/^Approval allowed/.test(value)) { entry.approvals.allowed++; entry.interventions++; }
  else if (/^Approval denied/.test(value)) { entry.approvals.denied++; entry.interventions++; }
  else if (/^Auto-approved: |^Tool .* auto-approved by policy/.test(value)) entry.approvals.automatic++;
  else if (/^Allowed /.test(value)) entry.approvals.byRule++;
  else if (/^Answered |^Skipped the question/.test(value)) entry.interventions++;
  else if (/^\$ |^(Bash|run_shell_command|shell|execute)\b/.test(value)) entry.tools.commands++;
  else if (/^File changes: |^(Edit|Write|MultiEdit|NotebookEdit|edit|write_file|replace)\b/.test(value)) entry.tools.edits++;
  else if (/^Tests (running|passed|failed)|^Using skill /.test(value)) return;
  else entry.tools.other++;
}

const newEntry = (id, record, overrides = {}) => ({
  runId: id, taskId: id, parentRunId: null, relation: null, provider: record.provider || null, model: record.model || null, effectiveModel: null, effort: record.effort || null,
  mode: record.mode || null, approvalPolicy: record.approvalPolicy || null, transport: record.effectiveTransport || record.transport || null, local: Boolean(record.local), billingSource: null,
  startedAt: record.at || null, endedAt: null, elapsedMs: null, status: 'running', errorCategory: null, usage: null, costEstimateUSD: null, costBasis: null,
  tools: { commands: 0, edits: 0, other: 0 }, approvals: { allowed: 0, denied: 0, automatic: 0, byRule: 0 }, interventions: 0, compactions: 0, compactionEvents: [], check: null, filesChanged: null, retryOf: record.retryOf || null,
  context: record.context ? { bytes: record.context.bytes ?? null, estimatedTokens: record.context.size?.estimatedTokens ?? null, policy: record.context.policy || null, sessionMode: record.context.sessionMode || null, sessionReason: record.context.sessionReason || null, omittedMessages: record.context.omittedMessages ?? null, shortenedMessages: record.context.shortenedMessages ?? null, memoryEntries: record.context.memory?.length ?? null, skills: record.context.skills?.map(({ name, version, reason }) => ({ name, version, reason })) || [] } : null,
  ...overrides,
});

function finishCost(entry, reported) {
  if (reported === null) { entry.costEstimateUSD = null; entry.costBasis = null; return; }
  if (typeof reported !== 'number') return;
  entry.costEstimateUSD = reported;
  // Provider-reported estimates are not billing statements, including on an API account.
  entry.costBasis = entry.billingSource === 'api' ? 'api-estimate' : entry.billingSource === 'subscription' ? 'not-charged-subscription' : 'billing-unknown';
}

export function ledgerFromRecords(records, { prompts = false } = {}) {
  const runs = new Map(), quota = [], totals = new Map();
  let active = null, last = null;
  const open = (id, record, overrides) => {
    const entry = newEntry(id, record, overrides);
    const follows = record.task || (record.retryOf ? { id: runs.get(record.retryOf)?.taskId || record.retryOf, parentRunId: record.retryOf, relation: 'retry' } : record.review || record.message?.text === continuationRequest ? last && { id: last.taskId, parentRunId: last.runId, relation: record.review ? 'review' : 'continuation' } : null);
    if (follows?.id) Object.assign(entry, { taskId: follows.id, parentRunId: follows.parentRunId ?? null, relation: follows.relation ?? null });
    if (prompts && record.message?.text) entry.prompt = String(record.message.text).slice(0, 200);
    runs.set(id, entry);
    return entry;
  };
  for (const record of records) {
    if (record.type === 'submission') {
      active = open(record.id, record, record.review ? { relation: 'review' } : {});
      // An agent's session total carries over only into a run that resumed that session.
      if (record.resetSession || record.context?.sessionMode !== 'resumed') totals.delete(record.provider);
      else if (!totals.has(record.provider)) totals.set(record.provider, Object.fromEntries([...FIELDS, 'costEstimateUSD'].map(key => [key, null])));
    } else if (record.type === 'run_start') active = open(record.id, record);
    else if (record.type === 'run_metadata' && active) {
      const metadata = record.metadata || {};
      if (metadata.effectiveModel) active.effectiveModel = metadata.effectiveModel;
      if (metadata.effectiveEffort) active.effort = metadata.effectiveEffort;
      if (metadata.transport) active.transport = metadata.transport;
      if (metadata.account?.billingSource) active.billingSource = metadata.account.billingSource;
      if (metadata.usage) active.usage = normalizeUsage(active.provider, metadata.usage, { previous: totals.get(active.provider) });
      if (typeof metadata.elapsedMs === 'number') active.elapsedMs = metadata.elapsedMs;
      if (metadata.costUSD !== undefined || active.usage?.source === 'claude-model-usage-total') finishCost(active, active.usage?.source === 'claude-model-usage-total' ? active.usage.costEstimateUSD : metadata.costUSD);
      if (typeof metadata.compactions === 'number') active.compactions = metadata.compactions;
    } else if (record.type === 'native_compaction') {
      const entry = runs.get(record.runId);
      if (entry) {
        const prior = entry.compactionEvents.find(item => item.id === record.event.id);
        if (!prior) entry.compactions++;
        entry.compactionEvents = [...entry.compactionEvents.filter(item => item.id !== record.event.id), { ...prior, ...record.event, observedAt: record.at }];
      }
    } else if (record.type === 'message') {
      const message = record.message || {}, entry = message.runId ? runs.get(message.runId) : null;
      if (!entry) continue;
      if (message.role === 'activity') countStep(entry, message.text);
      else if (message.role === 'user' && message.steer) entry.interventions++;
    } else if (record.type === 'run_end') {
      if (active) {
        Object.assign(active, { status: record.status, errorCategory: record.errorCategory || null, endedAt: record.at });
        active.elapsedMs ??= active.startedAt ? Date.parse(record.at) - Date.parse(active.startedAt) : null;
        totals.set(active.provider, active.usage?.sessionTotal || Object.fromEntries([...FIELDS, 'costEstimateUSD'].map(key => [key, null])));
        last = active;
      }
      active = null;
    } else if (record.type === 'check') {
      const entry = runs.get(record.runId), check = record.check || {};
      if (entry) entry.check = { status: check.status || null, exitCode: check.exitCode ?? null, durationMs: check.durationMs ?? null, ...(prompts && check.command ? { command: check.command } : {}) };
    } else if (record.type === 'run_snapshot' && record.phase === 'after') {
      const entry = runs.get(record.runId);
      if (entry) entry.filesChanged = record.files ?? null;
    } else if (record.type === 'background_review') {
      const review = record.review || {};
      runs.set(review.id, newEntry(review.id, { provider: review.provider, model: review.model, at: record.at, mode: 'read' }, { relation: 'review', taskId: record.taskId || last?.taskId || review.id, parentRunId: record.parentRunId || last?.runId || null }));
    } else if (record.type === 'review_budget') {
      const entry = runs.get(record.id), metadata = record.metadata || {};
      if (!entry || entry.status !== 'running') continue;
      if (metadata.usage) entry.usage = normalizeUsage(entry.provider, metadata.usage);
      if (metadata.account?.billingSource) entry.billingSource = metadata.account.billingSource;
      if (metadata.costUSD !== undefined || entry.usage?.source === 'claude-model-usage-total') finishCost(entry, entry.usage?.source === 'claude-model-usage-total' ? entry.usage.costEstimateUSD : metadata.costUSD);
      if (metadata.effectiveModel) entry.effectiveModel = metadata.effectiveModel;
    } else if (record.type === 'review_result') {
      const entry = runs.get(record.id), result = record.result || {};
      if (entry?.status === 'running' || entry?.relation === 'review') {
        Object.assign(entry, { status: result.status || 'failed', errorCategory: result.errorCategory || entry.errorCategory || null, endedAt: entry.endedAt || record.at });
        entry.elapsedMs ??= entry.startedAt ? Date.parse(record.at) - Date.parse(entry.startedAt) : null;
        if (result.usage) entry.usage = normalizeUsage(entry.provider, result.usage);
        if (result.billingSource) entry.billingSource = result.billingSource;
        if (result.costUSD !== undefined || entry.usage?.source === 'claude-model-usage-total') finishCost(entry, entry.usage?.source === 'claude-model-usage-total' ? entry.usage.costEstimateUSD : result.costUSD);
        if (result.effectiveModel) entry.effectiveModel = result.effectiveModel;
        if (number(result.elapsedMs) !== null) entry.elapsedMs = result.elapsedMs;
        if (result.accounting) {
          const { effort, tools, approvals, interventions, compactions, compactionEvents } = result.accounting;
          if (effort) entry.effort = effort;
          if (tools) entry.tools = tools;
          if (approvals) entry.approvals = approvals;
          if (number(interventions) !== null) entry.interventions = interventions;
          if (number(compactions) !== null) entry.compactions = compactions;
          if (Array.isArray(compactionEvents)) entry.compactionEvents = compactionEvents;
        }
      }
    } else if (record.type === 'quota_observation') quota.push({ provider: record.provider, observedAt: Object.hasOwn(record, 'observedAt') ? record.observedAt : record.at, plan: record.plan || null, windows: record.windows || [] });
  }
  return { runs: [...runs.values()], tasks: summarizeTasks([...runs.values()]), quotaObservations: quota };
}

export function summarizeTasks(runs) {
  const grouped = new Map();
  for (const run of runs) { if (!grouped.has(run.taskId)) grouped.set(run.taskId, []); grouped.get(run.taskId).push(run); }
  return [...grouped].map(([id, list]) => {
    const builders = list.filter(run => run.relation !== 'review'), first = builders[0] || list[0], final = builders.at(-1) || list.at(-1);
    const checks = list.filter(run => run.check && !['running', 'interrupted'].includes(run.check.status)), latest = checks.at(-1)?.check || null;
    const agents = {};
    for (const run of list) {
      const agent = agents[run.provider] ||= { runs: 0, workingMs: 0, filesChanged: null, commands: 0, edits: 0, usage: [] };
      agent.runs++; agent.workingMs += run.elapsedMs || 0; agent.commands += run.tools.commands; agent.edits += run.tools.edits; agent.usage.push(run.usage);
      if (typeof run.filesChanged === 'number') agent.filesChanged = (agent.filesChanged || 0) + run.filesChanged;
    }
    for (const agent of Object.values(agents)) agent.usage = sumUsage(agent.usage);
    return {
      id, ...(first.prompt ? { prompt: first.prompt } : {}), startedAt: first.startedAt,
      endedAt: list.every(run => run.endedAt) ? list.map(run => run.endedAt).sort().at(-1) : null, status: final.status,
      // Only the time agents worked: waiting for a limit to reset falls between runs and isn't counted.
      workingMs: list.reduce((sum, run) => sum + (run.elapsedMs || 0), 0),
      runs: list.length, retries: list.filter(run => run.relation === 'retry').length, continuations: list.filter(run => run.relation === 'continuation').length, reviews: list.filter(run => run.relation === 'review').length,
      interventions: list.reduce((sum, run) => sum + run.interventions, 0), usage: sumUsage(list.map(run => run.usage)), agents,
      firstAttemptSuccess: first.status === 'running' ? null : first.status === 'complete' && first.check?.status !== 'failed',
      // Passing the project's own tests is the only thing that counts as verified. A clean finish alone is not evidence.
      verification: latest?.status === 'passed' ? 'passed' : latest?.status === 'failed' ? 'failed' : 'unverified', latestCheck: latest,
    };
  });
}

// One result for a task that ran across agents (#94), from what was recorded and with no model call. It only exists once a
// task has crossed a handoff or a continuation, so a single run reads as it always has. Waiting for a limit to reset falls
// between runs, so it isn't working time, and tests are the latest result rather than a sum of repeated runs.
export function taskResult(c) {
  const taskId = c.lastRun?.taskId;
  if (!taskId || c.lastRun.status !== 'complete') return null;
  const runs = (c.runs || []).filter(run => run.taskId === taskId);
  if (runs.length < 2 || !runs.some(run => run.relation === 'continuation')) return null;
  const agents = new Map();
  for (const run of runs) {
    const key = run.local ? 'local' : run.provider, agent = agents.get(key) || { provider: run.provider, ...(run.local ? { local: true } : {}), runs: [] };
    agent.runs.push(run); agents.set(key, agent);
  }
  const elapsed = run => typeof run.elapsedMs === 'number' ? run.elapsedMs : Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)) || 0;
  const checks = runs.map(run => run.check).filter(check => check && ['passed', 'failed'].includes(check.status));
  return {
    runs: runs.length, workingMs: runs.reduce((sum, run) => sum + elapsed(run), 0), tests: checks.at(-1)?.status || null,
    agents: [...agents.values()].map(({ runs: own, ...agent }) => {
      // A file two runs changed counts once where the steps name it; a snapshot also sees what a command changed.
      const ids = new Set(own.map(run => run.id)), named = runSteps((c.messages || []).filter(message => ids.has(message.runId))).files.length, seen = own.map(run => run.files).filter(count => typeof count === 'number');
      return { ...agent, files: seen.length || named ? Math.max(named, ...seen) : null };
    }),
  };
}

// Reads a conversation's journal for the ledger. Streaming text makes up most of a long journal and adds nothing here, so
// those lines are skipped before parsing, which keeps this quick while the window is in use.
export async function readLedger(filename, options = {}) {
  let source = '';
  try { source = await fs.promises.readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = [];
  for (const line of source.split('\n')) {
    if (!line || line.includes('"type":"message_delta"') || line.includes('"type":"message_update"')) continue;
    try { records.push(JSON.parse(line)); } catch { /* A torn last line is repaired on the next start. */ }
  }
  return ledgerFromRecords(records, options);
}


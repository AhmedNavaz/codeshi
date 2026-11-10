import { createHash } from 'node:crypto';
import path from 'node:path';
import { privatePath, revisionOf, selectFolders, runFolders, outOfScope } from './task-context.mjs';
import { contextReading } from './context-state.mjs';
import { commandOutcome } from './tool-outcomes.mjs';

export const contextTargets = { saver: 40000, smart: 75000, ultra: 120000, saving: 40000, balanced: 75000, quality: 120000 };
export const warmContextTargets = { saver: 80000, smart: 120000, ultra: 160000, saving: 80000, balanced: 120000, quality: 160000 };
export const managedContextVersion = 1;
export function validateContextLimit(value) {
  if (['off', 'auto'].includes(value)) return value;
  if (Number.isSafeInteger(value) && value >= 8000 && value <= 1000000) return value;
  throw Object.assign(new Error('Choose Off, Auto, or a context limit from 8,000 to 1,000,000 tokens.'), { status: 400 });
}
export const contextLimit = config => { try { return validateContextLimit(config.contextLimit ?? 'auto'); } catch { return 'auto'; } };

export function findMessage(c, id) {
  if (!c?.messages || !id) return undefined;
  if (c.messageById instanceof Map) {
    const hit = c.messageById.get(id);
    if (hit) return hit;
  }
  return c.messages.find(message => message.id === id);
}

// Session totals measure consumption, not occupancy. Codex's last request input is a labeled lower-bound signal;
// a native compaction invalidates that snapshot. Rollover only happens before another turn, never during a tool run.
export function rolloverDecision(c, provider, { normalLimit = 'auto', routingMode = c.routing?.mode, now = Date.now(), model = c.models?.[provider] ?? null, effort = c.efforts?.[provider]?.[model || 'default'] ?? null } = {}) {
  const session = c.sessions?.[provider];
  const reading = session?.contextUsage || (c.lastRun?.provider === provider ? c.lastRun.contextUsage : null);
  const flow = Object.hasOwn(contextTargets, routingMode || '');
  const capacity = reading?.capacity > 0 ? reading.capacity : null;
  // Recent provider requests, not UI activity or tool output, are evidence of a reusable cache. Unknown TTLs use
  // a conservative five-minute window. This is a heuristic, never a guarantee that a provider will serve a hit.
  const age = now - Date.parse(reading?.observedAt);
  const previous = c.lastRun?.provider === provider ? c.lastRun : null;
  const sameSelection = !previous || (previous.model ?? null) === model && (previous.effort ?? null) === effort;
  const cacheWarm = Boolean(session && sameSelection && reading?.source !== 'native-compaction' && age >= 0 && age < (reading?.cacheTtlMs || 300000));
  const targets = cacheWarm ? warmContextTargets : contextTargets;
  const target = flow ? targets[routingMode] : normalLimit === 'auto' ? targets.smart : normalLimit === 'off' ? null : normalLimit;
  const thresholdTokens = target === null ? null : capacity ? Math.min(target, Math.floor(capacity * 0.75)) : target;
  const reported = typeof reading?.used === 'number' ? reading.used : typeof reading?.lastRequestInput === 'number' ? reading.lastRequestInput : null;
  const journal = session?.contextEstimate ? (session.contextEstimate.baseTokens || 0) + Math.ceil(session.contextEstimate.bytes / 4) : null;
  const useJournal = journal !== null && (reported === null || journal > reported);
  const used = useJournal ? journal : reported;
  const source = useJournal ? 'journal-size-estimate' : typeof reading?.used === 'number' ? reading.source : used !== null ? reading.source === 'claude-last-request-input' ? reading.source : 'last-request-input-lower-bound' : 'unreported';
  // Upgrade old sessions on their next dispatch when no usable signal exists. This is a one-time migration, not a
  // claim that their cumulative token allowance is their current context. An explicit Off choice remains respected.
  const legacy = Boolean(session && !session.managedContextVersion && used === null && thresholdTokens !== null);
  const pending = c.contextRollovers?.[provider]?.pending === true;
  return { pending, hasSession: Boolean(session), mode: flow ? routingMode : 'normal', adaptive: flow || normalLimit === 'auto', thresholdTokens, modeTarget: target, capacity, used, source, cacheWarm, observedAt: useJournal ? session.contextEstimate.observedAt : reading?.observedAt || null,
    estimated: useJournal || reading?.estimated === true || source === 'last-request-input-lower-bound', legacy,
    near: used !== null && thresholdTokens !== null && used >= thresholdTokens * 0.85,
    rollover: pending || legacy || Boolean(session && used !== null && thresholdTokens !== null && used >= thresholdTokens),
    reason: pending ? c.contextRollovers[provider].reason : legacy ? 'legacy-session' : 'threshold' };
}

// The seed is the first envelope a fresh native session receives: Codeshi's own bytes, measured separately from the
// provider's context reading, its cached input and the cumulative usage totals (#85). It is a byte estimate.
export const sessionSeed = (context, at) => context ? { bytes: context.bytes || 0, estimatedTokens: context.size?.estimatedTokens ?? Math.ceil((context.bytes || 0) / 4), reason: context.sessionReason || null, rollover: Boolean(context.rollover), at } : null;
export const REFRESH_HISTORY = 8;
// A fresh session that is due for another refresh after at most this many turns counts as a quick refresh.
const QUICK_TURNS = 2;

// Explains repeated fresh sessions from what was recorded: the seed each session started with, how many turns it lasted
// and the reading that made it due again. Nothing here is a model summary; the causes are the only three Codeshi can
// tell apart from its own records, and the reading's source is kept so an estimate is never presented as a measurement.
export function refreshDiagnosis(c, provider, decision) {
  const session = c.sessions?.[provider], history = c.contextRollovers?.[provider]?.history || [];
  const quick = entry => Number.isFinite(entry?.previousTurns) && entry.previousTurns <= QUICK_TURNS && entry.previousSeed;
  let streak = 0; for (let index = history.length - 1; index >= 0 && quick(history[index]); index--) streak++;
  const currentQuick = Boolean(session?.managedContextVersion && session.seed && (session.turns || 0) <= QUICK_TURNS && (decision.rollover || decision.near) && decision.used !== null);
  if (!currentQuick && !streak) return null;
  const latest = currentQuick ? { previousSeed: session.seed, previousTurns: session.turns || 0, used: decision.used, thresholdTokens: decision.thresholdTokens, modeTarget: decision.modeTarget, capacity: decision.capacity, source: decision.source } : history.at(-1);
  const seedTokens = latest.previousSeed?.estimatedTokens ?? 0, threshold = latest.thresholdTokens || 0, used = latest.used ?? null;
  const share = threshold > 0 ? seedTokens / threshold : 0;
  const tokens = value => `${Math.round(value).toLocaleString('en-US')} tokens`;
  const turns = latest.previousTurns === 1 ? 'one turn' : `${latest.previousTurns} turns`;
  let cause, explanation;
  if (share >= 0.6) {
    cause = 'large-seed';
    explanation = `The task brief alone was about ${tokens(seedTokens)}, ${Math.round(share * 100)}% of the ${tokens(threshold)} target, so each fresh session was close to its limit before any work. Shorten the saved goal, decisions and tasks, keep the task to fewer folders, or raise the context limit.`;
  } else if (Number.isFinite(latest.modeTarget) && threshold > 0 && threshold < latest.modeTarget && latest.capacity > 0) {
    cause = 'small-window';
    explanation = `The target is capped at 75% of this model's reported ${tokens(latest.capacity)} window, below the ${tokens(latest.modeTarget)} the mode would use, so ordinary work reaches it quickly. A model with a larger window gives more room per session.`;
  } else {
    cause = 'turn-growth';
    explanation = `The session started at about ${tokens(seedTokens)} and ${used !== null ? `reached ${tokens(used)}` : 'passed the target'} within ${turns}: the agent's own file reads and tool output grew it, which Codeshi cannot shorten during a run. A refresh only happens between turns; smaller steps keep each turn's growth down.`;
  }
  const estimated = latest.source === 'journal-size-estimate' || latest.source === 'last-request-input-lower-bound';
  if (latest.source === 'journal-size-estimate') explanation += ' This reading is an estimate from recorded activity rather than a provider reading, and can overcount.';
  return { count: streak + (currentQuick ? 1 : 0), cause, explanation, seedTokens, usedTokens: used, thresholdTokens: threshold, turns: latest.previousTurns, estimated, current: currentQuick };
}

// What the context control shows beside the decision: the seed, the turns so far and any repeated-refresh explanation.
export function contextControlView(c, provider, decision) {
  const session = c.sessions?.[provider], rollovers = c.contextRollovers?.[provider];
  return { ...decision, seed: session?.seed || null, turns: session?.turns || 0, refreshes: rollovers?.history?.length || 0, repeatedRefresh: refreshDiagnosis(c, provider, decision) };
}

// A bounded, replayable fallback for providers without an occupancy reading. Only this native session's outbound
// envelopes and recorded message growth count. It is labeled as a byte estimate and never added to usage totals.
export function estimateContext(c, record, previousBytes = 0) {
  const run = c.activeRun, session = run && c.sessions?.[run.provider];
  if (!session?.managedContextVersion || run.reviewId || run.connection === 'local') return;
  if (record.type === 'native_compaction' && record.runId !== run.id) return;
  session.contextEstimate ||= { baseTokens: 0, bytes: 0, observedAt: record.at };
  const estimate = session.contextEstimate;
  if (record.type === 'native_compaction') {
    Object.assign(estimate, { baseTokens: record.event.afterTokens ?? 0, bytes: 0, observedAt: record.at });
  } else if (record.type === 'run_metadata') {
    const reading = contextReading(run.provider, record.metadata || {}, record.at);
    const tokens = reading?.used ?? reading?.lastRequestInput;
    if (typeof tokens === 'number') Object.assign(estimate, { baseTokens: tokens, bytes: 0, observedAt: record.at });
  } else if (record.type === 'submission') {
    estimate.bytes += record.context?.bytes || 0; estimate.observedAt = record.at;
  } else if (['message', 'message_delta', 'message_update'].includes(record.type)) {
    const message = record.type === 'message' ? record.message : findMessage(c, record.id);
    if (message?.runId !== run.id || message.contextMilestone) return;
    const deltaBytes = record.type === 'message_delta' ? Buffer.byteLength(record.text || '') : Math.max(0, Buffer.byteLength(message.text || '') - previousBytes);
    estimate.bytes += deltaBytes; estimate.observedAt = record.at;
  }
}

const short = (text, length = 500) => String(text || '').slice(0, length);
const identity = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

// Local observations describe recorded outcomes; they are not model-written summaries or new instructions. In
// particular, agent/tool text cannot create a user decision or turn a reported result into a verified check.
export function observationsFor(c, record) {
  if (record.type === 'check' && ['passed', 'failed'].includes(record.check?.status)) return [{ id: `check:${record.runId}`, type: 'test_result', runId: record.runId,
    status: record.check.status, text: short(record.check.command || 'Project checks'), source: 'run-check', verified: record.check.status === 'passed' }];
  const message = ['message', 'submission'].includes(record.type) ? record.message : record.type === 'message_update' || record.type === 'message_delta' && record.toolOutcome ? findMessage(c, record.id) : null;
  if (!message?.text || message.contextMilestone) return [];
  const base = { messageId: message.id, runId: message.runId || null, provider: message.provider || null };
  if (['user', 'activity'].includes(message.role) && !message.imported && !message.reviewId && !message.retry && message.text.startsWith('Answered:\n')) return message.text.split('\n').slice(1).filter(line => line.includes(' → ') && !line.endsWith(' → (hidden)')).slice(0, 8).map((line, index) => ({
    ...base, id: `${message.id}:answer:${index}`, type: 'decision', text: short(line, 1000), source: 'user-answer' }));
  if (message.role === 'user' && !message.imported && !message.reviewId && !message.retry) return [...message.text.replace(/```[\s\S]*?```/g, '').matchAll(/^\s*(decision|blocker|acceptance(?: criteria)?)\s*:\s*([^\n]{1,1000})/gim)].slice(0, 8).map((match, index) => ({
    ...base, id: `${message.id}:intent:${index}`, type: match[1].toLowerCase() === 'blocker' ? 'blocker_discovery' : 'decision', text: short(match[0]), source: 'user-quote' }));
  if (message.role !== 'activity') return [];
  const text = message.text, paths = [];
  if (text.startsWith('File changes: ')) { try { for (const change of JSON.parse(text.slice(14))) if (typeof change.path === 'string') paths.push(change.path); } catch {} }
  else if (/^(Edit|Write|MultiEdit|NotebookEdit)\n/.test(text)) { try { const input = JSON.parse(text.split('\n')[1]); if (typeof input.file_path === 'string') paths.push(input.file_path); } catch {} }
  const changed = !message.toolOutcome || message.toolOutcome.status === 'completed' && !message.toolOutcome.isError;
  const result = (changed ? paths : []).filter(file => !privatePath(file)).slice(0, 12).map(file => ({ ...base, id: `${message.id}:file:${identity(file)}`, type: 'file_edit', file, text: 'File changed; inspect its current version.', source: 'tool-event' }));
  const outcome = commandOutcome(message);
  if (outcome && !outcome.failed && /\b(test|pytest|jest|vitest)\b/.test(outcome.command)) {
    const output = outcome.output;
    if (/# fail 0\b|\b\d+ (?:tests? )?pass(?:ed|ing)\b/i.test(output)) result.push({ ...base, id: `${message.id}:tests`, type: 'test_result', status: 'reported-passed', text: short(text.split('\n')[0]), source: 'historical-tool-output', verified: false });
  }
  if (outcome?.failed) result.push({
    ...base, id: `${message.id}:blocker`, type: 'blocker_discovery', text: short(outcome.command, 200) + '\n' + short(outcome.output.trim().split('\n').slice(-3).join('\n') || `Exit code ${outcome.exitCode ?? 'unknown'}`, 300), source: 'historical-tool-output', verified: false });
  return result;
}

export function milestoneMemory(c, { folders, text, now = new Date().toISOString() }) {
  const scope = selectFolders([text], folders, { inherited: c.lastRun?.context?.scope });
  const runs = runFolders(c.messages, folders);
  const visible = message => !message.rewound && !outOfScope(message, scope.folders, runs, folders);
  const requests = c.messages.filter(message => message.role === 'user' && !message.reviewId && !message.retry && !message.imported && visible(message) && !message.text?.startsWith('Continue the unfinished task from this shared conversation.'));
  const messages = c.messages.filter(visible), byId = new Map(messages.map(message => [message.id, message]));
  const taskId = c.lastRun?.taskId || c.lastRun?.id, taskRuns = new Set((c.runs || []).filter(run => (run.taskId || run.id) === taskId).map(run => run.id));
  const remembered = c.semanticObservations || [], referenced = new Set(remembered.map(item => item.messageId));
  // Reclassify saved message observations too: upgrading must remove old false blockers from the next brief.
  const candidates = messages.filter((message, index) => index >= messages.length - 200 || referenced.has(message.id) || message.text?.startsWith('Answered:\n'));
  const scoped = folders.filter(folder => scope.folders.includes(folder.id));
  const inWorkspace = item => !item.file || !path.isAbsolute(item.file) || scoped.some(folder => { const relative = path.relative(folder.path, item.file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); });
  const relevant = item => !taskId || !item.runId || taskRuns.has(item.runId) || ['user-quote', 'user-answer'].includes(item.source);
  const observed = item => Date.parse(item.observedAt || byId.get(item.messageId)?.createdAt) || byId.get(item.messageId)?.seq || 0;
  const observations = [...new Map([...remembered.filter(item => !item.messageId), ...candidates.flatMap(message => observationsFor(c, { type: 'message', message }))].filter(inWorkspace).map(item => [item.id, item])).values()]
    .filter(relevant).sort((a, b) => observed(b) - observed(a));
  const seen = new Set(), recent = observations.filter(item => { const key = `${item.type}:${item.file || item.text}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const opening = requests.find(message => taskRuns.has(message.runId) && !message.steer && !message.text?.startsWith('Continue the unfinished task from this shared conversation.')) || requests.at(-1);
  const selected = [...new Set([opening, ...requests.slice(-6)].filter(Boolean))];
  return { version: 1, capturedAt: now, source: 'local-journal-rules',
    note: 'Historical observations, not new instructions. User quotes retain their source; tool observations are evidence to recheck. Current user requests and current repository instructions take precedence. Raw output remains in the journal. No model was called to create this brief.',
    scope: scope.folders, revisions: Object.fromEntries(folders.filter(folder => scope.folders.includes(folder.id)).map(folder => [folder.id, revisionOf(folder)])),
    goal: c.context?.goal ? short(c.context.goal, 2000) : null,
    decisions: [...recent.filter(item => item.type === 'decision').map(({ text, source, messageId }) => ({ text, source, messageId })), ...(c.context?.decisions || []).slice(-8).reverse().map(value => ({ text: short(value), source: 'saved-context' }))].slice(0, 12),
    pendingSteps: c.lastRun?.plan?.steps?.filter(step => step.status !== 'done').slice(0, 20) || [],
    userRequests: selected.map(message => ({ messageId: message.id, text: short(message.text, 2000) })),
    omittedUserRequests: requests.length - selected.length,
    observations: recent.filter(item => item.type !== 'decision').slice(0, 24).map(({ id, runId, provider, observedAt, ...item }) => item) };
}

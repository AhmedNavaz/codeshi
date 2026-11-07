// After every prompt: did that run use a lot, or more than usual? This is worked out from what the journal already holds, so
// checking costs no allowance. Run sizes vary widely, so a run has to be well above both the median and nearly everything
// recent before it counts, and a stretch of large runs or one limit filling up is mentioned once, not after each run.
//
// Tokens and limit readings stay apart, as in the task ledger. Tokens are what this run reported. A limit reading covers the
// whole account, so a move seen during a run is reported as that and is never called what the run cost.
const BASELINE_RUNS = 30, BASELINE_MIN = 8, TIMES_USUAL = 3, UNUSUAL_MIN_TOKENS = 2e6, HEAVY_TOKENS = 20e6, QUIET_RUNS = 4, WORSE_THAN_LAST = 2;
const SHORT_WINDOW_POINTS = 15, WEEKLY_WINDOW_POINTS = 3, NEAR_PERCENT = 80, COMPACT_MIN_TOKENS = 40000, READINGS_KEPT = 40;
const START_GRACE_MS = 60000, START_MAX_AGE_MS = 30 * 60000, END_MAX_AGE_MS = 5 * 60000, UNCHANGED_MS = 60000, SAME_WINDOW_MS = 10 * 60000;

// Everything the run sent and received, cache reads included. Across real runs this followed allowance better than fresh
// tokens alone. A run that reported neither its input nor its cache reads has no known size, which is different from zero.
export function runTokens(usage) {
  if (!usage || !Number.isFinite(usage.input) && !Number.isFinite(usage.cacheRead)) return null;
  return [usage.input, usage.cacheRead, usage.cacheWrite, usage.output].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}
const percentile = (values, share) => [...values].sort((a, b) => a - b)[Math.floor(share * values.length)];

// Called for each finished run, live and when a journal is read, so both agree. Each agent keeps its own history: their
// counts aren't comparable, and an agent used less often would otherwise fall out of the conversation's recent runs.
export function observeRunSize(c, run) {
  const tokens = run.local ? null : runTokens(run.usageMeasured);
  if (tokens === null) return;
  c.usageSeen ||= {};
  const seen = c.usageSeen[run.provider] ||= { tokens: [], count: 0, lastHeavy: null };
  const known = seen.tokens.length >= BASELINE_MIN, usual = known ? percentile(seen.tokens, .5) : null;
  const large = known ? tokens >= UNUSUAL_MIN_TOKENS && tokens >= TIMES_USUAL * usual && tokens >= percentile(seen.tokens, .9) : tokens >= HEAVY_TOKENS;
  const heavy = large && !(seen.lastHeavy && seen.count - seen.lastHeavy.at <= QUIET_RUNS && tokens < seen.lastHeavy.tokens * WORSE_THAN_LAST);
  const partial = run.usageMeasured.partial === true;
  run.usageSize = { tokens, usual, samples: seen.tokens.length, heavy, partial };
  if (heavy) seen.lastHeavy = { at: seen.count, tokens };
  // What was seen of a partial run is only its lower bound, so it would pull "usual" down.
  if (!partial) { seen.tokens = [...seen.tokens, tokens].slice(-BASELINE_RUNS); seen.count++; }
}

export function observeReading(c, provider, reading) {
  c.quotaHistory ||= {};
  c.quotaHistory[provider] = [...(c.quotaHistory[provider] || []), reading].slice(-READINGS_KEPT);
}

// A reading just before the run and one just after, for the limits that apply to every model. Anything else can't say what
// moved during this run: a reset between them, or a reading from long before it started.
function limitMoves(readings, run) {
  const at = reading => Date.parse(reading.observedAt), started = Date.parse(run.startedAt), ended = Date.parse(run.endedAt);
  const before = readings.findLast(reading => at(reading) <= Math.min(started + START_GRACE_MS, ended) && started - at(reading) <= START_MAX_AGE_MS);
  // An unchanged reading isn't saved again within a minute, so the one that ended the run can be the last one before it ended.
  const after = readings.find(reading => at(reading) >= ended && at(reading) - ended <= END_MAX_AGE_MS) || readings.findLast(reading => at(reading) < ended && ended - at(reading) <= UNCHANGED_MS);
  if (!before || !after || at(after) <= at(before)) return { after: null, moves: [] };
  const moves = [];
  for (const row of after.windows) {
    const start = before.windows.find(item => item.id === row.id);
    if (!start || row.scope || row.scopes) continue;
    if (row.resetsAt && start.resetsAt && Math.abs(Date.parse(row.resetsAt) - Date.parse(start.resetsAt)) > SAME_WINDOW_MS) continue;
    const points = row.usedPercent - start.usedPercent;
    if (points > 0) moves.push({ id: row.id, label: row.label || row.id, from: start.usedPercent, to: row.usedPercent, points, resetsAt: row.resetsAt || null, near: start.usedPercent < NEAR_PERCENT && row.usedPercent >= NEAR_PERCENT });
  }
  return { after, moves };
}

// One limit filling up over several runs is one thing to say: the first large move, then only when it reaches the near mark
// or moves at least twice as far. A new reset period starts over. Runs close together can share their readings, and then
// the move is told once, for the latest of them.
function withLargeMoves(c, run) {
  const readings = (c.quotaHistory?.[run.provider] || []).filter(reading => Number.isFinite(Date.parse(reading.observedAt))).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const runs = c.runs.filter(item => item.provider === run.provider && !item.local && item.endedAt), seen = runs.map(item => limitMoves(readings, item)), told = new Map();
  let result = [];
  runs.forEach((item, index) => {
    const { after, moves } = seen[index];
    if (after && seen[index + 1]?.after === after) return;
    const judged = moves.map(move => {
      const last = told.get(move.id), samePeriod = last && (!move.resetsAt || !last.resetsAt || Math.abs(Date.parse(move.resetsAt) - Date.parse(last.resetsAt)) <= SAME_WINDOW_MS);
      const big = move.points >= (/week/i.test(move.label) ? WEEKLY_WINDOW_POINTS : SHORT_WINDOW_POINTS);
      const large = move.near || big && !(samePeriod && move.points < last.points * WORSE_THAN_LAST);
      if (large) told.set(move.id, move);
      return { ...move, large };
    });
    if (item.id === run.id) result = judged;
  });
  return result;
}

// What the agent's next message will carry, and the one thing worth doing about it, if any. Above the target Codeshi already
// refreshes on the next send, so offering Compact then would only ask for what is happening anyway.
function nextStep(c, run, decision) {
  const used = Number.isFinite(decision?.used) ? decision.used : null;
  const state = decision?.pending ? 'scheduled' : decision?.rollover ? 'due' : decision?.hasSession && run.provider !== 'gemini' && used >= COMPACT_MIN_TOKENS ? 'large' : 'small';
  const mode = c.routing?.mode;
  return { context: { used, state }, action: state === 'large' ? 'compact' : mode && mode !== 'saving' ? 'saving' : null };
}

export function usageWatch(c, decision) {
  if (c.activeRun || c.routingPending || !c.lastRun?.id) return null;
  const run = c.runs?.findLast(item => item.id === c.lastRun.id);
  if (!run || run.local || !run.endedAt) return null;
  const size = run.usageSize || null, moves = withLargeMoves(c, run), largeMoves = moves.filter(move => move.large);
  if (!size && !moves.length) return null;
  // A run stopped by a limit, or waiting out a reset, already has its own message saying what happens next.
  const quiet = c.lastRun.errorCategory === 'quota' || c.resume || c.limitSwitching;
  return { runId: run.id, provider: run.provider, tokens: size?.tokens ?? null, partial: size?.partial === true, usual: size?.usual ?? null, samples: size?.samples ?? 0, moves,
    notice: !quiet && (size?.heavy || largeMoves.length) ? { heavy: size?.heavy === true, moves: largeMoves, ...nextStep(c, run, decision) } : null };
}

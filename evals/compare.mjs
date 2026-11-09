// Measured comparisons (#139): manual against routed on the same pinned repository and hidden checks, from results that
// were already saved. Nothing runs here, so nothing is spent: the repeats come from `run`, each with its stated budget.
// The arithmetic and quality gate are the app's own (src/smart-results.mjs), so a measured comparison and the Smart
// results card can't disagree on what counts as a saving. Every evaluation runs its hidden checks, so all of its tasks
// are tested; the remaining thresholds are lower than the app's because each repeat is a deliberate, matched run.
import { compare, METHOD } from '../src/smart-results.mjs';
import { fingerprint, observedModels } from './experiment.mjs';

export const MEASURED = Object.freeze({ ...METHOD, minTasks: 3, minVerified: 2, minPerSize: 3, minCheckedShare: 1 });

// Only what makes two fixtures the same task: the repository, the checks, the agent family, the context policy and the
// engine. The routing policy and recorded traces differ by design.
const matchKey = result => fingerprint({ snapshot: result.experiment?.inputs?.snapshot ?? result.snapshot, checks: result.experiment?.inputs?.checks?.files ?? null, live: result.live,
  provider: result.policy?.builder?.provider ?? null, context: result.policy?.context ?? null, threads: result.policy?.threads ?? 'continuous', engine: result.experiment?.inputs?.engine ?? null, runtime: result.experiment?.inputs?.runtime ?? null });

export function evalRow(result, size) {
  const outcome = result.outcome || {}, usage = result.usage;
  const complete = usage?.runs && !usage.partialRuns && usage.reportedBy?.input === usage.runs && usage.reportedBy?.output === usage.runs;
  return { id: result.startedAt, kind: 'eval', size, status: outcome.verifiedCompletion ? 'complete' : 'incomplete', verification: outcome.verifiedCompletion ? 'passed' : 'failed', verified: outcome.verifiedCompletion === true,
    firstAttemptSuccess: typeof outcome.firstAttemptSuccess === 'boolean' ? outcome.firstAttemptSuccess : null, retries: outcome.retries || 0, interventions: outcome.interventions || 0,
    workingMs: outcome.workingMs || 0, newTokens: complete ? usage.input + usage.output + (usage.cacheWrite || 0) : null, providers: [...new Set(observedModels(result.runs || []).map(agent => agent.provider))].sort() };
}

export function measuredComparisons(results, { baseline = 'small-edit', routed = 'routing-assessment', method = MEASURED } = {}) {
  const usable = results.filter(result => !result.skipped && !result.failure && result.experiment?.version === 1);
  const cohorts = new Map();
  for (const result of usable) {
    const side = result.fixture === baseline ? 'baseline' : result.fixture === routed ? 'routed' : null;
    if (!side) continue;
    const key = matchKey(result);
    if (!cohorts.has(key)) cohorts.set(key, { baseline: [], routed: [], live: result.live, provider: result.policy?.builder?.provider || null });
    cohorts.get(key)[side].push(result);
  }
  return [...cohorts.values()].map(cohort => {
    const size = `${baseline}→${routed}`;
    const result = compare(cohort.routed.map(item => evalRow(item, size)), cohort.baseline.map(item => evalRow(item, size)), method);
    return { baseline, routed, live: cohort.live, provider: cohort.provider, repeats: { baseline: cohort.baseline.length, routed: cohort.routed.length }, ...result };
  });
}

const pct = value => value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const range = metric => metric?.interval?.relative ? `${pct(metric.interval.relative[0])} to ${pct(metric.interval.relative[1])}` : 'n/a';
export function measuredMarkdown(rows) {
  if (!rows.length) return 'No matched manual and routed results. Run both fixtures on the same agent, for example:\n\n```sh\nnpm run eval -- run --fixture small-edit,routing-assessment --agent codex --repeat 3\n```\n';
  const lines = ['| Manual → routed | Agent | Mode | Repeats (manual / routed) | Status | Verified (manual / routed) | Work per verified, ms (manual / routed) | Work difference | 90% range | Tokens per verified (manual / routed) | Token difference | 90% range |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of rows) {
    const time = row.workingTime, tokens = row.newTokens, quality = row.quality;
    const per = metric => metric?.perVerified ? `${Math.round(metric.perVerified.baseline).toLocaleString('en-US')} / ${Math.round(metric.perVerified.routed).toLocaleString('en-US')}` : 'n/a';
    lines.push(`| ${row.baseline} → ${row.routed} | ${row.provider || 'unknown'} | ${row.live ? 'live' : 'recorded'} | ${row.repeats.baseline} / ${row.repeats.routed} | ${row.status}${row.missing?.length ? ` (${row.missing.map(item => `${item.need} ${item.have}/${item.want}`).join(', ')})` : ''} | ${quality ? `${pct(quality.verifiedShare.baseline)} / ${pct(quality.verifiedShare.routed)}` : 'n/a'} | ${per(time)} | ${pct(time?.relative)} | ${range(time)} | ${per(tokens)} | ${pct(tokens?.relative)} | ${range(tokens)} |`);
  }
  lines.push('', 'Difference is manual minus routed, as a share of manual: positive means routed used less per verified run. Failed runs count in usage. A range that includes zero is no clear difference, and a lower routed verified share than manual (by more than 5 points) is a quality regression, not a saving. Recorded runs replay saved traces: they check the arithmetic and accounting, not live efficiency. Only live results with enough repeats are evidence, and only for this fixture and agent.');
  return lines.join('\n') + '\n';
}

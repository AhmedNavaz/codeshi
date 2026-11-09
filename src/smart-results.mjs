// Smart results (#139): what routed tasks used and achieved, from the task ledger (#84) on this computer, and, only when
// the evidence allows, how that compares with tasks where you chose the agent yourself. No model is called, nothing is
// run to fill the gaps, and nothing is sent anywhere.
//
// The rules are fixed here, before any result is shown, and every report carries them:
// - Groups. Smart, Saver and Ultra are each compared with your manual tasks, never pooled with each other. A choice you
//   pinned while routing was on counts as manual. A routed task counts under the routing rules that chose it, and only
//   the latest rules are compared.
// - Matching. Tasks are compared within the same kind (a change or a question) and size (light, standard or deep, by
//   Codeshi's local rules on the request, the same rules for both sides) and context setting. A size needs
//   METHOD.minPerSize finished tasks on each side and one verified manual task to be compared at all.
// - Quality comes first. Verified means the task finished and the project's own tests passed afterwards. A task whose
//   tests never ran is unverified, never a success. Usage is compared per verified task, counting failed and stopped
//   tasks in the usage, so cheaper unfinished work can't look like a saving. If the routed group verifies a smaller
//   share of tasks than manual, by more than METHOD.qualityMargin, or too few tasks ran tests, there is no saving to
//   report.
// - Arithmetic. For each size, the manual usage per verified task times the routed group's verified tasks is what the
//   same verified work took by hand. The difference is that baseline total minus the routed total, summed over sizes,
//   and a percentage only when the baseline total is above zero. Totals are summed, never averaged percentages, and a
//   negative or zero difference is shown as it is.
// - Uncertainty. A seeded bootstrap resamples tasks within each size, so the same records give the same interval. An
//   interval that includes zero is inconclusive.
// - Units. Working time compares across agents. Tokens compare only between tasks where every run reported them, and
//   are not stated as a result when the two sides used different agents, which count tokens differently. API spend is
//   shown as the agents estimated it and never compared, since no dated price list is kept: a price change would look
//   like a routing effect. Plan allowance readings are account-wide and include other tools, so they never enter here.
import '../public/routing.js';

export const METHOD = Object.freeze({
  version: 1,
  minTasks: 10,         // finished, matched tasks on each side
  minVerified: 5,       // verified manual tasks across matched sizes
  minPerSize: 3,        // finished tasks on each side for a size to be compared
  minCheckedShare: 0.5, // share of tasks on each side whose tests ran
  qualityMargin: 0.05,  // how much lower the routed verified share may be before it is a regression
  interval: 0.9, resamples: 1000, seed: 139,
});
export const GROUPS = ['smart', 'saver', 'ultra', 'manual'];
const ROUTED = ['smart', 'saver', 'ultra'];
const DAY = 86400000;

// The number of fresh tokens a task's runs reported, or null when any run left input or output unreported.
function newTokens(usage) {
  if (!usage?.runs || usage.partialRuns || usage.reportedBy?.input !== usage.runs || usage.reportedBy?.output !== usage.runs) return null;
  return usage.input + usage.output + (usage.cacheWrite || 0);
}
const finished = task => task.status !== 'running';
const verified = task => task.status === 'complete' && task.verification === 'passed';
const checked = task => task.verification === 'passed' || task.verification === 'failed';
const sizeKey = row => row.kind && row.size ? `${row.kind}:${row.size}` : null;

// One row per task: what it used and how it ended, with nothing from the request unless prompts were asked for.
export function taskRow(task, { prompts = false } = {}) {
  const builders = (task.models || []).filter(model => !['assessment', 'review'].includes(model.role));
  const first = builders[0] || task.models?.[0] || null;
  return {
    id: task.id, startedAt: task.startedAt, endedAt: task.endedAt, group: task.routing?.mode || 'manual', ...(task.routing?.selectedBy ? { selectedBy: task.routing.selectedBy } : {}),
    policy: task.routing?.policy ?? null, kind: task.taskClass?.kind || null, size: task.taskClass?.size || null, contextPolicy: task.contextPolicy || null,
    status: task.status, verification: task.verification, verified: verified(task), firstAttemptSuccess: task.firstAttemptSuccess ?? null,
    workingMs: task.workingMs || 0, newTokens: newTokens(task.usage), cacheRead: task.usage?.cacheRead ?? null, runs: task.runs, runsWithTokens: task.usage?.runsWithTokens ?? 0,
    retries: task.retries || 0, interventions: task.interventions || 0, reviews: task.reviews || 0,
    assessments: task.roles?.assessment ? { runs: task.roles.assessment.runs, workingMs: task.roles.assessment.workingMs, newTokens: newTokens(task.roles.assessment.usage) } : null,
    agent: first ? { provider: first.provider, model: first.model, effort: first.effort } : null, providers: [...new Set((task.models || []).map(model => model.local ? 'local' : model.provider))].sort(),
    billing: task.billing || [], apiEstimateUSD: task.apiEstimateUSD || { total: null, runs: 0, billedRuns: 0 },
    // An assessor writes its reason in its own words, which can quote the request, so it travels with the prompt.
    ...(prompts && task.prompt ? { prompt: task.prompt } : {}), ...(prompts && task.routing?.reason ? { routingReason: task.routing.reason } : {}),
  };
}

function observe(rows) {
  const done = rows.filter(finished), tokens = done.filter(row => row.newTokens !== null), known = done.filter(row => row.firstAttemptSuccess !== null);
  const assessed = done.filter(row => row.assessments), sum = (list, pick) => list.reduce((total, row) => total + pick(row), 0);
  const counts = list => Object.fromEntries([...new Set(list)].sort().map(value => [value, list.filter(item => item === value).length]));
  const priced = done.filter(row => row.apiEstimateUSD.runs);
  return {
    tasks: done.length, verified: done.filter(row => row.verified).length, testsFailed: done.filter(row => row.verification === 'failed').length,
    untested: done.filter(row => row.verification === 'unverified').length, notFinished: done.filter(row => row.status !== 'complete').length,
    firstAttemptSuccess: { passed: known.filter(row => row.firstAttemptSuccess).length, of: known.length },
    retries: sum(done, row => row.retries), interventions: sum(done, row => row.interventions), workingMs: sum(done, row => row.workingMs),
    newTokens: { total: tokens.length ? sum(tokens, row => row.newTokens) : null, tasks: tokens.length, of: done.length },
    // Routing's own overhead, already inside the totals above, shown so it can't hide.
    assessments: { tasks: assessed.length, runs: sum(assessed, row => row.assessments.runs), workingMs: sum(assessed, row => row.assessments.workingMs), newTokens: assessed.every(row => row.assessments.newTokens !== null) && assessed.length ? sum(assessed, row => row.assessments.newTokens) : null },
    apiEstimateUSD: { total: priced.length ? sum(priced, row => row.apiEstimateUSD.total) : null, runs: sum(done, row => row.apiEstimateUSD.runs), billedRuns: sum(done, row => row.apiEstimateUSD.billedRuns) },
    providers: counts(done.flatMap(row => row.providers)), billing: counts(done.flatMap(row => row.billing)),
  };
}

// Mulberry32: small, seeded, and the same in every JavaScript engine.
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const percentile = (sorted, share) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))] : null;

// Difference for one metric across the sizes both sides have, from summed totals. sizes maps a size to its two lists.
export function difference(sizes, value) {
  const table = [];
  let baselineTotal = 0, routedTotal = 0, routedVerified = 0;
  for (const [size, { baseline, routed }] of sizes) {
    const manualTotal = baseline.reduce((sum, row) => sum + value(row), 0), manualVerified = baseline.filter(row => row.verified).length;
    if (!manualVerified) continue;
    const routedSum = routed.reduce((sum, row) => sum + value(row), 0), verifiedHere = routed.filter(row => row.verified).length;
    const expected = manualTotal / manualVerified * verifiedHere;
    table.push({ size, baseline: { tasks: baseline.length, verified: manualVerified, total: manualTotal, perVerified: manualTotal / manualVerified }, routed: { tasks: routed.length, verified: verifiedHere, total: routedSum }, baselineForRoutedWork: expected });
    baselineTotal += expected; routedTotal += routedSum; routedVerified += verifiedHere;
  }
  const delta = baselineTotal - routedTotal;
  return { sizes: table, baselineTotal, routedTotal, difference: delta, relative: baselineTotal > 0 ? delta / baselineTotal : null, routedVerified,
    perVerified: routedVerified ? { baseline: baselineTotal / routedVerified, routed: routedTotal / routedVerified } : null };
}

function interval(sizes, value, method) {
  const next = random(method.seed), absolute = [], relative = [];
  const draw = list => list.map(() => list[Math.floor(next() * list.length)]);
  for (let index = 0; index < method.resamples; index++) {
    const sample = new Map([...sizes].map(([size, sides]) => [size, { baseline: draw(sides.baseline), routed: draw(sides.routed) }]));
    const result = difference(sample, value);
    if (!result.sizes.length) continue;
    absolute.push(result.difference);
    if (result.relative !== null) relative.push(result.relative);
  }
  const tail = (1 - method.interval) / 2, sort = list => list.sort((a, b) => a - b);
  sort(absolute); sort(relative);
  return { level: method.interval, resamples: absolute.length, difference: [percentile(absolute, tail), percentile(absolute, 1 - tail)], relative: relative.length ? [percentile(relative, tail), percentile(relative, 1 - tail)] : null };
}

const group = (rows, key) => { const map = new Map(); for (const row of rows) { const value = key(row); if (!map.has(value)) map.set(value, []); map.get(value).push(row); } return map; };

// The comparison for one routing mode against the manual baseline. Every reason it can't be made is listed.
export function compare(routed, baseline, method = METHOD) {
  const routedSizes = group(routed, sizeKey), manualSizes = group(baseline, sizeKey), sizes = new Map(), unmatched = [];
  for (const [size, list] of routedSizes) {
    const manual = manualSizes.get(size) || [];
    if (list.length >= method.minPerSize && manual.length >= method.minPerSize && manual.some(verified)) sizes.set(size, { baseline: manual, routed: list });
    else unmatched.push({ size, routed: list.length, baseline: manual.length, manualVerified: manual.filter(verified).length });
  }
  for (const [size, list] of manualSizes) if (!routedSizes.has(size)) unmatched.push({ size, routed: 0, baseline: list.length, manualVerified: list.filter(verified).length });
  const matched = { routed: [...sizes.values()].flatMap(sides => sides.routed), baseline: [...sizes.values()].flatMap(sides => sides.baseline) };
  const missing = [];
  if (matched.routed.length < method.minTasks) missing.push({ need: 'routed-tasks', have: matched.routed.length, want: method.minTasks });
  if (matched.baseline.length < method.minTasks) missing.push({ need: 'manual-tasks', have: matched.baseline.length, want: method.minTasks });
  if (matched.baseline.filter(verified).length < method.minVerified) missing.push({ need: 'manual-verified', have: matched.baseline.filter(verified).length, want: method.minVerified });
  const base = { matched: { routed: matched.routed.length, baseline: matched.baseline.length }, unmatched, missing };
  if (missing.length) return { ...base, status: 'not-enough-data' };

  // Quality, with the manual rate weighted to the routed group's mix of sizes.
  const share = (list, test) => list.length ? list.filter(test).length / list.length : null;
  const routedRate = share(matched.routed, verified);
  const manualRate = [...sizes.values()].reduce((sum, sides) => sum + share(sides.baseline, verified) * sides.routed.length, 0) / matched.routed.length;
  const checkedShare = { routed: share(matched.routed, checked), baseline: share(matched.baseline, checked) };
  const quality = {
    verifiedShare: { routed: routedRate, baseline: manualRate }, checkedShare,
    firstAttemptSuccess: { routed: share(matched.routed.filter(row => row.firstAttemptSuccess !== null), row => row.firstAttemptSuccess), baseline: share(matched.baseline.filter(row => row.firstAttemptSuccess !== null), row => row.firstAttemptSuccess) },
    retriesPerTask: { routed: matched.routed.reduce((sum, row) => sum + row.retries, 0) / matched.routed.length, baseline: matched.baseline.reduce((sum, row) => sum + row.retries, 0) / matched.baseline.length },
    interventionsPerTask: { routed: matched.routed.reduce((sum, row) => sum + row.interventions, 0) / matched.routed.length, baseline: matched.baseline.reduce((sum, row) => sum + row.interventions, 0) / matched.baseline.length },
    status: checkedShare.routed < method.minCheckedShare || checkedShare.baseline < method.minCheckedShare ? 'not-established' : routedRate < manualRate - method.qualityMargin ? 'regression' : 'ok',
  };
  const providers = list => [...new Set(list.flatMap(row => row.providers))].sort();
  const sameAgents = JSON.stringify(providers(matched.routed)) === JSON.stringify(providers(matched.baseline));
  const metric = (value, { coveredOnly = false } = {}) => {
    const use = new Map([...sizes].map(([size, sides]) => [size, coveredOnly ? { baseline: sides.baseline.filter(row => value(row) !== null), routed: sides.routed.filter(row => value(row) !== null) } : sides]));
    const covered = [...use.values()].reduce((sum, sides) => sum + sides.baseline.length + sides.routed.length, 0), of = matched.routed.length + matched.baseline.length;
    const result = difference(use, value);
    if (!result.sizes.length) return { status: 'not-enough-data', coverage: { tasks: covered, of } };
    const range = interval(use, value, method), [low, high] = range.difference;
    const direction = low > 0 ? 'less' : high < 0 ? 'more' : 'inconclusive';
    return { ...result, interval: range, coverage: { tasks: covered, of }, direction };
  };
  const time = metric(row => row.workingMs), tokens = metric(row => row.newTokens, { coveredOnly: true });
  const headline = (result, extra = true) => result.direction && result.direction !== 'inconclusive' && quality.status === 'ok' && result.coverage.tasks === result.coverage.of && extra;
  if (time.direction) time.headline = headline(time);
  if (tokens.direction) { tokens.headline = headline(tokens, sameAgents); if (!sameAgents) tokens.caveat = 'different-agents'; }
  return { ...base, status: quality.status === 'regression' ? 'quality-regression' : quality.status === 'not-established' ? 'quality-not-established' : 'compared', quality, providers: { routed: providers(matched.routed), baseline: providers(matched.baseline), same: sameAgents }, workingTime: time, newTokens: tokens };
}

// The whole summary: observed results for every group, and each routing mode compared with your manual baseline.
// options.baseline narrows manual tasks to the agent you usually choose: { provider, model?, effort? }.
export function smartResults(tasks, { now = Date.now(), days = 30, baseline = null, exclude = [], prompts = false, method = METHOD } = {}) {
  const excludedIds = new Set(exclude), from = Number.isFinite(days) && days > 0 ? now - days * DAY : null;
  const rows = tasks.map(task => taskRow(task, { prompts })).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))), excluded = {};
  const leaveOut = (row, reason) => { row.included = false; row.excludedBecause = reason; excluded[reason] = (excluded[reason] || 0) + 1; };
  const inRange = rows.filter(row => from === null || Date.parse(row.startedAt) >= from);
  for (const row of inRange) row.included = true;
  for (const row of inRange) {
    if (excludedIds.has(row.id)) leaveOut(row, 'left-out-by-you');
    else if (!finished(row)) leaveOut(row, 'still-running');
  }
  const counted = inRange.filter(row => row.included);
  const observed = Object.fromEntries(GROUPS.map(name => [name, observe(counted.filter(row => row.group === name))]));

  // Comparable conditions: the latest context setting, and for each mode the latest routing rules.
  const latest = counted.at(-1), contextPolicy = latest?.contextPolicy ?? null;
  for (const row of counted) {
    if (row.contextPolicy !== contextPolicy) leaveOut(row, row.contextPolicy ? 'other-context-setting' : 'context-setting-not-recorded');
    else if (!row.size) leaveOut(row, 'no-size');
  }
  const manualOptions = [...group(counted.filter(row => row.group === 'manual' && row.agent), row => JSON.stringify([row.agent.provider, row.agent.model, row.agent.effort]))]
    .map(([key, list]) => { const [provider, model, effort] = JSON.parse(key); return { provider, model, effort, tasks: list.length }; }).sort((a, b) => b.tasks - a.tasks);
  const matchesBaseline = row => !baseline || row.agent?.provider === baseline.provider && (baseline.model == null || row.agent.model === baseline.model) && (baseline.effort == null || row.agent.effort === baseline.effort);
  for (const row of counted) if (row.included && row.group === 'manual' && !matchesBaseline(row)) leaveOut(row, 'other-manual-agent');
  const policies = {};
  for (const mode of ROUTED) {
    const list = counted.filter(row => row.included && row.group === mode);
    policies[mode] = list.at(-1)?.policy ?? null;
    for (const row of list) if (row.policy !== policies[mode]) leaveOut(row, 'earlier-routing-rules');
  }
  const manual = counted.filter(row => row.included && row.group === 'manual');
  const comparisons = Object.fromEntries(ROUTED.map(mode => [mode, { policy: policies[mode], ...compare(counted.filter(row => row.included && row.group === mode), manual, method) }]));
  return {
    format: 'codeshi-smart-results', version: method.version, method: { ...method }, generatedAt: new Date(now).toISOString(),
    range: { days: from === null ? null : days, from: from === null ? null : new Date(from).toISOString(), to: new Date(now).toISOString() },
    baseline: { choice: baseline, options: manualOptions, tasks: manual.length }, contextPolicy,
    observed, comparisons, excluded, tasks: inRange.reverse(),
  };
}

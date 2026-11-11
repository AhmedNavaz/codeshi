import assert from 'node:assert/strict';
import test from 'node:test';
import { continuationRequest } from '../src/context.mjs';
import { ledgerFromRecords } from '../src/task-ledger.mjs';
import { compare, difference, METHOD, SHARE, shareableReport, sharePost, smartResults } from '../src/smart-results.mjs';
import { measuredComparisons, measuredMarkdown } from '../evals/compare.mjs';

// Journal records for whole tasks, so every case goes through the real ledger the app reads.
const START = Date.UTC(2026, 10, 5);
const SIZES = { light: 'Rename the helper', standard: 'Fix the failing login form', deep: 'Migrate the database to Postgres' };
function journal() {
  const records = [];
  let clock = 0, count = 0;
  const iso = ms => new Date(START + ms).toISOString();
  const add = ({ group = 'manual', size = 'standard', seconds = 60, input = 1000, output = 100, tests = 'passed', status = 'complete', provider = 'codex', model = 'gpt-5', effort = 'low', billing = 'subscription', cost, contextPolicy = 'task', policy = 1, selectedBy = null, usage = true, id = `task-${++count}` } = {}) => {
    const start = clock; clock += seconds * 1000 + 1000;
    const routing = group === 'manual' && !selectedBy ? null : { mode: group === 'manual' ? 'smart' : group, reason: selectedBy ? 'Your explicit task selection' : 'a focused change', policy, ...(selectedBy ? { selectedBy } : {}) };
    records.push({ type: 'submission', id, provider, model, effort, mode: 'edit', at: iso(start), message: { role: 'user', text: SIZES[size], runId: id }, ...(contextPolicy === null ? {} : { context: { policy: contextPolicy } }), ...(routing ? { routing } : {}) });
    records.push({ type: 'run_metadata', at: iso(start + 1), metadata: { elapsedMs: seconds * 1000, account: { billingSource: billing }, ...(usage ? { usage: { input_tokens: input, output_tokens: output } } : {}), ...(cost === undefined ? {} : { costUSD: cost }) } });
    records.push({ type: 'run_end', at: iso(start + seconds * 1000), status });
    if (tests) records.push({ type: 'check', runId: id, check: { status: tests } });
    return id;
  };
  const many = (times, options) => { for (let index = 0; index < times; index++) add(options); };
  const results = (options = {}) => smartResults(ledgerFromRecords(records, { prompts: options.prompts }).tasks, { now: START + clock + 1000, days: null, ...options });
  return { records, add, many, results, iso, now: () => START + clock };
}
// A manual baseline and a Smart group that both clear every minimum.
function standardPair({ manual = {}, smart = {} } = {}) {
  const log = journal();
  log.many(12, { seconds: 300, input: 3000, ...manual });
  log.many(12, { group: 'smart', seconds: 200, input: 2000, ...smart });
  return log;
}

test('a cold start shows observed results only, with no percentage and nothing estimated', () => {
  const empty = smartResults([], { now: START });
  for (const name of ['smart', 'saver', 'ultra', 'manual']) assert.equal(empty.observed[name].tasks, 0);
  assert.equal(empty.comparisons.smart.status, 'not-enough-data');
  assert.equal(empty.comparisons.smart.workingTime, undefined);
  assert.deepEqual(empty.comparisons.smart.missing.map(item => item.need), ['routed-tasks', 'manual-tasks', 'manual-verified']);

  const log = journal();
  log.many(12, { group: 'smart' });
  const result = log.results();
  assert.equal(result.observed.smart.tasks, 12, 'Actual usage stays visible without a baseline.');
  assert.equal(result.observed.smart.verified, 12);
  assert.equal(result.comparisons.smart.status, 'not-enough-data');
  assert.deepEqual(result.comparisons.smart.missing.find(item => item.need === 'manual-tasks'), { need: 'manual-tasks', have: 0, want: METHOD.minTasks });
});

test('the comparison sums totals by size, weighted to the routed mix, rather than averaging percentages', () => {
  const log = journal();
  log.many(3, { size: 'light', seconds: 60, input: 600 });
  log.many(10, { size: 'standard', seconds: 300, input: 3000 });
  log.many(9, { group: 'smart', size: 'light', seconds: 30, input: 300 });
  log.many(3, { group: 'smart', size: 'standard', seconds: 330, input: 3300 });
  const { comparisons: { smart } } = log.results();
  assert.equal(smart.status, 'compared');
  const time = smart.workingTime;
  // By hand: 60 s × 9 + 300 s × 3 = 1,440 s against Smart's 270 s + 990 s = 1,260 s.
  assert.equal(time.baselineTotal, 1440000);
  assert.equal(time.routedTotal, 1260000);
  assert.equal(time.difference, 180000);
  assert.equal(time.relative, 0.125, 'Not the 20% that averaging the two sizes’ percentages would give.');
  assert.deepEqual(time.sizes.map(size => [size.size, size.baselineForRoutedWork, size.routed.total]), [['change:light', 540000, 270000], ['change:standard', 900000, 990000]]);
  assert.deepEqual(time.perVerified, { baseline: 120000, routed: 105000 });
  assert.equal(time.direction, 'less');
  assert.equal(time.headline, true);
  assert.equal(smart.newTokens.headline, true, 'Same agent on both sides, every run reported.');
  assert.equal(smart.newTokens.relative, (600 * 9 + 3000 * 3 + 100 * 12 - (300 * 9 + 3300 * 3 + 100 * 12)) / (600 * 9 + 3000 * 3 + 100 * 12));
  assert.deepEqual(log.results().comparisons.smart.workingTime.interval, time.interval, 'A seeded resample gives the same interval every time.');
});

test('extra usage is shown as a negative difference, never clamped to zero', () => {
  const { comparisons: { smart } } = standardPair({ smart: { seconds: 400 } }).results();
  assert.equal(smart.workingTime.difference < 0, true);
  assert.equal(Math.round(smart.workingTime.relative * 1000) / 1000, -0.333);
  assert.equal(smart.workingTime.direction, 'more');
  assert.equal(smart.workingTime.headline, true, 'Extra usage is as reportable as a saving.');
});

test('a zero baseline gives a difference but no percentage', () => {
  const { comparisons: { smart } } = standardPair({ manual: { input: 0, output: 0 } }).results();
  assert.equal(smart.newTokens.baselineTotal, 0);
  assert.equal(smart.newTokens.relative, null);
  assert.equal(smart.newTokens.direction, 'more');
  assert.equal(smart.newTokens.interval.relative, null);
});

test('incomplete usage is a partial token result and never a headline', () => {
  const log = standardPair();
  log.add({ group: 'smart', seconds: 200, usage: false });
  const result = log.results(), tokens = result.comparisons.smart.newTokens;
  assert.deepEqual(result.observed.smart.newTokens, { total: 13 * 0 + 12 * 2100, tasks: 12, of: 13 });
  assert.deepEqual(tokens.coverage, { tasks: 24, of: 25 });
  assert.equal(tokens.headline, false);
  assert.equal(result.comparisons.smart.workingTime.headline, true, 'Working time is still complete.');
});

test('lower usage on fewer verified tasks is a quality regression, not a saving', () => {
  const log = journal();
  log.many(12, { seconds: 300 });
  log.many(8, { group: 'smart', seconds: 100 });
  log.many(4, { group: 'smart', seconds: 100, tests: 'failed' });
  const { comparisons: { smart } } = log.results();
  assert.equal(smart.status, 'quality-regression');
  assert.equal(smart.quality.verifiedShare.routed, 8 / 12);
  assert.equal(smart.workingTime.headline, false);
  assert.equal(smart.newTokens.headline, false);

  const untested = journal();
  untested.many(12, { seconds: 300 });
  untested.many(6, { group: 'smart', seconds: 100 });
  untested.many(6, { group: 'smart', seconds: 100, tests: null });
  const result = untested.results().comparisons.smart;
  assert.equal(result.quality.checkedShare.routed, 0.5);
  untested.add({ group: 'smart', seconds: 100, tests: null });
  assert.equal(untested.results().comparisons.smart.status, 'quality-not-established', 'Unverified work is not counted as success.');
});

test('failed and stopped tasks count in usage and in the success denominators', () => {
  const log = standardPair();
  log.add({ group: 'smart', seconds: 500, status: 'interrupted', tests: null });
  const result = log.results(), smart = result.comparisons.smart;
  assert.equal(result.observed.smart.tasks, 13);
  assert.equal(result.observed.smart.notFinished, 1);
  assert.equal(smart.matched.routed, 13);
  assert.equal(smart.workingTime.routedTotal, 12 * 200000 + 500000);
  assert.equal(smart.quality.verifiedShare.routed, 12 / 13);
});

test('changed conditions stay in separate cohorts and are listed, not silently mixed', () => {
  const log = journal();
  log.many(2, { contextPolicy: null });
  log.many(2, { contextPolicy: 'recency' });
  log.many(3, { group: 'smart', policy: 1 });
  log.many(12, { seconds: 300 });
  log.many(2, { seconds: 300, provider: 'claude', model: 'opus' });
  log.add({ seconds: 300, selectedBy: 'you' });
  log.many(12, { group: 'smart', seconds: 200, policy: 2 });
  const choice = { provider: 'codex', model: null, effort: null };
  const result = log.results({ baseline: choice });
  assert.deepEqual(result.excluded, { 'context-setting-not-recorded': 2, 'other-context-setting': 2, 'other-manual-agent': 2, 'earlier-routing-rules': 3 });
  assert.equal(result.comparisons.smart.policy, 2);
  assert.equal(result.comparisons.smart.matched.routed, 12);
  assert.equal(result.comparisons.smart.matched.baseline, 13, 'A pick you pinned while routing was on counts as manual.');
  assert.equal(result.baseline.options[0].provider, 'codex');
  assert.equal(result.tasks.find(task => task.selectedBy === 'you').group, 'manual');
});

test('mixed agents and billing keep their units apart: no combined spend, and tokens across agents are not a result', () => {
  const log = journal();
  log.many(12, { seconds: 300, provider: 'codex' });
  log.many(6, { group: 'smart', seconds: 200, provider: 'claude', model: 'haiku', billing: 'api', cost: 0.25 });
  log.many(6, { group: 'smart', seconds: 200, provider: 'codex' });
  const result = log.results(), smart = result.comparisons.smart;
  assert.deepEqual(result.observed.smart.billing, { api: 6, subscription: 6 });
  assert.equal(result.observed.smart.apiEstimateUSD.total, 1.5);
  assert.equal(result.observed.manual.apiEstimateUSD.total, null, 'Subscription runs have no spend, not zero spend.');
  assert.equal(smart.providers.same, false);
  assert.equal(smart.newTokens.caveat, 'different-agents');
  assert.equal(smart.newTokens.headline, false);
  assert.equal(smart.workingTime.headline, true);
  assert.equal(Object.keys(smart).some(key => /spend|cost|usd/i.test(key)), false, 'API estimates are never compared.');

  // A price change moves the estimates, never the comparison.
  const repriced = journal();
  repriced.many(12, { seconds: 300, provider: 'codex' });
  repriced.many(6, { group: 'smart', seconds: 200, provider: 'claude', model: 'haiku', billing: 'api', cost: 0.75 });
  repriced.many(6, { group: 'smart', seconds: 200, provider: 'codex' });
  const after = repriced.results();
  assert.equal(after.observed.smart.apiEstimateUSD.total, 4.5);
  assert.deepEqual(after.comparisons, result.comparisons);
});

test('plan allowance readings never change results, since other tools use the same allowance', () => {
  const log = standardPair(), before = log.results();
  log.records.push({ type: 'quota_observation', provider: 'codex', at: log.iso(5), windows: [{ label: '5-hour', usedPercent: 90 }] });
  assert.deepEqual(log.results(), before);
});

test('a stopped run and its continuation are one task, counted once', () => {
  const log = journal(), iso = log.iso;
  log.records.push(
    { type: 'submission', id: 'first', provider: 'claude', mode: 'edit', at: iso(0), message: { role: 'user', text: SIZES.standard }, context: { policy: 'task' }, routing: { mode: 'smart', reason: 'a focused change', policy: 1 } },
    { type: 'run_metadata', at: iso(1), metadata: { elapsedMs: 60000, usage: { input_tokens: 500, output_tokens: 50 } } },
    { type: 'run_end', at: iso(60000), status: 'interrupted' },
    { type: 'submission', id: 'second', provider: 'codex', mode: 'edit', at: iso(70000), message: { role: 'user', text: continuationRequest }, context: { policy: 'task' } },
    { type: 'run_metadata', at: iso(70001), metadata: { elapsedMs: 30000, usage: { input_tokens: 200, output_tokens: 20 } } },
    { type: 'run_end', at: iso(100000), status: 'complete' },
    { type: 'check', runId: 'second', check: { status: 'passed' } },
  );
  const result = smartResults(ledgerFromRecords(log.records).tasks, { now: START + 200000, days: null });
  assert.equal(result.tasks.length, 1);
  assert.deepEqual([result.tasks[0].group, result.tasks[0].size, result.tasks[0].runs, result.tasks[0].workingMs, result.tasks[0].newTokens, result.tasks[0].verified], ['smart', 'standard', 2, 90000, 770, true]);
});

test('routing assessments count in Smart totals, including one that stopped before a builder', () => {
  const log = journal(), iso = log.iso;
  log.records.push(
    { type: 'routing_assessment_start', id: 'assess', taskId: 'stopped', routingMode: 'smart', policy: 1, provider: 'claude', at: iso(0) },
    { type: 'routing_assessment_end', id: 'assess', at: iso(4000), result: { status: 'failed', elapsedMs: 4000, usage: { input_tokens: 40, output_tokens: 4 } } },
  );
  const result = smartResults(ledgerFromRecords(log.records).tasks, { now: START + 10000, days: null });
  assert.equal(result.observed.smart.tasks, 1);
  assert.equal(result.observed.smart.verified, 0);
  assert.deepEqual(result.observed.smart.assessments, { tasks: 1, runs: 1, workingMs: 4000, newTokens: 44 });
  assert.equal(result.excluded['no-size'], 1, 'With no request saved it has no size to compare, but its usage still shows.');
});

test('the report holds no requests unless asked, and you can leave tasks out', () => {
  const log = standardPair(), plain = log.results();
  assert.equal(plain.format, 'codeshi-smart-results');
  assert.deepEqual(plain.method, { ...METHOD });
  assert.equal(JSON.stringify(plain).includes(SIZES.standard), false);
  assert.equal(JSON.stringify(plain).includes('a focused change'), false, 'An assessor’s reason can quote the request.');
  const withPrompts = log.results({ prompts: true });
  assert.equal(withPrompts.tasks[0].prompt, SIZES.standard);
  assert.equal(withPrompts.tasks[0].routingReason, 'a focused change');
  const id = plain.tasks.find(task => task.group === 'smart').id, left = log.results({ exclude: [id] });
  assert.equal(left.excluded['left-out-by-you'], 1);
  assert.equal(left.observed.smart.tasks, 11);
  assert.equal(left.tasks.find(task => task.id === id).included, false, 'A task left out is still listed, so it can be put back.');
});

test('a shared report drops requests, task IDs and times of day, and its post matches the file', () => {
  const log = standardPair(), full = log.results({ prompts: true }), shared = shareableReport(full);
  assert.equal(shared.format, SHARE.format);
  assert.deepEqual(shared.removed, ['requests', 'routing-reasons', 'task-ids', 'times-of-day']);
  const text = JSON.stringify(shared);
  assert.equal(text.includes(SIZES.standard), false, 'No request, even from a report made with prompts.');
  assert.equal(text.includes('a focused change'), false, 'No routing reason.');
  for (const task of full.tasks) assert.equal(text.includes(task.id), false, `Task ID ${task.id} is gone.`);
  assert.equal(/T\d{2}:\d{2}/.test(text), false, 'No time of day anywhere.');
  assert.deepEqual(shared.tasks.map(task => task.task).sort((a, b) => a - b), full.tasks.map((_, index) => index + 1), 'Tasks are numbered 1 to n.');
  const first = shared.tasks.find(task => task.task === 1), earliest = full.tasks.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
  assert.equal(first.startedOn, earliest.startedAt.slice(0, 10), 'Task 1 is the one that started first, with only its date.');
  assert.deepEqual(shared.observed, full.observed);
  assert.deepEqual(shared.comparisons, full.comparisons, 'The arithmetic is unchanged.');
  const post = sharePost(shared, { fileName: 'x.json' });
  assert.match(post.title, /^Routing results: \d+ tasks over all time$/);
  assert.match(post.body, /Drag x\.json into this box/);
  assert.match(post.body, new RegExp(`\\| Smart \\| ${shared.observed.smart.tasks} \\| ${shared.observed.smart.verified} \\|`));
  assert.match(post.body, /\*\*Smart compared with manual:\*\* /);
  assert.equal(post.body.includes(SIZES.standard), false);
});

test('a shared post with no tasks says so and makes no comparison', () => {
  const empty = shareableReport(smartResults([], { now: START, days: 30 })), post = sharePost(empty);
  assert.equal(empty.tasks.length, 0);
  assert.match(post.title, /^Manual results: 0 tasks over the last 30 days$/);
  assert.match(post.body, /No finished tasks in this range\./);
  assert.equal(post.body.includes('compared with manual'), false);
});

test('the time range only counts tasks that started inside it', () => {
  const log = standardPair();
  const recent = smartResults(ledgerFromRecords(log.records).tasks, { now: log.now() + 1000, days: 1 });
  assert.equal(recent.observed.smart.tasks, 12);
  const later = smartResults(ledgerFromRecords(log.records).tasks, { now: log.now() + 3 * 86400000, days: 1 });
  assert.equal(later.observed.smart.tasks + later.observed.manual.tasks, 0);
  assert.equal(later.range.days, 1);
});

test('difference and compare stay usable on their own for evaluation rows', () => {
  const rows = (count, ms, verified = true) => Array.from({ length: count }, () => ({ kind: 'eval', size: 'x', status: 'complete', verification: verified ? 'passed' : 'failed', verified, firstAttemptSuccess: verified, retries: 0, interventions: 0, workingMs: ms, newTokens: ms, providers: ['codex'] }));
  const result = difference(new Map([['eval:x', { baseline: rows(2, 100), routed: rows(2, 50) }]]), row => row.workingMs);
  assert.deepEqual([result.baselineTotal, result.routedTotal, result.relative], [200, 100, 0.5]);
  assert.equal(compare(rows(3, 50), rows(3, 100), { ...METHOD, minTasks: 3, minVerified: 2 }).status, 'compared');
});

test('measured comparisons pair manual and routed evaluations on the same repository and checks', () => {
  const result = (fixture, workingMs, verified = true, provider = 'codex', snapshot = 'abc') => ({
    fixture, live: true, startedAt: `${fixture}-${workingMs}-${Math.random()}`, policy: { builder: { provider }, context: 'task', threads: 'continuous' },
    experiment: { version: 1, inputs: { snapshot: { app: snapshot }, checks: { files: 'checks' }, engine: 'e', runtime: { node: 'v' } } },
    outcome: { verifiedCompletion: verified, firstAttemptSuccess: verified, workingMs, retries: 0, interventions: 0 },
    usage: { input: workingMs, output: 10, cacheWrite: null, runs: 1, partialRuns: 0, reportedBy: { input: 1, output: 1 } }, runs: [{ provider }],
  });
  const saved = [result('small-edit', 1000), result('small-edit', 1100), result('small-edit', 900), result('routing-assessment', 1300), result('routing-assessment', 1200), result('routing-assessment', 1400), result('routing-assessment', 500, true, 'codex', 'other')];
  const [row, other] = measuredComparisons(saved);
  assert.equal(row.status, 'compared');
  assert.deepEqual(row.repeats, { baseline: 3, routed: 3 });
  assert.equal(row.workingTime.relative, (3000 - 3900) / 3000, 'Routing’s own assessment time counts, so a slower routed run is shown as extra.');
  assert.equal(row.workingTime.direction, 'more');
  assert.equal(other.status, 'not-enough-data', 'A different repository snapshot is never paired.');
  const text = measuredMarkdown([row, other]);
  assert.match(text, /\| small-edit → routing-assessment \| codex \| live \| 3 \/ 3 \| compared \|/);
  assert.match(text, /-30\.0%/);
});

test('an Orchestrate plan’s planning run and steps are left out of Smart results rather than counted as single tasks', () => {
  const log = journal();
  log.many(3, { group: 'smart' });
  const tasks = ledgerFromRecords(log.records).tasks;
  tasks[0] = { ...tasks[0], plan: { id: 'p', part: 'planning' } };
  tasks[1] = { ...tasks[1], plan: { id: 'p', part: 'step', stepId: 's1', number: 1 } };
  const result = smartResults(tasks, { now: log.now() + 1000, days: null });
  assert.equal(result.observed.smart.tasks, 1);
  assert.equal(result.excluded['part-of-a-plan'], 2);
  assert.deepEqual(result.tasks.filter(row => row.plan).map(row => [row.plan, row.excludedBecause]).sort(), [['planning', 'part-of-a-plan'], ['step', 'part-of-a-plan']]);
});

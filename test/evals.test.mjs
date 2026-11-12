import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixtures, fixtureById } from '../evals/fixtures.mjs';
import { compareResults, parsePolicy, repeatedFileReads, reportMarkdown, runCheck, runFixture } from '../evals/harness.mjs';
import { scriptCLIs } from './platform.mjs';
import { checkPin, experimentInputs, fingerprint, validatePin } from '../evals/experiment.mjs';

const cli = new URL('../evals/cli.mjs', import.meta.url).pathname;

test('routing evaluations count assessor overhead, reserve its budget and repeat the same pinned inputs', { skip: scriptCLIs }, async () => {
  const fixture = fixtureById('routing-assessment'), policy = parsePolicy({ agent: 'codex' });
  const budget = { maxRuns: 2, maxTokens: 10000, runs: 0, tokens: 0 };
  const result = await runFixture(fixture, policy, { budget });
  assert.equal(result.failure, undefined);
  assert.equal(result.check.passed, true);
  assert.deepEqual(result.runs.map(run => run.role), ['assessment', 'builder']);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.runs[1].parentRunId, result.runs[0].runId);
  assert.equal(result.usage.input, 1500);
  assert.equal(result.usage.output, 130);
  assert.equal(budget.runs, 2);
  assert.equal(budget.tokens, 2030);
  assert.equal(result.accounting.roles.assessment.usage.input, 300);
  assert.equal(result.accounting.roles.builder.usage.input, 1200);
  const repeated = await runFixture(fixture, policy, { pin: result });
  assert.equal(repeated.failure, undefined);
  assert.equal(compareResults([result, repeated])[0].repeats, 2);
  assert.match(reportMarkdown(compareResults([result])), /\| assessment \|/);
  const stopped = await runFixture(fixture, policy, { budget: { maxRuns: 1, maxTokens: 10000, runs: 0, tokens: 0 } });
  assert.equal(stopped.skipped, 'budget');
  assert.equal(stopped.runs.length, 0);
});

test('failed routing assessments retain measured overhead when the builder falls back', { skip: scriptCLIs }, async () => {
  const fixture = structuredClone(fixtureById('routing-assessment'));
  fixture.trace[0].steps[0].text = 'invalid assessment';
  const result = await runFixture(fixture, parsePolicy({ agent: 'codex' }));
  assert.equal(result.failure, undefined);
  assert.equal(result.runs[0].status, 'failed');
  assert.equal(result.accounting.roles.assessment.usage.input, 300);
  assert.equal(result.usage.input, 1500);
  assert.equal(result.check.passed, true);
  assert.equal(result.outcome.firstAttemptSuccess, false);
});

test('recorded Claude routing uses the SDK assessor and CLI builder without losing either usage report', { skip: scriptCLIs }, async () => {
  const result = await runFixture(fixtureById('routing-assessment'), parsePolicy({ agent: 'claude' }));
  assert.equal(result.failure, undefined);
  assert.equal(result.check.passed, true);
  assert.deepEqual(result.runs.map(run => run.status), ['complete', 'complete']);
  assert.deepEqual(result.runs.map(run => run.role), ['assessment', 'builder']);
  assert.equal(result.usage.input, 1500);
  assert.equal(result.accounting.roles.assessment.usage.input, 300);
  assert.equal(result.accounting.roles.builder.usage.input, 1200);
});

test('every kind of task the issue asks for has a fixture with a check the agent cannot see', () => {
  assert.deepEqual(fixtures.map(fixture => fixture.id), ['small-edit', 'cross-folder', 'bug-repair', 'quota-handoff', 'context-heavy', 'memory-reuse', 'skill-procedure', 'skill-handoff', 'long-thread', 'review', 'view-states', 'api-endpoint', 'data-migration', 'accessible-toolbar', 'review-intent', 'test-writing', 'routing-assessment']);
  for (const fixture of fixtures) {
    assert(fixture.check || fixture.checkReply, fixture.id);
    assert(fixture.rubric, fixture.id);
    assert(fixture.trace?.length, fixture.id);
    for (const [folder, files] of Object.entries(fixture.folders)) for (const name of Object.keys(files)) assert.equal(fixture.check?.[folder]?.[name], undefined, `${fixture.id}: ${name} is hidden, so it can't also be in the repository.`);
  }
});

// Writes a fixture with an answer on top and runs its hidden check, the way an evaluation does after the agent finishes.
const answer = (t, fixture, files = {}, reply = '') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-answer-')), folders = {};
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(fixture.folders)) {
    folders[name] = path.join(root, name);
    for (const [file, text] of Object.entries({ ...content, ...files[name] })) { fs.mkdirSync(path.dirname(path.join(folders[name], file)), { recursive: true }); fs.writeFileSync(path.join(folders[name], file), text); }
  }
  return runCheck(fixture, folders, [reply]);
};

test('each starter skill has a task, and its hidden check refuses the slip that starter is about while allowing other sound answers', t => {
  const starters = fs.readdirSync(new URL('../starter-skills/', import.meta.url), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(fixtures.filter(fixture => fixture.starter).map(fixture => fixture.starter).sort(), starters);
  const slips = {
    'view-states': [{ web: { 'orders.mjs': 'export function renderOrders(state) {\n  return `<ul>${state.orders.map(order => `<li>#${order.number} ${order.customer}</li>`).join(\'\')}</ul>`;\n}\n' } }],
    'api-endpoint': [{ api: { 'routes.mjs': fixtureById('api-endpoint').folders.api['routes.mjs'] + "\nexport function renameUser({ params, body }) {\n  const found = users.get(params.id);\n  if (!found) return fail(404, 'not_found', 'No such user.');\n  if (!body.name) return fail(400, 'invalid_name', 'Give a name.');\n  found.name = body.name;\n  return { status: 200, body: publicUser(found) };\n}\n" } }],
    'data-migration': [{ db: { 'migrations/003_add_country.mjs': "export function up(db) { db.addColumn('users', 'country', { required: true }); db.update('users', row => { row.country = 'DE'; }); }\nexport function down(db) { db.dropColumn('users', 'country'); }\n" } },
      { db: { 'migrations/003_add_country.mjs': "export function up(db) { db.addColumn('users', 'country', { required: true, default: 'DE' }); }\nexport function down(db) { db.dropTable('users'); }\n" } }],
    'accessible-toolbar': [{ web: { 'toolbar.mjs': "export function renderToolbar({ query = '', count = 0 } = {}) {\n  return `<div class=\"toolbar\"><h2>Results</h2><input type=\"search\" placeholder=\"Search\" value=\"${query}\"><span class=\"clear\">×</span><p>${count} results</p></div>`;\n}\n" } }],
    'test-writing': [{}, { lib: { 'duration.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { parseDuration } from './duration.mjs';\ntest('parses', () => { assert.equal(parseDuration('1h30m'), 5400); assert.equal(parseDuration('45s'), 45); });\n" } }],
  };
  for (const [id, wrong] of Object.entries(slips)) for (const files of wrong) assert.equal(answer(t, fixtureById(id), files).passed, false, `${id} should refuse ${JSON.stringify(files).slice(0, 80)}`);
  const review = fixtureById('review-intent');
  for (const reply of ['Looks good: the discount maths is right and both tests pass.', 'applyCoupon never records the use in usedCoupons, so WELCOME10 can be reused.'])
    assert.equal(answer(t, review, {}, reply).passed, false, reply);
  assert.equal(answer(t, review, {}, 'Bug 1: nothing is ever added to `customer.usedCoupons`, so a customer can apply WELCOME10 repeatedly. Bug 2: the lookup normalises with toUpperCase() but the used check compares the raw code.').passed, true);
  // Other sound answers pass too: a default instead of a backfill, and a label around the field with hidden button text.
  assert.equal(answer(t, fixtureById('data-migration'), { db: { 'migrations/003_country.mjs': "export const up = db => db.addColumn('users', 'country', { required: true, default: 'DE' });\nexport const down = db => db.dropColumn('users', 'country');\n" } }).passed, true);
  assert.equal(answer(t, fixtureById('accessible-toolbar'), { web: { 'toolbar.mjs': "export function renderToolbar({ query = '', count = 0 } = {}) {\n  return `<div class=\"toolbar\"><label>Search <input type=\"search\" value=\"${query}\"></label><button type=\"button\"><span aria-hidden=\"true\">×</span><span class=\"visually-hidden\">Clear search</span></button><div aria-live=\"polite\">${count} results</div></div>`;\n}\n" } }).passed, true);
  // A failed check says which parts failed, by the check's own names and never with the agent's text.
  assert.deepEqual(answer(t, fixtureById('api-endpoint'), slips['api-endpoint'][0]).results[0].failed, ['someone else is refused with 403', 'a missing, empty or non-text name is refused with 400']);
  assert.deepEqual(answer(t, fixtureById('data-migration'), slips['data-migration'][0]).results[0].failed, ['applies to a table that already has users, who get DE', 'country is required', 'undoing it removes only the country']);
  assert.deepEqual(answer(t, review, {}, 'applyCoupon never records the use in usedCoupons, so WELCOME10 can be reused.').results[0].failed, ['names the case-sensitive check']);
  assert.deepEqual(answer(t, fixtureById('test-writing'), slips['test-writing'][1]).results[0].failed, ['the tests catch: empty text gives 0', 'the tests catch: other text gives 0']);
});

test('recorded evaluations run every fixture through the real broker, verified by their hidden checks', { skip: scriptCLIs }, async () => {
  for (const fixture of fixtures) {
    const result = await runFixture(fixture, parsePolicy({ agent: 'codex' }));
    assert.equal(result.failure, undefined, `${fixture.id}: ${result.failure}`);
    assert.equal(result.check.passed, true, `${fixture.id}: ${JSON.stringify(result.check)}`);
    assert.equal(result.outcome.verifiedCompletion, true);
    assert.equal(result.live, false);
    assert(Object.values(result.snapshot).every(commit => /^[\da-f]{40}$/.test(commit)));
    assert.equal(JSON.stringify(result.runs).includes('raw'), false, 'Results hold no raw agent output.');
    assert.equal(result.outcome.missingUsage, 0);
  }
});

test('a fixture is pinned: the same one is the same commit and the same hash every time', { skip: scriptCLIs }, async () => {
  const first = await runFixture(fixtureById('small-edit'), parsePolicy({ agent: 'codex' })), second = await runFixture(fixtureById('small-edit'), parsePolicy({ agent: 'codex' }), { pin: first });
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.equal(first.fixtureHash, second.fixtureHash);
  assert.equal(second.failure, undefined);
  assert.deepEqual(first.experiment, second.experiment);
  assert.equal(compareResults([first, second])[0].repeats, 2);
  assert(first.outcome.wallMs >= first.outcome.workingMs);
});

test('a handoff is one task across two runs, with both runs in its total', { skip: scriptCLIs }, async () => {
  const result = await runFixture(fixtureById('quota-handoff'), parsePolicy({ agent: 'codex', to: 'codex' }));
  assert.equal(result.tasks.length, 1);
  assert.deepEqual([result.tasks[0].runs, result.tasks[0].continuations], [2, 1]);
  assert.equal(result.runs[0].status, 'interrupted');
  assert.deepEqual([result.usage.input, result.usage.output], [1500 + 2400, 80 + 170], 'The second run counts only what it added to the running total.');
  assert.equal(result.outcome.firstAttemptSuccess, null, 'A run stopped on purpose says nothing about its first attempt.');
});

test('long workloads compare resumed sessions, separate threads and switching back on the same snapshots and checks', { skip: scriptCLIs }, async () => {
  const fixture = fixtureById('long-thread');
  const continuous = await runFixture(fixture, parsePolicy({ agent: 'codex' }));
  const separate = await runFixture(fixture, parsePolicy({ agent: 'codex', threads: 'separate' }));
  const switched = await runFixture(fixture, parsePolicy({ agent: 'codex', to: 'claude' }));
  for (const result of [continuous, separate, switched]) {
    assert.equal(result.failure, undefined);
    assert.equal(result.check.passed, true);
    assert.equal(result.runs.length, 3);
    assert.equal(result.outcome.missingUsage, 0);
    assert.deepEqual([result.usage.input, result.usage.cacheRead, result.usage.output], [6500, 2300, 310]);
    assert.equal(result.outcome.compactions, 1);
    assert.equal(result.outcome.repeatedFileReads, 1);
    assert(result.turns.every(turn => turn.reconstruction.source === 'fresh-envelope-probe'));
    assert(result.turns.every(turn => turn.reconstruction.factsKept === turn.reconstruction.factsTotal));
    assert.deepEqual(result.snapshot, continuous.snapshot);
    assert.deepEqual(result.experiment.inputs.checks, continuous.experiment.inputs.checks);
    assert.equal(result.accounting.nativeCompactionUsage, 'not-separately-attributable');
  }
  assert.deepEqual(continuous.runs.map(run => run.context.sessionMode), ['fresh', 'resumed', 'resumed']);
  assert.equal(continuous.turns[2].context.restoredAfterCompaction, true, 'The actual resumed dispatch rebuilds task context after the native compaction notification.');
  assert.equal(separate.turns[2].context.restoredAfterCompaction, undefined);
  assert.deepEqual(separate.runs.map(run => run.context.sessionMode), ['fresh', 'fresh', 'fresh']);
  assert.deepEqual(switched.runs.map(run => run.provider), ['codex', 'claude', 'codex']);
  assert.deepEqual(switched.runs.map(run => run.context.sessionReason), ['new-conversation', 'cross-agent-handoff', 'cross-agent-handoff']);
  assert.equal(continuous.usage.reasoning, 90);
  assert.equal(switched.usage.reportedBy.reasoning, 2, 'Claude did not report separate reasoning tokens.');
  assert.equal(continuous.runs[2].usage.sessionTotal.input, 8800, 'The session counter includes cached input and earlier tasks.');
  assert.equal(continuous.runs[2].usage.context.lastRequest.inputTokens, 2400);
  assert.equal(switched.runs[2].usage.sessionTotal.input, 2400, 'Switching back really starts a new session.');
  assert.equal(compareResults([continuous, separate, switched]).length, 3);
});

test('workload budgets stop between turns, and reconstruction alone cannot verify a broken result', { skip: scriptCLIs }, async () => {
  const fixture = fixtureById('long-thread'), policy = parsePolicy({ agent: 'codex' });
  const budget = { maxRuns: 3, maxTokens: 100, runs: 0, tokens: 0 };
  const stopped = await runFixture(fixture, policy, { budget });
  assert.equal(stopped.skipped, 'budget');
  assert.equal(stopped.runs.length, 1);
  assert.equal(budget.tokens, 4420, 'Cached inputs count toward the evaluation budget; reasoning is already in output.');
  assert.equal(stopped.outcome.verifiedCompletion, false);
  const failedDispatch = await runFixture(fixture, parsePolicy({ agent: 'codex', to: 'unsupported' }));
  assert(failedDispatch.failure);
  assert.equal(failedDispatch.runs.length, 1);
  assert.equal(failedDispatch.usage.input, 3500, 'A later failed dispatch cannot erase earlier measured usage.');
  assert.equal(failedDispatch.outcome.verifiedCompletion, false);
  const trace = structuredClone(fixture.trace);
  trace[2].steps.find(step => step.type === 'write').content = "export function receipt() { return 'wrong separator and currency'; }\n";
  const broken = await runFixture({ ...fixture, trace }, policy);
  assert.equal(broken.turns[2].reconstruction.factsKept, broken.turns[2].reconstruction.factsTotal);
  assert.equal(broken.outcome.verifiedCompletion, false);
  assert.equal(broken.outcome.firstAttemptSuccess, false);
  assert.match(reportMarkdown(compareResults([broken])), /does not measure retention inside/);
});

test('task context keeps every fact of a long history and leaves out the other folder, unlike the older selection', { skip: scriptCLIs }, async () => {
  const task = await runFixture(fixtureById('context-heavy'), parsePolicy({ agent: 'codex', context: 'task' })), older = await runFixture(fixtureById('context-heavy'), parsePolicy({ agent: 'codex', context: 'recency' }));
  assert.deepEqual([task.context.factsKept, task.context.factsTotal], [4, 4]);
  assert.equal(task.context.unrelatedSteps, 0);
  assert(older.context.unrelatedSteps > 0);
  assert(task.context.bytes < older.context.bytes);
});

test('a live evaluation needs a stated budget, and stops when it is spent', { skip: scriptCLIs }, async () => {
  await assert.rejects(runFixture(fixtureById('small-edit'), parsePolicy({ agent: 'codex' }), { live: true }), /stated budget/);
  const budget = { maxRuns: 1, runs: 0, tokens: 0 };
  const first = await runFixture(fixtureById('quota-handoff'), parsePolicy({ agent: 'codex' }), { budget });
  assert.equal(budget.runs, 1);
  assert.equal(first.skipped, 'budget', 'The second run was never started.');
  const none = await runFixture(fixtureById('small-edit'), parsePolicy({ agent: 'codex' }), { budget });
  assert.equal(none.skipped, 'budget');
  assert.equal(none.runs.length, 0);
  const result = spawnSync(process.execPath, [cli, 'run', '--live', '--agent', 'codex'], { encoding: 'utf8', env: { ...process.env, CODESHI_EVAL_RESULTS: path.join(os.tmpdir(), 'unused') } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /State a budget/);
});

test('nobody answers in an evaluation: a question is skipped and counted, and a run past the time limit is stopped', { skip: scriptCLIs }, async () => {
  const base = fixtureById('review');
  const asking = await runFixture({ ...base, trace: [{ steps: [{ type: 'ask', text: 'Which format?' }, { type: 'say', text: 'Without an answer: it never divides by 100.' }], usage: { input: 10, cached: 0, output: 1, reasoning: 0 } }] }, parsePolicy({ agent: 'codex' }));
  assert.equal(asking.failure, undefined);
  assert.equal(asking.outcome.questionsAsked, 1);
  assert.equal(asking.check.passed, true, 'The run carried on and finished.');
  const stuck = await runFixture({ ...base, trace: [{ hold: true, steps: [{ type: 'say', text: 'Working' }] }] }, parsePolicy({ agent: 'codex' }), { runLimitMs: 300 });
  assert.equal(stuck.outcome.timedOut, true);
  assert.equal(stuck.runs[0].status, 'interrupted');
  assert.equal(compareResults([asking])[0].interventions.median, 1, 'Needing to ask shows in the report.');
});

test('the report compares policies, shows the spread and says what is unknown', () => {
  const outcome = { firstAttemptSuccess: true, verifiedCompletion: true, workingMs: 100, retries: 0, interventions: 0, repeatedFileReads: 1 };
  const policy = parsePolicy({ agent: 'claude:haiku', context: 'task' });
  const provenance = { experiment: { version: 1, id: 'same-inputs' }, runs: [{ provider: 'claude', effectiveModel: 'haiku', effort: null }] };
  const rows = compareResults([
    { ...provenance, fixture: 'small-edit', policy, live: true, outcome, usage: { input: 10, output: 5, cacheRead: null } },
    { ...provenance, fixture: 'small-edit', policy, live: true, outcome: { ...outcome, verifiedCompletion: false, workingMs: 300 }, usage: { input: 30, output: 5, cacheRead: null } },
    { ...provenance, fixture: 'small-edit', policy, live: true, outcome: { ...outcome, workingMs: 200 }, usage: null },
  ]);
  assert.deepEqual(rows[0].verifiedCompletion, { passed: 2, of: 3 });
  assert.deepEqual(rows[0].input, { median: 10, min: 10, max: 30, reported: 2, of: 3 });
  assert.equal(rows[0].cacheRead.median, null);
  const report = reportMarkdown(rows);
  assert.match(report, /\| 2\/3 \|/);
  assert.match(report, /10 \(10–30\)/);
  assert.match(report, /unknown/);
  assert.match(report, /it is not zero/);
});

test('results can be listed, reported and deleted, and are written only where they were asked to go', { skip: scriptCLIs }, t => {
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-eval-results-'));
  t.after(() => fs.rmSync(results, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, CODESHI_EVAL_RESULTS: results } });
  const ran = run('run', '--agent', 'codex', '--fixture', 'small-edit');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /small-edit \[codex task\] verified/);
  const [file] = fs.readdirSync(results);
  assert.equal(fs.statSync(path.join(results, file)).mode & 0o077, 0, 'Readable only by you.');
  assert.match(run('list').stdout, /small-edit/);
  assert.match(run('report').stdout, /small-edit/);
  assert.equal(run('delete').status, 2);
  assert.match(run('delete', 'all').stdout, /Deleted 1/);
  assert.deepEqual(fs.readdirSync(results), []);
});

test('repeated reads count a file a later run reads again', () => {
  const read = (runId, file) => ({ role: 'activity', runId, text: `Read\n${JSON.stringify({ file_path: `/w/${file}` })}\nok` });
  assert.equal(repeatedFileReads([read('a', 'x.js'), read('a', 'x.js'), read('a', 'y.js'), read('b', 'x.js'), { role: 'activity', runId: 'b', text: '$ cat y.js\nok' }, { role: 'activity', runId: 'b', text: '$ cat new.js\nok' }], { workspace: '/w' }), 2);
  assert.equal(repeatedFileReads([read('a', 'shop/index.js'), read('b', 'ops/index.js')]), 0, 'Same basename in another folder is different work.');
});

test('pins cover skill resources, checks and runtime, and keep their contents private', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-eval-skill-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'SKILL.md'), 'Private instructions');
  fs.writeFileSync(path.join(directory, 'guide.md'), 'Private reference');
  const fixture = fixtureById('small-edit');
  const options = { fixture, fixtureHash: 'fixture', snapshot: { app: 'commit' }, policy: parsePolicy({ agent: 'codex' }), live: false, runLimitMs: 1000,
    skills: [{ name: 'test-skill', version: 'version', snapshot: directory, files: ['SKILL.md', 'guide.md'] }] };
  const original = experimentInputs(options), pin = { experiment: original };
  checkPin(pin, experimentInputs(options));
  const serialized = JSON.stringify(original);
  for (const secret of ['Private instructions', 'Private reference', directory, fixture.prompt, fixture.check.app['greet.test.mjs']]) assert(!serialized.includes(secret));
  fs.writeFileSync(path.join(directory, 'guide.md'), 'Changed reference');
  assert.throws(() => checkPin(pin, experimentInputs(options)), /inputs changed: skills/);
  const changedCheck = experimentInputs({ ...options, skills: [], fixture: { ...fixture, checkReply: /new check/i } });
  assert.throws(() => checkPin({ experiment: experimentInputs({ ...options, skills: [] }) }, changedCheck), /checks/);
  assert.throws(() => checkPin(pin, experimentInputs({ ...options, runLimitMs: 500 })), /runLimitMs/);
  assert.throws(() => validatePin({}), /no valid experiment pin/);
  assert.throws(() => validatePin({ experiment: { ...original, inputs: { ...original.inputs, live: true } } }), /no valid experiment pin/);
});

test('pinned runs refuse changed skills and check flags before spending any run budget', { skip: scriptCLIs }, async () => {
  const fixture = fixtureById('skill-procedure'), policy = parsePolicy({ agent: 'codex', skill: 'test-authoring' });
  const first = await runFixture(fixture, policy);
  assert.equal(first.failure, undefined);
  assert.deepEqual(first.experiment.inputs.skills.map(skill => skill.name), ['change-note', 'test-authoring']);
  assert(first.experiment.inputs.skills.every(skill => /^[a-f0-9]{64}$/.test(skill.version)));
  const again = await runFixture(fixture, policy, { pin: JSON.parse(JSON.stringify(first)) });
  assert.equal(again.check.passed, true);
  assert.equal(again.failure, undefined);
  const budget = { maxRuns: 1, runs: 0, tokens: 0 };
  const changed = await runFixture({ ...fixture, skills: { 'change-note': fixture.skills['change-note'] + '\nA new instruction.\n' } }, policy, { pin: first, budget });
  assert.match(changed.failure, /inputs changed:.*skills/);
  assert.equal(budget.runs, 0);
  const reply = fixtureById('review'), original = await runFixture(reply, parsePolicy({ agent: 'codex' }));
  const flags = await runFixture({ ...reply, checkReply: new RegExp(reply.checkReply.source) }, parsePolicy({ agent: 'codex' }), { pin: original, budget });
  assert.match(flags.failure, /inputs changed:.*checks/);
  assert.equal(budget.runs, 0);
});

test('reports never pool different experiments, live and recorded results, changed models or unpinned history', () => {
  const base = { fixture: 'small-edit', policy: parsePolicy({ agent: 'codex' }), live: true, outcome: {},
    experiment: { version: 1, id: fingerprint({ fixture: 'a' }) }, runs: [{ provider: 'codex', effectiveModel: 'm1', effort: 'low' }] };
  const rows = compareResults([base, { ...base }, { ...base, live: false }, { ...base, experiment: { version: 1, id: fingerprint({ fixture: 'b' }) } },
    { ...base, runs: [{ ...base.runs[0], effectiveModel: 'm2' }] }, { ...base, runs: [{ ...base.runs[0], effort: 'high' }] },
    { ...base, experiment: undefined }, { ...base, experiment: undefined }, { ...base, runs: [] }, { ...base, runs: [] }]);
  assert.deepEqual(rows.map(row => row.repeats), [2, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.match(reportMarkdown(rows), /legacy \(unmatched\)/);
});

test('reported model drift fails a repeat while preserving its measured usage and check result', { skip: scriptCLIs }, async () => {
  const fixture = fixtureById('small-edit'), policy = parsePolicy({ agent: 'codex' });
  const original = await runFixture(fixture, policy);
  const pin = { ...original, runs: original.runs.map(run => ({ ...run, effectiveModel: 'previous-model' })) };
  const budget = { maxRuns: 1, runs: 0, tokens: 0 };
  const changed = await runFixture(fixture, policy, { pin, budget });
  assert.match(changed.failure, /provider-reported model or effort changed/);
  assert.equal(changed.check.passed, true);
  assert.equal(changed.usage.input, original.usage.input);
  assert.equal(budget.runs, 1);
  assert(budget.tokens > 0);
  assert.equal(compareResults([pin, changed]).length, 2);
});

test('CLI repeats a saved pin, rejects overrides and drift, and never implies live approval', { skip: scriptCLIs }, t => {
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-eval-pin-'));
  t.after(() => fs.rmSync(results, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, 'run', ...args], { encoding: 'utf8', env: { ...process.env, CODESHI_EVAL_RESULTS: results } });
  assert.equal(run('--fixture', 'small-edit').status, 0);
  const [file] = fs.readdirSync(results), original = JSON.parse(fs.readFileSync(path.join(results, file), 'utf8'));
  const repeat = run('--pin', file);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(repeat.stdout, /verified/);
  assert.equal(run('--pin', file, '--agent', 'claude').status, 2);
  assert.equal(run('--pin', file, '--threads', 'separate').status, 2);
  assert.equal(run('--pin', file, '--live', '--max-runs', '1').status, 2);
  const drift = { ...original, experiment: { ...original.experiment, inputs: { ...original.experiment.inputs, engine: 'old-engine' } } };
  drift.experiment.id = fingerprint(drift.experiment.inputs);
  fs.writeFileSync(path.join(results, 'drift.json'), JSON.stringify(drift));
  const refused = run('--pin', 'drift.json');
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /inputs changed: engine/);
  const live = { ...original, live: true, experiment: { ...original.experiment, inputs: { ...original.experiment.inputs, live: true } } };
  live.experiment.id = fingerprint(live.experiment.inputs);
  fs.writeFileSync(path.join(results, 'live.json'), JSON.stringify(live));
  assert.match(run('--pin', 'live.json').stderr, /needs --live and a new stated budget/);
  assert.match(run('--pin', 'live.json', '--live').stderr, /State a budget/);
  for (const invalid of ['Infinity', '-1', '1.5']) assert.equal(run('--pin', 'live.json', '--live', '--max-runs', invalid).status, 2);
  assert.equal(run('--pin', file, '--repeat', '-1').status, 2);
});

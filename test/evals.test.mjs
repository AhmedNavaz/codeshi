import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixtures, fixtureById } from '../evals/fixtures.mjs';
import { compareResults, parsePolicy, repeatedFileReads, reportMarkdown, runFixture } from '../evals/harness.mjs';
import { scriptCLIs } from './platform.mjs';
import { checkPin, experimentInputs, fingerprint, validatePin } from '../evals/experiment.mjs';

const cli = new URL('../evals/cli.mjs', import.meta.url).pathname;

test('every kind of task the issue asks for has a fixture with a check the agent cannot see', () => {
  assert.deepEqual(fixtures.map(fixture => fixture.id), ['small-edit', 'cross-folder', 'bug-repair', 'quota-handoff', 'context-heavy', 'memory-reuse', 'skill-procedure', 'skill-handoff', 'review']);
  for (const fixture of fixtures) {
    assert(fixture.check || fixture.checkReply, fixture.id);
    assert(fixture.rubric, fixture.id);
    assert(fixture.trace?.length, fixture.id);
    for (const [folder, files] of Object.entries(fixture.folders)) for (const name of Object.keys(files)) assert.equal(fixture.check?.[folder]?.[name], undefined, `${fixture.id}: ${name} is hidden, so it can't also be in the repository.`);
  }
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
  assert.equal(repeatedFileReads([read('a', 'x.js'), read('a', 'x.js'), read('a', 'y.js'), read('b', 'x.js'), { role: 'activity', runId: 'b', text: '$ cat y.js\nok' }, { role: 'activity', runId: 'b', text: '$ cat new.js\nok' }]), 2);
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

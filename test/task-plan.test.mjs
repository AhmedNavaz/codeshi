import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { carriedPlan, planForBrief, reportedPlan } from '../src/task-plan.mjs';
import { taskResult } from '../src/task-ledger.mjs';
import { latestEdit } from '../src/activity-format.mjs';
import { runningEdit } from '../desktop/status.mjs';

const steps = [{ text: 'One', status: 'done' }, { text: 'Two', status: 'active' }, { text: 'Three', status: 'pending' }];

test('only an unfinished plan is carried, and it says which run it came from', () => {
  assert.deepEqual(carriedPlan({ id: 'r', provider: 'codex', plan: { steps } }).carriedFrom, { runId: 'r', provider: 'codex' });
  assert.equal(carriedPlan({ id: 'r', provider: 'codex', plan: { steps: [{ text: 'One', status: 'done' }] } }), null);
  assert.equal(carriedPlan({ id: 'r', provider: 'codex' }), null);
  assert.equal(carriedPlan({ id: 'r', provider: 'codex', connection: 'local', plan: { steps } }).carriedFrom.local, true);
});

test('Claude is asked to keep TodoWrite, which current versions replace by default and which its plan comes from', () => {
  const source = fs.readFileSync(new URL('../src/providers.mjs', import.meta.url), 'utf8');
  assert.match(source, /CLAUDE_CODE_ENABLE_TASKS: 'false'/);
  assert.match(source, /block\.name === 'TodoWrite'/);
});

test('a plan an agent reports for itself is left as it is', () => {
  assert.deepEqual(reportedPlan({ steps }, [{ text: 'New', status: 'active' }]), [{ text: 'New', status: 'active' }]);
  assert.deepEqual(reportedPlan(null, [{ text: 'New', status: 'active' }]), [{ text: 'New', status: 'active' }]);
});

test('the plan in a brief is bounded: what remains always goes, and the oldest done steps give way', () => {
  const many = Array.from({ length: 50 }, (_, index) => ({ text: 'S' + index + ' ' + 'x'.repeat(290), status: index < 45 ? 'done' : 'pending' }));
  const brief = planForBrief({ provider: 'codex', plan: { steps: many } });
  assert(Buffer.byteLength(JSON.stringify(brief.steps)) < 9000, 'Within the budget.');
  assert.equal(brief.steps.filter(step => step.status === 'pending').length, 5);
  assert(brief.stepsLeftOut > 0); assert.match(brief.steps.at(-6).text, /^S44/, 'The most recent done steps are kept.');
  assert(brief.steps.every(step => step.text.length <= 240));
  assert.equal(planForBrief({ plan: { steps: [{ text: 'Done', status: 'done' }] } }), null);
});

const run = (id, extra = {}) => ({ id, taskId: 't', provider: 'claude', status: 'complete', startedAt: '2026-11-05T10:00:00.000Z', endedAt: '2026-11-05T10:01:00.000Z', elapsedMs: 60000, ...extra });
const conversation = (runs, messages = []) => ({ lastRun: { ...runs.at(-1), status: runs.at(-1).status }, runs, messages });

test('one result covers a task that crossed agents: working time without the wait, files per agent and the latest test result', () => {
  const runs = [run('a', { files: 2 }), run('b', { provider: 'codex', relation: 'continuation', files: 2, elapsedMs: 40000, startedAt: '2026-11-05T15:00:00.000Z', endedAt: '2026-11-05T15:00:40.000Z', check: { status: 'failed' } }), run('c', { provider: 'codex', relation: 'retry', files: 1, elapsedMs: 20000, check: { status: 'passed' } })];
  const result = taskResult(conversation(runs));
  assert.equal(result.workingMs, 120000, 'Five hours waiting for a reset between the runs is not working time.');
  assert.deepEqual(result.agents.map(agent => [agent.provider, agent.files]), [['claude', 2], ['codex', 2]]);
  assert.equal(result.tests, 'passed', 'The latest result, not a sum.');
  assert.equal(taskResult(conversation([run('a', { check: { status: 'running' } }), run('b', { relation: 'continuation', provider: 'codex' })])).tests, null, 'A check still running is not a result.');
});

test('a single run, a retry alone, or an unfinished task has no combined result, and what is unknown stays unknown', () => {
  assert.equal(taskResult(conversation([run('a')])), null);
  assert.equal(taskResult(conversation([run('a'), run('b', { relation: 'retry' })])), null, 'A retry alone reads as it does today.');
  assert.equal(taskResult(conversation([run('a'), run('b', { relation: 'continuation', status: 'incomplete' })])), null);
  assert.equal(taskResult({ runs: [], messages: [] }), null);
  const unknown = taskResult(conversation([run('a'), run('b', { relation: 'continuation', provider: 'codex', local: true, files: 0 })]));
  assert.deepEqual(unknown.agents.map(agent => [agent.provider, agent.local, agent.files]), [['claude', undefined, null], ['codex', true, 0]]);
  const named = taskResult(conversation([run('a', { files: 1 }), run('b', { relation: 'continuation', files: 1 })], [{ role: 'activity', runId: 'a', text: 'Edit\n{"file_path":"/w/a.js"}' }, { role: 'activity', runId: 'b', text: 'Edit\n{"file_path":"/w/a.js"}' }]));
  assert.equal(named.agents[0].files, 1, 'One file two runs changed counts once.');
});

test('the latest edit is a file and its line counts, whichever agent made it, and never its contents', () => {
  const secret = 'SECRET-CONTENT';
  const edit = latestEdit([
    { role: 'activity', text: 'Read\n{"file_path":"/w/skip.js"}' },
    { role: 'activity', text: 'File changes: [{"path":"/w/src/old.js","kind":"update","added":1,"removed":0},{"path":"/w/src/BuyBox.tsx","kind":"update","added":4,"removed":2}]' },
    { role: 'activity', text: '$ npm test\nok' }, { role: 'assistant', text: 'File changes: []' },
  ], ['/w']);
  assert.deepEqual(edit, { path: 'src/BuyBox.tsx', added: 4, removed: 2 });
  const claude = latestEdit([{ role: 'activity', text: 'Edit\n' + JSON.stringify({ file_path: '/w/a.js', old_string: secret, new_string: secret + '\nmore' }) }], ['/w']);
  assert.deepEqual(claude, { path: 'a.js', added: 1, removed: 0 }); assert.doesNotMatch(JSON.stringify(claude), /SECRET/);
  assert.deepEqual(latestEdit([{ role: 'activity', text: 'Write\n{"path":"/elsewhere/deep/b.js","content":"x\\ny"}' }], ['/w']), { path: 'b.js', added: 2, removed: 0 }, 'Outside the workspace, only the file name.');
  assert.equal(latestEdit([{ role: 'activity', text: '$ ls' }]), null);
  assert.equal(latestEdit([{ role: 'activity', text: 'File changes: {broken' }]), null);
});

test('the preview follows only the running task of its own workspace', () => {
  const messages = [{ role: 'activity', runId: 'now', text: 'File changes: [{"path":"/w/a.js","added":1,"removed":1}]' }, { role: 'activity', runId: 'before', text: 'File changes: [{"path":"/w/old.js"}]' }];
  const registry = { brokers: new Map([['p', { broker: { workspaces: ['/w'], running: { c: { activeRun: { id: 'now' }, messages } } } }], ['idle', { broker: { workspaces: ['/x'], running: null } }]]) };
  assert.deepEqual(runningEdit(registry, 'p'), { path: 'a.js', added: 1, removed: 1 });
  assert.equal(runningEdit(registry, 'idle'), null); assert.equal(runningEdit(registry, 'missing'), null);
});

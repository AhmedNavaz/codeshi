import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { buildRecap, runSteps } from '../src/recap.mjs';
import { createRelayServer } from '../src/server.mjs';
import { scriptCLIs } from './platform.mjs';

test('each conversation keeps a short history of its runs, rebuilt from its journal', { skip: scriptCLIs }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-recap-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const bin = path.join(root, 'codex.mjs'); fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  let broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: bin } });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id);
  broker.start(c, { text: 'Add a loading spinner to the checkout button\nand keep the old styles', provider: 'codex' });
  await broker.running.done;
  assert.equal(c.runs.length, 1);
  const [run] = c.runs;
  assert.deepEqual([run.provider, run.prompt.split('\n')[0], Boolean(run.startedAt && run.endedAt)], ['codex', 'Add a loading spinner to the checkout button', true]);
  assert.deepEqual([run.id, run.status, run.endedAt], [c.lastRun.id, c.lastRun.status, c.lastRun.endedAt], 'The history records how the run ended.');
  await broker.close();
  broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: bin } });
  assert.deepEqual(broker.get(c.id).runs, c.runs, 'The history survives a restart.');
});

test('a run’s steps say which files it changed and which commands it ran', () => {
  const steps = runSteps([
    { role: 'activity', text: 'File changes: [{"path":"src/checkout.js","kind":"modify"},{"path":"src/promo.js","kind":"add"}]' },
    { role: 'activity', text: '$ npm test\n12 passing' },
    { role: 'activity', text: 'Edit\n{"file_path":"/w/src/header.css","old_string":"a","new_string":"b"}\nThe file was updated.' },
    { role: 'activity', text: 'Bash\n{"command":"git status","description":"Check the tree"}\nclean' },
    { role: 'activity', text: 'File changes: not json' },
    { role: 'assistant', text: '$ not a step' },
  ]);
  assert.deepEqual(steps, { files: ['src/checkout.js', 'src/promo.js', '/w/src/header.css'], commands: 2, tests: true });
});

// A registry stand-in holding loaded workspaces and their conversations.
function registry(workspaces) {
  return {
    list: () => workspaces.map(({ id, name, conversation }) => ({ id, name, conversationId: conversation?.id || null, folders: [{ id: 'f', name, path: `/w/${id}` }] })),
    brokers: new Map(workspaces.filter(item => item.conversation).map(({ id, conversation, running = null, resume = null }) => [id, { broker: { conversations: new Map([[conversation.id, conversation]]), running, resume } }])),
  };
}
const conversation = (id, runs, messages = [], extra = {}) => ({ id, runs, messages, queue: [], ...extra });

test('the recap lists what ran, changed and is waiting since a time, and leaves out quiet workspaces', () => {
  const since = '2026-11-02T10:00:00.000Z', now = new Date('2026-11-02T10:30:00.000Z');
  const shop = conversation('c-shop', [
    { id: 'old', provider: 'codex', prompt: 'Earlier work', startedAt: '2026-11-02T09:00:00.000Z', endedAt: '2026-11-02T09:10:00.000Z', status: 'complete' },
    { id: 'promo', provider: 'claude', prompt: 'Add promo codes to checkout\nwith tests', startedAt: '2026-11-02T10:05:00.000Z', endedAt: '2026-11-02T10:08:00.000Z', status: 'complete' },
    { id: 'limit', provider: 'codex', prompt: 'Refactor the payment module', startedAt: '2026-11-02T10:09:00.000Z', endedAt: '2026-11-02T10:20:00.000Z', status: 'incomplete', errorCategory: 'quota' },
  ], [
    { role: 'activity', runId: 'promo', text: 'File changes: [{"path":"src/checkout.js","kind":"modify"}]' },
    { role: 'activity', runId: 'promo', text: '$ npm test\nok' },
    { role: 'activity', runId: 'old', text: 'File changes: [{"path":"old.js","kind":"modify"}]' },
  ], { resume: { providers: ['claude', 'codex'] }, queue: [{ id: 'q' }, { id: 'q2' }], queuePaused: { reason: 'stopped' } });
  const api = conversation('c-api', [{ id: 'live', provider: 'codex', prompt: 'Add rate limiting', startedAt: '2026-11-02T10:25:00.000Z', endedAt: null, status: 'running' }], [], { activeRun: { id: 'live' } });
  const docs = conversation('c-docs', [{ id: 'd', provider: 'codex', prompt: 'Old docs', startedAt: '2026-11-01T10:00:00.000Z', endedAt: '2026-11-01T10:05:00.000Z', status: 'complete' }]);
  const recap = buildRecap({ since, now, registry: registry([
    { id: 'shop', name: 'acme-shop', conversation: shop, resume: { view: () => ({ agents: { claude: { resetsAt: '2026-11-02T11:00:00.000Z' } } }) } },
    { id: 'api', name: 'payments-api', conversation: api, running: { c: api, approvals: new Map([['a', {}], ['b', {}]]) } },
    { id: 'docs', name: 'docs', conversation: docs },
    { id: 'idle', name: 'not loaded' },
  ]), git: folders => ({ repositories: [{ available: true, totalChanges: folders[0].path === '/w/shop' ? 4 : 0 }] }) });
  assert.deepEqual([recap.since, recap.until], [since, now.toISOString()]);
  assert.deepEqual(recap.workspaces.map(item => item.name), ['acme-shop', 'payments-api'], 'Quiet and unloaded workspaces are left out.');
  const [shopRecap, apiRecap] = recap.workspaces;
  assert.deepEqual(shopRecap.runs.map(run => [run.id, run.prompt, run.status, run.errorCategory || null, run.files, run.tests]), [['promo', 'Add promo codes to checkout', 'complete', null, ['src/checkout.js'], true], ['limit', 'Refactor the payment module', 'incomplete', 'quota', [], false]]);
  assert.deepEqual(shopRecap.waiting, { providers: ['claude', 'codex'], resetsAt: '2026-11-02T11:00:00.000Z' });
  assert.deepEqual(shopRecap.queue, { count: 2, paused: true });
  assert.equal(shopRecap.uncommitted, 4);
  assert.deepEqual([apiRecap.runs[0].status, apiRecap.approvals], ['running', 2]);
  assert.throws(() => buildRecap({ since: 'yesterday', registry: registry([]) }), /time the recap starts/);
});

test('the recap includes tasks and folds a plan’s steps into one entry (#88)', () => {
  const since = '2026-11-02T10:00:00.000Z', now = new Date('2026-11-02T10:30:00.000Z'), after = '2026-11-02T10:20:00.000Z', before = '2026-11-02T09:00:00.000Z';
  const task = (id, status, extra = {}) => ({ id, title: `Task ${id}\nmore`, folderName: 'web', provider: 'codex', status, endedAt: status === 'running' ? null : after, ...extra });
  const main = conversation('c-main', [], [], {
    orchestrations: [{ id: 'p1', goal: 'Checkout rewrite' }],
    parallelTasks: [
      task('solo', 'complete', { mode: 'worktree' }),
      task('live', 'waiting'), // Its lane is running, so it counts as working.
      task('old', 'complete', { endedAt: before }),
      task('merged', 'integrated'), task('closed', 'complete', { closed: true }),
      task('s1', 'complete', { plan: { id: 'p1', number: 1 }, stepCheck: { status: 'failed' }, endedAt: before }),
      task('s2', 'running', { plan: { id: 'p1', number: 2 } }),
      task('s3', 'integrated', { plan: { id: 'p1', number: 3 } }),
      task('s4', 'cancelled', { plan: { id: 'p1', number: 4 } }),
    ],
  });
  const laneConversation = conversation('lane', [{ id: 'r', startedAt: after, endedAt: after }], [{ role: 'activity', runId: 'r', text: 'File changes: [{"path":"src/a.js"}]' }]);
  const reg = registry([{ id: 'w', name: 'shop', conversation: main }]);
  reg.brokers.get('w').broker.tasks = { lanes: new Map([
    ['solo', { task: { id: 'solo' }, c: laneConversation, broker: { running: null, pendingCount: () => 1 } }],
    ['live', { task: { id: 'live' }, c: null, broker: { running: {}, pendingCount: () => 0 } }],
  ]) };
  const [recap] = buildRecap({ since, now, registry: reg, git: () => ({ repositories: [] }) }).workspaces;
  assert.deepEqual(recap.tasks.map(item => [item.id, item.title, item.status, item.approvals, item.files, item.unmerged]), [['solo', 'Task solo', 'complete', 1, ['src/a.js'], true], ['live', 'Task live', 'running', 0, [], false]], 'Old, merged and closed tasks are left out; a running lane counts as working.');
  assert.deepEqual(recap.plans.map(plan => [plan.goal, plan.done, plan.total, plan.steps.map(step => [step.number, step.status, step.check])]), [['Checkout rewrite', 2, 3, [[1, 'complete', 'failed'], [2, 'running', null]]]], 'A step whose tests failed stays in the recap until it is dealt with; cancelled steps don’t count.');
});

test('the recap route answers for every workspace and checks its starting time', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-recap-route-'));
  const relay = createRelayServer({ workspace: root, dataDir: path.join(root, '.relay-data'), lock: false });
  t.after(async () => { await relay.close({ force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const ok = await fetch(`${base}/api/recap?since=${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}`);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).workspaces, []);
  assert.equal((await fetch(`${base}/api/recap?since=soon`)).status, 400);
});

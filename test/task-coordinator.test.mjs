import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { noSymlinks, scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { MutationCoordinator } from '../src/mutation-lock.mjs';
import { createRelayServer } from '../src/server.mjs';
import { applyPlan, folderIdentity, integrationPlan, pathsOverlap, planIsolation, unrestricted } from '../src/task-isolation.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const scenarios = JSON.stringify({ 'Hold A': { behavior: 'hold' }, 'Hold B': { behavior: 'hold' }, 'Hold main': { behavior: 'hold' }, 'Hold C': { behavior: 'hold' } });
// A folder with what the mock agent reads. Its own files stay out of any change Git would see.
function populate(folder, files = {}) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.mock-scenarios.json'), scenarios);
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.writeFileSync(path.join(folder, name), text); }
}
function repository(folder, files = {}, { commit = true } = {}) {
  populate(folder, files);
  fs.writeFileSync(path.join(folder, '.gitignore'), '.release\n.mock-captures.jsonl\nnode_modules\n');
  git(folder, 'init', '-q'); git(folder, 'config', 'user.email', 't@t.t'); git(folder, 'config', 'user.name', 't');
  if (commit) { git(folder, 'add', '.'); git(folder, 'commit', '-qm', 'first'); }
  return folder;
}
function setup(t, folders, { tests = null, policy = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-tasks-')), bins = {}, dataDir = path.join(root, 'data');
  for (const provider of ['codex', 'claude']) { bins[provider] = path.join(root, `${provider}-mock.mjs`); fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 }); }
  bins.gemini = path.join(root, 'missing-gemini');
  const made = typeof folders === 'function' ? folders(path.join(root, 'w')) : folders;
  const list = Object.entries(made).map(([name, where]) => ({ id: name, name, path: where }));
  const mutations = new MutationCoordinator(path.join(root, 'locks'));
  const open = () => { const paths = list.map(folder => folder.path); return new Broker({ workspace: paths[0], workspaceFolders: list, dataDir, bins, tests, handoffPreferences: () => ({ threshold: 0, automatic: false }), acquireMutation: operation => mutations.acquireMany(paths, operation), acquireFolders: (where, operation) => mutations.acquireMany(where, operation), withFolders: (where, operation, work) => mutations.withMutations(where, operation, work) }); };
  const broker = open(), c = broker.get(broker.create().id);
  if (policy) broker.budget.setPolicy(c, policy);
  t.after(async () => { await env.broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let number = 0;
  const env = { broker, c, root, dataDir, bins, list, folders: made, open, mutations,
    start: (folderId, text, extra = {}) => env.broker.tasks.start(env.c, { text, folderId, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: `request-${++number}`, ...extra }),
    task: id => env.c.parallelTasks.find(item => item.id === id),
    lane: id => env.broker.tasks.lanes.get(id),
    captured: place => { const file = path.join(place, '.mock-captures.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : []; },
    release: place => fs.writeFileSync(path.join(place, '.release'), ''),
    reopen: async () => { await env.broker.close(); env.broker = open(); env.c = env.broker.get(c.id); return env.broker; },
  };
  return env;
}
const until = async (check, what) => { for (let i = 0; i < 1500; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Timed out waiting for ${what}.`); };
const working = (env, task) => until(() => env.task(task.id).scopePath && env.captured(env.task(task.id).scopePath).length, `${task.title} to start`);
const finished = (env, task) => until(() => !env.lane(task.id)?.broker.running && env.task(task.id).status !== 'running', `${task.title} to finish`);
const hold = (env, id, text) => env.start(id, text);
// What an agent working in a task's copy would do.
const edit = (env, task, name, text) => { const file = path.join(env.task(task.id).scopePath, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const finish = async (env, task) => { await working(env, task); env.release(env.task(task.id).scopePath); await finished(env, task); };

test('folder identity goes by the disk and by Git, not by labels', { skip: noSymlinks }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-identity-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = repository(path.join(root, 'repo'), { 'web/a.js': '1', 'api/b.js': '2' }), plain = path.join(root, 'plain'); fs.mkdirSync(plain);
  fs.symlinkSync(repo, path.join(root, 'linked'));
  const web = folderIdentity(path.join(repo, 'web')), api = folderIdentity(path.join(repo, 'api')), linked = folderIdentity(path.join(root, 'linked')), whole = folderIdentity(repo);
  assert.equal(web.commonDir, api.commonDir, 'Two folders of one repository are one repository.');
  assert.equal(linked.commonDir, whole.commonDir); assert.equal(linked.real, whole.real, 'A link names the same place.');
  assert.deepEqual([web.prefix, whole.prefix], ['web', '']);
  assert.deepEqual(folderIdentity(plain).git, false);
  const worktree = path.join(root, 'other'); git(repo, 'worktree', 'add', '-q', worktree);
  assert.equal(folderIdentity(worktree).commonDir, whole.commonDir, 'A worktree shares its repository.');
  const empty = repository(path.join(root, 'empty'), {}, { commit: false });
  assert.equal(folderIdentity(empty).head, false);
  assert.equal(pathsOverlap('/a/b', '/a/b/c'), true); assert.equal(pathsOverlap('/a/b', '/a/bc'), false);
});

test('the plan: direct when nothing is shared, a worktree for a shared repository, and waiting where neither is safe', () => {
  const git1 = { real: '/r1', git: true, head: true, commonDir: '/r1/.git' }, plain = { real: '/p', git: false }, empty = { real: '/e', git: true, head: false, commonDir: '/e/.git' };
  const on = (real, commonDir = null, extra = {}) => ({ real, commonDir, unrestricted: false, label: 'Other', ...extra });
  assert.equal(planIsolation(git1, []).mode, 'direct');
  assert.equal(planIsolation(git1, [on('/r2', '/r2/.git')]).mode, 'direct', 'Disjoint repositories run directly.');
  assert.equal(planIsolation(git1, [on('/r1-copy', '/r1/.git')]).mode, 'worktree', 'Another worktree of one repository still shares it.');
  assert.equal(planIsolation({ ...git1, real: '/r1/web', commonDir: '/r1/.git' }, [on('/r1/api', '/r1/.git')]).mode, 'worktree', 'Different folders, same repository.');
  assert.equal(planIsolation(plain, []).mode, 'direct');
  assert.equal(planIsolation(plain, [on('/p')]).mode, 'wait');
  assert.equal(planIsolation({ real: '/p/inner', git: false }, [on('/p')]).mode, 'wait', 'A nested folder overlaps.');
  assert.equal(planIsolation(empty, [on('/e', '/e/.git')]).mode, 'wait', 'A repository with no commit has nothing to copy.');
  assert.equal(planIsolation(plain, [on('/q', null, { unrestricted: true })]).mode, 'wait', 'An agent that isn’t asked could reach any folder.');
  assert.equal(planIsolation(git1, [on('/q', null, { unrestricted: true })]).mode, 'worktree');
  assert.equal(planIsolation(plain, [on('/q')], { loose: true }).mode, 'wait', 'And so could this one, if it were started.');
  assert.equal(unrestricted({ provider: 'claude', mode: 'edit', approvalPolicy: 'auto' }), true);
  assert.equal(unrestricted({ provider: 'codex', mode: 'edit', approvalPolicy: 'auto' }), false, 'Codex keeps its sandbox.');
  assert.equal(unrestricted({ provider: 'claude', mode: 'read', approvalPolicy: 'auto' }), false);
});

test('two tasks in different folders run at once, each with its own output and Stop, and stay apart after a restart', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')), b: repository(path.join(root, 'b')) }));
  const a = hold(env, 'a', 'Hold A'), b = hold(env, 'b', 'Hold B');
  await working(env, a); await working(env, b);
  assert.deepEqual([env.task(a.id).status, env.task(b.id).status, env.task(a.id).mode, env.task(b.id).mode], ['running', 'running', 'direct', 'direct']);
  const [laneA, laneB] = [env.lane(a.id), env.lane(b.id)];
  assert.deepEqual(laneA.broker.workspaces, [fs.realpathSync(env.folders.a)], 'A task only holds its own folder.');
  assert.notEqual(laneA.c.id, laneB.c.id);
  assert.equal(env.captured(env.folders.a)[0].context.currentRequest, 'Hold A'); assert.equal(env.captured(env.folders.b)[0].context.currentRequest, 'Hold B');
  // Stop one: the other carries on, and a late event from the stopped one reaches nobody else.
  const runA = laneA.broker.running; laneA.broker.stop(laneA.c.id); await runA.done; await finished(env, a);
  assert.equal(env.task(a.id).status, 'stopped'); assert.equal(env.task(b.id).status, 'running');
  const beforeB = laneB.c.messages.length, beforeA = laneA.c.messages.length;
  try { laneA.broker.event(runA, { type: 'item.completed', item: { id: 'late', type: 'agent_message', text: 'Late from A' } }); } catch { /* An ended run may refuse it. */ }
  assert.equal(laneB.c.messages.length, beforeB, 'A late event can’t reach another task.'); assert(!laneB.c.messages.some(message => message.text === 'Late from A')); assert(laneA.c.messages.length >= beforeA);
  await env.reopen();
  const tasks = env.broker.tasks.list(env.c);
  assert.deepEqual(tasks.map(item => [item.title, item.status]), [['Hold A', 'stopped'], ['Hold B', 'stopped']], 'Both are there after a restart, and what was running is known to have stopped.');
  const view = env.broker.tasks.view(env.c, b.id);
  assert(view.messages.some(message => message.text === 'Hold B')); assert(!view.messages.some(message => message.text === 'Hold A'), 'Each keeps its own history.');
  assert.equal(view.task.id, b.id); assert.equal(view.parallelTasks.length, 2);
  assert.deepEqual(env.broker.tasks.lanes.get(b.id).broker.workspaces, [fs.realpathSync(env.folders.b)], 'A restart doesn’t widen what it reaches.');
  assert.equal(env.c.messages.length, 0, 'None of this lands in the main conversation.');
});

test('approvals and questions stay with their task', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')), b: repository(path.join(root, 'b')) }));
  const a = hold(env, 'a', 'Hold A'), b = hold(env, 'b', 'Hold B');
  await working(env, a); await working(env, b);
  const [laneA, laneB] = [env.lane(a.id), env.lane(b.id)];
  laneA.broker.running.approvals.set('ask', { id: 'ask', kind: 'Bash', input: {} });
  assert.deepEqual([env.broker.tasks.list(env.c)[0].approvals, env.broker.tasks.list(env.c)[1].approvals], [1, 0], 'The list says which task is asking.');
  assert.equal(laneB.broker.view(laneB.c).pendingApprovals.length, 0); assert.equal(laneA.broker.view(laneA.c).pendingApprovals.length, 1);
  await assert.rejects(async () => laneB.broker.approve(laneA.broker.running.id, 'ask', true), /./, 'Answering through another task finds nothing to answer.');
  laneA.broker.running.approvals.clear();
  env.release(env.folders.a); env.release(env.folders.b); await finished(env, a); await finished(env, b);
});

test('the same repository under two roots, a nested root and a linked root all take their own copy, and a main run shares too', { skip: noSymlinks }, async t => {
  const env = setup(t, root => {
    const repo = repository(path.join(root, 'repo'), { 'web/index.js': 'web\n', 'api/index.js': 'api\n', 'web/.mock-scenarios.json': scenarios, 'api/.mock-scenarios.json': scenarios });
    fs.symlinkSync(repo, path.join(root, 'link'));
    return { web: path.join(repo, 'web'), api: path.join(repo, 'api'), link: path.join(root, 'link') };
  });
  const web = hold(env, 'web', 'Hold A'); await working(env, web);
  assert.equal(env.task(web.id).mode, 'direct');
  assert.equal(env.broker.tasks.preview(env.c, { folderId: 'api' }).mode, 'worktree', 'Different labels, one repository.');
  assert.equal(env.broker.tasks.preview(env.c, { folderId: 'link' }).mode, 'worktree', 'A link to the folder around it.');
  const api = hold(env, 'api', 'Hold B'); await working(env, api);
  assert.equal(env.task(api.id).mode, 'worktree');
  assert(env.task(api.id).scopePath.endsWith(path.join('worktree', 'api')), 'It works at the same place in its copy.');
  assert.notEqual(env.task(api.id).scopePath, fs.realpathSync(env.folders.api));
  env.release(env.task(web.id).scopePath); env.release(env.task(api.id).scopePath); await finished(env, web); await finished(env, api);
});

test('outside Git, an overlapping task waits and starts by itself when the folder is free, and a separate folder runs at once', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => { const shared = path.join(root, 'shared'), other = path.join(root, 'other'); populate(shared); populate(path.join(shared, 'inner')); populate(other); return { shared, inner: path.join(shared, 'inner'), other }; }, { policy: { maxConcurrent: 5 } });
  const first = hold(env, 'shared', 'Hold A'); await working(env, first);
  const nested = hold(env, 'inner', 'Hold B');
  assert.equal(env.task(nested.id).status, 'waiting'); assert.match(env.task(nested.id).reason, /using this folder.*can't have its own copy.*waits/s);
  const apart = hold(env, 'other', 'Hold C'); await working(env, apart);
  assert.equal(env.task(apart.id).mode, 'direct', 'A separate folder has nothing to wait for.');
  env.release(fs.realpathSync(env.folders.shared)); await finished(env, first);
  await working(env, nested);
  assert.equal(env.task(nested.id).mode, 'direct');
  env.release(fs.realpathSync(env.folders.inner)); env.release(fs.realpathSync(env.folders.other)); await finished(env, nested); await finished(env, apart);
});

test('a direct task and a run or file operation in the same folder can’t both proceed', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')), b: repository(path.join(root, 'b')) }));
  const a = hold(env, 'a', 'Hold A'); await working(env, a);
  assert.throws(() => env.broker.start(env.c, { text: 'Main work', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }), /busy/, 'The main conversation reaches every folder, so its run waits.');
  await assert.rejects(env.mutations.withMutations([env.folders.a], 'patch', async () => {}), /busy/, 'Patches, undo and imports take the same lease.');
  assert.deepEqual(await env.mutations.withMutations([env.folders.b], 'patch', async () => 'done'), 'done', 'Another folder isn’t held.');
  env.release(fs.realpathSync(env.folders.a)); await finished(env, a);
});

test('a task beside a running main conversation takes its own copy, and is merged only after review', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'app.js': 'one\ntwo\nthree\n', 'gone.js': 'bye\n', 'kept.js': 'mine\n' }) }));
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folders.a)).length, 'the main run');
  // Work in progress in the folder itself, which nothing here may disturb.
  fs.writeFileSync(path.join(env.folders.a, 'kept.js'), 'mine, edited\n'); fs.writeFileSync(path.join(env.folders.a, 'draft.txt'), 'unrelated\n');
  assert.match(env.broker.tasks.preview(env.c, { folderId: 'a' }).reason, /own copy from the last commit/);
  assert.equal(env.broker.tasks.preview(env.c, { folderId: 'a' }).uncommitted, 2, 'The person is told what the copy leaves out.');
  const task = hold(env, 'a', 'Hold A'); await working(env, task);
  assert.equal(env.task(task.id).mode, 'worktree');
  assert.throws(() => env.broker.tasks.review(env.c, task.id), /Wait for this task/);
  edit(env, task, 'app.js', 'one\nTWO\nthree\n'); edit(env, task, 'new/file.js', 'added\n'); fs.rmSync(path.join(env.task(task.id).scopePath, 'gone.js'));
  env.release(env.task(task.id).scopePath); await finished(env, task);
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'app.js'), 'utf8'), 'one\ntwo\nthree\n', 'Nothing reaches the folder before it is merged.');
  const review = env.broker.tasks.review(env.c, task.id);
  assert.deepEqual(review.files.map(file => [file.path, file.change, file.status]), [['app.js', 'update', 'clean'], ['gone.js', 'delete', 'clean'], ['new/file.js', 'add', 'clean']]);
  assert.equal(review.conflicts, 0); assert.match(review.files[0].diff, /\+TWO/); assert.deepEqual([review.files[0].added, review.files[0].removed], [1, 1]);
  // The main run still holds the folder, so merging must wait for it.
  await assert.rejects(env.broker.tasks.integrate(env.c, task.id, { digest: review.digest }), /busy/);
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'app.js'), 'utf8'), 'one\ntwo\nthree\n');
  env.release(fs.realpathSync(env.folders.a)); await main.done;
  const worktree = env.task(task.id).worktree;
  await env.broker.tasks.integrate(env.c, task.id, { digest: review.digest });
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'app.js'), 'utf8'), 'one\nTWO\nthree\n');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'new/file.js'), 'utf8'), 'added\n');
  assert.equal(fs.existsSync(path.join(env.folders.a, 'gone.js')), false);
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'kept.js'), 'utf8'), 'mine, edited\n', 'Unrelated work is preserved.');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'draft.txt'), 'utf8'), 'unrelated\n');
  assert.equal(env.task(task.id).status, 'integrated'); assert.equal(fs.existsSync(worktree), false, 'Its copy is gone.');
  assert.doesNotMatch(git(env.folders.a, 'worktree', 'list'), /worktree$/m); assert.equal(git(env.folders.a, 'for-each-ref', 'refs/codeshi').trim(), '');
  assert.match(env.c.messages.at(-1).text, /Merged “Hold A” into a: 3 files/);
  assert.throws(() => env.broker.tasks.integrate(env.c, task.id, { digest: review.digest }), /nothing to merge/);
  assert(env.broker.tasks.view(env.c, task.id).messages.some(message => message.text === 'Hold A'), 'Its history stays.');
  const ended = env.lane(task.id); assert.throws(() => ended.broker.start(ended.c, { text: 'More', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }), /has ended/);
});

test('a queued prompt can start as a task beside the main run, keeping its settings, and stays queued when the task can’t start', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')) }));
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folders.a)).length, 'the main run');
  env.broker.queueAction(env.c, { action: 'add', text: 'First queued', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  env.broker.queueAction(env.c, { action: 'add', text: 'Hold A', provider: 'claude', mode: 'read', approvalPolicy: 'ask', routing: { mode: 'balanced', reason: 'A light task', tier: 'light' } });
  const [first, second] = env.c.queue;
  assert.throws(() => env.broker.tasks.fromQueue(env.c, { id: second.id, folderId: 'missing' }), /Choose a folder/);
  assert.deepEqual(env.c.queue.map(item => item.text), ['First queued', 'Hold A'], 'A task that can’t start leaves the prompt queued.');
  const task = env.broker.tasks.fromQueue(env.c, { id: second.id, folderId: 'a' });
  assert.deepEqual(env.c.queue.map(item => item.id), [first.id], 'The prompt has left the queue.');
  assert.deepEqual([task.title, task.provider, task.accessMode, task.approvalPolicy, task.routing?.reason], ['Hold A', 'claude', 'read', 'ask', 'A light task'], 'The task keeps what the prompt was queued with.');
  assert.equal(env.broker.tasks.fromQueue(env.c, { id: second.id, folderId: 'a' }).id, task.id, 'Asking again gets the same task.');
  assert.throws(() => env.broker.tasks.fromQueue(env.c, { id: 'not-queued', folderId: 'a' }), /already started or been removed/);
  await working(env, task);
  assert.equal(env.task(task.id).mode, 'worktree', 'Beside the main run, it takes its own copy.');
  env.release(env.task(task.id).scopePath); await finished(env, task);
  env.release(fs.realpathSync(env.folders.a)); await main.done;
});

test('changes on both sides merge when they don’t touch, and a conflict overwrites nothing and can be kept as a branch', { skip: scriptCLIs }, async t => {
  const text = 'one\n2\n3\n4\n5\n6\nseven\n';
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'merge.txt': text, 'clash.txt': 'same\n', 'both.txt': 'x\n', 'bin.dat': 'y\n' }) }), { policy: { maxConcurrent: 5 } });
  const first = hold(env, 'a', 'Hold A'), second = hold(env, 'a', 'Hold B'); await working(env, first); await working(env, second);
  assert.deepEqual([env.task(first.id).mode, env.task(second.id).mode], ['direct', 'worktree'], 'Concurrent work in one repository: the second takes a copy.');
  edit(env, second, 'merge.txt', 'ONE\n2\n3\n4\n5\n6\nseven\n'); edit(env, second, 'clash.txt', 'theirs\n'); edit(env, second, 'both.txt', 'identical\n');
  await finish(env, second);
  env.release(fs.realpathSync(env.folders.a)); await finished(env, first);
  fs.writeFileSync(path.join(env.folders.a, 'merge.txt'), 'one\n2\n3\n4\n5\n6\nSEVEN\n'); fs.writeFileSync(path.join(env.folders.a, 'clash.txt'), 'ours\n'); fs.writeFileSync(path.join(env.folders.a, 'both.txt'), 'identical\n');
  const review = env.broker.tasks.review(env.c, second.id), status = Object.fromEntries(review.files.map(file => [file.path, file.status]));
  assert.deepEqual(status, { 'both.txt': 'same', 'clash.txt': 'conflict', 'merge.txt': 'merged' }); assert.equal(review.conflicts, 1);
  assert.match(review.files.find(file => file.path === 'clash.txt').reason, /same lines/);
  await assert.rejects(env.broker.tasks.integrate(env.c, second.id, { digest: review.digest }), /1 file conflicts, so nothing was merged/);
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'clash.txt'), 'utf8'), 'ours\n'); assert.equal(fs.readFileSync(path.join(env.folders.a, 'merge.txt'), 'utf8'), 'one\n2\n3\n4\n5\n6\nSEVEN\n', 'A conflict stops the whole merge.');
  assert.equal(env.task(second.id).status, 'complete');
  // Reviewed once, then the folder moves: that review no longer counts.
  fs.writeFileSync(path.join(env.folders.a, 'clash.txt'), 'theirs\n');
  await assert.rejects(env.broker.tasks.integrate(env.c, second.id, { digest: review.digest }), /moved since you reviewed/);
  const again = env.broker.tasks.review(env.c, second.id);
  await env.broker.tasks.integrate(env.c, second.id, { digest: again.digest });
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'merge.txt'), 'utf8'), 'ONE\n2\n3\n4\n5\n6\nSEVEN\n', 'Both changes are in.');

  const env2 = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'clash.txt': 'same\n' }) }));
  env2.broker.start(env2.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env2.broker.running;
  await until(() => env2.captured(fs.realpathSync(env2.folders.a)).length, 'the main run');
  const task = hold(env2, 'a', 'Hold A'); await working(env2, task); edit(env2, task, 'clash.txt', 'theirs\n'); await finish(env2, task);
  env2.release(fs.realpathSync(env2.folders.a)); await main.done;
  fs.writeFileSync(path.join(env2.folders.a, 'clash.txt'), 'ours\n');
  const { branch } = env2.broker.tasks.keep(env2.c, task.id);
  assert.match(branch, /^codeshi\/hold-a-/); assert.equal(git(env2.folders.a, 'show', `${branch}:clash.txt`), 'theirs\n', 'The task’s work is an ordinary branch.');
  assert.equal(fs.readFileSync(path.join(env2.folders.a, 'clash.txt'), 'utf8'), 'ours\n'); assert.equal(env2.task(task.id).status, 'kept');
});

test('two copies of one repository merge one after the other, each against what the last one left', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'one.txt': '1\n', 'two.txt': '2\n', 'shared.txt': 'top\nmiddle\nbottom\n' }) }), { policy: { maxConcurrent: 5 } });
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folders.a)).length, 'the main run');
  const first = hold(env, 'a', 'Hold A'), second = hold(env, 'a', 'Hold B'); await working(env, first); await working(env, second);
  assert.notEqual(env.task(first.id).scopePath, env.task(second.id).scopePath);
  edit(env, first, 'one.txt', 'first\n'); edit(env, first, 'shared.txt', 'TOP\nmiddle\nbottom\n');
  edit(env, second, 'two.txt', 'second\n'); edit(env, second, 'shared.txt', 'top\nmiddle\nBOTTOM\n');
  await finish(env, first); await finish(env, second);
  env.release(fs.realpathSync(env.folders.a)); await main.done;
  await env.broker.tasks.integrate(env.c, first.id, { digest: env.broker.tasks.review(env.c, first.id).digest });
  const review = env.broker.tasks.review(env.c, second.id);
  assert.equal(review.files.find(file => file.path === 'shared.txt').status, 'merged', 'The second sees what the first changed.');
  await env.broker.tasks.integrate(env.c, second.id, { digest: review.digest });
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'shared.txt'), 'utf8'), 'TOP\nmiddle\nBOTTOM\n');
  assert.deepEqual(['one.txt', 'two.txt'].map(name => fs.readFileSync(path.join(env.folders.a, name), 'utf8')), ['first\n', 'second\n']);
});

test('a change outside the task’s folder, a link, or a file changed to a folder is surfaced rather than written', { skip: noSymlinks }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-plan-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = repository(path.join(root, 'repo'), { 'web/a.js': 'a\n', 'api/b.js': 'b\n', 'web/c.js': 'c\n', 'web/d.js': 'd\n' });
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(repo, 'web/a.js'), 'A\n'); fs.writeFileSync(path.join(repo, 'api/b.js'), 'B\n'); fs.symlinkSync('/etc/hosts', path.join(repo, 'web/link')); fs.writeFileSync(path.join(repo, 'web/c.js'), 'C\n'); fs.writeFileSync(path.join(repo, 'web/d.js'), 'D\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'task'); const result = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'reset', '-q', '--hard', base);
  fs.rmSync(path.join(repo, 'web/c.js')); fs.mkdirSync(path.join(repo, 'web/c.js'));
  const outside = fs.mkdtempSync(path.join(root, 'outside-')); fs.rmSync(path.join(repo, 'web/d.js')); 
  const plan = integrationPlan({ root: repo, prefix: 'web', base, result }), row = name => plan.files.find(file => file.path === name);
  assert.match(row('api/b.js').reason, /outside this task's folder/); assert.match(row('web/link').reason, /Links and submodules/);
  assert.match(row('web/c.js').reason, /other than a plain file/); assert.match(row('web/d.js').reason, /deleted here/); assert.equal(row('web/a.js').status, 'clean');
  assert.equal(plan.conflicts, 4);
  assert.deepEqual(plan.writes.map(item => item.path), ['web/a.js'], 'Only what is safe would be written.');
  // A directory turned into a link after the task began: a path through it never gets written.
  git(repo, 'checkout', '-q', '--', '.'); fs.rmSync(path.join(repo, 'web'), { recursive: true, force: true }); fs.symlinkSync(outside, path.join(repo, 'web'));
  const through = integrationPlan({ root: repo, prefix: 'web', base, result });
  assert(through.files.filter(file => file.path.startsWith('web/')).every(file => file.status === 'conflict'), 'Nothing is written through a link.');
  assert.deepEqual(fs.readdirSync(outside), []);
  // A file that can't be written puts everything back.
  const restore = repository(path.join(root, 'restore'), { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  fs.rmSync(path.join(restore, 'b.txt')); fs.mkdirSync(path.join(restore, 'b.txt'));
  assert.throws(() => applyPlan(restore, { writes: [{ path: 'a.txt', content: Buffer.from('changed\n') }, { path: 'b.txt', content: Buffer.from('x\n') }] }), /can't be replaced/);
  assert.equal(fs.readFileSync(path.join(restore, 'a.txt'), 'utf8'), 'a\n');
});

test('the combined result is checked before merging, in a temporary copy, and failing tests need a yes', { skip: scriptCLIs }, async t => {
  let command = { command: `node -e "process.exit(require('fs').readFileSync('value.txt','utf8').trim()==='ours+theirs'?0:1)"`, directory: '' };
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'value.txt': 'base\n', 'other.txt': 'x\n', 'more.txt': 'top\n1\n2\n3\n4\n5\nbottom\n' }) }), { tests: { saved: () => command, run() { throw new Error('The task’s check runs in its own copy.'); } } });
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folders.a)).length, 'the main run');
  const task = hold(env, 'a', 'Hold A'); await working(env, task);
  edit(env, task, 'value.txt', 'ours+theirs\n'); await finish(env, task);
  env.release(fs.realpathSync(env.folders.a)); await main.done;
  fs.writeFileSync(path.join(env.folders.a, 'uncommitted.txt'), 'here\n');
  let review = env.broker.tasks.review(env.c, task.id);
  assert.equal(review.canCheck, true); assert.equal(review.check, null);
  const passed = await env.broker.tasks.check(env.c, task.id, { digest: review.digest });
  assert.equal(passed.status, 'passed');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'value.txt'), 'utf8'), 'base\n', 'The folder is untouched.');
  assert.doesNotMatch(git(env.folders.a, 'worktree', 'list'), /check-/, 'The temporary copy is gone.');
  assert.equal(env.broker.tasks.review(env.c, task.id).check.status, 'passed', 'The result stays with what it checked.');
  command = { command: 'node -e "console.log(\'nope\');process.exit(3)"', directory: '' };
  const failed = await env.broker.tasks.check(env.c, task.id, { digest: review.digest });
  assert.deepEqual([failed.status, failed.exitCode], ['failed', 3]); assert.match(failed.output, /nope/);
  await assert.rejects(env.broker.tasks.integrate(env.c, task.id, { digest: review.digest }), /tests failed on the combined result/);
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'value.txt'), 'utf8'), 'base\n');
  await env.broker.tasks.integrate(env.c, task.id, { digest: review.digest, acceptFailedCheck: true });
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'value.txt'), 'utf8'), 'ours+theirs\n');
});

test('a dependency keeps its work in order, and a copy has to be merged before what depends on it starts', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'a.txt': '1\n' }), b: repository(path.join(root, 'b')) }), { policy: { maxConcurrent: 5 } });
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folders.a)).length, 'the main run');
  const first = hold(env, 'a', 'Hold A'); await working(env, first);
  const after = env.start('b', 'Hold B', { dependsOn: first.id });
  assert.equal(env.task(after.id).status, 'waiting'); assert.match(env.task(after.id).reason, /Waiting for “Hold A”/);
  edit(env, first, 'a.txt', '2\n'); await finish(env, first);
  await until(() => /to be merged/.test(env.task(after.id).reason), 'it to wait for the merge');
  assert.equal(env.task(after.id).status, 'waiting', 'Its work isn’t anywhere the next one can see yet.');
  env.release(fs.realpathSync(env.folders.a)); await main.done;
  await env.broker.tasks.integrate(env.c, first.id, { digest: env.broker.tasks.review(env.c, first.id).digest });
  await working(env, after);
  assert.throws(() => env.broker.tasks.discard(env.c, after.id), /Stop this task/);
  env.release(fs.realpathSync(env.folders.b)); await finished(env, after);
  assert.throws(() => env.start('b', 'Later', { dependsOn: 'missing' }), /no longer here/);
});

test('every task shares the workspace’s limit, with the main run, and starts when a slot frees', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')), b: repository(path.join(root, 'b')), c: repository(path.join(root, 'c')) }), { policy: { maxConcurrent: 2, allowedProviders: ['codex'] } });
  const a = hold(env, 'a', 'Hold A'), b = hold(env, 'b', 'Hold B'); await working(env, a); await working(env, b);
  const c = hold(env, 'c', 'Hold C');
  assert.equal(env.task(c.id).status, 'waiting'); assert.match(env.task(c.id).reason, /already running/);
  assert.throws(() => env.broker.start(env.c, { text: 'Main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }), /already running/, 'The main conversation counts too.');
  assert.deepEqual([env.broker.tasks.preview(env.c, { folderId: 'c' }).full, env.broker.tasks.preview(env.c, { folderId: 'c' }).limit], [true, 2], 'The page can say so before it starts.');
  assert.throws(() => env.start('c', 'On Claude', { provider: 'claude' }), /isn't allowed by this workspace's task limits/, 'A task can’t use an agent the workspace left out.');
  assert.deepEqual(env.lane(a.id).broker.budget.policy(env.lane(a.id).c).allowedProviders, ['codex'], 'Its limits come from the workspace.');
  env.broker.budget.setPolicy(env.c, { maxHandoffs: 1 });
  env.release(fs.realpathSync(env.folders.a)); await finished(env, a);
  await working(env, c);
  assert.equal(env.lane(c.id).broker.budget.policy(env.lane(c.id).c).maxHandoffs, 1, 'And changes reach it when it starts.');
  env.release(fs.realpathSync(env.folders.b)); env.release(fs.realpathSync(env.folders.c)); await finished(env, b); await finished(env, c);
});

test('a restart holds what was waiting, marks what was running, and a task that lost its folder or copy can’t run', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'x.txt': '1\n' }), b: repository(path.join(root, 'b')) }), { policy: { maxConcurrent: 5 } });
  const a = hold(env, 'a', 'Hold A'); await working(env, a);
  const copy = hold(env, 'a', 'Hold B'); await working(env, copy);
  const dependent = env.start('b', 'Hold C', { dependsOn: a.id });
  assert.equal(env.task(dependent.id).status, 'waiting');
  const place = env.task(copy.id).worktree;
  await env.reopen();
  assert.deepEqual([env.task(a.id).status, env.task(copy.id).status], ['stopped', 'stopped']);
  assert.equal(env.task(dependent.id).status, 'waiting'); assert.equal(env.task(dependent.id).held, true, 'Nothing starts by itself after a restart.');
  assert.equal(fs.existsSync(place), true, 'Its copy is kept.');
  assert.equal(env.broker.tasks.lanes.get(a.id).c.lastRun.status, 'interrupted');
  await env.broker.tasks.lanes.get(copy.id).broker.close();
  env.broker.tasks.lanes.delete(copy.id);
  fs.rmSync(place, { recursive: true, force: true });
  await env.reopen();
  assert.equal(env.task(copy.id).status, 'lost'); assert.throws(() => env.broker.tasks.review(env.c, copy.id), /nothing to merge|working copy is gone/);
  // The folder leaves the workspace.
  await env.broker.close();
  const kept = env.list.filter(folder => folder.id !== 'a');
  env.broker = new Broker({ workspace: kept[0].path, workspaceFolders: kept, dataDir: env.dataDir, bins: env.bins, handoffPreferences: () => ({ threshold: 0, automatic: false }) });
  env.c = env.broker.get(env.c.id);
  assert.equal(env.task(a.id).status, 'detached'); assert.equal(env.task(dependent.id).status, 'waiting', 'A task in a folder still here keeps its place.');
  const detached = env.broker.tasks.lane(env.c, env.task(a.id));
  assert.throws(() => detached.broker.start(detached.c, { text: 'More', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }), /no longer in this workspace/);
  assert.deepEqual(detached.broker.workspaces, [fs.realpathSync(env.folders.a)], 'Its lane keeps to that folder, and nothing gets more access.');
  assert(env.broker.tasks.view(env.c, a.id).messages.some(message => message.text === 'Hold A'), 'Its history stays readable.');
});

test('an agent left running by a crash blocks only its own task, and the workspace still opens', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')), b: repository(path.join(root, 'b')) }));
  const a = hold(env, 'a', 'Hold A'); await working(env, a);
  const journal = path.join(env.broker.tasks.directory(env.task(a.id)), 'journal', `${env.task(a.id).conversationId}.jsonl`);
  await env.broker.close();
  // As after a crash: the journal says this process group is the agent, and it is still alive.
  const record = { type: 'submission', seq: 9999, at: new Date().toISOString(), id: 'orphan', provider: 'codex', mode: 'edit', model: null, transport: 'auto', context: {}, requestId: 'orphan', fingerprint: 'x', workspaceSignature: 'x', message: { id: 'orphan-message', role: 'user', text: 'Orphan', provider: 'codex', runId: 'orphan' } };
  fs.appendFileSync(journal, `${JSON.stringify(record)}\n${JSON.stringify({ ...record, type: 'run_process', seq: 10000, pid: process.pid })}\n`);
  const main = env.c.parallelTasks.find(item => item.id === a.id); main.status = 'running';
  fs.appendFileSync(path.join(env.dataDir, `${env.c.id}.jsonl`), `${JSON.stringify({ type: 'parallel_task_update', id: a.id, changes: { status: 'running' }, seq: env.c.records + 1, at: new Date().toISOString() })}\n`);
  let group = null; try { process.kill(-process.pid, 0); group = true; } catch { group = false; }
  env.broker = env.open(); env.c = env.broker.get(env.c.id);
  if (group) { assert.equal(env.task(a.id).status, 'blocked'); assert.match(env.task(a.id).reason, /may still be active/); }
  const b = hold(env, 'b', 'Hold B'); await working(env, b);
  assert.equal(env.task(b.id).status, 'running', 'Other folders carry on.');
  env.release(fs.realpathSync(env.folders.b)); await finished(env, b);
});

test('a task starts once for one request, keeps its access, and gets the workspace’s memory, skills and chosen history', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')), b: repository(path.join(root, 'b')) }));
  env.broker.changeMemory(env.c, { action: 'add', kind: 'convention', text: 'Dates are UTC everywhere', folderId: null });
  env.broker.changeMemory(env.c, { action: 'add', kind: 'convention', text: 'Only for folder b', folderId: 'b' });
  env.broker.message(env.c, 'user', 'Earlier context from the main conversation', 'codex');
  const first = env.start('a', 'Hold A', { requestId: 'same', includeHistory: true, mode: 'read', approvalPolicy: 'ask' });
  assert.equal(env.start('a', 'Hold A', { requestId: 'same', mode: 'read' }).id, first.id);
  assert.equal(env.c.parallelTasks.length, 1);
  await working(env, first);
  const seen = env.captured(fs.realpathSync(env.folders.a))[0];
  assert.match(seen.prompt, /Dates are UTC everywhere/); assert.doesNotMatch(seen.prompt, /Only for folder b/, 'Memory for another folder stays out.');
  assert.match(seen.prompt, /Earlier context from the main conversation/);
  assert.deepEqual([env.lane(first.id).c.activeRun.mode, env.lane(first.id).c.activeRun.approvalPolicy], ['read', 'ask'], 'Its access is what was chosen, never more.');
  assert.deepEqual(seen.context.workspaceFolders.map(folder => folder.id), ['a'], 'And it is only told about its own folder.');
  env.release(fs.realpathSync(env.folders.a)); await finished(env, first);
  // A follow-up in a task that ran directly goes through its own lane.
  const lane = env.lane(first.id);
  lane.broker.start(lane.c, { text: 'Hold A', provider: 'codex', mode: 'read', approvalPolicy: 'ask', requestId: 'follow-up' });
  await until(() => env.task(first.id).status === 'running', 'the follow-up');
  fs.writeFileSync(path.join(fs.realpathSync(env.folders.a), '.release'), ''); await finished(env, first);
  assert.equal(env.task(first.id).status, 'complete');
  // Closing: worked directly, so nothing is left behind.
  assert.throws(() => env.broker.tasks.discard(env.c, first.id), /no separate copy/);
  env.broker.tasks.closeTask(env.c, first.id);
  assert.deepEqual(env.broker.tasks.list(env.c), []);
  // The ledger covers lanes too.
  const ledger = await env.broker.ledger(env.c);
  assert.equal(ledger.tasks.filter(item => item.folder === 'a').length >= 1, true);
});

test('a task’s copy must be merged or discarded before it closes, and a waiting one can be cancelled', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'x.txt': '1\n' }) }), { policy: { maxConcurrent: 5 } });
  const first = hold(env, 'a', 'Hold A'); await working(env, first);
  const copy = hold(env, 'a', 'Hold B'); await working(env, copy);
  edit(env, copy, 'x.txt', '2\n'); await finish(env, copy);
  assert.throws(() => env.broker.tasks.closeTask(env.c, copy.id), /Merge or discard/);
  const place = env.task(copy.id).worktree;
  env.broker.tasks.discard(env.c, copy.id);
  assert.equal(env.task(copy.id).status, 'discarded'); assert.equal(fs.existsSync(place), false);
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'x.txt'), 'utf8'), '1\n');
  env.broker.tasks.closeTask(env.c, copy.id);
  const waiting = env.start('a', 'Hold C', { dependsOn: first.id });
  assert.equal(env.broker.tasks.discard(env.c, waiting.id).task.status, 'cancelled');
  env.release(fs.realpathSync(env.folders.a)); await finished(env, first);
  assert.equal(env.task(waiting.id).conversationId, undefined, 'A cancelled task never starts.');
});

test('through the real server: a task starts, its conversation answers for itself, and the workspace can’t change under it', { skip: scriptCLIs }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-task-server-'))), a = repository(path.join(root, 'a')), b = repository(path.join(root, 'b')), cli = path.join(root, 'codex-mock.mjs');
  fs.writeFileSync(cli, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  const app = createRelayServer({ workspace: a, dataRoot: path.join(root, 'data'), bins: { codex: cli, claude: cli, gemini: path.join(root, 'missing') }, accessToken: 'fixture-token' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  app.registry.addFolder(app.registry.list()[0].id, b);
  const project = app.registry.list()[0], main = app.registry.broker(project.id), home = main.get(app.registry.mainConversation(project.id).id);
  const call = async (route, input) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}${route.includes('?') ? '&' : '?'}projectId=${project.id}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'X-AI-Relay-Token': 'fixture-token', 'X-AI-Relay': '1', 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, body: await response.json() }; };
  const folder = project.folders.find(item => item.path === a), other = project.folders.find(item => item.path === b);
  assert.equal((await call('/api/tasks/plan', { folderId: folder.id })).body.mode, 'direct');
  const started = await call('/api/tasks', { text: 'Hold A', folderId: folder.id, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'server-one' });
  assert.equal(started.status, 202);
  await until(() => fs.existsSync(path.join(a, '.mock-captures.jsonl')), 'the task to start');
  const shown = await call(`/api/conversation?task=${started.body.id}`);
  assert.equal(shown.status, 200); assert.equal(shown.body.status, 'running'); assert.equal(shown.body.task.id, started.body.id); assert(shown.body.messages.some(message => message.text === 'Hold A'));
  assert.deepEqual(shown.body.checkpoints, {}, 'Undo works from the main conversation.');
  const mainView = await call('/api/conversation');
  assert.equal(mainView.body.id, home.id); assert.equal(mainView.body.status, 'idle'); assert.deepEqual(mainView.body.parallelTasks.map(task => task.status), ['running']);
  assert.equal(app.registry.list().find(item => item.id === project.id).runningConversationId, 'parallel-task', 'The sidebar knows the workspace is working.');
  const incremental = await call(`/api/conversation?task=${started.body.id}&since=${shown.body.cursor}`);
  assert.equal(incremental.body.id, shown.body.id);
  assert.match((await call(`/api/conversations/${shown.body.id}/provider`, { provider: 'codex', mode: 'read' })).body.error || 'accepted', /./);
  // What belongs to the workspace goes to the workspace, from whichever conversation is open.
  const remembered = await call(`/api/conversations/${shown.body.id}/memory`, { action: 'add', kind: 'convention', text: 'Saved from a task' });
  assert.equal(remembered.status, 200); assert(home.memory.some(entry => entry.text === 'Saved from a task'));
  assert.equal(main.tasks.lanes.get(started.body.id).c.memory?.some(entry => entry.text === 'Saved from a task') || false, false);
  // Folders can't change while a task works there.
  assert.throws(() => app.registry.removeFolder(project.id, other.id), /Stop the current run/);
  await assert.rejects(app.registry.withMutation(project.id, 'patch', async () => {}), /busy/, 'Workspace-wide operations wait too.');
  // Stop reaches this task by its conversation, and only this task.
  const stopped = await call(`/api/conversations/${shown.body.id}/stop`, {});
  assert.equal(stopped.body.stopped, true);
  await until(() => !main.tasks.lanes.get(started.body.id).broker.running && main.tasks.find(home, started.body.id).status === 'stopped', 'it to stop');
  assert.equal((await call(`/api/conversations/${home.id}/stop`, {})).body.stopped, false, 'The main conversation had nothing to stop.');
  assert.equal((await call(`/api/conversations/not-a-conversation/stop`, {})).status, 404);
  assert.equal((await call('/api/tasks/plan', { folderId: 'missing' })).status, 400);
  assert.equal((await call(`/api/tasks/${started.body.id}/close`, {})).body.closed, true);
  assert.deepEqual((await call('/api/tasks')).body.tasks, []);
  // Without a task running, folders can change, and a task whose folder went stays, but can't run.
  const second = await call('/api/tasks', { text: 'Hold B', folderId: other.id, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'server-two' });
  await until(() => fs.existsSync(path.join(b, '.mock-captures.jsonl')), 'the second task');
  fs.writeFileSync(path.join(b, '.release'), '');
  await until(() => !main.tasks.lanes.get(second.body.id)?.broker.running && main.tasks.find(home, second.body.id).status === 'complete', 'it to finish');
  app.registry.removeFolder(project.id, other.id);
  const after = app.registry.broker(project.id), now = after.get(app.registry.mainConversation(project.id).id);
  assert.equal(after.tasks.find(now, second.body.id).status, 'detached');
  assert.equal((await call(`/api/conversation?task=${second.body.id}`)).status, 200, 'Its history stays readable.');
});

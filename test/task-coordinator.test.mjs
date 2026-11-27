import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { noSymlinks, scriptCLIs } from './platform.mjs';
import { captureReview, listReviewChanges, reviewFreshness } from '../src/agent-review.mjs';
import { Broker } from '../src/broker.mjs';
import { MutationCoordinator } from '../src/mutation-lock.mjs';
import { createRelayServer } from '../src/server.mjs';
import { applyPlan, checkCombined, createWorktree, folderIdentity, ignoredPaths, integrationPlan, markerLabels, ownCheck, pathsOverlap, planIsolation, prepareResolution, refreshWorktree, uncommittedCount, unrestricted } from '../src/task-isolation.mjs';
import { stageChanges, unstageChanges, commitChanges } from '../src/workspace-commit.mjs';
import { taskFilePath } from '../src/task-coordinator.mjs';

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
  git(folder, 'init', '-q'); git(folder, 'config', 'core.autocrlf', 'false'); git(folder, 'config', 'user.email', 't@t.t'); git(folder, 'config', 'user.name', 't');
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
  const open = () => { const paths = list.map(folder => folder.path); return new Broker({ workspace: paths[0], workspaceFolders: list, dataDir, bins, tests, handoffPreferences: () => ({ threshold: 0, automatic: false }), acquireMutation: operation => mutations.acquireMany(paths, operation), acquireFolders: (where, operation) => mutations.acquireMany(where, operation), withFolders: (where, operation, work) => mutations.withMutations(where, operation, work), activeMutations: where => mutations.active(where) }); };
  const broker = open(), c = broker.get(broker.create().id);
  broker.checks.usage = async () => ({ available: false });
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
  assert.equal(planIsolation(git1, []).mode, 'worktree');
  assert.equal(planIsolation(git1, [on('/r2', '/r2/.git')]).mode, 'worktree', 'Git repositories with commits run in their own copy.');
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

test('a file an agent names with its copy’s full path is named as the folder names it (#162)', () => {
  const root = path.resolve('/work/repo'), worktree = path.resolve('/data/tasks/t1/worktree');
  const card = { worktree, scopePath: worktree, folderPath: root, repoRoot: root };
  // Claude's and Codex's edits can name the file with the copy's full path: the cards after it are told the file, not the copy.
  assert.equal(taskFilePath(card, path.join(worktree, 'src', 'add.js')), 'src/add.js');
  assert.equal(taskFilePath(card, './src/add.js'), 'src/add.js');
  assert.equal(taskFilePath(card, path.join(root, 'notes.md')), 'notes.md');
  // A path outside every folder of the task is kept as it is; an empty one is dropped.
  assert.equal(taskFilePath(card, path.resolve('/tmp/scratch.txt')), path.resolve('/tmp/scratch.txt'));
  assert.equal(taskFilePath(card, '  '), '');
  // In a sub-folder of its repository, both kinds of path lose the sub-folder, as the copy's own list does.
  const sub = { worktree, scopePath: path.join(worktree, 'app'), folderPath: path.join(root, 'app'), repoRoot: root, prefix: 'app' };
  assert.equal(taskFilePath(sub, path.join(worktree, 'app', 'src', 'add.js')), 'src/add.js');
  assert.equal(taskFilePath(sub, 'app/src/add.js'), 'src/add.js');
  assert.equal(taskFilePath(sub, 'src/add.js'), 'src/add.js');
});

test('a card that saves files Git ignores waits for its folder, since a copy would lose them', t => {
  const git1 = { real: '/r1', git: true, head: true, commonDir: '/r1/.git' };
  const main = { real: '/r1', commonDir: '/r1/.git', unrestricted: false, label: 'The main conversation' };
  assert.equal(planIsolation(git1, [], { keeps: ['output/a.md'] }).mode, 'direct', 'With nothing else working it runs in the folder, as any card does.');
  const held = planIsolation(git1, [main], { keeps: ['output/a.md', 'output/b.png', 'output/shots/', 'output/d.md'] });
  assert.equal(held.mode, 'wait');
  assert.equal(held.reason, 'The main conversation is using this repository, and this card saves files Git ignores (output/a.md, output/b.png, output/shots/ and 1 more), which its own copy would lose. So it waits until that finishes, then works in the folder itself.');
  assert.equal(planIsolation(git1, [main]).mode, 'worktree', 'A card that names no such file still gets a copy.');
  // Which paths Git ignores, asked of the folder itself.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-ignored-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = repository(path.join(root, 'repo'), { 'src/a.js': '1', 'web/page.js': '2' });
  fs.appendFileSync(path.join(repo, '.gitignore'), 'output/\n*.log\n'); git(repo, 'add', '-f', '.gitignore'); git(repo, 'commit', '-qm', 'ignore');
  fs.mkdirSync(path.join(repo, 'output')); fs.writeFileSync(path.join(repo, 'output', 'kept.md'), 'tracked'); git(repo, 'add', '-f', 'output/kept.md'); git(repo, 'commit', '-qm', 'tracked');
  assert.deepEqual(ignoredPaths(repo, ['output/launch/audit.md', './output/shots/', 'src/', 'src/a.js', 'README.md', 'build.log', 'output/kept.md', ':(glob)*', '/etc/output/x', '../output/x', '~/output/x', 'output/launch/audit.md']), ['output/launch/audit.md', 'output/shots/', 'build.log'], 'A tracked file isn’t ignored, whatever its name; magic, absolute and outside paths are skipped.');
  assert.deepEqual(ignoredPaths(path.join(repo, 'web'), ['output/x.png', 'page.js']), ['output/x.png'], 'From a folder inside the repository, paths are its own.');
  assert.deepEqual(ignoredPaths(repo, []), []);
  const plain = path.join(root, 'plain'); fs.mkdirSync(plain);
  assert.deepEqual(ignoredPaths(plain, ['output/x.md']), [], 'A folder outside Git ignores nothing.');
  // A card's own check that moves into the card's folder first runs from that folder instead.
  const site = path.join(root, 'site'); fs.mkdirSync(site);
  assert.equal(ownCheck('cd ../site && npm run typecheck && npm run build', site), 'npm run typecheck && npm run build');
  assert.equal(ownCheck(`cd "${site}" && npm test`, site), 'npm test');
  assert.equal(ownCheck('cd . && npm test', site), 'npm test');
  assert.equal(ownCheck('cd ../repo && npm test', site), 'cd ../repo && npm test', 'A move to another folder is left as written.');
  assert.equal(ownCheck('cd ../missing && npm test', site), 'cd ../missing && npm test');
  assert.equal(ownCheck('npm test', site), 'npm test');
  assert.equal(ownCheck('cd ../site; rm -rf x', site), 'cd ../site; rm -rf x', 'Only a move joined with && is dropped.');
});

test('two tasks in different folders run at once, each with its own output and Stop, and stay apart after a restart', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')), b: repository(path.join(root, 'b')) }));
  const a = hold(env, 'a', 'Hold A'), b = hold(env, 'b', 'Hold B');
  await working(env, a); await working(env, b);
  assert.deepEqual([env.task(a.id).status, env.task(b.id).status, env.task(a.id).mode, env.task(b.id).mode], ['running', 'running', 'worktree', 'worktree']);
  const [laneA, laneB] = [env.lane(a.id), env.lane(b.id)];
  assert.deepEqual(laneA.broker.workspaces, [env.task(a.id).scopePath], 'A task only holds its own copy.');
  assert.notEqual(laneA.c.id, laneB.c.id);
  assert.equal(env.captured(env.task(a.id).scopePath)[0].context.currentRequest, 'Hold A'); assert.equal(env.captured(env.task(b.id).scopePath)[0].context.currentRequest, 'Hold B');
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
  assert.deepEqual(env.broker.tasks.lanes.get(b.id).broker.workspaces, [env.task(b.id).scopePath], 'A restart doesn’t widen what it reaches.');
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
  env.release(env.task(a.id).scopePath); env.release(env.task(b.id).scopePath); await finished(env, a); await finished(env, b);
});

test('the same repository under two roots, a nested root and a linked root all take their own copy, and a main run shares too', { skip: noSymlinks || scriptCLIs }, async t => {
  const env = setup(t, root => {
    const repo = repository(path.join(root, 'repo'), { 'web/index.js': 'web\n', 'api/index.js': 'api\n', 'web/.mock-scenarios.json': scenarios, 'api/.mock-scenarios.json': scenarios });
    fs.symlinkSync(repo, path.join(root, 'link'));
    return { web: path.join(repo, 'web'), api: path.join(repo, 'api'), link: path.join(root, 'link') };
  });
  const web = hold(env, 'web', 'Hold A'); await working(env, web);
  assert.equal(env.task(web.id).mode, 'worktree');
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

test('a direct task and a run or file operation in the same folder can’t both proceed, while a worktree task leaves them free', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), {}, { commit: false }), b: repository(path.join(root, 'b')) }));
  const a = hold(env, 'a', 'Hold A'); await working(env, a);
  assert.equal(env.task(a.id).mode, 'direct');
  assert.throws(() => env.broker.start(env.c, { text: 'Main work', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }), /busy/, 'The main conversation reaches every folder, so its run waits.');
  await assert.rejects(env.mutations.withMutations([env.folders.a], 'patch', async () => {}), /busy/, 'Patches, undo and imports take the same lease.');
  const folder = { id: 'a', path: env.folders.a };
  await assert.rejects(stageChanges(folder, { all: true }), /busy/, 'The Git panel cannot stage a task’s active folder.');
  await assert.rejects(unstageChanges(folder, { all: true }), /busy/);
  await assert.rejects(commitChanges(folder, { message: 'While active', expected: [] }), /busy/);
  await stageChanges({ id: 'b', path: env.folders.b }, { all: true });
  assert.deepEqual(await env.mutations.withMutations([env.folders.b], 'patch', async () => 'done'), 'done', 'Another folder isn’t held.');
  env.release(fs.realpathSync(env.folders.a)); await finished(env, a);
  // A Git task with a commit runs in its own copy, so the workspace chat and folder operations stay free.
  const b = hold(env, 'b', 'Hold B'); await working(env, b);
  assert.equal(env.task(b.id).mode, 'worktree');
  assert.deepEqual(await env.mutations.withMutations([env.folders.b], 'patch', async () => 'free'), 'free');
  await stageChanges({ id: 'b', path: env.folders.b }, { all: true });
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folders.a)).length, 'main run in workspace');
  assert.equal(env.task(b.id).status, 'running');
  env.release(fs.realpathSync(env.folders.a)); await main.done;
  env.release(env.task(b.id).scopePath); await finished(env, b);
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
  // Another agent's review of the task reads its copy: the task's changes, not the person's work in the folder.
  const scope = env.broker.tasks.reviewScope(env.c, task.id);
  assert.deepEqual(scope.project.folders.map(folder => [folder.id, folder.path]), [['a', env.task(task.id).scopePath]]);
  assert.deepEqual(listReviewChanges(scope.project.folders)[0].changes.map(file => file.path).sort(), ['app.js', 'gone.js', 'new/file.js']);
  // Opening Review & merge above committed the copy; the review still sees the task's changes since it started.
  const snapshot = captureReview(scope.project.folders, [{ folderId: 'a', path: 'app.js' }, { folderId: 'a', path: 'gone.js' }]);
  assert.match(snapshot.files[0].diff, /-two\n\+TWO/); assert.equal(snapshot.files[1].contentHash, null); assert.equal(snapshot.files[0].head, env.task(task.id).base);
  assert.equal(reviewFreshness({ snapshot }, env.broker.tasks.reviewScope(env.c, task.id).project.folders).stale, false);
  env.broker.tasks.review(env.c, task.id);
  assert.equal(reviewFreshness({ snapshot }, env.broker.tasks.reviewScope(env.c, task.id).project.folders).stale, false, 'Committing the copy again doesn’t make the review outdated.');
  edit(env, task, 'app.js', 'one\nTWO!\nthree\n');
  assert.equal(reviewFreshness({ snapshot }, env.broker.tasks.reviewScope(env.c, task.id).project.folders).stale, true);
  edit(env, task, 'app.js', 'one\nTWO\nthree\n');
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
  assert.throws(() => env.broker.tasks.reviewScope(env.c, task.id), /has ended/, 'Merged changes are reviewed from the workspace chat.');
  assert.doesNotMatch(git(env.folders.a, 'worktree', 'list'), /worktree$/m); assert.equal(git(env.folders.a, 'for-each-ref', 'refs/codeshi').trim(), '');
  assert.match(env.c.messages.at(-1).text, /Merged “Hold A” into a: 3 files/);
  assert.throws(() => env.broker.tasks.integrate(env.c, task.id, { digest: review.digest }), /nothing to merge/);
  assert(env.broker.tasks.view(env.c, task.id).messages.some(message => message.text === 'Hold A'), 'Its history stays.');
  const ended = env.lane(task.id); assert.throws(() => ended.broker.start(ended.c, { text: 'More', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }), /has ended/);
});

test('a task’s copy brings the installed dependencies but no secrets, and neither becomes part of its changes', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => {
    const folder = repository(path.join(root, 'a'), { 'app.js': 'one\n', 'web/page.js': 'page\n' });
    fs.writeFileSync(path.join(folder, '.gitignore'), '.release\n.mock-captures.jsonl\nnode_modules/\n.env*\n');
    git(folder, 'commit', '-qam', 'ignore');
    for (const place of ['node_modules/dep', 'web/node_modules/tool']) { fs.mkdirSync(path.join(folder, place), { recursive: true }); fs.writeFileSync(path.join(folder, place, 'index.js'), 'installed\n'); }
    fs.writeFileSync(path.join(folder, '.env'), 'SECRET=1\n'); fs.writeFileSync(path.join(folder, 'web/.env.local'), 'SECRET=2\n');
    return { a: folder };
  });
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folders.a)).length, 'the main run');
  const task = hold(env, 'a', 'Hold A'); await working(env, task);
  const saved = env.task(task.id), copy = saved.worktree;
  assert.equal(saved.mode, 'worktree');
  assert.deepEqual(saved.setup.dependencies.map(item => item.path), ['node_modules', 'web/node_modules']);
  assert.deepEqual(saved.setup.missing, ['.env', 'web/.env.local'], 'The person is told which secrets the copy lacks.');
  assert.equal(fs.readFileSync(path.join(copy, 'web/node_modules/tool/index.js'), 'utf8'), 'installed\n', 'Its build finds what is installed.');
  assert.equal(fs.existsSync(path.join(copy, '.env')), false, 'Secrets are never copied.');
  const cloned = saved.setup.dependencies.every(item => item.how === 'copy');
  if (cloned) {
    edit(env, task, 'node_modules/dep/index.js', 'reinstalled\n');
    assert.equal(fs.readFileSync(path.join(env.folders.a, 'node_modules/dep/index.js'), 'utf8'), 'installed\n', 'Installing in the task leaves the folder’s own alone.');
  }
  edit(env, task, 'app.js', 'two\n');
  env.release(env.task(task.id).scopePath); await finished(env, task);
  const review = env.broker.tasks.review(env.c, task.id);
  assert.deepEqual(review.files.map(file => file.path), ['app.js'], 'Brought-in dependencies are never part of its changes.');
  env.release(fs.realpathSync(env.folders.a)); await main.done;
  env.broker.tasks.discard(env.c, task.id);
  assert.equal(fs.existsSync(copy), false, 'Its copy is gone.');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'node_modules/dep/index.js'), 'utf8'), 'installed\n', 'Removing the copy never reaches the folder’s dependencies.');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'web/node_modules/tool/index.js'), 'utf8'), 'installed\n');
});

test('a queued prompt can start as a task beside the main run, keeping its settings, and stays queued when the task can’t start', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')) }));
  env.broker.tasks.BrokerClass = class extends Broker {
    constructor(options) {
      super(options);
      this.availableProviders = () => ['claude'];
      this.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'subscription' });
      this.handoff.models = async () => ({ models: [{ id: 'haiku', displayName: 'Haiku' }] });
      this.checks.usage = async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: 10 }] });
      this.router.worker = async () => JSON.stringify({ tier: 'light', effort: 'low', reason: 'A scoped read-only task.' });
    }
  };
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folders.a)).length, 'the main run');
  env.broker.queueAction(env.c, { action: 'add', text: 'First queued', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  env.broker.execution.setDefault(env.c, { mode: 'flow' });
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
  assert.equal(env.lane(task.id).c.lastRun.routing.assessment.source, 'agent', 'A routed queued prompt is assessed when its task lane starts.');
  env.release(fs.realpathSync(env.folders.a)); await main.done;
});

test('changes on both sides merge when they don’t touch, and a conflict overwrites nothing and can be kept as a branch', { skip: scriptCLIs }, async t => {
  const text = 'one\n2\n3\n4\n5\n6\nseven\n';
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'merge.txt': text, 'clash.txt': 'same\n', 'both.txt': 'x\n', 'bin.dat': 'y\n' }) }), { policy: { maxConcurrent: 5 } });
  const first = hold(env, 'a', 'Hold A'), second = hold(env, 'a', 'Hold B'); await working(env, first); await working(env, second);
  assert.deepEqual([env.task(first.id).mode, env.task(second.id).mode], ['worktree', 'worktree'], 'Both tasks in a Git repository work in their own copies.');
  edit(env, second, 'merge.txt', 'ONE\n2\n3\n4\n5\n6\nseven\n'); edit(env, second, 'clash.txt', 'theirs\n'); edit(env, second, 'both.txt', 'identical\n');
  await finish(env, second);
  env.release(env.task(first.id).scopePath); await finished(env, first);
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

test('each conflict says whether an agent can combine it, and preparing one writes only the copy, with the folder’s versions as the new base', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-resolve-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (folder, files) => { for (const [name, text] of Object.entries(files)) { if (text === null) fs.rmSync(path.join(folder, name)); else fs.writeFileSync(path.join(folder, name), text); } };
  const read = (folder, name) => fs.existsSync(path.join(folder, name)) ? fs.readFileSync(path.join(folder, name), 'utf8') : null;
  const repo = repository(path.join(root, 'repo'), { 'lines.txt': 'a\nb\nc\n', 'gone.txt': 'g\n', 'drop.txt': 'd\n', 'img.bin': 'x\0y', 'calm.txt': '1\n2\n3\n4\n5\n' }), base = git(repo, 'rev-parse', 'HEAD').trim();
  const copy = path.join(root, 'copy'); git(repo, 'worktree', 'add', '-q', '--detach', copy, 'HEAD');
  const commit = () => { git(copy, 'add', '-A'); git(copy, 'commit', '-qm', 'task'); return git(copy, 'rev-parse', 'HEAD').trim(); };
  put(copy, { 'lines.txt': 'a\nB card\nc\n', 'gone.txt': 'G card\n', 'drop.txt': null, 'img.bin': 'x\0card', 'both.txt': 'card\n', 'calm.txt': 'ONE\n2\n3\n4\n5\n' });
  const result = commit();
  put(repo, { 'lines.txt': 'a\nB folder\nc\n', 'gone.txt': null, 'drop.txt': 'D folder\n', 'img.bin': 'x\0folder', 'both.txt': 'folder\n', 'calm.txt': '1\n2\n3\n4\nFIVE\n' });
  const kinds = plan => Object.fromEntries(plan.files.map(file => [file.path, file.kind || file.status]));
  const plan = integrationPlan({ root: repo, base, result });
  assert.deepEqual(kinds(plan), { 'both.txt': 'added-both', 'calm.txt': 'merged', 'drop.txt': 'deleted-by-task', 'gone.txt': 'deleted-here', 'img.bin': 'binary', 'lines.txt': 'lines' });
  const labels = markerLabels('my repo'), folder = Object.fromEntries(['lines.txt', 'gone.txt', 'drop.txt', 'both.txt', 'calm.txt'].map(name => [name, read(repo, name)]));
  assert.throws(() => prepareResolution({ root: repo, worktree: copy, id: 'resolve-test', base, result, plan, labels }), /img\.bin can’t be combined/);
  assert.equal(read(copy, 'lines.txt'), 'a\nB card\nc\n', 'A file that can’t be combined changes nothing, not even the others.');
  put(repo, { 'img.bin': 'x\0y' });
  const prepared = prepareResolution({ root: repo, worktree: copy, id: 'resolve-test', base, result, plan: integrationPlan({ root: repo, base, result }), labels });
  assert.deepEqual(prepared.files.map(file => [file.path, file.kind, file.conflicts]), [['both.txt', 'added-both', 1], ['drop.txt', 'deleted-by-task', 1], ['gone.txt', 'deleted-here', 1], ['lines.txt', 'lines', 1]]);
  assert.equal(read(copy, 'lines.txt'), 'a\n<<<<<<< this copy\nB card\n||||||| when this copy was made\nb\n=======\nB folder\n>>>>>>> my repo now\nc\n');
  assert.equal(read(copy, 'drop.txt'), '<<<<<<< this copy\n||||||| when this copy was made\nd\n=======\nD folder\n>>>>>>> my repo now\n', 'A file the task deleted comes back marked, with its side empty.');
  assert.equal(read(copy, 'gone.txt'), '<<<<<<< this copy\nG card\n||||||| when this copy was made\ng\n=======\n>>>>>>> my repo now\n');
  assert.deepEqual(Object.fromEntries(Object.keys(folder).map(name => [name, read(repo, name)])), folder, 'The folder isn’t touched.');
  assert.equal(git(repo, 'rev-parse', 'refs/codeshi/tasks/resolve-test/base').trim(), prepared.base);
  assert.equal(git(repo, 'show', `${prepared.base}:lines.txt`), 'a\nB folder\nc\n', 'The new base holds the folder’s version.');
  assert.equal(git(repo, 'show', `${prepared.base}:drop.txt`), 'D folder\n'); assert.equal(git(repo, 'show', `${prepared.base}:calm.txt`), '1\n2\n3\n4\n5\n', 'Files that didn’t conflict keep their base.');
  assert.throws(() => git(repo, 'cat-file', '-e', `${prepared.base}:gone.txt`), 'What the folder deleted is gone from the new base too.');
  assert.equal(git(repo, 'status', '--porcelain', '--', 'lines.txt'), ' M lines.txt\n', 'The folder’s own index is left alone.');
  // Still marked: nothing can be merged.
  const pending = { files: prepared.files.map(file => file.path), labels };
  const marked = integrationPlan({ root: repo, base: prepared.base, result: commit(), pending });
  assert.deepEqual(Object.entries(kinds(marked)).filter(([, kind]) => kind === 'unresolved').map(([name]) => name), ['both.txt', 'drop.txt', 'gone.txt', 'lines.txt']);
  // Settled: both lines kept, the task's version of a file the folder deleted, the task's deletion, both additions.
  put(copy, { 'lines.txt': 'a\nB card\nB folder\nc\n', 'gone.txt': 'G card\n', 'drop.txt': null, 'both.txt': 'card\nfolder\n' });
  const ready = integrationPlan({ root: repo, base: prepared.base, result: commit(), pending });
  assert.equal(ready.conflicts, 0);
  assert.deepEqual(ready.files.filter(file => file.resolved).map(file => [file.path, file.status]), [['both.txt', 'clean'], ['drop.txt', 'clean'], ['gone.txt', 'clean'], ['lines.txt', 'clean']]);
  assert.match(ready.files.find(file => file.path === 'lines.txt').diff, /^ B folder$/m, 'The review shows the change to the folder’s own version.');
  applyPlan(repo, ready);
  // The file the folder had deleted comes back as a checkout writes it: with CRLF where core.autocrlf is on, as on Windows.
  assert.deepEqual(['lines.txt', 'gone.txt', 'drop.txt', 'both.txt', 'calm.txt'].map(name => read(repo, name)), ['a\nB card\nB folder\nc\n', git(repo, 'cat-file', '--filters', `${git(copy, 'rev-parse', 'HEAD').trim()}:gone.txt`), null, 'card\nfolder\n', 'ONE\n2\n3\n4\nFIVE\n']);
});

// A repository whose mock agent holds a run that resolves conflicts, so a test can look at the copy meanwhile.
const resolvingRepository = (folder, files) => {
  repository(folder, files);
  fs.writeFileSync(path.join(folder, '.mock-scenarios.json'), JSON.stringify({ ...JSON.parse(scenarios), '~Settle every conflict here': { behavior: 'hold' } }));
  git(folder, 'commit', '-qam', 'resolving scenario');
  return folder;
};
const resolveRun = (env, task) => until(() => env.captured(env.task(task.id).scopePath).find(item => String(item.context.currentRequest).includes('Settle every conflict here')), 'the resolving run');

test('an agent resolves a conflict in the task’s copy, never the folder, and the review then shows the combined result', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: resolvingRepository(path.join(root, 'a'), { 'list.md': 'intro\none\nend\n', 'other.txt': 'x\n' }) }), { policy: { maxConcurrent: 5 } });
  const first = hold(env, 'a', 'Hold A'), second = hold(env, 'a', 'Hold B'); await working(env, first); await working(env, second);
  edit(env, second, 'list.md', 'intro\none\nfrom the card\nend\n'); edit(env, second, 'other.txt', 'y\n');
  await finish(env, second);
  env.release(env.task(first.id).scopePath); await finished(env, first);
  fs.writeFileSync(path.join(env.folders.a, 'list.md'), 'intro\none\nfrom the folder\nend\n');
  const review = env.broker.tasks.review(env.c, second.id);
  assert.equal(review.conflicts, 1); assert.equal(review.files.find(file => file.path === 'list.md').kind, 'lines');
  assert.deepEqual([review.resolve.can, review.resolve.provider], [true, 'codex']);
  assert.throws(() => env.broker.tasks.resolve(env.c, second.id, { digest: 'stale' }), /moved since you reviewed/);
  const copy = env.task(second.id).scopePath; fs.rmSync(path.join(copy, '.release'));
  const started = env.broker.tasks.resolve(env.c, second.id, { digest: review.digest });
  assert.deepEqual([started.started, started.files, started.task.resolving], [true, 1, { open: true, files: 1 }]);
  const asked = (await resolveRun(env, second)).context.currentRequest;
  assert.match(asked, /^This task’s changes can’t be merged into a yet/); assert.match(asked, /^- list\.md: 1 conflict$/m); assert.match(asked, /ask me which to keep, showing both versions/);
  assert.equal(fs.readFileSync(path.join(copy, 'list.md'), 'utf8'), 'intro\none\n<<<<<<< this copy\nfrom the card\n||||||| when this copy was made\n=======\nfrom the folder\n>>>>>>> a now\nend\n', 'The copy has both versions, marked.');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'list.md'), 'utf8'), 'intro\none\nfrom the folder\nend\n', 'The folder isn’t touched.');
  assert.equal(env.task(second.id).status, 'running'); assert.throws(() => env.broker.tasks.review(env.c, second.id), /Wait for this task to finish/);
  // The agent combines both, and the review shows what merging changes in the folder.
  edit(env, second, 'list.md', 'intro\none\nfrom the card\nfrom the folder\nend\n'); env.release(copy); await finished(env, second);
  assert.deepEqual([env.task(second.id).status, env.task(second.id).resolve.open], ['complete', false]);
  const after = env.broker.tasks.review(env.c, second.id), row = after.files.find(file => file.path === 'list.md');
  assert.deepEqual([after.conflicts, row.status, row.resolved, after.resolve.combined], [0, 'clean', true, 1]);
  assert.match(row.diff, /^\+from the card$/m); assert.doesNotMatch(row.diff, /^[-+]from the folder$/m);
  // The folder moves on in other lines meanwhile: that merges as any change does.
  fs.writeFileSync(path.join(env.folders.a, 'list.md'), 'INTRO\none\nfrom the folder\nend\n');
  const last = env.broker.tasks.review(env.c, second.id);
  assert.equal(last.files.find(file => file.path === 'list.md').status, 'merged');
  await env.broker.tasks.integrate(env.c, second.id, { digest: last.digest });
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'list.md'), 'utf8'), 'INTRO\none\nfrom the card\nfrom the folder\nend\n');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'other.txt'), 'utf8'), 'y\n');
});

test('a file left marked can’t be merged: resolving again starts from where it began, and a kept branch has no markers', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: resolvingRepository(path.join(root, 'a'), { 'title.md': 'Old title\n' }) }), { policy: { maxConcurrent: 5 } });
  const first = hold(env, 'a', 'Hold A'), second = hold(env, 'a', 'Hold B'); await working(env, first); await working(env, second);
  edit(env, second, 'title.md', 'Card title\n'); await finish(env, second);
  env.release(env.task(first.id).scopePath); await finished(env, first);
  fs.writeFileSync(path.join(env.folders.a, 'title.md'), 'Folder title\n');
  const copy = env.task(second.id).scopePath, folderBase = env.task(second.id).base;
  // A run that can't start puts the copy back as it was.
  const lane = env.lane(second.id), start = lane.broker.start;
  lane.broker.start = () => { throw Object.assign(new Error('No agent today.'), { status: 409 }); };
  assert.throws(() => env.broker.tasks.resolve(env.c, second.id, { digest: env.broker.tasks.review(env.c, second.id).digest }), /No agent today/);
  lane.broker.start = start;
  assert.equal(fs.readFileSync(path.join(copy, 'title.md'), 'utf8'), 'Card title\n'); assert.equal(env.task(second.id).resolve, null);
  assert.equal(git(env.folders.a, 'show', `${env.task(second.id).base}:title.md`), git(env.folders.a, 'show', `${folderBase}:title.md`));
  // The agent asks instead of choosing, and leaves the markers.
  fs.rmSync(path.join(copy, '.release'));
  env.broker.tasks.resolve(env.c, second.id, { digest: env.broker.tasks.review(env.c, second.id).digest });
  await resolveRun(env, second); env.release(copy); await finished(env, second);
  assert.equal(env.task(second.id).resolve.open, true, 'Still marked, so resolving isn’t finished.');
  const marked = env.broker.tasks.review(env.c, second.id);
  assert.deepEqual([marked.conflicts, marked.files[0].kind, marked.resolve.unresolved, marked.resolve.can], [1, 'unresolved', 1, true]);
  await assert.rejects(env.broker.tasks.integrate(env.c, second.id, { digest: marked.digest }), /1 file conflicts/);
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'title.md'), 'utf8'), 'Folder title\n');
  // The folder changes again; resolving again starts from the task's own version, against the folder as it is now.
  fs.writeFileSync(path.join(env.folders.a, 'title.md'), 'Newer folder title\n');
  fs.rmSync(path.join(copy, '.release'));
  env.broker.tasks.resolve(env.c, second.id, { digest: env.broker.tasks.review(env.c, second.id).digest });
  await until(() => env.captured(copy).filter(item => String(item.context.currentRequest).includes('Settle every conflict here')).length === 2, 'the second resolving run');
  assert.equal(fs.readFileSync(path.join(copy, 'title.md'), 'utf8'), '<<<<<<< this copy\nCard title\n||||||| when this copy was made\nOld title\n=======\nNewer folder title\n>>>>>>> a now\n');
  env.release(copy); await finished(env, second);
  // Kept as a branch while still marked: the branch holds the task's own version.
  const { branch } = env.broker.tasks.keep(env.c, second.id);
  assert.equal(git(env.folders.a, 'show', `${branch}:title.md`), 'Card title\n');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'title.md'), 'utf8'), 'Newer folder title\n');
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

test('where Git converts line endings, a task merges like anywhere else and each file keeps the line endings it has', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-eol-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Git for Windows turns core.autocrlf on by default: files are stored with LF and checked out with CRLF.
  const repo = path.join(root, 'repo'), crlf = text => text.replace(/\n/g, '\r\n'), seven = 'one\n2\n3\n4\n5\n6\nseven\n', both = 'ONE\n2\n3\n4\n5\n6\nSEVEN\n';
  fs.mkdirSync(repo); git(repo, 'init', '-q'); git(repo, 'config', 'core.autocrlf', 'true'); git(repo, 'config', 'user.email', 't@t.t'); git(repo, 'config', 'user.name', 't');
  const put = (folder, files) => { for (const [name, text] of Object.entries(files)) { if (text === null) fs.rmSync(path.join(folder, name)); else fs.writeFileSync(path.join(folder, name), text); } };
  const read = name => fs.existsSync(path.join(repo, name)) ? fs.readFileSync(path.join(repo, name), 'utf8') : null;
  put(repo, { 'clean.txt': 'a\n', 'same.txt': 'b\n', 'merge.txt': seven, 'clash.txt': 'x\n', 'lf.txt': 'l\n', 'lf-merge.txt': seven, 'gone.txt': 'g\n', 'drop.txt': 'd\n' });
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'first'); git(repo, 'rm', '-rq', '--cached', '.'); git(repo, 'reset', '-q', '--hard');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  assert.deepEqual([read('merge.txt'), git(repo, 'show', 'HEAD:merge.txt')], [crlf(seven), seven], 'Checked out with CRLF, stored with LF.');
  // The task's work, committed in its own copy as Codeshi does it.
  const copy = path.join(root, 'copy'); git(repo, 'worktree', 'add', '-q', '--detach', copy, 'HEAD');
  put(copy, { 'clean.txt': crlf('A\n'), 'same.txt': crlf('B\n'), 'merge.txt': crlf(seven.replace('one', 'ONE')), 'clash.txt': crlf('theirs\n'), 'lf.txt': crlf('L\n'), 'lf-merge.txt': crlf(seven.replace('one', 'ONE')), 'new.txt': 'new\n', 'gone.txt': null, 'drop.txt': null });
  git(copy, 'add', '-A'); git(copy, 'commit', '-qm', 'task'); const result = git(copy, 'rev-parse', 'HEAD').trim();
  // Meanwhile in the folder: the same change, a change elsewhere in two files, one in the same line, one to a file the task
  // deleted, and two files a tool rewrote with LF, which Git's diff finds unchanged except for the text.
  put(repo, { 'same.txt': crlf('B\n'), 'merge.txt': crlf(seven.replace('seven', 'SEVEN')), 'clash.txt': crlf('ours\n'), 'drop.txt': crlf('D\n'), 'lf.txt': 'l\n', 'lf-merge.txt': seven.replace('seven', 'SEVEN') });
  assert.equal(git(repo, 'diff', '--name-only', '--', 'lf.txt', 'clean.txt', 'gone.txt'), '');
  const plan = integrationPlan({ root: repo, base, result });
  assert.deepEqual(Object.fromEntries(plan.files.map(file => [file.path, file.status])), { 'clash.txt': 'conflict', 'clean.txt': 'clean', 'drop.txt': 'conflict', 'gone.txt': 'clean', 'lf-merge.txt': 'merged', 'lf.txt': 'clean', 'merge.txt': 'merged', 'new.txt': 'clean', 'same.txt': 'same' });
  assert.match(plan.files.find(file => file.path === 'clash.txt').reason, /same lines/); assert.match(plan.files.find(file => file.path === 'drop.txt').reason, /The task deleted this file/);
  put(repo, { 'clash.txt': crlf('x\n'), 'drop.txt': crlf('d\n') });
  const ready = integrationPlan({ root: repo, base, result });
  assert.equal(ready.conflicts, 0); applyPlan(repo, ready);
  assert.deepEqual(Object.fromEntries(plan.files.map(file => [file.path, read(file.path)])), {
    'clash.txt': crlf('theirs\n'), 'clean.txt': crlf('A\n'), 'drop.txt': null, 'gone.txt': null, 'lf-merge.txt': both, 'lf.txt': 'L\n', 'merge.txt': crlf(both), 'new.txt': crlf('new\n'), 'same.txt': crlf('B\n'),
  }, 'Each file keeps the line endings it had, and a new one gets what a checkout writes.');
  git(repo, 'add', '-A');
  assert.equal(git(repo, 'diff', '--cached', '--name-only', result), 'lf-merge.txt\nmerge.txt\n', 'Git sees the task’s work, with the folder’s own changes on top.');
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

test('combined checks find package managers from a Finder PATH and sanitize the app environment', { skip: process.platform === 'win32' }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')) }));
  const nvm = path.join(env.root, 'nvm'), bin = path.join(nvm, 'versions/node/v22.12.0/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\nconsole.log(JSON.stringify({found: 'package-manager', ci: process.env.CI, electron: process.env.ELECTRON_RUN_AS_NODE, options: process.env.NODE_OPTIONS, relay: process.env.AI_RELAY_CHECK_SECRET}));\n`, { mode: 0o700 });
  const changes = { PATH: '/usr/bin:/bin', NVM_DIR: nvm, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--no-warnings', AI_RELAY_CHECK_SECRET: 'private' };
  const saved = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  Object.assign(process.env, changes);
  let result;
  try { result = await checkCombined({ root: env.folders.a, plan: { writes: [] }, command: 'npm', target: path.join(env.root, 'check') }); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.equal(result.status, 'passed', result.output);
  assert.deepEqual(JSON.parse(result.output.trim()), { found: 'package-manager', ci: '1' });
});

test('combined checks find a tool that only a Volta folder in the home provides', { skip: process.platform === 'win32' }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a')) }));
  const home = path.join(env.root, 'home'), bin = path.join(home, '.volta/bin');
  fs.mkdirSync(bin, { recursive: true });
  // A name no computer has installed, so only the temporary home can supply it.
  fs.writeFileSync(path.join(bin, 'volta-only-tool'), `#!${process.execPath}\nconst relay = Object.keys(process.env).filter(key => key.startsWith('AI_RELAY_'));\nconsole.log(JSON.stringify({ found: 'volta', ci: process.env.CI, electron: process.env.ELECTRON_RUN_AS_NODE, options: process.env.NODE_OPTIONS, relay }));\n`, { mode: 0o700 });
  const changes = { PATH: '/usr/bin:/bin', HOME: home, NVM_DIR: undefined, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--no-warnings', AI_RELAY_CHECK_SECRET: 'private' };
  const saved = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  let result;
  try { result = await checkCombined({ root: env.folders.a, plan: { writes: [] }, command: 'volta-only-tool', target: path.join(env.root, 'check') }); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.equal(result.status, 'passed', result.output);
  assert.deepEqual(JSON.parse(result.output.trim()), { found: 'volta', ci: '1', relay: [] });
});

test('a combined check gets its own clone of each node_modules, so a build that refuses a linked one runs, and reinstalling leaves the folder’s alone', { skip: process.platform === 'win32' }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'app.js': 'one\n', 'web/page.js': 'page\n' }) }));
  for (const place of ['node_modules/dep', 'web/node_modules/tool']) { fs.mkdirSync(path.join(env.folders.a, place), { recursive: true }); fs.writeFileSync(path.join(env.folders.a, place, 'index.js'), 'installed\n'); }
  // Where the disk can't clone, the check links instead, as before, and this build's refusal can't be avoided.
  const probe = path.join(env.root, 'probe');
  fs.mkdirSync(path.join(probe, 'from'), { recursive: true });
  fs.writeFileSync(path.join(probe, 'from', 'file'), 'x\n');
  const flags = process.platform === 'darwin' ? ['-c', '-R'] : ['-R', '--reflink=always'];
  try { execFileSync('/bin/cp', [...flags, path.join(probe, 'from'), path.join(probe, 'to')], { stdio: 'ignore' }); } catch { t.skip('This disk can’t make copy-on-write clones.'); return; }
  // Like Next.js's Turbopack: it resolves only inside the project, so a node_modules that leads out of it is refused.
  const build = path.join(env.root, 'build.mjs');
  fs.writeFileSync(build, `import fs from 'node:fs'; import path from 'node:path';
const project = fs.realpathSync('..');
for (const [place, name] of [['../node_modules', 'dep'], ['node_modules', 'tool']]) {
  const real = fs.realpathSync(place);
  if (fs.lstatSync(place).isSymbolicLink() || !real.startsWith(project + path.sep)) { console.log('Could not find ' + name + ': ' + place + ' leads outside ' + project); process.exit(1); }
  if (fs.readFileSync(path.join(place, name, 'index.js'), 'utf8') !== 'installed\\n') process.exit(2);
  fs.writeFileSync(path.join(place, name, 'index.js'), 'reinstalled\\n');
}
console.log('built');
`);
  const result = await checkCombined({ root: env.folders.a, plan: { writes: [] }, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(build)}`, directory: 'web', target: path.join(env.root, 'check') });
  assert.equal(result.status, 'passed', result.output);
  assert.equal(result.output.trim(), 'built');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'node_modules/dep/index.js'), 'utf8'), 'installed\n', 'Reinstalling in the check leaves the folder’s dependencies alone.');
  assert.equal(fs.readFileSync(path.join(env.folders.a, 'web/node_modules/tool/index.js'), 'utf8'), 'installed\n');
  assert.equal(fs.existsSync(path.join(env.root, 'check')), false, 'The check’s copy is gone, with its clones.');
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

// Gated plan runs (#89): a finished step's tests run on a copy of its result before anything builds on it, a failure holds
// the steps after it, and the next step's brief is written when it starts, from what the earlier step actually did.
test('a plan step is tested before the steps after it start, and a failure holds them until you check again or continue', { skip: scriptCLIs }, async t => {
  let command = { command: 'node -e "console.log(\'contract broken\');process.exit(2)"', directory: '' };
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'value.txt': 'base\n' }) }), { tests: { saved: () => command, run() { throw new Error('A step’s tests run on a copy.'); } }, policy: { maxConcurrent: 5 } });
  const step = (id, extra = {}) => ({ id, title: `Step ${id}`, instructions: `Do ${id}.`, files: [], tier: 'standard', dependsOn: [], agent: null, role: 'builder', artifact: null, check: null, skills: [], ...extra });
  const codex = { provider: 'codex', model: null, effort: null };
  const plan = env.broker.orchestrationAction(env.c, { action: 'create', goal: 'Agree the contract, then build the page.' }).orchestrations[0];
  env.broker.orchestrationAction(env.c, { action: 'update', id: plan.id, revision: 0, steps: [step('s1', { role: 'backend', artifact: 'contract' }), step('s2', { dependsOn: ['s1'], role: 'frontend' })] });
  env.broker.orchestrationAction(env.c, { action: 'run', id: plan.id, revision: 1, folderId: 'a', assignments: { s1: codex, s2: codex } });
  const saved = () => env.c.orchestrations.find(item => item.id === plan.id), first = () => env.task(saved().tasks.s1), second = () => env.task(saved().tasks.s2);

  await until(() => first().stepCheck?.status === 'done', 'the first step’s tests');
  assert.deepEqual([first().mode, first().stepCheck.outcome, first().stepCheck.exitCode, first().stepCheck.command], ['worktree', 'failed', 2, command.command]);
  assert.match(first().stepCheck.output, /contract broken/);
  await until(() => /tests failed on “1\. Step s1”/.test(second().reason || ''), 'the second step to be held');
  assert.equal(second().status, 'waiting', 'Nothing builds on a step whose tests failed.');
  assert.deepEqual([saved().stepOutcomes.s1.outcome, saved().stepOutcomes.s1.status], ['failed', 'blocked']);
  assert.equal(saved().artifacts.s1.kind, 'contract', 'The step’s report is recorded as the contract it was asked for.');
  assert.match(env.c.messages.at(-1).text, /tests failed on step 1/);
  assert.doesNotMatch(git(env.folders.a, 'worktree', 'list'), /check-/, 'The tests ran on a temporary copy that is gone.');
  assert.throws(() => env.broker.orchestrationAction(env.c, { action: 'continue', id: plan.id, stepId: 's2' }), /Nothing is holding/);

  // Continuing anyway is recorded as your decision, and the next step is told the tests failed.
  env.broker.orchestrationAction(env.c, { action: 'continue', id: plan.id, stepId: 's1' });
  assert.equal(first().stepCheck.accepted, true);
  assert.equal(saved().stepOutcomes.s1.accepted, true);
  await until(() => second().status === 'complete' && second().stepCheck?.status === 'done', 'the second step');
  const brief = env.captured(second().scopePath).map(capture => capture.context.currentRequest).find(text => text.includes('step 2 of 2'));
  assert.ok(brief, 'The second step ran.');
  assert.match(brief, /Step 1: Step s1 \(backend\)/);
  assert.match(brief, /Tests failed on its result: node -e/);
  assert.match(brief, /Its contract, in its own words:\n {4}Codex: You are doing step 1 of 2/, 'It gets what the first step actually reported.');
  assert.match(brief, /Check the files themselves/);
  assert.deepEqual(Object.keys(second().builtOn), ['s1']);

  // Checking again with tests that pass replaces the result.
  command = { command: 'node -e "process.exit(0)"', directory: '' };
  env.broker.orchestrationAction(env.c, { action: 'recheck', id: plan.id, stepId: 's1' });
  assert.throws(() => env.broker.orchestrationAction(env.c, { action: 'recheck', id: plan.id, stepId: 's1' }), /already running/);
  await until(() => first().stepCheck?.status === 'done', 'the tests to run again');
  assert.deepEqual([first().stepCheck.outcome, saved().stepOutcomes.s1.outcome], ['passed', 'passed']);
  assert.equal(second().builtOn.s1, first().stepResult.at, 'A check again isn’t a new version of the step.');

  // Tests cut short by a restart aren't evidence either way.
  env.broker.tasks.update(env.c, first(), { stepCheck: { id: 'cut', status: 'running', at: new Date().toISOString() } });
  await env.reopen();
  assert.deepEqual([first().stepCheck.status, first().stepCheck.outcome], ['interrupted', 'unverified']);
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
  env.release(env.task(after.id).scopePath); await finished(env, after);
  assert.throws(() => env.start('b', 'Later', { dependsOn: 'missing' }), /no longer here/);
});

// Merging writes to the folder without committing, and a copy is made from the last commit. So the work a task builds on
// is brought into its copy from the folder, in a commit the copy starts from.
const files = {
  put: (folder, list) => { for (const [name, text] of Object.entries(list)) { const file = path.join(folder, name); if (text === null) fs.rmSync(file); else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); } } },
  read: (folder, name) => fs.existsSync(path.join(folder, name)) ? fs.readFileSync(path.join(folder, name), 'utf8') : null,
};
test('a copy starts with the folder’s version of the files its task builds on, and only those, and its changes are still only its own', { skip: noSymlinks }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-built-on-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { put, read } = files, repo = repository(path.join(root, 'repo'), { 'api.js': 'one\ntwo\nthree\n', 'old.js': 'old\n', 'mine.js': 'mine\n' });
  fs.appendFileSync(path.join(repo, '.gitignore'), 'secret.env\nout/\n'); git(repo, 'commit', '-qam', 'ignore');
  const head = git(repo, 'rev-parse', 'HEAD').trim(), identity = folderIdentity(repo);
  // What an earlier card merged, uncommitted as a merge leaves it: a change, a new file in a new folder and a deletion.
  put(repo, { 'api.js': 'one\nTWO merged\nthree\n', 'lib/new.js': 'new\n', 'old.js': null });
  // The person's own work, which no card merged, and what a copy never has: ignored files, a link and a folder.
  put(repo, { 'mine.js': 'mine, edited\n', 'draft.txt': 'draft\n', 'secret.env': 'KEY=1\n', 'out/shot.png': 'png' });
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(repo, 'link')); fs.mkdirSync(path.join(repo, 'folder'));
  const status = git(repo, 'status', '--porcelain'), copy = path.join(root, 'copy');
  const made = createWorktree(identity, copy, 'built-on', ['api.js', 'lib/new.js', 'old.js', 'api.js', 'secret.env', 'out/shot.png', 'link', 'folder', '../outside.js', '.git/config', 'never.js', ':odd']);
  assert.deepEqual(made.brought, ['api.js', 'lib/new.js', 'old.js']);
  assert.equal(made.from, head); assert.equal(git(repo, 'rev-parse', `${made.base}^`).trim(), head, 'The copy starts from a commit of Codeshi’s own, on the folder’s last one.');
  assert.deepEqual([read(copy, 'api.js'), read(copy, 'lib/new.js'), read(copy, 'old.js')], ['one\nTWO merged\nthree\n', 'new\n', null], 'What that work changed, added and deleted is in the copy.');
  assert.deepEqual([read(copy, 'mine.js'), read(copy, 'draft.txt'), read(copy, 'secret.env'), read(copy, 'out/shot.png'), fs.existsSync(path.join(copy, 'link')), fs.existsSync(path.join(copy, 'folder'))], ['mine\n', null, null, null, false, false], 'Nothing else comes from the folder: not the person’s own changes, a file Git ignores or a link.');
  assert.equal(git(copy, 'status', '--porcelain'), '', 'It is a commit there, so the copy shows only what its own task changes.');
  assert.equal(git(repo, 'rev-parse', 'refs/codeshi/tasks/built-on/base').trim(), made.base);
  assert.deepEqual([git(repo, 'status', '--porcelain'), git(repo, 'rev-parse', 'HEAD').trim(), git(repo, 'branch', '--list').trim().split('\n').length], [status, head, 1], 'The folder, its index and its branches are left alone.');
  // The person is told how much the copy leaves out, without what it was given: a new folder is counted file by file.
  assert.equal(uncommittedCount(repo), 6, 'api.js, old.js, mine.js, draft.txt, lib/ and the link.');
  assert.equal(uncommittedCount(repo, made.brought), 3, 'mine.js, draft.txt and the link.');
  put(repo, { 'lib/own.js': 'the person’s\n' });
  assert.equal(uncommittedCount(repo, made.brought), 4, 'A file of the person’s own beside one the copy has still counts.');
  put(repo, { 'lib/own.js': null });
  // The task's work on top: merging it brings back only what the task itself changed, against the versions it began with.
  put(copy, { 'api.js': 'one\nTWO merged\nthree\nfour\n', 'lib/own.js': 'own\n' });
  git(copy, 'add', '-A'); git(copy, 'commit', '-qm', 'task');
  const plan = integrationPlan({ root: repo, base: made.base, result: git(copy, 'rev-parse', 'HEAD').trim() });
  assert.deepEqual(plan.files.map(file => [file.path, file.change, file.status]), [['api.js', 'update', 'clean'], ['lib/own.js', 'add', 'clean']]);
  assert.deepEqual([plan.files[0].added, plan.files[0].removed], [1, 0], 'The earlier card’s change isn’t shown as this task’s.');
  applyPlan(repo, plan);
  assert.deepEqual([read(repo, 'api.js'), read(repo, 'lib/own.js'), read(repo, 'mine.js')], ['one\nTWO merged\nthree\nfour\n', 'own\n', 'mine, edited\n']);
  // With nothing to bring, or only files that are as the last commit has them, a copy starts from that commit as before.
  const plain = createWorktree(identity, path.join(root, 'plain'), 'plain'), same = createWorktree(identity, path.join(root, 'same'), 'same', ['.gitignore', 'never.js']);
  assert.deepEqual([plain.base, plain.brought, same.base, same.brought], [head, [], head, []]);
});

test('a copy that is kept gets what the work before it merged since, and the task’s own changes stay', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-refresh-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { put, read } = files, repo = repository(path.join(root, 'repo'), { 'export.js': 'a\nb\nc\n', 'both.js': '1\n2\n3\n4\n5\n', 'clash.js': 'x\n', 'gone.js': 'g\n', 'calm.js': 'k\n' });
  const copy = path.join(root, 'copy'), made = createWorktree(folderIdentity(repo), copy, 'again');
  // What the task did in its copy: tests of its own, and a change to two files the repair will change too.
  put(copy, { 'both.js': 'ONE\n2\n3\n4\n5\n', 'clash.js': 'mine\n', 'own.test.js': 'test\n' });
  // What a repair merged into the folder since: a fix, a new file and a deletion, and its changes to those two files.
  put(repo, { 'export.js': 'a\nb\nC fixed\n', 'rows.js': 'rows\n', 'gone.js': null, 'both.js': '1\n2\n3\n4\nFIVE\n', 'clash.js': 'theirs\n' });
  const named = ['export.js', 'rows.js', 'gone.js', 'both.js', 'clash.js', 'calm.js'], status = git(repo, 'status', '--porcelain');
  const fresh = refreshWorktree({ root: repo, worktree: copy, id: 'again', base: made.base, files: named });
  assert.deepEqual(fresh.files, ['both.js', 'export.js', 'gone.js', 'rows.js']);
  assert.deepEqual([read(copy, 'export.js'), read(copy, 'rows.js'), read(copy, 'gone.js')], ['a\nb\nC fixed\n', 'rows\n', null], 'Files the task left alone are as the folder has them now.');
  assert.equal(read(copy, 'both.js'), 'ONE\n2\n3\n4\nFIVE\n', 'A file changed on both sides, in lines that don’t touch, has both changes.');
  assert.deepEqual([read(copy, 'clash.js'), read(copy, 'own.test.js'), read(copy, 'calm.js')], ['mine\n', 'test\n', 'k\n'], 'One changed in the same lines stays as the task has it, like the rest of its work.');
  assert.equal(git(repo, 'rev-parse', 'refs/codeshi/tasks/again/base').trim(), fresh.base);
  assert.deepEqual([git(repo, 'show', `${fresh.base}:export.js`), git(repo, 'show', `${fresh.base}:both.js`), git(repo, 'show', `${fresh.base}:clash.js`)], ['a\nb\nC fixed\n', '1\n2\n3\n4\nFIVE\n', 'x\n'], 'What it’s compared with holds the folder’s versions, except for the file left as it was.');
  assert.equal(git(repo, 'status', '--porcelain'), status, 'Only the copy is written.');
  // So merging the task still brings back only its own changes, and says where both sides changed the same lines.
  git(copy, 'add', '-A'); git(copy, 'commit', '-qm', 'task');
  const plan = integrationPlan({ root: repo, base: fresh.base, result: git(copy, 'rev-parse', 'HEAD').trim() });
  assert.deepEqual(plan.files.map(file => [file.path, file.status, file.kind || null]), [['both.js', 'clean', null], ['clash.js', 'conflict', 'lines'], ['own.test.js', 'clean', null]]);
  // Nothing new in the folder: nothing moves.
  assert.deepEqual(refreshWorktree({ root: repo, worktree: copy, id: 'again', base: fresh.base, files: named }), { base: fresh.base, files: [] });
});

test('a file that can’t be brought into a copy stays as the last commit has it, and the others still come', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-awkward-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { put, read } = files, repo = repository(path.join(root, 'repo'), { 'api.js': 'one\n', 'conf': 'c\n', 'lib/x.js': 'x\n' });
  // A repository inside this one, whose files are its own; a folder where the last commit has a file; and the other way round.
  fs.mkdirSync(path.join(repo, 'vendor')); git(path.join(repo, 'vendor'), 'init', '-q');
  fs.rmSync(path.join(repo, 'conf')); fs.rmSync(path.join(repo, 'lib'), { recursive: true });
  put(repo, { 'api.js': 'two\n', 'vendor/v.js': 'v\n', 'conf/app.json': '{}\n', 'lib': 'now a file\n' });
  const copy = path.join(root, 'copy'), made = createWorktree(folderIdentity(repo), copy, 'awkward', ['vendor/v.js', 'conf', 'conf/app.json', 'api.js', 'lib', 'lib/x.js']);
  assert.deepEqual(made.brought, ['api.js'], 'One path Git won’t take keeps only itself out.');
  assert.deepEqual([read(copy, 'api.js'), read(copy, 'conf'), read(copy, 'lib/x.js'), fs.existsSync(path.join(copy, 'vendor'))], ['two\n', 'c\n', 'x\n', false]);
});

test('a task that waits for another starts in a copy with what that one merged, also through a task in between, and is told so', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'api.js': 'one\n', 'other.js': 'o\n' }), b: repository(path.join(root, 'b')) }), { policy: { maxConcurrent: 5 } });
  const { read } = files, folder = env.folders.a, head = git(folder, 'rev-parse', 'HEAD').trim(), merge = async task => env.broker.tasks.integrate(env.c, task.id, { digest: env.broker.tasks.review(env.c, task.id).digest });
  const first = hold(env, 'a', 'Hold A'); await working(env, first);
  const second = env.start('a', 'Hold B', { dependsOn: first.id }), third = env.start('a', 'Hold C', { dependsOn: second.id }), elsewhere = env.start('b', 'Hold A', { dependsOn: first.id });
  edit(env, first, 'api.js', 'two\n'); edit(env, first, 'lib/new.js', 'new\n'); await finish(env, first);
  // The person's own work in the folder, which the copy leaves out as before.
  fs.writeFileSync(path.join(folder, 'other.js'), 'o, edited\n'); fs.writeFileSync(path.join(folder, 'draft.txt'), 'draft\n');
  await merge(first);
  assert.equal(git(folder, 'rev-parse', 'HEAD').trim(), head, 'Merging commits nothing.');
  // A merge of more files than are saved with their diffs keeps the names of the rest, which count as merged and stay off the page.
  env.broker.tasks.update(env.c, env.task(first.id), { integration: { ...env.task(first.id).integration, rest: ['lib/more.js'] } });
  assert.deepEqual(env.broker.tasks.mergedBefore(env.c, env.task(third.id), env.task(first.id).repoRoot).sort(), ['api.js', 'lib/more.js', 'lib/new.js']);
  assert.deepEqual(Object.keys(env.broker.tasks.public(env.task(first.id)).integration).sort(), ['at', 'changes', 'files']);
  await working(env, second);
  const copy = env.task(second.id).scopePath;
  assert.deepEqual([read(copy, 'api.js'), read(copy, 'lib/new.js'), read(copy, 'other.js'), read(copy, 'draft.txt')], ['two\n', 'new\n', 'o\n', null], 'It starts with what the first one merged, and without the person’s own changes.');
  assert.deepEqual([env.task(second.id).carried, env.task(second.id).uncommitted], [{ from: head, files: 2 }, 2]);
  assert.notEqual(env.task(second.id).base, head);
  assert.deepEqual(env.broker.tasks.list(env.c).find(task => task.id === second.id).carried.files, 2, 'The page can say what the copy has.');
  // Its agent is told the copy has that work, and how to list it, so it doesn't look for it in the folder it can't change.
  const scope = env.captured(copy)[0].context.taskScope;
  assert.ok(scope.includes(`made from that folder's last commit. The work this task builds on is merged into a but isn't in that commit, so this copy also has the 2 files it changed, as they are in a now (\`git diff --stat ${head.slice(0, 12)} ${env.task(second.id).base.slice(0, 12)}\` lists them). Paths in the request under`), scope);
  assert.equal(git(copy, 'diff', '--stat', head.slice(0, 12), env.task(second.id).base.slice(0, 12)).trim().split('\n').length, 3, 'That command lists the two files and their total.');
  // What it changes is still only its own, on top of the first one's.
  edit(env, second, 'api.js', 'two\nthree\n'); await finish(env, second);
  assert.deepEqual(env.broker.tasks.review(env.c, second.id).files.map(file => [file.path, file.change, file.status, file.added, file.removed]), [['api.js', 'update', 'clean', 1, 0]]);
  await merge(second);
  assert.equal(read(folder, 'api.js'), 'two\nthree\n');
  // A task two steps on has both: what the second changed and what the first added.
  await working(env, third);
  assert.deepEqual([read(env.task(third.id).scopePath, 'api.js'), read(env.task(third.id).scopePath, 'lib/new.js'), env.task(third.id).carried.files], ['two\nthree\n', 'new\n', 2]);
  // Another repository has none of it, and its copy starts from its own last commit as before.
  await working(env, elsewhere);
  assert.deepEqual([env.task(elsewhere.id).carried, env.task(elsewhere.id).base], [null, git(env.folders.b, 'rev-parse', 'HEAD').trim()]);
  assert.ok(env.captured(env.task(elsewhere.id).scopePath)[0].context.taskScope.includes("made from that folder's last commit. Paths in the request under"));
  for (const task of [third, elsewhere]) { env.release(env.task(task.id).scopePath); await finished(env, task); }
  // Once the person commits that work, the last commit has it, so nothing is brought.
  git(folder, 'add', '-A'); git(folder, 'commit', '-qm', 'the merged work');
  const later = env.start('a', 'Hold B', { dependsOn: second.id }); await working(env, later);
  assert.deepEqual([env.task(later.id).carried, env.task(later.id).base, read(env.task(later.id).scopePath, 'lib/new.js')], [null, git(folder, 'rev-parse', 'HEAD').trim(), 'new\n']);
  env.release(env.task(later.id).scopePath); await finished(env, later);
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
  env.release(env.task(a.id).scopePath); await finished(env, a);
  await working(env, c);
  assert.equal(env.lane(c.id).broker.budget.policy(env.lane(c.id).c).maxHandoffs, 1, 'And changes reach it when it starts.');
  env.release(env.task(b.id).scopePath); env.release(env.task(c.id).scopePath); await finished(env, b); await finished(env, c);
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
  assert.deepEqual(detached.broker.workspaces, [env.task(a.id).scopePath], 'Its lane keeps to its own copy, and nothing gets more access.');
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
  env.release(env.task(b.id).scopePath); await finished(env, b);
});

test('a task starts once for one request, keeps its access, and gets the workspace’s memory, skills and chosen history', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), {}, { commit: false }), b: repository(path.join(root, 'b')) }));
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
  env.release(env.task(first.id).scopePath); await finished(env, first);
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
  assert.equal((await call('/api/tasks/plan', { folderId: folder.id })).body.mode, 'worktree');
  const started = await call('/api/tasks', { text: 'Hold A', folderId: folder.id, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'server-one' });
  assert.equal(started.status, 202);
  const firstScope = () => main.tasks.find(home, started.body.id)?.scopePath;
  await until(() => firstScope() && fs.existsSync(path.join(firstScope(), '.mock-captures.jsonl')), 'the task to start');
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
  // Folders can't change while a task works there, though mutations in the workspace folder itself stay free.
  assert.throws(() => app.registry.removeFolder(project.id, other.id), /Stop the current run/);
  await app.registry.withMutation(project.id, 'patch', async () => {});
  // Stop reaches this task by its conversation, and only this task.
  const stopped = await call(`/api/conversations/${shown.body.id}/stop`, {});
  assert.equal(stopped.body.stopped, true);
  await until(() => !main.tasks.lanes.get(started.body.id).broker.running && main.tasks.find(home, started.body.id).status === 'stopped', 'it to stop');
  assert.equal((await call(`/api/conversations/${home.id}/stop`, {})).body.stopped, false, 'The main conversation had nothing to stop.');
  assert.equal((await call(`/api/conversations/not-a-conversation/stop`, {})).status, 404);
  assert.equal((await call('/api/tasks/plan', { folderId: 'missing' })).status, 400);
  assert.equal((await call(`/api/tasks/${started.body.id}/discard`, {})).body.task.status, 'discarded');
  assert.equal((await call(`/api/tasks/${started.body.id}/close`, {})).body.closed, true);
  assert.deepEqual((await call('/api/tasks')).body.tasks, []);
  // Without a task running, folders can change, and a task whose folder went stays, but can't run.
  const second = await call('/api/tasks', { text: 'Hold B', folderId: other.id, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'server-two' });
  const secondScope = () => main.tasks.find(home, second.body.id)?.scopePath;
  await until(() => secondScope() && fs.existsSync(path.join(secondScope(), '.mock-captures.jsonl')), 'the second task');
  fs.writeFileSync(path.join(secondScope(), '.release'), '');
  await until(() => !main.tasks.lanes.get(second.body.id)?.broker.running && main.tasks.find(home, second.body.id).status === 'complete', 'it to finish');
  app.registry.removeFolder(project.id, other.id);
  const after = app.registry.broker(project.id), now = after.get(app.registry.mainConversation(project.id).id);
  assert.equal(after.tasks.find(now, second.body.id).status, 'detached');
  assert.equal((await call(`/api/conversation?task=${second.body.id}`)).status, 200, 'Its history stays readable.');
});

test('integrating or keeping a task records its changed files and diffs on integration, and public() omits diffs', { skip: scriptCLIs }, async t => {
  const env = setup(t, root => ({ a: repository(path.join(root, 'a'), { 'existing.txt': 'hello\nworld\n' }) }), { policy: { maxConcurrent: 5 } });
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folders.a)).length, 'the main run');

  const first = hold(env, 'a', 'Hold A'), second = hold(env, 'a', 'Hold B');
  await working(env, first); await working(env, second);
  edit(env, first, 'existing.txt', 'hello\ncodeshi\n');
  edit(env, first, 'added.txt', 'brand new\nline two\n');
  edit(env, second, 'kept.txt', 'on branch\n');
  await finish(env, first); await finish(env, second);
  env.release(fs.realpathSync(env.folders.a)); await main.done;

  const review = env.broker.tasks.review(env.c, first.id);
  await env.broker.tasks.integrate(env.c, first.id, { digest: review.digest });
  const merged = env.task(first.id);
  assert.equal(merged.status, 'integrated');
  assert.equal(merged.integration.files, 2);
  assert.deepEqual(
    merged.integration.changes.map(({ path: p, change, added, removed, status }) => ({ path: p, change, added, removed, status })),
    [
      { path: 'added.txt', change: 'add', added: 2, removed: 0, status: 'clean' },
      { path: 'existing.txt', change: 'update', added: 1, removed: 1, status: 'clean' },
    ]
  );
  assert.match(merged.integration.changes[0].diff, /\+brand new/);
  assert.match(merged.integration.changes[1].diff, /-world/);
  const shown = env.broker.tasks.public(merged);
  assert.equal(shown.integration.changes.length, 2);
  assert.equal(shown.integration.changes[0].diff, undefined, 'SSE task state omits diffs.');

  const { branch } = env.broker.tasks.keep(env.c, second.id);
  const kept = env.task(second.id);
  assert.equal(kept.status, 'kept');
  assert.equal(kept.integration.branch, branch);
  assert.equal(kept.integration.files, 1);
  assert.equal(kept.integration.changes[0].path, 'kept.txt');
  assert.match(kept.integration.changes[0].diff, /\+on branch/);
  assert.equal(env.broker.tasks.public(kept).integration.changes[0].diff, undefined);
});

test('task files and diffs can be previewed from a live copy, merged folder or kept branch via routes and coordinator (#88)', { skip: scriptCLIs }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-task-files-')));
  const a = repository(path.join(root, 'a'), { 'docs/guide.md': '# Title\noriginal\n' });
  const cli = path.join(root, 'codex-mock.mjs');
  fs.writeFileSync(cli, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  const app = createRelayServer({ workspace: a, dataRoot: path.join(root, 'data'), bins: { codex: cli, claude: cli, gemini: path.join(root, 'missing') }, accessToken: 'fixture-token' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = app.registry.list()[0], main = app.registry.broker(project.id), home = main.get(app.registry.mainConversation(project.id).id);
  const call = async (route, input) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}${route.includes('?') ? '&' : '?'}projectId=${project.id}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'X-AI-Relay-Token': 'fixture-token', 'X-AI-Relay': '1', 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: await response.json() };
  };

  const t1 = (await call('/api/tasks', { text: 'Hold 1', folderId: project.folders[0].id, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'f-1' })).body;
  const t2 = (await call('/api/tasks', { text: 'Hold 2', folderId: project.folders[0].id, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'f-2' })).body;
  const scope = id => main.tasks.find(home, id)?.scopePath;
  await until(() => scope(t1.id) && fs.existsSync(path.join(scope(t1.id), '.mock-captures.jsonl')) && scope(t2.id) && fs.existsSync(path.join(scope(t2.id), '.mock-captures.jsonl')), 'both worktrees to start');

  fs.mkdirSync(path.join(scope(t1.id), 'docs'), { recursive: true });
  fs.writeFileSync(path.join(scope(t1.id), 'docs/guide.md'), '# Title\nupdated in copy\n');
  fs.writeFileSync(path.join(scope(t1.id), 'docs/new.md'), 'brand new doc\n');
  fs.writeFileSync(path.join(scope(t2.id), 'docs/branch.md'), 'only on branch\n');
  fs.writeFileSync(path.join(scope(t1.id), '.release'), '');
  fs.writeFileSync(path.join(scope(t2.id), '.release'), '');
  await until(() => !main.tasks.lanes.get(t1.id)?.broker.running && !main.tasks.lanes.get(t2.id)?.broker.running && main.tasks.find(home, t1.id).status === 'complete' && main.tasks.find(home, t2.id).status === 'complete', 'both tasks to finish');

  // While worktree exists, preview and diff read from the task copy even before merging (even without folderId).
  const copyPreview = await call(`/api/files/preview?path=docs%2Fnew.md&taskId=${t1.id}`);
  assert.equal(copyPreview.status, 200);
  assert.equal(copyPreview.body.text, 'brand new doc\n');
  assert.equal(copyPreview.body.inCopy, true);
  const copyDiff = await call(`/api/git/diff?path=docs%2Fguide.md&taskId=${t1.id}`);
  assert.equal(copyDiff.status, 200);
  assert.match(copyDiff.body.diff, /\+updated in copy/);

  // After integrating (worktree removed), preview reads the merged workspace file and diff returns the saved merge diff.
  const review = main.tasks.review(home, t1.id);
  await main.tasks.integrate(home, t1.id, { digest: review.digest });
  const mergedPreview = await call(`/api/files/preview?path=docs%2Fguide.md&taskId=${t1.id}`);
  assert.equal(mergedPreview.status, 200);
  assert.equal(mergedPreview.body.text, '# Title\nupdated in copy\n');
  const mergedDiff = await call(`/api/git/diff?path=docs%2Fnew.md&taskId=${t1.id}`);
  assert.equal(mergedDiff.status, 200);
  assert.match(mergedDiff.body.diff, /\+brand new doc/);

  // After keeping as a branch, preview reads the blob from the kept branch and diff returns its saved diff.
  const { branch } = main.tasks.keep(home, t2.id);
  const branchPreview = await call(`/api/files/preview?path=docs%2Fbranch.md&taskId=${t2.id}`);
  assert.equal(branchPreview.status, 200);
  assert.equal(branchPreview.body.text, 'only on branch\n');
  assert.equal(branchPreview.body.branch, branch);
  const branchDiff = await call(`/api/git/diff?path=docs%2Fbranch.md&taskId=${t2.id}`);
  assert.equal(branchDiff.status, 200);
  assert.match(branchDiff.body.diff, /\+only on branch/);
});

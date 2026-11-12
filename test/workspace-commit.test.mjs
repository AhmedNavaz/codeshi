import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commitChanges, committer, stageChanges, unstageChanges } from '../src/workspace-commit.mjs';
import { workspaceGit } from '../src/workspace-git.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';
import { createRelayServer } from '../src/server.mjs';
import { MutationCoordinator } from '../src/mutation-lock.mjs';
import { ProjectRegistry } from '../src/projects.mjs';
import { createWorkspaceRoutes } from '../src/workspace-routes.mjs';
import { noSymlinks, scriptCLIs } from './platform.mjs';

function git(cwd, ...args) { const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
// A repository with one commit, its own identity (so a machine without a global one still commits), and a change.
function repository(t, { commit = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-commit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Pat Example'); git(root, 'config', 'user.email', 'pat@example.com'); git(root, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'web')); fs.mkdirSync(path.join(root, 'api'));
  for (const file of ['web/app.js', 'web/old.js', 'api/server.js']) fs.writeFileSync(path.join(root, file), `// ${file}\n`);
  if (commit) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'Start'); }
  return { root, folder: { id: 'repo', name: 'repo', path: root }, web: { id: 'web', name: 'web', path: path.join(root, 'web') }, api: { id: 'api', name: 'api', path: path.join(root, 'api') } };
}
const staged = folder => workspaceGit([folder]).repositories[0].stagedPaths;
const hook = (root, name, script) => { const file = path.join(root, '.git', 'hooks', name); fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 }); };
const until = async check => { for (let i = 0; i < 1000; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Timed out waiting for the Git hook.'); };

test('files are staged and unstaged one at a time or all together, including new folders, deletions and renames', async t => {
  const { root, folder } = repository(t);
  fs.writeFileSync(path.join(root, 'web/app.js'), 'changed\n');
  fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Guide\n');
  fs.rmSync(path.join(root, 'api/server.js'));
  git(root, 'mv', 'web/old.js', 'web/renamed.js'); git(root, 'restore', '--staged', '--', 'web/old.js', 'web/renamed.js');
  await stageChanges(folder, { paths: ['web/app.js', 'docs/'] });
  assert.deepEqual(staged(folder).sort(), ['docs/guide.md', 'web/app.js']);
  await stageChanges(folder, { paths: ['api/server.js'] });
  assert(staged(folder).includes('api/server.js'), 'A deletion is staged.');
  await stageChanges(folder, { all: true });
  assert.deepEqual(staged(folder).sort(), ['api/server.js', 'docs/guide.md', 'web/app.js', 'web/old.js', 'web/renamed.js'], 'Stage all includes the rename’s two paths.');
  await unstageChanges(folder, { paths: ['web/renamed.js'] });
  assert(!staged(folder).some(file => file.startsWith('web/old.js') || file === 'web/renamed.js'), 'Unstaging a rename unstages both of its paths.');
  await unstageChanges(folder, { all: true });
  assert.deepEqual(staged(folder), []);
  await assert.rejects(stageChanges(folder, { paths: ['web/untouched.js'] }), /has no current changes/);
  await assert.rejects(stageChanges(folder, { paths: ['../outside'] }), /has no current changes/);
  await assert.rejects(stageChanges(folder, { paths: [] }), /Choose the changed files/);
});

test('a commit holds exactly what the panel showed as staged, with the person’s own identity, and is never pushed', async t => {
  const { root, folder } = repository(t);
  git(root, 'remote', 'add', 'origin', path.join(root, 'nowhere.git'));
  fs.writeFileSync(path.join(root, 'web/app.js'), 'changed\n'); fs.writeFileSync(path.join(root, 'api/server.js'), 'changed too\n');
  await stageChanges(folder, { paths: ['web/app.js'] });
  const shown = staged(folder);
  await assert.rejects(commitChanges(folder, { message: '   ', expected: shown }), /Write a commit message/);
  await stageChanges(folder, { paths: ['api/server.js'] });
  await assert.rejects(commitChanges(folder, { message: 'Update the app', expected: shown }), error => error.status === 409 && error.details.code === 'changed', 'Something staged after the panel was read is not committed silently.');
  assert.equal(git(root, 'rev-list', '--count', 'HEAD').trim(), '1');
  const { commit } = await commitChanges(folder, { message: 'Update the app\n\nAnd the server.', expected: staged(folder) });
  assert.deepEqual([commit.subject, commit.branch, commit.files, commit.shortHash.length >= 7], ['Update the app', 'main', 2, true]);
  assert.equal(git(root, 'log', '-1', '--format=%an <%ae>%n%B').trim(), 'Pat Example <pat@example.com>\nUpdate the app\n\nAnd the server.');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'for-each-ref', 'refs/remotes').trim(), '', 'Nothing is pushed.');
  await assert.rejects(commitChanges(folder, { message: 'Again', expected: [] }), /Stage the changes to commit first/);
  assert.deepEqual(await committer(folder), { name: 'Pat Example', email: 'pat@example.com' });
});

test('a workspace folder inside a larger repository stages only its own files and refuses to commit files staged elsewhere', async t => {
  const { root, web, api } = repository(t);
  fs.writeFileSync(path.join(root, 'web/app.js'), 'web change\n'); fs.writeFileSync(path.join(root, 'api/server.js'), 'api change\n');
  await stageChanges(web, { all: true });
  assert.deepEqual(git(root, 'diff', '--cached', '--name-only').trim(), 'web/app.js', 'Stage all stays inside the folder.');
  await assert.rejects(stageChanges(web, { paths: ['api/server.js'] }), /has no current changes/);
  await stageChanges(api, { paths: ['api/server.js'] });
  await assert.rejects(commitChanges(web, { message: 'Web only', expected: ['web/app.js'] }), error => error.details.code === 'outside' && /api\/server\.js/.test(error.message));
  await unstageChanges(api, { all: true });
  assert.equal((await commitChanges(web, { message: 'Web only', expected: ['web/app.js'] })).commit.files, 1);
});

test('the project’s commit hooks run; a hook that stops the commit is reported with its output, and committing without hooks is a separate choice', async t => {
  const { root, folder } = repository(t);
  hook(root, 'commit-msg', `echo checked >> "${path.join(root, 'hook-ran')}"`);
  fs.writeFileSync(path.join(root, 'web/app.js'), 'one\n');
  await stageChanges(folder, { all: true });
  await commitChanges(folder, { message: 'With hooks', expected: staged(folder) });
  assert.equal(fs.readFileSync(path.join(root, 'hook-ran'), 'utf8'), 'checked\n', 'The person’s own hook ran, as in their terminal.');
  hook(root, 'pre-commit', 'echo "lint: 2 problems in web/app.js" >&2; exit 1');
  fs.writeFileSync(path.join(root, 'web/app.js'), 'two\n');
  await stageChanges(folder, { all: true });
  await assert.rejects(commitChanges(folder, { message: 'Blocked', expected: staged(folder) }), error => error.details.code === 'hook' && error.details.hooks === true && /lint: 2 problems/.test(error.details.output));
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), 'With hooks');
  const { commit } = await commitChanges(folder, { message: 'Without hooks', expected: staged(folder), skipHooks: true });
  assert.equal(commit.hooks, false);
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), 'Without hooks');
});

test('the first commit of a new repository works, and a missing Git identity is explained', async t => {
  const { root, folder } = repository(t, { commit: false });
  await stageChanges(folder, { paths: ['web/'] });
  assert.deepEqual(staged(folder).sort(), ['web/app.js', 'web/old.js'], 'A new folder is staged with its files.');
  await unstageChanges(folder, { paths: ['web/app.js'] });
  assert.deepEqual(staged(folder), ['web/old.js'], 'Before the first commit, unstaging takes the file out of the index.');
  await stageChanges(folder, { all: true });
  assert.equal((await commitChanges(folder, { message: 'First', expected: staged(folder) })).commit.subject, 'First');
  const global = path.join(root, 'empty-global-config'); fs.writeFileSync(global, '');
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = global; process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => { for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.system]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  git(root, 'config', '--unset', 'user.name'); git(root, 'config', '--unset', 'user.email'); git(root, 'config', 'user.useConfigOnly', 'true');
  fs.writeFileSync(path.join(root, 'web/app.js'), 'again\n');
  await stageChanges(folder, { all: true });
  await assert.rejects(commitChanges(folder, { message: 'Who', expected: staged(folder) }), error => error.details?.code === 'identity' && /git config --global user\.name/.test(error.message));
  assert.deepEqual(await committer(folder), { name: null, email: null });
});

test('the Git routes stage and commit only on POST, and answer with refreshed Git activity', async t => {
  const { root } = repository(t);
  const relay = createRelayServer({ workspace: root, dataDir: path.join(root, '.relay-data'), lock: false });
  t.after(() => relay.close({ force: true }));
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`, [project] = relay.registry.list(), folderId = project.folders[0].id;
  const call = async (pathname, body) => { const response = await fetch(`${base}${pathname}?projectId=${project.id}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(body) } : {}); return { status: response.status, data: await response.json() }; };
  fs.writeFileSync(path.join(root, 'web/app.js'), 'changed\n');
  const read = await call('/api/git');
  assert.deepEqual(read.data.repositories[0].committer, { name: 'Pat Example', email: 'pat@example.com' });
  assert.equal((await call('/api/git/stage')).status, 405);
  const stagedNow = await call('/api/git/stage', { folderId, paths: ['web/app.js'] });
  assert.deepEqual(stagedNow.data.git.repositories[0].stagedPaths, ['web/app.js']);
  const refused = await call('/api/git/commit', { folderId, message: 'Route', expected: [] });
  assert.equal(refused.status, 409); assert.equal(refused.data.details.code, 'changed');
  const committed = await call('/api/git/commit', { folderId, message: 'Route', expected: ['web/app.js'] });
  assert.equal(committed.data.commit.subject, 'Route');
  assert.equal(committed.data.git.repositories[0].totalChanges, 1, 'Only the relay’s own data folder is left.');
  const timeline = await call('/api/checkpoints');
  assert.deepEqual(timeline.data.entries.filter(entry => entry.kind === 'commit').map(entry => [entry.subject, entry.by || null])[0], ['Route', 'panel'], 'Timeline says the commit came from the Git panel.');
});

test('Git mutations share leases with sibling-folder work and preserve the index on refusal or failure', async t => {
  const { root, folder, web, api } = repository(t), mutations = new MutationCoordinator();
  fs.writeFileSync(path.join(root, 'web/app.js'), 'web change\n'); fs.writeFileSync(path.join(root, 'api/server.js'), 'unrelated change\n');
  await stageChanges(web, { all: true });
  const original = fs.readFileSync(path.join(root, '.git', 'index')), head = git(root, 'rev-parse', 'HEAD');
  for (const operation of ['provider:codex', 'patch', 'undo', 'merging a task', 'conversation import']) {
    const lease = mutations.acquire(api.path, operation);
    try {
      for (const attempt of [() => stageChanges(web, { all: true }), () => unstageChanges(web, { all: true }), () => commitChanges(web, { message: 'Web', expected: ['web/app.js'] })]) await assert.rejects(attempt(), error => error.status === 409 && /busy/.test(error.message));
      assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), original, operation);
      assert.equal(git(root, 'rev-parse', 'HEAD'), head);
      assert.equal(fs.readFileSync(path.join(root, 'api/server.js'), 'utf8'), 'unrelated change\n');
    } finally { lease.release(); }
  }
  await unstageChanges(web, { all: true });
  assert.deepEqual(staged(folder), []);
  await assert.rejects(commitChanges(web, { message: '', expected: [] }), /Write a commit message/);
  mutations.acquire(root, 'after validation failure').release();
  hook(root, 'pre-commit', 'echo failed >&2; exit 1');
  await stageChanges(web, { all: true });
  await assert.rejects(commitChanges(web, { message: 'Blocked', expected: ['web/app.js'] }), /hook stopped/);
  mutations.acquire(root, 'after failed hook').release();
});

test('canonical repository leases cover symlink aliases without blocking a separate worktree or repository', { skip: noSymlinks }, async t => {
  const { root, web } = repository(t), apart = repository(t), mutations = new MutationCoordinator();
  const link = path.join(apart.root, 'linked-web'); fs.symlinkSync(web.path, link);
  const copy = path.join(apart.root, 'copy'); git(root, 'worktree', 'add', '--detach', '-q', copy);
  t.after(() => { if (fs.existsSync(root) && fs.existsSync(copy)) git(root, 'worktree', 'remove', '--force', copy); });
  fs.writeFileSync(path.join(root, 'web/app.js'), 'main change\n');
  fs.writeFileSync(path.join(copy, 'web/app.js'), 'copy change\n');
  fs.writeFileSync(path.join(apart.root, 'web/app.js'), 'separate change\n');
  const lease = mutations.acquire(path.join(root, 'api'), 'sibling task');
  try {
    await assert.rejects(stageChanges({ ...web, path: link }, { all: true }), /busy/);
    await stageChanges({ ...web, path: path.join(copy, 'web') }, { all: true });
    await stageChanges(apart.web, { all: true });
    assert.deepEqual(staged(web), []);
    assert.equal(git(copy, 'diff', '--cached', '--name-only').trim(), 'web/app.js');
    assert.deepEqual(staged(apart.web), ['web/app.js']);
  } finally { lease.release(); }
});

test('a Git commit holds the shared repository lease across asynchronous hooks, also for another process', async t => {
  const { root, web, api } = repository(t), apart = repository(t), mutations = new MutationCoordinator();
  const entered = path.join(apart.root, 'entered'), release = path.join(apart.root, 'release');
  hook(root, 'pre-commit', `echo ready > "${entered}"\nwhile [ ! -f "${release}" ]; do sleep 0.05; done`);
  fs.writeFileSync(path.join(root, 'web/app.js'), 'changed\n'); await stageChanges(web, { all: true });
  const committing = commitChanges(web, { message: 'After the hook', expected: ['web/app.js'] });
  try {
    await until(() => fs.existsSync(entered));
    assert.throws(() => mutations.acquire(api.path, 'provider:codex'), /Git commit/);
    // A separate Node process uses the same durable lease directory, not the in-memory Git-action guard.
    const module = new URL('../src/mutation-lock.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {MutationCoordinator} from ${JSON.stringify(module)};try{new MutationCoordinator().acquire(${JSON.stringify(api.path)},'patch').release();process.exitCode=1;}catch(error){if(error.status!==409||!error.message.includes('Git commit'))throw error;}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0);
    fs.writeFileSync(path.join(apart.root, 'web/app.js'), 'apart\n'); await stageChanges(apart.web, { all: true });
  } finally { fs.writeFileSync(release, ''); await committing; }
  mutations.acquire(api.path, 'after commit').release();
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), 'After the hook');
});

for (const timing of ['upload', 'lookup']) test(`Git routes reject a folder detached during ${timing}`, async t => {
  const { root, web, api } = repository(t), dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-git-routes-'));
  const registry = new ProjectRegistry({ dataRoot, lock: false });
  t.after(async () => { await registry.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const project = registry.add({ folders: [web.path, api.path] }), folderId = project.folders[0].id;
  fs.writeFileSync(path.join(web.path, 'app.js'), 'new\n');
  const detach = () => registry.removeFolder(project.id, folderId);
  if (timing === 'lookup') {
    const original = registry.withMutation.bind(registry);
    registry.withMutation = (...args) => { detach(); return original(...args); };
  }
  const route = createWorkspaceRoutes({ registry, body: async () => { if (timing === 'upload') detach(); return { folderId, all: true }; }, json: () => assert.fail('A detached folder cannot be staged') });
  await assert.rejects(route({ req: { method: 'POST' }, res: {}, url: new URL(`http://localhost/api/git/stage?projectId=${project.id}`) }), error => error.status === 404);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  assert.equal(registry.activeMutations.size, 0);
  registry.mutations.acquire(root, 'after refused route').release();
});

test('Git routes lock the repository of the chosen folder and leave independent repositories available', async t => {
  const one = repository(t), two = repository(t), dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-git-route-leases-'));
  const registry = new ProjectRegistry({ dataRoot, lock: false });
  t.after(async () => { await registry.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const project = registry.add({ folders: [one.web.path, two.web.path] });
  fs.writeFileSync(path.join(one.web.path, 'app.js'), 'one\n'); fs.writeFileSync(path.join(two.web.path, 'app.js'), 'two\n');
  await stageChanges(one.web, { all: true });
  const route = createWorkspaceRoutes({ registry, body: async req => req.input, json: () => {} });
  const call = (action, input) => route({ req: { method: 'POST', input }, res: {}, url: new URL(`http://localhost/api/git/${action}?projectId=${project.id}`) });
  const lease = registry.mutations.acquire(one.api.path, 'running sibling task');
  try {
    for (const action of ['stage', 'unstage', 'commit']) await assert.rejects(call(action, { folderId: project.folders[0].id, all: true, message: 'Blocked', expected: ['web/app.js'] }), error => error.status === 409 && /busy/.test(error.message));
    await call('stage', { folderId: project.folders[1].id, all: true });
    assert.deepEqual(staged(one.web), ['web/app.js']); assert.deepEqual(staged(two.web), ['web/app.js']);
    assert.equal(git(one.root, 'log', '-1', '--format=%s').trim(), 'Start');
  } finally { lease.release(); }
  assert.equal(registry.activeMutations.size, 0);
  await call('commit', { folderId: project.folders[0].id, message: 'After sibling stops', expected: ['web/app.js'] });
  assert.equal(git(one.root, 'log', '-1', '--format=%s').trim(), 'After sibling stops');
});

test('shutdown waits for a Git hook and releases its lease only when the action settles', async t => {
  const { root, web } = repository(t), dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-git-close-'));
  const registry = new ProjectRegistry({ dataRoot, lock: false });
  t.after(async () => { await registry.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const project = registry.add({ path: web.path });
  const entered = path.join(dataRoot, 'entered'), release = path.join(dataRoot, 'release');
  hook(root, 'pre-commit', `echo ready > "${entered}"\nwhile [ ! -f "${release}" ]; do sleep 0.05; done`);
  fs.writeFileSync(path.join(web.path, 'app.js'), 'changed\n'); await stageChanges(web, { all: true });
  const route = createWorkspaceRoutes({ registry, body: async () => ({ folderId: project.folders[0].id, message: 'Wait for hook', expected: ['web/app.js'] }), json: () => {} });
  const committing = route({ req: { method: 'POST' }, res: {}, url: new URL(`http://localhost/api/git/commit?projectId=${project.id}`) });
  let closing, closed = false;
  try {
    await until(() => fs.existsSync(entered));
    assert.equal(registry.activeMutations.size, 1);
    closing = registry.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    assert.throws(() => registry.mutations.acquire(web.path, 'undo'), /Git commit/);
  } finally { fs.writeFileSync(release, ''); await committing; await closing; }
  assert.equal(closed, true); assert.equal(registry.activeMutations.size, 0);
  registry.mutations.acquire(web.path, 'after shutdown').release();
});

test('a task waiting on a Git commit starts after the hook releases its lease', { skip: scriptCLIs }, async t => {
  const { root, web } = repository(t), dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-git-wait-'));
  const bin = path.join(dataRoot, 'codex.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('fixture 1');process.exit(0);}for await(const part of process.stdin){}console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Done'}}));console.log(JSON.stringify({type:'turn.completed'}));\n`, { mode: 0o700 });
  const registry = new ProjectRegistry({ dataRoot, lock: false, bins: { codex: bin, claude: path.join(dataRoot, 'none'), gemini: path.join(dataRoot, 'none') } });
  t.after(async () => { await registry.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const project = registry.add({ path: web.path }), broker = registry.broker(project.id), c = broker.get(registry.mainConversation(project.id).id);
  const entered = path.join(dataRoot, 'entered'), release = path.join(dataRoot, 'release');
  hook(root, 'pre-commit', `echo ready > "${entered}"\nwhile [ ! -f "${release}" ]; do sleep 0.05; done`);
  fs.writeFileSync(path.join(web.path, 'app.js'), 'changed\n'); await stageChanges(web, { all: true });
  const route = createWorkspaceRoutes({ registry, body: async () => ({ folderId: project.folders[0].id, message: 'Before task', expected: ['web/app.js'] }), json: () => {} });
  const committing = route({ req: { method: 'POST' }, res: {}, url: new URL(`http://localhost/api/git/commit?projectId=${project.id}`) });
  let task;
  try {
    await until(() => fs.existsSync(entered));
    task = broker.tasks.start(c, { folderId: project.folders[0].id, text: 'After commit', provider: 'codex', requestId: 'after-commit' });
    assert.equal(broker.tasks.find(c, task.id).status, 'waiting');
    assert.match(broker.tasks.find(c, task.id).reason, /Git commit/);
  } finally { fs.writeFileSync(release, ''); await committing; }
  await until(() => broker.tasks.find(c, task.id).status === 'complete');
  assert.equal(broker.tasks.view(c, task.id).messages.at(-1).text, 'Done');
});

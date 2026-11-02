import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commitChanges, committer, stageChanges, unstageChanges } from '../src/workspace-commit.mjs';
import { workspaceGit } from '../src/workspace-git.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';
import { createRelayServer } from '../src/server.mjs';

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
});

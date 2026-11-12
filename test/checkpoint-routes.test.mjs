import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { ProjectRegistry } from '../src/projects.mjs';
import { createCheckpointRoutes } from '../src/checkpoint-routes.mjs';

test('checkpoint routes list history, enforce the workspace lease and restore only after preview confirmation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-timeline-routes-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'before\n');
  const registry = new ProjectRegistry({ dataRoot: path.join(root, 'data'), lock: false });
  t.after(async () => { await registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = registry.add({ path: workspace }), broker = registry.broker(project.id), c = broker.get(registry.mainConversation(project.id).id);
  const run = { id: randomUUID(), provider: 'codex' };
  broker.record(c, { type: 'run_start', ...run, message: { text: 'Change the file' } });
  await broker.checkpoints.before(c, run);
  for (const folder of c.snapshots[run.id].before.folders) assert.ok(folder.commit, `Checkpoint not saved: ${folder.error}`);
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'after\n');
  broker.record(c, { type: 'run_end', status: 'complete' });
  broker.checkpoints.after(c, run); await broker.checkpoints.idle();
  let result;
  const route = createCheckpointRoutes({ registry, body: async req => req.input, json: (_res, status, value) => { result = { status, value }; } });
  const call = async (pathname, method = 'GET', input = {}, suffix = '') => { result = null; await route({ req: { method, input }, res: {}, url: new URL(`http://localhost${pathname}?projectId=${project.id}${suffix}`) }); return result; };
  const history = await call('/api/checkpoints');
  assert.equal(history.status, 200);
  assert.equal(history.value.entries[0].provider, 'codex');
  const target = history.value.entries[0].checkpoints[0].target;
  const preview = await call('/api/checkpoints/preview', 'POST', { target });
  assert.equal(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf8'), 'after\n');
  const lease = registry.mutations.acquireMany([workspace], 'parallel test task');
  try { await assert.rejects(call('/api/checkpoints/apply', 'POST', { target, digest: preview.value.digest }), error => error.status === 409); }
  finally { lease.release(); }
  await assert.rejects(call('/api/checkpoints/apply', 'POST', { target, digest: 'stale' }), /Review the changes again/);
  await assert.rejects(call('/api/checkpoints/apply', 'POST', { target, digest: preview.value.digest, conversation: { count: 'all' } }), /Review the conversation rewind again/);
  assert.equal(preview.value.conversation.available, false, 'Nothing was said after this checkpoint, so there is nothing to rewind.');
  await assert.rejects(call('/api/checkpoints', 'GET', {}, '&task=parallel'), /main workspace conversation/);
  await assert.rejects(call('/api/checkpoints', 'POST'), error => error.status === 405);
  assert.equal((await call('/api/checkpoints/apply', 'POST', { target, digest: preview.value.digest })).status, 200);
  assert.equal(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf8'), 'before\n');
  assert.equal((await call('/api/checkpoints')).value.entries[0].kind, 'restore');
});

test('Timeline lists each folder’s commits by who made them, and shows a commit read only', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-timeline-commits-'))), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const git = (...args) => execFileSync('git', ['-c', 'user.email=sam@example.com', '-c', 'user.name=Sam', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, encoding: 'utf8', env: { ...process.env, ...git.env } });
  const write = (name, text) => fs.writeFileSync(path.join(workspace, name), text);
  write('file.txt', 'one\n'); git('init', '-q', '-b', 'main'); git('add', '-A');
  git.env = { GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' }; git('commit', '-q', '-m', 'Start'); git.env = {};
  const registry = new ProjectRegistry({ dataRoot: path.join(root, 'data'), lock: false });
  t.after(async () => { await registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = registry.add({ path: workspace }), broker = registry.broker(project.id), c = broker.get(registry.mainConversation(project.id).id), folderId = project.folders[0].id;
  let result;
  const route = createCheckpointRoutes({ registry, body: async req => req.input, json: (_res, status, value) => { result = { status, value }; } });
  const call = async (pathname, suffix = '') => { result = null; await route({ req: { method: 'GET', input: {} }, res: {}, url: new URL(`http://localhost${pathname}?projectId=${project.id}${suffix}`) }); return result.value; };

  const first = await call('/api/checkpoints');
  assert.deepEqual(first.entries.map(entry => [entry.kind, entry.subject, entry.author, entry.by]), [['commit', 'Start', 'Sam', undefined]], 'With no checkpoints yet, the latest commits show.');

  const run = { id: randomUUID(), provider: 'codex' };
  broker.record(c, { type: 'run_start', ...run, message: { text: 'Rename and commit' } });
  await broker.checkpoints.before(c, run);
  git('mv', 'file.txt', 'renamed.txt'); write('picture.bin', Buffer.from([0, 1, 2, 0])); write('added.txt', 'new line\n');
  git('add', '-A'); git('commit', '-q', '-m', 'Agent work', '-m', 'Why it changed.');
  broker.record(c, { type: 'run_end', status: 'complete' });
  broker.checkpoints.after(c, run); await broker.checkpoints.idle();
  write('added.txt', 'new line\nfrom the panel\n'); git('commit', '-q', '-am', 'Panel commit');
  broker.record(c, { type: 'git_commit', folderId, hash: git('rev-parse', 'HEAD').trim() });

  const head = git('rev-parse', 'HEAD').trim(), status = git('status', '--porcelain');
  const listed = await call('/api/checkpoints');
  const commits = listed.entries.filter(entry => entry.kind === 'commit');
  assert.deepEqual(commits.map(entry => [entry.subject, entry.by || null]), [['Panel commit', 'panel'], ['Agent work', 'run']], 'Commits from before the oldest checkpoint are left out.');
  assert.equal(commits[1].provider, 'codex');
  assert.ok(listed.entries.some(entry => entry.kind === 'run'), 'Checkpoints stay in the list.');

  const agent = await call('/api/checkpoints/commit', `&folderId=${folderId}&hash=${commits[1].hash}`);
  assert.deepEqual([agent.subject, agent.body, agent.totalFiles, agent.merge], ['Agent work', 'Why it changed.', 3, false]);
  const byPath = Object.fromEntries(agent.files.map(file => [file.path, file]));
  assert.deepEqual([byPath['renamed.txt'].status, byPath['renamed.txt'].originalPath], ['renamed', 'file.txt']);
  assert.equal(byPath['picture.bin'].binary, true);
  assert.match(byPath['added.txt'].diff, /^@@ .*\n\+new line$/);

  git('switch', '-q', '-c', 'side'); write('side.txt', 'side\n'); git('add', '-A'); git('commit', '-q', '-m', 'Side');
  git('switch', '-q', 'main'); git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  const merge = await call('/api/checkpoints/commit', `&folderId=${folderId}&hash=${git('rev-parse', 'HEAD').trim()}`);
  assert.deepEqual([merge.merge, merge.files.map(file => file.path)], [true, ['side.txt']], 'A merge shows what it brought into the branch.');
  const root1 = await call('/api/checkpoints/commit', `&folderId=${folderId}&hash=${git('rev-list', '--max-parents=0', 'HEAD').trim()}`);
  assert.deepEqual(root1.files.map(file => [file.path, file.status]), [['file.txt', 'added']], 'The first commit shows its files as added.');

  await assert.rejects(call('/api/checkpoints/commit', `&folderId=${folderId}&hash=HEAD;rm`), error => error.status === 400);
  await assert.rejects(call('/api/checkpoints/commit', `&folderId=${folderId}&hash=${'f'.repeat(40)}`), error => error.status === 404);
  await assert.rejects(call('/api/checkpoints/commit', `&folderId=elsewhere&hash=${head}`), error => error.status === 404);
  git('reset', '-q', '--hard', head);
  assert.deepEqual([git('rev-parse', 'HEAD').trim(), git('status', '--porcelain')], [head, status], 'Reading commits changes nothing in Git.');
});

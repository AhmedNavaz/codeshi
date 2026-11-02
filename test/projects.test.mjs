import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs, noSymlinks } from './platform.mjs';
import { ProjectRegistry } from '../src/projects.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));

function setup(t, scenarios = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-relay-projects-test-'));
  const dataRoot = path.join(root, 'private-data');
  const workspaces = ['first project', 'second project'].map(name => {
    const workspace = path.join(root, name);
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify(scenarios));
    return workspace;
  });
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, `${provider}-mock.mjs`);
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  }
  const registries = [];
  const open = (options = {}) => {
    const registry = new ProjectRegistry({ dataRoot, bins, ...options });
    registries.push(registry);
    return registry;
  };
  t.after(async () => {
    await Promise.all(registries.map(registry => registry.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataRoot, workspaces, open };
}

async function untilUpdate(registry, predicate) {
  if (predicate()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for mock provider output.')); }, 5000);
    const check = () => { if (predicate()) { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(timer); registry.off('update', check); };
    registry.on('update', check);
    check();
  });
}

test('projects persist with stable realpath IDs and deduplicate symlinks without losing names', { skip: noSymlinks }, async t => {
  const env = setup(t);
  const registry = env.open();
  const workspace = fs.realpathSync(env.workspaces[0]);
  const id = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  const project = registry.add({ path: workspace, name: 'Shop Admin' });

  assert.equal(project.id, id);
  assert.equal(project.name, 'Shop Admin');
  assert.equal(project.path, workspace);
  assert.ok(Number.isFinite(Date.parse(project.createdAt)));
  assert.equal(project.available, true);
  assert.equal(project.runningConversationId, null);
  assert.equal(project.conversationCount, 0);
  assert.equal(project.folders.length, 1);
  assert.equal(project.folders[0].path, workspace);
  assert.equal(project.conversationId, null);

  const alias = path.join(env.root, 'workspace alias');
  fs.symlinkSync(workspace, alias, 'dir');
  assert.deepEqual(registry.add({ path: alias }), project);
  const renamed = registry.add({ path: alias, name: 'Admin dashboard' });
  assert.equal(renamed.name, 'Admin dashboard');
  assert.equal(renamed.id, id);
  assert.equal(renamed.createdAt, project.createdAt);
  assert.equal(registry.list().length, 1);

  const saved = JSON.parse(fs.readFileSync(path.join(env.dataRoot, 'projects.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.projects[0].id, id);
  assert.equal(saved.projects[0].name, 'Admin dashboard');
  assert.equal(saved.projects[0].folders[0].path, workspace);
  await registry.close();
  const reopened = env.open();
  assert.deepEqual(reopened.get(id), renamed);
  assert.deepEqual(reopened.list(), [renamed]);
});

test('a folder typed in another letter case is the same workspace folder', t => {
  const env = setup(t);
  const registry = env.open();
  const workspace = fs.realpathSync(env.workspaces[0]);
  const typed = path.join(path.dirname(workspace), path.basename(workspace).toUpperCase());
  if (!fs.existsSync(typed)) return t.skip('This file system distinguishes letter case.');
  const project = registry.add({ path: workspace });
  assert.equal(registry.add({ path: typed }).id, project.id);
  assert.equal(registry.list().length, 1);
  assert.deepEqual(registry.addFolder(project.id, typed).folders.map(folder => folder.path), [workspace]);
  fs.mkdirSync(path.join(workspace, 'Backend'));
  assert.equal(registry.add({ path: path.join(typed, 'backend') }).path, path.join(workspace, 'Backend'), 'A new folder is saved with its name as it is on disk.');
});

test('a workspace saved with a folder typed in another letter case keeps its identity and history', async t => {
  const env = setup(t);
  const workspace = fs.realpathSync(env.workspaces[0]);
  const saved = path.join(path.dirname(workspace), path.basename(workspace).toUpperCase());
  if (!fs.existsSync(saved)) return t.skip('This file system distinguishes letter case.');
  // Earlier versions saved a folder as it was typed, with IDs derived from that path.
  const id = createHash('sha256').update(saved).digest('hex').slice(0, 16);
  fs.mkdirSync(env.dataRoot, { recursive: true });
  fs.writeFileSync(path.join(env.dataRoot, 'projects.json'), JSON.stringify({ version: 2, projects: [{ id, name: 'saved', path: saved, folders: [{ id, name: 'saved', displayName: 'saved', path: saved }], folderAliases: { [id]: 'saved' }, conversationId: null, createdAt: '2026-10-01T09:00:00.000Z' }] }));
  let registry = env.open();
  const conversation = registry.mainConversation(id), broker = registry.broker(id);
  broker.message(broker.get(conversation.id), 'user', 'Saved before the upgrade', 'codex');
  await registry.close();

  registry = env.open();
  for (const folder of [saved, workspace, path.join(path.dirname(workspace), 'First Project')]) {
    assert.equal(registry.add({ path: folder }).id, id, `${path.basename(folder)} is the saved workspace.`);
    assert.deepEqual(registry.addFolder(id, folder).folders.map(item => [item.id, item.path]), [[id, saved]], 'The saved folder keeps its ID and path.');
  }
  assert.equal(registry.list().length, 1);
  assert.deepEqual(registry.broker(id).get(registry.mainConversation(id).id).messages.map(m => m.text), ['Saved before the upgrade']);
});

test('registration validates folders and expands a leading home shortcut', t => {
  const env = setup(t);
  const registry = env.open();
  const file = path.join(env.root, 'file.txt');
  fs.writeFileSync(file, 'Not a directory.');
  for (const invalid of ['', 'relative/project', '~someone/project', file, path.join(env.root, 'missing')]) {
    assert.throws(() => registry.add({ path: invalid }), { status: 400 });
  }
  const home = registry.add({ path: '~/' });
  assert.equal(home.path, fs.realpathSync(os.homedir()));
  assert.equal(home.available, true);
  assert.throws(() => registry.get('unknown-project'), { status: 404 });
  assert.throws(() => registry.broker('unknown-project'), { status: 404 });
});

test('conversation histories open lazily, remain isolated, and report saved counts', async t => {
  const env = setup(t);
  const registry = env.open();
  const first = registry.add({ path: env.workspaces[0] });
  const second = registry.add({ path: env.workspaces[1] });
  assert.equal(first.name, path.basename(env.workspaces[0]));
  assert.equal(fs.existsSync(path.join(env.dataRoot, first.id)), false);
  assert.equal(fs.existsSync(path.join(env.dataRoot, second.id)), false);

  const firstBroker = registry.broker(first.id);
  assert.equal(registry.broker(first.id), firstBroker);
  assert.equal(firstBroker.workspace, fs.realpathSync(env.workspaces[0]));
  assert.equal(firstBroker.dataDir, path.join(env.dataRoot, first.id));
  const conversation = firstBroker.create();
  firstBroker.message(firstBroker.get(conversation.id), 'user', 'Only the first project knows this.');
  firstBroker.create();
  assert.equal(registry.get(first.id).conversationCount, 1);
  assert.equal(registry.get(second.id).conversationCount, 0);
  assert.equal(fs.existsSync(path.join(env.dataRoot, second.id)), false);

  await registry.close();
  const reopened = env.open();
  assert.equal(reopened.get(first.id).conversationCount, 1);
  assert.equal(reopened.get(second.id).conversationCount, 0);
  const recovered = reopened.broker(first.id).get(conversation.id);
  assert.equal(recovered.messages[0].text, 'Only the first project knows this.');
  const secondBroker = reopened.broker(second.id);
  assert.equal(secondBroker.list().length, 1);
  assert.throws(() => secondBroker.get(conversation.id), { status: 404 });
});

test('a missing saved folder remains listed without preventing another project from opening', async t => {
  const env = setup(t);
  const registry = env.open();
  const missing = registry.add({ path: env.workspaces[0], name: 'Temporarily unavailable' });
  const available = registry.add({ path: env.workspaces[1] });
  registry.broker(missing.id).create();
  await registry.close();
  fs.rmSync(env.workspaces[0], { recursive: true });

  const reopened = env.open();
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.get(missing.id).available, false);
  assert.equal(reopened.get(missing.id).name, 'Temporarily unavailable');
  assert.equal(reopened.get(missing.id).conversationCount, 1);
  assert.equal(reopened.broker(missing.id).list().length, 1, 'saved chat remains readable while its source folder is missing');
  assert.equal(reopened.get(available.id).available, true);
  assert.equal(reopened.broker(available.id).create().status, 'idle');
});

test('broker updates identify both the project and conversation', t => {
  const env = setup(t);
  const registry = env.open();
  const first = registry.add({ path: env.workspaces[0] });
  const second = registry.add({ path: env.workspaces[1] });
  const updates = [];
  registry.on('update', update => updates.push(update));
  const firstConversation = registry.broker(first.id).create();
  const secondConversation = registry.broker(second.id).create();
  assert.deepEqual(updates, [
    { projectId: first.id, conversationId: firstConversation.id },
    { projectId: second.id, conversationId: secondConversation.id },
  ]);
});

test('project events announce new registrations and explicit renames without duplicate noise', t => {
  const env = setup(t);
  const registry = env.open();
  let events = 0;
  registry.on('projects', () => events++);
  const project = registry.add({ path: env.workspaces[0], name: 'Original name' });
  assert.equal(events, 1);
  registry.add({ path: env.workspaces[0] });
  assert.equal(events, 1);
  assert.equal(registry.get(project.id).name, 'Original name');
  registry.add({ path: env.workspaces[0], name: 'Updated name' });
  assert.equal(events, 2);
  assert.equal(registry.get(project.id).name, 'Updated name');
  registry.add({ path: env.workspaces[1] });
  assert.equal(events, 3);
});

test('locks apply only to opened projects and close releases them for another registry', async t => {
  const env = setup(t);
  const firstRegistry = env.open();
  const first = firstRegistry.add({ path: env.workspaces[0] });
  const second = firstRegistry.add({ path: env.workspaces[1] });
  firstRegistry.broker(first.id).create();

  const secondRegistry = env.open();
  assert.equal(secondRegistry.list().length, 2, 'listing projects must not acquire their broker locks');
  secondRegistry.broker(second.id).create();
  assert.throws(() => secondRegistry.broker(first.id), /lock|already|another/i);
  assert.throws(() => firstRegistry.broker(second.id), /lock|already|another/i);

  await firstRegistry.close();
  assert.equal(secondRegistry.broker(first.id).list().length, 1);
  await secondRegistry.close();
  const thirdRegistry = env.open();
  assert.equal(thirdRegistry.broker(first.id).list().length, 1);
  assert.equal(thirdRegistry.broker(second.id).list().length, 1);
});

test('a running instance keeps its project lock, even after the clock is set back', t => {
  if (process.platform !== 'darwin') return t.skip('Process start times are read on macOS only.');
  const env = setup(t);
  const registry = env.open();
  const project = registry.add({ path: env.workspaces[0] });
  registry.broker(project.id).create();
  // A backward clock correction after the instance started makes its lock look older than the instance.
  const lock = path.join(env.dataRoot, project.id, 'server.lock'), earlier = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, earlier, earlier);
  assert.throws(() => env.open().broker(project.id), /already running for this project/);
});

test('a lock left by a crash is replaced once its process ID belongs to a process that started later', async t => {
  if (process.platform !== 'darwin') return t.skip('Process start times are read on macOS only.');
  const env = setup(t);
  const registry = env.open();
  const project = registry.add({ path: env.workspaces[0] });
  registry.broker(project.id).create();
  const lock = path.join(env.dataRoot, project.id, 'server.lock'), saved = JSON.parse(fs.readFileSync(lock, 'utf8'));
  await registry.close();
  // ps reports start times to the second, so the process that takes over the ID starts in a later second.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const later = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => later.kill());
  // A lock saved by an earlier version has no start time, so a live process ID still holds it.
  fs.writeFileSync(lock, JSON.stringify({ pid: later.pid, token: 'left-by-a-crash' }));
  assert.throws(() => env.open().broker(project.id), /already running for this project/);
  fs.writeFileSync(lock, JSON.stringify({ ...saved, pid: later.pid }));
  assert.equal(env.open().broker(project.id).list().length, 1);
});

test('projects can run independently and registry close stops every run before releasing locks', { skip: scriptCLIs }, async t => {
  const env = setup(t, { 'Keep working': { behavior: 'hang', text: 'Partial work before closing' } });
  const registry = env.open();
  const projects = env.workspaces.map(workspace => registry.add({ path: workspace }));
  const brokers = projects.map(project => registry.broker(project.id));
  const conversations = brokers.map(broker => broker.get(broker.create().id));
  for (let index = 0; index < brokers.length; index++) {
    brokers[index].start(conversations[index], { text: 'Keep working', provider: 'codex', mode: 'edit' });
  }
  await untilUpdate(registry, () => conversations.every(conversation => conversation.messages.some(message => message.role === 'activity')));
  projects.forEach((project, index) => {
    assert.equal(registry.get(project.id).runningConversationId, conversations[index].id);
  });

  await registry.close();
  brokers.forEach((broker, index) => {
    assert.equal(broker.running, null);
    assert.equal(conversations[index].status, 'interrupted');
    assert.ok(conversations[index].messages.some(message => message.role === 'assistant' && message.status === 'incomplete'));
  });
  const reopened = env.open();
  projects.forEach((project, index) => {
    const broker = reopened.broker(project.id);
    assert.equal(reopened.get(project.id).runningConversationId, null);
    assert.equal(broker.get(conversations[index].id).status, 'interrupted');
  });
});

test('removing the last workspace persists while files and its canonical chat survive Undo and re-add', async t => {
  const env = setup(t), registry = env.open(), stale = env.open();
  const project = registry.add({ folders: env.workspaces, name: 'Full stack' });
  const broker = registry.broker(project.id), chat = registry.mainConversation(project.id);
  broker.message(broker.get(chat.id), 'user', 'Keep this saved chat.');
  const journal = path.join(env.dataRoot, project.id, chat.id + '.jsonl');
  const before = fs.readFileSync(journal);
  fs.writeFileSync(path.join(env.workspaces[0], 'keep.txt'), 'Keep these project files.');
  let events = 0; registry.on('projects', () => events++);
  assert.deepEqual(registry.remove(project.id), { id: project.id, removed: true });
  assert.deepEqual(registry.list(), []); assert.deepEqual(stale.list(), []);
  assert.throws(() => registry.get(project.id), { status: 404 });
  assert.throws(() => registry.broker(project.id), { status: 404 });
  assert.throws(() => broker.message(broker.get(chat.id), 'user', 'Stale write'), { status: 409 });
  assert.equal(fs.readFileSync(path.join(env.workspaces[0], 'keep.txt'), 'utf8'), 'Keep these project files.');
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.equal(events, 1); registry.remove(project.id); assert.equal(events, 1, 'Retry is idempotent.');
  const reopened = env.open(); assert.deepEqual(reopened.list(), []);
  const restored = reopened.restore(project.id); assert.equal(restored.name, 'Full stack');
  assert.equal(reopened.mainConversation(project.id).id, chat.id);
  assert.equal(reopened.mainConversation(project.id).messages[0].text, 'Keep this saved chat.');
  reopened.remove(project.id);
  const added = stale.add({ folders: [...env.workspaces].reverse() });
  assert.equal(added.id, project.id); assert.equal(added.name, 'Full stack');
  assert.equal(stale.mainConversation(project.id).id, chat.id);
  assert.equal(stale.list().length, 1);
});

test('removal respects active runs, mutation leases and locks owned by another instance', async t => {
  const env = setup(t, { 'Keep working': { behavior: 'hang', text: 'Partial work' } });
  const registry = env.open(), other = env.open();
  const project = registry.add({ path: env.workspaces[0] });
  const broker = registry.broker(project.id), conversation = broker.get(registry.mainConversation(project.id).id);
  assert.throws(() => other.remove(project.id), { status: 409 });
  const lease = registry.mutations.acquireMany([env.workspaces[0]], 'patch-review');
  try { assert.throws(() => registry.remove(project.id), /busy/); assert.equal(registry.list().length, 1); }
  finally { lease.release(); }
  broker.start(conversation, { text: 'Keep working', provider: 'codex', mode: 'edit' });
  assert.throws(() => registry.remove(project.id), /Stop the current run/);
  broker.stop(conversation.id); await untilUpdate(registry, () => !broker.running);
  registry.remove(project.id); assert.deepEqual(registry.list(), []);
  other.restore(project.id); assert.equal(other.mainConversation(project.id).id, conversation.id, 'Removal releases the broker lock.');
});

test('unavailable workspaces can be removed and restored without discarding their history', async t => {
  const env = setup(t), registry = env.open();
  const project = registry.add({ path: env.workspaces[0] });
  const chat = registry.mainConversation(project.id); await registry.close();
  fs.renameSync(env.workspaces[0], env.workspaces[0] + '-moved');
  const reopened = env.open(); reopened.remove(project.id); assert.deepEqual(reopened.list(), []);
  assert.equal(reopened.restore(project.id).available, false);
  assert.equal(reopened.mainConversation(project.id).id, chat.id);
});

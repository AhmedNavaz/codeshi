import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { noSymlinks } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { ProjectRegistry } from '../src/projects.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-v2-'));
  const dataRoot = path.join(root, 'data'); fs.mkdirSync(dataRoot);
  const folders = ['one/api', 'two/api', 'web'].map(name => { const value = path.join(root, name); fs.mkdirSync(value, { recursive: true }); return fs.realpathSync(value); });
  const instances = [];
  const open = () => { const registry = new ProjectRegistry({ dataRoot, bins: { codex: '/disabled', claude: '/disabled' } }); instances.push(registry); return registry; };
  t.after(async () => { for (const registry of instances) await registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataRoot, folders, open };
}
test('previous-conversation dismissal persists per workspace across restarts, renames and folder changes', async t => {
  const f=setup(t),registry=f.open();const first=registry.add({path:f.folders[0]}),second=registry.add({path:f.folders[1]});
  assert.equal(registry.get(first.id).previousConversationsDismissed,false);
  registry.update(first.id,{previousConversationsDismissed:true});registry.update(first.id,{name:'Renamed workspace'});registry.addFolder(first.id,f.folders[2]);
  const restarted=f.open();assert.equal(restarted.get(first.id).previousConversationsDismissed,true);assert.equal(restarted.get(first.id).name,'Renamed workspace');
  assert.equal(restarted.get(second.id).previousConversationsDismissed,false);
  assert.throws(()=>restarted.update(first.id,{previousConversationsDismissed:'true'}),{status:400});
  restarted.update(first.id,{previousConversationsDismissed:false});assert.equal(registry.get(first.id).previousConversationsDismissed,false);
});

test('v1 migration preserves project ID and journals, deterministically selects newest main, and archives others', async t => {
  const f = setup(t); const directory = f.folders[0]; const id = createHash('sha256').update(directory).digest('hex').slice(0, 16);
  const broker = new Broker({ workspace: directory, dataDir: path.join(f.dataRoot, id), bins: { codex: '/disabled', claude: '/disabled' } });
  const old = broker.create(); const latest = broker.create();
  broker.message(broker.get(old.id), 'user', 'Older content stays archived');
  broker.message(broker.get(latest.id), 'user', 'Newest content stays canonical');
  // Equal timestamps use journal IDs, so write explicit stable update ordering.
  broker.record(broker.get(old.id), { type: 'title', title: 'Old' });
  broker.record(broker.get(latest.id), { type: 'title', title: 'Latest' });
  const latestFile = path.join(f.dataRoot, id, `${latest.id}.jsonl`);
  const oldFile = path.join(f.dataRoot, id, `${old.id}.jsonl`);
  const oldLines = fs.readFileSync(oldFile, 'utf8').trim().split('\n').map(JSON.parse); oldLines.at(-1).at = '2020-01-01T00:00:00.000Z'; fs.writeFileSync(oldFile, oldLines.map(JSON.stringify).join('\n') + '\n');
  const original = fs.readFileSync(oldFile, 'utf8'); const latestOriginal = fs.readFileSync(latestFile, 'utf8');
  fs.writeFileSync(path.join(f.dataRoot, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id, name: 'Legacy project', path: directory, createdAt: '2020-01-01T00:00:00.000Z' }] }));
  const registry = f.open(); assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataRoot, 'projects.json'))).version, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataRoot,'projects.json.v1-backup'))).version,1);
  assert.equal(registry.mainConversation(id).id, latest.id);
  const managed = registry.broker(id); assert.equal(managed.create().id, latest.id); assert.equal(managed.create().id, latest.id);
  assert.deepEqual(managed.list().map(c => c.id), [latest.id]); assert.deepEqual(managed.list({ archived: true }).map(c => c.id), [old.id]);
  assert.match(managed.get(old.id).messages[0].text, /Older/);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), original); assert.equal(fs.readFileSync(latestFile, 'utf8'), latestOriginal);
  assert.equal(registry.get(id).archivedConversationCount, 1);
  await registry.close(); const reopened = f.open(); assert.equal(reopened.mainConversation(id).id, latest.id);
});
test('multi-folder aliases are stable and safe, primary changes preserve project and permanent chat', { skip: noSymlinks }, async t => {
  const f = setup(t); const registry = f.open();
  const project = registry.add({ name: 'Full product', folders: [f.folders[0], f.folders[1], f.folders[0]] });
  assert.equal(project.folders.length, 2); assert.notEqual(project.folders[0].name, project.folders[1].name);
  for (const folder of project.folders) assert.match(folder.name, /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  const main = registry.mainConversation(project.id); const oldBroker = registry.broker(project.id);
  assert.deepEqual(oldBroker.workspaces, f.folders.slice(0, 2));
  assert.equal(registry.addFolder(project.id, { path: f.folders[0] }).folders.length, 2);
  const snapshot = []; registry.on('beforeFoldersChange', event => snapshot.push(event));
  const removed = registry.removeFolder(project.id, project.folders[0].id);
  assert.equal(removed.id, project.id); assert.equal(removed.path, f.folders[1]); assert.equal(registry.mainConversation(project.id).id, main.id);
  assert.equal(removed.folders[0].name, project.folders[1].name); assert.equal(snapshot[0].workspace.path, f.folders[0]);
  assert.throws(() => oldBroker.start(oldBroker.get(main.id), { text: 'stale object' }), { status: 409 });
  const readded = registry.addFolder(project.id, { path: f.folders[0] });
  assert.equal(readded.folders.find(folder => folder.path === f.folders[0]).name, project.folders[0].name);
  const alias = path.join(f.root, 'symbolic-api'); fs.symlinkSync(f.folders[0], alias);
  assert.equal(registry.addFolder(project.id, { path: alias }).folders.length, 2);
  const renamed = registry.update(project.id, { name: 'Renamed product' }); assert.equal(renamed.name, 'Renamed product'); assert.equal(renamed.conversationId, main.id);
  registry.removeFolder(project.id, project.folders[0].id);
  assert.throws(() => registry.removeFolder(project.id, project.folders[1].id), { status: 400 });
});
test('membership changes reject active operations and abort safely when association snapshot fails', async t => {
  const f = setup(t); const registry = f.open(); const project = registry.add({ folders: f.folders.slice(0, 2) });
  const broker = registry.broker(project.id); const main = registry.mainConversation(project.id);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const operation = registry.withMutation(project.id, 'verification', () => gate);
  assert.throws(() => registry.removeFolder(project.id, project.folders[0].id), { status: 409 });
  release(); await operation;
  const listener = () => { throw new Error('Snapshot failed'); }; registry.on('beforeFoldersChange', listener);
  assert.throws(() => registry.removeFolder(project.id, project.folders[0].id), /Snapshot failed/);
  assert.equal(registry.get(project.id).folders.length, 2); assert.equal(registry.broker(project.id), broker); assert.equal(registry.mainConversation(project.id).id, main.id);
  const competing = f.open(); assert.throws(() => competing.broker(project.id), { status: 409 }, 'failed edit must retain the original broker history lock');
  registry.off('beforeFoldersChange', listener);
  registry.removeFolder(project.id, project.folders[0].id);
  assert.equal(registry.get(project.id).folders.length, 1);
});
test('unavailable folders can be removed without losing the permanent history', t => {
  const f = setup(t); const registry = f.open(); const project = registry.add({ folders: f.folders.slice(0, 2) });
  const main = registry.mainConversation(project.id); fs.rmSync(f.folders[1], { recursive: true });
  assert.equal(registry.get(project.id).folders[1].available, false);
  registry.removeFolder(project.id, project.folders[1].id);
  assert.equal(registry.mainConversation(project.id).id, main.id);
});

test('folder limits validate the combined legacy path and folder list before persistence', t => {
  const f = setup(t); const registry = f.open();
  const folders = Array.from({ length: 32 }, (_, index) => { const value = path.join(f.root, `extra-${index}`); fs.mkdirSync(value); return value; });
  assert.throws(() => registry.add({ path: f.folders[0], folders }), { status: 400 });
  assert.deepEqual(registry.list(), []);
});

test('several folders are added in one change, those already there are skipped, and one that cannot be added stops all', async t => {
  const f = setup(t); const registry = f.open();
  const project = registry.add({ name: 'Product', folders: [f.folders[0]] });
  const changes = []; registry.on('beforeFoldersChange', event => changes.push(event));
  const added = registry.addFolder(project.id, { folders: [f.folders[1], f.folders[0], f.folders[2], f.folders[1]] });
  assert.deepEqual(added.folders.map(folder => folder.path), f.folders);
  assert.equal(changes.length, 1, 'All of them join in one change.');
  assert.equal(new Set(added.folders.map(folder => folder.name)).size, 3, 'Two folders both called api still get names of their own.');
  assert.equal(registry.addFolder(project.id, { folders: [f.folders[2]] }).folders.length, 3, 'A folder already there is left as it is.');
  assert.equal(changes.length, 1);
  const extra = path.join(f.root, 'extra'); fs.mkdirSync(extra);
  assert.throws(() => registry.addFolder(project.id, { folders: [extra, path.join(f.root, 'missing')] }), { status: 400 });
  assert.equal(registry.get(project.id).folders.length, 3, 'Nothing is added when one folder cannot be.');
  assert.throws(() => registry.addFolder(project.id, { folders: [] }), /Choose between 1 and 32 folders/);
  assert.throws(() => registry.addFolder(project.id, { folders: 'not a list' }), /Choose between 1 and 32 folders/);
});

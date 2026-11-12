import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportBackup, importBackup, portablePath, readBackup, rewriter } from '../src/backup.mjs';
import { ProjectRegistry } from '../src/projects.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';

// Low scrypt cost keeps the tests quick; files must still ask for at least this much.
const kdf = { name: 'scrypt', N: 2 ** 14, r: 8, p: 1 };
const secret = 'correct horse battery';
const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-backup-')));
const noOrigin = () => null;
function repository(folder, origin) {
  fs.mkdirSync(folder, { recursive: true });
  spawnSync(gitExecutable(), ['init', '-q', folder]);
  if (origin) spawnSync(gitExecutable(), ['-C', folder, 'remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(folder, 'README.md'), 'hello\n');
  return folder;
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const journalOf = (registry, id) => path.join(registry.dataRoot, id, `${registry.projects.get(id).conversationId}.jsonl`);

// One computer: a workspace with a conversation, a record naming its folder, an attachment, a saved command, a task with
// its working copy, approvals and a checkpoint store with things that must never move.
function oldComputer() {
  const root = temporary(), folder = repository(path.join(root, 'code', 'app'), 'git@github.com:me/app.git');
  const registry = new ProjectRegistry({ dataRoot: path.join(root, 'data'), lock: false });
  const project = registry.add({ folders: [folder], name: 'My app' });
  const broker = registry.broker(project.id), conversation = broker.get(registry.mainConversationId(project.id));
  broker.message(conversation, 'user', `Fix the bug in ${folder}/src/a.js please`);
  const folderId = project.folders[0].id, data = path.join(registry.dataRoot, project.id);
  broker.record(conversation, { type: 'test_note', folderId, path: path.join(folder, 'src', 'a.js'), snapshot: path.join(data, 'skills', 'abc', 'skill', 'SKILL.md'), revisions: { [folderId]: 'abc123' } });
  write(path.join(data, 'attachments', 'feed.json'), '{"name":"shot.png"}');
  write(path.join(data, 'commands.json'), JSON.stringify({ version: 2, commands: [{ id: 'web', name: 'web', folderId, directory: '', command: 'npm run web' }] }));
  write(path.join(data, 'permissions.json'), JSON.stringify({ rules: [{ path: `${folder}/x` }] }));
  const task = '11111111-2222-4333-8444-555555555555';
  write(path.join(data, 'tasks', task, 'journal', '66666666-7777-4888-9999-000000000000.jsonl'), `${JSON.stringify({ type: 'created', seq: 1, at: '2026-11-01T00:00:00.000Z', scopePath: `${folder}` })}\n`);
  write(path.join(data, 'tasks', task, 'worktree', 'node_modules', 'big.js'), 'x');
  const store = path.join(data, 'checkpoints', `${folderId}.git`);
  write(path.join(store, 'objects', 'ab', 'c'.repeat(38)), 'object');
  write(path.join(store, 'refs', 'checkpoints', 'one'), 'abc\n');
  write(path.join(store, 'hooks', 'post-checkout'), '#!/bin/sh\necho owned\n');
  write(path.join(store, 'config'), '[core]\n\tfsmonitor = echo owned\n');
  return { root, folder, registry, project, folderId, broker, conversation, data, task };
}
async function backupOf(computer, options = {}) {
  const file = path.join(computer.root, 'out.codeshibackup');
  fs.rmSync(file, { force: true });
  await computer.registry.close();
  const result = await exportBackup({ registry: computer.registry, settings: { appearance: 'dark', githubCloneFolder: '/x', suggestions: false }, file, passphrase: secret, workspaces: [{ id: computer.project.id, checkpoints: options.checkpoints === true }], includeSettings: true, kdf, origin: noOrigin, ...options.extra });
  return { file, result };
}

test('only Codeshi’s own portable records leave a workspace’s data: no approvals, hooks, config or working copies', () => {
  for (const good of ['0e0f1a2b-0000-4000-8000-000000000000.jsonl', 'commands.json', 'attachments/abc.png', 'skills/v1/name/SKILL.md', 'tasks/11111111-2222-4333-8444-555555555555/journal/0e0f1a2b-0000-4000-8000-000000000000.jsonl']) assert.equal(portablePath(good), true, good);
  for (const bad of ['permissions.json', 'server.lock', 'resume-pending', '../x.jsonl', 'attachments/../../etc', 'tasks/11111111-2222-4333-8444-555555555555/worktree/a.js', 'checkpoints/0123456789abcdef.git/objects/ab/' + 'c'.repeat(38)]) assert.equal(portablePath(bad), false, bad);
  const store = 'checkpoints/0123456789abcdef.git/';
  assert.equal(portablePath(store + 'objects/ab/' + 'c'.repeat(38), { checkpoints: true }), true);
  assert.equal(portablePath(store + 'refs/checkpoints/x', { checkpoints: true }), true);
  for (const bad of ['hooks/post-checkout', 'config', 'HEAD', 'index', 'info/attributes', 'objects/info/alternates']) assert.equal(portablePath(store + bad, { checkpoints: true }), false, bad);
});

test('folder IDs and paths are rewritten as whole values only, and untouched records keep their bytes', () => {
  const rewrite = rewriter({ ids: new Map([['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']]), prefixes: [['/old/app', '/new/app'], ['/data', '/elsewhere']], toSeparator: '/' });
  const line = JSON.stringify({ folderId: 'aaaaaaaaaaaaaaaa', path: '/old/app/src/a.js', root: '/old/app', other: '/data/z', text: 'see /old/app/src/a.js', revisions: { aaaaaaaaaaaaaaaa: 1 }, near: '/old/application' });
  assert.deepEqual(JSON.parse(rewrite.line(line)), { folderId: 'bbbbbbbbbbbbbbbb', path: '/new/app/src/a.js', root: '/new/app', other: '/elsewhere/z', text: 'see /old/app/src/a.js', revisions: { bbbbbbbbbbbbbbbb: 1 }, near: '/old/application' });
  const untouched = '{"b": 1,  "a":"x"}';
  assert.equal(rewrite.line(untouched), untouched);
  const windows = rewriter({ prefixes: [['C:\\code\\app', '/Users/me/app']], fromSeparator: '\\', toSeparator: '/' });
  assert.equal(JSON.parse(windows.line(JSON.stringify({ path: 'C:\\code\\app\\src\\a.js' }))).path, '/Users/me/app/src/a.js');
});

test('a backup opens only with its passphrase, and a changed, cut or foreign file is refused', async () => {
  const computer = oldComputer(), { file } = await backupOf(computer);
  const target = new ProjectRegistry({ dataRoot: path.join(computer.root, 'other'), lock: false });
  await assert.rejects(readBackup({ registry: target, file, passphrase: 'wrong passphrase', origin: noOrigin }), error => error.status === 401 && /passphrase is wrong/.test(error.message));
  const bytes = fs.readFileSync(file);
  const changed = Buffer.from(bytes); changed[changed.length - 40] ^= 1; fs.writeFileSync(file + '.changed', changed);
  await assert.rejects(readBackup({ registry: target, file: file + '.changed', passphrase: secret, origin: noOrigin }), /damaged|passphrase/);
  fs.writeFileSync(file + '.cut', bytes.subarray(0, bytes.length - 100));
  await assert.rejects(importBackup({ registry: target, file: file + '.cut', passphrase: secret, workspaces: [{ key: 'w1', folders: { [computer.folderId]: computer.folder } }], origin: noOrigin }), /incomplete|damaged/);
  fs.writeFileSync(file + '.txt', 'not a backup at all');
  await assert.rejects(readBackup({ registry: target, file: file + '.txt', passphrase: secret, origin: noOrigin }), /isn’t a Codeshi backup/);
  assert.equal(bytes.includes(Buffer.from('Fix the bug')), false, 'Conversations are encrypted.');
  assert.equal(target.list().length, 0, 'A refused import changes nothing.');
  await assert.rejects(exportBackup({ registry: computer.registry, file, passphrase: secret, workspaces: [{ id: computer.project.id }], kdf, origin: noOrigin }), error => error.status === 409, 'An existing file is not replaced unless asked.');
  await assert.rejects(exportBackup({ registry: computer.registry, file: path.join(computer.root, 'x'), passphrase: 'short', workspaces: [{ id: computer.project.id }], kdf }), /at least 8/);
});

test('moving a workspace to a computer where its folder is elsewhere: records follow the folder, and nothing private moves', async () => {
  const computer = oldComputer(), { file, result } = await backupOf(computer, { checkpoints: true });
  assert.equal(result.workspaces, 1);
  const other = temporary(), folder = path.join(other, 'Projects', 'my-app');
  fs.cpSync(computer.folder, folder, { recursive: true });
  const registry = new ProjectRegistry({ dataRoot: path.join(other, 'data'), lock: false });
  const read = await readBackup({ registry, file, passphrase: secret, origin: noOrigin });
  assert.equal(read.workspaces[0].name, 'My app');
  assert.equal(read.workspaces[0].folders[0].path, computer.folder);
  let applied = null;
  const imported = await importBackup({ registry, file, passphrase: secret, workspaces: [{ key: 'w1', folders: { [computer.folderId]: folder } }], includeSettings: true, applySettings: value => { applied = value; return Object.keys(value); }, origin: noOrigin });
  assert.deepEqual(applied, { appearance: 'dark', suggestions: false }, 'Only portable settings move; paths stay behind.');
  const [outcome] = imported.workspaces;
  assert.equal(outcome.created, true); assert.equal(outcome.added, 1);
  const project = registry.get(outcome.id), newId = project.folders[0].id;
  assert.equal(project.name, 'My app'); assert.equal(project.folders[0].path, fs.realpathSync(folder)); assert.notEqual(newId, computer.folderId);
  const data = path.join(registry.dataRoot, project.id), text = fs.readFileSync(journalOf(registry, project.id), 'utf8');
  const note = text.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(record => record.type === 'test_note');
  assert.equal(note.folderId, newId);
  assert.equal(note.path, path.join(fs.realpathSync(folder), 'src', 'a.js'));
  assert.equal(note.snapshot, path.join(data, 'skills', 'abc', 'skill', 'SKILL.md'), 'Paths into Codeshi’s own data follow it.');
  assert.deepEqual(Object.keys(note.revisions), [newId]);
  assert(text.includes(JSON.stringify(`Fix the bug in ${computer.folder}/src/a.js`).slice(1, -1)), 'What people wrote stays as written.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'commands.json'), 'utf8')).commands[0].folderId, newId);
  assert.equal(fs.existsSync(path.join(data, 'attachments', 'feed.json')), true);
  assert.equal(fs.existsSync(path.join(data, 'permissions.json')), false, 'Always-allow approvals stay behind.');
  assert.equal(fs.existsSync(path.join(data, 'tasks', computer.task, 'journal')), true);
  assert.equal(fs.existsSync(path.join(data, 'tasks', computer.task, 'worktree')), false, 'A task’s working copy stays behind.');
  const store = path.join(data, 'checkpoints', `${newId}.git`);
  assert.equal(fs.existsSync(path.join(store, 'objects', 'ab', 'c'.repeat(38))), true);
  assert.equal(fs.existsSync(path.join(store, 'refs', 'checkpoints', 'one')), true);
  assert.equal(fs.existsSync(path.join(store, 'hooks')), false); assert.equal(fs.existsSync(path.join(store, 'config')), false);
  assert.equal(fs.readdirSync(registry.dataRoot).some(name => name.startsWith('.import-')), false, 'The staging folder is removed.');
  // The workspace opens, with the conversation it had.
  const conversation = registry.mainConversation(project.id);
  assert(conversation.messages.some(message => message.role === 'user' && message.text.startsWith('Fix the bug')));
  await registry.close();
});

test('importing again merges: the same stays, a longer one updates, and one changed on both sides waits for your choice', async () => {
  const computer = oldComputer();
  const other = temporary(), folder = path.join(other, 'app'); fs.cpSync(computer.folder, folder, { recursive: true });
  const registry = new ProjectRegistry({ dataRoot: path.join(other, 'data'), lock: false });
  const plan = { registry, passphrase: secret, workspaces: [{ key: 'w1', folders: { [computer.folderId]: folder } }], origin: noOrigin };
  const first = await backupOf(computer);
  const { id } = (await importBackup({ ...plan, file: first.file })).workspaces[0];
  const again = await importBackup({ ...plan, file: first.file });
  assert.deepEqual([again.workspaces[0].created, again.workspaces[0].kept, again.workspaces[0].added], [false, 1, 0]);

  // The other computer carries on; this one hasn't changed since.
  const source = new ProjectRegistry({ dataRoot: computer.registry.dataRoot, lock: false });
  const broker = source.broker(computer.project.id); broker.message(broker.get(source.mainConversationId(computer.project.id)), 'user', 'Second message');
  computer.registry = source;
  const newer = await backupOf(computer);
  assert.equal((await importBackup({ ...plan, file: newer.file })).workspaces[0].updated, 1);

  // Both carry on.
  const here = registry.broker(id); here.message(here.get(registry.mainConversationId(id)), 'user', 'Written here');
  const there = new ProjectRegistry({ dataRoot: computer.registry.dataRoot, lock: false });
  const remote = there.broker(computer.project.id); remote.message(remote.get(there.mainConversationId(computer.project.id)), 'user', 'Written there');
  computer.registry = there;
  const diverged = await backupOf(computer);
  const before = fs.readFileSync(journalOf(registry, id));
  await assert.rejects(importBackup({ ...plan, file: diverged.file }), error => error.status === 409 && error.conflicts.length === 1 && error.conflicts[0].current === true);
  assert.deepEqual(fs.readFileSync(journalOf(registry, id)), before, 'Nothing changes until you choose.');
  const key = `w1:${registry.projects.get(id).conversationId}`;
  assert.equal((await importBackup({ ...plan, file: diverged.file, decisions: { [key]: 'keep' } })).workspaces[0].kept, 1);
  assert.deepEqual(fs.readFileSync(journalOf(registry, id)), before);
  assert.equal((await importBackup({ ...plan, file: diverged.file, decisions: { [key]: 'backup' } })).workspaces[0].replaced, 1);
  assert.match(fs.readFileSync(journalOf(registry, id), 'utf8'), /Written there/);
  const kept = path.join(registry.dataRoot, id, 'import-replaced');
  assert.equal(fs.readdirSync(kept).length, 1, 'This computer’s copy is kept.');
  assert.match(fs.readFileSync(path.join(kept, fs.readdirSync(kept)[0], path.basename(journalOf(registry, id))), 'utf8'), /Written here/);
});

test('a folder can be left out, and a workspace already here with an empty conversation takes the moved one', async () => {
  const computer = oldComputer(), second = repository(path.join(computer.root, 'code', 'api'));
  computer.registry.addFolder(computer.project.id, { path: second });
  const secondId = computer.registry.get(computer.project.id).folders[1].id;
  const { file } = await backupOf(computer);
  const other = temporary(), folder = path.join(other, 'app'); fs.cpSync(computer.folder, folder, { recursive: true });
  const registry = new ProjectRegistry({ dataRoot: path.join(other, 'data'), lock: false });
  const existing = registry.add({ folders: [folder] }); registry.mainConversationId(existing.id);
  const result = await importBackup({ registry, file, passphrase: secret, workspaces: [{ key: 'w1', folders: { [computer.folderId]: folder, [secondId]: null } }], origin: noOrigin });
  const [outcome] = result.workspaces;
  assert.equal(outcome.id, existing.id); assert.equal(outcome.created, false); assert.deepEqual(outcome.skippedFolders, ['api']);
  assert.equal(registry.projects.get(existing.id).conversationId, computer.registry.projects.get(computer.project.id).conversationId, 'The moved conversation becomes current.');
  assert.equal(registry.projects.get(existing.id).folderAliases[secondId], 'api', 'History can still name the folder left out.');
  assert.equal(outcome.previous, false);
});

test('a workspace that is working can’t be exported or imported into', async () => {
  const computer = oldComputer();
  computer.registry.brokers.set(computer.project.id, { broker: { running: true } });
  await assert.rejects(exportBackup({ registry: computer.registry, file: path.join(computer.root, 'b'), passphrase: secret, workspaces: [{ id: computer.project.id }], kdf, origin: noOrigin }), error => error.status === 409 && /is working/.test(error.message));
});

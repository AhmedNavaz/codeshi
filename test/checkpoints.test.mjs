import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { safeTarget } from '../src/checkpoints.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (root, file) => fs.existsSync(path.join(root, file));
async function until(check, ms = 20000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting'); await new Promise(resolve => setTimeout(resolve, 10)); } }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Pat', GIT_AUTHOR_EMAIL: 'pat@example.com', GIT_COMMITTER_NAME: 'Pat', GIT_COMMITTER_EMAIL: 'pat@example.com' } });

// A workspace with a mock Codex that edits files as each scenario says. The mock's own files are ignored.
function setup(t, { files = {}, scenarios = {}, repository = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-checkpoints-'));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  fs.mkdirSync(workspace);
  for (const [file, content] of Object.entries({ '.gitignore': '.mock-*\n', ...files })) { fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true }); fs.writeFileSync(path.join(workspace, file), content); }
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify(scenarios));
  if (repository) { git(workspace, 'init', '-q', '-b', 'main'); git(workspace, 'config', 'commit.gpgsign', 'false'); git(workspace, 'add', '-A'); git(workspace, 'commit', '-q', '-m', 'Start'); }
  const bin = path.join(root, 'codex-mock.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  const broker = new Broker({ workspace, dataDir, bins: { codex: bin } });
  const c = broker.get(broker.create().id);
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Runs one prompt and waits until its checkpoint after the run is saved.
  const run = async text => { const { runId } = broker.start(c, { text, provider: 'codex', mode: 'edit' }); await until(() => !broker.running); await broker.checkpoints.idle(); return runId; };
  const undo = async target => { const preview = await broker.checkpoints.preview(c, target); return { preview, result: await broker.checkpoints.apply(c, target, preview.digest) }; };
  return { root, workspace, dataDir, broker, c, run, undo, view: () => broker.view(c) };
}

test('a run is undone and redone across edits, additions and deletions, and the next agent is told', { skip: scriptCLIs }, async t => {
  const env = setup(t, {
    files: { 'src/checkout.js': 'line one\nline two\n', 'old.js': 'old\n', 'node_modules/pkg/index.js': 'installed\n' },
    scenarios: { 'Add promo codes': { write: { 'src/checkout.js': 'line one\nPROMO\n', 'src/promo/apply.js': 'export const apply = 1;\n', 'old.js': null, 'node_modules/pkg/index.js': 'reinstalled\n' } }, 'What changed?': {} },
  });
  const runId = await env.run('Add promo codes');
  assert.equal(read(env.workspace, 'src/checkout.js'), 'line one\nPROMO\n');
  assert.deepEqual(env.view().checkpoints[runId], { files: 3 }, 'Rebuilt folders such as node_modules and ignored files are not part of a checkpoint.');
  assert.equal(env.view().snapshots, undefined, 'Snapshot details stay private to the app.');

  const { preview, result } = await env.undo({ kind: 'run', id: runId });
  assert.deepEqual(preview.files.map(file => [file.path, file.action]).sort(), [['old.js', 'recreate'], ['src/checkout.js', 'restore'], ['src/promo/apply.js', 'remove']]);
  assert.equal(preview.provider, 'codex'); assert.equal(preview.prompt, 'Add promo codes');
  assert.match(preview.files.find(file => file.path === 'src/checkout.js').diff, /^@@ .*\n line one\n-PROMO\n\+line two$/);
  assert.deepEqual(result.counts, { remove: 1, restore: 1, merge: 0, recreate: 1 });
  assert.equal(read(env.workspace, 'src/checkout.js'), 'line one\nline two\n');
  assert.equal(read(env.workspace, 'old.js'), 'old\n');
  assert.equal(exists(env.workspace, 'src/promo'), false, 'A folder the run created, left empty, goes too.');
  assert.equal(exists(env.workspace, 'src'), true, 'A folder that existed before stays.');
  assert.equal(read(env.workspace, 'node_modules/pkg/index.js'), 'reinstalled\n', 'Files outside the checkpoint are not touched.');
  assert.deepEqual(env.view().checkpoints[runId], { files: 3, undone: result.id });
  const note = env.c.messages.at(-1);
  assert.equal(note.role, 'system');
  assert.match(note.text, /^Undid Codex’s changes from “Add promo codes”: restored 1 file, removed 1 file it added, brought back 1 file it deleted \(src\/promo\/apply\.js, src\/checkout\.js, old\.js\)\./);

  const redo = await env.undo({ kind: 'rewind', id: result.id });
  assert.deepEqual(redo.preview.files.map(file => [file.path, file.action]).sort(), [['old.js', 'remove'], ['src/checkout.js', 'restore'], ['src/promo/apply.js', 'recreate']]);
  assert.equal(read(env.workspace, 'src/checkout.js'), 'line one\nPROMO\n');
  assert.equal(read(env.workspace, 'src/promo/apply.js'), 'export const apply = 1;\n');
  assert.equal(exists(env.workspace, 'old.js'), false);
  assert.deepEqual(env.view().checkpoints[runId], { files: 3 }, 'After a redo the run can be undone again.');
  assert.match(env.c.messages.at(-1).text, /^Redid Codex’s changes from “Add promo codes”: put back 3 files/);

  // The note reaches the next agent with the conversation.
  await env.run('What changed?');
  const captures = read(env.workspace, '.mock-captures.jsonl').trim().split('\n').map(line => JSON.parse(line));
  assert(captures.at(-1).context.context.some(item => item.role === 'system' && item.text.startsWith('Redid Codex’s changes')));
});

test('edits made after a run are kept: other lines merge, the same lines are left as they are', { skip: scriptCLIs }, async t => {
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const env = setup(t, {
    files: { 'notes.txt': lines, 'plan.md': 'first\n' },
    scenarios: { 'Edit line two': { write: { 'notes.txt': lines.replace('line 2\n', 'AGENT 2\n'), 'plan.md': 'agent\n', 'added.txt': 'new\n' } } },
  });
  const runId = await env.run('Edit line two');
  fs.writeFileSync(path.join(env.workspace, 'notes.txt'), lines.replace('line 2\n', 'AGENT 2\n').replace('line 11\n', 'MINE 11\n'));
  fs.writeFileSync(path.join(env.workspace, 'plan.md'), 'mine\n');
  fs.appendFileSync(path.join(env.workspace, 'added.txt'), 'mine too\n');
  const { preview, result } = await env.undo({ kind: 'run', id: runId });
  const actions = Object.fromEntries(preview.files.map(file => [file.path, file]));
  assert.equal(actions['notes.txt'].action, 'merge');
  assert.equal(actions['plan.md'].action, 'conflict'); assert.match(actions['plan.md'].reason, /same places/);
  assert.equal(actions['added.txt'].action, 'conflict'); assert.match(actions['added.txt'].reason, /would remove those changes/);
  assert.equal(read(env.workspace, 'notes.txt'), lines.replace('line 11\n', 'MINE 11\n'), 'The run’s line is taken out and the later edit kept.');
  assert.equal(read(env.workspace, 'plan.md'), 'mine\n'); assert.equal(read(env.workspace, 'added.txt'), 'new\nmine too\n');
  assert.deepEqual(result.left.map(file => file.path).sort(), ['added.txt', 'plan.md']);
  assert.match(env.c.messages.at(-1).text, /Left as they are: (plan\.md, added\.txt|added\.txt, plan\.md)\./);
});

test('an undo is refused when files changed after its preview, or while an agent works', { skip: scriptCLIs }, async t => {
  const env = setup(t, { files: { 'a.txt': 'a\n' }, scenarios: { 'Change a': { write: { 'a.txt': 'agent\n' } }, 'Hold': { behavior: 'hold' } } });
  const runId = await env.run('Change a');
  const preview = await env.broker.checkpoints.preview(env.c, { kind: 'run', id: runId });
  fs.writeFileSync(path.join(env.workspace, 'a.txt'), 'changed after the preview\n');
  await assert.rejects(env.broker.checkpoints.apply(env.c, { kind: 'run', id: runId }, preview.digest), error => error.status === 409 && /Review the changes again/.test(error.message));
  assert.equal(read(env.workspace, 'a.txt'), 'changed after the preview\n');

  fs.writeFileSync(path.join(env.workspace, 'a.txt'), 'agent\n');
  const fresh = await env.broker.checkpoints.preview(env.c, { kind: 'run', id: runId });
  env.broker.start(env.c, { text: 'Hold', provider: 'codex', mode: 'edit' });
  await until(() => env.broker.running);
  await assert.rejects(env.broker.checkpoints.apply(env.c, { kind: 'run', id: runId }, fresh.digest), error => error.status === 409 && /current run to finish/.test(error.message));
  fs.writeFileSync(path.join(env.workspace, '.release'), '');
  await until(() => !env.broker.running);
  await assert.rejects(env.broker.checkpoints.preview(env.c, { kind: 'run', id: '00000000-0000-0000-0000-000000000000' }), error => error.status === 404);
});

test('checkpoints leave the project’s Git repository alone, keep files byte for byte, and skip very large files', { skip: scriptCLIs }, async t => {
  const env = setup(t, {
    repository: true,
    files: { '.gitattributes': '* text=auto\n', 'windows.txt': 'one\r\ntwo\r\n', 'small.txt': 'small\n' },
    scenarios: { 'Edit both': { write: { 'windows.txt': 'one\r\nCHANGED\r\n', 'small.txt': 'agent\n', 'big.bin': Buffer.alloc(4096, 1).toString() } } },
  });
  // The repository as Git sees it: its commits and refs, and its index byte for byte.
  const repository = () => [git(env.workspace, 'rev-parse', 'HEAD'), git(env.workspace, 'for-each-ref'), git(env.workspace, 'stash', 'list'), createHash('sha256').update(fs.readFileSync(path.join(env.workspace, '.git', 'index'))).digest('hex')];
  const before = repository();
  env.broker.checkpoints.limits.fileBytes = 1024;
  const runId = await env.run('Edit both');
  assert.equal(env.view().checkpoints[runId].files, 2, 'The large file is left out of the checkpoint.');
  const { preview } = await env.undo({ kind: 'run', id: runId });
  assert.deepEqual(preview.files.map(file => file.path).sort(), ['small.txt', 'windows.txt']);
  assert.equal(fs.readFileSync(path.join(env.workspace, 'windows.txt'), 'utf8'), 'one\r\ntwo\r\n', 'Line endings are restored exactly.');
  assert.equal(read(env.workspace, 'small.txt'), 'small\n');
  assert.equal(exists(env.workspace, 'big.bin'), true, 'A file too large to keep is never removed.');
  assert.deepEqual(repository(), before, 'The project’s commits, refs, stash and index are untouched.');
  assert.equal(git(env.workspace, 'status', '--porcelain').trim(), '?? big.bin');
});

test('old checkpoints are let go, and writes never follow a link out of the folder', { skip: scriptCLIs }, async t => {
  const env = setup(t, { files: { 'a.txt': '0\n' }, scenarios: { One: { write: { 'a.txt': '1\n' } }, Two: { write: { 'a.txt': '2\n' } }, Three: { write: { 'a.txt': '3\n' } } } });
  env.broker.checkpoints.limits.keepRuns = 2;
  const first = await env.run('One'); await env.run('Two'); await env.run('Three');
  assert.equal(Object.keys(env.view().checkpoints).length, 2);
  assert.equal(env.view().checkpoints[first], undefined);
  await assert.rejects(env.broker.checkpoints.preview(env.c, { kind: 'run', id: first }), error => error.status === 404);
  const store = path.join(env.dataDir, 'checkpoints', `${env.broker.workspaceFolders[0].id}.git`);
  assert.doesNotMatch(git(store, 'for-each-ref', '--format=%(refname)'), new RegExp(first));

  const outside = path.join(env.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(env.workspace, 'linked'));
  assert.throws(() => safeTarget(env.workspace, 'linked/file.txt'), error => error.status === 409);
  for (const unsafe of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd', 'a//b']) assert.throws(() => safeTarget(env.workspace, unsafe), error => error.status === 409);
  assert.equal(safeTarget(env.workspace, 'new/folder/file.txt'), path.join(fs.realpathSync(env.workspace), 'new', 'folder', 'file.txt'));
});

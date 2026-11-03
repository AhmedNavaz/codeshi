import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { automaticReviewPlan, automaticReviewContextDigest, validateAutomaticReview, captureAutomaticReview } from '../src/automatic-review.mjs';
import { reviewFreshness } from '../src/agent-review.mjs';
import { AttachmentStore } from '../src/attachments.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';
import { noSymlinks } from './platform.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-auto-review-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function repo(name) {
    const directory = path.join(root, name); fs.mkdirSync(directory);
    const git = (...args) => { const result = spawnSync(gitExecutable(), args, { cwd: directory, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(directory, 'app.js'), 'export const value = 1;\n'); git('add', '.'); git('commit', '-qm', 'Initial');
    return { id: name, name, path: directory, git };
  }
  const folders = [repo('web'), repo('api')], broker = { workspaceFolders: folders, workspaceSignature: 'test-workspace', attachments: new AttachmentStore(path.join(root, 'data')) };
  const c = { provider: 'codex', model: 'builder-model', mode: 'edit', approvalPolicy: 'ask', models: { codex: 'builder-model', claude: 'reviewer-model' } };
  const input = { text: 'Implement the public contract', folderIds: ['web'] };
  const plan = changes => automaticReviewPlan(broker, c, { ...input, ...changes });
  return { root, folders, broker, c, input, plan, write: (name, value, folder = 0) => fs.writeFileSync(path.join(folders[folder].path, name), value) };
}

test('automatic review authorizes one task and named Git roots, capturing only those roots after the builder finishes', t => {
  const f = fixture(t), plan = f.plan();
  assert.equal(plan.builder, 'codex'); assert.equal(plan.reviewer, 'claude'); assert.equal(plan.model, 'reviewer-model');
  assert.match(plan.scope, /including changes already present/); assert.equal(plan.limits.files, 12);
  assert.deepEqual(plan.folders, [{ id: 'web', name: 'web', path: f.folders[0].path }]);
  assert.equal(captureAutomaticReview(plan, f.folders), null, 'Clean projects can be opted in before any edit.');
  f.write('app.js', 'export const value = 2;\n'); f.write('other.js', 'New file\n'); f.write('app.js', 'Outside selected scope\n', 1);
  const snapshot = captureAutomaticReview(plan, f.folders);
  assert.deepEqual(snapshot.files.map(file => [file.folderId, file.path]), [['web', 'app.js'], ['web', 'other.js']]);
  assert.equal(reviewFreshness({ snapshot }, f.folders).stale, false);
  f.write('app.js', 'Newer edit\n'); assert.equal(reviewFreshness({ snapshot }, f.folders).stale, true);
});

test('approval binds full task, pairing, models, access policy, and attached folder identities', t => {
  const f = fixture(t), plan = f.plan(), input = { approvedDigest: plan.approvedDigest, folderIds: plan.folderIds, reviewer: plan.reviewer, model: plan.model, billingConfirmed: true };
  assert.equal(validateAutomaticReview(f.broker, f.c, input, f.input).billingConfirmed, true);
  for (const change of [{ text: 'A different task' }, { provider: 'claude' }, { model: 'different-model' }, { approvalPolicy: 'auto' }]) {
    assert.throws(() => validateAutomaticReview(f.broker, f.c, input, { ...f.input, ...change }), error => error.status === 409);
  }
  assert.throws(() => validateAutomaticReview(f.broker, f.c, { ...input, folderIds: ['api'] }, f.input), error => error.status === 409);
  assert.throws(() => validateAutomaticReview(f.broker, f.c, { ...input, reviewer: 'gemini' }, f.input), error => error.status === 409);
  f.c.models.claude = 'different-reviewer-model';
  assert.throws(() => validateAutomaticReview(f.broker, f.c, input, f.input), error => error.status === 409);
  f.c.models.claude = 'reviewer-model';
  const renamed = f.folders.map(folder => ({ ...folder, id: folder.id === 'api' ? 'new-id' : folder.id }));
  assert.throws(() => captureAutomaticReview(plan, renamed), error => error.status === 409);
  assert.throws(() => captureAutomaticReview(plan, f.folders.slice(0, 1)), error => error.status === 409);
  const long = 'x'.repeat(4001), a = f.plan({ text: long }), b = f.plan({ text: long + 'different ending' });
  assert.equal(a.goal, long); assert.equal(b.goal, long + 'different ending'); assert.notEqual(a.approvedDigest, b.approvedDigest, 'Long tasks keep their final requirements in both the review goal and authorization.');
});

test('automatic review pairs Claude with Codex and Gemini with Claude without inheriting the last builder', t => {
  const f = fixture(t); f.c.lastBuilder = 'claude';
  assert.equal(f.plan().reviewer, 'claude');
  assert.deepEqual([f.plan({ provider: 'claude' }).reviewer, f.plan({ provider: 'claude' }).model], ['codex', 'builder-model']);
  assert.equal(f.plan({ provider: 'gemini' }).reviewer, 'claude');
  assert.throws(() => f.plan({ mode: 'read' }), error => error.status === 400);
  assert.throws(() => f.plan({ text: '' }), error => error.status === 400);
  for (const folderIds of [[], ['web', 'web'], ['foreign']]) assert.throws(() => f.plan({ folderIds }));
  const nested = path.join(f.folders[0].path, 'nested'); fs.mkdirSync(nested);
  f.broker.workspaceFolders[0] = { ...f.folders[0], path: nested };
  assert.throws(() => f.plan(), /Git repository root/);
});

test('automatic authorization binds the saved project brief and verified immutable attachments', t => {
  const f = fixture(t), add = text => f.broker.attachments.put({ name: 'task.txt', data: Buffer.from(text).toString('base64') });
  const first = add('Implement the public contract.'), second = add('Change the public contract instead.');
  const attachments = [first.id], plan = f.plan({ attachments });
  const input = { approvedDigest: plan.approvedDigest, folderIds: plan.folderIds, reviewer: plan.reviewer, model: plan.model };
  const run = { ...f.input, attachments };
  assert.deepEqual(plan.attachments, attachments);
  assert.equal(validateAutomaticReview(f.broker, f.c, input, run).approvedDigest, plan.approvedDigest);
  assert.throws(() => validateAutomaticReview(f.broker, f.c, input, { ...run, attachments: [second.id] }), error => error.status === 409);
  assert.throws(() => validateAutomaticReview(f.broker, f.c, input, { ...run, attachments: [] }), error => error.status === 409);
  assert.throws(() => f.plan({ attachments: [first.id, first.id] }), error => error.status === 400);
  assert.throws(() => f.plan({ attachments: ['a'.repeat(64)] }), error => error.status === 404);
  const originalContext = automaticReviewContextDigest(f.c);
  f.c.context = { goal: 'A materially different saved goal' };
  assert.notEqual(automaticReviewContextDigest(f.c), originalContext);
  assert.throws(() => validateAutomaticReview(f.broker, f.c, input, run), error => error.status === 409);
  delete f.c.context;
  assert.equal(automaticReviewContextDigest(f.c), plan.contextDigest);
  const attachmentFile = path.join(f.broker.attachments.root, first.id + '.json'), saved = JSON.parse(fs.readFileSync(attachmentFile, 'utf8'));
  fs.writeFileSync(attachmentFile, JSON.stringify({ ...saved, data: Buffer.from('tampered task').toString('base64') }));
  assert.throws(() => validateAutomaticReview(f.broker, f.c, input, run), error => error.status === 409);
});

test('automatic review includes preexisting changes, deleted text and new text while excluding private and binary paths', t => {
  const f = fixture(t);
  f.write('app.js', 'Already edited before authorization\n');
  const plan = f.plan();
  f.write('.env', 'DO_NOT_SHARE=private\n'); f.write('image.bin', Buffer.from([0, 1, 2]));
  f.write('bad-encoding.bin', Buffer.from([0xff, 0xfe]));
  fs.rmSync(path.join(f.folders[0].path, 'app.js')); f.write('new.js', 'new text\n');
  const snapshot = captureAutomaticReview(plan, f.folders);
  assert.deepEqual(snapshot.files.map(file => file.path), ['app.js', 'new.js']);
  assert.equal(snapshot.files.find(file => file.path === 'app.js').contentHash, null);
  assert(!JSON.stringify(snapshot).includes('DO_NOT_SHARE'));
});

test('automatic review refuses partial captures when file, diff or status limits are exceeded', t => {
  const f = fixture(t), plan = f.plan();
  for (let i = 0; i < 13; i++) f.write(`new-${i}.js`, 'text\n');
  assert.throws(() => captureAutomaticReview(plan, f.folders), error => error.status === 413);
  for (let i = 0; i < 13; i++) fs.rmSync(path.join(f.folders[0].path, `new-${i}.js`));
  f.write('large.js', 'x'.repeat(73000));
  assert.throws(() => captureAutomaticReview(plan, f.folders), error => error.status === 413);
  f.write('large.js', 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => captureAutomaticReview(plan, f.folders), error => error.status === 413);
  fs.rmSync(path.join(f.folders[0].path, 'large.js'));
  for (let i = 0; i < 101; i++) f.write(`unreviewable-${i}.bin`, Buffer.from([0, 1, 2]));
  assert.throws(() => captureAutomaticReview(plan, f.folders), error => error.status === 413);
});

test('automatic review skips symlinks without disclosing their targets', { skip: noSymlinks }, t => {
  const f = fixture(t), plan = f.plan();
  const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'PRIVATE_OUTSIDE_CONTENT\n');
  fs.symlinkSync(outside, path.join(f.folders[0].path, 'link.js')); f.write('app.js', 'Allowed change\n');
  const snapshot = captureAutomaticReview(plan, f.folders);
  assert.deepEqual(snapshot.files.map(file => file.path), ['app.js']);
  assert(!JSON.stringify(snapshot).includes('PRIVATE_OUTSIDE_CONTENT'));
});

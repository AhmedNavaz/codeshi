import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCopy, writeCopy } from '../src/memory-instructions.mjs';

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-agents-md-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const folders = [{ id: 'a', name: 'a', path: a }, { id: 'b', name: 'b', path: b }];
  const c = { memory: [
    { id: 'm1', kind: 'convention', text: 'Dates are UTC.', status: 'active', folderId: null },
    { id: 'm2', kind: 'decision', text: 'Use pnpm.\n\n\nNot npm. <!-- sneaky --> end', status: 'active', folderId: 'a' },
    { id: 'm3', kind: 'convention', text: 'Only for b', status: 'active', folderId: 'b' },
    { id: 'm4', kind: 'convention', text: 'Retired one', status: 'retired', folderId: null },
  ] };
  return { a, folders, c, file: path.join(a, 'AGENTS.md') };
};
const copy = (c, folders, input) => { const plan = planCopy(c, folders, input); writeCopy(plan, input.sha256 === undefined ? plan.preview.sha256 : input.sha256); return plan; };

test('Copy to AGENTS.md creates, appends and replaces only its own section', t => {
  const { folders, c, file } = setup(t);
  const created = copy(c, folders, { folderId: 'a', ids: ['m1', 'm2', 'm3', 'm4'] });
  assert.deepEqual(created.preview.ids, ['m1', 'm2'], 'only active memories for this folder or every folder');
  assert.equal(created.preview.exists, false);
  const first = fs.readFileSync(file, 'utf8');
  assert.match(first, /### Conventions\n\n- Dates are UTC\.\n\n### Decisions\n\n- Use pnpm\.\n\n  Not npm\. < !-- sneaky -- > end/);
  assert.equal(first.split('<!-- codeshi:memory -->').length, 2);

  // The person's own text before and after the section is kept byte for byte.
  fs.writeFileSync(file, '# Rules\r\n\r\nKeep this.\r\n\r\n' + first.replaceAll('\n', '\r\n') + '\r\nAnd this after.\r\n');
  const before = fs.readFileSync(file, 'utf8'), replaced = copy(c, folders, { folderId: 'a', ids: ['m1'] });
  assert.ok(replaced.preview.replaces);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith('# Rules\r\n\r\nKeep this.\r\n\r\n<!-- codeshi:memory -->\r\n'));
  assert.ok(after.endsWith('<!-- /codeshi:memory -->\r\n\r\nAnd this after.\r\n'));
  assert.doesNotMatch(after, /pnpm/);
  assert.notEqual(before, after);
  assert.equal(planCopy(c, folders, { folderId: 'a', ids: ['m1'] }).preview.unchanged, true);
});

test('Copy to AGENTS.md appends to an existing file and refuses unsafe writes', t => {
  const { a, folders, c, file } = setup(t);
  fs.writeFileSync(file, '# Team rules\n\nBe kind.\n\n\n');
  const plan = planCopy(c, folders, { folderId: 'a', ids: ['m1'] });
  fs.appendFileSync(file, 'Edited meanwhile.\n');
  assert.throws(() => writeCopy(planCopy(c, folders, { folderId: 'a', ids: ['m1'] }), plan.preview.sha256), /changed after the preview/);
  assert.match(fs.readFileSync(file, 'utf8'), /Edited meanwhile\.\n$/, 'a stale preview writes nothing');
  copy(c, folders, { folderId: 'a', ids: ['m1'] });
  assert.match(fs.readFileSync(file, 'utf8'), /^# Team rules\n\nBe kind\.\n\n\nEdited meanwhile\.\n\n<!-- codeshi:memory -->/);
  assert.deepEqual(fs.readdirSync(a), ['AGENTS.md'], 'no temporary file left behind');

  fs.appendFileSync(file, '\n<!-- codeshi:memory -->\n');
  assert.throws(() => planCopy(c, folders, { folderId: 'a', ids: ['m1'] }), /missing or extra/);
  fs.rmSync(file); fs.symlinkSync(path.join(os.tmpdir(), 'elsewhere.md'), file);
  assert.throws(() => planCopy(c, folders, { folderId: 'a', ids: ['m1'] }), /is a link/);
  assert.throws(() => planCopy(c, folders, { folderId: 'a', ids: [] }), /at least one/);
  assert.throws(() => planCopy(c, folders, { folderId: 'gone', ids: ['m1'] }), /no longer in this workspace/);
});

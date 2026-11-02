import assert from 'node:assert/strict';
import test from 'node:test';
import { diffCounts, fileChanges, lineCounts, toolCounts, toolInput } from '../src/activity-format.mjs';

test('line counts compare the changed middle line by line, and empty text has no lines', () => {
  assert.deepEqual(lineCounts('function a(x) {\n  const y = 1;\n  return y;', 'function a(x, z) {\n  const y = 1;\n  const w = 2;\n  return y + w;'), { added: 3, removed: 2 });
  assert.deepEqual(lineCounts('', 'one\ntwo'), { added: 2, removed: 0 });
  assert.deepEqual(lineCounts('same\nlines', 'same\nlines'), { added: 0, removed: 0 });
  assert.deepEqual(toolCounts('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: '', new_string: 'c\nd' }] }), { added: 3, removed: 1 });
  assert.deepEqual(toolCounts('Write', { content: 'one\ntwo\n' }), { added: 2 });
  assert.equal(toolCounts('Read', { file_path: 'a.js' }), null);
});

test('a long tool input stays one line of valid JSON, keeping its path and line counts', () => {
  const content = Array.from({ length: 2000 }, (_, index) => `line ${index}`).join('\n');
  const short = toolInput('Read', { file_path: '/p/a.js' });
  assert.equal(short, '{"file_path":"/p/a.js"}', 'Short inputs are kept as they are.');
  const long = toolInput('Write', { file_path: '/p/big.js', content });
  assert(long.length <= 12000); assert(!long.includes('\n'));
  const parsed = JSON.parse(long);
  assert.equal(parsed.file_path, '/p/big.js'); assert.deepEqual(parsed.lineCounts, { added: 2000 });
  assert.match(parsed.content, /more characters\]$/);
  const edits = JSON.parse(toolInput('MultiEdit', { file_path: '/p/b.js', edits: Array.from({ length: 30 }, () => ({ old_string: content, new_string: content + '\nmore' })) }));
  assert.equal(edits.file_path, '/p/b.js'); assert.deepEqual(edits.lineCounts, { added: 30, removed: 0 });
});

test('file changes keep path, kind and line counts from either Codex shape, without the diff', () => {
  assert.deepEqual(fileChanges([
    { path: 'new.js', kind: { type: 'add' }, diff: 'one\ntwo\n' },
    { path: 'old.js', kind: { type: 'delete' }, diff: 'gone\n' },
    { path: 'app.js', kind: { type: 'update', move_path: 'src/app.js' }, diff: '@@ -1,2 +1,2 @@\n keep\n-before\n+after\n+extra\n' },
    { path: 'cli.js', kind: 'add' }, { path: 'x.js', kind: 'modify' }, { kind: 'add' },
  ]), [
    { path: 'new.js', kind: 'add', added: 2, removed: 0 }, { path: 'old.js', kind: 'delete', added: 0, removed: 1 },
    { path: 'app.js', kind: 'update', to: 'src/app.js', added: 2, removed: 1 }, { path: 'cli.js', kind: 'add' }, { path: 'x.js', kind: 'update' },
  ]);
  assert.equal(diffCounts('', 'update'), null); assert.deepEqual(fileChanges('not a list'), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSplit, parseSplitCards, SUBTASK_LIMITS } from '../src/subtasks.mjs';

const steps = [
  { title: 'Inspect the command environment', instructions: 'Check discovery.', tier: 'standard' },
  { title: 'Try the app command', instructions: 'Record its result.', tier: 'standard' },
  { title: 'Try the website command', instructions: 'Record its result.', tier: 'deep' },
  { title: 'Review completion', instructions: 'Check the final changes.', tier: 'light' },
];
const payload = JSON.stringify({ cards: [{ card: 1, subtasks: steps }] });
const content = list => list.map(({ title, instructions, tier }) => ({ title, instructions, tier }));

test('split replies recover omitted wrapper closers without losing any subtasks', () => {
  // The reported reply ended in }]}: the subtasks and card were complete, but the outer ]} was missing.
  const reported = payload.slice(0, -2);
  assert.ok(reported.endsWith('}]}'));
  assert.throws(() => JSON.parse(reported));
  for (let missing = 0; missing <= 4; missing++) {
    const reply = missing ? payload.slice(0, -missing) : payload;
    assert.deepEqual(content(parseSplitCards(reply, 1)[0]), steps);
    assert.deepEqual(content(parseSplit(reply)), steps);
  }
  const single = JSON.stringify({ subtasks: steps });
  for (let missing = 1; missing <= 2; missing++) assert.deepEqual(content(parseSplit(single.slice(0, -missing))), steps);
});

test('split replies extract JSON from fences and surrounding prose', () => {
  const reply = ['Use {placeholder} and [] in examples.', '```json', payload.slice(0, -2), '```', 'Done {extra}.'].join('\n');
  assert.deepEqual(content(parseSplitCards(reply, 1)[0]), steps);
  assert.deepEqual(content(parseSplit(`Example {placeholder}.\n${payload}\nDone {extra}.`)), steps);
});

test('split parsing preserves braces, trailing-comma text, escaped quotes and backslashes in instructions', () => {
  const instructions = String.raw`Keep ,} and ,] literally. Use {braces}, [arrays], "quotes" and C:\tools\bin.`;
  const json = JSON.stringify({ subtasks: [{ title: 'Preserve instructions', instructions }] });
  for (const reply of [json, json.replace(/}]}/, '},],}'), json.slice(0, -2)]) {
    assert.equal(parseSplit(reply)[0].instructions, instructions);
    assert.equal(parseSplitCards(reply, 1)[0][0].instructions, instructions);
  }
});

test('split replies accept bare subtask arrays and numbered card arrays', () => {
  const bare = JSON.stringify(steps);
  assert.deepEqual(content(parseSplit(bare)), steps);
  assert.deepEqual(content(parseSplitCards(bare, 1)[0]), steps);
  assert.deepEqual(content(parseSplit(bare.slice(0, -1))), steps);
  const numbered = JSON.stringify([{ card: 2, subtasks: [steps[1]] }, { card: 1, subtasks: [steps[0]] }]);
  assert.deepEqual(parseSplitCards(numbered, 3).map(list => list?.map(item => item.title) ?? null), [[steps[0].title], [steps[1].title], null]);
});

test('split replies reject unfinished subtasks and malformed tails instead of accepting a nested partial list', () => {
  const invalid = [
    '{"subtasks":[{"title":"First"},{"title":"Unfinished',
    '{"subtasks":[{"title":"First"},{"title":"Unfinished"',
    '{"subtasks":[{"title":"First"},',
    '{"subtasks":[{"title":"First","instructions":{}',
    '{"subtasks":[{"title":"First"}],"unfinished":"',
    '{"cards":[{"card":1,"subtasks":[{"title":"First"}]},{"card":2,"subtasks":[{"title":"Unfinished',
    '{"cards":[{"card":1,"subtasks":[{"title":"First"}]}],"unfinished":',
    '{"subtasks":[{"title":"First"}] trailing garbage',
    '{"subtasks":[{"title":"First"}]}'.replace(']}', '}}'),
    'No JSON was returned.',
  ];
  for (const reply of invalid) {
    assert.throws(() => parseSplit(reply), { status: 422 }, reply);
    assert.throws(() => parseSplitCards(reply, 2), { status: 422 }, reply);
  }
});

test('split recovery retains validation and reply limits', () => {
  assert.throws(() => parseSplit('{"subtasks":[]}'), /didn’t return any subtasks/);
  assert.throws(() => parseSplit('{"subtasks":[{"instructions":"Missing title"}]}'), /has no title/);
  assert.throws(() => parseSplitCards('{"cards":[]}', 1), /didn’t return any subtasks/);
  assert.throws(() => parseSplit(JSON.stringify({ subtasks: Array.from({ length: SUBTASK_LIMITS.subtasks + 1 }, () => steps[0]) })), /more than/);
  assert.throws(() => parseSplit(' '.repeat(SUBTASK_LIMITS.reply) + payload), /didn’t return any subtasks/);
  assert.throws(() => parseSplitCards(' '.repeat(SUBTASK_LIMITS.reply * 2) + payload, 2), /didn’t return any subtasks/);
});

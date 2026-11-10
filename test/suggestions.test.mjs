import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseTip, DAILY, dismissTip, flowTip, markShown, memoryTip, skillTip } from '../src/suggestions.mjs';

let seq = 0;
// A conversation where each message started its own finished run.
function conversation(prompts, { model = 'claude-opus-4-6', effort = 'high', routing = null, extra = {} } = {}) {
  const messages = [], runs = [];
  for (const text of prompts) {
    const runId = `run-${++seq}`;
    messages.push({ id: `m-${seq}`, role: 'user', text, runId }, { id: `a-${seq}`, role: 'assistant', text: 'Done.', runId });
    runs.push({ id: runId, provider: 'claude', model, effort, ...(routing ? { routing } : {}), startedAt: '2026-11-10T10:00:00Z', endedAt: '2026-11-10T10:01:00Z', status: 'complete' });
  }
  return { id: 'c1', messages, runs, lastRun: { id: runs.at(-1).id, status: 'complete' }, status: 'complete', ...extra };
}
const NOW = Date.parse('2026-11-10T12:00:00');

test('a rule written in two messages suggests Memory, and not once it is saved', () => {
  const c = conversation(['Fix the login form. Always use pnpm, never npm, in this repo.', 'Now add a reset link.', 'Update the header. Always use pnpm and never npm in this repo!']);
  const tip = memoryTip(c);
  assert.equal(tip.kind, 'memory');
  assert.match(tip.text, /in 2 messages/);
  assert.match(tip.memory.text, /pnpm/);
  assert.equal(tip.memory.messageId, c.messages.at(-2).id);
  assert.equal(memoryTip({ ...c, memory: [{ status: 'active', kind: 'convention', text: 'Always use pnpm, never npm, in this repo.' }] }), null);
  // Only when the latest message repeats it, so it appears at the moment it is useful.
  assert.equal(memoryTip(conversation(['Always use pnpm, never npm, in this repo.', 'Always use pnpm, never npm, in this repo.', 'Add a footer.'])), null);
  assert.equal(memoryTip(conversation(['Add a footer.', 'Add a header.'])), null);
});

test('the same steps in three messages suggest a skill, with the steps to review', () => {
  const steps = '1. Run npm test\n2. Update CHANGELOG.md with the change\n3. Bump the version in package.json';
  const c = conversation([`Release it:\n${steps}`, 'Fix a typo.', `Again please:\n${steps}`, `And once more\n${steps}\n4. Tag the release`]);
  const tip = skillTip(c);
  assert.equal(tip.kind, 'skill');
  assert.match(tip.text, /in 3 messages/);
  assert.equal(tip.skill.steps[0], 'Run npm test');
  assert.equal(tip.skill.messageIds.length, 3);
  assert.equal(skillTip(conversation([`Release it:\n${steps}`, `Again:\n${steps}`])), null, 'twice is not yet several');
  // Not again once a skill was made from those messages.
  assert.equal(skillTip({ ...c, skills: [{ name: 'release', enabled: true, provenance: { messageIds: tip.skill.messageIds } }] }), null);
});

test('small changes sent to a strong model in Normal suggest Flow, with what was seen', () => {
  const c = conversation(['Fix the typo in the README', 'Rename the variable to count', 'Refactor the auth module', 'Quick: reword the log message']);
  const tip = flowTip(c);
  assert.equal(tip.kind, 'flow');
  assert.match(tip.text, /^3 of your last 4 messages looked like small changes/);
  assert.match(tip.text, /claude-opus-4-6 at high effort/);
  assert.doesNotMatch(tip.text, /sav|cheap|fewer tokens/i, 'it promises no saving');
  assert.equal(flowTip({ ...c, routing: { mode: 'smart' } }), null, 'not in Flow');
  assert.equal(flowTip(conversation(['Fix the typo in the README', 'Rename the variable to count', 'Quick: reword the log message'], { model: 'claude-haiku-4-5', effort: 'low' })), null, 'not on a light model');
  assert.equal(flowTip(conversation(['Fix the typo in the README', 'Rename the variable to count', 'Quick: reword the log message', 'Refactor the auth module'])), null, 'only right after one of them');
});

test('one suggestion per pause, never during work, at most a few a day, and dismissed for good', () => {
  const prompts = ['Always use pnpm, never npm, in this repo.', 'Add a header. Always use pnpm, never npm, in this repo.'];
  const c = conversation(prompts);
  assert.equal(chooseTip(c, { on: false, now: NOW }), null);
  assert.equal(chooseTip({ ...c, activeRun: { id: 'x' } }, { now: NOW }), null);
  assert.equal(chooseTip(c, { waiting: true, now: NOW }), null, 'not over an approval or a question');
  assert.equal(chooseTip({ ...c, lastRun: { ...c.lastRun, status: 'failed' } }, { now: NOW }), null);
  const tip = chooseTip(c, { now: NOW });
  assert.equal(tip.kind, 'memory'); assert.equal(tip.runId, c.lastRun.id);

  let tips = markShown(undefined, { key: tip.key, runId: tip.runId, conversationId: c.id, now: NOW });
  assert.equal(chooseTip(c, { tips, now: NOW + 1000 }).key, tip.key, 'stays for this pause');
  // Shown and ignored: after the next run it waits a week.
  const later = { ...c, lastRun: { id: 'next', status: 'complete' } };
  assert.equal(chooseTip(later, { tips, now: NOW + 3600e3 }), null);
  assert.equal(chooseTip(later, { tips, now: NOW + 8 * 86400e3 })?.key, tip.key);
  assert.equal(chooseTip(c, { tips: dismissTip(tips, tip.key), now: NOW }), null, 'dismissed stays away');
  assert.equal(chooseTip(later, { tips: dismissTip(tips, tip.key), now: NOW + 8 * 86400e3 }), null);

  // The daily limit counts every suggestion shown today, in any workspace.
  let full;
  for (let index = 0; index < DAILY; index++) full = markShown(full, { key: `flow:other-${index}`, runId: `r${index}`, conversationId: 'elsewhere', now: NOW - 60e3 });
  assert.equal(chooseTip(c, { tips: full, now: NOW }), null);
  assert.ok(chooseTip(c, { tips: full, now: NOW + 86400e3 }), 'a new day');
});

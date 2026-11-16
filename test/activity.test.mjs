import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { activityPatch, activityPreferences, badgesFor, createActivity, IDLE_MS, noteActivity, summarizeDay } from '../src/activity.mjs';
import { applyBudgetRecord, finishingRun } from '../src/task-budget.mjs';
import { createRelayServer } from '../src/server.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const at = (day, hours, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();
// A store on a clock the test moves. Reports come every 30 seconds unless a test says otherwise.
function setup(t, { start = at(16, 9), preferences = {}, file = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-activity-'));
  const clock = { now: start, busy: false };
  const store = createActivity({ file: file || path.join(directory, 'activity.json'), now: () => clock.now, working: () => clock.busy, preferences: () => preferences });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  // Works for a while: an input before each report.
  const work = (ms, { focused = true, every = 30_000 } = {}) => { for (let done = 0; done < ms; done += every) { clock.now += every; store.beat({ idleMs: 0, focused }); } };
  // Time passes with no input, reported every 30 seconds.
  const idle = (ms, { focused = true } = {}) => { const last = clock.now; for (let done = 0; done < ms; done += 30_000) { clock.now += 30_000; store.beat({ idleMs: clock.now - last, focused }); } };
  return { store, clock, work, idle, directory };
}
const today = store => store.view().months[0].days.find(day => day.date === store.live().today);

test('time counts while you work with Codeshi in front, and reading without input counts once you come back', t => {
  const { store, work, idle } = setup(t);
  store.beat({ idleMs: 0, focused: true });
  work(30 * MINUTE);
  assert.equal(store.live().activeMs, 30 * MINUTE);
  // Three minutes reading an answer: still counting while it passes, and kept when the next input comes.
  idle(3 * MINUTE);
  assert.equal(store.live().counting, true);
  assert.equal(store.live().activeMs, 33 * MINUTE);
  work(30_000);
  assert.equal(store.live().activeMs, 33.5 * MINUTE);
  assert.equal(today(store).breaks, 0);
});

test('five minutes away is a break: the time after your last input is dropped and a new stretch begins', t => {
  const { store, work, idle } = setup(t);
  store.beat({ idleMs: 0, focused: true });
  work(HOUR);
  idle(12 * MINUTE);
  assert.equal(store.live().present, false);
  assert.equal(store.live().activeMs, HOUR, 'the twelve minutes away are not counted, not even the first five');
  assert.equal(store.live().stretchMs, 0);
  store.beat({ idleMs: 0, focused: true });
  work(20 * MINUTE);
  const day = today(store);
  assert.equal(day.activeMs, HOUR + 20 * MINUTE);
  assert.equal(day.breaks, 1);
  assert.equal(day.longestMs, HOUR);
  assert.equal(store.live().stretchMs, 20 * MINUTE);
});

test('time in another app counts only while one of your agents is working', t => {
  const { store, clock, work } = setup(t);
  store.beat({ idleMs: 0, focused: true });
  work(10 * MINUTE);
  work(20 * MINUTE, { focused: false });
  // The report as you left is counted with the time before it; the rest isn't.
  assert.ok(store.live().activeMs <= 10 * MINUTE + 30_000, String(store.live().activeMs));
  const before = store.live().activeMs;
  clock.busy = true;
  work(15 * MINUTE, { focused: false });
  assert.equal(store.live().activeMs, before + 15 * MINUTE);
  assert.equal(today(store).breaks, 0, 'you were at the computer the whole time');
});

test('a stretch across midnight is split between the two days', t => {
  const { store, work } = setup(t, { start: at(16, 23, 50) });
  store.beat({ idleMs: 0, focused: true });
  work(20 * MINUTE);
  const days = store.view().months[0].days;
  assert.deepEqual(days.map(day => [day.date, day.activeMs]), [['2026-11-16', 10 * MINUTE], ['2026-11-17', 10 * MINUTE]]);
  assert.equal(store.live().stretchMs, 20 * MINUTE, 'the stretch goes on across midnight');
});

test('prompts, runs with their tokens, cards, groups, merges and games are counted on the day, and nothing while tracking is off', t => {
  const preferences = {};
  const { store } = setup(t, { preferences });
  noteActivity('prompts'); noteActivity('prompts');
  noteActivity('run', 1200, { provider: 'claude' }); noteActivity('run', 0, { provider: 'codex' }); noteActivity('run', 300, { provider: '../x' });
  noteActivity('cards'); noteActivity('groups'); noteActivity('merges'); noteActivity('games'); noteActivity('nonsense');
  let day = today(store);
  assert.deepEqual([day.prompts, day.runs, day.tokens, day.cards, day.groups, day.merges, day.games], [2, 3, 1500, 1, 1, 1, 1]);
  assert.deepEqual(day.agents, { claude: 1200, other: 300 });
  preferences.track = false;
  noteActivity('prompts');
  assert.deepEqual(store.beat({ idleMs: 0, focused: true }), { tracking: false, settings: { track: false, statusBar: true, reminders: true, every: 60 }, now: store.live().now });
  preferences.track = true;
  day = today(store);
  assert.equal(day.prompts, 2);
});

test('only this month and last month are kept, and a file that cannot be read is set aside', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-activity-file-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'activity.json');
  const old = { work: [[at(1, 9) - 60 * 24 * HOUR, at(1, 10) - 60 * 24 * HOUR]], stretches: [], prompts: 4 };
  fs.writeFileSync(file, JSON.stringify({ version: 1, days: { '2026-09-02': old, '2026-10-30': { prompts: 7, work: [[1, 2], ['x']] }, '2026-11-02': { prompts: 1 } }, announced: ['2026-09:arcade', '2026-11:arcade'] }));
  const { store } = setup(t, { file });
  store.beat({ idleMs: 0, focused: true });
  store.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.days).sort(), ['2026-10-30', '2026-11-02', '2026-11-16']);
  assert.deepEqual(saved.days['2026-10-30'].work, [[1, 2]], 'a span that isn’t two numbers is left out');
  assert.deepEqual(saved.announced, ['2026-11:arcade']);
  store.close();
  fs.writeFileSync(file, '{ not json');
  const next = createActivity({ file, now: () => at(16, 9) });
  t.after(() => next.close());
  assert.equal(next.view().months[0].days.length, 0);
  assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('activity.json.unreadable-')).length, 1);
});

test('badges count the month’s own days and say the day each was earned; none of them rewards long days', () => {
  const day = (date, extra = {}) => ({ ...summarizeDay(date), ...extra });
  const days = [
    day('2026-11-02', { activeMs: 2 * HOUR, prompts: 40, tokens: 1_000_000 }), day('2026-11-03', { activeMs: HOUR, prompts: 40, tokens: 4_000_000 }), day('2026-11-04', { activeMs: HOUR, cards: 6 }),
    day('2026-11-05', { activeMs: HOUR, prompts: 25, cards: 4, tokens: 5_000_000 }), day('2026-11-06', { activeMs: 30_000 }), day('2026-11-08', { activeMs: HOUR }), day('2026-11-09', { activeMs: HOUR, games: 3 }),
  ];
  const badges = Object.fromEntries(badgesFor(days).map(badge => [badge.id, badge]));
  assert.equal(badges['hundred-prompts'].earnedOn, '2026-11-05');
  assert.equal(badges.finisher.earnedOn, '2026-11-05');
  assert.equal(badges['ten-million-tokens'].target, 10_000_000);
  assert.equal(badges['ten-million-tokens'].earnedOn, '2026-11-05');
  assert.equal(badgesFor([day('2026-11-02', { tokens: 1_000_000 })]).find(badge => badge.id === 'ten-million-tokens').earnedOn, null);
  // Five days of one Monday-to-Sunday week, each a minute or more: Nov 6 had thirty seconds, so the week has four.
  assert.equal(badges['steady-week'].value, 5, 'Nov 2–5 and Nov 8 are the same week');
  assert.equal(badges['steady-week'].earnedOn, '2026-11-08');
  assert.equal(badges.arcade.earnedOn, null);
  assert.equal(badges.arcade.value, 3);
  // A good rhythm needs four hours with no stretch past 90 minutes; lunch needs half an hour away around midday.
  const rhythm = summarizeDay('2026-11-10', { work: [[at(10, 9), at(10, 10, 30)], [at(10, 10, 40), at(10, 12)], [at(10, 13), at(10, 14, 30)]], stretches: [[at(10, 9), at(10, 10, 30)], [at(10, 10, 40), at(10, 12)], [at(10, 13), at(10, 14, 30)]] });
  assert.deepEqual([rhythm.activeMs, rhythm.rhythm, rhythm.lunch, rhythm.breaks], [4 * HOUR + 20 * MINUTE, true, true, 2]);
  const long = summarizeDay('2026-11-11', { work: [[at(11, 9), at(11, 14)]], stretches: [[at(11, 9), at(11, 14)]] });
  assert.deepEqual([long.rhythm, long.lunch, long.longestMs], [false, false, 5 * HOUR]);
});

test('a break reminder comes after the interval; Later puts it off 15 minutes and OK until the next interval', t => {
  const preferences = { every: 45 };
  const { store, clock, work } = setup(t, { start: at(16, 15), preferences });
  store.beat({ idleMs: 0, focused: true });
  work(44 * MINUTE);
  assert.equal(store.live().reminder, null);
  assert.equal(store.live().breakInMs, MINUTE);
  work(MINUTE);
  const due = store.live().reminder;
  assert.equal(due.kind, 'break');
  assert.equal(due.stretchMs, 45 * MINUTE);
  assert.equal(store.remind({ action: 'later', id: 'break:stale' }).reminder.id, due.id, 'an answer to an older reminder changes nothing');
  assert.equal(store.remind({ action: 'later', id: due.id }).reminder, null);
  work(14 * MINUTE);
  assert.equal(store.live().reminder, null);
  work(MINUTE);
  const again = store.live().reminder;
  assert.equal(again.kind, 'break');
  store.remind({ action: 'ok', id: again.id });
  work(44 * MINUTE);
  assert.equal(store.live().reminder, null);
  work(MINUTE);
  assert.equal(store.live().reminder?.kind, 'break');
  // None while you're in another app with nothing working, and none once turned off.
  clock.now += 30_000; store.beat({ idleMs: 0, focused: false });
  assert.equal(store.live().reminder, null);
  store.beat({ idleMs: 0, focused: true });
  preferences.reminders = false;
  assert.equal(store.live().reminder, null);
  assert.throws(() => store.remind({ action: 'never', id: 'x' }), /Later or OK/);
});

test('a new stretch after a break starts the interval again', t => {
  const { store, work, idle } = setup(t, { start: at(16, 15) });
  store.beat({ idleMs: 0, focused: true });
  work(50 * MINUTE);
  idle(6 * MINUTE);
  store.beat({ idleMs: 0, focused: true });
  work(50 * MINUTE);
  assert.equal(store.live().reminder, null);
  work(10 * MINUTE);
  assert.equal(store.live().reminder?.kind, 'break');
});

test('lunch around midday, a long day and a late night are each suggested once', t => {
  const { store, clock, work, idle } = setup(t, { start: at(16, 9) });
  store.beat({ idleMs: 0, focused: true });
  work(50 * MINUTE); idle(10 * MINUTE); store.beat({ idleMs: 0, focused: true });
  work(50 * MINUTE); idle(10 * MINUTE); store.beat({ idleMs: 0, focused: true });
  work(55 * MINUTE);
  // 11:55: not lunchtime yet.
  assert.equal(store.live().reminder, null);
  work(30 * MINUTE);
  const lunch = store.live().reminder;
  assert.equal(lunch.kind, 'lunch');
  store.remind({ action: 'ok', id: lunch.id });
  assert.notEqual(store.live().reminder?.kind, 'lunch');
  // Work on into the evening with a break every 50 minutes, until nine hours.
  while (store.live().activeMs < 9 * HOUR) {
    const due = store.live().reminder;
    if (due?.kind === 'break') store.remind({ action: 'ok', id: due.id });
    if (due?.kind === 'long-day') break;
    work(10 * MINUTE);
    if (store.live().stretchMs > 50 * MINUTE) { idle(6 * MINUTE); store.beat({ idleMs: 0, focused: true }); }
  }
  work(MINUTE);
  const long = store.live().reminder;
  assert.equal(long.kind, 'long-day');
  store.remind({ action: 'ok', id: long.id });
  assert.notEqual(store.live().reminder?.kind, 'long-day');
  // Late at night, after twenty minutes of a stretch.
  clock.now = at(16, 23, 30); store.beat({ idleMs: 0, focused: true });
  work(19 * MINUTE);
  assert.equal(store.live().reminder, null);
  work(2 * MINUTE);
  const late = store.live().reminder;
  assert.equal(late.kind, 'late');
  store.remind({ action: 'ok', id: late.id });
  work(40 * MINUTE);
  assert.notEqual(store.live().reminder?.kind, 'late', 'once a night, past midnight too');
});

test('a badge is announced once, and settings are checked before they are saved', t => {
  const { store } = setup(t);
  for (let index = 0; index < 100; index++) noteActivity('prompts');
  assert.deepEqual(store.live().announce.map(item => item.id), ['hundred-prompts']);
  store.seen({ ids: ['hundred-prompts', 'not-a-badge'] });
  assert.deepEqual(store.live().announce, []);
  assert.deepEqual(activityPreferences({}), { track: true, statusBar: true, reminders: true, every: 60 });
  assert.deepEqual(activityPatch({ every: 90, statusBar: false }, { reminders: false }), { track: true, statusBar: false, reminders: false, every: 90 });
  assert.throws(() => activityPatch({ every: 10 }), /30, 45, 60, 90 or 120/);
  assert.throws(() => activityPatch({ track: 'yes' }), /on or off/);
  assert.throws(() => activityPatch(null), /valid work time settings/);
});

test('a run’s new tokens are read as it finishes, the way task limits count them, and a run that never began has none', () => {
  const c = { id: 'conversation', messages: [] }, iso = new Date().toISOString();
  applyBudgetRecord(c, { type: 'submission', id: 'run-1', provider: 'gemini', at: iso, context: { sessionMode: 'fresh' } });
  applyBudgetRecord(c, { type: 'run_metadata', metadata: { usage: { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 9000, cachedWriteTokens: 50 } }, at: iso });
  assert.deepEqual(finishingRun(c, { type: 'run_end', status: 'complete', at: iso }), { provider: 'gemini', tokens: 1550 });
  applyBudgetRecord(c, { type: 'run_end', status: 'complete', at: iso });
  assert.equal(finishingRun(c, { type: 'run_end', status: 'complete', at: iso }), null);
  applyBudgetRecord(c, { type: 'submission', id: 'run-2', provider: 'codex', at: iso, context: { sessionMode: 'fresh' } });
  assert.equal(finishingRun(c, { type: 'run_end', status: 'incomplete', at: iso }), null, 'refused before it started');
});

test('the activity routes report, count games, change settings and clear, and only on the computer', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-activity-http-'));
  fs.mkdirSync(path.join(directory, 'project'));
  const app = createRelayServer({ workspace: path.join(directory, 'project'), dataDir: path.join(directory, 'data'), bins: { codex: process.execPath, claude: process.execPath }, lock: false });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/activity`;
  const post = (route, value, headers = {}) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1', ...headers }, body: JSON.stringify(value) });
  const first = await (await post('/beat', { idleMs: 0, focused: true })).json();
  assert.equal(first.tracking, true);
  assert.equal((await post('/note', { kind: 'prompts' })).status, 400, 'only games are reported by the page');
  assert.equal((await post('/note', { kind: 'games' })).status, 200);
  const view = await (await fetch(url)).json();
  assert.equal(view.months.length, 2);
  assert.equal(view.months[0].totals.games, 1);
  assert.equal((await post('/beat', { idleMs: 0 }, { 'X-AI-Relay': '' })).status, 403, 'the local application header is required');
  assert.equal((await post('/settings', { every: 7 })).status, 400);
  const changed = await (await post('/settings', { every: 90, statusBar: false })).json();
  assert.deepEqual(changed.settings, { track: true, statusBar: false, reminders: true, every: 90 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'data', 'settings.json'), 'utf8')).activity.every, 90);
  const cleared = await (await post('/clear', {})).json();
  assert.equal(cleared.months[0].totals.games, 0);
  assert.equal((await post('/nothing', {})).status, 404);
  assert.ok(IDLE_MS === 5 * MINUTE);
});

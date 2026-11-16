import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { atomicJSON } from './patches.mjs';

// Work time and activity: how long you worked with Codeshi each day, what you did, the breaks you took, and this
// month's badges. Everything stays in activity.json in Codeshi's data folder, for this month and last month only, and
// nothing is sent anywhere.
//
// Working time counts while you are at the computer (a key, click or trackpad touch in the last five minutes) and either
// Codeshi is in front or one of your agents is working. The window reports how long ago your last input was, from the
// system on the desktop app, and this file does the counting, so several reports never count the same time twice.
// - A stretch is time at the computer with no break of five minutes or more. Five minutes away is a break, and the time
//   after your last input is never counted once it is one.
// - The time since your last input counts as it passes, so the clock doesn't stand still while you read an answer. If
//   you turn out to have left, that part is dropped when the five minutes are up, while you are away.
export const IDLE_MS = 5 * 60_000;
const MERGE_MS = 60_000, SAVE_MS = 60_000, SNOOZE_MS = 15 * 60_000, DAY_MS = 86_400_000;
export const REMINDER_MINUTES = [30, 45, 60, 90, 120];
export const defaultActivityPreferences = Object.freeze({ track: true, statusBar: true, reminders: true, every: 60 });
const COUNTS = ['prompts', 'runs', 'tokens', 'cards', 'groups', 'merges', 'games'];

// What happened, reported from anywhere in the app: a prompt you sent, a run's tokens, a card done, a merge, a game.
// With no store listening (tests, the codeshi command) a note goes nowhere.
export const activityEvents = new EventEmitter();
activityEvents.setMaxListeners(50);
export function noteActivity(kind, value = 1, detail = null) {
  if (activityEvents.listenerCount('note')) activityEvents.emit('note', { kind, value, detail });
}

export function activityPreferences(config = {}) {
  const saved = config.activity && typeof config.activity === 'object' ? config.activity : {};
  return {
    track: saved.track !== false, statusBar: saved.statusBar !== false, reminders: saved.reminders !== false,
    every: REMINDER_MINUTES.includes(saved.every) ? saved.every : defaultActivityPreferences.every,
  };
}
export function activityPatch(input, previous = {}) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Choose valid work time settings.');
  const next = activityPreferences({ activity: previous });
  for (const key of ['track', 'statusBar', 'reminders']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') fail('Turn each work time setting on or off.');
    next[key] = input[key];
  }
  if (input.every !== undefined) {
    if (!REMINDER_MINUTES.includes(input.every)) fail('Choose a break reminder every 30, 45, 60, 90 or 120 minutes.');
    next.every = input.every;
  }
  return next;
}

// Days and months in the computer's own time zone.
const pad = value => String(value).padStart(2, '0');
export const dayKey = ms => { const date = new Date(ms); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
export const monthKey = ms => dayKey(ms).slice(0, 7);
const dayStart = ms => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); };
const nextMidnight = ms => { const date = new Date(ms); date.setHours(24, 0, 0, 0); return date.getTime(); };
const atTime = (key, hours, minutes = 0) => { const [year, month, day] = key.split('-').map(Number); return new Date(year, month - 1, day, hours, minutes).getTime(); };
const previousMonth = key => { const [year, month] = key.split('-').map(Number); const date = new Date(year, month - 2, 1); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`; };
const daysIn = key => { const [year, month] = key.split('-').map(Number); return new Date(year, month, 0).getDate(); };
// The night after 11 pm runs until 4 am, so a reminder at 1 am belongs to the evening before.
const nightKey = ms => dayKey(new Date(ms).getHours() < 4 ? ms - 5 * 3_600_000 : ms);

const emptyDay = () => ({ work: [], stretches: [], prompts: 0, runs: 0, tokens: 0, agents: {}, cards: 0, groups: 0, merges: 0, games: 0 });
const length = spans => spans.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
const overlaps = (a, b) => a[0] <= b[1] && b[0] <= a[1];

// One day in numbers. Breaks, the longest stretch and lunch only look at stretches you worked in, so an hour with
// Codeshi open behind other apps doesn't count as a stretch of work.
export function summarizeDay(key, day = emptyDay()) {
  const work = day.work || [], stretches = (day.stretches || []).filter(stretch => work.some(span => overlaps(span, stretch)));
  const activeMs = length(work), lengths = stretches.map(([start, end]) => end - start);
  let lunch = false;
  for (let index = 1; index < stretches.length; index++) {
    const from = stretches[index - 1][1], to = stretches[index][0];
    if (to - from >= 30 * 60_000 && from < atTime(key, 14, 30) && to > atTime(key, 11, 30)) lunch = true;
  }
  const longestMs = lengths.length ? Math.max(...lengths) : 0;
  return {
    date: key, activeMs, breaks: Math.max(0, stretches.length - 1), longestMs, lunch,
    // A good rhythm: four hours or more, with a break at least every 90 minutes.
    rhythm: activeMs >= 4 * 3_600_000 && longestMs <= 90 * 60_000,
    firstAt: work[0]?.[0] ?? null, lastAt: work.at(-1)?.[1] ?? null, spans: work.map(span => [...span]),
    prompts: day.prompts || 0, runs: day.runs || 0, tokens: day.tokens || 0, agents: { ...day.agents },
    cards: day.cards || 0, groups: day.groups || 0, merges: day.merges || 0, games: day.games || 0,
  };
}

// This month's badges. Each counts only the month's own days and starts again on the first, so last month's stay
// beside this month's to compare. None of them rewards long days: three are for breaks and rhythm.
export const BADGES = [
  { id: 'steady-week', target: 5, measure: days => mostInOneWeek(days) },
  { id: 'good-rhythm', target: 5, measure: days => days.filter(day => day.rhythm).length },
  { id: 'lunch-breaks', target: 5, measure: days => days.filter(day => day.lunch).length },
  { id: 'forty-hours', target: 40 * 3_600_000, measure: days => days.reduce((sum, day) => sum + day.activeMs, 0) },
  { id: 'finisher', target: 10, measure: days => days.reduce((sum, day) => sum + day.cards, 0) },
  { id: 'hundred-prompts', target: 100, measure: days => days.reduce((sum, day) => sum + day.prompts, 0) },
  { id: 'ten-million-tokens', target: 10_000_000, measure: days => days.reduce((sum, day) => sum + day.tokens, 0) },
  { id: 'arcade', target: 10, measure: days => days.reduce((sum, day) => sum + day.games, 0) },
];
// Days worked (a minute or more) in the busiest Monday-to-Sunday week.
function mostInOneWeek(days) {
  const weeks = new Map();
  for (const day of days) {
    if (day.activeMs < 60_000) continue;
    const [year, month, date] = day.date.split('-').map(Number), at = new Date(year, month - 1, date), monday = new Date(year, month - 1, date - (at.getDay() + 6) % 7);
    const week = dayKey(monday.getTime()); weeks.set(week, (weeks.get(week) || 0) + 1);
  }
  return weeks.size ? Math.max(...weeks.values()) : 0;
}
export function badgesFor(days) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  return BADGES.map(({ id, target, measure }) => {
    const value = measure(sorted);
    let earnedOn = null;
    // The day it was earned: the first day the month's count up to it reached the target.
    if (value >= target) for (let index = 0; index < sorted.length && !earnedOn; index++) if (measure(sorted.slice(0, index + 1)) >= target) earnedOn = sorted[index].date;
    return { id, value, target, earnedOn };
  });
}
export function monthSummary(key, summaries) {
  const days = summaries.filter(day => day.date.startsWith(key + '-')), totals = { activeMs: 0, daysWorked: 0, breaks: 0, longestMs: 0, agents: {} };
  for (const name of COUNTS) totals[name] = 0;
  for (const day of days) {
    totals.activeMs += day.activeMs; totals.breaks += day.breaks; totals.longestMs = Math.max(totals.longestMs, day.longestMs);
    if (day.activeMs >= 60_000) totals.daysWorked++;
    for (const name of COUNTS) totals[name] += day[name];
    for (const [agent, tokens] of Object.entries(day.agents)) totals.agents[agent] = (totals.agents[agent] || 0) + tokens;
  }
  return { month: key, length: daysIn(key), days, totals, badges: badgesFor(days) };
}

function readStore(file) {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    // A file that can't be read is kept beside a fresh one, so nothing is lost by starting again.
    if (error.code !== 'ENOENT') try { fs.renameSync(file, `${file}.unreadable-${Date.now()}`); } catch { /* Starting fresh anyway. */ }
  }
  const store = { version: 1, days: {}, reminders: {}, announced: [] };
  if (!saved || typeof saved !== 'object') return store;
  const spans = list => Array.isArray(list) ? list.filter(span => Array.isArray(span) && span.length === 2 && span.every(Number.isFinite) && span[1] >= span[0]).map(span => [span[0], span[1]]) : [];
  for (const [key, day] of Object.entries(saved.days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !day || typeof day !== 'object') continue;
    const clean = emptyDay(); clean.work = spans(day.work); clean.stretches = spans(day.stretches);
    for (const name of COUNTS) clean[name] = Number.isFinite(day[name]) && day[name] > 0 ? day[name] : 0;
    for (const [agent, tokens] of Object.entries(day.agents || {})) if (/^[a-z]{2,20}$/.test(agent) && Number.isFinite(tokens) && tokens > 0) clean.agents[agent] = tokens;
    store.days[key] = clean;
  }
  if (saved.reminders && typeof saved.reminders === 'object') store.reminders = saved.reminders;
  if (Array.isArray(saved.announced)) store.announced = saved.announced.filter(item => typeof item === 'string');
  return store;
}

export function createActivity({ file, now = Date.now, working = () => false, preferences = () => defaultActivityPreferences }) {
  let store = readStore(file), dirty = false, timer = null, prunedFor = null;
  // What the last report said: when your last input was, and whether you were working with Codeshi then.
  let input = null, engaged = false;
  const prefs = () => activityPreferences({ activity: preferences() });

  function save() { clearTimeout(timer); timer = null; if (!dirty) return; dirty = false; try { atomicJSON(file, store); } catch (error) { console.error('Codeshi could not save activity:', error.message); } }
  const later = () => { dirty = true; if (!timer) { timer = setTimeout(save, SAVE_MS); timer.unref?.(); } };
  // Only this month and last month are kept.
  function prune(t) {
    const month = monthKey(t);
    if (prunedFor === month) return;
    prunedFor = month;
    const oldest = previousMonth(month);
    for (const key of Object.keys(store.days)) if (key.slice(0, 7) < oldest) { delete store.days[key]; dirty = true; }
    const kept = store.announced.filter(item => item.slice(0, 7) >= oldest);
    if (kept.length !== store.announced.length) { store.announced = kept; dirty = true; }
    if (dirty) later();
  }
  const day = (key, create = true) => store.days[key] || (create ? (store.days[key] = emptyDay()) : null);
  // Adds [start, end] to the days it covers, split at midnight, joined to the span before it when they touch.
  function add(kind, start, end) {
    let from = start;
    for (;;) {
      const until = Math.min(end, nextMidnight(from)), list = day(dayKey(from))[kind], last = list.at(-1);
      if (last && from >= last[0] && from - last[1] <= MERGE_MS) last[1] = Math.max(last[1], until);
      else list.push([from, until]);
      if (until >= end) break;
      from = until;
    }
  }
  function lastStretch(t) {
    for (let back = 0; back < 2; back++) { const found = store.days[dayKey(dayStart(t) - back * DAY_MS)]?.stretches.at(-1); if (found) return found; }
    return null;
  }
  // Where the stretch you're in began, across midnight.
  function stretchStart(t) {
    const last = lastStretch(t); if (!last) return null;
    let start = last[0];
    for (let back = 1; back < 3 && start === dayStart(start); back++) {
      const before = store.days[dayKey(start - 1)]?.stretches.at(-1);
      if (!before || start - before[1] > MERGE_MS) break;
      start = before[0];
    }
    return start;
  }
  const present = t => input !== null && t - input < IDLE_MS;
  // Today's working time, with the time since your last input while it is still counting.
  function activeToday(t) {
    const today = store.days[dayKey(t)], counted = today ? length(today.work) : 0, last = lastStretch(t);
    if (!engaged || !present(t) || !last) return counted;
    return counted + Math.max(0, Math.min(t, last[1] + IDLE_MS) - Math.max(last[1], dayStart(t)));
  }

  function beat({ idleMs = 0, focused = false } = {}) {
    const t = now();
    if (!prefs().track) { input = null; engaged = false; return live(); }
    prune(t);
    const idle = Number.isFinite(idleMs) ? Math.min(Math.max(0, idleMs), 7 * DAY_MS) : 0, at = t - idle;
    let busy = false; try { busy = Boolean(working()); } catch { /* Counted as not working. */ }
    const here = t - at < IDLE_MS, using = focused === true || busy, last = lastStretch(t);
    if (here) {
      if (last && at >= last[1] && at - last[1] < IDLE_MS) {
        if (at > last[1]) { const from = last[1]; add('stretches', from, at); if (using || engaged) add('work', from, at); later(); }
      } else if (!last || at - last[1] >= IDLE_MS) { add('stretches', at, at); later(); }
    }
    input = Math.max(at, input ?? at); engaged = here && using;
    return live();
  }

  function note({ kind, value = 1, detail = null } = {}) {
    if (!prefs().track) return;
    const t = now(); prune(t);
    const today = day(dayKey(t));
    if (kind === 'run') {
      today.runs++;
      const tokens = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
      if (tokens) { today.tokens += tokens; const agent = typeof detail?.provider === 'string' && /^[a-z]{2,20}$/.test(detail.provider) ? detail.provider : 'other'; today.agents[agent] = (today.agents[agent] || 0) + tokens; }
    } else if (['prompts', 'cards', 'groups', 'merges', 'games'].includes(kind)) today[kind]++;
    else return;
    later();
  }

  // A reminder due now, while you are working with Codeshi: a late night, a long day, lunch, or a break.
  function reminder(t) {
    const settings = prefs();
    if (!settings.track || !settings.reminders || !engaged || !present(t)) return null;
    const saved = store.reminders || {};
    if (saved.snoozedUntil > t) return null;
    const today = dayKey(t), hour = new Date(t).getHours() + new Date(t).getMinutes() / 60, start = stretchStart(t);
    if (start === null) return null;
    const stretchMs = t - start, active = activeToday(t);
    if ((hour >= 23 || hour < 4) && saved.late !== nightKey(t) && stretchMs >= 20 * 60_000) return { kind: 'late', id: `late:${nightKey(t)}`, stretchMs, activeMs: active };
    if (active >= 9 * 3_600_000 && saved.long !== today) return { kind: 'long-day', id: `long:${today}`, stretchMs, activeMs: active };
    if (hour >= 12 && hour < 14.5 && saved.lunch !== today && active >= 2 * 3_600_000 && stretchMs >= 20 * 60_000 && !summarizeDay(today, store.days[today]).lunch) return { kind: 'lunch', id: `lunch:${today}`, stretchMs, activeMs: active };
    const next = nextBreak(start, settings);
    if (t >= next) return { kind: 'break', id: `break:${start}:${next}`, stretchMs, activeMs: active, tip: Math.floor(start / 60_000) };
    return null;
  }
  // When the stretch you're in is due a break reminder: the interval after it began, or after you last answered one.
  const nextBreak = (start, settings = prefs()) => { const saved = store.reminders?.break; return saved?.stretch === start ? saved.next : start + settings.every * 60_000; };
  // Later puts every reminder off for 15 minutes; OK puts this one away: a break until the next interval, the others
  // until tomorrow.
  function remind({ action, id } = {}) {
    const t = now(), due = reminder(t);
    if (!['later', 'ok'].includes(action)) throw Object.assign(new Error('Choose Later or OK.'), { status: 400 });
    if (!due || due.id !== id) return live();
    const saved = store.reminders ||= {};
    if (action === 'later') saved.snoozedUntil = t + SNOOZE_MS;
    else if (due.kind === 'break') saved.break = { stretch: stretchStart(t), next: t + prefs().every * 60_000 };
    else if (due.kind === 'late') saved.late = nightKey(t);
    else if (due.kind === 'long-day') saved.long = dayKey(t);
    else saved.lunch = dayKey(t);
    later();
    return live();
  }

  function summaries() { return Object.entries(store.days).map(([key, value]) => summarizeDay(key, value)).sort((a, b) => a.date.localeCompare(b.date)); }
  // Badges earned this month that haven't been announced yet.
  function unannounced(t, month = null) {
    const key = monthKey(t), badges = month || monthSummary(key, summaries().filter(day => day.date.startsWith(key))).badges;
    return badges.filter(badge => badge.earnedOn && !store.announced.includes(`${key}:${badge.id}`)).map(badge => ({ month: key, id: badge.id, earnedOn: badge.earnedOn }));
  }
  // What the status bar and reminders need, on every report.
  function live() {
    const t = now(), settings = prefs();
    if (!settings.track) return { tracking: false, settings, now: t };
    prune(t);
    const start = stretchStart(t), here = present(t), snoozed = store.reminders?.snoozedUntil > t ? store.reminders.snoozedUntil : 0;
    return { tracking: true, settings, now: t, today: dayKey(t), activeMs: activeToday(t), counting: engaged && here, present: here,
      stretchMs: here && start !== null ? t - start : 0,
      // How long until the next break reminder, after Later or OK moved it; null while you're away.
      breakInMs: here && start !== null ? Math.max(nextBreak(start, settings), snoozed) - t : null,
      reminder: reminder(t), announce: unannounced(t) };
  }
  // The whole view: today, and every day of this month and last month with their totals and badges.
  function view() {
    const t = now(), current = live(), all = summaries(), month = monthKey(t), last = previousMonth(month);
    const today = all.find(item => item.date === current.today);
    if (today && current.tracking) today.activeMs = current.activeMs;
    return { ...current, months: [monthSummary(month, all), monthSummary(last, all)] };
  }
  function seen({ ids = [] } = {}) {
    const month = monthKey(now());
    for (const id of Array.isArray(ids) ? ids : []) if (BADGES.some(badge => badge.id === id) && !store.announced.includes(`${month}:${id}`)) store.announced.push(`${month}:${id}`);
    later(); return live();
  }
  function clear() { store = { version: 1, days: {}, reminders: {}, announced: [] }; input = null; engaged = false; dirty = true; save(); return view(); }

  const listener = event => { try { note(event); } catch (error) { console.error('Codeshi could not count activity:', error.message); } };
  activityEvents.on('note', listener);
  function close() { activityEvents.off('note', listener); save(); }
  return { beat, note, live, view, remind, seen, clear, flush: save, close };
}

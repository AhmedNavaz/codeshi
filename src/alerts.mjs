// Alerts: how Codeshi tells you about work while you are in another app. Every alert is one of three moments: an
// agent needs you, a task finished or a task stopped. Each way of telling you (a banner, a sound, the Dock icon
// bouncing, a count on the Dock icon and a notification on a paired phone) is turned on or off as a whole, and for each moment. The menu bar status is
// one more switch: it shows what is happening all the time rather than announcing it. The desktop app follows these
// rules for banners and the Dock, and the page plays the sounds, so sounds also work in the browser.
import { randomUUID } from 'node:crypto';

export const MOMENTS = ['attention', 'finished', 'stopped'];
export const CHANNELS = ['banner', 'sound', 'bounce', 'badge', 'phone'];
// Which moment each kind of alert belongs to. Progress reports, such as continuing after a usage limit resets or
// waiting for another reset, show and count like their moment but play no sound.
const MOMENT_OF = { approval: 'attention', handoff: 'attention', finished: 'finished', started: 'finished', scheduled: 'finished', stopped: 'stopped', failed: 'stopped', expired: 'stopped', waiting: 'stopped', missed: 'stopped' };
const QUIET = new Set(['started', 'waiting', 'scheduled']);
export const momentOf = kind => MOMENT_OF[kind] || null;

const every = value => Object.fromEntries(MOMENTS.map(moment => [moment, value]));
// Banners, the Dock and the menu bar status are on until turned off, and sounds are off until turned on. A banner is
// a system notification unless `panel` shows it near the top of the screen instead. `progressPill` keeps a small
// pill under the menu bar while agents work (#75), whichever way banners show and with or without the menu bar
// status. A new installation turns it on; one from before it existed keeps it off until turned on.
export const alertDefaults = Object.freeze({
  banner: Object.freeze({ on: true, ...every(true), panel: false }),
  sound: Object.freeze({ on: false, ...every(true), volume: 70, background: false }),
  bounce: Object.freeze({ on: true, ...every(true) }),
  badge: Object.freeze({ on: true, ...every(true) }),
  // A phone paired Away from home gets a lock-screen notification only after it turns them on itself.
  phone: Object.freeze({ on: true, ...every(true) }),
  statusItem: true,
  progressPill: false,
});
const copy = value => ({ ...value, ...Object.fromEntries(CHANNELS.map(channel => [channel, { ...value[channel] }])) });
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// Whether one setting of a way is known and of the right type: on, each moment, and the few that belong to one way.
function valid(channel, key, value) {
  if (key === 'on' || MOMENTS.includes(key)) return typeof value === 'boolean';
  if (channel === 'banner' && key === 'panel') return typeof value === 'boolean';
  if (channel === 'sound' && key === 'background') return typeof value === 'boolean';
  if (channel === 'sound' && key === 'volume') return Number.isInteger(value) && value >= 0 && value <= 100;
  return false;
}

// Saved settings, with anything missing or unreadable falling back to its default. Settings saved before alerts were
// chosen per way kept one switch for banners and the Dock bounce, sounds in an object of their own, and the panel as
// `overlay`; they read the same way they worked.
export function alertPreferences(saved = {}) {
  const value = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}, result = copy(alertDefaults);
  if (typeof value.enabled === 'boolean') result.banner.on = result.bounce.on = value.enabled;
  if (typeof value.overlay === 'boolean') result.banner.panel = value.overlay;
  if (typeof value.sound === 'boolean') result.sound.on = value.sound;
  if (value.sounds && typeof value.sounds === 'object' && !Array.isArray(value.sounds)) for (const [key, item] of Object.entries(value.sounds)) if (key !== 'on' && valid('sound', key, item)) result.sound[key] = item;
  for (const channel of CHANNELS) {
    const saved = value[channel];
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
    for (const [key, item] of Object.entries(saved)) if (valid(channel, key, item)) result[channel][key] = item;
  }
  if (typeof value.statusItem === 'boolean') result.statusItem = value.statusItem;
  if (typeof value.progressPill === 'boolean') result.progressPill = value.progressPill;
  return result;
}

// A change from Settings or a menu, checked whole before any of it is kept: only known settings, of the right type.
export function mergeAlertPreferences(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('Alert settings must be an object.');
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'statusItem') { if (typeof value !== 'boolean') fail('Turn the status icon on or off.'); continue; }
    if (key === 'progressPill') { if (typeof value !== 'boolean') fail('Turn the progress pill on or off.'); continue; }
    if (!CHANNELS.includes(key)) fail('Unknown alert setting.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Alert settings must be an object.');
    for (const [name, item] of Object.entries(value)) if (!valid(key, name, item)) fail(key === 'sound' && name === 'volume' ? 'Volume must be a whole number from 0 to 100.' : 'Turn each alert on or off.');
  }
  const next = copy(current);
  for (const [key, value] of Object.entries(patch)) { if (key === 'statusItem' || key === 'progressPill') next[key] = value; else Object.assign(next[key], value); }
  return next;
}

// Where one alert goes. While Codeshi is in front, the page shows what happened, so nothing goes outside the
// window. A banner is the panel near the top of the screen when that is chosen and the panel is there, or else a
// system notification, never both. Whether a sound plays in front of you is the page's choice, as it knows.
export function alertPlan(notice, preferences, { focused = false, panelAvailable = true } = {}) {
  const moment = momentOf(notice?.kind), on = channel => Boolean(moment && preferences?.[channel]?.on && preferences[channel][moment]);
  const banner = !focused && on('banner'), panel = banner && preferences.banner.panel === true && panelAvailable;
  return { moment, badge: !focused && on('badge'), bounce: !focused && on('bounce'), notification: banner && !panel, panel, sound: !QUIET.has(notice?.kind) && on('sound') && preferences.sound.volume > 0 };
}

// Try it in Settings › Alerts: what one moment would do right now, as chosen, with a made-up example to show. It is
// planned as if Codeshi weren't in front, since that is when alerts come; the page plays the sound itself.
const SAMPLES = {
  attention: ['handoff', 'Example: an agent needs you', 'This is how Codeshi tells you an approval or a question is waiting.'],
  finished: ['finished', 'Example: task finished', 'This is how Codeshi tells you a task is done.'],
  stopped: ['stopped', 'Example: task stopped', 'This is how Codeshi tells you a task stopped with an error, a limit or failing tests.'],
};
export function alertSample(moment, preferences, { panelAvailable = true, t = value => value } = {}) {
  const sample = Object.hasOwn(SAMPLES, String(moment)) ? SAMPLES[moment] : null;
  if (!sample) return null;
  const [kind, title, body] = sample;
  return { moment, kind, title: t(title), body: t(body), plan: alertPlan({ kind }, preferences, { focused: false, panelAvailable }) };
}
// The pill as it reads while an agent works, for Show the pill.
export const pillSample = (t = value => value) => ({ kind: 'progress', title: t('Codex · Editing · 2 files changed'), body: t('Example') });

// Whether the pill under the menu bar may show live progress (#75). It is a choice of its own, like the menu bar
// status: either, both or neither. Whether Codeshi is in front, and whether anything is running, is decided where it shows.
export const progressPillOn = preferences => preferences?.progressPill === true;

// What a phone's lock screen shows for one alert, or null for none. Anyone holding the phone can read it, so it says
// only what kind of thing happened and in which workspace: never a command, a file, a question or the agent's reply.
const PHONE_TITLE = { approval: 'Waiting for you', handoff: 'Handoff offered', finished: 'Finished', started: 'Continuing', stopped: 'Stopped', failed: 'Stopped', expired: 'Request expired', waiting: 'Waiting for a usage reset', scheduled: 'Scheduled run started', missed: 'A scheduled run didn’t start' };
export function alertPush(notice, preferences) {
  const moment = momentOf(notice?.kind);
  if (!moment || !preferences?.phone?.on || !preferences.phone[moment]) return null;
  const workspace = typeof notice.projectName === 'string' ? notice.projectName.trim().slice(0, 80) : '';
  return {
    moment, urgency: moment === 'attention' ? 'high' : 'normal',
    // An approval keeps waiting, so its notification may arrive later; a finished run is old news after an hour.
    ttl: moment === 'attention' ? 12 * 3600 : 3600,
    message: { title: PHONE_TITLE[notice.kind], body: workspace, tag: `${moment}:${notice.projectId || ''}`, ...(typeof notice.projectId === 'string' ? { projectId: notice.projectId } : {}) },
  };
}

// What the page is told for one alert, or null for no sound. Each moment has its own sound.
export function alertSound(notice, preferences) {
  const plan = alertPlan(notice, preferences);
  if (!plan.sound) return null;
  return { id: randomUUID(), sound: plan.moment, volume: preferences.sound.volume, background: preferences.sound.background, kind: notice.kind, ...(notice.projectId ? { projectId: notice.projectId } : {}) };
}

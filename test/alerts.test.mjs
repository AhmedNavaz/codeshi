import assert from 'node:assert/strict';
import test from 'node:test';
import { alertDefaults, alertPlan, alertPreferences, alertSound, mergeAlertPreferences, momentOf } from '../src/alerts.mjs';

const plain = value => JSON.parse(JSON.stringify(value));

test('alerts default to banners and the Dock for every moment, with sounds off until turned on', () => {
  assert.deepEqual(alertPreferences(), {
    banner: { on: true, attention: true, finished: true, stopped: true, panel: false },
    sound: { on: false, attention: true, finished: true, stopped: true, volume: 70, background: false },
    bounce: { on: true, attention: true, finished: true, stopped: true },
    badge: { on: true, attention: true, finished: true, stopped: true },
    statusItem: true,
  });
  const read = alertPreferences(); read.banner.on = false;
  assert.equal(alertDefaults.banner.on, true, 'Reading settings never changes the defaults.');
});

test('settings saved by earlier versions read the way they worked', () => {
  // "Notify when runs finish or need approval" covered banners and the Dock bounce together; the panel was `overlay`.
  const off = alertPreferences({ enabled: false, overlay: true, statusItem: false });
  assert.deepEqual([off.banner.on, off.bounce.on, off.badge.on, off.banner.panel, off.statusItem], [false, false, true, true, false]);
  // Sounds had a switch of their own and an object with each kind, the volume and "only when not in front".
  const sounds = alertPreferences({ sound: true, sounds: { attention: true, finished: false, stopped: true, background: true, volume: 40 } });
  assert.deepEqual(sounds.sound, { on: true, attention: true, finished: false, stopped: true, volume: 40, background: true });
  assert.deepEqual(alertPreferences({ sounds: { volume: 25, chime: true, finished: 'no' } }).sound, { ...alertDefaults.sound, volume: 25 }, 'Unknown or broken old settings fall back to the defaults.');
  // Once saved in the current shape, the old keys are gone and the new ones are read as they are.
  assert.deepEqual(alertPreferences({ banner: { on: false, finished: false, panel: true, extra: true }, sound: { on: true, volume: 101 }, statusItem: 'yes' }).banner, { on: false, attention: true, finished: false, stopped: true, panel: true });
  assert.equal(alertPreferences({ sound: { on: true, volume: 101 } }).sound.volume, 70);
  for (const broken of [null, 'on', [], { banner: [] }, { badge: 'off' }]) assert.deepEqual(alertPreferences(broken), plain(alertDefaults), JSON.stringify(broken));
});

test('a change is checked whole before any of it is kept, and changes only what it names', () => {
  const current = alertPreferences();
  const next = mergeAlertPreferences(current, { bounce: { finished: false }, sound: { on: true, volume: 35 }, statusItem: false });
  assert.deepEqual([next.bounce, next.sound.on, next.sound.volume, next.sound.attention, next.statusItem], [{ on: true, attention: true, finished: false, stopped: true }, true, 35, true, false]);
  assert.equal(current.bounce.finished, true, 'The current settings are not changed in place.');
  for (const wrong of [null, [], 'on', { banners: { on: true } }, { banner: true }, { banner: { on: 'yes' } }, { banner: { volume: 10 } }, { bounce: { panel: true } }, { badge: { background: true } }, { sound: { volume: 101 } }, { sound: { volume: 2.5 } }, { sound: { chime: true } }, { statusItem: 'yes' }, { enabled: false }])
    assert.throws(() => mergeAlertPreferences(current, wrong), error => error.status === 400, JSON.stringify(wrong));
  assert.throws(() => mergeAlertPreferences(current, { banner: { on: false }, sound: { volume: 500 } }), /Volume/);
  assert.equal(current.banner.on, true, 'A change with a mistake in it keeps nothing.');
});

test('each kind of alert belongs to a moment; progress reports show like their moment but play no sound', () => {
  assert.deepEqual(['approval', 'handoff', 'finished', 'started', 'stopped', 'failed', 'expired', 'waiting', 'other'].map(momentOf), ['attention', 'attention', 'finished', 'finished', 'stopped', 'stopped', 'stopped', 'stopped', null]);
  const everything = mergeAlertPreferences(alertPreferences(), { sound: { on: true } });
  assert.deepEqual(alertPlan({ kind: 'started' }, everything), { moment: 'finished', badge: true, bounce: true, notification: true, panel: false, sound: false });
  assert.deepEqual(alertPlan({ kind: 'other' }, everything), { moment: null, badge: false, bounce: false, notification: false, panel: false, sound: false }, 'An alert of an unknown kind goes nowhere.');
});

test('an alert goes only the ways turned on for its moment, and nowhere outside the window while it is in front', () => {
  const preferences = mergeAlertPreferences(alertPreferences(), { sound: { on: true, finished: false }, bounce: { finished: false }, badge: { on: false } });
  assert.deepEqual(alertPlan({ kind: 'approval' }, preferences), { moment: 'attention', badge: false, bounce: true, notification: true, panel: false, sound: true });
  assert.deepEqual(alertPlan({ kind: 'finished' }, preferences), { moment: 'finished', badge: false, bounce: false, notification: true, panel: false, sound: false });
  assert.deepEqual(alertPlan({ kind: 'approval' }, preferences, { focused: true }), { moment: 'attention', badge: false, bounce: false, notification: false, panel: false, sound: true }, 'In front, the page shows it; whether a sound plays there is the page’s choice.');
  const quiet = mergeAlertPreferences(preferences, { banner: { on: false }, bounce: { on: false } });
  assert.deepEqual(alertPlan({ kind: 'stopped' }, quiet), { moment: 'stopped', badge: false, bounce: false, notification: false, panel: false, sound: true }, 'A way turned off keeps its moments but is skipped.');
  assert.equal(alertPlan({ kind: 'approval' }, mergeAlertPreferences(preferences, { sound: { volume: 0 } })).sound, false, 'No volume plays nothing.');
});

test('a banner is the panel near the top of the screen when chosen and there, or else a notification, never both', () => {
  const panel = mergeAlertPreferences(alertPreferences(), { banner: { panel: true } });
  assert.deepEqual([alertPlan({ kind: 'finished' }, panel).panel, alertPlan({ kind: 'finished' }, panel).notification], [true, false]);
  assert.deepEqual([alertPlan({ kind: 'finished' }, panel, { panelAvailable: false }).panel, alertPlan({ kind: 'finished' }, panel, { panelAvailable: false }).notification], [false, true], 'Where there is no panel, such as on Windows, the notification shows.');
  const off = mergeAlertPreferences(panel, { banner: { stopped: false } });
  assert.deepEqual([alertPlan({ kind: 'failed' }, off).panel, alertPlan({ kind: 'failed' }, off).notification], [false, false]);
});

test('the page is told which sound to play, at what volume and whether only when Codeshi is not in front', () => {
  const preferences = mergeAlertPreferences(alertPreferences(), { sound: { on: true, volume: 40, background: true } });
  const sound = alertSound({ kind: 'handoff', projectId: 'p1' }, preferences);
  assert.match(sound.id, /^[\da-f-]{36}$/);
  assert.deepEqual({ ...sound, id: null }, { id: null, sound: 'attention', volume: 40, background: true, kind: 'handoff', projectId: 'p1' });
  assert.equal(alertSound({ kind: 'expired' }, preferences).sound, 'stopped');
  assert.equal(alertSound({ kind: 'waiting' }, preferences), null, 'Waiting for another reset reports progress, quietly.');
  assert.equal(alertSound({ kind: 'finished' }, alertPreferences()), null, 'Sounds are off until turned on.');
});

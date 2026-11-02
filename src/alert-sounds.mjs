// Sound alerts: a short sound when an agent needs you, finishes, or stops. The page plays it, so it works in the
// desktop app and the browser alike, without notification permission. This decides which sound an alert gets.
import { randomUUID } from 'node:crypto';

// Which sound each kind of alert plays. Kinds that only report progress, like continuing after a reset, play none.
export const ALERT_SOUNDS = { approval: 'attention', handoff: 'attention', finished: 'finished', stopped: 'stopped', failed: 'stopped', expired: 'stopped' };
export const SOUNDS = ['attention', 'finished', 'stopped'];
export const soundDefaults = Object.freeze({ attention: true, finished: true, stopped: true, background: false, volume: 70 });
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// Saved settings, with anything missing or unreadable falling back to its default.
export function soundSettings(saved = {}) {
  const value = saved && typeof saved === 'object' ? saved : {};
  const result = { ...soundDefaults };
  for (const key of [...SOUNDS, 'background']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (Number.isInteger(value.volume) && value.volume >= 0 && value.volume <= 100) result.volume = value.volume;
  return result;
}
// A change from Settings or the menu: only known settings, each of the right type.
export function soundPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('Sound settings must be an object.');
  for (const [key, value] of Object.entries(patch)) {
    if ([...SOUNDS, 'background'].includes(key)) { if (typeof value !== 'boolean') fail('Turn each sound on or off.'); }
    else if (key === 'volume') { if (!Number.isInteger(value) || value < 0 || value > 100) fail('Volume must be a whole number from 0 to 100.'); }
    else fail('Unknown sound setting.');
  }
  return patch;
}
// What the page is told for one alert, or null for no sound.
export function alertSound(notice, preferences) {
  const sound = ALERT_SOUNDS[notice?.kind];
  if (!preferences?.sound || !sound || !preferences.sounds?.[sound] || !preferences.sounds.volume) return null;
  return { id: randomUUID(), sound, volume: preferences.sounds.volume, background: preferences.sounds.background, kind: notice.kind, ...(notice.projectId ? { projectId: notice.projectId } : {}) };
}

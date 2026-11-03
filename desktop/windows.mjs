import fs from 'node:fs';
import path from 'node:path';

export const APP_ID = 'local.throughline.desktop';

// Windows shows an app's notifications only when a Start menu shortcut carries the app ID the app runs under. The
// installer adds the shortcut; Codeshi adds its ID, and points the shortcut at this copy if it was moved or unzipped
// somewhere else. The shortcut from before the rename, Throughline.lnk, goes once it is known to be this app's.
export function ensureStartMenuShortcut({ shell, programs, target, appId = APP_ID, exists = fs.existsSync, remove = file => fs.rmSync(file, { force: true }) }) {
  const link = path.join(programs, 'Codeshi.lnk'), legacy = path.join(programs, 'Throughline.lnk');
  if (exists(legacy)) {
    try { const old = shell.readShortcutLink(legacy); if (old.appUserModelId === appId || /(^|[\\/])Throughline\.exe$/i.test(old.target || '')) remove(legacy); }
    catch { /* A shortcut that can't be read is left as it is. */ }
  }
  let current = null;
  if (exists(link)) { try { current = shell.readShortcutLink(link); } catch { current = null; } }
  if (current && current.target === target && current.appUserModelId === appId) return { link, changed: false };
  const written = shell.writeShortcutLink(link, current ? 'replace' : 'create', { target, cwd: path.dirname(target), appUserModelId: appId, description: 'Codeshi' });
  if (!written) throw new Error('Windows did not save the Start menu shortcut.');
  return { link, changed: true };
}

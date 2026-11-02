import fs from 'node:fs';
import path from 'node:path';

export const APP_ID = 'local.throughline.desktop';

// Windows shows an app's notifications only when a Start menu shortcut carries the app ID the app runs under. The
// installer adds the shortcut; Throughline adds its ID, and points the shortcut at this copy if it was moved or unzipped
// somewhere else.
export function ensureStartMenuShortcut({ shell, programs, target, appId = APP_ID, exists = fs.existsSync }) {
  const link = path.join(programs, 'Throughline.lnk');
  let current = null;
  if (exists(link)) { try { current = shell.readShortcutLink(link); } catch { current = null; } }
  if (current && current.target === target && current.appUserModelId === appId) return { link, changed: false };
  const written = shell.writeShortcutLink(link, current ? 'replace' : 'create', { target, cwd: path.dirname(target), appUserModelId: appId, description: 'Throughline' });
  if (!written) throw new Error('Windows did not save the Start menu shortcut.');
  return { link, changed: true };
}

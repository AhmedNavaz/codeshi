import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reasons a test cannot run on this system, for `test(name, { skip }, fn)`; false where it can.

// Many tests stand in for an agent CLI with a script that starts with #!. Windows starts only programs, so it cannot
// run these stand-ins; the code they cover is the same on every system and is tested on macOS.
export const scriptCLIs = process.platform === 'win32' && 'Windows cannot start a #! script standing in for an agent CLI';

// Windows creates symbolic links only with Developer Mode on or administrator rights.
export const noSymlinks = (() => {
  if (process.platform !== 'win32') return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-symlink-check-'));
  try { fs.writeFileSync(path.join(root, 'target'), ''); fs.symlinkSync(path.join(root, 'target'), path.join(root, 'link')); return false; }
  catch { return 'Creating symbolic links on Windows needs Developer Mode or administrator rights'; }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
})();

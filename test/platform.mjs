// Reasons a test cannot run on this system, for `test(name, { skip }, fn)`; false where it can.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Many tests stand in for an agent CLI with a script that starts with #!. Windows starts only programs, so it cannot
// run these stand-ins; the code they cover is the same on every system and is tested on macOS.
export const scriptCLIs = process.platform === 'win32' && 'Windows cannot start a #! script standing in for an agent CLI';

// Windows creates symbolic links only with Developer Mode on or administrator rights (CI runners have them), so the
// checks that links never lead outside a workspace try once to make a file and a folder link, and skip only if that fails.
// Directory junctions need no rights, and the tests that make one run everywhere: on other systems it's a folder link.
function linksAllowed() {
  if (process.platform !== 'win32') return true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-links-'));
  try {
    fs.writeFileSync(path.join(root, 'file'), ''); fs.mkdirSync(path.join(root, 'folder'));
    fs.symlinkSync(path.join(root, 'file'), path.join(root, 'file-link'), 'file');
    fs.symlinkSync(path.join(root, 'folder'), path.join(root, 'folder-link'), 'dir');
    return true;
  } catch { return false; } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
export const noSymlinks = !linksAllowed() && 'This Windows account cannot create symbolic links; turn on Developer Mode to run these checks';

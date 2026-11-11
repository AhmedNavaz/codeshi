// The codeshi command (#90) reaches the open app through cli.json in the app's data folder: the engine's local address,
// its access token and the app's process ID. Only this user can read it, and it goes when the app quits. Installing the
// command links /usr/local/bin/codeshi to bin/codeshi inside the app, as other Mac apps install theirs.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const connectionFile = userData => path.join(userData, 'cli.json');
export const COMMAND_LINK = '/usr/local/bin/codeshi';

export function writeConnection(file, { url, token, pid = process.pid, version }) {
  const temporary = `${file}.${pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, url, token, pid, appVersion: version })}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

// Only the app that wrote the file removes it, so a second copy quitting doesn't cut off the one still open.
export function removeConnection(file, pid = process.pid) {
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file, { force: true }); } catch { /* Nothing to remove. */ }
}

// installed: the link points at this app's command. other: something else already has the name.
export function commandState({ link = COMMAND_LINK, target }) {
  let stat;
  try { stat = fs.lstatSync(link); } catch { return 'missing'; }
  if (!stat.isSymbolicLink()) return 'other';
  try { return fs.realpathSync(link) === fs.realpathSync(target) ? 'installed' : 'other-link'; } catch { return 'other-link'; }
}

const shellQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
const appleScriptString = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
// macOS asks for an administrator's password when /usr/local/bin isn't writable, which is usual on Apple silicon.
const asAdministrator = (script, prompt) => new Promise((resolve, reject) => {
  execFile('/usr/bin/osascript', ['-e', `do shell script ${appleScriptString(script)} with prompt ${appleScriptString(prompt)} with administrator privileges`], error => {
    if (!error) return resolve(true);
    // -128: the person cancelled the password dialog.
    if (/-128/.test(String(error.message))) return resolve(false);
    reject(error);
  });
});

export async function installCommand({ link = COMMAND_LINK, target, elevate = asAdministrator }) {
  const state = commandState({ link, target });
  if (state === 'installed') return { installed: true, changed: false };
  if (state === 'other') throw new Error(`${link} already exists and isn't from Codeshi. Remove it, then try again.`);
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (state === 'other-link') fs.rmSync(link);
    fs.symlinkSync(target, link);
    return { installed: true, changed: true };
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
  }
  const done = await elevate(`mkdir -p ${shellQuote(path.dirname(link))} && ln -sfn ${shellQuote(target)} ${shellQuote(link)}`, 'Codeshi wants to add the codeshi command.');
  return { installed: done && commandState({ link, target }) === 'installed', changed: done, cancelled: !done };
}

export async function uninstallCommand({ link = COMMAND_LINK, target, elevate = asAdministrator }) {
  if (commandState({ link, target }) !== 'installed') return { removed: false };
  try { fs.rmSync(link); return { removed: true }; }
  catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
  const done = await elevate(`rm -f ${shellQuote(link)}`, 'Codeshi wants to remove the codeshi command.');
  return { removed: done && commandState({ link, target }) === 'missing', cancelled: !done };
}

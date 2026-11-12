// The codeshi command (#90) reaches the open app through cli.json in the app's data folder: the engine's local address,
// its access token and the app's process ID. Only this user can read it, and it goes when the app quits. Installing the
// command links /usr/local/bin/codeshi to bin/codeshi inside the app, as other Mac apps install theirs. On Windows it
// writes codeshi.cmd, a two-line launcher for bin\codeshi.cmd inside the app, into the user's WindowsApps folder, which
// Windows keeps on every user's PATH: no administrator, no PATH edit, and it works in terminals that are already open.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const connectionFile = userData => path.join(userData, 'cli.json');
export const COMMAND_LINK = '/usr/local/bin/codeshi';
export const windowsCommandLink = (env = process.env) => path.win32.join(env.LOCALAPPDATA || path.win32.join(env.USERPROFILE || 'C:\\', 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'codeshi.cmd');
const defaultLink = platform => platform === 'win32' ? windowsCommandLink() : COMMAND_LINK;
// The launcher's second line says whose it is, so Codeshi replaces or removes only its own.
const LAUNCHER_MARK = "rem Codeshi's codeshi command.";
export const windowsLauncher = target => `@echo off\r\n${LAUNCHER_MARK} Installed from Codeshi's File menu, which also removes it.\r\n"${String(target).replaceAll('%', '%%')}" %*\r\n`;
const onPath = (folder, env) => String(env.PATH || env.Path || '').split(';').some(entry => entry.trim().replace(/[\\/]+$/, '').toLowerCase() === folder.toLowerCase());

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
export function commandState({ platform = process.platform, link = defaultLink(platform), target }) {
  if (platform === 'win32') {
    let text;
    try { text = fs.readFileSync(link, 'utf8'); } catch (error) { return error.code === 'ENOENT' ? 'missing' : 'other'; }
    return text === windowsLauncher(target) ? 'installed' : text.includes(LAUNCHER_MARK) ? 'other-link' : 'other';
  }
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

export async function installCommand({ platform = process.platform, link = defaultLink(platform), target, elevate = asAdministrator, env = process.env }) {
  const state = commandState({ platform, link, target });
  if (state === 'installed') return { installed: true, changed: false };
  if (state === 'other') throw new Error(`${link} already exists and isn't from Codeshi. Remove it, then try again.`);
  if (platform === 'win32') {
    const folder = path.win32.dirname(link);
    if (/["\r\n]/.test(target)) throw new Error("The codeshi command can't be installed from this folder. Move Codeshi to a folder without quotation marks in its name.");
    if (!onPath(folder, env)) throw new Error(`${folder} isn't on your PATH, so a command there wouldn't be found. Add it to your PATH in Windows' environment variables, restart Codeshi, then try again.`);
    fs.mkdirSync(folder, { recursive: true });
    const temporary = `${link}.${process.pid}.tmp`;
    try { fs.writeFileSync(temporary, windowsLauncher(target)); fs.renameSync(temporary, link); }
    catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    return { installed: true, changed: true };
  }
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (state === 'other-link') fs.rmSync(link);
    fs.symlinkSync(target, link);
    return { installed: true, changed: true };
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
  }
  const done = await elevate(`mkdir -p ${shellQuote(path.dirname(link))} && ln -sfn ${shellQuote(target)} ${shellQuote(link)}`, 'Codeshi wants to add the codeshi command.');
  return { installed: done && commandState({ platform, link, target }) === 'installed', changed: done, cancelled: !done };
}

export async function uninstallCommand({ platform = process.platform, link = defaultLink(platform), target, elevate = asAdministrator }) {
  if (commandState({ platform, link, target }) !== 'installed') return { removed: false };
  if (platform === 'win32') { fs.rmSync(link); return { removed: true }; }
  try { fs.rmSync(link); return { removed: true }; }
  catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
  const done = await elevate(`rm -f ${shellQuote(link)}`, 'Codeshi wants to remove the codeshi command.');
  return { removed: done && commandState({ platform, link, target }) === 'missing', cancelled: !done };
}

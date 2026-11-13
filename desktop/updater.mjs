import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { atomicJSON } from '../src/patches.mjs';
import { compareVersions, versionPattern } from './updates.mjs';

// Updates from GitHub Releases, for the macOS and Windows builds the release workflow publishes. A newer release is
// offered, never installed unasked. Installing downloads the zip for this computer, checks it against the release's
// SHA256SUMS.txt and checks the app inside, then a small helper replaces the app once Codeshi has quit and opens the
// new version. Codeshi never restarts while an agent works.
// - macOS: the app's version, bundle ID and signature are checked. Files the app downloads itself are not marked as
//   downloaded from the internet, so the updated app opens without the security prompt a browser download gets.
// - Windows: builds are not signed yet, so the checksum is the check, as in install.ps1, with the folder's Codeshi.exe
//   and the version in its package.json. The update is unpacked beside the installed folder, so the swap is a rename on
//   the same drive, and a PowerShell helper does it once Codeshi and its helper processes have let go of the folder.
export const REPOSITORY = 'AhmedNavaz/codeshi';
export const PACKAGE_NAME = 'codeshi';
export const BUNDLE_ID = 'local.throughline.desktop';
// Codeshi was called Throughline. Release files may come from the repository under either name, since GitHub sends
// the old one to the new after a rename, and the zip and the app inside may carry either name.
const REPOSITORIES = [REPOSITORY, 'AhmedNavaz/throughline'], NAMES = ['Codeshi', 'Throughline'];
const fromRepository = (url, part) => typeof url === 'string' && REPOSITORIES.some(repository => url.startsWith(`https://github.com/${repository}/${part}`));
const CHECK_INTERVAL = 6 * 60 * 60 * 1000, FIRST_CHECK = 15 * 1000;
const MAX_DOWNLOAD = 1024 * 1024 * 1024, MAX_CHECKSUMS = 64 * 1024;

// Apple Silicon Macs get the Apple Silicon build, also when this copy runs as the Intel build under Rosetta. Windows has
// one build, x64, which Windows on Arm runs too.
export function updateBuild({ arch, translated = false, platform = 'darwin' }) {
  if (platform === 'win32') return 'windows-x64';
  return arch === 'arm64' || translated ? 'apple-silicon' : 'intel';
}
const windowsBuild = build => String(build).startsWith('windows-');
const archiveName = (name, version, build) => windowsBuild(build) ? `${name}-${version}-${build}.zip` : `${name}-${version}-mac-${build}.zip`;

// The running app bundle, and why it cannot be replaced in place: macOS runs an app opened straight from Downloads from
// a read-only copy (App Translocation), and a folder the person cannot write to needs an administrator.
export function bundleLocation(executable, access = fs.accessSync) {
  const bundle = path.resolve(executable, '..', '..', '..');
  if (!bundle.endsWith('.app')) return { bundle: null, blocked: 'not-bundle' };
  if (bundle.includes('/AppTranslocation/')) return { bundle, blocked: 'translocated' };
  try { access(path.dirname(bundle), fs.constants.W_OK); access(bundle, fs.constants.W_OK); }
  catch { return { bundle, blocked: 'read-only' }; }
  return { bundle, blocked: null };
}

// The running Windows app's folder, the one install.ps1 makes (…\Programs\Codeshi with Codeshi.exe in it), and why it
// cannot be replaced: a zip opened in Explorer without extracting runs from a temporary copy, and a folder such as
// Program Files needs an administrator. Windows decides write access by the folder's permissions, which fs.accessSync
// does not read, so a file is written and removed to find out.
export function windowsLocation(executable, { temporary = os.tmpdir(), probe = canWrite } = {}) {
  const exe = path.win32.basename(executable);
  if (exe.toLowerCase() !== 'codeshi.exe') return { bundle: null, blocked: 'not-bundle' };
  const bundle = path.win32.dirname(executable), inside = (folder, parent) => { const relative = path.win32.relative(parent, folder); return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.win32.isAbsolute(relative); };
  if (temporary && inside(bundle, temporary)) return { bundle, blocked: 'temporary' };
  if (!probe(path.win32.dirname(bundle)) || !probe(bundle)) return { bundle, blocked: 'read-only' };
  return { bundle, blocked: null };
}
function canWrite(folder) {
  const file = path.join(folder, `.codeshi-write-${process.pid}-${Date.now()}`);
  try { fs.writeFileSync(file, ''); fs.rmSync(file, { force: true }); return true; } catch { return false; }
}
// Beside the installed folder: the unpacked update waiting to move in, and the previous version during the swap.
const siblings = bundle => ({ update: `${bundle}.update`, previous: `${bundle}.previous` });

// The expected hash of one file in a SHA256SUMS.txt written by sha256sum: "<hash>  <file>" per line.
export function checksumFor(text, file) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2] === file) return match[1].toLowerCase();
  }
  return null;
}

// The newest published release, with the files this Mac needs. Release assets must come from this repository.
export function releaseFrom(json, build) {
  if (!json || json.draft || json.prerelease || typeof json.tag_name !== 'string') return null;
  const version = json.tag_name.replace(/^v/, '');
  if (!versionPattern.test(version)) return null;
  const asset = name => (json.assets || []).find(item => item?.name === name && fromRepository(item.browser_download_url, 'releases/download/'));
  const file = NAMES.map(name => archiveName(name, version, build)).find(asset) || archiveName('Codeshi', version, build);
  const archive = asset(file), sums = asset('SHA256SUMS.txt');
  const notesUrl = fromRepository(json.html_url, 'releases/') ? json.html_url : `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
  return { version, notesUrl, publishedAt: typeof json.published_at === 'string' ? json.published_at : null, file, url: archive?.browser_download_url || null, size: Number.isSafeInteger(archive?.size) ? archive.size : null, checksumsUrl: sums?.browser_download_url || null };
}

// Waits for Codeshi to quit, moves the installed app aside, moves the verified new app into its place and opens it.
// If the new app cannot be moved in, the previous one is put back and opened instead.
export const HELPER = `#!/bin/sh
pid=$1 target=$2 staged=$3 previous=$4
shift 4
log() { printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1"; }
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 1200 ]; then log "Codeshi did not quit, so the update was not installed."; exit 1; fi
  sleep 0.1
done
rm -rf "$previous"
if ! mv "$target" "$previous"; then log "The installed app could not be moved aside."; "$@" "$target"; exit 1; fi
if mv "$staged" "$target"; then
  log "Installed the update."
  rm -rf "$previous"
else
  log "The update could not be moved into place, so the previous version was restored."
  rm -rf "$target"
  mv "$previous" "$target"
fi
"$@" "$target"
`;

// The Windows helper, run by Windows PowerShell 5.1, which every supported Windows has. It waits for Codeshi to quit,
// then retries the rename for up to 30 seconds, since Codeshi's own helper processes can hold files in its folder for a
// moment after it has gone. Renames on one drive move a folder whole or not at all. If the new version cannot move in,
// the previous one is put back. Open is the Codeshi.exe to start afterwards, or "-" for none. ASCII only: Windows
// PowerShell reads a script without a byte order mark in the system's code page.
export const WINDOWS_HELPER = `param([int]$ProcessId, [string]$Target, [string]$Staged, [string]$Previous, [string]$Open)
$ErrorActionPreference = 'Stop'
function Log([string]$message) { Write-Output ((Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') + ' ' + $message) }
function Reopen { if ($Open -and $Open -ne '-') { try { Start-Process -FilePath $Open -WorkingDirectory (Split-Path -Parent $Open) } catch { Log ('Codeshi could not be opened: ' + $_.Exception.Message) } } }
$waited = 0
while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
  $waited++
  if ($waited -gt 1200) { Log 'Codeshi did not quit, so the update was not installed.'; exit 1 }
  Start-Sleep -Milliseconds 100
}
if (Test-Path -LiteralPath $Previous) { Remove-Item -LiteralPath $Previous -Recurse -Force -ErrorAction SilentlyContinue }
$moved = $false
for ($try = 0; $try -lt 100 -and -not $moved; $try++) {
  try { Move-Item -LiteralPath $Target -Destination $Previous; $moved = $true } catch { Start-Sleep -Milliseconds 300 }
}
if (-not $moved) { Log 'The installed app could not be moved aside.'; Reopen; exit 1 }
try {
  Move-Item -LiteralPath $Staged -Destination $Target
  Log 'Installed the update.'
  Remove-Item -LiteralPath $Previous -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Split-Path -Parent $Staged) -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  Log 'The update could not be moved into place, so the previous version was restored.'
  if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue }
  Move-Item -LiteralPath $Previous -Destination $Target
}
Reopen
`;
const powershell = () => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsTar = () => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
function launchHelper(platform) {
  return (script, args, log) => {
    const out = fs.openSync(log, 'a');
    const [file, list] = platform === 'win32' ? [powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...args]] : ['/bin/sh', [script, ...args]];
    // The helper starts in the updates folder, never in the folder it is about to move.
    spawn(file, list, { detached: true, windowsHide: true, cwd: path.dirname(script), stdio: ['ignore', out, out] }).unref();
    fs.closeSync(out);
  };
}

const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout))));

export function createUpdater({
  version, build, location, directory, platform = process.platform, supported = true,
  fetchImpl = globalThis.fetch, exec = run, launch = launchHelper(platform),
  busy = () => false, quit = () => {}, onState = () => {}, now = () => Date.now(), timers = { setTimeout, clearTimeout }, pid = process.pid,
}) {
  const windows = platform === 'win32';
  const preferencesFile = path.join(directory, 'preferences.json');
  let preferences = { automatic: true, skipped: null, checkedAt: null };
  try { const saved = JSON.parse(fs.readFileSync(preferencesFile, 'utf8')); preferences = { automatic: saved.automatic !== false, skipped: typeof saved.skipped === 'string' && versionPattern.test(saved.skipped) ? saved.skipped : null, checkedAt: typeof saved.checkedAt === 'string' ? saved.checkedAt : null }; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const enabled = supported && (platform === 'darwin' || windows) && Boolean(location?.bundle);
  let status = 'idle', latest = null, error = null, progress = null, staged = null, controller = null, timer = null, checking = null, lastProgress = 0;
  // The installer runs after Codeshi has gone, so the next launch is the first chance to say it failed. It says so once.
  const installLog = path.join(directory, 'install.log');
  let installFailed = false;
  if (enabled) try {
    installFailed = /did not quit|could not be moved/.test(fs.readFileSync(installLog, 'utf8').trimEnd().split('\n').at(-1));
    if (installFailed) fs.appendFileSync(installLog, `${new Date(now()).toISOString()} Told the person at launch.\n`);
  } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }

  const save = () => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); atomicJSON(preferencesFile, { version: 1, ...preferences }); };
  const state = () => ({
    version, supported: enabled, automatic: preferences.automatic, skipped: preferences.skipped, checkedAt: preferences.checkedAt,
    status, error, progress, blocked: location?.blocked || null, installFailed,
    latest: latest && { version: latest.version, notesUrl: latest.notesUrl, publishedAt: latest.publishedAt },
  });
  const emit = () => onState(state());
  const set = (next, details = {}) => { status = next; error = details.error ?? null; progress = details.progress ?? null; emit(); };

  function schedule(delay = CHECK_INTERVAL) {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (!enabled || !preferences.automatic) return;
    timer = timers.setTimeout(() => { timer = null; check().catch(() => {}).finally(() => schedule()); }, delay);
    timer?.unref?.();
  }

  async function check() {
    if (!enabled) return state();
    if (['downloading', 'ready', 'waiting', 'installing'].includes(status)) return state();
    if (checking) return checking;
    checking = (async () => {
      set('checking');
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Codeshi/${version}` }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub is limiting update checks right now. Try again later.' : `GitHub answered ${response.status}.`);
        const release = releaseFrom(await response.json(), build);
        if (!release) throw new Error('The latest release could not be read.');
        preferences.checkedAt = new Date(now()).toISOString(); save();
        if (compareVersions(release.version, version) > 0) { latest = release; set('available'); }
        else { latest = null; set('current'); }
      } catch (failure) {
        set('error', { error: failure.name === 'TimeoutError' ? 'GitHub did not answer in time. Check your connection and try again.' : /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(failure.message) ? 'GitHub could not be reached. Check your connection and try again.' : failure.message });
      } finally { checking = null; }
      return state();
    })();
    return checking;
  }

  // Streams the zip to disk while hashing it, so a large download never sits in memory.
  async function download(release, file) {
    const response = await fetchImpl(release.url, { signal: controller.signal, headers: { 'User-Agent': `Codeshi/${version}` } });
    if (!response.ok || !response.body) throw new Error(`The download failed (${response.status}).`);
    const total = Number(response.headers.get('content-length')) || release.size || null;
    if (total && total > MAX_DOWNLOAD) throw new Error('The download is larger than expected.');
    const hash = createHash('sha256'), out = fs.openSync(file, 'w', 0o600);
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > MAX_DOWNLOAD) throw new Error('The download is larger than expected.');
        hash.update(chunk); fs.writeSync(out, chunk);
        if (now() - lastProgress > 200) { lastProgress = now(); set('downloading', { progress: { received, total } }); }
      }
    } finally { fs.closeSync(out); }
    set('downloading', { progress: { received, total } });
    return hash.digest('hex');
  }

  async function stage(release) {
    const work = path.join(directory, `download-${release.version}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    const zip = path.join(work, release.file);
    const actual = await download(release, zip);
    const sums = await fetchImpl(release.checksumsUrl, { signal: controller.signal, headers: { 'User-Agent': `Codeshi/${version}` } });
    if (!sums.ok) throw new Error(`The checksums could not be downloaded (${sums.status}).`);
    const text = await sums.text();
    if (text.length > MAX_CHECKSUMS) throw new Error('The checksums file is larger than expected.');
    const expected = checksumFor(text, release.file);
    if (!expected || expected !== actual) throw new Error('The download does not match its published checksum, so nothing was installed.');
    if (windows) return stageWindows(release, work, zip);
    const unpacked = path.join(work, 'app');
    await exec('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
    fs.rmSync(zip, { force: true });
    const app = NAMES.map(name => path.join(unpacked, `${name}.app`)).find(bundle => fs.existsSync(path.join(bundle, 'Contents', 'Info.plist')));
    if (!app) throw new Error('The download does not contain Codeshi.app.');
    const plist = path.join(app, 'Contents', 'Info.plist');
    const read = async key => (await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).trim();
    if (await read('CFBundleIdentifier') !== BUNDLE_ID || await read('CFBundleShortVersionString') !== release.version) throw new Error('The downloaded app is not the expected version of Codeshi.');
    try { await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]); }
    catch { throw new Error('The downloaded app’s signature could not be verified, so nothing was installed.'); }
    await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {});
    return { version: release.version, app, work };
  }

  // Windows: unpacked beside the installed folder with the system's tar, which reads zip files, then checked: one
  // Codeshi folder with Codeshi.exe, and Codeshi's package.json at the release's version.
  async function stageWindows(release, work, zip) {
    const unpacked = siblings(location.bundle).update;
    fs.rmSync(unpacked, { recursive: true, force: true });
    fs.mkdirSync(unpacked, { recursive: true });
    try { await exec(windowsTar(), ['-xf', zip, '-C', unpacked]); }
    catch { throw new Error('The update could not be unpacked, so nothing was installed.'); }
    fs.rmSync(work, { recursive: true, force: true });
    const app = path.join(unpacked, 'Codeshi');
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(app, 'resources', 'app', 'package.json'), 'utf8')); } catch {}
    if (!fs.existsSync(path.join(app, 'Codeshi.exe')) || !manifest) throw new Error('The download does not contain Codeshi.exe.');
    if (manifest.name !== PACKAGE_NAME || manifest.version !== release.version) throw new Error('The downloaded app is not the expected version of Codeshi.');
    return { version: release.version, app, work: unpacked };
  }

  // Hands the swap to the helper; the helper puts the new version in place once this process has exited. Restarting
  // opens it, and quitting with an update ready leaves it in place for the next launch.
  function swap({ reopen = true } = {}) {
    if (!staged || status === 'installing') return;
    set('installing');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const log = path.join(directory, 'install.log');
    if (windows) {
      const script = path.join(directory, 'install-update.ps1');
      fs.writeFileSync(script, WINDOWS_HELPER, { mode: 0o700 });
      launch(script, [String(pid), location.bundle, staged.app, siblings(location.bundle).previous, reopen ? path.join(location.bundle, 'Codeshi.exe') : '-'], log);
    } else {
      const script = path.join(directory, 'install-update.sh'), previous = path.join(directory, 'previous', 'Codeshi.app');
      fs.mkdirSync(path.dirname(previous), { recursive: true, mode: 0o700 });
      fs.writeFileSync(script, HELPER, { mode: 0o700 });
      launch(script, [String(pid), location.bundle, staged.app, previous, reopen ? '/usr/bin/open' : '/usr/bin/true'], log);
    }
    if (reopen) quit();
  }

  // Downloads the update and checks it, then waits as ready: the person restarts when they choose.
  async function install() {
    if (!enabled) throw new Error('This copy of Codeshi can’t update itself.');
    if (location.blocked) throw new Error({ translocated: 'Move Codeshi to your Applications folder to install updates.', temporary: 'Codeshi is running from a temporary folder. Install it with the installer to get updates.' }[location.blocked] || 'Codeshi can’t replace itself in this folder. Download the update instead.');
    if (['downloading', 'ready', 'waiting', 'installing'].includes(status)) return state();
    if (!latest) throw new Error('There is no update to install.');
    if (staged?.version === latest.version) { set('ready'); return state(); }
    controller = new AbortController();
    set('downloading', { progress: { received: 0, total: latest.size } });
    try {
      staged = await stage(latest);
    } catch (failure) {
      const cancelled = controller.signal.aborted;
      controller = null;
      fs.rmSync(path.join(directory, `download-${latest.version}`), { recursive: true, force: true });
      if (windows) fs.rmSync(siblings(location.bundle).update, { recursive: true, force: true });
      if (cancelled) { set('available'); return state(); }
      set('error', { error: failure.message || 'The update could not be downloaded.' });
      return state();
    }
    controller = null;
    set('ready');
    return state();
  }

  // Restarting into a ready update never stops an agent: it happens now, or once no agent is working.
  function restart() {
    if (!staged || !['ready', 'waiting'].includes(status)) return state();
    if (busy()) set('waiting'); else swap();
    return state();
  }

  // Called when runs start or finish: a restart that is waiting goes ahead once no agent is working.
  function idle() { if (status === 'waiting' && !busy()) swap(); }

  // Quitting with an update ready installs it as Codeshi closes, without opening it again.
  function finishOnQuit() { if (staged && ['ready', 'waiting'].includes(status)) swap({ reopen: false }); }

  function cancel() {
    if (status === 'downloading') controller?.abort();
    else if (status === 'waiting') set('ready');
    return state();
  }

  function skip(skipped) {
    if (!versionPattern.test(String(skipped))) throw new Error('Choose a version to skip.');
    preferences.skipped = skipped; save(); emit(); return state();
  }

  function setAutomatic(automatic) {
    if (typeof automatic !== 'boolean') throw new Error('Automatic checks must be on or off.');
    preferences.automatic = automatic; save(); schedule(automatic ? FIRST_CHECK : undefined); emit(); return state();
  }

  // A previous attempt's files are removed at launch; a finished update leaves nothing behind.
  if (enabled) for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory) : []) if (/^(download-|previous$|install-update\.(sh|ps1)$)/.test(entry)) fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  // On Windows the leftovers sit beside the installed folder. Codeshi is running from that folder, so a previous
  // version kept there by an interrupted swap is no longer needed.
  if (enabled && windows && !location.blocked) for (const leftover of Object.values(siblings(location.bundle))) fs.rmSync(leftover, { recursive: true, force: true });
  schedule(FIRST_CHECK);
  return { state, check, install, restart, cancel, skip, setAutomatic, idle, finishOnQuit, dispose() { if (timer) timers.clearTimeout(timer); controller?.abort(); } };
}

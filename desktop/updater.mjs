import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { atomicJSON } from '../src/patches.mjs';
import { compareVersions, versionPattern } from './updates.mjs';

// Updates from GitHub Releases, for the macOS builds the release workflow publishes. A newer release is offered, never
// installed unasked. Installing downloads the zip for this Mac, checks it against the release's SHA256SUMS.txt and checks
// the app inside (its version, bundle ID and signature), then a small helper replaces the app once Throughline has quit
// and opens the new version. Files the app downloads itself are not marked as downloaded from the internet, so the
// updated app opens without the security prompt a browser download gets. Throughline never restarts while an agent works.
export const REPOSITORY = 'AhmedNavaz/throughline';
const BUNDLE_ID = 'local.throughline.desktop';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000, FIRST_CHECK = 15 * 1000;
const MAX_DOWNLOAD = 1024 * 1024 * 1024, MAX_CHECKSUMS = 64 * 1024;

// Apple Silicon Macs get the Apple Silicon build, also when this copy runs as the Intel build under Rosetta.
export function updateBuild({ arch, translated = false }) { return arch === 'arm64' || translated ? 'apple-silicon' : 'intel'; }

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
  const prefix = `https://github.com/${REPOSITORY}/releases/download/`;
  const asset = name => (json.assets || []).find(item => item?.name === name && typeof item.browser_download_url === 'string' && item.browser_download_url.startsWith(prefix));
  const file = `Throughline-${version}-mac-${build}.zip`, archive = asset(file), sums = asset('SHA256SUMS.txt');
  const notesUrl = typeof json.html_url === 'string' && json.html_url.startsWith(`https://github.com/${REPOSITORY}/releases/`) ? json.html_url : `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
  return { version, notesUrl, publishedAt: typeof json.published_at === 'string' ? json.published_at : null, file, url: archive?.browser_download_url || null, size: Number.isSafeInteger(archive?.size) ? archive.size : null, checksumsUrl: sums?.browser_download_url || null };
}

// Waits for Throughline to quit, moves the installed app aside, moves the verified new app into its place and opens it.
// If the new app cannot be moved in, the previous one is put back and opened instead.
export const HELPER = `#!/bin/sh
pid=$1 target=$2 staged=$3 previous=$4
shift 4
log() { printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1"; }
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 1200 ]; then log "Throughline did not quit, so the update was not installed."; exit 1; fi
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

const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout))));

export function createUpdater({
  version, build, location, directory, platform = process.platform, supported = true,
  fetchImpl = globalThis.fetch, exec = run, launch = (script, args, log) => { const out = fs.openSync(log, 'a'); spawn('/bin/sh', [script, ...args], { detached: true, stdio: ['ignore', out, out] }).unref(); fs.closeSync(out); },
  busy = () => false, quit = () => {}, onState = () => {}, now = () => Date.now(), timers = { setTimeout, clearTimeout }, pid = process.pid,
}) {
  const preferencesFile = path.join(directory, 'preferences.json');
  let preferences = { automatic: true, skipped: null, checkedAt: null };
  try { const saved = JSON.parse(fs.readFileSync(preferencesFile, 'utf8')); preferences = { automatic: saved.automatic !== false, skipped: typeof saved.skipped === 'string' && versionPattern.test(saved.skipped) ? saved.skipped : null, checkedAt: typeof saved.checkedAt === 'string' ? saved.checkedAt : null }; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const enabled = supported && platform === 'darwin' && Boolean(location?.bundle);
  let status = 'idle', latest = null, error = null, progress = null, staged = null, controller = null, timer = null, checking = null, lastProgress = 0;

  const save = () => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); atomicJSON(preferencesFile, { version: 1, ...preferences }); };
  const state = () => ({
    version, supported: enabled, automatic: preferences.automatic, skipped: preferences.skipped, checkedAt: preferences.checkedAt,
    status, error, progress, blocked: location?.blocked || null,
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
    if (['downloading', 'waiting', 'installing'].includes(status)) return state();
    if (checking) return checking;
    checking = (async () => {
      set('checking');
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Throughline/${version}` }, signal: AbortSignal.timeout(20000) });
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
    const response = await fetchImpl(release.url, { signal: controller.signal, headers: { 'User-Agent': `Throughline/${version}` } });
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
    const sums = await fetchImpl(release.checksumsUrl, { signal: controller.signal, headers: { 'User-Agent': `Throughline/${version}` } });
    if (!sums.ok) throw new Error(`The checksums could not be downloaded (${sums.status}).`);
    const text = await sums.text();
    if (text.length > MAX_CHECKSUMS) throw new Error('The checksums file is larger than expected.');
    const expected = checksumFor(text, release.file);
    if (!expected || expected !== actual) throw new Error('The download does not match its published checksum, so nothing was installed.');
    const unpacked = path.join(work, 'app');
    await exec('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
    fs.rmSync(zip, { force: true });
    const app = path.join(unpacked, 'Throughline.app'), plist = path.join(app, 'Contents', 'Info.plist');
    if (!fs.existsSync(plist)) throw new Error('The download does not contain Throughline.app.');
    const read = async key => (await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).trim();
    if (await read('CFBundleIdentifier') !== BUNDLE_ID || await read('CFBundleShortVersionString') !== release.version) throw new Error('The downloaded app is not the expected version of Throughline.');
    try { await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]); }
    catch { throw new Error('The downloaded app’s signature could not be verified, so nothing was installed.'); }
    await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {});
    return { version: release.version, app, work };
  }

  // Hands the swap to the helper and quits; the helper opens the new version once this process has exited.
  function restart() {
    if (!staged || status === 'installing') return;
    set('installing');
    const script = path.join(directory, 'install-update.sh'), previous = path.join(directory, 'previous', 'Throughline.app');
    fs.mkdirSync(path.dirname(previous), { recursive: true, mode: 0o700 });
    fs.writeFileSync(script, HELPER, { mode: 0o700 });
    launch(script, [String(pid), location.bundle, staged.app, previous, '/usr/bin/open'], path.join(directory, 'install.log'));
    quit();
  }

  async function install() {
    if (!enabled) throw new Error('Updates are installed from the macOS app.');
    if (location.blocked) throw new Error(location.blocked === 'translocated' ? 'Move Throughline to your Applications folder to install updates.' : 'Throughline can’t replace itself in this folder. Download the update instead.');
    if (status === 'waiting' || status === 'installing' || status === 'downloading') return state();
    if (!latest) throw new Error('There is no update to install.');
    if (staged?.version === latest.version) { if (busy()) set('waiting'); else restart(); return state(); }
    controller = new AbortController();
    set('downloading', { progress: { received: 0, total: latest.size } });
    try {
      staged = await stage(latest);
    } catch (failure) {
      const cancelled = controller.signal.aborted;
      controller = null;
      fs.rmSync(path.join(directory, `download-${latest.version}`), { recursive: true, force: true });
      if (cancelled) { set('available'); return state(); }
      set('error', { error: failure.message || 'The update could not be downloaded.' });
      return state();
    }
    controller = null;
    if (busy()) set('waiting'); else restart();
    return state();
  }

  // Called when runs start or finish: a staged update waits until no agent is working.
  function idle() { if (status === 'waiting' && !busy()) restart(); }

  function cancel() {
    if (status === 'downloading') controller?.abort();
    else if (status === 'waiting') set('available');
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
  if (enabled) for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory) : []) if (/^(download-|previous$|install-update\.sh$)/.test(entry)) fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  schedule(FIRST_CHECK);
  return { state, check, install, cancel, skip, setAutomatic, idle, dispose() { if (timer) timers.clearTimeout(timer); controller?.abort(); } };
}

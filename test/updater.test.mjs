import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HELPER, WINDOWS_HELPER, bundleLocation, checksumFor, createUpdater, releaseFrom, updateBuild, windowsLocation } from '../desktop/updater.mjs';

const download = 'https://github.com/AhmedNavaz/throughline/releases/download/v0.15.0/';
const zipBytes = Buffer.from('the Apple Silicon build of Codeshi 0.15.0');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const release = (overrides = {}) => ({
  tag_name: 'v0.15.0', html_url: 'https://github.com/AhmedNavaz/throughline/releases/tag/v0.15.0', draft: false, prerelease: false,
  assets: [{ name: 'Codeshi-0.15.0-mac-apple-silicon.zip', size: zipBytes.length, browser_download_url: download + 'Codeshi-0.15.0-mac-apple-silicon.zip' }, { name: 'Codeshi-0.15.0-mac-intel.zip', size: 10, browser_download_url: download + 'Codeshi-0.15.0-mac-intel.zip' }, { name: 'SHA256SUMS.txt', browser_download_url: download + 'SHA256SUMS.txt' }],
  ...overrides,
});

// An updater with GitHub, the macOS tools and the helper replaced by recordings.
function setup(t, { json = release(), sums = `${sha(zipBytes)}  Codeshi-0.15.0-mac-apple-silicon.zip\n`, plist = {}, bundle = 'Codeshi.app', codesign = true, platform = 'darwin', busy = () => false, slow = false, status = 200 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-updater-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { fetch: [], exec: [], launch: [], quit: 0, states: [], timers: [] };
  const fetchImpl = async (url, options = {}) => {
    calls.fetch.push(url);
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(json), { status });
    if (url.endsWith('SHA256SUMS.txt')) return new Response(sums);
    if (url.endsWith('.zip')) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(zipBytes.subarray(0, 10));
      if (slow) options.signal.addEventListener('abort', () => controller.error(new DOMException('The download was cancelled.', 'AbortError')));
      else { controller.enqueue(zipBytes.subarray(10)); controller.close(); }
    } }), { headers: { 'content-length': String(zipBytes.length) } });
    return new Response('', { status: 404 });
  };
  const values = { CFBundleIdentifier: 'local.throughline.desktop', CFBundleShortVersionString: '0.15.0', ...plist };
  const exec = async (file, args) => {
    calls.exec.push([path.basename(file), ...args.slice(0, 2)]);
    if (file.endsWith('ditto')) { const app = path.join(args[3], bundle, 'Contents'); fs.mkdirSync(app, { recursive: true }); fs.writeFileSync(path.join(app, 'Info.plist'), 'plist'); return ''; }
    if (file.endsWith('plutil')) return values[args[1]] + '\n';
    if (file.endsWith('codesign') && !codesign) throw new Error('invalid signature');
    return '';
  };
  const options = {
    version: '0.14.0', build: 'apple-silicon', platform, location: { bundle: path.join(root, 'Applications', 'Codeshi.app'), blocked: null }, directory: path.join(root, 'updates'),
    fetchImpl, exec, busy, pid: 4242, launch: (script, args, log) => calls.launch.push({ script, args, log }), quit: () => { calls.quit++; },
    onState: state => calls.states.push(state), timers: { setTimeout: (_fn, delay) => { calls.timers.push(delay); return null; }, clearTimeout: () => {} },
  };
  return { root, calls, options, updater: createUpdater(options) };
}

test('an update that could not be installed is reported at the next launch, once', { skip: process.platform === 'win32' && 'The in-app updater replaces macOS app bundles' }, t => {
  const { options } = setup(t), log = path.join(options.directory, 'install.log');
  assert.equal(createUpdater(options).state().installFailed, false, 'With no log, there is nothing to report.');
  fs.mkdirSync(options.directory, { recursive: true });
  fs.writeFileSync(log, '2026-11-04T01:00:00 Installed the update.\n');
  assert.equal(createUpdater(options).state().installFailed, false);
  for (const line of ['Codeshi did not quit, so the update was not installed.', 'The installed app could not be moved aside.', 'The update could not be moved into place, so the previous version was restored.']) {
    fs.appendFileSync(log, `2026-11-04T01:00:00 ${line}\n`);
    assert.equal(createUpdater(options).state().installFailed, true, line);
    assert.equal(createUpdater(options).state().installFailed, false, 'It is said once.');
  }
});

test('updates come only from this repository’s releases, for this Mac', { skip: process.platform === 'win32' && 'The in-app updater replaces macOS app bundles' }, () => {
  assert.equal(updateBuild({ arch: 'arm64' }), 'apple-silicon');
  assert.equal(updateBuild({ arch: 'x64', translated: true }), 'apple-silicon', 'The Intel build running under Rosetta moves to the Apple Silicon build.');
  assert.equal(updateBuild({ arch: 'x64' }), 'intel');
  const found = releaseFrom(release(), 'intel');
  assert.deepEqual([found.version, found.file, found.url, found.checksumsUrl], ['0.15.0', 'Codeshi-0.15.0-mac-intel.zip', download + 'Codeshi-0.15.0-mac-intel.zip', download + 'SHA256SUMS.txt']);
  const elsewhere = release({ assets: [{ name: 'Codeshi-0.15.0-mac-intel.zip', browser_download_url: 'https://example.com/Codeshi-0.15.0-mac-intel.zip' }] });
  assert.equal(releaseFrom(elsewhere, 'intel').url, null, 'A file hosted anywhere else is never downloaded.');
  assert.equal(releaseFrom(release({ prerelease: true }), 'intel'), null);
  assert.equal(releaseFrom(release({ tag_name: 'nightly' }), 'intel'), null);
  assert.equal(checksumFor(`${'a'.repeat(64)}  other.zip\n${'B'.repeat(64)}  Codeshi-0.15.0-mac-intel.zip\n`, 'Codeshi-0.15.0-mac-intel.zip'), 'b'.repeat(64));
  assert.equal(checksumFor(`${'a'.repeat(64)}  Codeshi-0.15.0-mac-intel.zip.old\n`, 'Codeshi-0.15.0-mac-intel.zip'), null);
  assert.deepEqual(bundleLocation('/Applications/Codeshi.app/Contents/MacOS/Codeshi', () => {}), { bundle: '/Applications/Codeshi.app', blocked: null });
  assert.equal(bundleLocation('/private/var/folders/x/AppTranslocation/1234/d/Codeshi.app/Contents/MacOS/Codeshi', () => {}).blocked, 'translocated');
  assert.equal(bundleLocation('/Applications/Codeshi.app/Contents/MacOS/Codeshi', () => { throw new Error('EACCES'); }).blocked, 'read-only');
  assert.equal(bundleLocation('/usr/local/bin/electron', () => {}).blocked, 'not-bundle');
});

test('Codeshi updates from releases made under its old name, Throughline, and from the renamed repository', { skip: process.platform === 'win32' && 'The in-app updater replaces macOS app bundles' }, async t => {
  const asset = (name, base = download) => ({ name, size: 10, browser_download_url: base + name });
  const old = release({ assets: [asset('Throughline-0.15.0-mac-intel.zip'), asset('SHA256SUMS.txt')] });
  assert.deepEqual([releaseFrom(old, 'intel').file, releaseFrom(old, 'intel').url], ['Throughline-0.15.0-mac-intel.zip', download + 'Throughline-0.15.0-mac-intel.zip'], 'A release from before the rename names its files after Throughline.');
  const both = release({ assets: [asset('Throughline-0.15.0-mac-intel.zip'), asset('Codeshi-0.15.0-mac-intel.zip'), asset('SHA256SUMS.txt')] });
  assert.equal(releaseFrom(both, 'intel').file, 'Codeshi-0.15.0-mac-intel.zip', 'A release with both names is installed from the Codeshi file.');
  const renamed = 'https://github.com/AhmedNavaz/codeshi/releases/download/v0.15.0/';
  const moved = releaseFrom(release({ html_url: 'https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0', assets: [asset('Codeshi-0.15.0-mac-intel.zip', renamed), asset('SHA256SUMS.txt', renamed)] }), 'intel');
  assert.deepEqual([moved.url, moved.checksumsUrl, moved.notesUrl], [renamed + 'Codeshi-0.15.0-mac-intel.zip', renamed + 'SHA256SUMS.txt', 'https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0'], 'Once the repository is renamed, GitHub serves its files under the new name.');
  const stranger = 'https://github.com/someone/codeshi/releases/download/v0.15.0/';
  assert.equal(releaseFrom(release({ assets: [asset('Codeshi-0.15.0-mac-intel.zip', stranger), asset('SHA256SUMS.txt', stranger)] }), 'intel').url, null, 'Another account’s repository is never used.');
  // A zip from a release that still holds Throughline.app installs the same way.
  const { updater, calls, options } = setup(t, { bundle: 'Throughline.app' });
  await updater.check();
  assert.equal((await updater.install()).status, 'ready');
  updater.restart();
  assert.equal(calls.launch[0].args[2], path.join(options.directory, 'download-0.15.0', 'app', 'Throughline.app'));
});

test('a newer release is offered, the installed one or an older one is not, and a failed check says why', async t => {
  const { updater, calls } = setup(t);
  assert.deepEqual(calls.timers, [15000], 'The first automatic check runs shortly after launch.');
  const offered = await updater.check();
  assert.equal(offered.status, 'available');
  assert.deepEqual(offered.latest, { version: '0.15.0', notesUrl: 'https://github.com/AhmedNavaz/throughline/releases/tag/v0.15.0', publishedAt: null });
  assert.match(offered.checkedAt, /^\d{4}-/);
  assert.deepEqual(calls.fetch, ['https://api.github.com/repos/AhmedNavaz/codeshi/releases/latest']);
  assert.equal((await setup(t, { json: release({ tag_name: 'v0.14.0' }) }).updater.check()).status, 'current');
  assert.equal((await setup(t, { json: release({ tag_name: 'v0.13.2' }) }).updater.check()).status, 'current');
  assert.match((await setup(t, { status: 403 }).updater.check()).error, /GitHub is limiting update checks/);
  const elsewhere = setup(t, { platform: 'linux' });
  assert.equal((await elsewhere.updater.check()).supported, false);
  assert.deepEqual(elsewhere.calls.fetch, [], 'Only the macOS app checks; there is no build for other systems yet.');
});

test('Update downloads and checks the update and waits as ready; Restart hands the swap to the helper and quits', async t => {
  const { updater, calls, options } = setup(t);
  await updater.check();
  const ready = await updater.install();
  assert.equal(ready.status, 'ready');
  assert.deepEqual(calls.exec.map(([tool]) => tool), ['ditto', 'plutil', 'plutil', 'codesign', 'xattr']);
  assert.deepEqual([calls.launch.length, calls.quit], [0, 0], 'Nothing restarts until the person says so.');
  assert.equal((await updater.check()).status, 'ready', 'A ready update is not checked again.');
  assert.equal((await updater.install()).status, 'ready');
  assert.equal(updater.restart().status, 'installing');
  assert.equal(calls.launch.length, 1);
  const [{ script, args }] = calls.launch, staged = path.join(options.directory, 'download-0.15.0', 'app', 'Codeshi.app');
  assert.deepEqual(args, ['4242', options.location.bundle, staged, path.join(options.directory, 'previous', 'Codeshi.app'), '/usr/bin/open']);
  assert.equal(fs.readFileSync(script, 'utf8'), HELPER);
  assert(fs.existsSync(staged));
  assert(!fs.existsSync(path.join(options.directory, 'download-0.15.0', 'Codeshi-0.15.0-mac-apple-silicon.zip')), 'The zip is removed once unpacked.');
  assert.equal(calls.quit, 1);
  assert(calls.states.some(item => item.status === 'downloading' && item.progress?.total === zipBytes.length));
});

test('a download that does not match its checksum, or an app that is not the expected one, installs nothing', async t => {
  for (const [options, message] of [
    [{ sums: `${'0'.repeat(64)}  Codeshi-0.15.0-mac-apple-silicon.zip\n` }, /does not match its published checksum/],
    [{ sums: `${sha(zipBytes)}  Codeshi-0.15.0-mac-intel.zip\n` }, /does not match its published checksum/],
    [{ plist: { CFBundleShortVersionString: '0.14.9' } }, /not the expected version/],
    [{ plist: { CFBundleIdentifier: 'com.example.other' } }, /not the expected version/],
    [{ codesign: false }, /signature could not be verified/],
  ]) {
    const { updater, calls, options: config } = setup(t, options);
    await updater.check();
    const state = await updater.install();
    assert.equal(state.status, 'error'); assert.match(state.error, message);
    assert.equal(calls.launch.length, 0); assert.equal(calls.quit, 0);
    assert(!fs.existsSync(path.join(config.directory, 'download-0.15.0')), 'A rejected download is removed.');
  }
});

test('while an agent works a restart waits, and Codeshi restarts only once no agent is working', async t => {
  let working = true;
  const { updater, calls } = setup(t, { busy: () => working });
  await updater.check();
  assert.equal(updater.restart().status, 'available', 'Nothing is ready to restart into yet.');
  assert.equal((await updater.install()).status, 'ready', 'An agent at work does not stop the download.');
  assert.equal(updater.restart().status, 'waiting');
  assert.equal(calls.launch.length, 0);
  updater.idle();
  assert.equal(calls.launch.length, 0, 'Still working.');
  assert.equal(updater.cancel().status, 'ready', 'Calling the restart off keeps the checked download.');
  assert.equal(updater.restart().status, 'waiting');
  assert.deepEqual(calls.exec.filter(([tool]) => tool === 'ditto').length, 1);
  working = false;
  updater.idle();
  assert.equal(calls.launch.length, 1); assert.equal(calls.quit, 1);
});

test('quitting with an update ready installs it as Codeshi closes, without opening it again', async t => {
  const { updater, calls, options } = setup(t);
  updater.finishOnQuit();
  assert.equal(calls.launch.length, 0, 'Nothing is ready, so nothing is installed.');
  await updater.check(); await updater.install();
  updater.finishOnQuit();
  assert.equal(updater.state().status, 'installing');
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].args.at(-1), '/usr/bin/true', 'The helper puts the update in place and opens nothing.');
  assert.equal(calls.launch[0].args[1], options.location.bundle);
  assert.equal(calls.quit, 0, 'Codeshi is already quitting.');
  updater.finishOnQuit();
  assert.equal(calls.launch.length, 1, 'It is handed over once.');
});

test('the update demo for a source checkout offers the next version, passes every check and only relaunches', async t => {
  const { updateDemo } = await import('../desktop/update-demo.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-update-demo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let relaunched = 0, launched = 0;
  const demo = updateDemo({ version: '0.20.3', build: 'apple-silicon', relaunch: () => { relaunched++; }, chunks: 4, pause: 1 });
  const states = [];
  // The demo stands in for the macOS app, the only one that updates itself, whichever system runs the test.
  const updater = createUpdater({ version: '0.20.3', build: 'apple-silicon', platform: 'darwin', directory: path.join(root, 'updates'), location: demo.location, fetchImpl: demo.fetchImpl, exec: demo.exec, launch: () => { launched++; demo.launch(); }, quit: demo.quit, onState: state => states.push(state.status), timers: { setTimeout: () => null, clearTimeout: () => {} } });
  const offered = await updater.check();
  assert.deepEqual([offered.status, offered.latest.version], ['available', '0.21.0']);
  assert.equal((await updater.install()).status, 'ready', 'The stand-in download passes the checksum, version and signature checks.');
  assert(states.includes('downloading'));
  updater.restart();
  assert.deepEqual([launched, relaunched], [1, 1], 'Restarting relaunches this copy; the demo helper replaces nothing.');
  assert.equal(demo.location.bundle.includes('update demo'), true);
});

test('cancelling a download returns to the offer', async t => {
  const { updater, calls } = setup(t, { slow: true });
  await updater.check();
  const installing = updater.install();
  for (let tries = 0; updater.state().status !== 'downloading' && tries < 50; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  updater.cancel();
  assert.equal((await installing).status, 'available');
  assert.equal(calls.launch.length, 0);
});

test('a skipped version and automatic checks being off are remembered', async t => {
  const { updater, options, calls } = setup(t);
  await updater.check();
  updater.skip('0.15.0');
  updater.setAutomatic(false);
  const reopened = createUpdater(options);
  assert.equal(reopened.state().skipped, '0.15.0');
  assert.equal(reopened.state().automatic, false);
  assert.deepEqual(calls.timers, [15000], 'With checks off, none is scheduled at launch.');
  reopened.setAutomatic(true);
  assert.deepEqual(calls.timers, [15000, 15000], 'Turning checks on checks soon.');
  assert.throws(() => updater.skip('latest'), /Choose a version/);
});

test('the helper replaces the app once Codeshi has quit, and puts the previous version back if the new one cannot be moved in', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-helper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'install-update.sh'), recorder = path.join(root, 'open.sh'), opened = path.join(root, 'opened');
  fs.writeFileSync(script, HELPER); fs.writeFileSync(recorder, `printf '%s' "$1" > "${opened}"\n`);
  const app = (where, version) => { fs.mkdirSync(path.join(where, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(where, 'Contents', 'version'), version); };
  const target = path.join(root, 'Applications', 'Codeshi.app'), staged = path.join(root, 'staged', 'Codeshi.app'), previous = path.join(root, 'previous', 'Codeshi.app');
  app(target, '0.14.0'); app(staged, '0.15.0'); fs.mkdirSync(path.dirname(previous));
  // Run without blocking, so the stand-in for Codeshi is reaped when it exits, as the system does for the app.
  const helper = args => new Promise(resolve => { const child = spawn('/bin/sh', [script, ...args]); let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stdout += chunk; }); child.on('close', status => resolve({ status, stdout })); });
  const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)']);
  const started = Date.now();
  const result = await helper([String(running.pid), target, staged, previous, '/bin/sh', recorder]);
  assert.equal(result.status, 0, result.stdout);
  assert(Date.now() - started >= 300, 'The helper waits for Codeshi to quit.');
  assert.equal(fs.readFileSync(path.join(target, 'Contents', 'version'), 'utf8'), '0.15.0');
  assert(!fs.existsSync(previous) && !fs.existsSync(staged));
  assert.equal(fs.readFileSync(opened, 'utf8'), target, 'The new version is opened.');
  assert.match(result.stdout, /Installed the update/);

  fs.rmSync(opened);
  const failed = await helper(['999999', target, path.join(root, 'missing', 'Codeshi.app'), previous, '/bin/sh', recorder]);
  assert.equal(fs.readFileSync(path.join(target, 'Contents', 'version'), 'utf8'), '0.15.0', 'The installed version is put back.');
  assert.equal(fs.readFileSync(opened, 'utf8'), target);
  assert.match(failed.stdout, /previous version was restored/);
});

// Windows: the same GitHub release, the system's tar stood in for, and the install folder in a temporary root.
const winBytes = Buffer.from('the Windows build of Codeshi 0.15.0');
const winRelease = () => release({ assets: [{ name: 'Codeshi-0.15.0-windows-x64.zip', size: winBytes.length, browser_download_url: download + 'Codeshi-0.15.0-windows-x64.zip' }, { name: 'SHA256SUMS.txt', browser_download_url: download + 'SHA256SUMS.txt' }] });
function setupWindows(t, { sums = `${sha(winBytes)}  Codeshi-0.15.0-windows-x64.zip\n`, manifest = { name: 'codeshi', version: '0.15.0' }, exe = true, tar = true, busy = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-updater-win-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'Programs', 'Codeshi');
  fs.mkdirSync(bundle, { recursive: true }); fs.writeFileSync(path.join(bundle, 'Codeshi.exe'), '0.14.0');
  const calls = { fetch: [], exec: [], launch: [], quit: 0 };
  const fetchImpl = async url => {
    calls.fetch.push(url);
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(winRelease()));
    if (url.endsWith('SHA256SUMS.txt')) return new Response(sums);
    if (url.endsWith('.zip')) return new Response(winBytes, { headers: { 'content-length': String(winBytes.length) } });
    return new Response('', { status: 404 });
  };
  const exec = async (file, args) => {
    calls.exec.push([path.win32.basename(file), ...args]);
    if (!tar) throw new Error('tar failed');
    const app = path.join(args[3], 'Codeshi'), resources = path.join(app, 'resources', 'app');
    fs.mkdirSync(resources, { recursive: true });
    if (exe) fs.writeFileSync(path.join(app, 'Codeshi.exe'), '0.15.0');
    if (manifest) fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify(manifest));
    return '';
  };
  const options = {
    version: '0.14.0', build: 'windows-x64', platform: 'win32', location: { bundle, blocked: null }, directory: path.join(root, 'AppData', 'updates'),
    fetchImpl, exec, busy, pid: 4242, launch: (script, args, log) => calls.launch.push({ script, args, log }), quit: () => { calls.quit++; },
    timers: { setTimeout: () => null, clearTimeout: () => {} },
  };
  return { root, bundle, calls, options, updater: createUpdater(options) };
}

test('Windows gets the Windows build from this repository’s releases', () => {
  assert.equal(updateBuild({ arch: 'x64', platform: 'win32' }), 'windows-x64');
  assert.equal(updateBuild({ arch: 'arm64', platform: 'win32' }), 'windows-x64', 'Windows on Arm runs the x64 build.');
  const found = releaseFrom(winRelease(), 'windows-x64');
  assert.deepEqual([found.file, found.url], ['Codeshi-0.15.0-windows-x64.zip', download + 'Codeshi-0.15.0-windows-x64.zip']);
  assert.equal(releaseFrom(release(), 'windows-x64').url, null, 'A release without a Windows zip offers nothing to download.');
});

test('the Windows install folder must be Codeshi.exe’s own, writable and not a temporary copy', () => {
  const writable = () => true;
  assert.deepEqual(windowsLocation('C:\\Users\\a\\AppData\\Local\\Programs\\Codeshi\\Codeshi.exe', { temporary: 'C:\\Users\\a\\AppData\\Local\\Temp', probe: writable }), { bundle: 'C:\\Users\\a\\AppData\\Local\\Programs\\Codeshi', blocked: null });
  assert.equal(windowsLocation('C:\\Users\\a\\AppData\\Local\\Temp\\Temp1_Codeshi-0.14.0-windows-x64.zip\\Codeshi\\Codeshi.exe', { temporary: 'C:\\Users\\a\\AppData\\Local\\Temp', probe: writable }).blocked, 'temporary', 'A zip opened in Explorer without extracting runs from a temporary copy.');
  assert.equal(windowsLocation('C:\\Program Files\\Codeshi\\Codeshi.exe', { temporary: 'C:\\Temp', probe: folder => folder !== 'C:\\Program Files' }).blocked, 'read-only');
  assert.equal(windowsLocation('C:\\dev\\node_modules\\electron\\dist\\electron.exe', { temporary: 'C:\\Temp', probe: writable }).blocked, 'not-bundle', 'A copy run from source is not replaced.');
});

test('on Windows, Update unpacks beside the install folder and checks it; Restart hands the swap to the PowerShell helper', async t => {
  const { updater, calls, options, bundle } = setupWindows(t);
  assert.equal(updater.state().supported, true);
  assert.equal((await updater.check()).status, 'available');
  assert.equal((await updater.install()).status, 'ready');
  const unpacked = `${bundle}.update`;
  assert.deepEqual(calls.exec, [['tar.exe', '-xf', path.join(options.directory, 'download-0.15.0', 'Codeshi-0.15.0-windows-x64.zip'), '-C', unpacked]]);
  assert(fs.existsSync(path.join(unpacked, 'Codeshi', 'Codeshi.exe')));
  assert(!fs.existsSync(path.join(options.directory, 'download-0.15.0')), 'The zip is removed once unpacked.');
  assert.equal(fs.readFileSync(path.join(bundle, 'Codeshi.exe'), 'utf8'), '0.14.0', 'Nothing is replaced while Codeshi runs.');
  assert.deepEqual([calls.launch.length, calls.quit], [0, 0]);
  assert.equal(updater.restart().status, 'installing');
  const [{ script, args, log }] = calls.launch;
  assert.equal(path.basename(script), 'install-update.ps1');
  assert.equal(fs.readFileSync(script, 'utf8'), WINDOWS_HELPER);
  assert.deepEqual(args, ['4242', bundle, path.join(unpacked, 'Codeshi'), `${bundle}.previous`, path.join(bundle, 'Codeshi.exe')]);
  assert.equal(log, path.join(options.directory, 'install.log'));
  assert.equal(calls.quit, 1);
});

test('on Windows, quitting with an update ready installs it without opening Codeshi again', async t => {
  const { updater, calls } = setupWindows(t);
  await updater.check(); await updater.install();
  updater.finishOnQuit();
  assert.equal(calls.launch[0].args.at(-1), '-');
  assert.equal(calls.quit, 0);
});

test('on Windows, a wrong checksum, a failed unpack or the wrong app installs nothing and leaves nothing beside Codeshi', async t => {
  for (const [options, message] of [
    [{ sums: `${'0'.repeat(64)}  Codeshi-0.15.0-windows-x64.zip\n` }, /does not match its published checksum/],
    [{ tar: false }, /could not be unpacked/],
    [{ exe: false }, /does not contain Codeshi\.exe/],
    [{ manifest: null }, /does not contain Codeshi\.exe/],
    [{ manifest: { name: 'codeshi', version: '0.14.9' } }, /not the expected version/],
    [{ manifest: { name: 'something-else', version: '0.15.0' } }, /not the expected version/],
  ]) {
    const { updater, calls, bundle, options: config } = setupWindows(t, options);
    await updater.check();
    const state = await updater.install();
    assert.equal(state.status, 'error'); assert.match(state.error, message);
    assert.deepEqual([calls.launch.length, calls.quit], [0, 0]);
    assert(!fs.existsSync(`${bundle}.update`), 'The rejected update is removed.');
    assert(!fs.existsSync(path.join(config.directory, 'download-0.15.0')));
  }
});

test('on Windows, leftovers from an interrupted update are removed at launch, and a blocked folder says why', async t => {
  const { options, bundle } = setupWindows(t);
  fs.mkdirSync(`${bundle}.update`); fs.mkdirSync(`${bundle}.previous`);
  fs.mkdirSync(options.directory, { recursive: true }); fs.writeFileSync(path.join(options.directory, 'install-update.ps1'), '');
  createUpdater(options);
  assert(!fs.existsSync(`${bundle}.update`) && !fs.existsSync(`${bundle}.previous`) && !fs.existsSync(path.join(options.directory, 'install-update.ps1')));
  assert(fs.existsSync(path.join(bundle, 'Codeshi.exe')), 'The installed folder stays.');
  const blocked = createUpdater({ ...options, location: { bundle, blocked: 'temporary' } });
  await blocked.check();
  await assert.rejects(blocked.install(), /temporary folder/);
});

test('the Windows helper is plain ASCII and logs what the next launch looks for', () => {
  assert(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(WINDOWS_HELPER), 'Windows PowerShell reads a script without a byte order mark in the system code page.');
  for (const line of ['did not quit', 'could not be moved aside', 'could not be moved into place']) assert(WINDOWS_HELPER.includes(line), line);
  assert.match(WINDOWS_HELPER, /param\(\[int\]\$ProcessId, \[string\]\$Target, \[string\]\$Staged, \[string\]\$Previous, \[string\]\$Open\)/);
});

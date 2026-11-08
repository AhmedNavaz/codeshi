import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ELECTRON_MIRROR, GITHUB_RELEASES, HTTPError, createElectronDownloader, electronChecksums } from '../scripts/electron-download.mjs';

const zip = GITHUB_RELEASES + 'v44.10.0/electron-v44.10.0-darwin-arm64.zip';
const mirrored = ELECTRON_MIRROR + 'v44.10.0/electron-v44.10.0-darwin-arm64.zip';
const ok = body => new Response(body, { status: 200 });
const failed = (status, statusText) => new Response('', { status, statusText });
// A body that breaks off after its first bytes, and one that never sends any.
const cut = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('par')); controller.error(new Error('reset')); } }));
const silent = () => new Response(new ReadableStream({ start() {} }));

// A fetch that answers each call from a list of replies, recording the URLs asked for, with no pauses and a short stall limit.
function downloader(...replies) {
  const urls = [], sleeps = [], logs = [];
  const fetch = async url => { urls.push(url); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply; };
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-electron-')), 'cache', 'electron.zip');
  const { download } = createElectronDownloader({ fetch, delays: [1, 2], stall: 50, sleep: async ms => { sleeps.push(ms); }, log: line => logs.push(line) });
  return { get: url => download(url ?? zip, target), urls, sleeps, logs, target, read: () => fs.readFileSync(target, 'utf8') };
}

test('a download that works first time is one request and no message', async () => {
  const d = downloader(ok('zip'));
  await d.get();
  assert.equal(d.read(), 'zip');
  assert.deepEqual(d.urls, [zip]); assert.deepEqual(d.sleeps, []); assert.deepEqual(d.logs, []);
});

test('a gateway timeout is tried again from GitHub after a pause', async () => {
  const d = downloader(failed(504, 'Gateway Time-out'), ok('zip'));
  await d.get();
  assert.equal(d.read(), 'zip');
  assert.deepEqual(d.urls, [zip, zip]); assert.deepEqual(d.sleeps, [1]);
  assert.match(d.logs[0], /504 \(Gateway Time-out\).*attempt 2 of 3/);
});

test('after GitHub keeps failing, the file comes from the mirror, with a message', async () => {
  const d = downloader(failed(504, 'Gateway Time-out'), new Error('fetch failed'), failed(503, 'Service Unavailable'), ok('mirror zip'));
  await d.get();
  assert.equal(d.read(), 'mirror zip');
  assert.deepEqual(d.urls, [zip, zip, zip, mirrored], 'The mirror is tried as soon as GitHub has had every try.');
  assert.deepEqual(d.sleeps, [1, 2]);
  assert.match(d.logs.at(-1), /keep failing \(Response code 503.*from https:\/\/npmmirror\.com\/mirrors\/electron\/ instead/);
});

test('a missing file is not tried again or looked for on the mirror', async () => {
  const d = downloader(failed(404, 'Not Found'));
  await assert.rejects(d.get(), error => error instanceof HTTPError && error.status === 404);
  assert.deepEqual(d.urls, [zip]); assert.deepEqual(d.logs, []);
  assert.equal(fs.existsSync(d.target), false);
});

test('when the mirror fails as well, the last error is reported and no partial file is left', async () => {
  const d = downloader(failed(504, 'a'), failed(504, 'b'), failed(504, 'c'), failed(502, 'Bad Gateway'), new Error('fetch failed'), failed(502, 'Bad Gateway'));
  await assert.rejects(d.get(), { name: 'HTTPError', status: 502, url: mirrored });
  assert.deepEqual(d.urls, [zip, zip, zip, mirrored, mirrored, mirrored]);
  assert.equal(fs.existsSync(d.target), false);
});

test('a URL that is not GitHub\'s, such as one from ELECTRON_MIRROR, is tried again but has no fallback', async () => {
  const own = 'https://mirror.example/electron/v44.10.0/electron-v44.10.0-darwin-arm64.zip';
  const d = downloader(failed(504, 'a'), failed(504, 'b'), failed(504, 'c'));
  await assert.rejects(d.get(own), { status: 504, url: own });
  assert.deepEqual(d.urls, [own, own, own]);
});

test('a download that breaks off or stalls is tried again, and the broken part is thrown away', async () => {
  const d = downloader(cut(), silent(), ok('zip'));
  await d.get();
  assert.equal(d.read(), 'zip');
  assert.deepEqual(d.urls, [zip, zip, zip]);
  assert.match(d.logs[0], /reset/); assert.match(d.logs[1], /No data from .* for 0\.05 s/);
});

test('the electron package ships the checksum of this platform\'s zip, and packaging refuses to go on without it', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
  assert.match(electronChecksums(root)[`electron-v${version}-${process.platform}-${process.arch}.zip`], /^[0-9a-f]{64}$/);
  assert.throws(() => electronChecksums(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-no-electron-'))), /checksums\.json is missing/);
});

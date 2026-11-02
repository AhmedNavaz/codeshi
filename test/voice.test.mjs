import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VoiceSessions, buildHelper } from '../src/voice.mjs';
import { createRelayServer } from '../src/server.mjs';
import { scriptCLIs } from './platform.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 5000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting'); await wait(10); } }
// A stand-in for Throughline Speech: it prints the lines a scenario gives it, and its final transcript once told to stop.
function helper(t, lines = ['{"type":"ready"}', '{"type":"partial","text":"add a"}', '{"type":"partial","text":"add a spinner"}'], { final = 'Add a spinner.', exitEarly = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-voice-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'Throughline Speech');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(directory, 'args'))}, JSON.stringify(process.argv.slice(2)));
for (const line of ${JSON.stringify(lines)}) console.log(line);
${exitEarly ? 'process.exit(0);' : ''}
process.stdin.on('data', chunk => { if (String(chunk).includes('stop')) { console.log(JSON.stringify({ type: 'final', text: ${JSON.stringify(final)} })); process.exit(0); } });
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return { file, args: () => JSON.parse(fs.readFileSync(path.join(directory, 'args'), 'utf8')) };
}
const collect = (sessions, id) => { const events = []; sessions.subscribe(id, event => events.push(event)); return events; };

test('listening streams what is heard, and stopping delivers the final transcript', { skip: scriptCLIs }, async t => {
  const fake = helper(t), sessions = new VoiceSessions({ platform: 'darwin', helper: fake.file });
  t.after(() => sessions.close());
  const { id, status } = await sessions.start({ locale: 'en-GB' });
  assert.equal(status, 'starting');
  const events = collect(sessions, id);
  await until(() => events.some(event => event.text === 'add a spinner'));
  assert.deepEqual(fake.args(), ['--locale', 'en-GB']);
  await assert.rejects(sessions.start(), /already listening/, 'One listening session at a time.');
  await sessions.stop(id);
  await until(() => events.at(-1)?.type === 'closed');
  assert.deepEqual(events.map(event => event.type), ['ready', 'partial', 'partial', 'final', 'closed']);
  assert.equal(events.at(-2).text, 'Add a spinner.');
  assert.equal(sessions.session, null);
  const again = await sessions.start();
  assert.notEqual(again.id, id, 'A new session can start once the last one ends.');
  sessions.cancel(again.id);
});

test('cancelling discards what was heard, an unanswered permission prompt times out, and listening stops at its time limit', { skip: scriptCLIs }, async t => {
  const fake = helper(t), sessions = new VoiceSessions({ platform: 'darwin', helper: fake.file });
  t.after(() => sessions.close());
  const first = await sessions.start(), events = collect(sessions, first.id);
  await until(() => events.some(event => event.type === 'ready'));
  sessions.cancel(first.id);
  assert.equal(events.at(-2).code, 'cancelled'); assert.equal(sessions.session, null);
  await assert.rejects(sessions.stop(first.id), /ended/);

  const silent = helper(t, []), waiting = new VoiceSessions({ platform: 'darwin', helper: silent.file, readyWait: 50 });
  t.after(() => waiting.close());
  const second = await waiting.start(), held = collect(waiting, second.id);
  await until(() => held.some(event => event.type === 'error'));
  assert.match(held.find(event => event.type === 'error').message, /waiting for permission/);

  const limited = new VoiceSessions({ platform: 'darwin', helper: fake.file, limit: 80 });
  t.after(() => limited.close());
  const third = await limited.start(), timed = collect(limited, third.id);
  await until(() => timed.some(event => event.type === 'final'));
  assert.equal(timed.find(event => event.type === 'final').text, 'Add a spinner.');
});

test('a helper that ends early keeps what it heard, and failures are reported plainly', { skip: scriptCLIs }, async t => {
  const early = helper(t, ['{"type":"ready"}', '{"type":"partial","text":"half a sentence"}'], { exitEarly: true });
  const sessions = new VoiceSessions({ platform: 'darwin', helper: early.file });
  t.after(() => sessions.close());
  const { id } = await sessions.start(), events = collect(sessions, id);
  await until(() => events.some(event => event.type === 'final'));
  assert.equal(events.find(event => event.type === 'final').text, 'half a sentence');

  const denied = helper(t, ['{"type":"error","code":"speech-denied","message":"Allow Throughline Speech in System Settings."}']);
  const refused = new VoiceSessions({ platform: 'darwin', helper: denied.file });
  t.after(() => refused.close());
  const second = await refused.start(), errors = collect(refused, second.id);
  await until(() => errors.some(event => event.type === 'error'));
  assert.deepEqual(errors.find(event => event.type === 'error'), { type: 'error', code: 'speech-denied', message: 'Allow Throughline Speech in System Settings.' });
});

test('other systems are told voice input is on macOS, and a language must look like one', async () => {
  const windows = new VoiceSessions({ platform: 'win32', helper: 'Throughline Speech' });
  assert.deepEqual(await windows.status(), { supported: false });
  await assert.rejects(windows.start(), /available on macOS/);
  await assert.rejects(new VoiceSessions({ platform: 'darwin', helper: 'Throughline Speech' }).start({ locale: 'en; rm -rf /' }), /Choose a language/);
});

test('a copy run from source builds the helper on first use, once, and explains a missing compiler', { skip: scriptCLIs }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-voice-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fake = helper(t), target = path.join(directory, 'Throughline Speech');
  let builds = 0;
  const sessions = new VoiceSessions({ platform: 'darwin', helper: target, build: async () => { builds++; await wait(20); fs.copyFileSync(fake.file, target); fs.chmodSync(target, 0o755); return target; } });
  t.after(() => sessions.close());
  assert.deepEqual(await sessions.status(), { supported: true, helper: 'missing' });
  const { id } = await sessions.start();
  assert.equal(builds, 1);
  sessions.cancel(id);
  await sessions.start().then(next => sessions.cancel(next.id));
  assert.equal(builds, 1, 'A built helper is reused.');
  const broken = new VoiceSessions({ platform: 'darwin', helper: path.join(directory, 'missing'), build: async () => { throw new Error('Voice input needs the Swift compiler to build from source.'); } });
  await assert.rejects(broken.start(), error => error.status === 503 && /Swift compiler/.test(error.message));
  assert.equal(broken.session, null);
});

test('the voice routes start, stream and stop listening, and the stream accepts the desktop token', { skip: scriptCLIs }, async t => {
  const fake = helper(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-voice-routes-'));
  const relay = createRelayServer({ workspace: root, dataDir: path.join(root, '.relay-data'), lock: false, accessToken: 'voice-token', voice: new VoiceSessions({ platform: 'darwin', helper: fake.file }) });
  t.after(async () => { await relay.close({ force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`, headers = { 'X-AI-Relay-Token': 'voice-token' };
  const post = async (name, body) => { const response = await fetch(`${base}/api/voice/${name}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  assert.equal((await fetch(`${base}/api/voice/start`, { headers })).status, 405);
  const started = await post('start', {});
  assert.equal(started.status, 201);
  assert.equal((await fetch(`${base}/api/voice/stream?id=${started.data.id}`)).status, 403, 'The stream needs the desktop token.');
  const stream = await fetch(`${base}/api/voice/stream?id=${started.data.id}&token=voice-token`);
  let received = '';
  const reading = (async () => { const decoder = new TextDecoder(); for await (const chunk of stream.body) received += decoder.decode(chunk); })();
  await until(() => received.includes('add a spinner'));
  await post('stop', { id: started.data.id });
  await reading;
  assert.match(received, /event: final\ndata: \{"type":"final","text":"Add a spinner\."\}/);
  assert.equal((await post('stop', { id: started.data.id })).status, 409);
});

test('Throughline Speech builds with its usage descriptions and reports permission without asking', { skip: process.platform !== 'darwin' || spawnSync('/usr/bin/xcrun', ['--find', 'swiftc']).status !== 0, timeout: 300000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-speech-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const out = await buildHelper({ out: path.join(directory, 'Throughline Speech') });
  const plist = execFileSync('/usr/bin/otool', ['-X', '-s', '__TEXT', '__info_plist', out]).toString();
  assert(plist.length > 0, 'The usage descriptions are embedded.');
  assert.match(execFileSync('/usr/bin/codesign', ['-dv', out], { stdio: ['ignore', 'pipe', 'pipe'] }).toString() + spawnSync('/usr/bin/codesign', ['-dv', out], { encoding: 'utf8' }).stderr, /Identifier=local\.throughline\.speech/);
  const check = JSON.parse(execFileSync(out, ['--check', '--locale', 'en-US']).toString().trim().split('\n').at(-1));
  assert.equal(check.type, 'check');
  assert(['authorized', 'denied', 'restricted', 'not-determined'].includes(check.speech));
  assert.equal(typeof check.onDevice, 'boolean');
  const unsupported = spawnSync(out, ['--check', '--locale', 'xx-YY'], { encoding: 'utf8' });
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stdout, /"code":"language"/);
});

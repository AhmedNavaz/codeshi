import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';
import { createPhoneAccess } from '../src/phone-access.mjs';
import { createRelayServer } from '../src/server.mjs';
import { scriptCLIs } from './platform.mjs';
import { phoneConversation } from '../src/phone-conversation.mjs';
import '../public/phone-logic.js';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const networks = () => [{ name: 'Test network', address: '127.0.0.1' }];
const post = (url, input, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1', Origin: new URL(url).origin, ...headers }, body: JSON.stringify(input) });
async function fixture(t, options = {}) {
  let clock = 1000, calls = [];
  const access = createPhoneAccess({ interfaces: networks, now: () => clock, local: () => ({ port: 1234, accessToken: 'desktop-secret' }), handle: (req, res) => { calls.push({ path: req.url, headers: req.headers, phone: req.phoneClient }); res.end('workspace data'); }, ...options });
  t.after(() => access.close());
  await access.manage({ action: 'start' });
  const url = access.status().url;
  async function pair() {
    const invite = await access.manage({ action: 'invite' });
    const response = await post(`${url}/phone/pair`, { code: invite.invite.code, name: 'My phone' });
    assert.equal(response.status, 202);
    const cookie = response.headers.get('set-cookie').split(';')[0], value = await response.json();
    const device = access.status().devices.find(row => row.code === value.code);
    return { cookie, value, device, invite: invite.invite };
  }
  return { access, url, pair, calls, time: ms => { clock += ms; } };
}

const { blocks, spans, describeStep, mergeMessages, duration, requestId } = globalThis.relayPhoneLogic;

test('a phone gets the latest chat messages, not the whole conversation', () => {
  const messages = [];
  for (let i = 0; i < 300; i++) messages.push({ id: `a${i}`, seq: i, role: 'activity', runId: 'r1', text: `Read\n{"file_path":"/x/f${i}.js"}\n${'x'.repeat(5000)}` }, { id: `m${i}`, seq: i, role: i % 2 ? 'assistant' : 'user', text: `message ${i}`, provider: 'claude', runId: 'r1' });
  const approval = { id: 'a', runId: 'r1', command: 'c'.repeat(5000) };
  const view = { id: 'c', status: 'running', messages, runs: new Array(500).fill({ context: 'y'.repeat(1000) }), context: { big: 'z'.repeat(50000) }, pendingApprovals: [approval], cursor: 900, activeRun: { id: 'r1', provider: 'claude', phase: 'working', startedAt: 'now', baseline: 'q'.repeat(9000) }, lastRun: null };
  const out = phoneConversation(view, 40);
  assert.equal(out.messages.length, 40); assert.equal(out.earlier, 260); assert.equal(out.messages.at(-1).id, 'm299');
  assert.equal(out.delta, false); assert.equal(out.cursor, 900);
  assert.ok(out.messages.every(message => message.role !== 'activity'), 'Tool activity stays on the computer.');
  assert.equal(out.step.id, 'a299'); assert.ok(out.step.text.length <= 2001);
  assert.deepEqual(out.pendingApprovals, [approval], 'What an approval asks is never shortened.');
  assert.equal(out.runs, undefined); assert.equal(out.context, undefined); assert.equal(out.activeRun.baseline, undefined); assert.equal(out.activeRun.phase, 'working');
  assert.ok(JSON.stringify(out).length < 12000, 'The full view is megabytes; this stays small.');
  const delta = phoneConversation({ ...view, messageCount: 600, messages: [messages[1], messages[0]] }, 40);
  assert.equal(delta.delta, true); assert.equal(delta.earlier, undefined); assert.deepEqual(delta.messages.map(message => message.id), ['m0']);
  assert.equal(phoneConversation({ id: null, messages: [], status: 'waiting' }).activeRun, null, 'A task that has not started has no conversation yet.');
});

test('phone page logic: updates merge in place, and a request ID works without a secure context', () => {
  const start = [{ id: '1', text: 'a' }, { id: '2', text: 'b' }];
  assert.deepEqual(mergeMessages(start, { delta: true, messages: [{ id: '2', text: 'b+' }, { id: '3', text: 'c' }] }).map(message => message.text), ['a', 'b+', 'c']);
  assert.deepEqual(mergeMessages(start, { delta: false, messages: [{ id: '9', text: 'z' }] }).map(message => message.id), ['9']);
  assert.equal(start[1].text, 'b');
  // Only getRandomValues: crypto.randomUUID doesn't exist on http://192.168….
  const id = requestId({ getRandomValues: bytes => bytes.fill(171) });
  assert.match(id, /^[A-Za-z0-9_.:-]{1,128}$/); assert.equal(id, 'ab'.repeat(16));
  assert.equal(duration(19000), '19s'); assert.equal(duration(134000), '2m 14s'); assert.equal(duration(3900000), '1h 5m');
});

test('the phone keeps its own appearance and leaves the computer\'s alone', async () => {
  const source = fs.readFileSync(new URL('../public/phone-theme.js', import.meta.url), 'utf8');
  assert.equal(/fetch|api\/appearance/.test(source), false, 'It never saves to the computer.');
  const load = (stored, dark) => {
    const attributes = {}, storage = new Map(stored ? [['codeshi:phone-theme', stored]] : []), changes = [], media = { matches: dark, addEventListener: (_, listener) => changes.push(listener) }, bar = { setAttribute: (_, value) => { attributes.bar = value; } };
    const window = { matchMedia: () => media };
    vm.runInNewContext(source, { window, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, document: { documentElement: { setAttribute: (_, value) => { attributes.theme = value; } }, querySelector: () => bar } });
    return { attributes, storage, media, changes, theme: window.relayPhoneTheme };
  };
  assert.equal(load(null, true).attributes.theme, 'graphite'); assert.equal(load(null, false).attributes.theme, 'light');
  assert.equal(load('light', true).attributes.theme, 'light', 'A choice beats the phone\'s own setting.');
  assert.equal(load('nonsense', false).theme.choice(), 'system');
  const phone = load(null, true);
  phone.theme.choose('light');
  assert.equal(phone.attributes.theme, 'light'); assert.equal(phone.attributes.bar, '#f4efe6'); assert.equal(phone.storage.get('codeshi:phone-theme'), 'light');
  phone.media.matches = true; phone.changes[0]();
  assert.equal(phone.attributes.theme, 'light', 'A Light or Dark choice stays as it is.');
  phone.theme.choose('system'); phone.media.matches = false; phone.changes[0]();
  assert.equal(phone.attributes.theme, 'light'); phone.media.matches = true; phone.changes[0]();
  assert.equal(phone.attributes.theme, 'graphite', 'System follows the phone.');
});

test('phone page logic: a step reads as one plain line, whatever form it was saved in', () => {
  assert.equal(describeStep('$ /bin/zsh -lc \'npm test\'\nresult'), 'Running npm test');
  assert.equal(describeStep('Read\n{"file_path":"/Users/me/app/src/index.js"}\nfile body'), 'Reading src/index.js');
  assert.equal(describeStep('Bash\n{"command":"rm -rf x","description":"Remove the build"}'), 'Remove the build');
  assert.equal(describeStep('Grep\n{"pattern":"needle","path":"/a"'), 'Searching a', 'A step cut short still names what it acted on.');
  assert.equal(describeStep('File changes:[{"path":"/r/a.js"},{"path":"/r/b.js"},{"path":"/r/c.js"}]'), 'Editing r/a.js, r/b.js and 1 more');
  assert.equal(describeStep('Tests running: npm test'), 'Running the tests');
  assert.equal(describeStep('Tests deferred: npm test'), 'Automatic tests deferred');
  assert.equal(describeStep('TodoWrite\n{"todos":[]}'), 'Updating its plan');
  assert.equal(describeStep(''), '');
});

test('phone page logic: replies read as Markdown blocks, and only web links become links', () => {
  const parsed = blocks('# Title\n\nSome **bold** text\nsecond line\n\n- one\n- two\n  wrapped\n\n1. first\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n---\n\n```js\nlet a = 1;\n\nlet b;\n```\nafter');
  assert.deepEqual(parsed.map(block => block.type), ['heading', 'paragraph', 'list', 'list', 'table', 'quote', 'rule', 'code', 'paragraph']);
  assert.deepEqual(parsed[2].items, ['one', 'two wrapped']); assert.equal(parsed[3].ordered, true);
  assert.deepEqual(parsed[4].head, ['A', 'B']); assert.deepEqual(parsed[4].rows, [['1', '2']]);
  assert.equal(parsed[7].text, 'let a = 1;\n\nlet b;'); assert.equal(parsed[7].language, 'js');
  assert.equal(blocks('```\nstill being written').at(-1).text, 'still being written', 'A reply still streaming can end inside a fence.');
  assert.deepEqual(blocks('').length, 0); assert.deepEqual(blocks(undefined).length, 0);
  const text = 'a `b` **c** *d* [e](https://x.dev) [f](javascript:alert(1)) <img src=x>';
  assert.deepEqual(spans(text).map(span => span.type), ['text', 'code', 'text', 'bold', 'text', 'italic', 'text', 'link', 'text']);
  assert.equal(spans(text).find(span => span.type === 'link').href, 'https://x.dev');
  assert.match(spans(text).at(-1).text, /\[f\]\(javascript:alert\(1\)\) <img src=x>/, 'Anything else stays plain text.');
});

test('phone pairing requires a one-use code and desktop approval; credentials never reach the page', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/api/projects`)).status, 401);
  assert.match(await (await fetch(f.url)).text(), /Connect to Codeshi/);
  assert.equal(f.calls.length, 0);
  assert.equal((await fetch(`${f.url}/phone-theme.js`)).status, 200, 'The pairing page has the same colours as the phone page.');
  const paired = await f.pair();
  assert.match(paired.cookie, /^codeshi_phone=[a-f0-9]{64}$/);
  assert.equal((await fetch(`${f.url}/api/projects`, { headers: { Cookie: paired.cookie } })).status, 401);
  assert.equal((await post(`${f.url}/phone/pair`, { code: paired.invite.code })).status, 403, 'An accepted code cannot be reused.');
  assert.equal((await fetch(`${f.url}/phone/session`, { headers: { Cookie: paired.cookie } })).status, 200);
  await f.access.manage({ action: 'allow', id: paired.device.id });
  const response = await fetch(`${f.url}/api/projects`, { headers: { Cookie: paired.cookie, 'X-AI-Relay-Token': 'attacker-supplied' } });
  assert.equal(await response.text(), 'workspace data');
  assert.equal(f.calls[0].headers['x-ai-relay-token'], 'desktop-secret');
  assert.equal(f.calls[0].headers.host, '127.0.0.1:1234');
  assert.equal(f.calls[0].phone, true);
  assert.equal(JSON.stringify(f.access.status()).includes(paired.cookie.split('=')[1]), false, 'Desktop device lists omit session credentials.');
  assert.equal((await fetch(`${f.url}/api/phone`, { headers: { Cookie: paired.cookie } })).status, 403);
  assert.equal((await post(`${f.url}/api/phone`, { action: 'invite' }, { Cookie: paired.cookie })).status, 403);
  assert.deepEqual(await (await fetch(`${f.url}/api/voice`, { headers: { Cookie: paired.cookie } })).json(), { supported: false });
  assert.equal((await post(`${f.url}/api/voice/start`, {}, { Cookie: paired.cookie })).status, 403, 'A phone must not turn on the computer microphone.');
  assert.equal(f.calls.length, 1);
});

test('scanning the generated QR returns the exact local one-use pairing link', async t => {
  const f = await fixture(t), first = f.access.status().invite;
  const decode = invite => { const png = PNG.sync.read(Buffer.from(invite.qr.split(',')[1], 'base64')); return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data; };
  assert.match(first.qr, /^data:image\/png;base64,/);
  assert.equal(decode(first), first.url);
  const next = (await f.access.manage({ action: 'invite' })).invite;
  assert.notEqual(first.url, next.url);
  assert.equal(decode(next), next.url);
  const oldCode = new URL(first.url).hash.slice(6);
  assert.equal((await post(`${f.url}/phone/pair`, { code: oldCode })).status, 403, 'Replacing a QR invalidates the old link.');
  const paired = await post(`${f.url}/phone/pair`, { code: new URL(next.url).hash.slice(6) });
  assert.equal(paired.status, 202);
  assert.equal((await fetch(`${f.url}/api/projects`, { headers: { Cookie: paired.headers.get('set-cookie').split(';')[0] } })).status, 401, 'A scan still needs desktop approval.');
});

test('phone gateway rejects cross-site mutations, rebinding hosts and unapproved network addresses', async t => {
  const f = await fixture(t), paired = await f.pair(); await f.access.manage({ action: 'allow', id: paired.device.id });
  for (const headers of [{ Origin: 'https://other.example' }, { Origin: 'null' }, { Origin: '' }, { 'X-AI-Relay': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await post(`${f.url}/api/conversations`, {}, { Cookie: paired.cookie, ...headers })).status, 403);
  }
  const rebinding = await new Promise((resolve, reject) => {
    const req = http.get(`${f.url}/api/projects`, { headers: { Host: 'attacker.example', Cookie: paired.cookie } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
  });
  assert.equal(rebinding, 403); assert.equal(f.calls.length, 0);
  await f.access.manage({ action: 'stop' });
  await assert.rejects(f.access.manage({ action: 'start', address: '0.0.0.0' }), /private Wi-Fi/);
  await assert.rejects(f.access.manage({ action: 'start', address: '203.0.113.1' }), /private Wi-Fi/);
});

test('pairing guesses are bounded; codes, pending requests and approved sessions expire', async t => {
  const f = await fixture(t);
  await f.access.manage({ action: 'invite' });
  for (let i = 0; i < 5; i++) assert.equal((await post(`${f.url}/phone/pair`, { code: i === 0 ? 'é'.repeat(8) : 'wrong' })).status, 403);
  assert.equal(f.access.status().invite, null);
  assert.equal((await post(`${f.url}/phone/pair`, { code: 'wrong' })).status, 429);
  f.time(60_001);
  const invite = await f.access.manage({ action: 'invite' }); f.time(5 * 60_000);
  assert.equal((await post(`${f.url}/phone/pair`, { code: invite.invite.code })).status, 403);
  const pending = await f.pair(); f.time(5 * 60_000);
  await assert.rejects(f.access.manage({ action: 'allow', id: pending.device.id }), /expired/);
  assert.equal((await fetch(`${f.url}/phone/session`, { headers: { Cookie: pending.cookie } })).status, 401);
  const active = await f.pair(); await f.access.manage({ action: 'allow', id: active.device.id }); f.time(12 * 60 * 60_000);
  assert.equal((await fetch(`${f.url}/api/projects`, { headers: { Cookie: active.cookie } })).status, 401);
});

test('declining, revoking, logging out and stopping remove grants; restarting never restores them', async t => {
  const f = await fixture(t);
  const declined = await f.pair(); await f.access.manage({ action: 'deny', id: declined.device.id });
  assert.equal((await fetch(`${f.url}/api/projects`, { headers: { Cookie: declined.cookie } })).status, 401);
  const paired = await f.pair(); await f.access.manage({ action: 'allow', id: paired.device.id });
  await f.access.manage({ action: 'revoke', id: paired.device.id });
  assert.equal((await fetch(`${f.url}/api/projects`, { headers: { Cookie: paired.cookie } })).status, 401);
  const logout = await f.pair(); await f.access.manage({ action: 'allow', id: logout.device.id });
  assert.equal((await post(`${f.url}/phone/logout`, {}, { Cookie: logout.cookie })).status, 200);
  assert.equal((await fetch(`${f.url}/api/projects`, { headers: { Cookie: logout.cookie } })).status, 401);
  const last = await f.pair(); await f.access.manage({ action: 'allow', id: last.device.id });
  await Promise.all([f.access.manage({ action: 'stop' }), f.access.manage({ action: 'start' }), f.access.manage({ action: 'stop' })]);
  assert.equal(f.access.status().enabled, false); assert.equal(f.access.status().devices.length, 0);
  await f.access.manage({ action: 'start' });
  assert.equal((await fetch(`${f.access.status().url}/api/projects`, { headers: { Cookie: last.cookie } })).status, 401);
});

test('paired phone and desktop share saved conversations, approval checks and live events', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-phone-test-')), workspace = path.join(folder, 'workspace'); fs.mkdirSync(workspace);
  const app = createRelayServer({ workspace, dataRoot: path.join(folder, 'data'), accessToken: 'desktop-token', lock: false, bins: { codex: process.execPath, claude: process.execPath }, phoneOptions: { interfaces: networks } });
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await app.close({ force: true }); fs.rmSync(folder, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const desktop = `http://127.0.0.1:${app.server.address().port}`, headers = { 'X-AI-Relay-Token': 'desktop-token' };
  assert.equal((await post(`${desktop}/api/phone`, { action: 'start' })).status, 403, 'Only the authenticated desktop can enable access.');
  assert.equal((await fetch(`${desktop}/api/phone`, { headers })).status, 200);
  const state = await (await post(`${desktop}/api/phone`, { action: 'start' }, headers)).json();
  const invite = await (await post(`${desktop}/api/phone`, { action: 'invite' }, headers)).json();
  const phone = state.url;
  const pair = await post(`${phone}/phone/pair`, { code: new URL(invite.invite.url).hash.slice(6), name: 'Test phone' });
  assert.equal(pair.status, 202); const cookie = pair.headers.get('set-cookie').split(';')[0];
  const pending = await (await fetch(`${desktop}/api/phone`, { headers })).json();
  await post(`${desktop}/api/phone`, { action: 'allow', id: pending.devices[0].id }, headers);
  const page = await fetch(phone, { headers: { Cookie: cookie } }); const html = await page.text();
  assert.match(html, /src="\/phone\.js"/, 'A paired phone gets its own page.'); assert.equal(html.includes('/app.js'), false); assert.equal(html.includes('desktop-token'), false);
  assert.match(await (await fetch(desktop, { headers })).text(), /src="\/app\.js"/, 'The computer keeps the desktop page.');
  const c = await (await post(`${phone}/api/conversations`, {}, { Cookie: cookie })).json();
  const saved = await (await fetch(`${desktop}/api/conversations/${c.id}`, { headers })).json(); assert.equal(saved.id, c.id);
  // The exact same backend validation rejects stale approvals from either device.
  const stale = { runId: 'old-run', approvalId: 'old-approval', allow: true };
  const mobileApproval = await post(`${phone}/api/conversations/${c.id}/approval`, stale, { Cookie: cookie });
  const desktopApproval = await post(`${desktop}/api/conversations/${c.id}/approval`, stale, headers);
  assert.equal(mobileApproval.status, desktopApproval.status); assert.notEqual(mobileApproval.status, 200);
  const stream = await fetch(`${phone}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  const reader = stream.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  app.registry.emit('update', { projectId: app.registry.list()[0].id, kind: 'phone-test' });
  assert.match(new TextDecoder().decode((await reader.read()).value), /phone-test/);
  await post(`${desktop}/api/phone`, { action: 'revoke', id: pending.devices[0].id }, headers);
  await assert.rejects(reader.read(), /terminated|abort|closed/i);
  assert.equal((await fetch(`${phone}/api/projects`, { headers: { Cookie: cookie } })).status, 401);
});

test('a phone can send a prompt and answer a live agent approval once, in the desktop conversation', { skip: scriptCLIs }, async t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-phone-run-'))), workspace = path.join(folder, 'workspace'); fs.mkdirSync(workspace);
  const cli = path.join(folder, 'gemini.mjs'), outcome = path.join(folder, 'outcome');
  fs.writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs'; import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));let prompt;
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')emit({id:m.id,result:{sessionId:'phone-run',models:{currentModelId:'m'}}});
if(m.method==='session/prompt'){prompt=m.id;emit({id:1001,method:'session/request_permission',params:{sessionId:'phone-run',toolCall:{toolCallId:'edit',title:'Create a file',kind:'execute',rawInput:{command:'touch phone-test.txt'}},options:[{optionId:'once',kind:'allow_once',name:'Allow'},{optionId:'no',kind:'reject_once',name:'Reject'}]}});}
if(m.id===1001&&!m.method){fs.writeFileSync(${JSON.stringify(outcome)},m.result.outcome.outcome);emit({method:'session/update',params:{sessionId:'phone-run',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Phone approval received.'}}}});emit({id:prompt,result:{stopReason:'end_turn'}});}}
`, { mode: 0o700 });
  const app = createRelayServer({ workspace, dataRoot: path.join(folder, 'data'), accessToken: 'desktop-token', lock: false, bins: { gemini: cli }, phoneOptions: { interfaces: networks } });
  t.after(async () => { await app.close({ force: true }); fs.rmSync(folder, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const desktop = `http://127.0.0.1:${app.server.address().port}`, headers = { 'X-AI-Relay-Token': 'desktop-token' };
  const { url } = await (await post(`${desktop}/api/phone`, { action: 'start' }, headers)).json();
  const { invite } = await (await post(`${desktop}/api/phone`, { action: 'invite' }, headers)).json();
  const pair = await post(`${url}/phone/pair`, { code: invite.code, name: 'My phone' }), cookie = pair.headers.get('set-cookie').split(';')[0];
  const { devices } = await (await fetch(`${desktop}/api/phone`, { headers })).json();
  await post(`${desktop}/api/phone`, { action: 'allow', id: devices[0].id }, headers);
  const c = await (await post(`${url}/api/conversations`, {}, { Cookie: cookie })).json();
  const started = await post(`${url}/api/conversations/${c.id}/messages`, { text: 'Check phone approvals', provider: 'gemini', model: 'm', mode: 'edit', approvalPolicy: 'ask', requestId: 'phone-test-send' }, { Cookie: cookie });
  assert.equal(started.status, 202);
  const broker = app.registry.broker(app.registry.list()[0].id), run = broker.running;
  for (let i = 0; i < 200 && !run.approvals.size; i++) await new Promise(resolve => setTimeout(resolve, 25));
  const approval = [...run.approvals.values()][0]; assert.ok(approval);
  const input = { runId: run.id, approvalId: approval.id, allow: true };
  assert.equal((await post(`${url}/api/conversations/${c.id}/approval`, input, { Cookie: cookie })).status, 200);
  await run.done;
  assert.equal(fs.readFileSync(outcome, 'utf8'), 'selected');
  assert.notEqual((await post(`${desktop}/api/conversations/${c.id}/approval`, input, headers)).status, 200, 'An already answered approval cannot run again.');
  const saved = await (await fetch(`${desktop}/api/conversations/${c.id}`, { headers })).json();
  assert.match(JSON.stringify(saved.messages), /Phone approval received/);
});

test('same-Wi-Fi access distinguishes activeNow from allowed, moves a session to another browser, explains unpaired browsers, and replaces stale connections (#114)', async t => {
  const f = await fixture(t);
  const first = await f.pair();
  await f.access.manage({ action: 'allow', id: first.device.id });
  assert.equal(f.access.status().devices[0].activeNow, true);

  // Hiding the phone tab marks activeNow false while keeping the session allowed.
  assert.equal((await fetch(`${f.url}/phone/session?active=0`, { headers: { Cookie: first.cookie } })).status, 200);
  assert.equal(f.access.status().devices[0].activeNow, false);
  assert.equal(f.access.status().devices[0].state, 'active');

  // An unpaired second browser (e.g. Safari or Home Screen after scanning in a QR reader) gets a clear explanation.
  const unpaired = await fetch(`${f.url}/phone/session`);
  assert.equal(unpaired.status, 401);
  const unpairedBody = await unpaired.json();
  assert.equal(unpairedBody.pairedElsewhere, true);
  assert.match(unpairedBody.error, /Each browser on your phone.*Move the connection/i);

  // Moving the connection to another browser rotates the credential without requiring computer approval or adding a second device.
  const handover = await post(`${f.url}/phone/handover`, {}, { Cookie: first.cookie });
  assert.equal(handover.status, 200);
  const handoverData = await handover.json();
  const moved = await post(`${f.url}/phone/pair`, { code: handoverData.code, name: 'Safari iPhone', deviceId: 'safari-device-0001' });
  assert.equal(moved.status, 200);
  const movedCookie = moved.headers.get('set-cookie').split(';')[0];
  assert.equal((await moved.json()).state, 'active');
  assert.equal(f.access.status().devices.length, 1);
  assert.equal(f.access.status().devices[0].name, 'Safari iPhone');
  assert.equal((await fetch(`${f.url}/api/projects`, { headers: { Cookie: first.cookie } })).status, 401, 'Old browser credential is replaced.');
  assert.equal((await fetch(`${f.url}/api/projects`, { headers: { Cookie: movedCookie } })).status, 200, 'New browser credential works immediately.');

  // Re-pairing when stale connections exist replaces an inactive connection instead of failing at the 5-device cap.
  f.time(60_000);
  assert.equal(f.access.status().devices[0].activeNow, false);
  const invite = await f.access.manage({ action: 'invite' });
  const repaired = await post(`${f.url}/phone/pair`, { code: invite.invite.code, name: 'Safari iPhone', deviceId: 'safari-device-0001' });
  assert.equal(repaired.status, 202);
  const pendingDevice = f.access.status().devices.find(row => row.state === 'pending');
  await f.access.manage({ action: 'allow', id: pendingDevice.id });
  assert.equal(f.access.status().devices.length, 1, 'Re-pairing replaces the previous connection for the same browser/phone.');
});

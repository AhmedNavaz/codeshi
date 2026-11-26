import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { FirebasePhoneClient, firebaseConfig, token, roomKey, seal, open, MAX_PACKET, REMOTE_BUSY, handoverCode, normalizeHandoverCode, handoverMeeting, handoverKeys, handoverShared } from '../public/phone-firebase.mjs';
import { createRemotePhoneAccess, phoneRemotePath, phoneRemoteRequest } from '../src/phone-remote.mjs';
import { createRelayServer } from '../src/server.mjs';
import { TRANSFER_ENCODING, conversationRoute, encodeConversation, decodeConversation } from '../public/phone-transfer.mjs';

const config = { projectId: 'codeshi-phone', apiKey: 'test-key-for-phone-access-only', databaseURL: 'https://codeshi-phone-default-rtdb.europe-west1.firebasedatabase.app', phoneURL: 'https://codeshi-phone.web.app' };
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const wait = async predicate => {
  const until = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > until) throw Error('Remote condition did not arrive.'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
class MemoryFirebase {
  values = new Map(); watches = new Map(); writes = [];
  async identity() { return { uid: 'computer' }; }
  async request(key, method = 'GET', value) {
    if (method === 'DELETE') { for (const name of this.values.keys()) if (name === key || name.startsWith(`${key}/`)) this.values.delete(name); return null; }
    if (method === 'GET') {
      if (key === 'owners/computer') return Object.fromEntries([...this.values.keys()].filter(name => name.startsWith(`${key}/`)).map(name => [name.split('/').at(-1), true]));
      return clone(this.values.get(key));
    }
    this.values.set(key, clone(value)); this.writes.push({ key, value: clone(value) });
    for (const listener of this.watches.get(key) || []) queueMicrotask(() => listener(clone(value)));
    return null;
  }
  watch(key, changed) { const values = this.watches.get(key) || new Set(); values.add(changed); this.watches.set(key, values); return () => values.delete(changed); }
  close() { this.watches.clear(); }
}
async function fixture(t, overrides = {}) {
  const firebase = new MemoryFirebase(), calls = [];
  const access = createRemotePhoneAccess({ config, clientFactory: () => firebase, local: () => ({ port: 5555, accessToken: 'private-desktop-token' }), handle: async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, method: req.method, headers: req.headers, phoneClient: req.phoneClient, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
  }, ...overrides });
  t.after(() => access.close());
  const state = await access.manage({ action: 'start' });
  const [room, secret] = new URLSearchParams(new URL(state.invite.url).hash.slice(1)).get('remote').split('.'), key = await roomKey(secret);
  async function send(value, uid = 'phone') {
    const request = { id: token(16), at: Date.now(), ...value };
    const box = await seal(key, room, 'request', request);
    await firebase.request(`rooms/${room}/request`, 'PUT', { uid, box });
    await wait(() => firebase.values.get(`rooms/${room}/out`));
    // Each reply is opened into its own entry: an older reply that finishes opening late can't replace a newer one.
    let result;
    await wait(() => { const out = firebase.values.get(`rooms/${room}/out`); if (out !== result?.out) { const entry = { out }; result = entry; open(key, room, 'out', out).then(value => { entry.value = value; }); } return result?.value?.id === request.id; });
    return { value: result.value, request, box };
  }
  return { access, firebase, calls, state, room, key, send };
}

test('remote packets are encrypted, authenticated and bound to their room and direction', async () => {
  const key = await roomKey(token()), other = await roomKey(token()), room = token(), value = { text: 'private prompt', command: 'private command' };
  const box = await seal(key, room, 'request', value);
  assert.equal(JSON.stringify(box).includes('private'), false);
  assert.deepEqual(await open(key, room, 'request', box), value);
  await assert.rejects(open(other, room, 'request', box));
  await assert.rejects(open(key, token(), 'request', box));
  await assert.rejects(open(key, room, 'out', box));
  await assert.rejects(open(key, room, 'request', { ...box, data: `${box.data.slice(0, -4)}AAAA` }));
  await assert.rejects(seal(key, room, 'request', { text: 'x'.repeat(MAX_PACKET) }), /too large/);
});

test('a typed handover code moves an allowed phone to a new browser once, without exposing the connection key (#115)', async t => {
  const f = await fixture(t);
  await f.send({ kind: 'pair', name: 'My iPhone', code: '123456' });
  await f.access.manage({ action: 'allow', id: f.room });
  const sendTo = async (room, key, value, uid) => {
    const request = { id: token(16), at: Date.now(), ...value };
    await f.firebase.request(`rooms/${room}/request`, 'PUT', { uid, box: await seal(key, room, 'request', request) });
    let result;
    await wait(() => { const out = f.firebase.values.get(`rooms/${room}/out`); if (out && out !== result?.out) { const entry = { out }; result = entry; open(key, room, 'out', out).then(value => { entry.value = value; }); } return result?.value?.id === request.id; });
    return result.value;
  };

  assert.match(handoverCode(), /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(normalizeHandoverCode('abcd-ef0o'), 'ABCDEF00');
  assert.equal(normalizeHandoverCode('il23 4567'), '11234567');
  assert.equal(normalizeHandoverCode('ABCD EFG'), null);
  assert.equal(normalizeHandoverCode('ABCD EFGU'), null);

  const handover = (await f.send({ kind: 'handover' })).value;
  assert.equal(handover.status, 200);
  const code = handover.body.code;
  assert.ok(normalizeHandoverCode(code), 'Move to another browser also gives a short code.');
  const [target, targetSecret] = new URLSearchParams(new URL(handover.body.url).hash.slice(1)).get('remote').split('.');

  // A wrong code finds no meeting point. The real one finds a waiting one that isn't listed or counted as a device.
  assert.equal(f.firebase.values.get(`rooms/${(await handoverMeeting('ZZZZZZZZ')).room}/meta`), undefined);
  const meeting = await handoverMeeting(normalizeHandoverCode(code.toLowerCase()));
  assert.equal(f.firebase.values.get(`rooms/${meeting.room}/meta`).state, 'waiting');
  assert.notEqual(meeting.secret, targetSecret, 'The code never derives the connection key itself.');
  assert.equal(f.access.status().devices.length, 1);
  const meetingKey = await roomKey(meeting.secret);

  // Only a key exchange is answered: a pair request on the meeting point never becomes a phone awaiting approval.
  await f.firebase.request(`rooms/${meeting.room}/request`, 'PUT', { uid: 'intruder', box: await seal(meetingKey, meeting.room, 'request', { id: token(16), at: Date.now(), kind: 'pair', name: 'Intruder', code: '999999' }) });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.firebase.values.get(`rooms/${meeting.room}/meta`).state, 'waiting');
  assert.equal(f.access.status().devices.every(device => device.name !== 'Intruder'), true);

  const mine = await handoverKeys();
  const answer = await sendTo(meeting.room, meetingKey, { kind: 'meet', pub: mine.pub }, 'phone-icon');
  assert.equal(f.firebase.values.get(`rooms/${meeting.room}/meta`).peer, 'phone-icon');
  assert.equal(JSON.stringify(f.firebase.writes).includes(targetSecret), false, 'The connection key is never written where the code alone opens it.');
  await assert.rejects(open(meetingKey, meeting.room, 'handover', answer.box), 'Knowing the code is not enough to open the answer.');
  const received = await open(await handoverShared(mine.privateKey, answer.pub, meeting.room), meeting.room, 'handover', answer.box);
  assert.deepEqual(received, { room: target, secret: targetSecret });

  // A second exchange on the used meeting point gets nothing.
  const other = await handoverKeys(), before = f.firebase.values.get(`rooms/${meeting.room}/out`);
  await f.firebase.request(`rooms/${meeting.room}/request`, 'PUT', { uid: 'phone-icon', box: await seal(meetingKey, meeting.room, 'request', { id: token(16), at: Date.now(), kind: 'meet', pub: other.pub }) });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.firebase.values.get(`rooms/${meeting.room}/out`), before);

  // The new browser then joins the moved connection without approval, and the meeting point and old browser are gone.
  const moved = await sendTo(target, await roomKey(received.secret), { kind: 'pair', name: 'iPhone', code: '222333', deviceId: 'device-icon-12345678' }, 'phone-icon');
  assert.equal(moved.state, 'active');
  assert.equal(f.firebase.values.has(`rooms/${meeting.room}/meta`), false);
  assert.equal(f.firebase.values.has(`rooms/${f.room}/meta`), false);
  assert.deepEqual(f.access.status().devices.map(device => device.id), [target]);
  assert.equal(f.calls.length, 0);
});

test('a code meeting point disappears with its transfer, and a remote phone can not approve it as a device (#115)', async t => {
  const f = await fixture(t);
  await f.send({ kind: 'pair', name: 'My iPhone', code: '123456' });
  await f.access.manage({ action: 'allow', id: f.room });
  const handover = (await f.send({ kind: 'handover' })).value;
  const meeting = await handoverMeeting(handover.body.code);
  await assert.rejects(f.access.manage({ action: 'allow', id: meeting.room }), /expired or was removed/);
  // Asking for another transfer replaces the first link and its code.
  const again = (await f.send({ kind: 'handover' })).value;
  assert.equal(f.firebase.values.has(`rooms/${meeting.room}/meta`), false);
  assert.equal(f.firebase.values.get(`rooms/${(await handoverMeeting(again.body.code)).room}/meta`).state, 'waiting');
  await f.access.manage({ action: 'revoke', id: f.room });
  assert.equal(f.firebase.values.has(`rooms/${(await handoverMeeting(again.body.code)).room}/meta`), false, 'Removing the phone ends its code too.');
});

test('remote configuration accepts Firebase endpoints and rejects arbitrary database destinations', () => {
  assert.equal(firebaseConfig(config).phoneURL, config.phoneURL);
  for (const databaseURL of ['http://localhost', 'https://evil.example', 'https://x.firebaseio.com@evil.example', `${config.databaseURL}/other`, `${config.databaseURL}?x=1`]) assert.throws(() => firebaseConfig({ ...config, databaseURL }));
  assert.throws(() => firebaseConfig({ ...config, phoneURL: 'http://phone.example' }));
});

test('conversation transfers append only with an acknowledged base and restore exact text across rewrites and view switches', () => {
  const view = conversationRoute('/api/conversation?projectId=p&task=t&since=1'), other = conversationRoute('/api/conversation?projectId=p2&task=t');
  let server, phone;
  const text = 'A long reply with Unicode: 🐈 and café. '.repeat(40);
  const transfer = (body, base = phone?.base, route = view) => {
    const encoded = encodeConversation(body, route, base, server, token(16));
    const decoded = decodeConversation(encoded.body, route, base, phone, encoded.state.base);
    assert.deepEqual(decoded.body, body); server = encoded.state; phone = decoded.state; return encoded.body;
  };
  const body = (value, delta = true) => ({ id: 'c', delta, messages: [{ id: 'reply', role: 'assistant', text: value }] });
  transfer(body(text, false));
  const patched = transfer(body(text + 'Next sentence.'));
  assert.deepEqual(patched.messages[0].textAppend, { from: text.length, value: 'Next sentence.' });
  assert.equal(patched.messages[0].text, undefined);
  assert.throws(() => decodeConversation(patched, view, 'wrong-base', phone, token(16)), { code: 'PHONE_TEXT_BASE' });
  assert.equal(transfer(body('Rewritten text')).messages[0].text, 'Rewritten text');
  assert.equal(transfer(body(text), null).messages[0].text, text, 'Lost/restarted bases receive full text.');
  assert.equal(transfer(body(text + 'Different workspace'), phone.base, other).messages[0].textAppend, undefined);
  assert.equal(transfer({ ...body(text + 'Different conversation'), id: 'c2' }).messages[0].textAppend, undefined);
  const many = { id: 'c2', delta: false, messages: Array.from({ length: 110 }, (_, i) => ({ id: String(i), text })) };
  transfer(many);
  assert.ok(server.texts.size <= 100); assert.equal(server.texts.size, phone.texts.size);
});

test('encrypted conversation requests negotiate append transfers, recover from a lost reply, and retain legacy support', async t => {
  let text = 'Streaming reply. '.repeat(200), delta = false;
  const f = await fixture(t, { handle: (req, res) => { res.writeHead(200); res.end(JSON.stringify({ id: 'c', delta, messages: [{ id: 'm', text }] })); } });
  await f.send({ kind: 'pair', code: '123456' }); await f.access.manage({ action: 'allow', id: f.room });
  const get = base => f.send({ kind: 'api', method: 'GET', path: '/api/conversation?projectId=p', transfer: { encoding: TRANSFER_ENCODING, base } });
  const initial = (await get(null)).value; delta = true; text += 'New text.';
  const appended = (await get(initial.transfer.base)).value;
  assert.equal(appended.body.messages[0].textAppend.value, 'New text.');
  assert.equal((await get(initial.transfer.base)).value.body.messages[0].text, text, 'A stale base cannot create an unreadable patch.');
  const legacy = (await f.send({ kind: 'api', method: 'GET', path: '/api/conversation?projectId=p' })).value;
  assert.equal(legacy.transfer, undefined); assert.equal(legacy.body.messages[0].text, text);
});

test('remote access exposes only the required phone endpoints and forces the compact conversation form', () => {
  for (const pathname of ['/api/phone', '/api/terminal', '/api/voice/start', '/api/projects', '/api/files', '/api/preferences']) assert.equal(phoneRemotePath('POST', pathname), null);
  assert.equal(phoneRemotePath('GET', 'https://evil.example/api/projects'), null);
  assert.equal(phoneRemotePath('GET', '//evil.example/api/projects'), null);
  assert.match(phoneRemotePath('GET', '/api/conversation?tail=99999&projectId=p'), /tail=100/);
  assert.equal(phoneRemotePath('POST', '/api/conversations/c/approval?projectId=p'), '/api/conversations/c/approval?projectId=p');
});

test('remote pairing requires a matching QR key and computer approval before any API call', async t => {
  const f = await fixture(t);
  const paired = await f.send({ kind: 'pair', name: 'My iPhone', code: '123456' });
  assert.equal(paired.value.state, 'pending');
  assert.equal(f.access.status().invite, null);
  assert.equal(f.access.status().devices[0].code, '123456');
  assert.equal((await f.send({ kind: 'api', method: 'GET', path: '/api/projects' })).value.status, 401);
  assert.equal(f.calls.length, 0);
  await f.access.manage({ action: 'allow', id: f.room });
  const reply = await f.send({ kind: 'api', method: 'POST', path: '/api/conversations/c/approval?projectId=p', body: { runId: 'run', approvalId: 'approval', allow: true } });
  assert.deepEqual(reply.value.body, { ok: true });
  assert.equal(f.calls[0].phoneClient, true);
  assert.equal(f.calls[0].headers['x-ai-relay-token'], 'private-desktop-token');
  assert.deepEqual(f.calls[0].body, { runId: 'run', approvalId: 'approval', allow: true });
  assert.equal(JSON.stringify(f.firebase.writes).includes('private-desktop-token'), false);
  assert.equal(JSON.stringify(f.firebase.writes).includes('My iPhone'), false);
  assert.equal(JSON.stringify(f.firebase.writes).includes('approvalId'), false);
});

test('replayed approval packets produce the cached response, not another local action; revoked phones stop', async t => {
  const f = await fixture(t);
  await f.send({ kind: 'pair', code: '123456' }); await f.access.manage({ action: 'allow', id: f.room });
  const request = await f.send({ kind: 'api', method: 'POST', path: '/api/conversations/c/approval', body: { allow: true } });
  await f.firebase.request(`rooms/${f.room}/request`, 'PUT', { uid: 'phone', box: request.box });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.length, 1);
  await f.access.manage({ action: 'revoke', id: f.room });
  assert.equal(f.access.status().devices.length, 0);
  assert.equal(f.firebase.values.has(`rooms/${f.room}/out`), false);
  await f.firebase.request(`rooms/${f.room}/request`, 'PUT', { uid: 'phone', box: request.box });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.calls.length, 1);
});

test('a burst of session checks cannot evict a recent mutation ID and make it executable again', async t => {
  const f = await fixture(t);
  await f.send({ kind: 'pair', code: '123456' }); await f.access.manage({ action: 'allow', id: f.room });
  const first = await f.send({ kind: 'api', method: 'POST', path: '/api/conversations/c/queue', body: { action: 'add', text: 'Only once' } });
  for (let i = 0; i < 135; i++) await f.send({ kind: 'session' });
  await f.firebase.request(`rooms/${f.room}/request`, 'PUT', { uid: 'phone', box: first.box });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.length, 1);
});

test('expired requests and a different phone identity cannot perform a local action', async t => {
  const f = await fixture(t);
  await f.send({ kind: 'pair', code: '123456' }); await f.access.manage({ action: 'allow', id: f.room });
  for (const [uid, at] of [['other-phone', Date.now()], ['phone', Date.now() - 60000]]) {
    await f.firebase.request(`rooms/${f.room}/request`, 'PUT', { uid, box: await seal(f.key, f.room, 'request', { id: token(16), at, kind: 'api', method: 'POST', path: '/api/conversations/c/stop' }) });
  }
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.calls.length, 0);
});

test('remote requests run through the real local server with desktop-only routes excluded', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-remote-server-'));
  const app = createRelayServer({ workspace: root, dataRoot: path.join(root, 'data'), accessToken: 'desktop-token' });
  t.after(async () => { await app.close({ force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const bridge = { handle: (req, res) => app.server.emit('request', req, res), local: () => ({ port: app.server.address().port, accessToken: 'desktop-token' }) };
  const result = await phoneRemoteRequest(bridge, { method: 'GET', path: '/api/projects' });
  assert.equal(result.status, 200); assert.equal(result.body.length, 1);
  assert.equal((await phoneRemoteRequest(bridge, { method: 'POST', path: '/api/phone', body: { action: 'start' } })).status, 403);
});

test('the browser Firebase client keeps the Window receiver for sign-in, requests, streams and refresh', async t => {
  const calls = [], browser = {};
  browser.fetch = function (url, options) {
    assert.equal(this, browser, 'Native browser fetch must be called on Window, not the Firebase client.');
    calls.push({ url, options });
    if (options.headers.Accept === 'text/event-stream') {
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('event: put\ndata: {"path":"/","data":{"connected":true}}\n\n'));
        options.signal.addEventListener('abort', () => controller.close(), { once: true });
      } });
      return Promise.resolve(new Response(stream));
    }
    const value = url.includes('accounts:signUp') ? { localId: 'phone', idToken: 'id', refreshToken: 'refresh' }
      : url.includes('securetoken') ? { user_id: 'phone', id_token: 'new-id', refresh_token: 'new-refresh' }
      : { connected: true };
    return Promise.resolve(new Response(JSON.stringify(value)));
  };
  const source = fs.readFileSync(new URL('../public/phone-firebase.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
  const BrowserClient = vm.runInNewContext(`${source}\nFirebasePhoneClient`, {
    globalThis: browser, fetch: browser.fetch, TextEncoder, TextDecoder, URL, URLSearchParams,
    AbortSignal, AbortController, setTimeout, clearTimeout,
  });
  const client = new BrowserClient(config); t.after(() => client.close());
  assert.equal((await client.identity()).uid, 'phone');
  assert.equal((await client.request('rooms/test/meta')).connected, true);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Browser response stream did not open.')), 1000);
    let stop;
    stop = client.watch('rooms/test/out', value => {
      try { assert.equal(value.connected, true); clearTimeout(timer); stop(); resolve(); }
      catch (error) { clearTimeout(timer); stop(); reject(error); }
    }, error => { clearTimeout(timer); stop(); reject(error); });
  });
  assert.equal((await client.identity(true)).idToken, 'new-id');
  assert.equal(calls.length, 4);
});

test('a service failure says same-Wi-Fi still works, and a denied connection or request does not', async () => {
  const failure = outcome => new Promise(resolve => {
    const client = new FirebasePhoneClient(config, { fetchImpl: async address => {
      if (new URL(address).hostname === 'identitytoolkit.googleapis.com') return new Response(JSON.stringify({ localId: 'phone', idToken: 'token', refreshToken: 'refresh' }));
      return outcome();
    } });
    const stop = client.watch('rooms/test/out', () => {}, error => { stop(); client.close(); resolve(error); });
  });
  for (const outcome of [() => new Response('', { status: 503 }), () => new Response('', { status: 429 }), () => { throw TypeError('Load failed'); }]) {
    const error = await failure(outcome);
    assert.equal(error.message, REMOTE_BUSY);
    assert.equal(error.busy, true);
  }
  for (const status of [401, 403]) {
    const error = await failure(() => new Response('', { status }));
    assert.equal(error.message, 'Remote connection is unavailable.');
    assert.equal(error.busy, undefined);
  }
  const responses = { 503: REMOTE_BUSY, 403: 'Remote access expired or was removed. Scan a new QR code.' };
  for (const [status, message] of Object.entries(responses)) {
    const client = new FirebasePhoneClient(config, { fetchImpl: async address => new URL(address).hostname === 'identitytoolkit.googleapis.com' ? new Response(JSON.stringify({ localId: 'phone', idToken: 'token', refreshToken: 'refresh' })) : new Response('', { status: Number(status) }) });
    await assert.rejects(client.request('rooms/test/request', 'PUT', {}), { message });
    client.close();
  }
});

test('Firebase refresh tokens are reused and refreshed without creating another anonymous user', async () => {
  let saved = { uid: 'existing', refreshToken: 'saved-refresh' }; const calls = [];
  const client = new FirebasePhoneClient(config, { load: () => saved, save: value => { saved = value; }, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ user_id: 'existing', id_token: 'token', refresh_token: 'new-refresh', expires_in: 3600 }));
  } });
  const [one, two] = await Promise.all([client.identity(), client.identity()]);
  assert.equal(one.uid, 'existing'); assert.equal(two.uid, 'existing'); assert.equal(calls.length, 1);
  assert.match(calls[0].url, /securetoken/); assert.match(calls[0].options.body, /grant_type=refresh_token/);
  assert.equal(saved.refreshToken, 'new-refresh'); client.close();
});

test('Firebase writes suppress echoed payloads and count database bytes without recording authentication data', async t => {
  const calls = [], packet = { text: 'café 🐈' };
  const client = new FirebasePhoneClient(config, { fetchImpl: async (address, options) => {
    const url = new URL(address); calls.push({ url, options });
    if (url.hostname === 'identitytoolkit.googleapis.com') return new Response(JSON.stringify({ localId: 'phone', idToken: 'private-token', refreshToken: 'private-refresh' }));
    if (options.method === 'PUT') { assert.equal(url.searchParams.get('print'), 'silent'); return new Response(null, { status: 204 }); }
    assert.equal(url.searchParams.has('print'), false); return new Response(JSON.stringify(packet));
  } }); t.after(() => client.close());
  assert.equal(await client.request('rooms/test/request', 'PUT', packet), null);
  assert.deepEqual(await client.request('rooms/test/meta'), packet);
  const length = Buffer.byteLength(JSON.stringify(packet));
  assert.deepEqual(client.traffic, { uploadBytes: length, downloadBytes: length, requests: 2, streams: 0 });
  assert.equal(JSON.stringify(client.traffic).includes('private'), false);
  assert.equal(calls.length, 3);
});

test('the hosted phone bootstrap pairs, unlocks only after approval, and carries the existing phone API', async t => {
  let chat = 'A streaming response. '.repeat(200), delta = false;
  const calls = [];
  const f = await fixture(t, { handle: async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200); res.end(JSON.stringify(req.url.startsWith('/api/conversation?') ? { id: 'c', delta, messages: [{ id: 'm', text: chat }] } : { ok: true }));
  } }), storage = new Map(), pageEvents = new EventTarget(), window = new EventTarget();
  const element = () => ({ hidden: false, textContent: '', children: [], classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); } }, append(...children) { this.children.push(...children); }, prepend(...children) { this.children.unshift(...children); }, setAttribute() {}, addEventListener() {} });
  const app = element(); app.hidden = true;
  const document = Object.assign(pageEvents, { hidden: false, getElementById: id => id === 'app' ? app : null, createElement: element, body: element(), head: element() });
  let replaced = null, pairSent = false, releasePair, streamFailure, watchCalls = 0, corruptAppend = false;
  const pairGate = new Promise(resolve => { releasePair = resolve; }); t.after(releasePair);
  class PhoneClient {
    async identity() { return { uid: 'phone' }; }
    async request(path, method, value) {
      if (path === `rooms/${f.room}/request` && !pairSent) { pairSent = true; await pairGate; }
      return f.firebase.request(path, method, value);
    }
    watch(key, changed, failed) {
      assert.equal(f.firebase.values.get(`rooms/${f.room}/meta`).peer, 'phone', 'The real rules deny response reads until the computer claims this phone.');
      watchCalls++; streamFailure = failed;
      const deliver = async box => {
        if (box && corruptAppend) {
          const value = await open(f.key, f.room, 'out', box), patch = value.body?.messages?.[0]?.textAppend;
          if (patch) { corruptAppend = false; patch.from++; box = await seal(f.key, f.room, 'out', value); }
        }
        return changed(box);
      };
      const stop = f.firebase.watch(key, deliver, failed);
      const existing = f.firebase.values.get(key); if (existing) queueMicrotask(() => deliver(existing));
      return stop;
    }
  }
  const source = fs.readFileSync(new URL('../public/phone-remote.mjs', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '');
  const started = vm.runInNewContext(source, { document, window, crypto, URL, URLSearchParams, EventTarget, Event, MessageEvent, Response, setTimeout, clearTimeout, queueMicrotask,
    FirebasePhoneClient: PhoneClient, firebaseConfig, token, roomKey, seal, open, TRANSFER_ENCODING, conversationRoute, decodeConversation,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    location: { hash: new URL(f.state.invite.url).hash, pathname: '/' }, history: { replaceState: (...args) => { replaced = args; } }, navigator: { userAgent: 'iPhone' },
    fetch: async () => new Response(JSON.stringify(config)),
  });
  await wait(() => pairSent);
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(watchCalls, 0, 'Scanning or returning to the page must not open a response stream before the pairing request is claimed.');
  releasePair(); await started;
  assert.equal(app.hidden, true); assert.equal(window.relayPhoneTransport, undefined);
  assert.equal(replaced[2], '/', 'The pairing secret is removed from the address bar.');
  assert.equal(f.access.status().devices[0].state, 'pending');
  const note = document.body.children[0].children[1];
  assert.match(note.textContent, /Check that Codeshi shows this number/);
  streamFailure(Error('Remote connection is unavailable.'));
  assert.equal(note.textContent, 'Remote connection is unavailable.', 'A real connection failure remains visible.');
  await f.firebase.request(`rooms/${f.room}/out`, 'PUT', await seal(f.key, f.room, 'out', { state: 'pending', code: f.access.status().devices[0].code, at: Date.now() }));
  await wait(() => note.textContent.includes('Check that Codeshi shows this number'));
  await f.access.manage({ action: 'allow', id: f.room });
  await wait(() => window.relayPhoneTransport);
  assert.equal(app.hidden, false);
  assert.equal(document.head.children.at(-1).src, '/phone.js', 'The same minimal phone UI loads after approval.');
  const response = await window.relayPhoneTransport.fetch('/api/conversations/c/approval', { method: 'POST', body: JSON.stringify({ approvalId: 'waiting', runId: 'run', allow: true }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  assert.equal(calls.at(-1).body.approvalId, 'waiting');
  const initial = await (await window.relayPhoneTransport.fetch('/api/conversation?projectId=p')).json();
  assert.equal(initial.messages[0].text, chat);
  chat += 'Only these characters are new.'; delta = true;
  const next = await (await window.relayPhoneTransport.fetch('/api/conversation?projectId=p&since=1')).json();
  assert.equal(next.messages[0].text, chat, 'The regular UI receives the fully reconstructed text.');
  const wire = await open(f.key, f.room, 'out', f.firebase.values.get(`rooms/${f.room}/out`));
  assert.equal(wire.body.messages[0].textAppend.value, 'Only these characters are new.');
  corruptAppend = true; chat += ' Recovered text.';
  const recovered = await (await window.relayPhoneTransport.fetch('/api/conversation?projectId=p&since=2')).json();
  assert.equal(recovered.messages[0].text, chat, 'An invalid text base triggers a complete read instead of corrupting the displayed reply.');
  assert.equal(calls.filter(call => call.path.startsWith('/api/conversation?')).length, 4);
  assert.equal(new URL(calls.at(-1).path, 'https://phone.local').searchParams.has('since'), false);
  const events = window.relayPhoneTransport.events(); let invalidated = 0, updates = 0;
  events.addEventListener('projects', () => { invalidated++; });
  events.addEventListener('update', () => { updates++; });
  await f.firebase.request(`rooms/${f.room}/out`, 'PUT', await seal(f.key, f.room, 'out', { event: 'update', at: Date.now() }));
  await wait(() => updates > 0);
  assert.equal(invalidated, 0, 'Progress must not refresh workspace metadata.');
  await f.firebase.request(`rooms/${f.room}/out`, 'PUT', await seal(f.key, f.room, 'out', { event: 'update', projectsChanged: true, at: Date.now() }));
  await wait(() => invalidated > 0);
  const watched = () => f.firebase.watches.get(`rooms/${f.room}/out`).size;
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); assert.equal(watched(), 0);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); assert.equal(watched(), 1);
  events.close(); window.dispatchEvent(new Event('pagehide'));
});

test('away-from-home sessions last a week, survive a Codeshi restart, distinguish activeNow from allowed, move across browsers, and replace stale pairings (#114)', async t => {
  const rules = fs.readFileSync(new URL('../remote/database.rules.json', import.meta.url), 'utf8');
  assert.match(rules, /now \+ 604800000/, 'Firebase database rules allow up to a 1-week Away from home session.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-remote-persist-'));
  const storeFile = path.join(dir, 'phone-firebase-auth.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(storeFile, JSON.stringify({ uid: 'computer', refreshToken: 'computer-refresh' }), { mode: 0o600 });

  let clock = Date.now();
  const firebase = new MemoryFirebase(), calls = [];
  const makeAccess = () => createRemotePhoneAccess({
    config, storeFile, now: () => clock, clientFactory: () => firebase,
    local: () => ({ port: 5555, accessToken: 'private-desktop-token' }),
    handle: async (req, res) => {
      calls.push({ path: req.url, method: req.method });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  let access = makeAccess();
  t.after(() => access.close());
  const started = await access.manage({ action: 'start' });
  const [room, secret] = new URLSearchParams(new URL(started.invite.url).hash.slice(1)).get('remote').split('.');
  const key = await roomKey(secret);
  const sendTo = async (targetRoom, targetKey, value, uid = 'phone-1') => {
    const request = { id: token(16), at: clock, ...value };
    const box = await seal(targetKey, targetRoom, 'request', request);
    await firebase.request(`rooms/${targetRoom}/request`, 'PUT', { uid, box });
    let result;
    await wait(() => {
      const out = firebase.values.get(`rooms/${targetRoom}/out`);
      if (!out) return false;
      if (out !== result?.out) {
        const entry = { out }; result = entry;
        open(targetKey, targetRoom, 'out', out).then(v => { entry.value = v; });
      }
      return result?.value?.id === request.id;
    });
    return result.value;
  };

  await sendTo(room, key, { kind: 'pair', name: 'My iPhone', code: '654321', deviceId: 'device-one-abcd1234' });
  const allowed = await access.manage({ action: 'allow', id: room });
  assert.equal(allowed.devices.length, 1);
  assert.equal(allowed.devices[0].expiresAt - clock, 7 * 24 * 60 * 60_000, 'Approved Away from home session lasts 1 week.');
  assert.equal(allowed.devices[0].activeNow, true);
  assert.equal(allowed.devices[0].lastSeenAt, clock);

  // Hiding the phone tab marks activeNow false while keeping the phone allowed.
  await sendTo(room, key, { kind: 'session', active: false });
  assert.equal(access.status().devices[0].activeNow, false);
  assert.equal(access.status().devices[0].state, 'active');

  // Sending an API request marks activeNow true again; 60s of inactivity marks activeNow false.
  await sendTo(room, key, { kind: 'api', method: 'GET', path: '/api/projects' });
  assert.equal(access.status().devices[0].activeNow, true);
  clock += 60_000;
  assert.equal(access.status().devices[0].activeNow, false);
  assert.equal(access.status().devices[0].state, 'active');

  // Create an unapproved invite, then restart Codeshi: the unapproved invite is removed, while the active phone survives.
  const withInvite = await access.manage({ action: 'invite' });
  const [unapprovedRoom] = new URLSearchParams(new URL(withInvite.invite.url).hash.slice(1)).get('remote').split('.');
  assert.equal(firebase.values.has(`rooms/${unapprovedRoom}/meta`), true);

  await access.close();
  assert.equal(firebase.values.has(`rooms/${unapprovedRoom}/meta`), false, 'Unapproved invites are cleaned up on shutdown.');
  assert.equal(firebase.values.has(`rooms/${room}/meta`), true, 'Approved remote rooms remain in Firebase across a Codeshi restart.');
  const savedStore = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.equal(savedStore.uid, 'computer');
  assert.equal(savedStore.enabled, true);
  assert.equal(savedStore.rooms.length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(storeFile).mode & 0o777, 0o600);

  access = makeAccess();
  assert.equal(access.status().enabled, true);
  assert.equal(access.status().devices.length, 1);
  await wait(() => (firebase.watches.get(`rooms/${room}/request`)?.size || 0) > 0);
  const afterRestart = await sendTo(room, key, { kind: 'api', method: 'GET', path: '/api/projects' });
  assert.equal(afterRestart.status, 200, 'Previously paired phone works after a Codeshi restart without scanning a new QR code.');
  assert.equal(access.status().devices[0].activeNow, true);

  // Move the allowed session to another browser on the phone (e.g. from QR scanner to Safari) without computer re-approval.
  const handover = await sendTo(room, key, { kind: 'handover' });
  assert.equal(handover.status, 200);
  const [nextRoom, nextSecret] = new URLSearchParams(new URL(handover.body.url).hash.slice(1)).get('remote').split('.');
  const nextKey = await roomKey(nextSecret);
  const moved = await sendTo(nextRoom, nextKey, { kind: 'pair', name: 'My iPhone', code: '111222', deviceId: 'device-safari-12345678' }, 'phone-safari');
  assert.equal(moved.state, 'active', 'Handover activates the new browser immediately without computer re-approval.');
  assert.equal(access.status().devices.length, 1);
  assert.equal(access.status().devices[0].id, nextRoom);
  assert.equal(firebase.values.has(`rooms/${room}/meta`), false, 'The old browser room is removed when handed over.');
  const safariCall = await sendTo(nextRoom, nextKey, { kind: 'api', method: 'GET', path: '/api/projects' }, 'phone-safari');
  assert.equal(safariCall.status, 200);

  // Re-pairing from the same browser (matching deviceId) or after closing replaces the previous entry instead of duplicating.
  const repairInvite = await access.manage({ action: 'invite' });
  const [repairRoom, repairSecret] = new URLSearchParams(new URL(repairInvite.invite.url).hash.slice(1)).get('remote').split('.');
  const repairKey = await roomKey(repairSecret);
  await sendTo(repairRoom, repairKey, { kind: 'pair', name: 'My iPhone', code: '333444', deviceId: 'device-safari-12345678' }, 'phone-safari-2');
  await access.manage({ action: 'allow', id: repairRoom });
  assert.equal(access.status().devices.length, 1, 'Re-pairing the same browser replaces its previous connection.');
  assert.equal(access.status().devices[0].id, repairRoom);

  // Turning off remote access removes the room and clears saved rooms so a restart stays off.
  await access.manage({ action: 'stop' });
  assert.equal(access.status().enabled, false);
  assert.equal(access.status().devices.length, 0);
  await access.close();
  access = makeAccess();
  assert.equal(access.status().enabled, false);
  assert.equal(access.status().devices.length, 0);
});

// #200: replies that go missing, a page that leaves and comes back, and whether the computer thinks the phone is open.
const reply = async (f, id) => { let value = null; await wait(() => { const out = f.firebase.values.get(`rooms/${f.room}/out`); if (out) open(f.key, f.room, 'out', out).then(opened => { value = opened; }); return value?.id === id; }); return value; };
const sendAs = async (f, request) => f.firebase.request(`rooms/${f.room}/request`, 'PUT', { uid: 'phone', box: await seal(f.key, f.room, 'request', request) });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('a request asked again gets its kept reply without running twice, even after a progress update replaced it or the page paused for minutes (#200)', async t => {
  let clock = Date.now(); const calls = [];
  const f = await fixture(t, { now: () => clock, handle: async (req, res) => { for await (const chunk of req) void chunk; calls.push(req.url); res.writeHead(200); res.end(JSON.stringify({ ok: calls.length })); } });
  await f.send({ kind: 'pair', code: '123456' }); await f.access.manage({ action: 'allow', id: f.room });
  const stop = { id: token(16), at: clock, kind: 'api', method: 'POST', path: '/api/conversations/c/stop', body: {} };
  await sendAs(f, stop);
  assert.deepEqual((await reply(f, stop.id)).body, { ok: 1 });
  // A progress update replaces the reply in the one mailbox, and names it so the page knows it missed it.
  const before = f.firebase.values.get(`rooms/${f.room}/out`);
  f.access.notify(); await wait(() => f.firebase.values.get(`rooms/${f.room}/out`) !== before);
  const progress = await open(f.key, f.room, 'out', f.firebase.values.get(`rooms/${f.room}/out`));
  assert.equal(progress.event, 'update'); assert.equal(progress.reply, stop.id, 'A progress update names the last reply.');
  // Sealed afresh with the same ID, as the page does: answered from the kept reply.
  await sendAs(f, stop);
  assert.deepEqual((await reply(f, stop.id)).body, { ok: 1 });
  // Minutes later, past the 30 seconds a new request is accepted for, the same action is still answered, not run.
  clock += 3 * 60_000;
  await sendAs(f, stop);
  assert.deepEqual((await reply(f, stop.id)).body, { ok: 1 });
  assert.equal(calls.length, 1, 'Stop ran once.');
  // A request that never arrived in time is refused, and the page is told so instead of waiting.
  const late = { id: token(16), at: clock - 60_000, kind: 'api', method: 'POST', path: '/api/conversations/c/messages', body: { text: 'late' } };
  await sendAs(f, late);
  const refused = await reply(f, late.id);
  assert.equal(refused.status, 408); assert.match(refused.body.error, /too long ago/);
  assert.equal(calls.length, 1, 'A late message is never run.');
});

test('the page leaving is said without a reply, and only what it sends while in front counts as open (#200)', async t => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  await f.send({ kind: 'pair', code: '123456' }); await f.access.manage({ action: 'allow', id: f.room });
  assert.equal(f.access.status().devices[0].activeNow, true);
  const writes = f.firebase.writes.length;
  await sendAs(f, { id: token(16), at: clock, kind: 'session', active: false, quiet: true }); await settle();
  assert.equal(f.access.status().devices[0].activeNow, false);
  assert.equal(f.access.status().devices[0].lastSeenAt, clock, 'Last seen is when it left.');
  assert.equal(f.firebase.writes.slice(writes).some(write => write.key.endsWith('/out')), false, 'Nothing is written for a page that left.');
  // A read made before it left, or sent while away, arrives late without making the phone look open.
  await sendAs(f, { id: token(16), at: clock - 500, kind: 'api', method: 'GET', path: '/api/projects' });
  await sendAs(f, { id: token(16), at: clock + 10, kind: 'api', method: 'GET', path: '/api/projects', hidden: true }); await settle();
  assert.equal(f.access.status().devices[0].activeNow, false);
  clock += 1000;
  await sendAs(f, { id: token(16), at: clock, kind: 'session' }); await settle();
  assert.equal(f.access.status().devices[0].activeNow, true, 'Coming back counts as open at once.');
  // Without a word from the phone, open ends 25 seconds after the last request rather than 45.
  clock += 26_000;
  assert.equal(f.access.status().devices[0].activeNow, false);
});

test('an alert held back for an open page reaches the lock screen when the page leaves, unless it was acted on (#200)', async t => {
  let clock = Date.now(); const sent = [];
  const push = { publicKey: () => 'key', send: async (subscription, message) => { sent.push(message.title); return 'sent'; } };
  const f = await fixture(t, { now: () => clock, push });
  await f.send({ kind: 'pair', code: '123456' }); await f.access.manage({ action: 'allow', id: f.room });
  const subscription = { endpoint: 'https://web.push.apple.com/phone', keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } };
  assert.equal((await f.send({ kind: 'push', action: 'subscribe', subscription })).value.status, 200);
  const plan = title => ({ urgency: 'high', ttl: 60, message: { title, body: 'Workspace' } });
  assert.equal(await f.access.alert(plan('Waiting for you')), 0, 'The open page shows it.');
  clock += 2000;
  await sendAs(f, { id: token(16), at: clock, kind: 'session', active: false, quiet: true });
  await wait(() => sent.length === 1);
  assert.deepEqual(sent, ['Waiting for you']);
  // Answered from the page before leaving: nothing more to say.
  clock += 1000; await f.send({ kind: 'session', at: clock });
  assert.equal(await f.access.alert(plan('Finished')), 0);
  await f.send({ kind: 'api', method: 'POST', path: '/api/conversations/c/approval', body: { allow: true }, at: clock + 1 });
  await sendAs(f, { id: token(16), at: clock + 2, kind: 'session', active: false, quiet: true }); await settle();
  assert.deepEqual(sent, ['Waiting for you']);
});

test('after a restart, a request the phone asks again is not run a second time (#200)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-remote-seen-')), storeFile = path.join(dir, 'auth.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const firebase = new MemoryFirebase(), calls = [];
  const make = () => createRemotePhoneAccess({ config, storeFile, clientFactory: () => firebase, local: () => ({ port: 5555 }),
    handle: async (req, res) => { for await (const chunk of req) void chunk; calls.push(req.url); res.writeHead(200); res.end('{}'); } });
  let access = make(); t.after(() => access.close());
  const started = await access.manage({ action: 'start' });
  const [room, secret] = new URLSearchParams(new URL(started.invite.url).hash.slice(1)).get('remote').split('.'), key = await roomKey(secret);
  const f = { firebase, room, key };
  const pair = { id: token(16), at: Date.now(), kind: 'pair', code: '123456' }; await sendAs(f, pair); await reply(f, pair.id);
  await access.manage({ action: 'allow', id: room });
  const message = { id: token(16), at: Date.now(), kind: 'api', method: 'POST', path: '/api/conversations/c/messages', body: { text: 'once' } };
  await sendAs(f, message); await reply(f, message.id);
  await access.close(); await firebase.request(`rooms/${room}/out`, 'DELETE'); access = make();
  await wait(() => (firebase.watches.get(`rooms/${room}/request`)?.size || 0) > 0);
  await sendAs(f, message);
  const answer = await reply(f, message.id);
  assert.equal(answer.status, 409); assert.match(answer.body.error, /restarted/);
  assert.equal(calls.length, 1);
});

async function remotePage(t, f, secret) {
  const storage = new Map([[`codeshi:remote-session:${config.projectId}`, JSON.stringify({ room: f.room, secret })]]), window = new EventTarget();
  const element = () => ({ hidden: false, textContent: '', children: [], classList: { add() {}, remove() {} }, append(...children) { this.children.push(...children); }, prepend() {}, setAttribute() {}, addEventListener() {} });
  const document = Object.assign(new EventTarget(), { hidden: false, getElementById: () => element(), createElement: element, body: element(), head: element() });
  const link = { down: false, failPuts: 0, streams: [] };
  class PhoneClient {
    async identity() { return { uid: 'phone' }; }
    async request(key, method, value) {
      if (method === 'PUT' && key.endsWith('/request') && link.failPuts > 0) { link.failPuts--; throw new TypeError('Load failed'); }
      return f.firebase.request(key, method, value);
    }
    watch(key, changed, failed) {
      const stream = { changed, failed, live: true }; link.streams.push(stream);
      const stop = f.firebase.watch(key, box => { if (stream.live && !link.down) changed(box); });
      queueMicrotask(() => changed(clone(f.firebase.values.get(key))));
      return () => { stream.live = false; stop(); };
    }
  }
  const source = fs.readFileSync(new URL('../public/phone-remote.mjs', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '');
  const started = vm.runInNewContext(source, { document, window, crypto, URL, URLSearchParams, EventTarget, Event, MessageEvent, Response, setTimeout, clearTimeout, queueMicrotask,
    FirebasePhoneClient: PhoneClient, firebaseConfig, token, roomKey, seal, open, TRANSFER_ENCODING, conversationRoute, decodeConversation,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} }, navigator: { userAgent: 'iPhone' },
    fetch: async () => new Response(JSON.stringify(config)),
  });
  await started; await wait(() => window.relayPhoneTransport);
  const show = hidden => { document.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
  t.after(() => show(true));
  const post = (url, body = {}) => window.relayPhoneTransport.fetch(url, { method: 'POST', body: JSON.stringify(body) });
  return { window, document, link, show, post };
}
const remoteFixture = async (t, handle) => {
  const f = await fixture(t, { handle });
  await f.send({ kind: 'pair', code: '123456' }); await f.access.manage({ action: 'allow', id: f.room });
  return { f, secret: new URLSearchParams(new URL(f.state.invite.url).hash.slice(1)).get('remote').split('.')[1] };
};

test('coming back to the page picks up a reply that a progress update replaced while it was away, and sends the action once (#200)', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }), calls = [];
  const { f, secret } = await remoteFixture(t, async (req, res) => {
    for await (const chunk of req) void chunk; calls.push(req.url);
    if (req.url.includes('/queue')) await gate;
    res.writeHead(200); res.end(JSON.stringify({ queued: true }));
  });
  const page = await remotePage(t, f, secret);
  const sent = page.post('/api/conversations/c/queue', { action: 'add', text: 'Only once' });
  await wait(() => calls.some(call => call.includes('/queue')));
  page.show(true);
  // Leaving is said at once and nothing waits for it.
  const left = await Promise.race([page.window.relayPhoneTransport.fetch('/phone/session?active=0', { keepalive: true }), settle().then(() => 'waited')]);
  assert.equal(left.status, 200);
  await wait(() => f.access.status().devices[0].activeNow === false);
  release(); await settle();
  await f.firebase.request(`rooms/${f.room}/out`, 'PUT', await seal(f.key, f.room, 'out', { event: 'update', at: Date.now() }));
  const back = Date.now(); page.show(false);
  const response = await sent;
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { queued: true });
  assert(Date.now() - back < 2000, 'The page is up to date within 2 seconds.');
  assert.equal(calls.filter(call => call.includes('/queue')).length, 1, 'The prompt was queued once.');
  const next = await page.post('/api/conversations/c/stop');
  assert.equal(next.status, 200, 'Later requests go through at once.');
});

test('a request cut off as the page hides, or answered while the stream reconnects, is asked again instead of waiting 25 seconds (#200)', async t => {
  const calls = [];
  const { f, secret } = await remoteFixture(t, async (req, res) => { for await (const chunk of req) void chunk; calls.push(req.url); res.writeHead(200); res.end(JSON.stringify({ n: calls.length })); });
  const page = await remotePage(t, f, secret);
  // The phone cuts off the upload as the page hides: nothing failed, it is sent again on return.
  page.link.failPuts = 1; page.show(true);
  const approval = page.post('/api/conversations/c/approval', { allow: true });
  await settle(); page.show(false);
  const answered = await approval;
  assert.equal(answered.status, 200); assert.equal(calls.filter(call => call.includes('/approval')).length, 1);
  // The stream drops; the reply is written while it reconnects; the reconnected stream opens on the mailbox as it is now.
  page.link.down = true;
  const stop = page.post('/api/conversations/c/stop');
  await wait(() => calls.some(call => call.includes('/stop'))); await settle();
  await f.firebase.request(`rooms/${f.room}/out`, 'PUT', await seal(f.key, f.room, 'out', { event: 'update', at: Date.now() }));
  const stream = page.link.streams.at(-1);
  stream.failed(Error('Reconnecting to your computer…')); page.link.down = false;
  const started = Date.now();
  stream.changed(clone(f.firebase.values.get(`rooms/${f.room}/out`)));
  assert.equal((await stop).status, 200);
  assert(Date.now() - started < 2000);
  assert.equal(calls.filter(call => call.includes('/stop')).length, 1, 'Stop ran once.');
});

// An unpaired browser on the same phone, such as a new Home Screen icon (#201). Its elements keep their listeners so
// the test can tap Paste and submit the code box.
async function unpairedPage(t, clipboard, uid = 'phone-icon') {
  const created = [], window = new EventTarget(), storage = new Map();
  const element = () => {
    const listeners = new Map(), value = { hidden: false, textContent: '', children: [], disabled: false, value: '', classList: { add() {}, remove() {} }, append(...children) { this.children.push(...children); }, prepend(...children) { this.children.unshift(...children); }, setAttribute() {}, focus() {},
      addEventListener(type, listener) { listeners.set(type, listener); }, fire(type, event = { preventDefault() {} }) { return listeners.get(type)?.(event); } };
    created.push(value); return value;
  };
  const document = Object.assign(new EventTarget(), { hidden: false, getElementById: () => element(), createElement: element, body: element(), head: element() });
  class PhoneClient {
    async identity() { return { uid }; }
    request(...args) { return this.f.firebase.request(...args); }
    watch(key, changed) { const stop = this.f.firebase.watch(key, changed); queueMicrotask(() => changed(clone(this.f.firebase.values.get(key)))); return stop; }
  }
  const source = fs.readFileSync(new URL('../public/phone-remote.mjs', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '');
  return (f) => {
    PhoneClient.prototype.f = f;
    const started = vm.runInNewContext(source, { document, window, crypto, URL, URLSearchParams, EventTarget, Event, MessageEvent, Response, setTimeout, clearTimeout, queueMicrotask,
      FirebasePhoneClient: PhoneClient, firebaseConfig, token, roomKey, seal, open, TRANSFER_ENCODING, conversationRoute, decodeConversation, normalizeHandoverCode, handoverMeeting, handoverKeys, handoverShared, REMOTE_BUSY,
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} }, navigator: { userAgent: 'iPhone', clipboard: { readText: async () => clipboard() } },
      fetch: async () => new Response(JSON.stringify(config)),
    });
    t.after(() => { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    return { started, window, created, paste: () => created.find(item => item.id === 'phone-handover-paste'), field: () => created.find(item => item.id === 'phone-handover-code'), note: () => document.body.children[0]?.children?.[1] };
  };
}

test('a new browser takes over the connection with one tap on Paste, from the link or the code Move to another browser copied (#201)', async t => {
  const { f } = await remoteFixture(t);
  // The paired browser copies its link. The new one finds it on the clipboard.
  const handover = (await f.send({ kind: 'handover' })).value;
  let clipboard = 'not a connection';
  const page = (await unpairedPage(t, () => clipboard))(f);
  await page.started;
  assert.ok(page.paste(), 'An unpaired page offers Paste.');
  page.paste().fire('click'); await settle();
  assert.match(page.note().textContent, /Nothing to paste/, 'Something else on the clipboard is not taken for a connection.');
  assert.equal(f.access.status().devices.length, 1);
  clipboard = `Open this: ${handover.body.url}`;
  page.paste().fire('click');
  await wait(() => page.window.relayPhoneTransport);
  const devices = f.access.status().devices;
  assert.equal(devices.length, 1, 'It moves the connection rather than adding a phone.');
  assert.equal(devices[0].state, 'active');
  assert.notEqual(devices[0].id, f.room, 'The browser that copied it is disconnected.');
});

test('the code under Move to another browser can be pasted too, and the box still takes a typed one (#201)', async t => {
  const { f } = await remoteFixture(t);
  const handover = (await f.send({ kind: 'handover' })).value;
  const page = (await unpairedPage(t, () => ` ${handover.body.code.toLowerCase().replace(/(.{4})/, '$1 ')} `))(f);
  await page.started;
  page.paste().fire('click');
  await wait(() => page.window.relayPhoneTransport);
  assert.equal(f.access.status().devices[0].state, 'active');
  // A used code works only once.
  const again = (await unpairedPage(t, () => '', 'phone-other'))(f);
  await again.started;
  const form = again.created.find(item => item.children.includes(again.paste()));
  again.field().value = handover.body.code; form.fire('submit');
  await wait(() => /didn’t work/.test(again.note().textContent));
  assert.equal(again.window.relayPhoneTransport, undefined);
});

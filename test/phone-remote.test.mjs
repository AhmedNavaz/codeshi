import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { FirebasePhoneClient, firebaseConfig, token, roomKey, seal, open, MAX_PACKET, REMOTE_BUSY } from '../public/phone-firebase.mjs';
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
    let result;
    await wait(() => { const out = firebase.values.get(`rooms/${room}/out`); if (out !== result?.out) { result = { out, promise: open(key, room, 'out', out) }; result.promise.then(value => { result.value = value; }); } return result?.value?.id === request.id; });
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
  const element = () => ({ hidden: false, textContent: '', children: [], classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); } }, append(...children) { this.children.push(...children); }, prepend(...children) { this.children.unshift(...children); }, setAttribute() {} });
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

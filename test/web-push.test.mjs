import assert from 'node:assert/strict';
import { createECDH, createPublicKey, createDecipheriv, hkdfSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { encryptPush, pushSubscription, pushKeys, vapidAuthorization, createWebPush } from '../src/web-push.mjs';
import { alertDefaults, alertPreferences, alertPush, mergeAlertPreferences } from '../src/alerts.mjs';
import { createRemotePhoneAccess } from '../src/phone-remote.mjs';
import { token, roomKey, seal, open } from '../public/phone-firebase.mjs';

const b64 = value => Buffer.from(value).toString('base64url');

// A phone's browser: its own key pair and auth secret, and a way to read what was sent to it.
function phoneBrowser(endpoint = 'https://web.push.apple.com/QGuQyavXutnMH-u1H') {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return {
    subscription: { endpoint, keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } },
    read(body) {
      const salt = body.subarray(0, 16), length = body[20], senderKey = body.subarray(21, 21 + length), data = body.subarray(21 + length);
      const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(senderKey), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderKey]), 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce); decipher.setAuthTag(data.subarray(-16));
      const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
      assert.equal(plain.at(-1), 2, 'One record, marked as the last.');
      return JSON.parse(plain.subarray(0, -1));
    },
  };
}
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-push-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('push messages are encrypted exactly as RFC 8291 describes', () => {
  // The worked example in RFC 8291, section 5.
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const body = encryptPush({ keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
    'When I grow up, I want to be a watermelon', { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), ecdh });
  assert.equal(b64(body), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  // A fresh key and salt each time, so two identical messages never look alike.
  const phone = phoneBrowser();
  const first = encryptPush(phone.subscription, '{"a":1}'), second = encryptPush(phone.subscription, '{"a":1}');
  assert.notEqual(b64(first), b64(second));
  assert.deepEqual(phone.read(first), { a: 1 });
});

test('only a real push service address with well-formed keys is kept as a subscription', () => {
  const { subscription } = phoneBrowser();
  assert.deepEqual(pushSubscription(subscription), subscription);
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://api.push.apple.com/3/device/abc', 'https://db5p.notify.windows.com/w/?token=abc'])
    assert.ok(pushSubscription({ ...subscription, endpoint }), endpoint);
  for (const endpoint of ['http://web.push.apple.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://web.push.apple.com:8443/x', 'https://evil.example/web.push.apple.com', 'https://web.push.apple.com.evil.example/x', 'https://user@web.push.apple.com/x', 'not a url', ''])
    assert.equal(pushSubscription({ ...subscription, endpoint }), null, `Refused: ${endpoint}`);
  assert.equal(pushSubscription({ ...subscription, keys: { ...subscription.keys, auth: b64(Buffer.alloc(8)) } }), null);
  assert.equal(pushSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: b64(Buffer.alloc(65)) } }), null);
  assert.equal(pushSubscription({ endpoint: subscription.endpoint }), null);
  assert.equal(pushSubscription(null), null);
});

test('the computer signs each push with its own key, made once and kept private', t => {
  const file = path.join(temp(t), 'phone-push-key.json');
  const keys = pushKeys(file), again = pushKeys(file);
  assert.equal(keys.publicKey, again.publicKey, 'The key is kept, so existing subscriptions keep working.');
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const header = vapidAuthorization('https://web.push.apple.com/abc', keys, Date.UTC(2026, 10, 10));
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [head, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { aud: 'https://web.push.apple.com', exp: Date.UTC(2026, 10, 10) / 1000 + 12 * 3600, sub: 'https://codeshi.dev' });
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33)) }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('a push goes to the subscription with the Web Push headers, and a gone subscription is reported', async t => {
  const phone = phoneBrowser(), sent = [];
  let status = 201;
  const push = createWebPush({ keyFile: path.join(temp(t), 'key.json'), fetch: async (url, options) => { sent.push({ url, options }); return { status, ok: status < 300 }; } });
  assert.equal(await push.send(phone.subscription, { title: 'Finished', body: 'throughline' }, { urgency: 'high', ttl: 60 }), 'sent');
  const [{ url, options }] = sent;
  assert.equal(url, phone.subscription.endpoint);
  assert.equal(options.headers.TTL, '60'); assert.equal(options.headers.Urgency, 'high'); assert.equal(options.headers['Content-Encoding'], 'aes128gcm');
  assert.match(options.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.equal(options.redirect, 'error', 'A push service can’t redirect the computer elsewhere.');
  assert.deepEqual(phone.read(options.body), { title: 'Finished', body: 'throughline' });
  status = 410; assert.equal(await push.send(phone.subscription, {}), 'gone');
  status = 500; assert.equal(await push.send(phone.subscription, {}), 'failed');
  assert.equal(await push.send({ ...phone.subscription, endpoint: 'https://evil.example/x' }, {}), 'gone', 'An address that isn’t a push service is never contacted.');
  assert.equal(sent.length, 3);
});

test('a phone notification says only what happened and where, for the moments chosen in Alerts', () => {
  assert.deepEqual(alertDefaults.phone, { on: true, attention: true, finished: true, stopped: true });
  const preferences = alertPreferences({});
  const plan = alertPush({ kind: 'approval', title: 'Approval needed', body: 'Claude wants to run rm -rf build', projectId: 'p1', projectName: 'throughline', approvalId: 'a1' }, preferences);
  assert.deepEqual(plan, { moment: 'attention', urgency: 'high', ttl: 12 * 3600, message: { title: 'Waiting for you', body: 'throughline', tag: 'attention:p1', projectId: 'p1' } });
  assert.equal(JSON.stringify(plan).includes('rm -rf'), false, 'No command, question or reply reaches the lock screen.');
  assert.equal(alertPush({ kind: 'finished', projectName: 'x' }, preferences).urgency, 'normal');
  assert.equal(alertPush({ kind: 'other' }, preferences), null);
  assert.equal(alertPush({ kind: 'finished' }, mergeAlertPreferences(preferences, { phone: { finished: false } })), null);
  assert.equal(alertPush({ kind: 'approval' }, mergeAlertPreferences(preferences, { phone: { on: false } })), null);
  assert.throws(() => mergeAlertPreferences(preferences, { phone: { volume: 3 } }), /on or off/);
});

class MemoryFirebase {
  values = new Map(); watches = new Map();
  async identity() { return { uid: 'computer' }; }
  async request(key, method = 'GET', value) {
    if (method === 'DELETE') { for (const name of this.values.keys()) if (name === key || name.startsWith(`${key}/`)) this.values.delete(name); return null; }
    if (method === 'GET') return key === 'owners/computer' ? {} : structuredClone(this.values.get(key) ?? null);
    this.values.set(key, structuredClone(value));
    for (const listener of this.watches.get(key) || []) queueMicrotask(() => listener(structuredClone(value)));
    return null;
  }
  watch(key, changed) { const values = this.watches.get(key) || new Set(); values.add(changed); this.watches.set(key, values); return () => values.delete(changed); }
  close() { this.watches.clear(); }
}

test('a paired phone keeps its subscription with its connection, and only a phone that isn’t open is notified (#23)', async t => {
  const dir = temp(t), storeFile = path.join(dir, 'phone-firebase-auth.json'), firebase = new MemoryFirebase(), sent = [];
  let clock = Date.now(), status = 201;
  const config = { projectId: 'codeshi-phone', apiKey: 'test-key-for-phone-access-only', databaseURL: 'https://codeshi-phone-default-rtdb.europe-west1.firebasedatabase.app', phoneURL: 'https://codeshi-phone.web.app' };
  const push = createWebPush({ keyFile: path.join(dir, 'phone-push-key.json'), fetch: async (url, options) => { sent.push({ url, options }); return { status, ok: status < 300 }; } });
  const make = () => createRemotePhoneAccess({ config, storeFile, push, now: () => clock, clientFactory: () => firebase, local: () => ({ port: 5555 }), handle: async (req, res) => { res.writeHead(200); res.end('{}'); } });
  const access = make();
  const state = await access.manage({ action: 'start' });
  const [room, secret] = new URLSearchParams(new URL(state.invite.url).hash.slice(1)).get('remote').split('.'), key = await roomKey(secret);
  const send = async value => {
    const request = { id: token(16), at: clock, ...value };
    await firebase.request(`rooms/${room}/request`, 'PUT', { uid: 'phone', box: await seal(key, room, 'request', request) });
    for (let i = 0; i < 300; i++) {
      const out = firebase.values.get(`rooms/${room}/out`);
      if (out) { const reply = await open(key, room, 'out', out); if (reply.id === request.id) return reply; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error('No reply.');
  };
  const phone = phoneBrowser(), plan = alertPush({ kind: 'finished', projectId: 'p1', projectName: 'throughline' }, alertPreferences({}));

  assert.equal((await send({ kind: 'push' })).status, 401, 'Only an approved phone can ask.');
  await send({ kind: 'pair', name: 'iPhone', code: '123456' });
  await access.manage({ action: 'allow', id: room });

  const info = await send({ kind: 'push' });
  assert.equal(info.status, 200); assert.equal(info.body.subscribed, false); assert.equal(info.body.key, push.publicKey());
  assert.equal((await send({ kind: 'push', action: 'subscribe', subscription: { ...phone.subscription, endpoint: 'https://127.0.0.1/steal' } })).status, 400);
  assert.equal((await send({ kind: 'push', action: 'subscribe', subscription: phone.subscription })).body.subscribed, true);
  assert.equal(access.status().devices[0].notifications, true);
  assert.equal((await send({ kind: 'push' })).body.endpoint, phone.subscription.endpoint);

  // The page is open, so it shows the alert itself.
  assert.equal(await access.alert(plan), 0); assert.equal(sent.length, 0);
  // Hidden: the lock screen gets it.
  await send({ kind: 'session', active: false });
  assert.equal(await access.alert(plan), 1);
  assert.deepEqual(phone.read(sent[0].options.body), plan.message);

  // It survives a restart with the connection, and goes when the connection goes.
  await access.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile, 'utf8')).rooms[0].push, phone.subscription);
  const restarted = make(); t.after(() => restarted.close());
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(restarted.status().devices[0].notifications, true);
  assert.equal(await restarted.alert(plan), 1);
  // The phone turned notifications off in its own settings: the push service says the subscription is gone.
  status = 410;
  assert.equal(await restarted.alert(plan), 0);
  assert.equal(restarted.status().devices[0].notifications, false);
  assert.equal(JSON.parse(fs.readFileSync(storeFile, 'utf8')).rooms[0].push, undefined);
});

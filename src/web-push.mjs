// Lock-screen notifications for a paired phone (#23), sent by this computer straight to the phone's push service with
// the Web Push protocol. There is no Codeshi server in between and no Firebase function. Each message is encrypted for
// the phone's own subscription keys (RFC 8291), so the push service carries it without being able to read it, and the
// request is signed with this computer's own key (VAPID, RFC 8292), so only it can send to that subscription.
import fs from 'node:fs';
import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import { atomicJSON } from './patches.mjs';

const b64 = value => Buffer.from(value).toString('base64url');
const unb64 = value => Buffer.from(String(value), 'base64url');
// Only the push services that browsers actually use. A phone can't make this computer post to any other address.
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
const SUBJECT = 'https://codeshi.dev';

// A subscription as the phone's browser reported it, checked before it's kept: an https push service address and the
// two keys of the right length. Anything else is refused rather than stored.
export function pushSubscription(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { endpoint, keys } = input;
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return null;
  let url; try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !PUSH_HOSTS.some(host => host.test(url.hostname))) return null;
  if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.p256dh + keys.auth)) return null;
  const p256dh = unb64(keys.p256dh), auth = unb64(keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null;
  return { endpoint: url.href, keys: { p256dh: b64(p256dh), auth: b64(auth) } };
}

// RFC 8291 with the aes128gcm content coding (RFC 8188): one record, a fresh key pair and salt for every message.
// `ecdh` is only passed by tests, with a fixed key.
export function encryptPush(subscription, payload, { salt = randomBytes(16), ecdh = null } = {}) {
  const phoneKey = unb64(subscription.keys.p256dh), authSecret = unb64(subscription.keys.auth);
  if (!ecdh) { ecdh = createECDH('prime256v1'); ecdh.generateKeys(); }
  const ownKey = ecdh.getPublicKey(), shared = ecdh.computeSecret(phoneKey);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), phoneKey, ownKey]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = ownKey.length;
  return Buffer.concat([header, ownKey, body]);
}

// This computer's signing key, made once and kept in Codeshi's data folder. The phone subscribes with its public half.
export function pushKeys(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.privateKey?.kty === 'EC' && saved.privateKey.crv === 'P-256' && saved.privateKey.d) return keysFrom(saved.privateKey);
  } catch { /* Made below. */ }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  atomicJSON(file, { privateKey: jwk });
  try { fs.chmodSync(file, 0o600); } catch { /* Best effort, as for the other data files. */ }
  return keysFrom(jwk);
}
function keysFrom(jwk) {
  return { privateKey: createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x), unb64(jwk.y)])) };
}

export function vapidAuthorization(endpoint, keys, now = Date.now()) {
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: SUBJECT }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

// Sends one message. Resolves to 'sent', 'gone' (the phone unsubscribed or the subscription expired, so forget it) or
// 'failed'. A failure is never retried: a late notification is worse than a missing one.
export function createWebPush({ keyFile, fetch: send = globalThis.fetch, now = Date.now } = {}) {
  let keys = null;
  const ownKeys = () => (keys ||= pushKeys(keyFile));
  return {
    publicKey: () => ownKeys().publicKey,
    async send(subscription, message, { urgency = 'normal', ttl = 3600 } = {}) {
      const checked = pushSubscription(subscription);
      if (!checked) return 'gone';
      try {
        const response = await send(checked.endpoint, {
          method: 'POST',
          headers: { TTL: String(ttl), Urgency: urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuthorization(checked.endpoint, ownKeys(), now()) },
          body: encryptPush(checked, JSON.stringify(message)),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 404 || response.status === 410) return 'gone';
        return response.ok ? 'sent' : 'failed';
      } catch { return 'failed'; }
    },
  };
}

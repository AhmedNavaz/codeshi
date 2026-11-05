// Shared by the desktop relay and the hosted phone page. No administrator credentials or Firebase SDK bundle.
const encoder = new TextEncoder(), decoder = new TextDecoder();
export const MAX_PACKET = 1024 * 1024;
// Firebase Spark refuses new connections at its shared limit. Local-network pairing doesn't depend on it.
export const REMOTE_BUSY = 'Remote access is busy or unavailable. Codeshi keeps retrying, and same-Wi-Fi access still works.';
export function token(bytes = 32) { return [...crypto.getRandomValues(new Uint8Array(bytes))].map(n => n.toString(16).padStart(2, '0')).join(''); }
const base64 = bytes => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
const unbase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
export async function roomKey(secret) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error('Scan a new Codeshi QR code.');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g), pair => parseInt(pair, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(key, room, direction, value) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > MAX_PACKET) throw Error('This request is too large for remote access. Try a smaller photo or fewer messages.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`codeshi-phone-v1:${room}:${direction}`) }, key, bytes);
  return { iv: base64(iv), data: base64(new Uint8Array(encrypted)) };
}
export async function open(key, room, direction, box) {
  if (!box || typeof box.iv !== 'string' || box.iv.length !== 16 || typeof box.data !== 'string' || box.data.length > Math.ceil((MAX_PACKET + 16) / 3) * 4) throw Error('Invalid encrypted phone packet.');
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(box.iv), additionalData: encoder.encode(`codeshi-phone-v1:${room}:${direction}`) }, key, unbase64(box.data));
  return JSON.parse(decoder.decode(bytes));
}

export function firebaseConfig(input) {
  if (!input || typeof input !== 'object' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId || '') || !/^[A-Za-z0-9_-]{20,200}$/.test(input.apiKey || '')) throw Error('Remote access has not been configured in this Codeshi build.');
  const database = new URL(input.databaseURL), phone = new URL(input.phoneURL);
  if (database.protocol !== 'https:' || database.username || database.password || database.port || database.search || database.hash || database.pathname !== '/' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.(?:firebaseio\.com|firebasedatabase\.app)$/.test(database.hostname)) throw Error('Choose a Firebase Realtime Database HTTPS address.');
  if (phone.protocol !== 'https:' || phone.username || phone.password || phone.port || phone.search || phone.hash || phone.pathname !== '/') throw Error('Choose the hosted phone page’s HTTPS address.');
  return { projectId: input.projectId, apiKey: input.apiKey, databaseURL: database.origin, phoneURL: phone.origin };
}

export class FirebasePhoneClient {
  constructor(config, { fetchImpl = (...args) => globalThis.fetch(...args), load = () => null, save = () => {}, endpoints = null } = {}) {
    this.config = firebaseConfig(config); this.fetch = fetchImpl; this.load = load; this.save = save;
    this.endpoints = endpoints || { auth: 'https://identitytoolkit.googleapis.com/v1', refresh: 'https://securetoken.googleapis.com/v1/token', database: this.config.databaseURL };
    this.auth = null; this.authenticating = null; this.closed = false; this.streams = new Set(); this.requests = new Set();
    // Database application bytes only: request/response bodies and raw SSE chunks. No tokens or payloads are kept.
    // HTTP headers, TLS, authentication and Hosting are excluded, so this is not Firebase's billing meter.
    this.traffic = { uploadBytes: 0, downloadBytes: 0, requests: 0, streams: 0 };
  }
  async identity(force = false) {
    if (this.closed) throw Error('Remote access is off.');
    if (!force && this.auth && Date.now() < this.auth.until) return this.auth;
    if (this.authenticating) return this.authenticating;
    this.authenticating = (async () => {
      const saved = this.auth || this.load();
      const refreshed = Boolean(saved?.refreshToken);
      const url = refreshed ? `${this.endpoints.refresh}?key=${this.config.apiKey}` : `${this.endpoints.auth}/accounts:signUp?key=${this.config.apiKey}`;
      const response = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': refreshed ? 'application/x-www-form-urlencoded' : 'application/json' }, body: refreshed ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refreshToken }).toString() : JSON.stringify({ returnSecureToken: true }), signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw Error('Could not sign in to remote access. Check the connection and Firebase Authentication setup.');
      const auth = { uid: data.localId || data.user_id, idToken: data.idToken || data.id_token, refreshToken: data.refreshToken || data.refresh_token, until: Date.now() + Math.max(60, Number(data.expiresIn || data.expires_in || 3600) - 120) * 1000 };
      if (!auth.uid || !auth.idToken || !auth.refreshToken) throw Error('Firebase returned an incomplete phone session.');
      this.auth = auth; this.save({ uid: auth.uid, refreshToken: auth.refreshToken }); return auth;
    })();
    try { return await this.authenticating; } finally { this.authenticating = null; }
  }
  async request(path, method = 'GET', value = undefined) {
    const auth = await this.identity();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    this.requests.add(controller);
    try {
      const body = value === undefined ? undefined : JSON.stringify(value);
      this.traffic.requests++; this.traffic.uploadBytes += body === undefined ? 0 : encoder.encode(body).length;
      const url = new URL(this.url(path, auth));
      // Firebase otherwise echoes the entire encrypted packet to its sender as well as to the receiving stream.
      if (['PUT', 'POST', 'PATCH'].includes(method)) url.searchParams.set('print', 'silent');
      const response = await this.fetch(url.href, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }), signal: controller.signal });
      const text = await response.text(); this.traffic.downloadBytes += encoder.encode(text).length;
      if (!response.ok) throw Object.assign(Error(response.status === 401 || response.status === 403 ? 'Remote access expired or was removed. Scan a new QR code.' : REMOTE_BUSY), { status: response.status });
      return response.status === 204 ? null : JSON.parse(text);
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  url(path, auth) {
    const url = new URL(`${this.endpoints.database}/${path}.json`);
    url.searchParams.set('auth', auth.idToken);
    if (this.endpoints.namespace) url.searchParams.set('ns', this.endpoints.namespace);
    return url.href;
  }
  watch(path, changed, failed = () => {}) {
    let closed = false, controller = null, retry = null, delay = 500, snapshot = null;
    const connect = async () => {
      try {
        const auth = await this.identity(); if (closed) return;
        controller = new AbortController();
        this.traffic.requests++; this.traffic.streams++;
        const response = await this.fetch(this.url(path, auth), { headers: { Accept: 'text/event-stream' }, signal: controller.signal }).catch(() => { throw Object.assign(Error(REMOTE_BUSY), { busy: true }); });
        // Denied means not allowed yet or any more. Anything else is the service itself, which may be at its limit.
        if (response.status === 401 || response.status === 403) throw Error('Remote connection is unavailable.');
        if (!response.ok || !response.body) throw Object.assign(Error(REMOTE_BUSY), { busy: true });
        delay = 500;
        const reader = response.body.getReader(), utf8 = new TextDecoder(); let buffer = '';
        while (!closed) {
          const { value, done } = await reader.read(); if (done) break;
          this.traffic.downloadBytes += value.byteLength;
          buffer += utf8.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          if (buffer.length > MAX_PACKET * 2) throw Error('Remote event is too large.');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const kind = frame.match(/^event: (.+)$/m)?.[1];
            const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
            if (kind === 'auth_revoked') { this.auth = null; await this.identity(true); throw Error('Refreshing the phone connection.'); }
            if (kind === 'cancel') throw Error('Remote access expired or was removed. Scan a new QR code.');
            if (!['put', 'patch'].includes(kind) || !data) continue;
            const update = JSON.parse(data);
            if (update.path === '/') snapshot = kind === 'patch' ? { ...snapshot, ...update.data } : update.data;
            else {
              const parts = update.path.split('/').filter(Boolean); snapshot ||= {}; let target = snapshot;
              for (const part of parts.slice(0, -1)) target = target[part] ||= {};
              target[parts.at(-1)] = kind === 'patch' ? { ...target[parts.at(-1)], ...update.data } : update.data;
            }
            // A listener cannot make the stream loop reject with an unhandled promise.
            await changed(snapshot);
          }
        }
        if (!closed) throw Error('Reconnecting to your computer…');
      } catch (error) { if (!closed) failed(error); }
      finally {
        controller?.abort();
        if (!closed) { retry = setTimeout(connect, delay); retry.unref?.(); delay = Math.min(delay * 2, 15000); }
      }
    };
    const stop = () => { closed = true; clearTimeout(retry); controller?.abort(); this.streams.delete(stop); };
    this.streams.add(stop); connect(); return stop;
  }
  close() { this.closed = true; for (const stop of [...this.streams]) stop(); for (const request of this.requests) request.abort(); }
}

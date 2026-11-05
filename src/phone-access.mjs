import http from 'node:http';
import os from 'node:os';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const privateIP = address => {
  const ip = String(address || '').replace(/^::ffff:/, ''), parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
};
export const phoneInterfaces = () => Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
  (addresses || []).filter(row => !row.internal && row.family === 'IPv4' && privateIP(row.address)).map(row => ({ name, address: row.address })));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const COOKIE = 'codeshi_phone', FIVE_MINUTES = 5 * 60_000, SESSION = 12 * 60 * 60_000;
const publicDir = new URL('../public/', import.meta.url);

// A separate, explicitly enabled listener. The desktop server remains on loopback. Credentials and device grants
// exist only in memory, so quitting/restarting always turns access off. Paired requests use the existing handler:
// approvals, task ownership and budgets are checked in exactly the same place as requests from the desktop.
export function createPhoneAccess({ handle, local, interfaces = phoneInterfaces, now = Date.now, remote = null } = {}) {
  let server = null, address = null, invite = null, transition = Promise.resolve();
  const devices = new Map(), sockets = new Set(), attempts = new Map();
  const base = () => server?.listening ? `http://${address}:${server.address().port}` : null;
  function remove(device) { devices.delete(device.token); for (const socket of device.sockets) socket.destroy(); }
  function expire() {
    if (invite && now() >= invite.expiresAt) invite = null;
    for (const device of devices.values()) if (now() >= device.expiresAt) remove(device);
    for (const [ip, attempt] of attempts) if (now() - attempt.at >= 60_000) attempts.delete(ip);
  }
  function status() {
    expire();
    return { enabled: Boolean(base()), address, url: base(), interfaces: interfaces(),
      invite: invite ? { code: invite.code, url: `${base()}/#pair=${invite.secret}`, qr: invite.qr, expiresAt: invite.expiresAt } : null,
      devices: [...devices.values()].map(({ id, name, code, state, expiresAt }) => ({ id, name, code, state, expiresAt })), ...(remote ? { remote: remote.status() } : {}) };
  }
  const credential = req => {
    const token = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return token ? devices.get(token) : null;
  };
  async function read(req) {
    if (req.headers['content-type'] !== 'application/json') fail('Send JSON content.', 415);
    let length = 0; const chunks = [];
    for await (const chunk of req) { length += chunk.length; if (length > 4096) fail('Request is too large.', 413); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks)); } catch { fail('Invalid JSON request.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid JSON request.');
    return value;
  }
  async function request(req, res) {
    for (const [key, value] of Object.entries({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" })) res.setHeader(key, value);
    try {
      expire();
      if (!base()) fail('Remote access is off.', 503);
      if (req.headers.host !== `${address}:${server.address().port}`) fail('Use the phone address shown in Codeshi.', 403);
      const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (!privateIP(peer) && peer !== '127.0.0.1') fail('Only local-network connections are allowed.', 403);
      if (req.headers.origin && req.headers.origin !== base()) fail('Cross-origin requests are not allowed.', 403);
      if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) fail('Cross-site requests are not allowed.', 403);
      if (!req.url.startsWith('/') || req.url.startsWith('//')) fail('Use a local path.', 403);
      const url = new URL(req.url, base());
      if (req.method === 'POST' && (req.headers.origin !== base() || req.headers['x-ai-relay'] !== '1')) fail('Send from the paired Codeshi page.', 403);
      if (url.pathname === '/api/phone' || url.pathname.startsWith('/api/phone/')) fail('Manage remote access on the computer.', 403);
      if (req.method === 'GET' && ['/phone-pair.js', '/phone.css', '/editor-theme.css', '/phone-theme.js', '/mark.svg'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/svg+xml' });
        return res.end(fs.readFileSync(new URL(url.pathname.slice(1), publicDir)));
      }
      if (req.method === 'POST' && url.pathname === '/phone/pair') {
        // Both a per-address and a global bound apply; a short manual code never has unlimited guesses.
        if (attempts.size >= 64) fail('Too many pairing attempts. Try again in a minute.', 429);
        const attempt = attempts.get(peer) || { at: now(), count: 0 };
        attempt.count++; attempts.set(peer, attempt);
        if (attempt.count > 5 || [...attempts.values()].reduce((sum, row) => sum + row.count, 0) > 20) fail('Too many pairing attempts. Try again in a minute.', 429);
        const input = await read(req);
        if (!invite || !(same(input.code, invite.code) || same(input.code, invite.secret))) {
          if (invite && ++invite.failures >= 5) invite = null;
          fail('This code expired or does not match. Get a new code on the computer.', 403);
        }
        if (devices.size >= 5) fail('Remove a device on the computer before pairing another.', 409);
        invite = null;
        const device = { token: randomBytes(32).toString('hex'), id: randomBytes(16).toString('hex'), name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : 'Phone browser', code: String(randomInt(100000, 1000000)), state: 'pending', expiresAt: now() + FIVE_MINUTES, sockets: new Set() };
        devices.set(device.token, device);
        // HTTP on a trusted LAN: HttpOnly and Strict protect browser requests; this is not encrypted transport.
        res.setHeader('Set-Cookie', `${COOKIE}=${device.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION / 1000}`);
        return json(res, 202, { state: device.state, code: device.code });
      }
      const device = credential(req);
      if (req.method === 'GET' && url.pathname === '/phone/session') return json(res, device ? 200 : 401, device ? { state: device.state, code: device.code, expiresAt: device.expiresAt } : { error: 'Pair this browser from the computer again.' });
      if (req.method === 'POST' && url.pathname === '/phone/logout') {
        device?.sockets.delete(req.socket);
        if (device) remove(device);
        res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return json(res, 200, { disconnected: true });
      }
      if (!device || device.state !== 'active') {
        if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(new URL('phone-pair.html', publicDir))); }
        return json(res, 401, { error: device ? 'Approve this phone on the computer first.' : 'Pair this browser from the computer again.' });
      }
      // The native speech helper listens to the computer's microphone, not the phone's. Phone users can use their
      // keyboard's dictation without starting or stopping a microphone on a different device.
      if (url.pathname === '/api/voice' && req.method === 'GET') return json(res, 200, { supported: false });
      if (url.pathname.startsWith('/api/voice/')) fail('Use your phone keyboard’s dictation for voice input.', 403);
      if (!device.sockets.has(req.socket)) { device.sockets.add(req.socket); req.socket.once('close', () => device.sockets.delete(req.socket)); }
      const target = local();
      req.headers.host = `127.0.0.1:${target.port}`;
      if (req.headers.origin) req.headers.origin = `http://${req.headers.host}`;
      if (target.accessToken) req.headers['x-ai-relay-token'] = target.accessToken;
      else delete req.headers['x-ai-relay-token'];
      req.phoneClient = true;
      return handle(req, res);
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Phone connection failed. Try again on the computer.' }); else res.end(); }
  }
  async function stop() {
    const previous = server; server = null; address = null; invite = null; attempts.clear();
    for (const device of devices.values()) remove(device);
    for (const socket of sockets) socket.destroy();
    if (previous) await new Promise(resolve => previous.close(resolve));
  }
  async function newInvite() {
    // Load the encoder only when pairing is requested. The QR contains the same one-use local URL as the link;
    // it is generated on this computer and never sent to a QR service.
    const { default: QRCode } = await import('qrcode');
    const next = { code: String(randomInt(10000000, 100000000)), secret: randomBytes(32).toString('hex'), expiresAt: now() + FIVE_MINUTES, failures: 0 };
    next.qr = await QRCode.toDataURL(`${base()}/#pair=${next.secret}`, { errorCorrectionLevel: 'M', margin: 4, scale: 6 });
    invite = next;
    return status();
  }
  async function action(input) {
    if (input.connection === 'remote') { if (!remote) fail('Remote access is not configured.', 409); await remote.manage(input); return status(); }
    expire();
    if (input.action === 'stop') { await stop(); return status(); }
    if (input.action === 'start') {
      if (base()) return status();
      const choices = interfaces();
      const selected = choices.find(row => row.address === input.address) || (!input.address ? choices[0] : null);
      if (!selected) fail('Connect to a private Wi-Fi or Ethernet network, then refresh.');
      address = selected.address;
      const listener = http.createServer(request); server = listener;
      listener.requestTimeout = 30_000; listener.headersTimeout = 10_000; listener.maxHeadersCount = 64;
      listener.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      try { await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, address, () => { listener.removeListener('error', reject); resolve(); }); }); }
      catch { await stop(); fail('Could not open this network address. Check your connection and firewall.', 503); }
      return newInvite();
    }
    if (!base()) fail('Turn on remote access first.', 409);
    if (input.action === 'invite') {
      return newInvite();
    }
    const device = [...devices.values()].find(row => row.id === input.id);
    if (!device) fail('This device request expired or was removed.', 404);
    if (input.action === 'allow' && device.state === 'pending') { device.state = 'active'; device.expiresAt = now() + SESSION; }
    else if (['deny', 'revoke'].includes(input.action)) remove(device);
    else fail('Choose a pending phone or remove a connected one.');
    return status();
  }
  // Serialize start/stop so a quick second click or shutdown cannot leave an untracked listener running.
  const manage = input => { const next = transition.then(() => action(input)); transition = next.catch(() => {}); return next; };
  const timer = setInterval(expire, 30_000); timer.unref();
  return { status, manage, close: async () => { clearInterval(timer); await manage({ action: 'stop' }); await remote?.close(); } };
}

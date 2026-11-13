// Move to another computer over the local network (#160). The old computer makes a Codeshi backup (the same file
// Export Codeshi Backup writes) and offers it on a short-lived listener on this network. The new computer connects with
// a move code typed from the old one's screen, both screens show the same six digits, and the backup is sent only once
// you choose Allow on the old computer. The new computer then imports it as it would a backup file: it asks where each
// workspace's folders are, and never replaces a conversation that changed here without asking.
//
// No server and no relay are involved, and the code never travels over the network:
// - The move code is the address and port of the listener and 80 random bits. The bits make the backup's passphrase
//   and a key that every request proves it holds, so the listener answers nobody who wasn't shown the code.
// - The backup is sealed as a backup file is (AES-256-GCM pieces, scrypt), so the network only ever carries ciphertext,
//   and a file that was changed or cut short on the way is refused when it's opened.
// - Each connecting computer has its own six digits, so comparing them tells you the request you allow is from the
//   computer in front of you, even if someone else saw the code.
// - The listener closes once the backup has been sent, when you stop, or after 15 minutes. Its file is deleted then.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { exportBackup } from './backup.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
// Crockford's base32: no I, L, O or U, so a code read off a screen can't be typed wrong in those ways.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ', SECRET_BYTES = 10;
const OPEN_FOR = 15 * 60 * 1000, MAX_REQUESTS = 3, MAX_ATTEMPTS = 20, CHECK_EVERY = 1000;
// A move's backup needs no slow key derivation: its passphrase is 80 random bits, not something a person chose.
const MOVE_KDF = Object.freeze({ name: 'scrypt', N: 2 ** 14, r: 8, p: 1 });
const PREFIX = '.move-';

function encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function decode(text) {
  let bits = 0, value = 0; const out = [];
  for (const char of text) { const index = ALPHABET.indexOf(char); if (index < 0) return null; value = (value << 5) | index; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
const keysOf = secret => ({ auth: hmac(secret, 'codeshi-move-v1:auth'), passphrase: `move-${hmac(secret, 'codeshi-move-v1:backup').toString('hex').slice(0, 40)}`, check: hmac(secret, 'codeshi-move-v1:check') });
const proofOf = (auth, verb, nonce) => hmac(auth, `${verb}:${nonce}`).toString('hex');
// Six digits both computers work out from the code and the connecting computer's nonce.
export const checkDigits = (secret, nonce) => String(hmac(keysOf(secret).check, nonce).readUInt32BE(0) % 1_000_000).padStart(6, '0');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const NONCE = /^[a-f\d]{32}$/;
const computerName = () => os.hostname().replace(/\.local$/, '').slice(0, 80) || 'Another computer';

// Addresses on a private network: 10/8, 172.16/12, 192.168/16, link-local 169.254/16 and 100.64/10 (shared address
// space, which some VPNs between your own computers use). The receiving side connects to nothing else.
export function privateAddress(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255) || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
export function localAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces || {})) for (const entry of entries || []) {
    if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && privateAddress(entry.address)) found.push({ name, address: entry.address });
  }
  // Wi-Fi and Ethernet before VPNs and bridges, so the first code shown is the one most likely to work.
  const rank = item => /^(en|eth|wlan|wl|Wi-?Fi|Ethernet)/i.test(item.name) ? 0 : item.address.startsWith('169.254.') ? 2 : 1;
  return found.sort((a, b) => rank(a) - rank(b)).map(item => item.address).filter((address, index, all) => all.indexOf(address) === index);
}

export const formatCode = (address, port, secret) => `${address}:${port}/${encode(secret).match(/.{1,4}/g).join('-')}`;
// The code as typed or pasted: spaces, dashes and case don't matter, and a pasted line with words around it is fine.
export function parseCode(text, { allowLoopback = false } = {}) {
  const match = String(text || '').trim().match(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\s*\/\s*([0-9A-Za-z]{4}(?:[\s-]?[0-9A-Za-z]{4}){3})(?![0-9A-Za-z])/);
  if (!match) fail('Type the whole move code shown on the other computer, such as 192.168.1.20:52143/7KQM-2XHD-9PTA-W3CZ.');
  const [, address, portText, raw] = match, port = Number(portText);
  if (!(privateAddress(address) || (allowLoopback && address === '127.0.0.1'))) fail('That address isn’t on a local network. Both computers need to be on the same Wi-Fi or network.');
  if (!(port >= 1024 && port <= 65535)) fail('That move code isn’t complete. Check the number after the colon.');
  const letters = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const secret = letters.length === 16 ? decode(letters) : null;
  if (!secret || secret.length !== SECRET_BYTES) fail('That move code isn’t right. Check the letters after the slash.');
  return { address, port, secret };
}

const reply = (res, status, value) => { const body = Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' }); res.end(body); };

// Remove move files a crash or quit left behind.
export function sweepMoves(dataRoot) {
  let entries = []; try { entries = fs.readdirSync(dataRoot); } catch { return; }
  // A backup being written is named .<name>.<id>.partial, so a move's starts with ..move-.
  for (const name of entries) if (name.startsWith(PREFIX) || name.startsWith(`.${PREFIX}`)) try { fs.rmSync(path.join(dataRoot, name), { force: true, recursive: true }); } catch { /* Next time. */ }
}

// The old computer's side: one move at a time.
export function createMoveSender({ registry, settings = () => ({}), addresses = localAddresses, host = '0.0.0.0', now = Date.now, kdf = MOVE_KDF, openFor = OPEN_FOR }) {
  let move = null;

  function view() {
    if (!move) return { state: 'idle' };
    return {
      state: move.state, codes: move.codes, bytes: move.bytes, sent: move.sent, expiresAt: move.expiresAt, error: move.error || null,
      workspaces: move.workspaces, requests: [...move.requests.values()].map(item => ({ id: item.id, computer: item.computer, check: item.check, state: item.state })),
    };
  }
  function close(state = 'closed', error = null) {
    if (!move) return;
    const current = move;
    clearTimeout(current.timer);
    if (!['sent', 'failed'].includes(current.state) || state === 'failed') { current.state = state; current.error = error; }
    try { current.server?.close(); current.server?.closeAllConnections?.(); } catch { /* Already closed. */ }
    if (current.file) fs.rmSync(current.file, { force: true });
  }

  async function handle(req, res) {
    const current = move, url = new URL(req.url, 'http://move');
    if (!current || !['waiting', 'sending'].includes(current.state)) return reply(res, 410, { error: 'This move has ended. Start it again on the other computer.' });
    // Every request has to prove it was given the code; too many wrong ones close the listener.
    const refuse = () => { if (++current.attempts >= MAX_ATTEMPTS) close('failed', 'Too many connections with a wrong code. Start the move again.'); return reply(res, 403, { error: 'Wrong move code.' }); };
    if (req.method === 'POST' && url.pathname === '/move/hello') {
      let raw = ''; req.setEncoding('utf8');
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return reply(res, 413, { error: 'Too large.' }); }
      let input; try { input = JSON.parse(raw); } catch { return refuse(); }
      if (!NONCE.test(input?.nonce || '') || !same(input.proof, proofOf(current.keys.auth, 'hello', input.nonce))) return refuse();
      if (!current.requests.has(input.nonce)) {
        if (current.requests.size >= MAX_REQUESTS) return reply(res, 429, { error: 'Too many computers are asking. Start the move again.' });
        current.requests.set(input.nonce, { id: input.nonce.slice(0, 12), nonce: input.nonce, computer: typeof input.computer === 'string' && input.computer.trim() ? input.computer.trim().slice(0, 80) : 'Another computer', check: checkDigits(current.secret, input.nonce), state: 'pending' });
      }
      return reply(res, 200, { computer: computerName(), bytes: current.bytes, workspaces: current.workspaces.length, settings: current.settings });
    }
    const nonce = url.searchParams.get('nonce') || '', request = current.requests.get(nonce);
    if (req.method === 'GET' && url.pathname === '/move/status') {
      if (!request || !same(url.searchParams.get('proof'), proofOf(current.keys.auth, 'status', nonce))) return refuse();
      return reply(res, 200, { state: request.state });
    }
    if (req.method === 'GET' && url.pathname === '/move/file') {
      if (!request || !same(url.searchParams.get('proof'), proofOf(current.keys.auth, 'file', nonce))) return refuse();
      if (request.state !== 'allowed') return reply(res, 409, { error: 'Not allowed yet.' });
      if (current.state === 'sending') return reply(res, 409, { error: 'Already sending.' });
      current.state = 'sending'; current.sent = 0;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': current.bytes, 'cache-control': 'no-store' });
      const stream = fs.createReadStream(current.file);
      stream.on('data', chunk => { current.sent += chunk.length; });
      stream.on('error', () => { res.destroy(); if (move === current) { current.state = 'waiting'; request.state = 'allowed'; } });
      res.on('close', () => {
        if (move !== current) return;
        if (res.writableFinished && current.sent === current.bytes) { current.state = 'sent'; setTimeout(() => close('sent'), 2000).unref?.(); }
        else if (current.state === 'sending') { current.state = 'waiting'; if (now() > current.expiresAt) close('expired'); }
      });
      stream.pipe(res);
      return;
    }
    reply(res, 404, { error: 'Not found.' });
  }

  async function start({ workspaces = [], includeSettings = true } = {}) {
    if (move && ['preparing', 'waiting', 'sending'].includes(move.state)) fail('A move is already open. Stop it first.', 409);
    const found = addresses();
    if (!found.length) fail('This computer isn’t on a local network. Connect both computers to the same Wi-Fi or network, or use Export Codeshi Backup instead.', 409);
    const secret = randomBytes(SECRET_BYTES), keys = keysOf(secret), id = randomUUID();
    const current = { id, state: 'preparing', secret, keys, codes: [], bytes: 0, sent: 0, attempts: 0, requests: new Map(), workspaces: [], settings: includeSettings, file: null, server: null, timer: null, expiresAt: null };
    move = current;
    try {
      const exported = await exportBackup({ registry, settings: settings(), file: path.join(registry.dataRoot, `${PREFIX}${id}`), passphrase: keys.passphrase, workspaces, includeSettings, kdf });
      current.file = exported.path; current.bytes = fs.statSync(exported.path).size;
      current.workspaces = workspaces.map(item => registry.entry(String(item?.id || '')).name);
      if (move !== current) { fs.rmSync(current.file, { force: true }); fail('The move was stopped.', 409); }
      const server = http.createServer((req, res) => { handle(req, res).catch(() => { try { reply(res, 500, { error: 'Something went wrong.' }); } catch { res.destroy(); } }); });
      server.headersTimeout = 10000; server.requestTimeout = 0;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => { server.off('error', reject); resolve(); }); });
      current.server = server;
      const port = server.address().port;
      current.codes = found.map(address => formatCode(address, port, secret));
      current.state = 'waiting'; current.expiresAt = now() + openFor;
      current.timer = setTimeout(() => { if (move === current && current.state !== 'sending') close('expired'); }, openFor); current.timer.unref?.();
      return view();
    } catch (error) {
      if (move === current) close('failed', error.message);
      throw error;
    }
  }

  function answer(id, allow) {
    if (!move || move.state !== 'waiting') fail('There’s no move waiting for an answer.', 409);
    const request = [...move.requests.values()].find(item => item.id === id);
    if (!request) fail('That computer is no longer asking.', 404);
    if (request.state !== 'pending') return view();
    // One computer receives a move. Allowing one turns the others away.
    if (allow) for (const item of move.requests.values()) item.state = item === request ? 'allowed' : 'denied';
    else request.state = 'denied';
    return view();
  }

  return { view, start, allow: id => answer(id, true), deny: id => answer(id, false), stop: () => { close('closed'); return view(); }, close: () => close('closed') };
}

// The new computer's side: connect with a code, wait for Allow, then download the backup into Codeshi's data folder.
export function createMoveReceiver({ registry, allowLoopback = false, request = http.request, checkEvery = CHECK_EVERY }) {
  let move = null;
  const view = () => move ? { state: move.state, computer: move.computer, check: move.check, bytes: move.bytes, received: move.received, error: move.error || null, ...(move.state === 'ready' ? { path: move.file, passphrase: move.keys.passphrase } : {}) } : { state: 'idle' };

  function call(current, method, pathname, body = null, { stream = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ host: current.address, port: current.port, method, path: pathname, timeout: 10000, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, res => {
        if (stream && res.statusCode === 200) { resolve(res); return; }
        let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { if (raw.length < 8192) raw += chunk; });
        res.on('end', () => { let value = {}; try { value = JSON.parse(raw); } catch { /* Not JSON. */ } if (res.statusCode >= 400) reject(Object.assign(new Error(value.error || `The other computer answered ${res.statusCode}.`), { status: res.statusCode })); else resolve(value); });
      });
      current.req = req;
      req.on('timeout', () => req.destroy(Object.assign(new Error('The other computer stopped answering.'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      req.end(body || undefined);
    });
  }
  const unreachable = error => /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|stopped answering/.test(`${error?.code || ''} ${error?.message || ''}`);
  const reachText = 'Couldn’t reach the other computer. Check that both are on the same network, the move is still open there, and its firewall lets Codeshi accept connections.';

  async function download(current, nonce) {
    const res = await call(current, 'GET', `/move/file?nonce=${nonce}&proof=${proofOf(current.keys.auth, 'file', nonce)}`, null, { stream: true });
    if (Number(res.headers['content-length']) !== current.bytes) { res.destroy(); fail('The other computer sent something unexpected. Start the move again.', 502); }
    current.state = 'receiving';
    const handle = fs.openSync(current.file, 'wx', 0o600);
    try {
      for await (const chunk of res) {
        if (move !== current) { res.destroy(); return; }
        if (current.received + chunk.length > current.bytes) { res.destroy(); fail('The other computer sent more than it said. Start the move again.', 502); }
        fs.writeSync(handle, chunk); current.received += chunk.length;
      }
    } finally { fs.closeSync(handle); }
    if (current.received !== current.bytes) fail('The move was cut off. Start it again on the other computer.', 502);
    current.state = 'ready';
  }

  async function follow(current, nonce) {
    try {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, checkEvery));
        if (move !== current) return;
        const status = await call(current, 'GET', `/move/status?nonce=${nonce}&proof=${proofOf(current.keys.auth, 'status', nonce)}`);
        if (move !== current) return;
        if (status.state === 'denied') { current.state = 'denied'; return; }
        if (status.state === 'allowed') { await download(current, nonce); return; }
      }
    } catch (error) {
      if (move !== current) return;
      current.state = 'failed'; current.error = error.status === 410 ? 'The move ended on the other computer. Start it again there.' : unreachable(error) ? reachText : error.message;
      fs.rmSync(current.file, { force: true });
    }
  }

  async function connect(code) {
    if (move && ['asking', 'receiving'].includes(move.state)) fail('Already receiving a move. Stop it first.', 409);
    discard();
    const { address, port, secret } = parseCode(code, { allowLoopback });
    const nonce = randomBytes(16).toString('hex'), keys = keysOf(secret);
    const current = { address, port, keys, state: 'connecting', computer: null, check: checkDigits(secret, nonce), bytes: 0, received: 0, file: path.join(registry.dataRoot, `${PREFIX}incoming-${randomUUID()}.codeshibackup`), req: null };
    move = current;
    let hello;
    try { hello = await call(current, 'POST', '/move/hello', JSON.stringify({ nonce, proof: proofOf(keys.auth, 'hello', nonce), computer: computerName() })); }
    catch (error) {
      if (move === current) move = null;
      if (error.status === 403) fail('That move code isn’t right. Check it against the other computer’s screen.', 403);
      if (error.status === 410) fail('The move ended on the other computer. Start it again there.', 410);
      if (unreachable(error)) fail(reachText, 502);
      throw error;
    }
    if (!Number.isSafeInteger(hello.bytes) || hello.bytes <= 0 || hello.bytes > 64 * 1024 ** 3) { move = null; fail('The other computer sent something unexpected.', 502); }
    current.computer = typeof hello.computer === 'string' ? hello.computer.slice(0, 80) : null; current.bytes = hello.bytes; current.state = 'asking';
    follow(current, nonce);
    return view();
  }

  // Stops a move in progress, or clears a finished one, and deletes what was received.
  function discard() {
    const current = move; move = null;
    if (!current) return;
    try { current.req?.destroy(); } catch { /* Already closed. */ }
    fs.rmSync(current.file, { force: true });
  }

  return { view, connect, stop: () => { discard(); return view(); }, close: discard };
}

export function createMoveRoutes({ registry, body, json, settings, sender = createMoveSender({ registry, settings }), receiver = createMoveReceiver({ registry }) }) {
  sweepMoves(registry.dataRoot);
  const routes = async ({ req, res, url }) => {
    if (!url.pathname.startsWith('/api/move/')) return false;
    if (req.phoneClient) fail('Move Codeshi on the computer.', 403);
    const parts = url.pathname.split('/'), send = parts[3] === 'send', action = parts[4] || '';
    if (parts.length > 5 || !['send', 'receive'].includes(parts[3])) fail('Not found.', 404);
    if (req.method === 'GET') { if (action) fail('Not found.', 404); json(res, 200, send ? sender.view() : receiver.view()); return true; }
    if (req.method !== 'POST') fail('Use GET or POST.', 405);
    const input = await body(req, 64 * 1024);
    if (send) {
      if (action === '') json(res, 200, await sender.start({ workspaces: Array.isArray(input.workspaces) ? input.workspaces : [], includeSettings: input.settings === true }));
      else if (action === 'allow') json(res, 200, sender.allow(String(input.id || '')));
      else if (action === 'deny') json(res, 200, sender.deny(String(input.id || '')));
      else if (action === 'stop') json(res, 200, sender.stop());
      else fail('Not found.', 404);
      return true;
    }
    if (action === '') json(res, 200, await receiver.connect(input.code));
    else if (action === 'stop') json(res, 200, receiver.stop());
    else fail('Not found.', 404);
    return true;
  };
  routes.close = () => { sender.close(); receiver.close(); };
  return routes;
}

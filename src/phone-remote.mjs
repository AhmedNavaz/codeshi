import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { atomicJSON } from './patches.mjs';
import { FirebasePhoneClient, firebaseConfig, token, roomKey, seal, open, MAX_PACKET } from '../public/phone-firebase.mjs';
import { TRANSFER_ENCODING, conversationRoute, encodeConversation } from '../public/phone-transfer.mjs';

const FIVE_MINUTES = 300_000, SESSION = 12 * 60 * 60_000;
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const allowedGet = new Set(['/api/projects', '/api/status', '/api/conversation']);
const allowedPost = new Set(['/api/tasks', '/api/tasks/plan', '/api/attachments']);
export function phoneRemotePath(method, path) {
  if (typeof path !== 'string' || path.length > 2000 || !path.startsWith('/') || path.startsWith('//') || /[#\\]/.test(path)) return null;
  const url = new URL(path, 'http://phone.local');
  const allowed = method === 'GET' ? allowedGet.has(url.pathname) || /^\/api\/providers\/(codex|claude|gemini)\/(account|usage|models)$/.test(url.pathname)
    : method === 'POST' && (allowedPost.has(url.pathname) || /^\/api\/conversations\/[a-zA-Z0-9-]+\/(messages|approval|answer|stop|provider|queue|steer|handoff|retry|continue|resume|routing)$/.test(url.pathname));
  if (!allowed) return null;
  if (url.pathname === '/api/conversation') url.searchParams.set('tail', String(Math.min(Math.max(Number(url.searchParams.get('tail')) || 40, 1), 100)));
  return url.pathname + url.search;
}

// Invoke only the phone API subset, through the same handler as the local desktop. No new socket, localhost proxy,
// caller-supplied headers, file paths, terminal access, microphone access or settings management is exposed.
export function phoneRemoteRequest({ handle, local }, input) {
  const path = phoneRemotePath(input.method, input.path);
  if (!path) return Promise.resolve({ status: 403, body: { error: 'This action is available only on the computer.' } });
  return new Promise((resolve, reject) => {
    const body = input.method === 'POST' ? Buffer.from(JSON.stringify(input.body ?? {})) : Buffer.alloc(0);
    if (body.length > MAX_PACKET) return resolve({ status: 413, body: { error: 'This request is too large for remote access.' } });
    const target = local(), host = `127.0.0.1:${target.port}`;
    const req = Readable.from(body.length ? [body] : []);
    Object.assign(req, { method: input.method, url: path, phoneClient: true, headers: { host, origin: `http://${host}`, 'content-type': 'application/json', 'x-ai-relay': '1', ...(target.accessToken ? { 'x-ai-relay-token': target.accessToken } : {}) }, socket: { remoteAddress: '127.0.0.1' } });
    let length = 0; const chunks = [], headers = new Map();
    const res = new Writable({ write(chunk, encoding, done) { length += chunk.length; if (length > MAX_PACKET - 2048) return done(Error('The remote response is too large. Show fewer messages.')); chunks.push(Buffer.from(chunk)); done(); } });
    res.statusCode = 200; res.headersSent = false;
    res.setHeader = (key, value) => { headers.set(key.toLowerCase(), value); return res; };
    res.getHeader = key => headers.get(key.toLowerCase());
    res.writeHead = (status, values = {}) => { res.statusCode = status; res.headersSent = true; for (const [key, value] of Object.entries(values)) res.setHeader(key, value); return res; };
    const timeout = setTimeout(() => { req.destroy(); res.destroy(Error('The computer took too long to respond.')); }, 25000); timeout.unref();
    res.once('error', error => { clearTimeout(timeout); reject(error); });
    res.once('finish', () => {
      clearTimeout(timeout); req.destroy();
      try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); }
      catch { reject(Error('The phone endpoint did not return JSON.')); }
    });
    try { Promise.resolve(handle(req, res)).catch(error => res.destroy(error)); } catch (error) { res.destroy(error); }
  });
}

export function createRemotePhoneAccess({ config, storeFile, handle, local, clientFactory, now = Date.now } = {}) {
  let settings = null, setupError = null;
  if (config) { try { settings = firebaseConfig(config); } catch (error) { setupError = error.message; } }
  let client = null, enabled = false, invite = null, error = null, generation = 0, transition = Promise.resolve(), lastTraffic = null;
  const rooms = new Map();
  const load = () => { try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { return null; } };
  const save = value => { if (storeFile) atomicJSON(storeFile, value); };
  function status() {
    return { configured: Boolean(settings), enabled, error: setupError || error, url: settings?.phoneURL || null,
      traffic: client?.traffic ? { ...client.traffic } : lastTraffic,
      invite: invite && now() < invite.expiresAt ? { url: invite.url, qr: invite.qr, expiresAt: invite.expiresAt } : null,
      devices: [...rooms.values()].filter(room => room.state !== 'waiting').map(({ id, name, code, state, expiresAt }) => ({ id, name, code, state, expiresAt })) };
  }
  async function publish(room, value) {
    if (!enabled || !rooms.has(room.id)) return;
    await client.request(`rooms/${room.id}/out`, 'PUT', await seal(room.key, room.id, 'out', { ...value, at: now() }));
  }
  async function metadata(room) {
    await client.request(`rooms/${room.id}/meta`, 'PUT', { owner: room.owner, state: room.state, peer: room.peer || '', expiresAt: room.expiresAt });
  }
  async function remove(room) {
    rooms.delete(room.id); room.stop?.(); clearTimeout(room.timer);
    if (invite?.id === room.id) invite = null;
    // Expiry and rules still deny access if deletion cannot reach Firebase.
    try {
      await client?.request(`rooms/${room.id}`, 'DELETE');
      await client?.request(`owners/${room.owner}/${room.id}`, 'DELETE');
    } catch { error = 'Disconnected locally. Firebase cleanup will be retried when remote access is enabled again.'; }
  }
  async function receive(room, envelope) {
    if (!enabled || !rooms.has(room.id) || !envelope?.box || typeof envelope.uid !== 'string') return;
    if (now() >= room.expiresAt) return remove(room);
    let request;
    try { request = await open(room.key, room.id, 'request', envelope.box); } catch { return; }
    if (typeof request.id !== 'string' || !/^[a-f0-9]{32}$/.test(request.id) || !Number.isFinite(request.at) || Math.abs(now() - request.at) > 30_000) return;
    if (room.peer && room.peer !== envelope.uid) return;
    for (const [id, entry] of room.seen) if (now() > entry.expiresAt) room.seen.delete(id);
    if (room.seen.has(request.id)) { const reply = room.seen.get(request.id).reply; if (reply) await publish(room, reply); return; }
    const minute = Math.floor(now() / 60000);
    if (room.minute !== minute) { room.minute = minute; room.requests = 0; }
    if (++room.requests > 90 || room.seen.size >= 128) {
      await publish(room, { id: request.id, status: 429, body: { error: 'Remote access is busy. Try again shortly.' } }); return;
    }
    // Never evict a live request ID to make room: an older encrypted mutation must remain non-replayable for its
    // entire acceptance window, even if the phone floods the mailbox with session checks.
    const entry = { expiresAt: request.at + 30000, reply: null }; room.seen.set(request.id, entry);
    let reply;
    if (request.kind === 'pair' && room.state === 'waiting') {
      if (!/^[0-9]{6}$/.test(request.code || '')) return;
      room.peer = envelope.uid; room.code = request.code;
      room.name = typeof request.name === 'string' && request.name.trim() ? request.name.trim().slice(0, 60) : 'Remote phone';
      room.state = 'pending'; invite = null;
      await metadata(room);
      reply = { id: request.id, state: 'pending', code: room.code };
    } else if (request.kind === 'session') reply = { id: request.id, state: room.state, code: room.code, expiresAt: room.expiresAt };
    else if (room.state !== 'active') reply = { id: request.id, status: 401, body: { error: 'Approve this phone on the computer first.' } };
    else if (request.kind === 'logout') { await remove(room); return; }
    else if (request.kind === 'api') {
      try {
        reply = { id: request.id, ...await phoneRemoteRequest({ handle, local }, request) };
        const view = request.method === 'GET' && conversationRoute(request.path);
        if (view && request.transfer?.encoding === TRANSFER_ENCODING && reply.status === 200 && Array.isArray(reply.body?.messages)) {
          const base = token(16), encoded = encodeConversation(reply.body, view, request.transfer.base, room.conversation, base);
          reply.body = encoded.body; reply.transfer = { encoding: TRANSFER_ENCODING, base }; room.conversation = encoded.state;
        }
      }
      catch (failure) { reply = { id: request.id, status: 503, body: { error: failure.message } }; }
    } else reply = { id: request.id, status: 400, body: { error: 'Unknown phone request.' } };
    // Removal or expiry while the local handler was running cannot restore the device or publish another reply.
    if (!enabled || !rooms.has(room.id) || now() >= room.expiresAt) return;
    entry.reply = reply;
    let cached = 0;
    for (const previous of [...room.seen.values()].reverse()) if (previous.reply) {
      cached += Buffer.byteLength(JSON.stringify(previous.reply));
      if (cached > 2 * MAX_PACKET) previous.reply = null;
    }
    await publish(room, reply); error = null;
  }
  async function newInvite() {
    if (invite) await remove(invite);
    if (rooms.size >= 5) fail('Remove a remote phone before pairing another.', 409);
    const id = token(), secret = token(), identity = await client.identity();
    const room = { id, key: await roomKey(secret), owner: identity.uid, state: 'waiting', peer: '', expiresAt: now() + FIVE_MINUTES, seen: new Map(), requests: 0 };
    rooms.set(id, room);
    try {
      await client.request(`owners/${room.owner}/${id}`, 'PUT', true);
      await metadata(room);
      room.url = `${settings.phoneURL}/#remote=${id}.${secret}`;
      const { default: QRCode } = await import('qrcode');
      room.qr = await QRCode.toDataURL(room.url, { errorCorrectionLevel: 'M', margin: 4, scale: 6 });
      room.stop = client.watch(`rooms/${id}/request`, value => receive(room, value), failure => { error = failure?.busy ? failure.message : 'Remote connection interrupted. Retrying…'; });
      room.timer = setTimeout(() => remove(room), FIVE_MINUTES); room.timer.unref();
      invite = room;
    } catch (failure) { await remove(room); throw failure; }
    return status();
  }
  async function stop() {
    enabled = false; generation++; invite = null;
    const cleanup = Promise.allSettled([...rooms.values()].map(remove));
    let timeout;
    // Local authorization ends immediately, even without internet. Do not hold application shutdown open for
    // cloud cleanup; any remaining owner-index entries are retried on the next enable.
    await Promise.race([cleanup, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
    clearTimeout(timeout);
    if (client?.traffic) lastTraffic = { ...client.traffic };
    client?.close(); client = null;
    return status();
  }
  async function action(input) {
    if (input.action === 'stop') return stop();
    if (!settings) fail(setupError || 'Remote phone access is not configured in this build.', 409);
    if (input.action === 'start') {
      if (enabled) return status();
      client = clientFactory ? clientFactory(settings) : new FirebasePhoneClient(settings, { load, save });
      enabled = true; error = null;
      try {
        const identity = await client.identity();
        // An app restart always disconnects previously paired phones, including records left by a crash.
        const previous = await client.request(`owners/${identity.uid}`) || {};
        for (const id of Object.keys(previous)) if (/^[a-f0-9]{64}$/.test(id)) {
          await client.request(`rooms/${id}`, 'DELETE'); await client.request(`owners/${identity.uid}/${id}`, 'DELETE');
        }
        return await newInvite();
      } catch (failure) { await stop(); fail(failure.message, 503); }
    }
    if (!enabled) fail('Enable remote access first.', 409);
    if (input.action === 'invite') return newInvite();
    const room = rooms.get(input.id);
    if (!room || now() >= room.expiresAt) fail('This remote phone request expired or was removed.', 404);
    if (['deny', 'revoke'].includes(input.action)) { await remove(room); return status(); }
    if (input.action !== 'allow' || room.state !== 'pending') fail('Choose a pending phone or remove a connected one.');
    room.state = 'active'; room.expiresAt = now() + SESSION;
    try { await metadata(room); await publish(room, { state: 'active', code: room.code, expiresAt: room.expiresAt }); }
    catch (failure) { await remove(room); fail(failure.message, 503); }
    clearTimeout(room.timer); room.timer = setTimeout(() => remove(room), SESSION); room.timer.unref();
    return status();
  }
  let eventTimer = null;
  let projectsChanged = false;
  function notify(kind = 'update') {
    if (kind === 'projects') projectsChanged = true;
    if (!enabled || eventTimer) return;
    // One small invalidation every two seconds; the visible phone asks for a delta. Full transcripts and individual token
    // events never go into Firebase. A hidden page closes its listener and stops requesting updates.
    const current = generation;
    eventTimer = setTimeout(() => {
      eventTimer = null;
      if (current !== generation) return;
      const changed = projectsChanged; projectsChanged = false;
      for (const room of rooms.values()) if (room.state === 'active') publish(room, { event: 'update', ...(changed ? { projectsChanged: true } : {}) }).catch(() => { error = 'Remote connection interrupted. Retrying…'; });
    }, 2000); eventTimer.unref();
  }
  const manage = input => { const next = transition.then(() => action(input)); transition = next.catch(() => {}); return next; };
  return { status, manage, notify, close: async () => { clearTimeout(eventTimer); await manage({ action: 'stop' }); } };
}

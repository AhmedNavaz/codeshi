import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { atomicJSON } from './patches.mjs';
import { FirebasePhoneClient, firebaseConfig, token, roomKey, seal, open, MAX_PACKET, handoverCode, handoverMeeting, handoverKeys, handoverShared } from '../public/phone-firebase.mjs';
import { TRANSFER_ENCODING, conversationRoute, encodeConversation } from '../public/phone-transfer.mjs';
import { pushSubscription } from './web-push.mjs';

const FIVE_MINUTES = 300_000, SESSION = 7 * 24 * 60 * 60_000, ACTIVE_WINDOW = 45_000;
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const allowedGet = new Set(['/api/projects', '/api/status', '/api/conversation']);
const allowedPost = new Set(['/api/tasks', '/api/tasks/plan', '/api/attachments']);
export function phoneRemotePath(method, path) {
  if (typeof path !== 'string' || path.length > 2000 || !path.startsWith('/') || path.startsWith('//') || /[#\\]/.test(path)) return null;
  const url = new URL(path, 'http://phone.local');
  const allowed = method === 'GET' ? allowedGet.has(url.pathname) || /^\/api\/providers\/(codex|claude|gemini)\/(account|usage|models)$/.test(url.pathname)
    : method === 'POST' && (allowedPost.has(url.pathname) || /^\/api\/conversations\/[a-zA-Z0-9-]+\/(messages|approval|answer|stop|provider|queue|steer|handoff|retry|continue|resume|routing|execution-policy)$/.test(url.pathname));
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

export function createRemotePhoneAccess({ config, storeFile, handle, local, clientFactory, push = null, now = Date.now } = {}) {
  let settings = null, setupError = null;
  if (config) { try { settings = firebaseConfig(config); } catch (error) { setupError = error.message; } }
  let client = null, enabled = false, invite = null, error = null, generation = 0, transition = Promise.resolve(), lastTraffic = null;
  const rooms = new Map();
  const readStore = () => { try { return storeFile ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : null; } catch { return null; } };
  let storedAuth = readStore();
  const isActiveNow = room => room.state === 'active' && room.activeNow !== false && Boolean(room.lastSeenAt && now() - room.lastSeenAt < ACTIVE_WINDOW);
  const serializedRooms = () => [...rooms.values()]
    .filter(room => room.state === 'active' && !room.handoverFrom && room.secret && now() < room.expiresAt)
    .map(({ id, secret, owner, peer, name, code, expiresAt, lastSeenAt, approvedAt, deviceId, push }) => ({
      id, secret, owner: owner || null, peer, name, code, state: 'active', expiresAt,
      lastSeenAt: lastSeenAt || null, approvedAt: approvedAt || null, deviceId: deviceId || null,
      ...(push ? { push } : {}),
    }));
  function persist(authPatch = null) {
    if (!storeFile) return;
    const current = readStore() || storedAuth || {};
    if (authPatch) storedAuth = { ...current, ...authPatch };
    else storedAuth = current;
    const activeRooms = enabled ? serializedRooms() : [];
    atomicJSON(storeFile, {
      ...(storedAuth?.uid && storedAuth?.refreshToken ? { uid: storedAuth.uid, refreshToken: storedAuth.refreshToken } : {}),
      enabled: Boolean(enabled && activeRooms.length > 0),
      rooms: activeRooms,
    });
  }
  const load = () => {
    const data = readStore() || storedAuth;
    return data?.uid && data?.refreshToken ? { uid: data.uid, refreshToken: data.refreshToken } : null;
  };
  const save = value => persist(value);
  function status() {
    for (const room of [...rooms.values()]) if (now() >= room.expiresAt) {
      rooms.delete(room.id); room.stop?.(); clearTimeout(room.timer);
      if (invite?.id === room.id) invite = null;
    }
    return { configured: Boolean(settings), enabled, error: setupError || error, url: settings?.phoneURL || null,
      traffic: client?.traffic ? { ...client.traffic } : lastTraffic,
      invite: invite && now() < invite.expiresAt ? { url: invite.url, qr: invite.qr, expiresAt: invite.expiresAt } : null,
      devices: [...rooms.values()].filter(room => room.state !== 'waiting' && !room.meetingFor).map(room => ({
        id: room.id, name: room.name, code: room.code, state: room.state, expiresAt: room.expiresAt,
        lastSeenAt: room.lastSeenAt || null, activeNow: isActiveNow(room), notifications: Boolean(room.push),
      })) };
  }
  async function publish(room, value) {
    if (!enabled || !rooms.has(room.id)) return;
    await client.request(`rooms/${room.id}/out`, 'PUT', await seal(room.key, room.id, 'out', { ...value, at: now() }));
  }
  async function metadata(room) {
    await client.request(`rooms/${room.id}/meta`, 'PUT', { owner: room.owner, state: room.state, peer: room.peer || '', expiresAt: room.expiresAt });
  }
  async function remove(room, { persistStore = true } = {}) {
    rooms.delete(room.id); room.stop?.(); clearTimeout(room.timer);
    if (invite?.id === room.id) invite = null;
    for (const field of ['handoverId', 'meetingId']) if (room[field] && rooms.has(room[field])) {
      const linked = rooms.get(room[field]);
      room[field] = null;
      await remove(linked, { persistStore: false });
    }
    if (persistStore && room.state === 'active') persist();
    // Expiry and rules still deny access if deletion cannot reach Firebase.
    try {
      if (room.owner) {
        await client?.request(`rooms/${room.id}`, 'DELETE');
        await client?.request(`owners/${room.owner}/${room.id}`, 'DELETE');
      }
    } catch { error = 'Disconnected locally. Firebase cleanup will be retried when remote access is enabled again.'; }
  }
  function watchRoom(room) {
    room.stop?.();
    room.stop = client.watch(`rooms/${room.id}/request`, value => receive(room, value), failure => { error = failure?.busy ? failure.message : 'Remote connection interrupted. Retrying…'; });
    clearTimeout(room.timer);
    room.timer = setTimeout(() => remove(room), Math.max(1, room.expiresAt - now()));
    room.timer.unref?.();
  }
  async function receive(room, envelope) {
    if (!enabled || !rooms.has(room.id) || !envelope?.box || typeof envelope.uid !== 'string') return;
    if (now() >= room.expiresAt) return remove(room);
    let request;
    try { request = await open(room.key, room.id, 'request', envelope.box); } catch { return; }
    if (typeof request.id !== 'string' || !/^[a-f0-9]{32}$/.test(request.id) || !Number.isFinite(request.at) || Math.abs(now() - request.at) > 30_000) return;
    if (room.peer && room.peer !== envelope.uid) return;
    // A meeting point answers one key exchange and nothing else: it can never become a phone awaiting approval.
    if (room.meetingFor && request.kind !== 'meet') return;
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
    if (request.kind === 'meet' && room.meetingFor) {
      const target = rooms.get(room.meetingFor), source = target && rooms.get(target.handoverFrom);
      if (room.state !== 'waiting') return;
      // Removing the meeting point is the answer the phone sees: its metadata disappears and it says the code didn't work.
      if (!target || target.state !== 'waiting' || !source || source.state !== 'active' || now() >= target.expiresAt) { await remove(room, { persistStore: false }); return; }
      room.peer = envelope.uid; room.state = 'pending';
      await metadata(room);
      let mine, shared;
      try { mine = await handoverKeys(); shared = await handoverShared(mine.privateKey, request.pub, room.id); }
      catch { await remove(room, { persistStore: false }); return; }
      reply = { id: request.id, pub: mine.pub, box: await seal(shared, room.id, 'handover', { room: target.id, secret: target.secret }) };
    } else if (request.kind === 'pair' && room.state === 'waiting') {
      if (room.handoverFrom) {
        const source = rooms.get(room.handoverFrom);
        if (!source || source.state !== 'active' || now() >= source.expiresAt) { await remove(room); return; }
        room.peer = envelope.uid;
        room.code = source.code || (typeof request.code === 'string' ? request.code : '');
        room.name = typeof request.name === 'string' && request.name.trim() ? request.name.trim().slice(0, 60) : source.name;
        room.deviceId = typeof request.deviceId === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(request.deviceId) ? request.deviceId : source.deviceId || null;
        room.state = 'active';
        room.expiresAt = source.expiresAt;
        room.approvedAt = source.approvedAt || now();
        room.lastSeenAt = now();
        room.activeNow = true;
        delete room.handoverFrom;
        source.handoverId = null;
        if (room.meetingId && rooms.has(room.meetingId)) await remove(rooms.get(room.meetingId), { persistStore: false });
        room.meetingId = null;
        await remove(source, { persistStore: false });
        await metadata(room);
        clearTimeout(room.timer); room.timer = setTimeout(() => remove(room), Math.max(1, room.expiresAt - now())); room.timer.unref?.();
        persist();
        reply = { id: request.id, state: 'active', code: room.code, expiresAt: room.expiresAt };
      } else {
        if (!/^[0-9]{6}$/.test(request.code || '')) return;
        room.peer = envelope.uid; room.code = request.code;
        room.name = typeof request.name === 'string' && request.name.trim() ? request.name.trim().slice(0, 60) : 'Remote phone';
        room.deviceId = typeof request.deviceId === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(request.deviceId) ? request.deviceId : null;
        for (const other of [...rooms.values()]) {
          if (other.id !== room.id && other.state === 'pending' && (other.peer === room.peer || (room.deviceId && other.deviceId === room.deviceId))) await remove(other);
        }
        room.state = 'pending'; invite = null;
        await metadata(room);
        reply = { id: request.id, state: 'pending', code: room.code };
      }
    } else if (request.kind === 'session') {
      if (room.state === 'active') {
        if (request.active === false) room.activeNow = false;
        else { room.lastSeenAt = now(); room.activeNow = true; }
        persist();
      }
      reply = { id: request.id, state: room.state, code: room.code, expiresAt: room.expiresAt };
    } else if (room.state !== 'active') reply = { id: request.id, status: 401, body: { error: 'Approve this phone on the computer first.' } };
    else if (request.kind === 'logout') { await remove(room); return; }
    else if (request.kind === 'handover') {
      if (room.handoverId && rooms.has(room.handoverId)) await remove(rooms.get(room.handoverId), { persistStore: false });
      const id = token(), secret = token(), expiresAt = Math.min(room.expiresAt, now() + FIVE_MINUTES);
      const next = { id, secret, key: await roomKey(secret), owner: room.owner, state: 'waiting', peer: '', name: room.name, code: room.code, expiresAt, handoverFrom: room.id, seen: new Map(), requests: 0 };
      rooms.set(id, next); room.handoverId = id;
      try {
        await client.request(`owners/${next.owner}/${id}`, 'PUT', true);
        await metadata(next);
        watchRoom(next);
        // The typed code leads to a separate meeting point, so the link's own secret is never derived from it.
        const code = handoverCode(), meeting = await handoverMeeting(code);
        if (!rooms.has(meeting.room)) {
          const slot = { id: meeting.room, secret: meeting.secret, key: await roomKey(meeting.secret), owner: room.owner, state: 'waiting', peer: '', name: room.name, expiresAt, meetingFor: id, seen: new Map(), requests: 0 };
          rooms.set(slot.id, slot); next.meetingId = slot.id;
          await client.request(`owners/${slot.owner}/${slot.id}`, 'PUT', true);
          await metadata(slot);
          watchRoom(slot);
        }
        reply = { id: request.id, status: 200, body: { url: `${settings.phoneURL}/#remote=${id}.${secret}`, ...(next.meetingId ? { code } : {}), expiresAt } };
      } catch (failure) { await remove(next, { persistStore: false }); reply = { id: request.id, status: 503, body: { error: failure.message } }; }
    } else if (request.kind === 'push') {
      // Lock-screen notifications (#23). The phone asks for this computer's public key, then hands over the
      // subscription its browser made with it. It belongs to this connection only and goes when the connection does.
      room.lastSeenAt = now(); room.activeNow = true;
      if (!push) reply = { id: request.id, status: 409, body: { error: 'This version of Codeshi can’t send notifications.' } };
      else if (request.action === 'subscribe') {
        const subscription = pushSubscription(request.subscription);
        if (!subscription) reply = { id: request.id, status: 400, body: { error: 'This browser’s notification service isn’t supported.' } };
        else { room.push = subscription; persist(); reply = { id: request.id, status: 200, body: { subscribed: true } }; }
      } else if (request.action === 'unsubscribe') { room.push = null; persist(); reply = { id: request.id, status: 200, body: { subscribed: false } }; }
      else {
        let key = null; try { key = push.publicKey(); } catch { /* Reported below. */ }
        reply = key ? { id: request.id, status: 200, body: { key, subscribed: Boolean(room.push), endpoint: room.push?.endpoint || null } }
          : { id: request.id, status: 503, body: { error: 'Codeshi couldn’t make its notification key on the computer.' } };
      }
    } else if (request.kind === 'api') {
      room.lastSeenAt = now(); room.activeNow = true;
      try {
        reply = { id: request.id, ...await phoneRemoteRequest({ handle, local }, request) };
        const view = request.method === 'GET' && conversationRoute(request.path);
        if (view && request.transfer?.encoding === TRANSFER_ENCODING && reply.status === 200 && Array.isArray(reply.body?.messages)) {
          const base = token(16), encoded = encodeConversation(reply.body, view, request.transfer.base, room.conversation, base);
          reply.body = encoded.body; reply.transfer = { encoding: TRANSFER_ENCODING, base }; room.conversation = encoded.state;
        }
      }
      catch (failure) { reply = { id: request.id, status: 503, body: { error: failure.message } }; }
      persist();
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
  const countedRooms = () => [...rooms.values()].filter(room => !room.handoverFrom && !room.meetingFor);
  async function evictStaleIfNeeded(preferredName = null) {
    for (const room of [...rooms.values()]) if (now() >= room.expiresAt) await remove(room);
    if (countedRooms().length < 5) return;
    const candidate = countedRooms().find(room => room.state === 'pending')
      || (preferredName && countedRooms().find(room => room.state === 'active' && room.name === preferredName && !isActiveNow(room)))
      || countedRooms().filter(room => room.state === 'active' && !isActiveNow(room) && (room.activeNow === false || room.lastSeenAt)).sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0))[0];
    if (candidate) await remove(candidate);
  }
  async function newInvite() {
    if (invite) await remove(invite, { persistStore: false });
    await evictStaleIfNeeded();
    if (countedRooms().length >= 5) fail('Remove a remote phone before pairing another.', 409);
    const id = token(), secret = token(), identity = await client.identity();
    const room = { id, secret, key: await roomKey(secret), owner: identity.uid, state: 'waiting', peer: '', expiresAt: now() + FIVE_MINUTES, seen: new Map(), requests: 0 };
    rooms.set(id, room);
    try {
      await client.request(`owners/${room.owner}/${id}`, 'PUT', true);
      await metadata(room);
      room.url = `${settings.phoneURL}/#remote=${id}.${secret}`;
      const { default: QRCode } = await import('qrcode');
      room.qr = await QRCode.toDataURL(room.url, { errorCorrectionLevel: 'M', margin: 4, scale: 6 });
      watchRoom(room);
      invite = room;
    } catch (failure) { await remove(room, { persistStore: false }); throw failure; }
    return status();
  }
  async function stop() {
    enabled = false; generation++; invite = null;
    persist();
    const cleanup = Promise.allSettled([...rooms.values()].map(room => remove(room, { persistStore: false })));
    let timeout;
    // Local authorization ends immediately, even without internet. Do not hold application shutdown open for
    // cloud cleanup; any remaining owner-index entries are retried on the next enable.
    await Promise.race([cleanup, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
    clearTimeout(timeout);
    if (client?.traffic) lastTraffic = { ...client.traffic };
    client?.close(); client = null;
    return status();
  }
  async function shutdown() {
    if (!storeFile) return stop();
    generation++; invite = null;
    const unapproved = [...rooms.values()].filter(room => room.state !== 'active' || room.handoverFrom || now() >= room.expiresAt);
    for (const room of rooms.values()) { room.stop?.(); clearTimeout(room.timer); }
    const cleanup = Promise.allSettled(unapproved.map(room => remove(room, { persistStore: false })));
    let timeout;
    await Promise.race([cleanup, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
    clearTimeout(timeout);
    persist();
    if (client?.traffic) lastTraffic = { ...client.traffic };
    client?.close(); client = null;
    return status();
  }
  async function action(input) {
    if (input.action === 'stop') return stop();
    if (!settings) fail(setupError || 'Remote access is not configured in this build.', 409);
    if (input.action === 'start') {
      if (enabled) return status();
      client = clientFactory ? clientFactory(settings) : new FirebasePhoneClient(settings, { load, save });
      enabled = true; error = null;
      try {
        const identity = await client.identity();
        const previous = await client.request(`owners/${identity.uid}`) || {};
        for (const id of Object.keys(previous)) if (/^[a-f0-9]{64}$/.test(id) && !rooms.has(id)) {
          await client.request(`rooms/${id}`, 'DELETE'); await client.request(`owners/${identity.uid}/${id}`, 'DELETE');
        }
        return await newInvite();
      } catch (failure) { await stop(); fail(failure.message, 503); }
    }
    if (!enabled) fail('Enable remote access first.', 409);
    if (input.action === 'invite') return newInvite();
    const room = rooms.get(input.id);
    if (!room || room.meetingFor || now() >= room.expiresAt) fail('This remote phone request expired or was removed.', 404);
    if (['deny', 'revoke'].includes(input.action)) { await remove(room); return status(); }
    if (input.action !== 'allow' || room.state !== 'pending') fail('Choose a pending phone or remove a connected one.');
    for (const other of [...rooms.values()]) {
      if (other.id === room.id || other.handoverFrom || other.meetingFor) continue;
      const sameDevice = Boolean(room.deviceId && other.deviceId === room.deviceId);
      const staleSameName = other.name === room.name && (other.state === 'pending' || (other.state === 'active' && !isActiveNow(other) && (other.activeNow === false || other.lastSeenAt)));
      if (sameDevice || staleSameName) await remove(other, { persistStore: false });
    }
    room.state = 'active'; room.approvedAt = now(); room.expiresAt = now() + SESSION; room.lastSeenAt = now(); room.activeNow = true;
    try { await metadata(room); await publish(room, { state: 'active', code: room.code, expiresAt: room.expiresAt }); }
    catch (failure) { await remove(room); fail(failure.message, 503); }
    clearTimeout(room.timer); room.timer = setTimeout(() => remove(room), SESSION); room.timer.unref?.();
    persist();
    return status();
  }
  if (settings && storeFile) {
    const initial = readStore();
    const restored = Array.isArray(initial?.rooms) ? initial.rooms.filter(entry =>
      entry?.state === 'active' && /^[a-f0-9]{64}$/.test(entry.id || '') && /^[a-f0-9]{64}$/.test(entry.secret || '') &&
      typeof entry.peer === 'string' && entry.peer && Number.isFinite(entry.expiresAt) && entry.expiresAt > now()) : [];
    if (initial?.enabled && restored.length) {
      enabled = true;
      for (const entry of restored.slice(0, 5)) {
        rooms.set(entry.id, {
          id: entry.id, secret: entry.secret, owner: entry.owner || '', peer: entry.peer,
          name: typeof entry.name === 'string' && entry.name ? entry.name : 'Remote phone',
          code: typeof entry.code === 'string' ? entry.code : '',
          state: 'active', expiresAt: entry.expiresAt, lastSeenAt: entry.lastSeenAt || null,
          approvedAt: entry.approvedAt || null, deviceId: entry.deviceId || null,
          push: pushSubscription(entry.push), activeNow: false, seen: new Map(), requests: 0,
        });
      }
      transition = transition.then(async () => {
        if (!enabled) return;
        client = clientFactory ? clientFactory(settings) : new FirebasePhoneClient(settings, { load, save });
        const identity = await client.identity();
        for (const room of [...rooms.values()]) {
          if (room.state !== 'active') continue;
          if (now() >= room.expiresAt) { await remove(room, { persistStore: false }); continue; }
          room.owner = room.owner || identity.uid;
          room.key = await roomKey(room.secret);
          await client.request(`owners/${room.owner}/${room.id}`, 'PUT', true);
          await metadata(room);
          watchRoom(room);
        }
        const previous = await client.request(`owners/${identity.uid}`) || {};
        for (const id of Object.keys(previous)) if (/^[a-f0-9]{64}$/.test(id) && !rooms.has(id)) {
          await client.request(`rooms/${id}`, 'DELETE'); await client.request(`owners/${identity.uid}/${id}`, 'DELETE');
        }
        if (!rooms.size) enabled = false;
        persist();
      }).catch(failure => { error = failure?.busy ? failure.message : 'Remote connection interrupted. Retrying…'; });
    } else if (Array.isArray(initial?.rooms) && initial.rooms.length) {
      persist();
    }
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
  // One alert, chosen by alertPush, to each approved phone that turned notifications on and isn't looking at Codeshi
  // right now: an open page already shows it and plays its sound. A phone that unsubscribed is forgotten.
  async function alert(plan) {
    if (!enabled || !push || !plan?.message) return 0;
    const targets = [...rooms.values()].filter(room => room.state === 'active' && room.push && now() < room.expiresAt && !isActiveNow(room));
    const results = await Promise.all(targets.map(async room => {
      const subscription = room.push, result = await push.send(subscription, plan.message, { urgency: plan.urgency, ttl: plan.ttl });
      if (result === 'gone' && room.push === subscription) { room.push = null; persist(); }
      return result === 'sent';
    }));
    return results.filter(Boolean).length;
  }
  const manage = input => { const next = transition.then(() => action(input)); transition = next.catch(() => {}); return next; };
  return { status, manage, notify, alert, close: async () => { clearTimeout(eventTimer); const next = transition.then(() => shutdown()); transition = next.catch(() => {}); await next; } };
}

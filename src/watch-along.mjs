import fs from 'node:fs';
import { atomicJSON } from './patches.mjs';
import { phoneConversation } from './phone-conversation.mjs';
import { FirebasePhoneClient, firebaseConfig, token, roomKey, seal, open } from '../public/phone-firebase.mjs';
import { encodeConversation, decodeConversation } from '../public/phone-transfer.mjs';
import '../public/phone-logic.js';

const { describeStep, shortPath } = globalThis.relayPhoneLogic;

// Watch-along (#24, first slice): a teammate watches one workspace's conversation live, read-only, in their own Codeshi.
// It travels through the same Firebase relay as remote phone access, in the same room layout, so the deployed database
// rules are unchanged: the relay only stores encrypted packets in a request slot and a reply slot. The room's secret is
// in the invite link and never reaches the relay.
//
// The host stays in charge. An invite works for one person: the first Codeshi to answer it becomes the room's only
// writer, and it still waits until the host matches its six-digit code and allows it. The watcher can ask for the latest
// view of that one conversation, say whether it is looking, send a suggestion and leave. It can't send messages, answer
// approvals, stop runs, read files or pick another workspace or task: the host answers from a fixed workspace with a view
// built from an allowlist of fields, and suggestions only land beside the host's message box until the host uses them.
//
// Each side signs in to the relay with its own anonymous identity, separate from phone access, because each one deletes
// relay rooms it no longer knows about when it starts.
//
// Messages (#24, steering): the host chooses, per person, what that person's messages may do. 'suggest' is the first
// slice's suggestions only. With 'ask' a watcher's message waits beside the host's message box until the host sends it;
// with 'auto' it goes straight into the host's queue. Either way it runs on the host's computer and account, with the
// conversation's current agent and model and always with Ask for permission, so the host still approves every command
// and edit, and can pause, edit or remove it in the queue. The person's name stays on the message.

const INVITE = 30 * 60_000, SESSION = 24 * 60 * 60_000, ACTIVE_WINDOW = 45_000, HEARTBEAT = 20_000, REPLY_TIMEOUT = 20_000;
const MAX_WATCHERS = 5, MAX_SUGGESTIONS = 20, SUGGESTION_LENGTH = 2000, NAME_LENGTH = 60;
const LEVELS = ['suggest', 'ask', 'auto'], MESSAGE_INPUT = 8000, MAX_WAITING_MESSAGES = 3, QUEUE_SHOWN = 20;
const VIEW_MESSAGES = 60, MESSAGE_LENGTH = 20_000, VIEW_BYTES = 600_000, LABEL_LENGTH = 300;
const ROOM = /^[a-f0-9]{64}$/;
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const clip = (text, length) => typeof text === 'string' && text.length > length ? `${text.slice(0, length)}…` : text;
const cleanName = (value, fallback) => typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH) : fallback;

// ---- What a watcher may see. Built from an allowlist, so fields added to conversations later stay on the host.
const CHAT = new Set(['user', 'assistant', 'error', 'system']);
// Who wrote a teammate's message. The room stays on the host: each watcher only learns whether a message was theirs.
const author = value => value && typeof value.name === 'string' ? { name: clip(value.name, NAME_LENGTH), room: typeof value.room === 'string' ? value.room : null } : null;
function approvalLabel(item) {
  const command = item.command || item.input?.command, target = item.input?.file_path || item.input?.path;
  if (item.kind === 'question') return clip(item.questions?.[0]?.question || 'The agent asked a question.', LABEL_LENGTH);
  // A file is named by its folder and name, as in the step line, never by the host's full path.
  return clip(command ? `Run ${command}` : target ? `Change ${shortPath(String(target))}` : item.title || 'Use a tool', LABEL_LENGTH);
}
export function watchView(view, limit = VIEW_MESSAGES) {
  const short = phoneConversation(view, limit);
  const run = short.activeRun;
  const messages = (short.messages || []).filter(message => CHAT.has(message.role) && typeof message.id === 'string').map(message => ({
    id: message.id, role: message.role, provider: typeof message.provider === 'string' ? message.provider : null,
    createdAt: typeof message.createdAt === 'string' ? message.createdAt : null,
    text: typeof message.text === 'string' ? clip(message.text, MESSAGE_LENGTH) : '',
    attachments: Array.isArray(message.attachments) ? message.attachments.slice(0, 20).map(file => ({ name: clip(String(file?.name || 'file'), 120), kind: file?.kind === 'image' ? 'image' : 'file' })) : [],
    ...(message.role === 'user' && author(message.author) ? { author: author(message.author) } : {}),
  }));
  // A long reply can't push the packet over the relay's limit: the oldest messages go first.
  let size = messages.reduce((total, message) => total + message.text.length * 2, 0), earlier = short.earlier || 0;
  while (messages.length > 1 && size > VIEW_BYTES) { size -= messages.shift().text.length * 2; earlier++; }
  return {
    id: typeof view.id === 'string' ? view.id : null,
    title: typeof view.title === 'string' ? clip(view.title, 200) : '',
    status: view.status === 'running' ? 'running' : 'idle',
    provider: typeof view.provider === 'string' ? view.provider : null,
    model: typeof view.model === 'string' ? view.model : null,
    activeRun: run ? { provider: run.provider || null, model: run.model || null, startedAt: run.startedAt || null } : null,
    // What the agent is doing, in words ("Running npm test"), never the step's raw output.
    step: view.status === 'running' && short.step?.text ? clip(describeStep(short.step.text), LABEL_LENGTH) || null : null,
    waiting: (view.pendingApprovals || []).slice(0, 5).map(item => ({ kind: item.kind === 'question' ? 'question' : 'approval', provider: typeof item.provider === 'string' ? item.provider : null, label: approvalLabel(item) })),
    earlier,
    messages,
    // Teammates' messages waiting in the queue, with their place, so a watcher sees theirs wait its turn. The host's own
    // queued prompts stay private: only how many there are. Only the start of each message; the queue holds at most 20.
    upNext: (Array.isArray(short.queue) ? short.queue : []).slice(0, QUEUE_SHOWN).map((item, index) => author(item.author) ? { place: index + 1, text: clip(typeof item.text === 'string' ? item.text : '', LABEL_LENGTH), author: author(item.author) } : null).filter(Boolean),
    queued: Array.isArray(short.queue) ? short.queue.length : 0,
    paused: Boolean(short.queuePaused),
  };
}
// One watcher's copy of the view: authors keep their name, and "mine" replaces the room so nobody learns another's.
const mark = (value, roomId) => value.author ? { ...value, author: { name: value.author.name, mine: value.author.room === roomId } } : value;
export function roomView(view, roomId) {
  return { ...view, messages: (view.messages || []).map(message => mark(message, roomId)), upNext: (view.upNext || []).map(item => mark(item, roomId)) };
}

// The invite as text: codeshi://watch/<room>.<secret>. A pasted link may carry spaces or angle brackets from a chat app.
export function watchLink(id, secret) { return `codeshi://watch/${id}.${secret}`; }
export function parseWatchLink(text) {
  const match = String(text || '').trim().match(/(?:^|[/#=\s<])([a-f0-9]{64})\.([a-f0-9]{64})(?:$|[\s>])/i);
  return match ? { id: match[1].toLowerCase(), secret: match[2].toLowerCase() } : null;
}
const sixDigits = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');

// sendMessage(projectId, { text, author, billingConfirmed }) queues a teammate's message on the host's conversation.
export function createWatchAlong({ config, storeFile, readConversation, sendMessage, workspaceName = () => 'Workspace', defaultName = 'Teammate', clientFactory, onChange = () => {}, now = Date.now } = {}) {
  let settings = null, setupError = null;
  if (config) { try { settings = firebaseConfig(config); } catch (error) { setupError = error.message; } }
  const readStore = () => { try { return storeFile ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : {}; } catch { return {}; } };
  let store = readStore(), closed = false;
  const changed = () => { try { onChange(); } catch { /* A page that can't be told just refreshes later. */ } };

  // One relay client per side, each with its own saved anonymous identity.
  const clients = {};
  function client(side) {
    if (closed) fail('Codeshi is closing.', 503);
    if (!settings) fail(setupError || 'Watch-along needs the remote relay, which isn’t set up in this build.', 409);
    return clients[side] ||= clientFactory ? clientFactory(settings, side) : new FirebasePhoneClient(settings, {
      load: () => store[side]?.uid && store[side]?.refreshToken ? store[side] : null,
      save: value => { store[side] = { uid: value.uid, refreshToken: value.refreshToken }; persist(); },
    });
  }

  // ======================= Host: sharing this computer's conversations =======================
  const rooms = new Map(), invites = new Map();
  let suggestions = Array.isArray(store.suggestions) ? store.suggestions.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.projectId === 'string').slice(-MAX_SUGGESTIONS * 4) : [];
  const isActiveNow = room => room.state === 'active' && room.looking !== false && Boolean(room.lastSeenAt && now() - room.lastSeenAt < ACTIVE_WINDOW);

  function persist() {
    if (!storeFile || closed) return;
    const active = [...rooms.values()].filter(room => room.state === 'active' && now() < room.expiresAt)
      .map(({ id, secret, owner, peer, name, code, projectId, expiresAt, lastSeenAt, level }) => ({ id, secret, owner, peer, name, code, projectId, expiresAt, lastSeenAt: lastSeenAt || null, level: level || 'suggest' }));
    const watching = [...sessions.values()].filter(session => ['pending', 'active'].includes(session.state) && now() < session.expiresAt)
      .map(({ id, secret, name, code, state, workspace, title, expiresAt, level }) => ({ id, secret, name, code, state, workspace, title, expiresAt, level: level || 'suggest' }));
    try { atomicJSON(storeFile, { ...(store.host ? { host: store.host } : {}), ...(store.viewer ? { viewer: store.viewer } : {}), ...(store.name ? { name: store.name } : {}), rooms: active, sessions: watching, suggestions }); }
    catch (error) { console.error('Codeshi could not save watch-along:', error.message); }
  }
  async function publish(room, value) {
    if (!rooms.has(room.id)) return;
    await client('host').request(`rooms/${room.id}/out`, 'PUT', await seal(room.key, room.id, 'out', { ...value, at: now() }));
  }
  const metadata = room => client('host').request(`rooms/${room.id}/meta`, 'PUT', { owner: room.owner, state: room.state, peer: room.peer || '', expiresAt: room.expiresAt });
  async function remove(room, { tell = true } = {}) {
    if (!rooms.has(room.id)) return;
    rooms.delete(room.id); room.stop?.(); clearTimeout(room.timer);
    if (invites.get(room.projectId) === room.id) invites.delete(room.projectId);
    persist(); if (tell) changed();
    // Deleting the room is what tells the watcher. Expiry and the rules still deny it if the relay can't be reached now.
    try { await clients.host?.request(`rooms/${room.id}`, 'DELETE'); await clients.host?.request(`owners/${room.owner}/${room.id}`, 'DELETE'); }
    catch { /* Removed locally. Cleaned up when sharing starts again. */ }
  }
  function watchRoom(room) {
    room.stop?.();
    room.stop = client('host').watch(`rooms/${room.id}/request`, value => receive(room, value), () => {});
    clearTimeout(room.timer); room.timer = setTimeout(() => remove(room), Math.max(1, room.expiresAt - now())); room.timer.unref?.();
  }
  async function receive(room, envelope) {
    if (!rooms.has(room.id) || !envelope?.box || typeof envelope.uid !== 'string') return;
    if (now() >= room.expiresAt) return remove(room);
    let request;
    try { request = await open(room.key, room.id, 'request', envelope.box); } catch { return; }
    if (typeof request.id !== 'string' || !/^[a-f0-9]{32}$/.test(request.id) || !Number.isFinite(request.at) || Math.abs(now() - request.at) > 30_000) return;
    if (room.peer && room.peer !== envelope.uid) return;
    for (const [id, entry] of room.seen) if (now() > entry.expiresAt) room.seen.delete(id);
    if (room.seen.has(request.id)) { const reply = room.seen.get(request.id).reply; if (reply) await publish(room, reply).catch(() => {}); return; }
    const minute = Math.floor(now() / 60000);
    if (room.minute !== minute) { room.minute = minute; room.requests = 0; }
    if (++room.requests > 60 || room.seen.size >= 128) { await publish(room, { id: request.id, status: 429, error: 'Too many requests. Try again shortly.' }).catch(() => {}); return; }
    const entry = { expiresAt: request.at + 30_000, reply: null }; room.seen.set(request.id, entry);
    let reply;
    if (request.kind === 'pair') {
      if (room.state !== 'waiting' || !/^[0-9]{6}$/.test(request.code || '')) return;
      room.peer = envelope.uid; room.code = request.code; room.name = cleanName(request.name, 'Teammate'); room.state = 'pending';
      if (invites.get(room.projectId) === room.id) invites.delete(room.projectId);
      await metadata(room).catch(() => {});
      reply = { id: request.id, state: 'pending', code: room.code, workspace: workspaceName(room.projectId) };
      changed();
    } else if (request.kind === 'session') {
      if (room.state === 'active') { room.looking = request.active !== false; room.lastSeenAt = now(); changed(); }
      reply = { id: request.id, state: room.state, expiresAt: room.expiresAt, ...(room.state === 'active' ? { level: room.level || 'suggest' } : {}) };
    } else if (room.state !== 'active') reply = { id: request.id, status: 401, error: 'Waiting for the host to allow you.' };
    else if (request.kind === 'leave') { await remove(room); return; }
    else if (request.kind === 'view') {
      room.lastSeenAt = now(); room.looking = true;
      try {
        const view = roomView(readConversation(room.projectId), room.id);
        room.conversationId = view.id;
        const base = token(16), encoded = encodeConversation({ ...view, delta: true }, 'watch', request.base, room.sent, base);
        room.sent = encoded.state;
        reply = { id: request.id, status: 200, base, workspace: workspaceName(room.projectId), level: room.level || 'suggest', view: { ...encoded.body, delta: undefined } };
      } catch (failure) { reply = { id: request.id, status: 503, error: failure.status ? failure.message : 'The host’s conversation couldn’t be read.' }; }
    } else if (request.kind === 'suggest') {
      const text = typeof request.text === 'string' ? request.text.trim() : '';
      const waiting = suggestions.filter(item => item.projectId === room.projectId);
      if (!text) reply = { id: request.id, status: 400, error: 'Write a suggestion first.' };
      else if (text.length > SUGGESTION_LENGTH) reply = { id: request.id, status: 413, error: `Keep a suggestion under ${SUGGESTION_LENGTH} characters.` };
      else if (waiting.length >= MAX_SUGGESTIONS) reply = { id: request.id, status: 429, error: 'The host has too many suggestions waiting. Try again after they read them.' };
      else {
        suggestions.push({ id: token(8), projectId: room.projectId, roomId: room.id, from: room.name, text, at: new Date(now()).toISOString() });
        persist(); changed();
        reply = { id: request.id, status: 200, sent: true };
      }
    } else if (request.kind === 'message') reply = { id: request.id, ...await message(room, request.text) };
    else reply = { id: request.id, status: 400, error: 'Unknown watch request.' };
    if (!rooms.has(room.id)) return;
    entry.reply = reply;
    await publish(room, reply).catch(() => {});
  }
  // A watcher's message, by the level the host chose for them. The host's choice is checked here, on the host, each time.
  async function message(room, value) {
    const text = typeof value === 'string' ? value.trim() : '', level = room.level || 'suggest';
    if (level === 'suggest') return { status: 403, error: 'They haven’t let you send messages. Send a suggestion instead.', level };
    if (!text) return { status: 400, error: 'Write a message first.' };
    if (text.length > MESSAGE_INPUT) return { status: 413, error: `Keep a message under ${MESSAGE_INPUT.toLocaleString('en-US')} characters.` };
    let queuedByThem = 0;
    try { queuedByThem = (readConversation(room.projectId).upNext || []).filter(item => item.author?.room === room.id).length; } catch { /* Counted from what waits here. */ }
    const waiting = suggestions.filter(item => item.roomId === room.id && item.kind === 'message').length;
    if (waiting + queuedByThem >= MAX_WAITING_MESSAGES) return { status: 429, error: `You have ${MAX_WAITING_MESSAGES} messages waiting. Send more once one of them has run.` };
    if (suggestions.filter(item => item.projectId === room.projectId).length >= MAX_SUGGESTIONS) return { status: 429, error: 'The host has too many messages waiting. Try again after they read them.' };
    const item = { id: token(8), kind: 'message', projectId: room.projectId, roomId: room.id, from: room.name, text, at: new Date(now()).toISOString() };
    if (level === 'auto') {
      // Straight into the queue. Anything the host's queue refuses waits for the host instead, with the reason.
      try { await sendMessage(room.projectId, { text, author: { name: room.name, room: room.id } }); changed(); return { status: 200, sent: true, queued: true }; }
      catch (failure) { item.reason = clip(failure?.message || 'It couldn’t join the queue.', LABEL_LENGTH); }
    }
    suggestions.push(item); persist(); changed();
    return { status: 200, sent: true, queued: false };
  }
  async function setLevel(room, level) {
    if (!LEVELS.includes(level)) fail('Choose suggestions only, ask first or send straight to the queue.');
    if (room.state !== 'active') fail('Allow them first.', 409);
    if ((room.level || 'suggest') === level) return;
    room.level = level; persist(); changed();
    await publish(room, { event: 'level', level }).catch(() => {});
  }
  async function sendHeld(projectId, id, billingConfirmed) {
    const item = suggestions.find(entry => entry.id === id && entry.projectId === projectId && entry.kind === 'message');
    if (!item) fail('That message was already sent or dismissed.', 409);
    // The host is sending it, so it runs even if they've since stopped sharing with this person.
    await sendMessage(projectId, { text: item.text, author: { name: item.from, room: item.roomId }, billingConfirmed: billingConfirmed === true });
    suggestions = suggestions.filter(entry => entry !== item); persist(); changed();
  }

  // Removes leftovers from an earlier run that this computer no longer knows, such as an invite nobody used.
  let cleaned = false;
  async function cleanUp() {
    if (cleaned) return; cleaned = true;
    const host = client('host'), identity = await host.identity();
    const previous = await host.request(`owners/${identity.uid}`).catch(() => null) || {};
    for (const id of Object.keys(previous)) if (ROOM.test(id) && !rooms.has(id)) {
      await host.request(`rooms/${id}`, 'DELETE').catch(() => {}); await host.request(`owners/${identity.uid}/${id}`, 'DELETE').catch(() => {});
    }
  }
  async function invite(projectId) {
    if (typeof projectId !== 'string' || !projectId) fail('Select a workspace first.');
    workspaceName(projectId);
    const previous = invites.get(projectId); if (previous && rooms.has(previous)) await remove(rooms.get(previous), { tell: false });
    for (const room of [...rooms.values()]) if (now() >= room.expiresAt) await remove(room, { tell: false });
    if ([...rooms.values()].filter(room => room.projectId === projectId).length >= MAX_WATCHERS) fail(`Stop sharing with someone first. Up to ${MAX_WATCHERS} people can watch a workspace.`, 409);
    const host = client('host'), identity = await host.identity();
    await cleanUp();
    const id = token(), secret = token();
    const room = { id, secret, key: await roomKey(secret), owner: identity.uid, projectId, state: 'waiting', peer: '', name: '', code: '', expiresAt: now() + INVITE, seen: new Map(), requests: 0 };
    rooms.set(id, room);
    try { await host.request(`owners/${room.owner}/${id}`, 'PUT', true); await metadata(room); watchRoom(room); }
    catch (failure) { await remove(room, { tell: false }); fail(failure.message || 'The relay couldn’t be reached.', 503); }
    invites.set(projectId, id); room.link = watchLink(id, secret);
    changed();
  }
  async function allow(room) {
    if (room.state !== 'pending') fail('This request was already answered.', 409);
    room.state = 'active'; room.expiresAt = now() + SESSION; room.lastSeenAt = now(); room.looking = true; room.level = 'suggest';
    try { await metadata(room); await publish(room, { state: 'active', expiresAt: room.expiresAt, workspace: workspaceName(room.projectId), level: room.level }); }
    catch (failure) { await remove(room); fail(failure.message || 'The relay couldn’t be reached.', 503); }
    clearTimeout(room.timer); room.timer = setTimeout(() => remove(room), SESSION); room.timer.unref?.();
    persist(); changed();
  }
  let pending = null;
  function notify(projectId, conversationId) {
    const targets = [...rooms.values()].filter(room => room.state === 'active' && room.projectId === projectId && (!room.conversationId || !conversationId || room.conversationId === conversationId));
    if (!targets.length) return;
    pending ||= new Set();
    for (const room of targets) pending.add(room.id);
    if (notify.timer) return;
    // One small "something changed" every two seconds at most. The watcher asks for the view itself, as the phone does.
    notify.timer = setTimeout(() => {
      notify.timer = null; const ids = pending; pending = null;
      for (const id of ids) { const room = rooms.get(id); if (room?.state === 'active') publish(room, { event: 'update' }).catch(() => {}); }
    }, 2000); notify.timer.unref?.();
  }

  // ======================= Viewer: watching someone else's conversation =======================
  const sessions = new Map();
  function sessionView(session) {
    return { id: session.id, workspace: session.workspace || '', title: session.title || '', state: session.state, code: session.code, name: session.name, expiresAt: session.expiresAt || null,
      error: session.error || null, view: session.looking ? session.view || null : null, updatedAt: session.updatedAt || null, looking: Boolean(session.looking), level: session.level || 'suggest' };
  }
  function dropSession(session, state = 'ended') {
    session.state = state; session.stop?.(); session.stop = null; clearInterval(session.heartbeat); session.heartbeat = null;
    for (const waiter of session.waiting.values()) waiter.reject(Error(state === 'ended' ? 'The host stopped sharing.' : 'You left.'));
    session.waiting.clear();
    persist(); changed();
  }
  async function checkEnded(session) {
    if (session.checking || !['pending', 'active'].includes(session.state)) return;
    session.checking = true;
    try { const meta = await client('viewer').request(`rooms/${session.id}/meta`); if (!meta || meta.state === 'waiting') dropSession(session); }
    catch { /* Offline: keep trying through the stream. */ }
    finally { session.checking = false; }
  }
  function listen(session) {
    session.stop?.();
    let denied = 0;
    session.stop = client('viewer').watch(`rooms/${session.id}/out`, async box => {
      denied = 0;
      if (!box || !['joining', 'pending', 'active'].includes(session.state)) { if (!box && session.state === 'active') checkEnded(session); return; }
      let value; try { value = await open(session.key, session.id, 'out', box); } catch { return; }
      if (value.id && session.waiting.has(value.id)) { const waiter = session.waiting.get(value.id); session.waiting.delete(value.id); waiter.resolve(value); }
      if (session.state === 'joining') return;
      if (LEVELS.includes(value.level) && value.level !== session.level && (session.state === 'active' || value.state === 'active')) { session.level = value.level; persist(); changed(); }
      if (value.state === 'active' && session.state === 'pending') {
        session.state = 'active'; session.expiresAt = value.expiresAt || now() + SESSION; session.workspace = value.workspace || session.workspace; session.error = null;
        persist(); changed(); if (session.looking) { beat(session); refresh(session); }
      } else if (value.event === 'update' && session.state === 'active') {
        if (session.looking) refresh(session); else session.stale = true;
      }
    }, () => { if (++denied >= 2) checkEnded(session); });
  }
  async function send(session, payload) {
    const id = token(16), viewer = client('viewer'), identity = await viewer.identity();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.waiting.delete(id); reject(Error('The host’s Codeshi didn’t answer. It may be closed or offline.')); }, REPLY_TIMEOUT);
      timer.unref?.();
      session.waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    reply.catch(() => {}); // Observed by its turn below; one still queued when sharing ends has nobody else to tell.
    // The relay has one request slot per room, so requests go one at a time.
    const turn = session.queue.then(async () => {
      await viewer.request(`rooms/${session.id}/request`, 'PUT', { uid: identity.uid, box: await seal(session.key, session.id, 'request', { ...payload, id, at: now() }) });
      return reply;
    });
    session.queue = turn.catch(() => {});
    const value = await turn;
    if (value.status && value.status >= 400) fail(value.error || 'The host refused that request.', value.status);
    return value;
  }
  async function refresh(session) {
    if (session.state !== 'active') return;
    if (session.refreshing) { session.again = true; return; }
    session.refreshing = true; session.stale = false;
    try {
      const reply = await send(session, { kind: 'view', base: session.base || null });
      let decoded;
      try { decoded = decodeConversation({ ...reply.view, delta: true }, 'watch', session.base || null, session.texts, reply.base); }
      catch { session.base = null; session.texts = null; session.again = true; return; }
      session.base = reply.base; session.texts = decoded.state;
      session.view = { ...decoded.body, delta: undefined }; session.title = session.view.title || session.title;
      session.workspace = reply.workspace || session.workspace; session.updatedAt = new Date(now()).toISOString(); session.error = null;
      if (LEVELS.includes(reply.level)) session.level = reply.level;
    } catch (failure) { session.error = failure.message; }
    finally { session.refreshing = false; changed(); if (session.again) { session.again = false; refresh(session); } }
  }
  function beat(session) {
    clearInterval(session.heartbeat);
    const ping = () => send(session, { kind: 'session', active: true }).then(reply => { if (LEVELS.includes(reply.level) && reply.level !== session.level) { session.level = reply.level; persist(); changed(); } }).catch(() => {});
    session.heartbeat = setInterval(() => { if (session.state === 'active') ping(); }, HEARTBEAT);
    session.heartbeat.unref?.();
    ping();
  }
  function newSession(entry) {
    return { id: entry.id, secret: entry.secret, name: entry.name, code: entry.code, state: entry.state, workspace: entry.workspace || '', title: entry.title || '', expiresAt: entry.expiresAt,
      level: LEVELS.includes(entry.level) ? entry.level : 'suggest', key: null, waiting: new Map(), queue: Promise.resolve(), looking: false, view: null, base: null, texts: null };
  }
  async function join(link, name) {
    const parsed = parseWatchLink(link);
    if (!parsed) fail('Paste the whole invite link your teammate sent. It starts with codeshi://watch/.');
    const existing = sessions.get(parsed.id);
    if (existing && ['pending', 'active'].includes(existing.state)) return existing;
    const me = cleanName(name, store.name || defaultName); store.name = me;
    const session = newSession({ ...parsed, name: me, code: sixDigits(), state: 'joining', expiresAt: now() + INVITE });
    session.key = await roomKey(parsed.secret);
    sessions.set(session.id, session);
    const viewer = client('viewer'), identity = await viewer.identity();
    const meta = await viewer.request(`rooms/${session.id}/meta`).catch(() => null);
    if (!meta || meta.state !== 'waiting' || meta.expiresAt <= now()) {
      sessions.delete(session.id);
      fail(meta?.peer === identity.uid ? 'You already used this invite.' : 'This invite expired or was already used. Ask your teammate for a new one.', 410);
    }
    // The reply arrives where only the room's chosen watcher can read, which this request makes us. Listening first
    // means the answer isn't missed; the first attempts are refused until the host has seen the request.
    listen(session);
    try {
      const reply = await send(session, { kind: 'pair', code: session.code, name: me });
      if (session.state === 'joining') { session.state = reply.state === 'active' ? 'active' : 'pending'; session.workspace = reply.workspace || ''; }
    } catch (failure) { session.stop?.(); sessions.delete(session.id); throw failure; }
    persist(); changed();
    return session;
  }

  function restore() {
    if (!settings) return;
    const valid = entry => entry && ROOM.test(entry.id || '') && ROOM.test(entry.secret || '') && Number.isFinite(entry.expiresAt) && entry.expiresAt > now();
    const saved = Array.isArray(store.rooms) ? store.rooms.filter(entry => valid(entry) && typeof entry.peer === 'string' && entry.peer && typeof entry.projectId === 'string') : [];
    const watching = Array.isArray(store.sessions) ? store.sessions.filter(entry => valid(entry) && ['pending', 'active'].includes(entry.state)) : [];
    for (const entry of saved) rooms.set(entry.id, { ...entry, name: cleanName(entry.name, 'Teammate'), level: LEVELS.includes(entry.level) ? entry.level : 'suggest', state: 'active', looking: false, seen: new Map(), requests: 0 });
    for (const entry of watching) sessions.set(entry.id, newSession({ ...entry, name: cleanName(entry.name, defaultName) }));
    if (!rooms.size && !sessions.size) return;
    (async () => {
      for (const room of rooms.values()) { room.key = await roomKey(room.secret); await metadata(room); watchRoom(room); }
      if (rooms.size) await cleanUp();
      for (const session of sessions.values()) { session.key = await roomKey(session.secret); listen(session); }
    })().catch(error => console.error('Codeshi could not reconnect watch-along:', error.message));
  }
  restore();

  function status(projectId) {
    for (const room of [...rooms.values()]) if (now() >= room.expiresAt) remove(room, { tell: false });
    const inviteRoom = projectId && rooms.get(invites.get(projectId));
    return {
      configured: Boolean(settings), error: setupError,
      name: store.name || defaultName,
      host: projectId ? {
        invite: inviteRoom && inviteRoom.state === 'waiting' ? { link: inviteRoom.link, expiresAt: inviteRoom.expiresAt } : null,
        watchers: [...rooms.values()].filter(room => room.projectId === projectId && room.state !== 'waiting').map(room => ({
          id: room.id, name: room.name, code: room.code, state: room.state, level: room.level || 'suggest', watchingNow: isActiveNow(room), lastSeenAt: room.lastSeenAt || null, expiresAt: room.expiresAt })),
        suggestions: suggestions.filter(item => item.projectId === projectId).map(({ id, kind, from, text, at, reason }) => ({ id, kind: kind === 'message' ? 'message' : 'suggestion', from, text, at, ...(reason ? { reason } : {}) })),
      } : null,
      watching: [...sessions.values()].filter(session => session.state !== 'joining').map(sessionView),
    };
  }
  const roomFor = (id, projectId) => { const room = rooms.get(id); if (!room || (projectId && room.projectId !== projectId)) fail('That teammate is no longer connected.', 404); return room; };
  const sessionFor = id => { const session = sessions.get(id); if (!session) fail('That shared conversation is no longer open.', 404); return session; };
  async function manage(input = {}) {
    const { action, projectId } = input;
    if (action === 'invite') await invite(projectId);
    else if (action === 'cancel-invite') { const id = invites.get(projectId); if (id && rooms.has(id)) await remove(rooms.get(id)); }
    else if (action === 'allow') await allow(roomFor(input.id, projectId));
    else if (action === 'deny' || action === 'stop') await remove(roomFor(input.id, projectId));
    else if (action === 'level') await setLevel(roomFor(input.id, projectId), input.level);
    else if (action === 'send') await sendHeld(projectId, input.id, input.billingConfirmed);
    else if (action === 'dismiss') { suggestions = suggestions.filter(item => !(item.id === input.id && item.projectId === projectId)); persist(); changed(); }
    else if (action === 'join') { const session = await join(input.link, input.name); return { ...status(projectId), joined: session.id }; }
    else if (action === 'look') {
      const session = sessionFor(input.id), looking = input.looking !== false;
      if (session.looking !== looking) {
        session.looking = looking;
        if (session.state === 'active') {
          if (looking) { beat(session); if (session.stale || !session.view) await refresh(session); }
          else { clearInterval(session.heartbeat); session.heartbeat = null; send(session, { kind: 'session', active: false }).catch(() => {}); }
        }
      }
    } else if (action === 'refresh') { const session = sessionFor(input.id); if (session.state !== 'active') fail('The host hasn’t allowed you yet.', 409); await refresh(session); }
    else if (action === 'suggest') {
      const session = sessionFor(input.id), text = typeof input.text === 'string' ? input.text.trim() : '';
      if (session.state !== 'active') fail('The host hasn’t allowed you yet.', 409);
      if (!text) fail('Write a suggestion first.');
      if (text.length > SUGGESTION_LENGTH) fail(`Keep a suggestion under ${SUGGESTION_LENGTH} characters.`, 413);
      await send(session, { kind: 'suggest', text });
    } else if (action === 'message') {
      const session = sessionFor(input.id), text = typeof input.text === 'string' ? input.text.trim() : '';
      if (session.state !== 'active') fail('The host hasn’t allowed you yet.', 409);
      if (session.level === 'suggest') fail('They haven’t let you send messages. Send a suggestion instead.', 403);
      if (!text) fail('Write a message first.');
      if (text.length > MESSAGE_INPUT) fail(`Keep a message under ${MESSAGE_INPUT.toLocaleString('en-US')} characters.`, 413);
      const reply = await send(session, { kind: 'message', text });
      if (session.looking) refresh(session);
      return { ...status(projectId), queued: reply.queued === true };
    } else if (action === 'leave') {
      const session = sessionFor(input.id);
      if (session.state === 'active' || session.state === 'pending') await send(session, { kind: 'leave' }).catch(() => {});
      dropSession(session, 'left'); sessions.delete(session.id); persist(); changed();
    } else if (action === 'forget') { const session = sessionFor(input.id); if (['pending', 'active'].includes(session.state)) fail('Leave first.', 409); sessions.delete(session.id); changed(); }
    else fail('Unknown watch-along action.');
    return status(projectId);
  }
  async function close() {
    clearTimeout(notify.timer);
    for (const session of sessions.values()) { clearInterval(session.heartbeat); if (session.looking && session.state === 'active') await Promise.race([send(session, { kind: 'session', active: false }).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]); }
    // Unanswered invites and requests end with Codeshi. Allowed watchers stay allowed and reconnect at the next start.
    const unanswered = [...rooms.values()].filter(room => room.state !== 'active');
    await Promise.race([Promise.allSettled(unanswered.map(room => remove(room, { tell: false }))), new Promise(resolve => setTimeout(resolve, 2000))]);
    persist(); closed = true;
    for (const room of rooms.values()) { room.stop?.(); clearTimeout(room.timer); }
    for (const session of sessions.values()) session.stop?.();
    for (const side of Object.values(clients)) side.close();
  }
  return { status, manage, notify, close };
}

import fs from 'node:fs';
import path from 'node:path';
import { atomicJSON, textDiff, describeFile } from './patches.mjs';
import { sha256, fileBytes, validateRelativePath, scanSecrets } from './collaboration-format.mjs';
import { readWorkspaceFile, writeWorkspaceFile } from './workspace-files.mjs';
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
//
// Running together (#24, slice 3): with 'run', the host lets a teammate run a turn on the teammate's own computer and
// subscription, in their own local copy of the code. Only one run can hold the conversation at a time (either the host's
// or one teammate's), and the host can stop a teammate's run or change their access at any moment. When the run finishes,
// the teammate's prompt and their agent's reply join the shared conversation, and any file changes wait beside the host's
// message box as a reviewed patch checked against the SHA-256 baseline hashes before anything is written to the host.

const INVITE = 30 * 60_000, SESSION = 24 * 60 * 60_000, ACTIVE_WINDOW = 45_000, HEARTBEAT = 20_000, REPLY_TIMEOUT = 20_000, RUN_LEASE = 10 * 60_000;
const MAX_WATCHERS = 5, MAX_SUGGESTIONS = 20, SUGGESTION_LENGTH = 2000, NAME_LENGTH = 60;
const LEVELS = ['suggest', 'ask', 'auto', 'run'], MESSAGE_INPUT = 8000, MAX_WAITING_MESSAGES = 3, QUEUE_SHOWN = 20;
const MAX_PATCH_FILES = 24, MAX_PATCH_BYTES = 400_000, MAX_SCAN_FILES = 2000;
const VIEW_MESSAGES = 60, MESSAGE_LENGTH = 20_000, VIEW_BYTES = 600_000, LABEL_LENGTH = 300;
const ROOM = /^[a-f0-9]{64}$/, HASH = /^[a-f0-9]{64}$/;
const SKIP_FILES = new Set([".DS_Store", ".mock-captures.jsonl", ".mock-scenarios.json", ".release"]);
const SKIP_DIRS = new Set(['.git', '.data', '.ai-relay', '.codeshi', '.codex', '.claude', '.gemini', '.aws', '.ssh', '.gnupg', 'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', 'dist', 'build', 'output', '.venv', 'venv', '__pycache__']);
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const clip = (text, length) => typeof text === 'string' && text.length > length ? `${text.slice(0, length)}…` : text;
const cleanName = (value, fallback) => typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH) : fallback;
const agentLabel = provider => provider === 'claude' ? 'Claude' : provider === 'gemini' ? 'Gemini' : provider === 'antigravity' ? 'Antigravity' : provider === 'codex' ? 'Codex' : 'the agent';

// ---- What a watcher may see. Built from an allowlist, so fields added to conversations later stay on the host.
const CHAT = new Set(['user', 'assistant', 'error', 'system']);
// Who wrote or ran a teammate's turn. The room stays on the host: each watcher only learns whether a turn was theirs.
const author = value => value && typeof value.name === 'string' ? { name: clip(value.name, NAME_LENGTH), room: typeof value.room === 'string' ? value.room : null, ...(value.ranOn === 'peer' ? { ranOn: 'peer' } : {}) } : null;
function approvalLabel(item) {
  const command = item.command || item.input?.command, target = item.input?.file_path || item.input?.path;
  if (item.kind === 'question') return clip(item.questions?.[0]?.question || 'The agent asked a question.', LABEL_LENGTH);
  // A file is named by its folder and name, as in the step line, never by the host's full path.
  return clip(command ? `Run ${command}` : target ? `Change ${shortPath(String(target))}` : item.title || 'Use a tool', LABEL_LENGTH);
}
export function watchView(view, limit = VIEW_MESSAGES) {
  const short = phoneConversation(view, limit);
  const run = short.activeRun;
  const peerRun = view.teammateRun && author(view.teammateRun.author) ? {
    provider: typeof view.teammateRun.provider === 'string' ? clip(view.teammateRun.provider, 40) : null,
    model: typeof view.teammateRun.model === 'string' ? clip(view.teammateRun.model, 80) : null,
    prompt: typeof view.teammateRun.prompt === 'string' ? clip(view.teammateRun.prompt, LABEL_LENGTH) : '',
    step: typeof view.teammateRun.step === 'string' && view.teammateRun.step ? clip(describeStep(view.teammateRun.step), LABEL_LENGTH) || null : null,
    startedAt: typeof view.teammateRun.startedAt === 'string' ? view.teammateRun.startedAt : null,
    author: author(view.teammateRun.author),
  } : null;
  const messages = (short.messages || []).filter(message => CHAT.has(message.role) && typeof message.id === 'string').map(message => ({
    id: message.id, role: message.role, provider: typeof message.provider === 'string' ? message.provider : null,
    createdAt: typeof message.createdAt === 'string' ? message.createdAt : null,
    text: typeof message.text === 'string' ? clip(message.text, MESSAGE_LENGTH) : '',
    attachments: Array.isArray(message.attachments) ? message.attachments.slice(0, 20).map(file => ({ name: clip(String(file?.name || 'file'), 120), kind: file?.kind === 'image' ? 'image' : 'file' })) : [],
    ...((message.role === 'user' || message.role === 'assistant') && author(message.author) ? { author: author(message.author) } : {}),
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
    ...(peerRun ? { teammateRun: peerRun } : {}),
  };
}
// One watcher's copy of the view: authors keep their name, and "mine" replaces the room so nobody learns another's.
const mark = (value, roomId) => value?.author ? { ...value, author: { name: value.author.name, mine: value.author.room === roomId, ...(value.author.ranOn === 'peer' ? { ranOn: 'peer' } : {}) } } : value;
export function roomView(view, roomId) {
  return {
    ...view,
    messages: (view.messages || []).map(message => mark(message, roomId)),
    upNext: (view.upNext || []).map(item => mark(item, roomId)),
    ...(view.teammateRun ? { teammateRun: mark(view.teammateRun, roomId) } : {}),
  };
}

// ---- Workspace file snapshotting and portable patch validation for teammate runs (#24).
function normalizeWorkspace(workspace) {
  if (!workspace) return null;
  if (typeof workspace === 'string') {
    let resolved = path.resolve(workspace); try { resolved = fs.realpathSync(resolved); } catch {} const name = path.basename(resolved) || 'workspace';
    return { pathStyle: 'relative', allowedPaths: [resolved], folders: [{ id: 'root', name, displayName: name, path: resolved }] };
  }
  return Array.isArray(workspace.folders) ? workspace : null;
}
function scanWorkspaceFiles(rawWorkspace) {
  const workspace = normalizeWorkspace(rawWorkspace), files = new Map();
  if (!workspace) return files;
  const walk = (root, prefix, relDir) => {
    if (files.size >= MAX_SCAN_FILES) return;
    let entries;
    try { entries = fs.readdirSync(relDir ? path.join(root, relDir) : root, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (files.size >= MAX_SCAN_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(root, prefix, rel);
      } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
        const workspacePath = prefix ? `${prefix}/${rel}` : rel;
        try {
          validateRelativePath(workspacePath);
          const file = readWorkspaceFile(workspace, workspacePath, { allowMissing: true, binary: true });
          if (file && file.sha256 !== null) files.set(workspacePath, file);
        } catch { /* Skip private, excluded or oversized files. */ }
      }
    }
  };
  for (const folder of workspace.folders) {
    if (!folder?.path) continue;
    const prefix = workspace.pathStyle === 'namespaced' ? (folder.displayName || folder.name) : '';
    walk(folder.path, prefix, '');
  }
  return files;
}
function diffWorkspaceFiles(beforeMap, afterMap) {
  const changed = [];
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  for (const relative of paths) {
    const was = beforeMap.get(relative) || null, now = afterMap.get(relative) || null;
    if ((was?.sha256 || null) === (now?.sha256 || null)) continue;
    changed.push({
      path: relative,
      baseHash: was?.sha256 || null,
      afterHash: now?.sha256 || null,
      content: now ? now.content : null,
      ...(now?.encoding ? { encoding: now.encoding } : {}),
    });
  }
  return changed;
}
function validatePatchFiles(rawFiles) {
  if (rawFiles === undefined || rawFiles === null) return [];
  if (!Array.isArray(rawFiles)) fail('Patch files must be an array.');
  if (rawFiles.length > MAX_PATCH_FILES) fail(`Keep a teammate run’s changes to at most ${MAX_PATCH_FILES} files.`, 413);
  const seen = new Set(), clean = [];
  let totalBytes = 0;
  for (const raw of rawFiles) {
    if (!raw || typeof raw !== 'object') fail('Invalid patch file entry.');
    const relative = validateRelativePath(raw.path);
    if (seen.has(relative)) fail(`Duplicate path in patch: ${relative}`);
    seen.add(relative);
    const baseHash = raw.baseHash === null || raw.baseHash === undefined ? null : String(raw.baseHash);
    if (baseHash !== null && !HASH.test(baseHash)) fail(`Invalid baseline hash for ${relative}.`);
    if (raw.content === null) {
      if (baseHash === null) fail(`Cannot delete a file that had no baseline: ${relative}`);
      clean.push({ path: relative, baseHash, afterHash: null, content: null });
    } else {
      const entry = { path: relative, content: raw.content, ...(raw.encoding ? { encoding: raw.encoding } : {}) };
      const bytes = fileBytes(entry, relative);
      const afterHash = sha256(bytes);
      if (raw.afterHash && raw.afterHash !== afterHash) fail(`Patch file hash does not match its content: ${relative}`);
      if (baseHash === afterHash) continue;
      totalBytes += bytes.length;
      if (totalBytes > MAX_PATCH_BYTES) fail(`Teammate patch exceeds ${Math.round(MAX_PATCH_BYTES / 1024)} KB. Share larger changes through Ask a Friend or Git.`, 413);
      clean.push({ path: relative, baseHash, afterHash, content: raw.content, ...(raw.encoding ? { encoding: raw.encoding } : {}) });
    }
  }
  return clean;
}

// The invite as text: codeshi://watch/<room>.<secret>. A pasted link may carry spaces or angle brackets from a chat app.
export function watchLink(id, secret) { return `codeshi://watch/${id}.${secret}`; }
export function parseWatchLink(text) {
  const match = String(text || '').trim().match(/(?:^|[/#=\s<])([a-f0-9]{64})\.([a-f0-9]{64})(?:$|[\s>])/i);
  return match ? { id: match[1].toLowerCase(), secret: match[2].toLowerCase() } : null;
}
const sixDigits = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');

// sendMessage(projectId, { text, author, billingConfirmed }) queues a teammate's message on the host's conversation.
// recordTurn(projectId, { prompt, reply, provider, model, author, files }) records a turn a teammate ran on their own account.
// runLocal({ sessionId, runId, projectId, prompt, provider, model, view, onStep, registerCancel }) runs a turn on the viewer's own computer.
export function createWatchAlong({ config, storeFile, readConversation, sendMessage, recordTurn, notePatch, runLocal, workspaceFor, workspaceName = () => 'Workspace', defaultName = 'Teammate', clientFactory, onChange = () => {}, now = Date.now } = {}) {
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
  const rooms = new Map(), invites = new Map(), teammateRuns = new Map();
  let suggestions = Array.isArray(store.suggestions) ? store.suggestions.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.projectId === 'string' && (item.kind !== 'patch' || Array.isArray(item.files))).slice(-MAX_SUGGESTIONS * 4) : [];
  const isActiveNow = room => room.state === 'active' && room.looking !== false && Boolean(room.lastSeenAt && now() - room.lastSeenAt < ACTIVE_WINDOW);

  function activeTeammateRun(projectId) {
    const run = teammateRuns.get(projectId);
    if (!run) return null;
    const room = rooms.get(run.roomId);
    if (!room || room.state !== 'active' || room.level !== 'run' || now() - run.updatedAt > RUN_LEASE) {
      teammateRuns.delete(projectId);
      return null;
    }
    return run;
  }
  function hostConversationView(projectId) {
    const base = readConversation(projectId) || {};
    const active = activeTeammateRun(projectId);
    if (!active || base.teammateRun) return base;
    return watchView({ ...base, teammateRun: { provider: active.provider, model: active.model, prompt: active.prompt, step: active.step, startedAt: active.startedAt, author: { name: active.name, room: active.roomId, ranOn: 'peer' } } });
  }

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
    if (teammateRuns.get(room.projectId)?.roomId === room.id) teammateRuns.delete(room.projectId);
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
        const view = roomView(hostConversationView(room.projectId), room.id);
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
    else if (request.kind === 'run-start') reply = { id: request.id, ...startTeammateRun(room, request) };
    else if (request.kind === 'run-step') reply = { id: request.id, ...stepTeammateRun(room, request) };
    else if (request.kind === 'run-finish') reply = { id: request.id, ...await finishTeammateRun(room, request) };
    else reply = { id: request.id, status: 400, error: 'Unknown watch request.' };
    if (!rooms.has(room.id)) return;
    entry.reply = reply;
    await publish(room, reply).catch(() => {});
  }
  // A watcher's message, by the level the host chose for them. The host's choice is checked here, on the host, each time.
  async function message(room, value) {
    const text = typeof value === 'string' ? value.trim() : '', level = room.level || 'suggest';
    if (level === 'suggest') return { status: 403, error: 'They haven’t let you send messages. Send a suggestion instead.', level };
    if (level === 'run') return { status: 403, error: 'Your access is set to run on your own account. Run it on your computer or send a suggestion.', level };
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

  // ---- Teammate runs on their own computer and account (#24, slice 3).
  function startTeammateRun(room, request) {
    const level = room.level || 'suggest';
    if (level !== 'run') return { status: 403, error: 'They haven’t let you run on your own account.', level };
    const runId = typeof request.runId === 'string' && /^[a-f0-9-]{16,64}$/i.test(request.runId) ? request.runId : '';
    if (!runId) return { status: 400, error: 'Invalid teammate run ID.' };
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) return { status: 400, error: 'Write a message first.' };
    if (prompt.length > MESSAGE_INPUT) return { status: 413, error: `Keep a message under ${MESSAGE_INPUT.toLocaleString('en-US')} characters.` };
    let hostRunning = false;
    try { hostRunning = readConversation(room.projectId)?.status === 'running'; } catch { /* Checked when readable. */ }
    if (hostRunning) return { status: 409, error: 'Wait for their current run to finish first.' };
    const currentRun = activeTeammateRun(room.projectId);
    if (currentRun && currentRun.id !== runId) {
      return { status: 409, error: currentRun.roomId === room.id ? 'Your run is already in progress.' : `${currentRun.name} is already running a turn. Wait for them to finish first.` };
    }
    const waitingPatches = suggestions.filter(item => item.roomId === room.id && item.kind === 'patch' && item.status !== 'applied').length;
    if (waitingPatches >= MAX_WAITING_MESSAGES) return { status: 429, error: `You have ${MAX_WAITING_MESSAGES} sets of file changes waiting for review. Wait for them to apply or dismiss one first.` };
    if (suggestions.filter(item => item.projectId === room.projectId).length >= MAX_SUGGESTIONS) return { status: 429, error: 'The host has too many items waiting for review. Try again after they review them.' };
    const provider = typeof request.provider === 'string' && request.provider.trim() ? clip(request.provider.trim(), 40) : 'claude';
    const model = typeof request.model === 'string' && request.model.trim() ? clip(request.model.trim(), 80) : null;
    teammateRuns.set(room.projectId, {
      id: runId,
      roomId: room.id,
      projectId: room.projectId,
      name: room.name,
      provider,
      model,
      prompt,
      step: null,
      startedAt: new Date(now()).toISOString(),
      updatedAt: now(),
    });
    changed();
    notify(room.projectId, null, { excludeRoomId: room.id });
    return { status: 200, started: true };
  }
  function stepTeammateRun(room, request) {
    const active = activeTeammateRun(room.projectId);
    if (!active || active.roomId !== room.id || active.id !== request.runId) return { status: 409, error: 'That run is no longer active.', cancelled: true };
    const rawStep = typeof request.step === 'string' ? request.step.trim() : '';
    active.step = rawStep ? clip(describeStep(rawStep) || rawStep, LABEL_LENGTH) : null;
    active.updatedAt = now();
    changed();
    notify(room.projectId, null, { excludeRoomId: room.id });
    return { status: 200, ok: true };
  }
  async function finishTeammateRun(room, request) {
    const active = activeTeammateRun(room.projectId);
    const matches = active && active.roomId === room.id && active.id === request.runId;
    if (matches) teammateRuns.delete(room.projectId);
    if ((room.level || 'suggest') !== 'run' || !matches) {
      changed();
      notify(room.projectId, null, { excludeRoomId: room.id });
      return { status: 409, error: 'That run was stopped by the host.' };
    }
    if (request.status === 'stopped' || request.status === 'failed') {
      changed();
      notify(room.projectId, null, { excludeRoomId: room.id });
      return { status: 200, finished: true, recorded: false };
    }
    let cleanFiles;
    try { cleanFiles = validatePatchFiles(request.files); }
    catch (error) {
      changed();
      notify(room.projectId, null, { excludeRoomId: room.id });
      return { status: error.status || 400, error: error.message };
    }
    const prompt = clip(typeof request.prompt === 'string' && request.prompt.trim() ? request.prompt.trim() : active.prompt, MESSAGE_INPUT);
    const replyText = clip(typeof request.reply === 'string' ? request.reply.trim() : '', MESSAGE_LENGTH);
    const provider = typeof request.provider === 'string' && request.provider.trim() ? clip(request.provider.trim(), 40) : active.provider;
    const model = typeof request.model === 'string' && request.model.trim() ? clip(request.model.trim(), 80) : active.model;
    const peerAuthor = { name: room.name, room: room.id, ranOn: 'peer' };
    try {
      await recordTurn?.(room.projectId, {
        runId: active.id,
        prompt,
        reply: replyText,
        provider,
        model,
        author: peerAuthor,
        files: cleanFiles.map(file => file.path),
      });
    } catch (failure) {
      changed();
      notify(room.projectId, null, { excludeRoomId: room.id });
      return { status: failure.status || 503, error: failure.message || 'The host could not record that turn.' };
    }
    let patchId = null;
    if (cleanFiles.length) {
      patchId = token(8);
      suggestions.push({
        id: patchId,
        kind: 'patch',
        projectId: room.projectId,
        roomId: room.id,
        from: room.name,
        provider,
        model,
        text: prompt,
        reply: clip(replyText, SUGGESTION_LENGTH),
        files: cleanFiles,
        status: 'pending',
        at: new Date(now()).toISOString(),
      });
      persist();
    }
    changed();
    notify(room.projectId, null, { excludeRoomId: room.id });
    return { status: 200, finished: true, recorded: true, patchId };
  }
  async function cancelTeammateRun(projectId, roomId = null) {
    const active = activeTeammateRun(projectId);
    if (!active || (roomId && active.roomId !== roomId)) fail('No teammate run is active right now.', 409);
    teammateRuns.delete(projectId);
    const room = rooms.get(active.roomId);
    changed();
    notify(projectId, null, { excludeRoomId: active.roomId });
    if (room) await publish(room, { event: 'run-cancel', runId: active.id }).catch(() => {});
  }

  // ---- Reviewing, applying and undoing a teammate's file changes on the host (#24).
  function findPatch(projectId, id) {
    const item = suggestions.find(entry => entry.id === id && entry.projectId === projectId && entry.kind === 'patch');
    if (!item) fail('Those changes were already dismissed.', 404);
    return item;
  }
  function previewPatch(projectId, id) {
    const item = findPatch(projectId, id);
    const workspace = normalizeWorkspace(workspaceFor?.(projectId));
    if (!workspace) fail('This workspace has no files to compare against.', 409);
    const files = [], conflicts = [], warnings = [];
    for (const file of item.files) {
      let current = { path: file.path, content: null, sha256: null, mode: null }, readError = null;
      try { current = readWorkspaceFile(workspace, file.path, { allowMissing: true, binary: true }); }
      catch (error) { readError = error.message; }
      const operation = file.content === null ? 'delete' : file.baseHash === null ? 'create' : 'replace';
      let conflict = null;
      if (readError) conflict = { path: file.path, expected: file.baseHash, actual: null, reason: readError };
      else if (item.status !== 'applied' && current.sha256 !== file.baseHash) {
        conflict = {
          path: file.path,
          expected: file.baseHash,
          actual: current.sha256,
          reason: current.sha256 === null ? 'File is missing on your computer.' : file.baseHash === null ? 'File already exists on your computer.' : 'File differs from the baseline your teammate ran against.',
        };
      }
      if (conflict) conflicts.push(conflict);
      if (typeof file.content === 'string') {
        for (const warning of scanSecrets({ [file.path]: file.content })) warnings.push({ ...warning, path: file.path });
      }
      if (current.encoding !== undefined || file.encoding !== undefined) {
        files.push({ path: file.path, operation, baseHash: file.baseHash, currentHash: current.sha256, afterHash: file.afterHash, diff: '', binary: { before: describeFile(current, file.path), after: describeFile(file, file.path) }, conflict });
      } else {
        const beforeText = item.status === 'applied' && Array.isArray(item.recovery)
          ? (item.recovery.find(op => op.path === file.path)?.before?.content ?? current.content)
          : current.content;
        files.push({ path: file.path, operation, baseHash: file.baseHash, currentHash: current.sha256, afterHash: file.afterHash, diff: textDiff(file.path, beforeText, file.content), conflict });
      }
    }
    const digest = sha256(JSON.stringify(files.map(file => [file.path, file.operation, file.baseHash, file.currentHash, file.afterHash])));
    return {
      id: item.id,
      from: item.from,
      provider: item.provider,
      model: item.model || null,
      prompt: item.text,
      reply: item.reply || '',
      status: item.status || 'pending',
      at: item.at,
      appliedAt: item.appliedAt || null,
      digest,
      files,
      conflicts,
      warnings,
    };
  }
  async function applyPatch(projectId, id, digest) {
    const item = findPatch(projectId, id);
    if (item.status === 'applied') fail('Those changes were already applied.', 409);
    const preview = previewPatch(projectId, id);
    if (typeof digest !== 'string' || preview.digest !== digest) fail('Approve the exact reviewed diff before applying changes.', 400);
    if (preview.conflicts.length) throw Object.assign(Error('One or more files changed on your computer since their baseline; no files were written.'), { status: 409, conflicts: preview.conflicts });
    const workspace = normalizeWorkspace(workspaceFor?.(projectId));
    const operations = item.files.map(file => ({
      path: file.path,
      before: readWorkspaceFile(workspace, file.path, { allowMissing: true, binary: true }),
      after: { content: file.content, ...(file.encoding ? { encoding: file.encoding } : {}), sha256: file.afterHash },
    }));
    item.recovery = operations;
    persist();
    const written = [];
    try {
      for (const op of operations) {
        writeWorkspaceFile(workspace, op.path, op.after.content, {
          expectedHash: op.before.sha256,
          mode: op.before.mode ?? 0o644,
          encoding: op.after.encoding,
          binary: true,
        });
        written.push(op);
      }
    } catch (error) {
      for (const op of written.reverse()) {
        try {
          writeWorkspaceFile(workspace, op.path, op.before.content, {
            expectedHash: op.after.sha256,
            mode: op.before.mode ?? 0o644,
            encoding: op.before.encoding,
            binary: true,
          });
        } catch { /* Best-effort rollback on failure. */ }
      }
      delete item.recovery;
      persist();
      throw error;
    }
    item.status = 'applied';
    item.appliedAt = new Date(now()).toISOString();
    persist();
    try {
      await notePatch?.(projectId, `Applied ${item.from}’s changes from ${agentLabel(item.provider)} (${operations.length} ${operations.length === 1 ? 'file' : 'files'}: ${operations.map(op => op.path).join(', ')}). A recovery checkpoint is saved.`);
    } catch { /* Note is informational. */ }
    changed();
    notify(projectId);
  }
  async function undoPatch(projectId, id) {
    const item = findPatch(projectId, id);
    if (item.status !== 'applied' || !Array.isArray(item.recovery)) fail('Those changes have not been applied.', 409);
    const workspace = normalizeWorkspace(workspaceFor?.(projectId));
    if (!workspace) fail('This workspace is unavailable.', 409);
    const conflicts = [], restore = [];
    for (const op of item.recovery) {
      try {
        const current = readWorkspaceFile(workspace, op.path, { allowMissing: true, binary: true });
        if (current.sha256 === op.before.sha256) continue;
        if (current.sha256 === op.after.sha256) restore.push(op);
        else conflicts.push({ path: op.path, reason: 'Newer local changes were preserved; undo will not overwrite them.' });
      } catch (error) { conflicts.push({ path: op.path, reason: error.message }); }
    }
    if (conflicts.length) throw Object.assign(Error(`Newer local edits were preserved; undo will not overwrite them (${conflicts.map(c => c.path).join(', ')}).`), { status: 409, conflicts });
    for (const op of restore) {
      writeWorkspaceFile(workspace, op.path, op.before.content, {
        expectedHash: op.after.sha256,
        mode: op.before.mode ?? 0o644,
        encoding: op.before.encoding,
        binary: true,
      });
    }
    item.status = 'pending';
    delete item.recovery;
    delete item.appliedAt;
    persist();
    try {
      await notePatch?.(projectId, `Undid ${item.from}’s applied changes (${item.files.map(file => file.path).join(', ')}).`);
    } catch { /* Note is informational. */ }
    changed();
    notify(projectId);
  }

  async function setLevel(room, level) {
    if (!LEVELS.includes(level)) fail('Choose suggestions only, ask first, send straight to the queue, or run on their own account.');
    if (room.state !== 'active') fail('Allow them first.', 409);
    if ((room.level || 'suggest') === level) return;
    if (room.level === 'run' && level !== 'run' && teammateRuns.get(room.projectId)?.roomId === room.id) {
      const cancelled = teammateRuns.get(room.projectId);
      teammateRuns.delete(room.projectId);
      await publish(room, { event: 'run-cancel', runId: cancelled.id }).catch(() => {});
    }
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
  function notify(projectId, conversationId, { excludeRoomId = null } = {}) {
    const targets = [...rooms.values()].filter(room => room.state === 'active' && room.projectId === projectId && room.id !== excludeRoomId && (!room.conversationId || !conversationId || room.conversationId === conversationId));
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
    return {
      id: session.id, workspace: session.workspace || '', title: session.title || '', state: session.state, code: session.code, name: session.name, expiresAt: session.expiresAt || null,
      error: session.error || null, view: session.looking ? session.view || null : null, updatedAt: session.updatedAt || null, looking: Boolean(session.looking), level: session.level || 'suggest',
      running: session.running ? {
        id: session.running.id,
        prompt: session.running.prompt,
        provider: session.running.provider,
        model: session.running.model || null,
        projectId: session.running.targetProjectId || null,
        step: session.running.step || null,
        startedAt: session.running.startedAt,
      } : null,
    };
  }
  function cancelSessionRun(session, reason = 'Stopped.') {
    const active = session.running;
    if (!active) return;
    active.cancelled = true;
    active.cancelReason = reason;
    try { active.cancel?.(); } catch { /* Cancellation callback is best-effort. */ }
  }
  function dropSession(session, state = 'ended') {
    cancelSessionRun(session, state === 'ended' ? 'The host stopped sharing.' : 'You left.');
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
      if (value.event === 'run-cancel' && session.running && (!value.runId || session.running.id === value.runId)) {
        cancelSessionRun(session, 'The host stopped your run.');
        changed();
      }
      if (LEVELS.includes(value.level) && value.level !== session.level && (session.state === 'active' || value.state === 'active')) {
        session.level = value.level;
        if (value.level !== 'run' && session.running) cancelSessionRun(session, 'The host changed your access to this conversation.');
        persist(); changed();
      }
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
      level: LEVELS.includes(entry.level) ? entry.level : 'suggest', key: null, waiting: new Map(), queue: Promise.resolve(), looking: false, view: null, base: null, texts: null, running: null };
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

  // Starts a run on the viewer's own computer and account, streams sanitized step updates to the host, and returns
  // the finished reply and changed-file patch to the host's shared conversation.
  async function startViewerRun(session, input) {
    if (session.state !== 'active') fail('The host hasn’t allowed you yet.', 409);
    if (session.level !== 'run') fail('They haven’t let you run on your own account.', 403);
    if (session.running) fail('Wait for your current run to finish first.', 409);
    if (typeof runLocal !== 'function') fail('Running on your own account is not available in this build.', 501);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) fail('Write a message first.');
    if (text.length > MESSAGE_INPUT) fail(`Keep a message under ${MESSAGE_INPUT.toLocaleString('en-US')} characters.`, 413);
    const targetProjectId = input.targetProjectId || input.localProjectId || input.projectId || null;
    const provider = typeof input.provider === 'string' && input.provider.trim() ? clip(input.provider.trim(), 40) : 'claude';
    const model = typeof input.model === 'string' && input.model.trim() ? clip(input.model.trim(), 80) : null;
    const runId = token(16);
    await send(session, { kind: 'run-start', runId, prompt: text, provider, model });
    const runState = {
      id: runId,
      prompt: text,
      provider,
      model,
      targetProjectId,
      step: null,
      startedAt: new Date(now()).toISOString(),
      cancel: null,
      cancelled: false,
      cancelReason: null,
      done: null,
    };
    session.running = runState;
    session.error = null;
    changed();

    const execute = (async () => {
      const rawWorkspace = workspaceFor ? (() => { try { return workspaceFor(targetProjectId); } catch { return null; } })() : null;
      const beforeFiles = rawWorkspace ? scanWorkspaceFiles(rawWorkspace) : null;
      let outcome = null, localError = null;
      try {
        outcome = await runLocal({
          sessionId: session.id,
          runId,
          projectId: targetProjectId,
          prompt: text,
          provider,
          model,
          view: session.view,
          registerCancel: fn => {
            runState.cancel = fn;
            if (runState.cancelled) { try { fn?.(); } catch {} }
          },
          onStep: rawStep => {
            if (session.running?.id !== runId || runState.cancelled) return;
            const clean = typeof rawStep === 'string' && rawStep.trim() ? clip(describeStep(rawStep.trim()) || rawStep.trim(), LABEL_LENGTH) : null;
            if (!clean || clean === runState.step) return;
            runState.step = clean;
            changed();
            send(session, { kind: 'run-step', runId, step: clean }).catch(error => {
              if (/no longer active|stopped/i.test(error?.message || '')) cancelSessionRun(session, 'The host stopped your run.');
            });
          },
        });
      } catch (error) {
        localError = error;
      }
      const afterFiles = !localError && !runState.cancelled && outcome?.status !== 'stopped' && outcome?.status !== 'failed' && rawWorkspace
        ? scanWorkspaceFiles(rawWorkspace)
        : null;
      const detectedFiles = beforeFiles && afterFiles ? diffWorkspaceFiles(beforeFiles, afterFiles) : [];
      const files = Array.isArray(outcome?.files) ? outcome.files : detectedFiles;
      const finalStatus = runState.cancelled || outcome?.status === 'stopped' ? 'stopped' : localError || outcome?.status === 'failed' ? 'failed' : 'complete';
      const replyText = finalStatus === 'complete' && typeof outcome?.reply === 'string' ? outcome.reply : '';
      const finalProvider = outcome?.provider || provider;
      const finalModel = outcome?.model !== undefined ? outcome.model : model;
      if (session.running?.id === runId) session.running = null;
      if (localError && !runState.cancelled) session.error = localError.message;
      else if (outcome?.status === 'failed' && outcome?.error) session.error = outcome.error;
      changed();
      let hostReply = null;
      if (session.state === 'active') {
        try {
          hostReply = await send(session, {
            kind: 'run-finish',
            runId,
            status: finalStatus,
            prompt: text,
            provider: finalProvider,
            model: finalModel,
            reply: replyText,
            files: finalStatus === 'complete' ? files : [],
            ...(localError ? { error: localError.message } : outcome?.error ? { error: outcome.error } : {}),
          });
        } catch (finishError) {
          if (!runState.cancelled) session.error = finishError.message;
        }
        if (session.looking) await refresh(session);
      }
      if (localError && !runState.cancelled) throw localError;
      return {
        runId,
        status: finalStatus,
        provider: finalProvider,
        model: finalModel,
        reply: replyText,
        files: finalStatus === 'complete' ? files.map(file => file.path) : [],
        patchId: hostReply?.patchId || null,
      };
    })();
    runState.done = execute;
    execute.catch(() => {});
    if (input.wait === false) return { started: runId };
    return { run: await execute };
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
    const peerRun = projectId ? activeTeammateRun(projectId) : null;
    return {
      configured: Boolean(settings), error: setupError,
      name: store.name || defaultName,
      host: projectId ? {
        invite: inviteRoom && inviteRoom.state === 'waiting' ? { link: inviteRoom.link, expiresAt: inviteRoom.expiresAt } : null,
        watchers: [...rooms.values()].filter(room => room.projectId === projectId && room.state !== 'waiting').map(room => ({
          id: room.id, name: room.name, code: room.code, state: room.state, level: room.level || 'suggest', watchingNow: isActiveNow(room), lastSeenAt: room.lastSeenAt || null, expiresAt: room.expiresAt })),
        teammateRun: peerRun ? {
          id: peerRun.id,
          roomId: peerRun.roomId,
          from: peerRun.name,
          provider: peerRun.provider,
          model: peerRun.model || null,
          prompt: peerRun.prompt,
          step: peerRun.step || null,
          startedAt: peerRun.startedAt,
        } : null,
        suggestions: suggestions.filter(item => item.projectId === projectId).map(item => item.kind === 'patch' ? ({
          id: item.id,
          kind: 'patch',
          from: item.from,
          provider: item.provider,
          model: item.model || null,
          text: item.text,
          reply: item.reply || '',
          status: item.status || 'pending',
          files: (item.files || []).map(file => ({
            path: file.path,
            operation: file.content === null ? 'delete' : file.baseHash === null ? 'create' : 'replace',
          })),
          at: item.at,
          ...(item.appliedAt ? { appliedAt: item.appliedAt } : {}),
        }) : ({
          id: item.id,
          kind: item.kind === 'message' ? 'message' : 'suggestion',
          from: item.from,
          text: item.text,
          at: item.at,
          ...(item.reason ? { reason: item.reason } : {}),
        })),
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
    else if (action === 'cancel-run') await cancelTeammateRun(projectId, input.id || null);
    else if (action === 'preview-patch') return { ...status(projectId), patchPreview: previewPatch(projectId, input.id) };
    else if (action === 'apply-patch') await applyPatch(projectId, input.id, input.digest);
    else if (action === 'undo-patch') await undoPatch(projectId, input.id);
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
      if (session.level === 'run') fail('Your access is set to run on your own account. Run it on your computer or send a suggestion.', 403);
      if (!text) fail('Write a message first.');
      if (text.length > MESSAGE_INPUT) fail(`Keep a message under ${MESSAGE_INPUT.toLocaleString('en-US')} characters.`, 413);
      const reply = await send(session, { kind: 'message', text });
      if (session.looking) refresh(session);
      return { ...status(projectId), queued: reply.queued === true };
    } else if (action === 'run') {
      const session = sessionFor(input.id);
      const result = await startViewerRun(session, input);
      return { ...status(projectId), ...result };
    } else if (action === 'stop-run') {
      const session = sessionFor(input.id);
      if (!session.running) fail('No run is in progress.', 409);
      const runPromise = session.running.done;
      cancelSessionRun(session, 'You stopped the run.');
      if (runPromise) await runPromise.catch(() => {});
      return status(projectId);
    } else if (action === 'leave') {
      const session = sessionFor(input.id);
      cancelSessionRun(session, 'You left.');
      if (session.state === 'active' || session.state === 'pending') await send(session, { kind: 'leave' }).catch(() => {});
      dropSession(session, 'left'); sessions.delete(session.id); persist(); changed();
    } else if (action === 'forget') { const session = sessionFor(input.id); if (['pending', 'active'].includes(session.state)) fail('Leave first.', 409); sessions.delete(session.id); changed(); }
    else fail('Unknown watch-along action.');
    return status(projectId);
  }
  async function close() {
    clearTimeout(notify.timer);
    for (const session of sessions.values()) {
      cancelSessionRun(session, 'Codeshi is closing.');
      clearInterval(session.heartbeat);
      if (session.looking && session.state === 'active') await Promise.race([send(session, { kind: 'session', active: false }).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    }
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

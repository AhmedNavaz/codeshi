import { FirebasePhoneClient, firebaseConfig, token, roomKey, seal, open, REMOTE_BUSY, normalizeHandoverCode, handoverMeeting, handoverKeys, handoverShared } from './phone-firebase.mjs';
import { TRANSFER_ENCODING, conversationRoute, decodeConversation } from './phone-transfer.mjs';

const $ = id => document.getElementById(id), app = $('app');
document.body.classList.add('phone-pair-page');
const panel = document.createElement('main'); panel.className = 'phone-pair-card';
const title = document.createElement('h1'), note = document.createElement('p'), code = document.createElement('strong');
code.id = 'phone-match-code';
title.textContent = 'Connect to Codeshi'; note.setAttribute('role', 'status');
// An unpaired browser, such as a new Home Screen icon, can take over a connection with the code from Move to another browser.
const form = document.createElement('form'), field = document.createElement('input'), label = document.createElement('label'), submit = document.createElement('button');
label.append('Code from Move to another browser', field); form.append(label, submit); form.hidden = true;
Object.assign(field, { id: 'phone-handover-code', autocomplete: 'off', spellcheck: false, required: true, maxLength: 11, placeholder: 'XXXX XXXX' });
field.setAttribute('autocapitalize', 'characters'); field.setAttribute('autocorrect', 'off');
submit.type = 'submit'; submit.textContent = 'Connect';
panel.append(title, note, code, form); document.body.prepend(panel);
// Chromium offers installation only through this event, often before the app has loaded. Keep it for the Home Screen step.
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); window.codeshiInstallPrompt = event; window.dispatchEvent(new Event('codeshi-install-ready')); });
let client, stopWatching, key, room, config, sessionKey, active = false, canWatch = false, chain = Promise.resolve(), awaiting = null, conversation = null;
const listeners = new Set();
const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* An open session works without storage. */ } };
function unpair() { if (sessionKey) write(sessionKey, null); }
function deviceId() {
  const key = `codeshi:remote-device:${config.projectId}`;
  let id = read(key);
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) { id = token(16); write(key, id); }
  return id;
}
function event(type, data = {}) { for (const listener of listeners) listener(type, data); }
function waitingForApproval(matchCode) {
  title.textContent = 'Allow it on your computer';
  code.textContent = matchCode;
  note.textContent = 'Check that Codeshi shows this number, then choose Allow. This browser will be able to send prompts and answer approvals.';
}
async function watchAfterClaim(uid, requestId) {
  // Firebase permits reading responses only after the desktop has claimed this phone. Sending the pair packet
  // does not mean the desktop has received it yet, so wait for its metadata rather than opening a denied stream.
  while (awaiting?.id === requestId) {
    const meta = await client.request(`rooms/${room}/meta`);
    if (awaiting?.id !== requestId) return;
    if (!meta || meta.expiresAt <= Date.now() || meta.peer && meta.peer !== uid) {
      unpair(); throw Error('This connection expired or was removed. Scan a new QR code on your computer.');
    }
    if (meta.peer === uid) { canWatch = true; watch(); return; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function packet(value) {
  const identity = await client.identity();
  const request = { ...value, id: token(16), at: Date.now() };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (awaiting?.id === request.id) awaiting = null;
      reject(Error('Can’t reach your computer. Check that it’s awake, online and running Codeshi.'));
    }, 25000);
    awaiting = { id: request.id, resolve: value => { clearTimeout(timer); awaiting = null; resolve(value); }, reject: error => { clearTimeout(timer); awaiting = null; reject(error); } };
    seal(key, room, 'request', request).then(async box => {
      await client.request(`rooms/${room}/request`, 'PUT', { uid: identity.uid, box });
      if (value.kind === 'pair' || value.kind === 'meet') await watchAfterClaim(identity.uid, request.id);
    })
      .catch(error => { if (awaiting?.id === request.id) awaiting.reject(error); });
  });
}
// One mailbox per phone bounds cloud storage. Serialize API calls so simultaneous model/account checks cannot
// overwrite another request. Mutations are never retried automatically after an uncertain network failure.
function request(value) {
  const next = chain.then(() => packet(value)); chain = next.catch(() => {}); return next;
}
function watch() {
  if (!canWatch || document.hidden) return;
  stopWatching?.();
  stopWatching = client.watch(`rooms/${room}/out`, async box => {
    if (!box) return;
    let message; try { message = await open(key, room, 'out', box); } catch { return; }
    if (Math.abs(Date.now() - message.at) > 60000) return;
    if (!active && message.state === 'pending') waitingForApproval(message.code || code.textContent);
    if (awaiting && awaiting.id === message.id) awaiting.resolve(message);
    if (message.state === 'active' && !active) activate();
    if (message.event) event(message.event, {});
    if (message.projectsChanged) event('projects');
  }, error => { if (active) event('error'); else note.textContent = error.message; });
}
function activate() {
  if (active) return; active = true;
  window.relayPhoneTransport = {
    remote: true, unpair,
    async fetch(path, options = {}) {
      if (path === '/phone/logout') {
        try { await client.request(`rooms/${room}/request`, 'PUT', { uid: (await client.identity()).uid, box: await seal(key, room, 'request', { id: token(16), at: Date.now(), kind: 'logout' }) }); }
        finally { unpair(); }
        return new Response('{}', { status: 200 });
      }
      try {
        if (path === '/phone/handover') {
          const result = await request({ kind: 'handover' });
          return new Response(JSON.stringify(result.body || {}), { status: result.status || 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/phone/push') {
          const input = options.body ? JSON.parse(options.body) : {};
          const result = await request({ kind: 'push', ...(input.action === 'subscribe' ? { action: 'subscribe', subscription: input.subscription } : input.action === 'unsubscribe' ? { action: 'unsubscribe' } : {}) });
          return new Response(JSON.stringify(result.body || {}), { status: result.status || 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/phone/session' || path.startsWith('/phone/session?')) {
          const url = new URL(path, 'https://phone.local');
          const result = await request({ kind: 'session', ...(url.searchParams.get('active') === '0' ? { active: false } : {}) });
          return new Response(JSON.stringify(result), { status: result.status || (result.state === 'active' ? 200 : 401) });
        }
        const method = options.method || 'GET', view = method === 'GET' && conversationRoute(path);
        const send = async (target, base) => {
          const result = await request({ kind: 'api', method, path: target, ...(options.body ? { body: JSON.parse(options.body) } : {}),
            ...(view ? { transfer: { encoding: TRANSFER_ENCODING, base } } : {}) });
          if (view && result.transfer?.encoding === TRANSFER_ENCODING && result.status === 200 && Array.isArray(result.body?.messages)) {
            const decoded = decodeConversation(result.body, view, base, conversation, result.transfer.base);
            result.body = decoded.body; conversation = decoded.state;
          } else if (view) conversation = null; // Older desktop builds still send ordinary full message text.
          return result;
        };
        let result;
        try { result = await send(path, conversation?.view === view ? conversation.base : null); }
        catch (error) {
          if (!view || error.code !== 'PHONE_TEXT_BASE') throw error;
          // Only a conversation GET may be retried. Never repeat prompts, approvals or any other mutation.
          conversation = null;
          const fresh = new URL(path, 'https://phone.local'); fresh.searchParams.delete('since');
          result = await send(fresh.pathname + fresh.search, null);
        }
        return new Response(JSON.stringify(result.body || {}), { status: result.status || 503, headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        if ([401, 403].includes(error.status)) { unpair(); return new Response('{}', { status: 401 }); }
        throw error;
      }
    },
    events() {
      const source = new EventTarget(); source.readyState = 1;
      const relay = (type, data) => {
        // Progress refreshes the current conversation, not the full workspace list or connection setup.
        source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
      };
      listeners.add(relay); source.close = () => { source.readyState = 2; listeners.delete(relay); };
      queueMicrotask(() => source.dispatchEvent(new Event('ready'))); return source;
    },
  };
  panel.hidden = true; document.body.classList.remove('phone-pair-page'); app.hidden = false;
  const script = document.createElement('script'); script.src = '/phone.js'; document.head.append(script);
}

const NOT_PAIRED = 'This browser isn’t paired yet. Each browser on your phone (a QR scanner, Safari, Chrome or a Home Screen icon) has its own connection. In the browser where you approved it, choose Move to another browser and type its code here. Or on your computer choose Remote access → Away from home and scan a new QR code.';
const CODE_FAILED = 'That code didn’t work. A code works once, for 5 minutes. Choose Move to another browser again for a new one.';
function askForCode(message = NOT_PAIRED) {
  title.textContent = 'Connect to Codeshi'; code.textContent = ''; note.textContent = message;
  form.hidden = false; submit.disabled = false;
}
function useClient() {
  const authKey = `codeshi:remote-auth:${config.projectId}`;
  client ||= new FirebasePhoneClient(config, { load: () => read(authKey), save: value => write(authKey, value) });
  return client;
}
async function connect(session) {
  if (!/^[a-f0-9]{64}$/.test(session.room || '')) throw Error('Scan a new QR code on your computer.');
  room = session.room; key = await roomKey(session.secret);
  useClient();
  const identity = await client.identity(), meta = await client.request(`rooms/${room}/meta`);
  if (!meta || meta.expiresAt <= Date.now() || meta.peer && meta.peer !== identity.uid) {
    unpair();
    throw Error('This connection expired or was removed. On your computer, choose Remote access → Away from home and scan a new QR code.');
  }
  write(sessionKey, session);
  canWatch = meta.peer === identity.uid;
  if (meta.state === 'waiting') {
    const matchCode = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
    waitingForApproval(matchCode);
    const agent = navigator.userAgent, name = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android phone' : 'Remote phone';
    const result = await request({ kind: 'pair', name, code: matchCode, deviceId: deviceId() });
    if (result?.state === 'active') activate();
  } else {
    watch();
    const result = await request({ kind: 'session' });
    if (result.state === 'active') activate();
    else { title.textContent = 'Allow it on your computer'; code.textContent = result.code || ''; note.textContent = 'Check this number in Codeshi, then choose Allow.'; }
  }
}
// The code only opens a meeting point. The connection's own key arrives sealed with a fresh key exchange.
async function redeem(typed) {
  const handover = normalizeHandoverCode(typed);
  if (!handover) { askForCode('Type the 8 letters and numbers shown under Move to another browser.'); return; }
  form.hidden = true; note.textContent = 'Connecting…';
  let target;
  try {
    const meeting = await handoverMeeting(handover);
    room = meeting.room; key = await roomKey(meeting.secret);
    const meta = await useClient().request(`rooms/${room}/meta`);
    if (!meta || meta.state !== 'waiting' || meta.expiresAt <= Date.now()) throw Error(CODE_FAILED);
    const mine = await handoverKeys(), result = await request({ kind: 'meet', pub: mine.pub });
    target = await open(await handoverShared(mine.privateKey, result.pub, room), room, 'handover', result.box);
  } catch (error) {
    stopWatching?.(); stopWatching = null; canWatch = false; room = null;
    const reach = error?.message === REMOTE_BUSY || /^Can’t reach/.test(error?.message || '');
    askForCode(reach ? error.message : CODE_FAILED); return;
  }
  stopWatching?.(); stopWatching = null; canWatch = false;
  await connect({ room: target.room, secret: target.secret });
}
form.addEventListener('submit', event => {
  event.preventDefault(); submit.disabled = true;
  redeem(field.value).catch(error => { if (!active) askForCode(error.message || CODE_FAILED); });
});

async function start() {
  note.textContent = 'Connecting…';
  config = firebaseConfig(await (await fetch('/remote-config.json', { cache: 'no-store' })).json());
  sessionKey = `codeshi:remote-session:${config.projectId}`;
  const fragment = new URLSearchParams(location.hash.slice(1)).get('remote');
  // A tapped notification opens its workspace (see phone-sw.js).
  const workspace = new URLSearchParams(location.search).get('workspace');
  if (workspace && /^[A-Za-z0-9_-]{1,128}$/.test(workspace)) { try { localStorage.setItem('codeshi:phone-project', workspace); } catch { /* Opens the last workspace instead. */ } }
  history.replaceState(null, '', location.pathname);
  const saved = read(sessionKey), match = fragment?.match(/^([a-f0-9]{64})\.([a-f0-9]{64})$/);
  const session = match ? { room: match[1], secret: match[2] } : saved;
  if (!session) { askForCode(); return; }
  await connect(session);
}
document.addEventListener('visibilitychange', () => {
  if (!client) return;
  if (document.hidden) { stopWatching?.(); stopWatching = null; }
  else { watch(); event('ready'); }
});
window.addEventListener('pagehide', () => { stopWatching?.(); });
window.addEventListener('pageshow', event => { if (event.persisted && client && !document.hidden) watch(); });
start().catch(error => { if (!active) askForCode(error.message || 'Could not connect. Scan a new QR code on your computer.'); });

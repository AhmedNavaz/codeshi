// Replays the same synthetic workload through the real encrypted relay. Default is entirely local.
// --live explicitly uses the configured Firebase pilot, creates temporary anonymous identities, then removes them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FirebasePhoneClient, token, roomKey, seal, open } from '../public/phone-firebase.mjs';
import { TRANSFER_ENCODING, conversationRoute, decodeConversation } from '../public/phone-transfer.mjs';
import { createRemotePhoneAccess } from '../src/phone-remote.mjs';

const live = process.argv.includes('--live');
if (process.argv.slice(2).some(arg => arg !== '--live')) throw Error('Usage: node scripts/measure-phone.mjs [--live]');
const config = JSON.parse(fs.readFileSync(new URL('../remote/firebase-public.json', import.meta.url)));
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const counters = () => ({ uploadBytes: 0, downloadBytes: 0, requests: 0, streams: 0 });
const frame = value => `event: put\ndata: ${JSON.stringify({ path: '/', data: value })}\n\n`;
const wait = async predicate => {
  const end = Date.now() + 20000;
  while (!predicate()) { if (Date.now() > end) throw Error('Measurement response timed out.'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
function memoryClients(silent) {
  const values = new Map(), watches = new Map();
  return uid => ({
    traffic: counters(), async identity() { return { uid }; },
    async request(path, method = 'GET', value) {
      this.traffic.requests++;
      if (method === 'GET') { const result = values.get(path) ?? null; this.traffic.downloadBytes += bytes(result); return result; }
      if (value !== undefined) this.traffic.uploadBytes += bytes(value);
      if (method === 'DELETE') { for (const name of values.keys()) if (name === path || name.startsWith(`${path}/`)) values.delete(name); }
      else values.set(path, value);
      this.traffic.downloadBytes += silent && method !== 'DELETE' ? 0 : bytes(value === undefined ? null : value);
      for (const { client, changed } of watches.get(path) || []) {
        client.traffic.downloadBytes += bytes(frame(value)); queueMicrotask(() => changed(value));
      }
      return null;
    },
    watch(path, changed) {
      this.traffic.requests++; this.traffic.streams++;
      const entry = { client: this, changed }, listeners = watches.get(path) || new Set();
      listeners.add(entry); watches.set(path, listeners);
      const initial = values.get(path) ?? null; this.traffic.downloadBytes += bytes(frame(initial));
      queueMicrotask(() => changed(initial));
      return () => listeners.delete(entry);
    },
    close() { for (const listeners of watches.values()) for (const entry of listeners) if (entry.client === this) listeners.delete(entry); },
  });
}

const UPDATES = 30, CHUNK = 'A measured streaming reply with Unicode café 🐈.\n'.repeat(10);
const projects = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Example workspace ${i}`, available: true,
  folders: [{ id: `folder${i}`, name: 'Source', displayName: 'Source', path: `/synthetic/workspace-${i}/source`, available: true }],
  conversationId: `conversation${i}`, runningConversationId: i === 0 ? 'c' : null, pendingApprovals: 0 }));

async function measure(optimized) {
  const makeMemory = memoryClients(optimized);
  // Preserve the previous client's echoed-write behavior in the baseline, even after silent writes ship.
  const options = optimized ? {} : { fetchImpl: (address, init) => { const url = new URL(address); url.searchParams.delete('print'); return fetch(url.href, init); } };
  const owner = live ? new FirebasePhoneClient(config, options) : makeMemory('computer');
  const phone = live ? new FirebasePhoneClient(config, options) : makeMemory('phone');
  let step = 0, text = CHUNK.repeat(8), first = true, snapshot = null;
  const calls = { conversation: 0, projects: 0 };
  const access = createRemotePhoneAccess({ config, clientFactory: () => owner, local: () => ({ port: 1234 }), handle: (req, res) => {
    const path = new URL(req.url, 'https://phone.local'); let body;
    if (path.pathname === '/api/projects') { calls.projects++; body = projects; }
    else {
      assert.equal(path.pathname, '/api/conversation'); calls.conversation++;
      body = { id: 'c', status: 'running', provider: 'codex', cursor: step, delta: !first, activeRun: { id: 'run', phase: 'working' },
        pendingApprovals: [], messages: [{ id: 'reply', role: 'assistant', text }], step: { id: 'activity', text: 'Writing a reply' } };
      first = false;
    }
    res.writeHead(200); res.end(JSON.stringify(body));
  } });
  let stop;
  try {
    const initial = await access.manage({ action: 'start' }), identity = await phone.identity();
    const [room, secret] = new URLSearchParams(new URL(initial.invite.url).hash.slice(1)).get('remote').split('.'), key = await roomKey(secret);
    const received = new Map();
    const send = async value => {
      const input = { id: token(16), at: Date.now(), ...value };
      await phone.request(`rooms/${room}/request`, 'PUT', { uid: identity.uid, box: await seal(key, room, 'request', input) });
      return input.id;
    };
    await send({ kind: 'pair', code: '123456', name: 'Temporary traffic measurement' });
    await wait(() => access.status().devices[0]?.state === 'pending');
    // The in-process state can change before Firebase commits the matching peer grant.
    while ((await phone.request(`rooms/${room}/meta`))?.peer !== identity.uid) await new Promise(resolve => setTimeout(resolve, 50));
    stop = phone.watch(`rooms/${room}/out`, async box => { if (box) { const value = await open(key, room, 'out', box); if (value.id) received.set(value.id, value); } });
    await access.manage({ action: 'allow', id: room });
    const api = async path => {
      const view = conversationRoute(path), base = snapshot?.base || null;
      const id = await send({ kind: 'api', method: 'GET', path, ...(optimized && view ? { transfer: { encoding: TRANSFER_ENCODING, base } } : {}) });
      await wait(() => received.has(id)); const response = received.get(id); received.delete(id); assert.equal(response.status, 200);
      if (view) {
        let body = response.body;
        if (response.transfer) { const decoded = decodeConversation(body, view, base, snapshot, response.transfer.base); snapshot = decoded.state; body = decoded.body; }
        assert.equal(body.messages[0].text, text, 'Transferred text must exactly match the original.');
      }
    };
    await api('/api/projects'); await api('/api/conversation?projectId=p0&tail=40');
    for (step = 1; step <= UPDATES; step++) {
      text += CHUNK;
      // Identical progress invalidations in both cases. Only the workspace refresh policy and text encoding differ.
      await owner.request(`rooms/${room}/out`, 'PUT', await seal(key, room, 'out', { event: 'update', at: Date.now() }));
      await api(`/api/conversation?projectId=p0&tail=40&since=${step - 1}`);
      if (!optimized || step === UPDATES) await api('/api/projects');
    }
    const sum = field => owner.traffic[field] + phone.traffic[field];
    return { downloadBytes: sum('downloadBytes'), uploadBytes: sum('uploadBytes'), databaseRequests: sum('requests'), streams: sum('streams'), apiRequests: calls };
  } finally {
    stop?.(); await access.close(); phone.close();
    if (live) for (const client of [owner, phone]) if (client.auth?.idToken) {
      const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${config.apiKey}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: client.auth.idToken }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('Could not remove a temporary measurement identity.');
    }
  }
}

const baseline = await measure(false), optimized = await measure(true);
console.log(JSON.stringify({ mode: live ? 'live Firebase pilot' : 'local encrypted relay',
  workload: { progressRefreshes: UPDATES, simulatedSeconds: UPDATES * 2, initialTextBytes: bytes(CHUNK.repeat(8)), appendedTextBytes: bytes(CHUNK) * UPDATES,
    workspaces: projects.length, description: 'One visible phone, streaming reply, workspace metadata refreshed every progress update before and once per minute after. Events run without wall-clock delays.' },
  scope: 'Combined desktop + phone database application bytes, including encrypted JSON, SSE frames and HTTP response bodies. Excludes authentication, Hosting, HTTP headers, TLS and keepalive differences; not Firebase billed usage.',
  baseline, optimized, downloadReductionPercent: Number((100 * (1 - optimized.downloadBytes / baseline.downloadBytes)).toFixed(2)),
}, null, 2));

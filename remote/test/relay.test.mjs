import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRelayServer } from '../../src/server.mjs';
import { scriptCLIs } from '../../test/platform.mjs';
import { FirebasePhoneClient, token, roomKey, seal, open, handoverMeeting, handoverKeys, handoverShared } from '../../public/phone-firebase.mjs';
import { createRemotePhoneAccess } from '../../src/phone-remote.mjs';

const config = { projectId: 'demo-codeshi-phone', apiKey: 'emulator-phone-api-key-only', databaseURL: 'https://demo-codeshi-phone.firebaseio.com', phoneURL: 'https://demo-codeshi-phone.web.app' };
if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('Run this test with Firebase emulators:exec; it never targets a production database.');
const client = () => new FirebasePhoneClient(config, { endpoints: {
  auth: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`,
  refresh: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/securetoken.googleapis.com/v1/token`,
  database: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}`, namespace: 'demo-codeshi-phone-default-rtdb',
} });
const denied = promise => assert.rejects(promise, error => [401, 403].includes(error.status));
const wait = async predicate => { const until = Date.now() + 8000; while (!predicate()) { if (Date.now() > until) throw Error('The encrypted response did not arrive.'); await new Promise(resolve => setTimeout(resolve, 10)); } };

test('real Firebase rules isolate phones, reject malformed packets, and deny access after revocation', async t => {
  const owner = client(), phone = client(), stranger = client();
  t.after(() => { owner.close(); phone.close(); stranger.close(); });
  const [computer, paired, other] = await Promise.all([owner.identity(), phone.identity(), stranger.identity()]);
  const room = token(), path = `rooms/${room}`, key = await roomKey(token());
  const meta = { owner: computer.uid, state: 'waiting', peer: '', expiresAt: Date.now() + 60000 };
  await owner.request(`${path}/meta`, 'PUT', meta);
  t.after(() => owner.request(path, 'DELETE').catch(() => {}));
  await denied(stranger.request('rooms'));
  await denied(stranger.request(path));
  await denied(phone.request(`${path}/meta/state`, 'PUT', 'active'));
  await denied(phone.request(`${path}/request`, 'PUT', { uid: other.uid, box: { iv: 'a'.repeat(16), data: 'x' } }));
  await denied(phone.request(`${path}/request`, 'PUT', { uid: paired.uid, box: { iv: 'bad', data: 'x' } }));
  await phone.request(`${path}/request`, 'PUT', { uid: paired.uid, box: await seal(key, room, 'request', { name: 'My phone' }) });
  await owner.request(`${path}/meta`, 'PUT', { ...meta, state: 'active', peer: paired.uid });
  const box = await seal(key, room, 'out', { privateReply: 'Only my phone knows the QR secret.' });
  await owner.request(`${path}/out`, 'PUT', box);
  assert.deepEqual(await open(key, room, 'out', await phone.request(`${path}/out`)), { privateReply: 'Only my phone knows the QR secret.' });
  await denied(stranger.request(`${path}/out`));
  await denied(stranger.request(`${path}/request`, 'PUT', { uid: other.uid, box }));
  await denied(phone.request(`${path}/out`, 'PUT', box));
  await denied(phone.request(`${path}/meta`, 'PUT', { ...meta, owner: paired.uid, peer: paired.uid, state: 'active' }));
  await owner.request(path, 'DELETE');
  await denied(phone.request(`${path}/out`));
  await denied(phone.request(`${path}/request`, 'PUT', { uid: paired.uid, box }));
});

test('encrypted remote pairing, desktop approval, prompts, cached retries and stop work over Firebase SSE', async t => {
  const owner = client(), phone = client(), calls = [];
  const access = createRemotePhoneAccess({ config, clientFactory: () => owner, local: () => ({ port: 1234, accessToken: 'desktop-only' }), handle: async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({ method: req.method, path: req.url, input: text && JSON.parse(text), phone: req.phoneClient, token: req.headers['x-ai-relay-token'] });
    res.writeHead(200); res.end(JSON.stringify({ accepted: true }));
  } });
  t.after(async () => { await access.close(); phone.close(); });
  const initial = await access.manage({ action: 'start' });
  const [room, secret] = new URLSearchParams(new URL(initial.invite.url).hash.slice(1)).get('remote').split('.');
  const key = await roomKey(secret), identity = await phone.identity();
  let messages = [], streamError = null;
  // The rules start granting read access only once the desktop has claimed this phone identity.
  const watch = () => phone.watch(`rooms/${room}/out`, async box => { if (box) messages.push(await open(key, room, 'out', box)); }, error => { streamError = error; });
  const send = async input => {
    const request = { id: token(16), at: Date.now(), ...input };
    await phone.request(`rooms/${room}/request`, 'PUT', { uid: identity.uid, box: await seal(key, room, 'request', request) });
    return request;
  };
  await send({ kind: 'pair', name: 'Emulated phone', code: '654321' });
  await wait(() => access.status().devices[0]?.state === 'pending');
  assert.equal(access.status().devices[0].code, '654321');
  const stop = watch(); t.after(stop);
  const before = await send({ kind: 'api', method: 'POST', path: '/api/conversations/c/messages', body: { text: 'secret prompt' } });
  await wait(() => messages.some(message => message.id === before.id));
  assert.equal(messages.find(message => message.id === before.id).status, 401); assert.equal(calls.length, 0);
  await access.manage({ action: 'allow', id: room });
  await wait(() => messages.some(message => message.state === 'active'));
  const prompt = await send({ kind: 'api', method: 'POST', path: '/api/conversations/c/messages?projectId=p', body: { text: 'secret prompt', requestId: 'prompt-1' } });
  await wait(() => messages.some(message => message.id === prompt.id));
  assert.equal(calls.length, 1); assert.equal(calls[0].input.text, 'secret prompt'); assert.equal(calls[0].phone, true);
  assert.equal(calls[0].token, 'desktop-only');
  await phone.request(`rooms/${room}/request`, 'PUT', { uid: identity.uid, box: await seal(key, room, 'request', prompt) });
  await wait(() => messages.filter(message => message.id === prompt.id).length > 1);
  assert.equal(calls.length, 1, 'Firebase reconnects cannot repeat the local action.');
  const stopped = await send({ kind: 'api', method: 'POST', path: '/api/conversations/c/stop', body: {} });
  await wait(() => messages.some(message => message.id === stopped.id));
  assert.equal(calls.at(-1).path, '/api/conversations/c/stop');
  assert.equal(streamError, null);
  await access.manage({ action: 'revoke', id: room });
  await denied(phone.request(`rooms/${room}/request`, 'PUT', { uid: identity.uid, box: await seal(key, room, 'request', stopped) }));
});

test('a typed code moves a connection to a Home Screen icon under the real rules (#115)', async t => {
  const owner = client(), phone = client(), icon = client(), stranger = client();
  const access = createRemotePhoneAccess({ config, clientFactory: () => owner, local: () => ({ port: 1234, accessToken: 'desktop-only' }), handle: async (req, res) => { res.writeHead(200); res.end('{"ok":true}'); } });
  t.after(async () => { await access.close(); phone.close(); icon.close(); stranger.close(); });
  const initial = await access.manage({ action: 'start' });
  const [room, secret] = new URLSearchParams(new URL(initial.invite.url).hash.slice(1)).get('remote').split('.');
  const exchange = async (who, target, key, input) => {
    const uid = (await who.identity()).uid, request = { id: token(16), at: Date.now(), ...input };
    await who.request(`rooms/${target}/request`, 'PUT', { uid, box: await seal(key, target, 'request', request) });
    let reply = null; const until = Date.now() + 8000;
    while (!reply && Date.now() < until) {
      const meta = await who.request(`rooms/${target}/meta`);
      if (meta?.peer === uid) { const out = await who.request(`rooms/${target}/out`).catch(() => null); const value = out && await open(key, target, 'out', out).catch(() => null); if (value?.id === request.id) reply = value; }
      if (!reply) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!reply) throw Error('The encrypted response did not arrive.');
    return reply;
  };
  const key = await roomKey(secret);
  await exchange(phone, room, key, { kind: 'pair', name: 'Scanner browser', code: '654321' }).catch(() => {});
  await wait(() => access.status().devices[0]?.state === 'pending');
  await access.manage({ action: 'allow', id: room });
  const handover = await exchange(phone, room, key, { kind: 'handover' });
  assert.match(handover.body.code, /^[0-9A-Z]{8}$/);

  const meeting = await handoverMeeting(handover.body.code), meetingKey = await roomKey(meeting.secret);
  assert.equal((await icon.request(`rooms/${meeting.room}/meta`)).state, 'waiting', 'A new icon can find the meeting point from the code alone.');
  const mine = await handoverKeys();
  const answer = await exchange(icon, meeting.room, meetingKey, { kind: 'meet', pub: mine.pub });
  await denied(stranger.request(`rooms/${meeting.room}/out`));
  const moved = await open(await handoverShared(mine.privateKey, answer.pub, meeting.room), meeting.room, 'handover', answer.box);
  const joined = await exchange(icon, moved.room, await roomKey(moved.secret), { kind: 'pair', name: 'iPhone', code: '111222' });
  assert.equal(joined.state, 'active', 'The icon joins without another approval on the computer.');
  assert.deepEqual(access.status().devices.map(device => device.id), [moved.room]);
  assert.equal(await icon.request(`rooms/${meeting.room}/meta`), null, 'The meeting point is gone once used.');
  await denied(phone.request(`rooms/${room}/out`));
});

test('a remote prompt and agent approval reach the desktop conversation through the real server and worker', { skip: scriptCLIs }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-remote-worker-'))), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const cli = path.join(root, 'gemini.mjs');
  fs.writeFileSync(cli, `#!${process.execPath}
import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const send=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));let prompt;
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')send({id:m.id,result:{sessionId:'remote-run',models:{currentModelId:'m'}}});
if(m.method==='session/prompt'){prompt=m.id;send({id:77,method:'session/request_permission',params:{sessionId:'remote-run',toolCall:{toolCallId:'edit',title:'Create a file',kind:'execute',rawInput:{command:'touch remote-test.txt'}},options:[{optionId:'once',kind:'allow_once',name:'Allow'},{optionId:'no',kind:'reject_once',name:'Reject'}]}});}
if(m.id===77&&!m.method){send({method:'session/update',params:{sessionId:'remote-run',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Remote approval received.'}}}});send({id:prompt,result:{stopReason:'end_turn'}});}}
`, { mode: 0o700 });
  const owner = client(), phone = client();
  const app = createRelayServer({ workspace, dataRoot: path.join(root, 'data'), accessToken: 'desktop-token', lock: false, bins: { gemini: cli }, phoneOptions: { remoteConfig: config, remoteClientFactory: () => owner } });
  t.after(async () => { await app.close({ force: true }); phone.close(); fs.rmSync(root, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const desktop = `http://127.0.0.1:${app.server.address().port}`;
  const manage = async input => {
    const response = await fetch(`${desktop}/api/phone`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1', 'X-AI-Relay-Token': 'desktop-token', Origin: desktop }, body: JSON.stringify({ ...input, connection: 'remote' }) });
    assert.equal(response.status, 200); return (await response.json()).remote;
  };
  const state = await manage({ action: 'start' }), identity = await phone.identity();
  const [room, secret] = new URLSearchParams(new URL(state.invite.url).hash.slice(1)).get('remote').split('.'), key = await roomKey(secret);
  const send = async value => {
    const request = { id: token(16), at: Date.now(), ...value };
    await phone.request(`rooms/${room}/request`, 'PUT', { uid: identity.uid, box: await seal(key, room, 'request', request) }); return request.id;
  };
  await send({ kind: 'pair', name: 'Real worker phone', code: '112233' });
  const readState = async () => (await (await fetch(`${desktop}/api/phone`, { headers: { 'X-AI-Relay-Token': 'desktop-token' } })).json()).remote;
  for (let i = 0; i < 100 && !(await readState()).devices.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await manage({ action: 'allow', id: room });
  const messages = new Map(), stop = phone.watch(`rooms/${room}/out`, async box => { if (box) { const value = await open(key, room, 'out', box); if (value.id) messages.set(value.id, value); } }); t.after(stop);
  const api = async (method, path, body) => { const id = await send({ kind: 'api', method, path, body }); await wait(() => messages.has(id)); return messages.get(id); };
  const projects = (await api('GET', '/api/projects')).body, projectId = projects[0].id;
  const conversation = (await api('GET', `/api/conversation?projectId=${projectId}`)).body;
  const started = await api('POST', `/api/conversations/${conversation.id}/messages?projectId=${projectId}`, { text: 'Check remote approvals', provider: 'gemini', model: 'm', mode: 'edit', approvalPolicy: 'ask', requestId: 'remote-approval-test' });
  assert.equal(started.status, 202);
  const broker = app.registry.broker(projectId), run = broker.running;
  await wait(() => run.approvals.size);
  const approval = [...run.approvals.values()][0], input = { runId: run.id, approvalId: approval.id, allow: true };
  assert.equal((await api('POST', `/api/conversations/${conversation.id}/approval?projectId=${projectId}`, input)).status, 200);
  await run.done;
  assert.equal((await api('POST', `/api/conversations/${conversation.id}/approval?projectId=${projectId}`, input)).status, 409);
  const saved = (await api('GET', `/api/conversation?projectId=${projectId}`)).body;
  assert.ok(saved.messages.some(message => message.text === 'Remote approval received.'));
});

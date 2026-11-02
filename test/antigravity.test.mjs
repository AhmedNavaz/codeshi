import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { antigravityInvocation, configureAntigravitySession, googleMetadata, connectGoogle, closeGoogleConnections, verifyAntigravity } from '../src/antigravity.mjs';
import { installAntigravity, googleRuntimePath } from '../src/antigravity-install.mjs';
import { resolveBinary } from '../src/resolve-binary.mjs';
import { runGemini } from '../src/gemini.mjs';
import { Broker } from '../src/broker.mjs';

const initialized = { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.5' }, authMethods: [{ id: 'oauth-personal' }], agentCapabilities: { promptCapabilities: { image: true } } };
const session = () => ({ sessionId: 'google-session', _meta: { antigravity: { tier: { id: 'personal-free', name: 'Google account' } } }, configOptions: [{ id: 'mode', currentValue: 'auto_edit', options: [{ value: 'default' }, { value: 'auto_edit' }, { value: 'yolo' }] }, { id: 'model', currentValue: 'native-default', options: [{ name: 'Current models', options: [{ value: 'native-default', name: 'Provider default' }, { value: 'native-alternative', name: 'Alternative' }] }] }, { id: 'thinking_level', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }] });
function folder(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-google-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
class Client extends EventEmitter {
  requests = []; replies = []; pending = new Map(); state = session();
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'initialize') return initialized;
    if (method === 'session/new') { if (this.signedOut) throw new Error('Authentication required'); return this.state; }
    if (method === 'session/set_config_option') { this.state.configOptions.find(row => row.id === params.configId).currentValue = params.value; return { configOptions: this.state.configOptions }; }
    if (method === 'authenticate') { this.emit('diagnostic', 'Open https://accounts.google.com/o/oauth2/auth?client_id=official-client\n'); return this.authentication; }
    if (method === 'session/prompt') { await this.prompt?.(); this.emit('message', { method: 'session/update', params: { sessionId: this.state.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Completed' } } } }); return { stopReason: 'end_turn' }; }
    throw new Error('Unexpected method: ' + method);
  }
  rpc(params) { return new Promise(resolve => { this.pending.set(42, resolve); this.emit('message', { id: 42, method: 'session/request_permission', params: { sessionId: this.state.sessionId, ...params } }); }); }
  send(message) { this.replies.push(message); this.pending.get(message.id)?.(message); }
  close() { this.closed = true; }
}
test('Google setup isolates native configuration, rejects unsupported scopes and removes ambient billing/bypass variables', t => {
  const root = folder(t), bin = path.join(root, 'agy_acp_server.par');
  const previous = process.env.AGY_ACP_DISABLE_WORKSPACE_TRUST; process.env.AGY_ACP_DISABLE_WORKSPACE_TRUST = '1';
  try {
    const options = antigravityInvocation({ bin, googleRoot: root, workspace: root, mode: 'edit' });
    assert.equal(options.env.GEMINI_HOME, path.join(root, 'profile')); assert.equal(options.env.ANTIGRAVITY_HARNESS_PATH, path.join(root, process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external')); assert.equal(options.env.AGY_ACP_DISABLE_WORKSPACE_TRUST, undefined);
    assert.equal(options.env.GOOGLE_API_KEY, undefined); assert.equal(options.env.GEMINI_API_KEY, undefined);
    assert.throws(() => antigravityInvocation({ bin, googleRoot: root, mode: 'read' }), /verified read-only/);
    assert.throws(() => antigravityInvocation({ bin, googleRoot: root, workspace: root, workspaces: [path.join(root, 'other')], mode: 'edit' }), /one project folder/);
  } finally { if (previous === undefined) delete process.env.AGY_ACP_DISABLE_WORKSPACE_TRUST; else process.env.AGY_ACP_DISABLE_WORKSPACE_TRUST = previous; }
  for (const version of ['0.99.0', '1.0.0', '1.4.4']) assert.throws(() => verifyAntigravity({ ...initialized, agentInfo: { ...initialized.agentInfo, version } }), /1.4.5/);
});
test('Antigravity selects and confirms default approvals, current account model and effort before prompting', async () => {
  const client = new Client(); await configureAntigravitySession(client, client.state, { model: 'native-alternative', effort: 'high' });
  assert.deepEqual(client.requests.map(row => row.params), [ { sessionId: 'google-session', configId: 'mode', value: 'default' }, { sessionId: 'google-session', configId: 'model', value: 'native-alternative' }, { sessionId: 'google-session', configId: 'thinking_level', value: 'high' } ]);
  await assert.rejects(configureAntigravitySession(client, client.state, { model: 'invented-model' }), /does not offer/);
  const missing = new Client(); missing.state.configOptions = [];
  await assert.rejects(configureAntigravitySession(missing, missing.state, {}), /does not offer/);
  const liar = new Client(); liar.request = async () => ({ configOptions: session().configOptions });
  await assert.rejects(configureAntigravitySession(liar, liar.state, {}), /did not confirm/);
});
test('Google account and model discovery uses native session metadata without a prompt or cached email inference', async t => {
  const root = folder(t), options = { bin: path.join(root, 'agy_acp_server.par'), googleRoot: root };
  const client = new Client(), result = await googleMetadata(options, () => client);
  assert.equal(result.authenticated, true); assert.equal(result.billingSource, 'subscription'); assert.equal(result.models[1].id, 'native-alternative'); assert.equal(result.models[0].supportedReasoningEfforts[1].reasoningEffort, 'high');
  assert.deepEqual(client.requests.map(row => row.method), ['initialize', 'session/new']); assert(client.closed);
  const unknownTier = new Client(); delete unknownTier.state._meta;
  assert.equal((await googleMetadata(options, () => unknownTier)).billingSource, 'unknown');
  const signedOut = new Client(); signedOut.signedOut = true;
  const missing = await googleMetadata(options, () => signedOut); assert.equal(missing.authenticated, false); assert.deepEqual(missing.models, []);
});
test('Google sign-in uses explicit native personal OAuth and reuses an active flow', async t => {
  const root = folder(t), client = new Client(); let finish; client.authentication = new Promise(resolve => { finish = resolve; }); t.after(closeGoogleConnections);
  const options = { bin: path.join(root, 'agy_acp_server.par'), googleRoot: root };
  const login = await connectGoogle(options, () => client); assert.match(login.authUrl, /^https:\/\/accounts\.google\.com\//); assert.equal(login.started, true);
  assert.equal((await connectGoogle(options, () => { throw new Error('Duplicate login'); })).started, true);
  assert.deepEqual(client.requests.at(-1), { method: 'authenticate', params: { methodId: 'oauth-personal' } }); finish({}); await new Promise(resolve => setImmediate(resolve)); assert(client.closed);
});
test('Antigravity coding streams through ACP, grants only one action and never answers interaction questions as approvals', async t => {
  const root = folder(t);
  for (const question of [false, true]) {
    const client = new Client(), events = []; let calls = 0;
    client.prompt = async () => {
      const reply = await client.rpc({ toolCall: { toolCallId: question ? 'interaction_question' : 'command_1', kind: 'execute', title: 'Run tests' }, options: [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' }] });
      if (question) assert(reply.error); else assert.equal(reply.result.outcome.optionId, 'once');
    };
    const run = runGemini({ bin: path.join(root, 'agy_acp_server.par'), googleRoot: root, workspace: root, mode: 'edit', model: 'native-alternative', effort: 'high', prompt: 'Continue project' }, { clientFactory: () => client, event: event => events.push(event), metadata() {}, approval: async () => { calls++; return true; } });
    if (question) { await assert.rejects(run, /denied or unsupported/); assert.equal(calls, 0); } else { await run; assert.equal(calls, 1); assert.equal(events.at(-1).type, 'turn.completed'); }
    assert(client.closed);
  }
});
test('Antigravity runtime installation fails checksum verification before extraction and rejects unsupported platforms', async t => {
  const root = folder(t); let extracted = false;
  await assert.rejects(installAntigravity(root, { platform: 'darwin', arch: 'arm64', fetchImpl: async url => { assert.match(url, /^https:\/\/dl\.google\.com\//); return new Response('untrusted archive'); }, spawnImpl: () => { extracted = true; } }), /checksum/);
  assert.equal(extracted, false); assert(!fs.existsSync(googleRuntimePath(root))); assert.deepEqual(fs.readdirSync(path.join(root, 'runtime')), []);
  await assert.rejects(installAntigravity(root, { platform: 'unsupported', arch: 'unknown' }), /Automatic Antigravity/);
});
test('the installed Google ACP runtime takes priority while explicit Gemini API/enterprise overrides remain respected', t => {
  const root = folder(t), bin = googleRuntimePath(root); fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(resolveBinary('gemini', { googleRoot: root }), bin);
  assert.equal(resolveBinary('gemini', { googleRoot: root, override: '/explicit/gemini' }), '/explicit/gemini');
});
test('the Antigravity worker preserves project history and model metadata across a real IPC approval round trip', { skip: scriptCLIs }, async t => {
  const root = folder(t), bin = googleRuntimePath(root), protocol = path.join(root, 'protocol.mjs'), state = session(); fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(protocol, `#!${process.execPath}
import readline from 'node:readline';
const initialized=${JSON.stringify(initialized)},session=${JSON.stringify(state)},send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));let prompt;
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:initialized});
if(m.method==='session/new')send({id:m.id,result:session});
if(m.method==='session/set_config_option'){session.configOptions.find(o=>o.id===m.params.configId).currentValue=m.params.value;send({id:m.id,result:{configOptions:session.configOptions}});}
if(m.method==='session/prompt'){prompt=m.id;send({id:100,method:'session/request_permission',params:{sessionId:session.sessionId,toolCall:{toolCallId:'command_1',kind:'execute',title:'Run tests',rawInput:{command:'npm test'}},options:[{kind:'allow_once',optionId:'once'}]}});}
if(m.id===100&&m.result?.outcome?.optionId==='once'){send({method:'session/update',params:{sessionId:session.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Google completed the task.'}}}});send({id:prompt,result:{stopReason:'end_turn'}});}}
`, { mode: 0o700 });
  fs.symlinkSync(protocol, bin);
  const broker = new Broker({ workspace: root, dataDir: path.join(root, 'journal'), googleRoot: root, bins: { gemini: bin } }); t.after(() => broker.close());
  const conversation = broker.get(broker.create().id); broker.message(conversation, 'assistant', 'Earlier project context', 'claude');
  assert.throws(() => broker.start(conversation, { text: 'Read only', provider: 'gemini', mode: 'read' }), /verified read-only/); assert.equal(conversation.messages.length, 1);
  broker.start(conversation, { text: 'Continue', provider: 'gemini', mode: 'edit', model: 'native-alternative', effort: 'high', requestId: 'google-ipc-test' });
  const deadline = Date.now() + 10000;
  while (!broker.running?.approvals.size && broker.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const run = broker.running; assert(run?.approvals.size, JSON.stringify(conversation.messages.slice(-3))); const request = [...run.approvals.values()][0]; assert.equal(request.input.command, 'npm test'); broker.approve(run.id, request.id, true); await run.done;
  assert.equal(conversation.status, 'complete'); assert.equal(conversation.lastRun.effectiveModel, 'native-alternative'); assert.equal(conversation.lastRun.effectiveEffort, 'high'); assert(conversation.messages.some(message => message.text === 'Google completed the task.')); assert.equal(conversation.sessions.gemini, undefined);
});

test('a Google network failure is reported as one, not as the runtime’s bare internal error', async t => {
  const root = folder(t), options = { bin: path.join(root, 'agy_acp_server.par'), googleRoot: root, relay: null };
  const unreachable = new Client(); unreachable.request = async function (method) {
    if (method === 'initialize') return initialized;
    this.emit('diagnostic', 'CCPAConnectionError: Network connection failed to CCPA API: EOF occurred in violation of protocol\n');
    throw new Error('Internal error');
  };
  await assert.rejects(googleMetadata(options, () => unreachable), error => /could not reach Google/.test(error.message) && error.category === 'network');
  const broken = new Client(); broken.request = async method => { if (method === 'initialize') return initialized; throw new Error('Internal error'); };
  await assert.rejects(googleMetadata(options, () => broken), /^Error: Internal error$/, 'Other failures keep their own message.');
});

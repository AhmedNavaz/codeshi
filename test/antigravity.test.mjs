import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { antigravityInvocation, antigravitySessionParams, configureAntigravitySession, googleMetadata, connectGoogle, closeGoogleConnections, verifyAntigravity } from '../src/antigravity.mjs';
import { installAntigravity, googleRuntimePath } from '../src/antigravity-install.mjs';
import { resolveBinary } from '../src/resolve-binary.mjs';
import { runGemini } from '../src/gemini.mjs';
import { Broker } from '../src/broker.mjs';

const initialized = { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.5' }, authMethods: [{ id: 'oauth-personal' }], agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { additionalDirectories: {} } } };
const session = () => ({ sessionId: 'google-session', _meta: { antigravity: { tier: { id: 'personal-free', name: 'Google account' } } }, configOptions: [{ id: 'mode', currentValue: 'auto_edit', options: [{ value: 'default' }, { value: 'auto_edit' }, { value: 'yolo' }] }, { id: 'model', currentValue: 'native-default', options: [{ name: 'Current models', options: [{ value: 'native-default', name: 'Provider default' }, { value: 'native-alternative', name: 'Alternative' }] }] }, { id: 'thinking_level', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }] });
function folder(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-google-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
class Client extends EventEmitter {
  requests = []; replies = []; pending = new Map(); state = session();
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'initialize') return this.initialized || initialized;
    if (method === 'session/new') { if (this.signedOut) throw new Error('Authentication required'); return this.state; }
    if (method === 'session/set_config_option') { if (params.sessionId !== this.state.sessionId) throw new Error('Invalid params'); this.state.configOptions.find(row => row.id === params.configId).currentValue = params.value; return { configOptions: this.state.configOptions }; }
    if (method === 'authenticate') { this.emit('diagnostic', 'Open https://accounts.google.com/o/oauth2/auth?client_id=official-client\n'); return this.authentication; }
    if (method === 'session/prompt') { await this.prompt?.(); this.emit('message', { method: 'session/update', params: { sessionId: this.state.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Completed' } } } }); return { stopReason: 'end_turn' }; }
    throw new Error('Unexpected method: ' + method);
  }
  rpc(params, method = 'session/request_permission') { return new Promise(resolve => { this.pending.set(42, resolve); this.emit('message', { id: 42, method, params: { sessionId: this.state.sessionId, ...params } }); }); }
  send(message) { this.replies.push(message); this.pending.get(message.id)?.(message); }
  close() { this.closed = true; }
}
test('Google setup isolates native configuration, negotiates folder scope and removes ambient billing/bypass variables', t => {
  const root = folder(t), bin = path.join(root, 'agy_acp_server.par');
  const previous = process.env.AGY_ACP_DISABLE_WORKSPACE_TRUST; process.env.AGY_ACP_DISABLE_WORKSPACE_TRUST = '1';
  try {
    const options = antigravityInvocation({ bin, googleRoot: root, workspace: root, mode: 'edit' });
    assert.equal(options.env.GEMINI_HOME, path.join(root, 'profile')); assert.equal(options.env.ANTIGRAVITY_HARNESS_PATH, path.join(root, process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external')); assert.equal(options.env.AGY_ACP_DISABLE_WORKSPACE_TRUST, undefined);
    assert.equal(options.env.GOOGLE_API_KEY, undefined); assert.equal(options.env.GEMINI_API_KEY, undefined);
    assert.throws(() => antigravityInvocation({ bin, googleRoot: root, mode: 'read' }), /verified read-only/);
    assert.deepEqual(antigravitySessionParams(initialized, { workspace: root, workspaces: [root, path.join(root, 'other'), path.join(root, 'other')] }), { cwd: root, additionalDirectories: [path.join(root, 'other')], mcpServers: [] });
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
  assert.equal(result.capabilities.additionalDirectories, true);
  assert.deepEqual(client.requests.map(row => row.method), ['initialize', 'session/new']); assert(client.closed);
  const unknownTier = new Client(); delete unknownTier.state._meta;
  assert.equal((await googleMetadata(options, () => unknownTier)).billingSource, 'unknown');
  const signedOut = new Client(); signedOut.signedOut = true;
  const missing = await googleMetadata(options, () => signedOut); assert.equal(missing.authenticated, false); assert.deepEqual(missing.models, []);
  assert.equal(missing.capabilities.additionalDirectories, true, 'Folder support comes from the handshake, even before sign-in.');
});

test('Antigravity negotiates all workspace roots and bounds client file operations to them', async t => {
  const root = fs.realpathSync(folder(t)), first = path.join(root, 'first'), second = path.join(root, 'second'), outside = path.join(root, 'outside');
  for (const directory of [first, second, outside]) { fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'same.txt'), path.basename(directory)); }
  const config = { bin: path.join(root, 'agy_acp_server.par'), googleRoot: root, workspace: first, workspaces: [first, second, second], mode: 'edit', prompt: 'Update both folders', relay: null };
  const client = new Client(), approved = [];
  client.prompt = async () => {
    for (const directory of [first, second]) {
      const file = path.join(directory, 'same.txt');
      const read = await client.rpc({ path: file }, 'fs/read_text_file');
      assert.equal(read.result.content, path.basename(directory));
      assert.deepEqual((await client.rpc({ path: file, content: 'Updated ' + path.basename(directory) }, 'fs/write_text_file')).result, {});
    }
    for (const method of ['fs/read_text_file', 'fs/write_text_file']) {
      const result = await client.rpc({ path: path.join(outside, 'same.txt'), content: 'Wrong folder' }, method);
      assert.match(result.error.message, /outside this workspace/);
    }
  };
  await assert.rejects(runGemini(config, { clientFactory: () => client, event() {}, metadata() {}, approval: async request => { approved.push(request.input.path); return true; } }), /denied or unsupported/);
  assert.deepEqual(client.requests.find(row => row.method === 'session/new').params, { cwd: first, additionalDirectories: [second], mcpServers: [] });
  assert.deepEqual(approved, [path.join(first, 'same.txt'), path.join(second, 'same.txt')]);
  assert.equal(fs.readFileSync(path.join(first, 'same.txt'), 'utf8'), 'Updated first');
  assert.equal(fs.readFileSync(path.join(second, 'same.txt'), 'utf8'), 'Updated second');
  assert.equal(fs.readFileSync(path.join(outside, 'same.txt'), 'utf8'), 'outside');
  assert(client.closed);
});

test('Antigravity without additional-directory support rejects multiple roots before creating a session or prompting', async t => {
  const root = folder(t), client = new Client();
  client.initialized = { ...initialized, agentCapabilities: {} };
  await assert.rejects(runGemini({ bin: path.join(root, 'agy_acp_server.par'), googleRoot: root, workspace: root, workspaces: [path.join(root, 'second')], mode: 'edit', prompt: 'Continue', relay: null }, { clientFactory: () => client, event() {}, metadata() {}, approval: async () => true }), error => /does not support additional workspace folders/.test(error.message) && error.details?.folderChoice);
  assert.deepEqual(client.requests.map(row => row.method), ['initialize']);
  assert(client.closed);
  assert.deepEqual(antigravitySessionParams(client.initialized, { workspace: root }), { cwd: root, mcpServers: [] });
  const metadataClient = new Client(); metadataClient.initialized = client.initialized;
  const result = await googleMetadata({ bin: path.join(root, 'agy_acp_server.par'), googleRoot: root, relay: null }, () => metadataClient);
  assert.equal(result.capabilities.additionalDirectories, false);
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
  assert.equal(resolveBinary('gemini', { googleRoot: root, env: {} }), bin);
  assert.equal(resolveBinary('gemini', { googleRoot: root, env: {}, override: '/explicit/gemini' }), '/explicit/gemini');
});
test('the Antigravity worker edits both workspace folders, preserves chat and scope after restart, and supports Undo', { skip: scriptCLIs }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-google-workspace-'))), bin = googleRuntimePath(root), protocol = path.join(root, 'protocol.mjs'), captured = path.join(root, 'captured.json'), state = session(); fs.mkdirSync(path.dirname(bin), { recursive: true });
  const folders = ['first', 'second'].map(id => ({ id, name: id, path: path.join(root, id) }));
  for (const folder of folders) { fs.mkdirSync(folder.path); fs.writeFileSync(path.join(folder.path, 'same.txt'), folder.id); }
  fs.writeFileSync(path.join(root, 'outside.txt'), 'Unrelated work');
  fs.writeFileSync(protocol, `#!${process.execPath}
import readline from 'node:readline';
import fs from 'node:fs';
const initialized=${JSON.stringify(initialized)},session=${JSON.stringify(state)},send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));let prompt;
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:initialized});
if(m.method==='session/new'){fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify(m.params));send({id:m.id,result:session});}
if(m.method==='session/set_config_option'){session.configOptions.find(o=>o.id===m.params.configId).currentValue=m.params.value;send({id:m.id,result:{configOptions:session.configOptions}});}
if(m.method==='session/prompt'){prompt=m.id;send({id:100,method:'session/request_permission',params:{sessionId:session.sessionId,toolCall:{toolCallId:'command_1',kind:'execute',title:'Run tests',rawInput:{command:'npm test'}},options:[{kind:'allow_once',optionId:'once'}]}});}
if(m.id===100&&m.result?.outcome?.optionId==='once')send({id:101,method:'fs/write_text_file',params:{sessionId:session.sessionId,path:${JSON.stringify(path.join(folders[0].path, 'same.txt'))},content:'Updated first'}});
if(m.id===101&&m.result)send({id:102,method:'fs/write_text_file',params:{sessionId:session.sessionId,path:${JSON.stringify(path.join(folders[1].path, 'same.txt'))},content:'Updated second'}});
if(m.id===102&&m.result){send({method:'session/update',params:{sessionId:session.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Google completed the task.'}}}});send({id:prompt,result:{stopReason:'end_turn'}});}}
`, { mode: 0o700 });
  fs.symlinkSync(protocol, bin);
  const open = () => new Broker({ workspace: folders[0].path, workspaceFolders: folders, dataDir: path.join(root, 'journal'), googleRoot: root, bins: { gemini: bin } });
  let broker = open(); t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = broker.get(broker.create().id); broker.message(conversation, 'assistant', 'Earlier project context', 'claude');
  assert.throws(() => broker.start(conversation, { text: 'Read only', provider: 'gemini', mode: 'read' }), /verified read-only/); assert.equal(conversation.messages.length, 1);
  broker.start(conversation, { text: 'Continue', provider: 'gemini', mode: 'edit', model: 'native-alternative', effort: 'high', requestId: 'google-ipc-test' });
  const run = broker.running, approvals = [], deadline = Date.now() + 15000;
  while (broker.running && Date.now() < deadline) {
    for (const request of [...run.approvals.values()]) { approvals.push(request.input); broker.approve(run.id, request.id, true); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(broker.running, null, 'The worker finishes after the one-time approvals.');
  await run.done; await broker.checkpoints.idle();
  assert.equal(approvals[0].command, 'npm test');
  assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')), { cwd: folders[0].path, additionalDirectories: [folders[1].path], mcpServers: [] });
  for (const folder of folders) assert.equal(fs.readFileSync(path.join(folder.path, 'same.txt'), 'utf8'), 'Updated ' + folder.id);
  assert.equal(conversation.status, 'complete'); assert.equal(conversation.lastRun.effectiveModel, 'native-alternative'); assert.equal(conversation.lastRun.effectiveEffort, 'high'); assert(conversation.messages.some(message => message.text === 'Google completed the task.')); assert.equal(conversation.sessions.gemini, undefined);
  await broker.close(); broker = open();
  const restored = broker.get(conversation.id);
  assert(restored.messages.some(message => message.text === 'Earlier project context'));
  assert.deepEqual(restored.lastRun.baseline.folders.map(folder => folder.id), ['first', 'second']);
  const preview = await broker.checkpoints.preview(restored, { kind: 'run', id: run.id });
  assert.deepEqual(preview.files.map(file => [file.folderId, file.path]).sort(), [['first', 'same.txt'], ['second', 'same.txt']]);
  await broker.checkpoints.apply(restored, preview.target, preview.digest);
  for (const folder of folders) assert.equal(fs.readFileSync(path.join(folder.path, 'same.txt'), 'utf8'), folder.id);
  assert.equal(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), 'Unrelated work');
});

test('the Antigravity worker continues its own session between messages, and starts over when the runtime no longer has it', { skip: scriptCLIs }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-google-session-'))), bin = googleRuntimePath(root), protocol = path.join(root, 'protocol.mjs'), log = path.join(root, 'log.jsonl'), lost = path.join(root, 'lost'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.mkdirSync(workspace);
  const resumable = { ...initialized, agentCapabilities: { ...initialized.agentCapabilities, loadSession: true, sessionCapabilities: { additionalDirectories: {}, resume: {} } } };
  fs.writeFileSync(protocol, `#!${process.execPath}
import readline from 'node:readline';
import fs from 'node:fs';
const initialized=${JSON.stringify(resumable)},session=${JSON.stringify(session())},send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m})),log=m=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
const opened=()=>{try{return fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(l=>l.includes('"session/new"')).length;}catch{return 0;}};
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:initialized});
if(m.method==='session/new'){session.sessionId='google-session-'+(opened()+1);log({method:m.method,params:m.params});send({id:m.id,result:session});}
if(m.method==='session/resume'){log({method:m.method,params:m.params});if(fs.existsSync(${JSON.stringify(lost)})){send({id:m.id,error:{code:-32000,message:'Session not found in the current GEMINI_HOME'}});continue;}session.sessionId=m.params.sessionId;const {sessionId,...rest}=session;send({id:m.id,result:rest});}
if(m.method==='session/set_config_option'){if(m.params.sessionId!==session.sessionId){send({id:m.id,error:{code:-32602,message:'Invalid params'}});continue;}session.configOptions.find(o=>o.id===m.params.configId).currentValue=m.params.value;send({id:m.id,result:{configOptions:session.configOptions}});}
if(m.method==='session/prompt'){log({method:m.method,sessionId:m.params.sessionId,prompt:m.params.prompt[0].text});send({method:'session/update',params:{sessionId:session.sessionId,update:{sessionUpdate:'usage_update',used:13550,size:1048576}}});send({method:'session/update',params:{sessionId:session.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done with '+m.params.sessionId}}}});send({id:m.id,result:{stopReason:'end_turn',usage:{totalTokens:130,inputTokens:100,outputTokens:20,thoughtTokens:10,cachedReadTokens:60,cachedWriteTokens:0}}});}}
`, { mode: 0o700 });
  fs.symlinkSync(protocol, bin);
  const open = () => new Broker({ workspace, dataDir: path.join(root, 'journal'), googleRoot: root, bins: { gemini: bin } });
  let broker = open(); t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id);
  const send = async (text, options = {}) => { broker.start(c, { text, provider: 'gemini', mode: 'edit', model: 'native-alternative', effort: 'medium', requestId: text.toLowerCase().replace(/\s+/g, '-'), ...options }); await broker.running.done; await broker.checkpoints.idle(); };
  const logged = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const envelope = entry => JSON.parse(entry.prompt.slice(entry.prompt.indexOf('\n') + 1));
  await send('First task');
  assert.equal(c.status, 'complete'); assert.equal(c.sessions.gemini.id, 'google-session-1'); assert.equal(c.lastRun.context.sessionMode, 'fresh');
  assert.deepEqual([c.lastRun.usageMeasured.input, c.lastRun.usageMeasured.output, c.lastRun.usageMeasured.reasoning], [100, 20, 10], 'The turn\'s own usage is recorded.');
  assert.deepEqual([c.lastRun.contextUsage.used, c.lastRun.contextUsage.capacity], [13550, 1048576], 'The runtime\'s context reading is kept apart from usage.');
  await send('Second task', { effort: 'high' });
  assert.equal(c.status, 'complete'); assert.equal(c.sessions.gemini.id, 'google-session-1');
  assert.deepEqual([c.lastRun.context.sessionMode, c.lastRun.context.sessionReason, c.lastRun.effectiveEffort], ['resumed', 'same-agent-continuation', 'high']);
  const second = logged().filter(entry => entry.method === 'session/resume' || entry.method === 'session/prompt');
  assert.deepEqual(second.at(-2), { method: 'session/resume', params: { sessionId: 'google-session-1', cwd: workspace, mcpServers: [] } });
  assert.equal(second.at(-1).sessionId, 'google-session-1');
  const continued = envelope(second.at(-1));
  assert.equal(continued.continuation.sessionMode, 'resumed'); assert.equal(continued.currentRequest, 'Second task');
  assert(!continued.context.some(item => item.text === 'First task'), 'The session already holds the first task.');
  assert(c.messages.some(message => message.text === 'Done with google-session-1' && message.runId === c.lastRun.id));
  // The runtime no longer has the session: the run fails, says so, and the next message starts over with a task brief.
  fs.writeFileSync(lost, '');
  await send('Third task');
  assert.equal(c.status, 'incomplete'); assert.equal(c.lastRun.errorCategory, 'session'); assert.equal(c.sessions.gemini, undefined);
  assert(c.messages.some(message => message.role === 'error' && /could not continue its saved session: Session not found in the current GEMINI_HOME\. The next message starts a fresh session with a task brief\./.test(message.text)));
  assert(!logged().some(entry => entry.method === 'session/prompt' && entry.prompt.includes('Third task')), 'Nothing was sent to a session that was not there.');
  fs.rmSync(lost);
  await send('Fourth task');
  assert.equal(c.status, 'complete'); assert.equal(c.sessions.gemini.id, 'google-session-2'); assert.equal(c.lastRun.context.sessionMode, 'fresh');
  const fourth = envelope(logged().findLast(entry => entry.method === 'session/prompt'));
  assert(fourth.context.some(item => item.text === 'First task'), 'A fresh session gets the shared history again.');
  await broker.close(); broker = open();
  assert.equal(broker.get(c.id).sessions.gemini.id, 'google-session-2', 'The session survives a restart.');
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

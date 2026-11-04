import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { localCatalog, localEndpoint, verifyLocalModel } from '../src/local-models.mjs';
import { runCodex, localCodexConfig, CodexClient } from '../src/providers.mjs';
import { Broker } from '../src/broker.mjs';
import { createRelayServer } from '../src/server.mjs';
import { exportConversation, readConversationPackage } from '../src/conversation-export.mjs';
import { reviewAgents } from '../src/agent-review.mjs';

const digest = 'a'.repeat(64), model = 'fixture-coder:8b';
const info = { details: { format: 'gguf', parameter_size: '8B' }, capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'fixture', 'fixture.context_length': 131072 } };
const row = { name: model, digest, size: 4 * 1024 ** 3 };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('local addresses reject remote hosts, credentials, redirects and malformed metadata', async () => {
  assert.equal(localEndpoint('http://localhost:11434'), 'http://127.0.0.1:11434');
  for (const value of ['https://127.0.0.1', 'http://ollama.com', 'http://127.0.0.1.evil.example', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/v1', 'http://127.0.0.1?q=x']) assert.throws(() => localEndpoint(value));
  await assert.rejects(localCatalog({ fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); throw new Error('redirect'); } }), /not responding/);
  await assert.rejects(localCatalog({ fetchImpl: async () => new Response('invalid') }), /invalid model metadata/);
});

test('discovery makes metadata-only requests and excludes cloud aliases, unsupported tools and unverified weights', async () => {
  const rows = [row, { ...row, name: 'remote:cloud' }, { ...row, name: 'alias' }, { ...row, name: 'chat-only' }, { ...row, name: 'unknown' }, { ...row, name: 'tiny', size: 100 }], calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options }); if (url.endsWith('/api/tags')) return json({ models: rows });
    const name = JSON.parse(options.body).model;
    return json(name === 'alias' ? { ...info, remote_host: 'https://ollama.com', remote_model: 'paid' } : name === 'chat-only' ? { ...info, capabilities: ['completion'] } : name === 'unknown' ? { capabilities: ['tools'] } : info);
  };
  const result = await localCatalog({ fetchImpl, bin: process.execPath });
  assert.equal(result.installed, true); assert.deepEqual(result.models.map(item => item.id), [model]); assert.equal(result.excluded, 5);
  assert(calls.every(call => /\/api\/(tags|show)$/.test(call.url))); assert.equal(result.billingSource, 'local');
  await assert.rejects(verifyLocalModel(model, 'b'.repeat(64), { fetchImpl }), /changed or was removed/);
});

test('local native runs pin the model and endpoint, keep approvals and never consult the cloud model catalog', async () => {
  for (const mode of ['read', 'edit']) {
    class Client extends EventEmitter {
      requests = []; replies = [];
      async initialize() {}
      async request(method, params) {
        this.requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'local-thread', modelProvider: 'throughline_ollama' }, model };
        if (method === 'turn/start') {
          queueMicrotask(() => this.emit('message', { id: 90, method: 'item/commandExecution/requestApproval', params: { threadId: 'local-thread', command: 'fixture-command' } }));
          return { turn: { id: 'turn' } };
        }
        throw Error('Unexpected call: ' + method);
      }
      send(message) { this.replies.push(message); if (message.id === 90) queueMicrotask(() => this.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } })); }
      close() {}
    }
    const client = new Client(), metadata = [], approvals = [];
    const local = { model, digest, endpoint: 'http://127.0.0.1:11434', contextWindow: 131072 };
    await runCodex({ workspace: '/project', workspaces: ['/project', '/api'], prompt: 'Continue', model, mode, local }, {
      clientFactory: () => client, verifyLocal: async () => local, event() {}, metadata: value => metadata.push(value), approval: async value => { approvals.push(value); return true; },
    });
    const thread = client.requests.find(item => item.method === 'thread/start').params;
    assert.equal(thread.ephemeral, true); assert.equal(thread.modelProvider, 'throughline_ollama'); assert.equal(thread.model, model);
    assert.equal(thread.config['model_providers.throughline_ollama'].base_url, 'http://127.0.0.1:11434/v1');
    assert.equal(thread.config['model_providers.throughline_ollama'].requires_openai_auth, false); assert.deepEqual(thread.config.mcp_servers, {}); assert.equal(thread.config.web_search, 'disabled');
    assert.equal(client.requests.some(item => item.method === 'model/list' || item.method.startsWith('account/')), false);
    assert.deepEqual(thread.config['sandbox_workspace_write.writable_roots'], mode === 'read' ? [] : ['/project', '/api']);
    assert.equal(client.replies[0].result.decision, mode === 'read' ? 'decline' : 'accept'); assert.equal(approvals.length, mode === 'read' ? 0 : 1);
    assert(metadata.some(item => item.account?.billingSource === 'local'));
    assert.equal(localCodexConfig(local)['model_providers.throughline_ollama'].supports_websockets, false);
  }
});

test('a native client that selects another provider or model receives no task', async () => {
  for (const response of [{ thread: { id: 'wrong', modelProvider: 'openai' }, model }, { thread: { id: 'wrong', modelProvider: 'throughline_ollama' }, model: 'cloud-model' }]) {
    const methods = [], client = Object.assign(new EventEmitter(), { initialize: async () => {}, request: async method => { methods.push(method); return response; }, close() {} });
    await assert.rejects(runCodex({ workspace: '/project', mode: 'read', model, local: { model, digest } }, { clientFactory: () => client, verifyLocal: async () => ({ endpoint: 'http://127.0.0.1:11434' }), event() {}, approval() {}, metadata() {} }), /No task was sent/);
    assert.deepEqual(methods, ['thread/start']);
  }
});

test('local client processes do not receive inherited model API credentials', () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'fixture-secret'; let options, args;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  try {
    const client = new CodexClient({ bin: '/fixture/codex', local: { model, endpoint: 'http://127.0.0.1:11434' }, spawnImpl: (_bin, argv, config) => { args = argv; options = config; return child; } });
    assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(process.env.OPENAI_API_KEY, 'fixture-secret');
    assert(args.some(value => value.startsWith('model_provider='))); assert.equal(args.at(-1), 'app-server'); client.close(); child.emit('close', 0);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; child.stdout.end(); child.stderr.end(); }
});

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-local-'))), workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const captures = path.join(root, 'captures.jsonl'), scenario = path.join(root, 'scenario.json'); fs.writeFileSync(scenario, '{}');
  const cli = path.join(root, 'codex.mjs');
  fs.writeFileSync(cli, `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('fixture 1');process.exit(0);}
const emit=message=>console.log(JSON.stringify(message));
for await(const line of readline.createInterface({input:process.stdin})){
let m;try{m=JSON.parse(line);}catch{continue;}
fs.appendFileSync(${JSON.stringify(captures)},JSON.stringify(m)+'\\n');
const s=JSON.parse(fs.readFileSync(${JSON.stringify(scenario)},'utf8'));
if(m.method==='initialize')emit({id:m.id,result:{}});
if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'fresh-local',modelProvider:'throughline_ollama'},model:m.params.model}});
if(m.method==='turn/start'){emit({id:m.id,result:{turn:{id:'turn'}}});if(s.hang)continue;
emit({method:'item/completed',params:{threadId:'fresh-local',item:{id:'answer',type:'agentMessage',text:'Local fixture completed the task.'}}});
emit({method:'turn/completed',params:{threadId:'fresh-local',turn:{status:'completed'}}});}
}\n`, { mode: 0o700 });
  let tags = [{ ...row }], modelInfo = info;
  const ollama = http.createServer(async (req, res) => { for await (const _ of req) {} res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/api/tags' ? { models: tags } : modelInfo)); });
  ollama.listen(0, '127.0.0.1'); await once(ollama, 'listening');
  const old = process.env.AI_RELAY_OLLAMA_URL; process.env.AI_RELAY_OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
  const app = createRelayServer({ workspace, dataRoot: path.join(root, 'data'), bins: { codex: cli, claude: cli }, accessToken: 'fixture-token' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const project = app.registry.list()[0], broker = app.registry.broker(project.id), c = broker.get(app.registry.mainConversation(project.id).id);
  broker.settings(c, { provider: 'codex', model: 'cloud-codex', effort: 'high' }); broker.settings(c, { provider: 'claude', model: 'cloud-claude', effort: 'medium', mode: 'read' });
  broker.record(c, { type: 'session', provider: 'codex', id: 'original-paid-thread', workspaceSignature: broker.workspaceSignature });
  broker.message(c, 'user', 'Finish the project.', 'claude'); broker.message(c, 'assistant', 'Cloud work so far.', 'claude'); broker.updateContext(c, { goal: 'Finish safely', decisions: ['Use the existing architecture.'] });
  const request = async (route = '', input, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/local-models${route}?projectId=${project.id}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'X-AI-Relay-Token': 'fixture-token', 'X-AI-Relay': '1', 'Content-Type': 'application/json', ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await app.close(); await new Promise(resolve => ollama.close(resolve)); if (old === undefined) delete process.env.AI_RELAY_OLLAMA_URL; else process.env.AI_RELAY_OLLAMA_URL = old; fs.rmSync(root, { recursive: true, force: true }); });
  return { app, broker, c, project, request, scenario: value => fs.writeFileSync(scenario, JSON.stringify(value)), changed: () => { tags = [{ ...row, digest: 'b'.repeat(64) }]; }, cloud: () => { modelInfo = { ...info, remote_host: 'https://ollama.com' }; }, captures: () => fs.existsSync(captures) ? fs.readFileSync(captures, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : [] };
}
const selection = (metadata, requestId = 'local-request') => ({ model, digest, task: 'Continue the project locally.', context: metadata.context, requestId });

test('composer local runs include text snapshots and reject images before accepting a message', { skip: scriptCLIs }, async t => {
  const f = await fixture(t), metadata = (await f.request()).body;
  const text = f.broker.attachments.put({name:'notes.md',data:Buffer.from('Keep this attached context.').toString('base64')});
  assert.equal((await f.request('/start',{...selection(metadata,'with-text'),attachments:[text.id]})).status,202); await f.broker.running.done;
  assert(JSON.stringify(f.captures()).includes('Keep this attached context.'));
  const image = f.broker.attachments.put({name:'image.png',data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')}), before = f.c.messages.length;
  assert.equal((await f.request('/start',{...selection(metadata,'with-image'),attachments:[image.id]})).status,400); assert.equal(f.c.messages.length,before);
});

test('a local handoff uses the journal and leaves cloud settings, effort and native sessions intact across restart/export', { skip: scriptCLIs }, async t => {
  const f = await fixture(t), metadata = (await f.request()).body, before = { provider: f.c.provider, model: f.c.model, effort: f.c.effort, sessions: structuredClone(f.c.sessions), models: structuredClone(f.c.models) };
  const response = await f.request('/start', selection(metadata)); assert.equal(response.status, 202); await f.broker.running.done;
  assert.equal(f.c.status, 'complete'); assert.equal(f.c.provider, before.provider); assert.equal(f.c.model, before.model); assert.equal(f.c.effort, before.effort);
  assert.deepEqual(f.c.sessions, before.sessions); assert.deepEqual(f.c.models, before.models); assert.equal(f.c.lastRun.account.billingSource, 'local');
  const output = f.c.messages.find(item => item.text === 'Local fixture completed the task.'); assert.equal(output.connection, 'local'); assert.equal(output.model, model);
  assert.equal(reviewAgents(f.c).builderConnection, 'local'); assert.equal(reviewAgents(f.c).builderModel, model);
  const turn = f.captures().find(item => item.method === 'turn/start'); assert.match(turn.params.input[0].text, /Cloud work so far/); assert.match(turn.params.input[0].text, /Finish safely/); assert.match(turn.params.input[0].text, /existing architecture/);
  f.changed(); const duplicate = await f.request('/start', selection(metadata)); assert.equal(duplicate.body.duplicate, true); assert.equal(f.captures().filter(item => item.method === 'turn/start').length, 1);
  const exported = exportConversation(f.broker.view(f.c), f.project), imported = readConversationPackage(exported.package);
  assert(imported.messages.some(item => item.connection === 'local' && item.model === model));
  await f.broker.close(); const reopened = new Broker({ workspace: f.project.path, dataDir: f.broker.dataDir, bins: f.broker.configuredBins }); t.after(() => reopened.close());
  const restored = reopened.get(f.c.id); assert.equal(restored.lastRun.connection, 'local'); assert.deepEqual(restored.sessions, before.sessions); assert.equal(restored.model, before.model); assert.equal(restored.effort, before.effort);
});

test('workspace access changes and missing local approval scope are rejected before a run is recorded', async t => {
  const f = await fixture(t), metadata = (await f.request()).body, before = f.c.messages.length;
  assert.equal((await f.request('/start', { ...selection(metadata), context: undefined })).status, 409);
  f.broker.settings(f.c, { mode: 'edit' }); assert.equal((await f.request('/start', selection(metadata))).status, 409);
  assert.equal(f.c.messages.length, before); assert.equal(f.captures().length, 0);
  assert.equal((await f.request('/start', selection(metadata), { 'X-AI-Relay-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/start', selection(metadata), { 'X-AI-Relay': '' })).status, 403);
});

test('changed or cloud-routed model metadata fails the local run without launching a coding client', async t => {
  for (const change of ['changed', 'cloud']) {
    await t.test(change, async t => { const f = await fixture(t), metadata = (await f.request()).body; f[change]();
    assert.equal((await f.request('/start', selection(metadata))).status, 202); await f.broker.running.done;
    assert.equal(f.c.status, 'incomplete'); assert.equal(f.captures().length, 0); assert(f.c.messages.some(item => item.role === 'error'));
    });
  }
});

test('Stop cancels a local run and releases its workspace for another run', { skip: scriptCLIs }, async t => {
  const f = await fixture(t), metadata = (await f.request()).body; f.scenario({ hang: true });
  await f.request('/start', selection(metadata)); const running = f.broker.running;
  // The agent starts in its own process; under a busy full test run that can take more than a few seconds.
  for (let tries = 0; tries < 1500 && !f.captures().some(item => item.method === 'turn/start'); tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert(f.captures().some(item => item.method === 'turn/start')); f.broker.stop(f.c.id); await running.done;
  assert.equal(f.c.status, 'interrupted'); assert.equal(f.broker.running, null); assert.equal(f.c.sessions.codex.id, 'original-paid-thread');
  f.scenario({}); await f.request('/start', selection(metadata, 'after-stop')); await f.broker.running.done; assert.equal(f.c.status, 'complete');
});

test('ordinary message options cannot enable the broker’s internal local execution path', async t => {
  const f = await fixture(t);
  f.broker.start(f.c, { text: 'Ordinary task', provider: 'codex', transport: 'app-server', model: 'cloud-codex', effort: 'high', fresh: true, local: { model, digest } });
  await f.broker.running.done; assert.equal(f.c.lastRun.connection, undefined); assert.equal(f.c.model, 'cloud-codex');
});

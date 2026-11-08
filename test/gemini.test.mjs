import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { scriptCLIs, noSymlinks } from './platform.mjs';
import { GeminiClient, geminiInvocation, promptUsage, runGemini } from '../src/gemini.mjs';
import { Broker } from '../src/broker.mjs';
import { accountStatus, listModels, providerUsage } from '../src/providers.mjs';
import { exportConversation, readConversationPackage } from '../src/conversation-export.mjs';

function folder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-gemini-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test('Gemini invocation enforces read/edit policy without changing user settings or allowing extensions, hooks or MCP', t => {
  const root = folder(t);
  for (const mode of ['read', 'edit']) {
    const invocation = geminiInvocation({ mode, workspace: root, workspaces: [root, '/second folder'], model: 'chosen-model' }, { env: { GEMINI_API_KEY: 'fixture-key' }, systemDirectory: path.join(root, 'system') });
    try {
      const settings = JSON.parse(fs.readFileSync(invocation.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')), policy = fs.readFileSync(settings.adminPolicyPaths[0], 'utf8');
      assert.equal(settings.hooksConfig.enabled, false); assert.equal(settings.admin.mcp.enabled, false); assert.equal(settings.admin.extensions.enabled, false); assert.equal(settings.admin.skills.enabled, false);
      assert.equal(settings.tools.core.includes('run_shell_command'), mode === 'edit'); assert.equal(settings.tools.core.includes('write_file'), mode === 'edit');
      assert.match(policy, mode === 'read' ? /decision = "deny"/ : /decision = "ask_user"/); assert.match(policy, /priority = 998/); assert(!policy.includes('modes'));
      assert(invocation.args.includes('--admin-policy')); assert.deepEqual(invocation.args.slice(-2), ['--include-directories', '/second folder']); assert.equal(invocation.env.GEMINI_API_KEY, 'fixture-key');
      assert(!invocation.args.some(value => /yolo|auto_edit|skip-permission/.test(value)));
    } finally { invocation.cleanup(); }
    assert(!fs.existsSync(invocation.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH));
  }
  assert.throws(() => geminiInvocation({ workspace: root }, { env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/managed.json' }, systemDirectory: root }), /managed system/);
  fs.mkdirSync(path.join(root, 'policies')); fs.writeFileSync(path.join(root, 'policies/admin.toml'), '');
  assert.throws(() => geminiInvocation({ workspace: root }, { env: {}, systemDirectory: root }), /managed system/);
  assert.throws(() => geminiInvocation({ workspace: root, workspaces: Array.from({ length: 6 }, (_, i) => '/' + i) }, { env: {}, systemDirectory: path.join(root, 'absent') }), /six folders/);
});

class Client extends EventEmitter {
  requests = []; replies = []; pending = new Map(); sessionId = 'fresh-session'; capabilities = { promptCapabilities: { image: true } };
  constructor(script = async () => {}, model = 'chosen-model', stopReason = 'end_turn') { super(); Object.assign(this, { script, model, stopReason }); }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: this.capabilities };
    if (method === 'session/new') return { sessionId: 'fresh-session', models: { currentModelId: this.model } };
    if (['session/resume', 'session/load'].includes(method)) {
      if (this.lost) throw new Error('Session not found in the current GEMINI_HOME');
      this.sessionId = params.sessionId;
      if (method === 'session/load') for (const [role, text] of [['user', 'Earlier request'], ['agent', 'Earlier reply']]) this.update({ sessionUpdate: `${role}_message_chunk`, content: { type: 'text', text } });
      return { models: { currentModelId: this.model } };
    }
    if (method === 'session/prompt') { await this.script(this); return { stopReason: this.stopReason, ...(this.usage ? { usage: this.usage } : {}) }; }
    throw new Error('Unexpected method: ' + method);
  }
  send(message) { this.replies.push(message); this.pending.get(message.id)?.(message); this.pending.delete(message.id); }
  rpc(method, params, id = this.requests.length + this.replies.length + 10) { return new Promise(resolve => { this.pending.set(id, resolve); this.emit('message', { jsonrpc: '2.0', id, method, params: { sessionId: this.sessionId, ...params } }); }); }
  update(update) { this.emit('message', { jsonrpc: '2.0', method: 'session/update', params: { sessionId: this.sessionId, update } }); }
  close() { this.closed = true; }
  fail(error) { throw error; }
}
const request = { options: [{ kind: 'allow_always', optionId: 'persistent' }, { kind: 'allow_once', optionId: 'once' }], toolCall: { kind: 'execute', title: 'Run npm test' } };
async function run(client, config = {}, callbacks = {}) {
  const events = [], metadata = []; let cleaned = false;
  const promise = runGemini({ workspace: '/project', mode: 'edit', prompt: 'Saved project context', model: 'chosen-model', ...config }, { clientFactory: () => client, probe: async () => ({ status: 0, stdout: '0.66.0' }), invocation: () => ({ cleanup() { cleaned = true; } }), event: value => events.push(value), metadata: value => metadata.push(value), approval: async () => true, ...callbacks });
  try { await promise; } finally { if (client.requests.length) assert(cleaned); }
  return { events, metadata };
}

test('Gemini streams replies and tool activity, reports actual model, and permits only one action at a time', async () => {
  const client = new Client(async c => {
    const answer = await c.rpc('session/request_permission', request); assert.equal(answer.result.outcome.optionId, 'once');
    c.update({ sessionUpdate: 'tool_call', toolCallId: 'test', title: 'Run tests', status: 'in_progress' });
    c.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Private chain of thought' } });
    c.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Gemini result' } });
  });
  const { events, metadata } = await run(client);
  assert.equal(events.at(-1).type, 'turn.completed'); assert(events.some(event => event.type === 'relay.delta' && event.text === 'Gemini result'));
  assert(!JSON.stringify(events).includes('Private chain of thought')); assert.equal(metadata[0].effectiveModel, 'chosen-model');
  assert.deepEqual(client.requests.map(r => r.method), ['initialize', 'session/new', 'session/prompt']); assert(client.closed);
});

test('Gemini continues a saved session when the runtime can, skips the replayed history, and says when it cannot continue one', async () => {
  const reply = async c => { c.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Continued' } }); };
  // The runtime's own resume keeps the session as it is, and the turn's usage is reported for the run.
  const resumed = new Client(reply); resumed.capabilities = { loadSession: true, sessionCapabilities: { resume: {} } };
  resumed.usage = { totalTokens: 130, inputTokens: 100, outputTokens: 20, thoughtTokens: 10, cachedReadTokens: 60, cachedWriteTokens: 0 };
  const { events, metadata } = await run(resumed, { sessionId: 'saved-session' });
  assert.deepEqual(resumed.requests.map(r => r.method), ['initialize', 'session/resume', 'session/prompt']);
  assert.deepEqual(resumed.requests[1].params, { sessionId: 'saved-session', cwd: '/project', mcpServers: [] }); assert.equal(resumed.requests[2].params.sessionId, 'saved-session');
  assert.deepEqual(events.find(event => event.type === 'thread.started'), { type: 'thread.started', thread_id: 'saved-session' });
  assert.deepEqual(events.filter(event => event.type === 'item.completed').map(event => event.item.text), ['Continued']); assert.equal(events.at(-1).type, 'turn.completed');
  assert.deepEqual(metadata.find(entry => entry.usage).usage, { inputTokens: 100, outputTokens: 20, thoughtTokens: 10, cachedReadTokens: 60, cachedWriteTokens: 0 });
  // The standard load replays the saved messages first; the chat already has them.
  const loaded = new Client(reply); loaded.capabilities = { loadSession: true };
  const replay = await run(loaded, { sessionId: 'saved-session' });
  assert.equal(loaded.requests[1].method, 'session/load');
  assert.deepEqual(replay.events.filter(event => event.type === 'item.completed').map(event => event.item.text), ['Continued']); assert(!JSON.stringify(replay.events).includes('Earlier reply'));
  // A new session is remembered only when the runtime could continue it later.
  const fresh = new Client(); fresh.capabilities = { sessionCapabilities: { resume: {} } };
  assert.deepEqual((await run(fresh)).events.find(event => event.type === 'thread.started'), { type: 'thread.started', thread_id: 'fresh-session' });
  assert(!(await run(new Client())).events.some(event => event.type === 'thread.started'));
  // A session the runtime no longer has, or a runtime that can't continue any, fails the run before any prompt and says what happens next.
  const lost = new Client(); lost.capabilities = { sessionCapabilities: { resume: {} } }; lost.lost = true;
  await assert.rejects(run(lost, { sessionId: 'saved-session' }), error => /could not continue its saved session: Session not found in the current GEMINI_HOME\. The next message starts a fresh session with a task brief\./.test(error.message) && error.category === 'session');
  assert(!lost.requests.some(r => r.method === 'session/prompt'));
  const unable = new Client();
  await assert.rejects(run(unable, { sessionId: 'saved-session' }), error => /cannot continue a saved session/.test(error.message) && error.category === 'session');
  assert.deepEqual(unable.requests.map(r => r.method), ['initialize']);
  // Usage is added up over a run's turns, and a count any turn left out stays unknown.
  assert.deepEqual(promptUsage([{ inputTokens: 100, outputTokens: 20, thoughtTokens: 10, cachedReadTokens: 60, cachedWriteTokens: 0 }, { inputTokens: 50, outputTokens: 5 }]), { inputTokens: 150, outputTokens: 25, thoughtTokens: null, cachedReadTokens: null, cachedWriteTokens: null });
  assert.equal(promptUsage([undefined, { stopReason: 'end_turn' }]), null);
});

test('Gemini rejects read-only writes, denied approvals and persistent-only permission offers', async () => {
  for (const [mode, approve, options] of [['read', true, request.options], ['edit', false, request.options], ['edit', true, request.options.slice(0, 1)]]) {
    let calls = 0;
    const client = new Client(async c => { const reply = await c.rpc('session/request_permission', { ...request, options }); assert.equal(reply.result.outcome.outcome, 'cancelled'); });
    await assert.rejects(run(client, { mode }, { approval: async () => { calls++; return approve; } }), /denied or unsupported/);
    assert.equal(calls, mode === 'read' || options.length === 1 ? 0 : 1);
  }
});

test('Gemini filesystem proxy rejects outside paths and symlinks and rechecks file contents after approval', { skip: noSymlinks }, async t => {
  const root = folder(t), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'original'); fs.writeFileSync(path.join(root, 'outside.txt'), 'private');
  fs.symlinkSync(path.join(root, 'outside.txt'), path.join(workspace, 'link.txt'));
  // A directory junction leads out as well as a link does.
  fs.mkdirSync(path.join(root, 'elsewhere')); fs.writeFileSync(path.join(root, 'elsewhere', 'secret.txt'), 'private');
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(workspace, 'joined'), 'junction');
  for (const target of [path.join(root, 'outside.txt'), path.join(workspace, 'link.txt'), path.join(workspace, 'joined', 'secret.txt')]) {
    const client = new Client(async c => { assert((await c.rpc('fs/read_text_file', { path: target })).error); });
    await assert.rejects(run(client, { workspace }), /denied or unsupported/);
  }
  const client = new Client(async c => {
    assert.equal((await c.rpc('fs/read_text_file', { path: path.join(workspace, 'file.txt') })).result.content, 'original');
    assert((await c.rpc('fs/write_text_file', { path: path.join(workspace, 'file.txt'), content: 'overwrite' })).error);
  });
  await assert.rejects(run(client, { workspace }, { approval: async () => { fs.writeFileSync(path.join(workspace, 'file.txt'), 'newer contents'); return true; } }), /denied or unsupported/);
  assert.equal(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf8'), 'newer contents');
  const read = new Client(async c => { assert((await c.rpc('fs/write_text_file', { path: path.join(workspace, 'new.txt'), content: 'bad' })).error); });
  await assert.rejects(run(read, { workspace, mode: 'read' }), /denied or unsupported/); assert(!fs.existsSync(path.join(workspace, 'new.txt')));
});

test('Gemini verifies requested model before sending and treats limits, refusal and cancellation as incomplete', async () => {
  const mismatch = new Client(async () => { throw Error('Must not prompt'); }, 'other-model');
  await assert.rejects(run(mismatch), /requested model/); assert(!mismatch.requests.some(r => r.method === 'session/prompt'));
  for (const stop of ['max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) await assert.rejects(run(new Client(undefined, 'chosen-model', stop)), /did not complete/);
  await assert.rejects(run(new Client(), {}, { probe: async () => ({ status: 0, stdout: '0.40.0' }) }), /0.66.0/);
});

test('Gemini JSON-RPC client rejects malformed output and clears pending requests', async () => {
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const client = new GeminiClient({ spawnImpl: () => child });
  const pending = client.request('initialize'); child.stdout.write('not JSON\n');
  await assert.rejects(pending, /Invalid Gemini protocol/); assert(client.closed); assert.equal(client.pending.size, 0);
});

test('an effort saved under the Antigravity connection cannot stop a run on Gemini CLI, which takes its effort from the model', { skip: scriptCLIs }, async t => {
  // Hooks run in the order they're added, so this closes the broker, and the work it saves in the folder, before the folder is removed.
  let broker; t.after(() => broker?.close());
  const root = folder(t), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const cli = path.join(root, 'gemini.mjs');
  fs.writeFileSync(cli, `#!${process.execPath}
import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')emit({id:m.id,result:{sessionId:'native-session',models:{currentModelId:'chosen-model'}}});
if(m.method==='session/prompt'){emit({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done.'}}}});emit({id:m.id,result:{stopReason:'end_turn'}});}
}
`, { mode: 0o700 });
  broker = new Broker({ workspace, bins: { gemini: cli }, dataDir: path.join(root, 'data') });
  const c = broker.get(broker.create().id);
  broker.settings(c, { provider: 'gemini', model: 'chosen-model', mode: 'edit', effort: 'high' });
  assert.equal(c.efforts.gemini['chosen-model'], 'high');
  broker.start(c, { text: 'Continue this project', provider: 'gemini', requestId: 'saved-effort' }); await broker.running.done;
  assert.equal(c.status, 'complete');
  assert.deepEqual(c.messages.filter(message => message.role === 'error'), []);
});

test('Gemini worker completes canonical handoffs, preserves other sessions and model choices, and releases the workspace after Stop', { skip: scriptCLIs }, async t => {
  // Hooks run in the order they're added, so this closes the broker, and the work it saves in the folder, before the folder is removed.
  let broker; t.after(() => broker?.close());
  const root = folder(t), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const cli = path.join(root, 'gemini.mjs'), capture = path.join(root, 'capture.jsonl');
  fs.writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(m)+'\\n');
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')emit({id:m.id,result:{sessionId:'native-session',models:{currentModelId:'chosen-model'}}});
if(m.method==='session/prompt'){if(m.params.prompt[0].text.includes('HANG-FIXTURE')&&!m.params.prompt[0].text.includes('Retry after stopping'))continue;emit({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Gemini finished the task.'}}}});emit({id:m.id,result:{stopReason:'end_turn'}});}}
`, { mode: 0o700 });
  const dataDir = path.join(root, 'data'); broker = new Broker({ workspace, bins: { gemini: cli }, dataDir });
  const c = broker.get(broker.create().id);
  broker.record(c, { type: 'session', provider: 'codex', id: 'original-codex', workspaceSignature: broker.workspaceSignature });
  broker.message(c, 'assistant', 'Existing Claude plan', 'claude');
  broker.settings(c, { provider: 'gemini', model: 'chosen-model', mode: 'read' });
  broker.start(c, { text: 'Continue this project', requestId: 'gemini-first' }); await broker.running.done;
  assert.equal(c.status, 'complete'); assert.equal(c.sessions.codex.id, 'original-codex'); assert.equal(c.sessions.gemini, undefined);
  assert.equal(c.messages.find(message => message.text === 'Gemini finished the task.').provider, 'gemini'); assert.equal(c.lastRun.effectiveModel, 'chosen-model');
  const messages = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert(messages.find(message => message.method === 'session/prompt').params.prompt[0].text.includes('Existing Claude plan'));
  const exported = exportConversation(c, { name: 'Fixture', folders: [] }); assert.equal(readConversationPackage(exported.package).messages.find(m => m.text === 'Gemini finished the task.').provider, 'gemini');
  const replay = new Broker({ workspace, bins: { gemini: cli }, dataDir }); assert.equal(replay.get(c.id).provider, 'gemini'); await replay.close();
  assert.throws(() => broker.start(c, { text: 'Wrong transport', transport: 'cli' }), /does not support/);
  broker.start(c, { text: 'HANG-FIXTURE', requestId: 'gemini-stop' }); const stopped = broker.running.done;
  await new Promise(resolve => setTimeout(resolve, 500)); broker.stop(c.id); await stopped; assert.equal(c.status, 'interrupted');
  broker.start(c, { text: 'Retry after stopping', requestId: 'gemini-retry' }); await broker.running.done; assert.equal(c.status, 'complete');
  assert.equal((await listModels('gemini', { bin: cli })).manualSelection, true); assert.equal((await providerUsage('gemini', { bin: cli })).available, false);
  const account = await accountStatus('gemini', { bin: cli, workspace }); assert.equal(account.installed, true); assert.equal(account.authenticated, 'unknown');
});

test('Antigravity cannot infer authentication or billing and cannot start a run without an approval protocol', { skip: scriptCLIs }, async t => {
  // Hooks run in the order they're added, so this closes the broker, and the work it saves in the folder, before the folder is removed.
  let broker; t.after(() => broker?.close());
  const root = folder(t), bin = path.join(root, 'agy'), captures = path.join(root, 'commands.jsonl');
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(captures)},JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv.includes('--version')){console.log('1.4.12');process.exit(0);}
process.exit(1);
`, { mode: 0o700 });
  const account = await accountStatus('gemini', { bin, workspace: root });
  assert.equal(account.installed, true); assert.equal(account.authenticated, 'unknown'); assert.equal(account.billingSource, 'unknown'); assert.equal(account.capabilities.approvals, false);
  assert(!account.account); assert.match(account.message, /interactive tool approvals/);
  const models = await listModels('gemini', { bin }); assert.equal(models.source, 'unavailable'); assert.deepEqual(models.models, []);
  const before = fs.readFileSync(captures, 'utf8');
  for (const mode of ['read', 'edit']) await assert.rejects(runGemini({ bin, workspace: root, mode, prompt: 'Must not run' }, { event() {}, metadata() {} }), /interactive tool approvals/);
  assert.equal(fs.readFileSync(captures, 'utf8'), before, 'Unsupported adapters fail before invoking a task.');
  broker = new Broker({ workspace: root, dataDir: path.join(root, 'history'), bins: { gemini: bin, codex: bin, claude: bin } });
  const c = broker.get(broker.create().id), status = await broker.status();
  assert.equal(status.providers.gemini.installed, true); assert.equal(status.providers.gemini.available, false);
  assert.throws(() => broker.start(c, { text: 'Must not be accepted', provider: 'gemini' }), /interactive tool approvals/);
  assert.equal(c.messages.length, 0); assert.equal(broker.running, null);
});

test('Gemini auto-approves tool requests when approvalPolicy is auto', async () => {
  let approvalCalls = 0;
  const client = new Client(async c => {
    const answer = await c.rpc('session/request_permission', request);
    assert.equal(answer.result.outcome.optionId, 'once');
    c.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Gemini auto success' } });
  });
  const { events } = await run(client, { approvalPolicy: 'auto' }, { approval: async () => { approvalCalls++; return true; } });
  assert.equal(approvalCalls, 1, 'Tool requests are routed to approval handler');
  assert.equal(events.at(-1).type, 'turn.completed');
});

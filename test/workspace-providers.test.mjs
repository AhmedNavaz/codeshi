import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker, commandFor } from '../src/broker.mjs';
import { MutationCoordinator } from '../src/mutation-lock.mjs';
import { runCodex, runClaude } from '../src/providers.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspace-provider-')));
  const primary = path.join(root, 'web'); const secondary = path.join(root, 'api'); const third = path.join(root, 'third');
  for (const directory of [primary, secondary, third]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(primary, '.mock-scenarios.json'), '{}');
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, `${provider}.mjs`);
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  }
  const brokers = [];
  const open = (folders = [primary]) => {
    const broker = new Broker({ workspace: primary, workspaces: folders, workspaceFolders: folders.map((directory, index) => ({ id: `folder-${index}`, name: path.basename(directory), path: directory })), bins, dataDir: path.join(root, 'history') });
    brokers.push(broker); return broker;
  };
  const captures = () => fs.readFileSync(path.join(primary, '.mock-captures.jsonl'), 'utf8').split('\n').slice(0, -1).map(JSON.parse);
  t.after(async () => { for (const broker of brokers) await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, primary, secondary, third, open, captures };
}

test('multi-folder CLI arguments use explicit provider roots without widening Codex read-only access', () => {
  const options = { workspace: '/web folder', workspaces: ['/web folder', '/api folder'], bin: '/provider' };
  const codex = commandFor('codex', { ...options, mode: 'edit' }).args;
  assert.deepEqual(codex.slice(codex.indexOf('--add-dir'), codex.indexOf('--add-dir') + 2), ['--add-dir', '/api folder']);
  assert.ok(codex.indexOf('--add-dir') < codex.indexOf('exec'));
  const read = commandFor('codex', { ...options, mode: 'read' }).args;
  assert.equal(read.includes('--add-dir'), false); assert.equal(read[read.indexOf('--sandbox') + 1], 'read-only');
  const claude = commandFor('claude', { ...options, mode: 'read' }).args;
  assert.equal(claude[claude.indexOf('--add-dir') + 1], '/api folder');
  assert.equal(claude[claude.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal([...codex, ...read, ...claude].some(value => /bypass|danger-full|skip-permissions/.test(value)), false);
});

test('native adapters pass all current roots while read mode remains restricted', async () => {
  const workspaces = ['/web', '/api'];
  for (const mode of ['edit', 'read']) {
    class Client extends EventEmitter {
      requests = [];
      async initialize() {}
      async request(method, params) {
        this.requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread' } };
        if (method === 'turn/start') { queueMicrotask(() => this.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } })); return { turn: { id: 'turn' } }; }
      }
      close() {}
    }
    const client = new Client();
    await runCodex({ workspace: '/web', workspaces, prompt: 'Inspect workspace', mode }, { clientFactory: () => client, event() {}, metadata() {}, approval: async () => false });
    const start = client.requests.find(row => row.method === 'thread/start').params; const turn = client.requests.find(row => row.method === 'turn/start').params;
    assert.deepEqual(start.config['sandbox_workspace_write.writable_roots'], mode === 'edit' ? workspaces : []);
    assert.deepEqual(turn.sandboxPolicy, mode === 'edit' ? { type: 'workspaceWrite', writableRoots: workspaces, networkAccess: false } : { type: 'readOnly', networkAccess: false });
    let options;
    async function* queryImpl(input) { options = input.options; yield { type: 'result', subtype: 'success' }; }
    await runClaude({ workspace: '/web', workspaces, mode, prompt: 'Inspect workspace', bin: '/official/claude' }, { queryImpl, event() {}, metadata() {}, approval: async () => false });
    assert.deepEqual(options.additionalDirectories, ['/api']);
    assert.equal(options.settings.disableAllHooks, true);
    if (mode === 'read') {
      assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep', 'TodoWrite'], 'Read only adds nothing but the agent’s own to-do list.');
      assert.equal((await options.canUseTool('Bash', { command: 'touch /api/file' }, {})).behavior, 'deny');
      assert.equal((await options.canUseTool('TodoWrite', { todos: [] }, {})).behavior, 'allow');
    }
  }
});

test('snapshot reviews cannot resume coding sessions or enable edit access, MCP or hosted search', async () => {
  const config = { workspace:'/snapshot',workspaces:['/snapshot'],prompt:'Review approved copies',mode:'read',model:'fixture-model',effort:'medium',reviewSnapshot:true };
  for (const invalid of [{...config,mode:'edit'},{...config,sessionId:'previous-coding-thread'}]) await assert.rejects(runCodex(invalid, {}), /read-only access and a fresh/);
  class Client extends EventEmitter {
    requests=[]; async initialize() {}
    async request(method,params) { this.requests.push({method,params}); if (method==='thread/start') return {thread:{id:'review'}}; if (method==='turn/start') {queueMicrotask(()=>this.emit('message',{method:'turn/completed',params:{turn:{status:'completed'}}}));return {turn:{id:'turn'}};} }
    close() {}
  }
  const client = new Client(); let options;
  await runCodex(config,{clientFactory:value=>{options=value;return client;},event(){},metadata(){},approval:async()=>false});
  const started = client.requests.find(row=>row.method==='thread/start').params;
  assert.equal(options.reviewSnapshot,true); assert.equal(started.ephemeral,true); assert.equal(started.sandbox,'read-only'); assert.deepEqual(started.config.mcp_servers,{}); assert.equal(started.config.web_search,'disabled');
});

test('folder membership changes reconstruct both native sessions and preserve the canonical chat', { skip: scriptCLIs }, async t => {
  const f = fixture(t); let broker = f.open(); const id = broker.create().id;
  const run = async (provider, text) => { const c = broker.get(id); broker.start(c, { provider, text }); await broker.running.done; assert.equal(c.status, 'complete'); };
  await run('codex', 'First Codex'); await run('claude', 'First Claude'); await run('codex', 'Codex after switch');
  assert.equal(f.captures().at(-1).args.includes('resume'), false);
  await run('codex', 'Codex same roots');
  assert.ok(f.captures().at(-1).args.includes('resume'));
  await broker.close(); broker = f.open([f.primary, f.secondary]);
  await run('codex', 'Codex with API');
  let capture = f.captures().at(-1);
  assert.equal(capture.args.includes('resume'), false);
  assert.ok(capture.context.context.some(message => message.text === 'First Codex'));
  assert.deepEqual(capture.context.workspaceFolders.map(folder => folder.path), [f.primary, f.secondary]);
  assert.equal(capture.context.workspaceFolders[1].name, 'api');
  assert.deepEqual(broker.get(id).lastRun.baseline.folders.map(folder => folder.path), [f.primary, f.secondary]);
  await run('claude', 'Claude with API');
  assert.equal(f.captures().at(-1).args.includes('--resume'), false);
  await run('claude', 'Claude same roots');
  assert.equal(f.captures().at(-1).args.includes('--resume'), true);
  await broker.close(); broker = f.open([f.primary]);
  await run('codex', 'API removed from Codex');
  capture = f.captures().at(-1);
  assert.equal(capture.args.includes('resume'), false); assert.equal(capture.args.includes('--add-dir'), false);
  assert.deepEqual(capture.context.workspaceFolders.map(folder => folder.path), [f.primary]);
  await run('claude', 'API removed from Claude');
  assert.equal(f.captures().at(-1).args.includes('--resume'), false);
  assert.equal(broker.conversations.size, 1);
});

test('all workspace roots acquire atomically and secondary nested folders exclude other projects', t => {
  const f = fixture(t); const nested = path.join(f.secondary, 'nested'); fs.mkdirSync(nested);
  const first = new MutationCoordinator(f.root); const second = new MutationCoordinator(f.third);
  const secondaryLease = first.acquire(f.secondary, 'secondary provider');
  assert.throws(() => second.acquireMany([f.primary, nested], 'patch'), { status: 409 });
  // A rejected multi-root request leaves no partial lease on its earlier roots.
  const independent = second.acquire(f.primary, 'independent'); independent.release(); secondaryLease.release();
  const combined = first.acquireMany([f.primary, f.secondary], 'workspace provider');
  assert.throws(() => second.acquire(nested, 'nested patch'), { status: 409 });
  assert.throws(() => second.acquireMany([f.third, f.primary], 'other workspace'), { status: 409 });
  const unrelated = second.acquire(f.third, 'unrelated'); unrelated.release(); combined.release();
  const after = second.acquire(nested, 'after release'); after.release();
});

test('unavailable saved folders preserve chat access and reject runs before accepting user text', async t => {
  const f = fixture(t); let broker = f.open([f.primary, f.secondary]); const id = broker.create().id;
  broker.message(broker.get(id), 'user', 'Saved conversation'); await broker.close();
  fs.rmdirSync(f.secondary); broker = f.open([f.primary, f.secondary]);
  const c = broker.get(id); assert.equal(c.messages[0].text, 'Saved conversation');
  assert.throws(() => broker.start(c, { text: 'Do not accept this yet' }), /Workspace folder is unavailable/);
  assert.equal(c.messages.length, 1); assert.equal(broker.running, null);
  const coordinator = new MutationCoordinator(f.root);
  const lease = coordinator.acquireMany([f.primary, f.secondary], 'remove missing folder'); lease.release();
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { acpApprovalRequest, acpToolItem } from '../src/acp-tools.mjs';
import { GeminiClient } from '../src/acp-client.mjs';
import { approvalScope, readOnlyRequest } from '../src/approval-rules.mjs';
import { antigravityInvocation, removeRuntimeSkill } from '../src/antigravity.mjs';
import { runGemini } from '../src/gemini.mjs';

// Each frame below was captured from Antigravity 1.4.5.
const command = (status, extra = {}) => ({ toolCallId: 'cmd', kind: 'execute', status, title: 'git status', rawInput: { CommandLine: 'git status', Cwd: '/project', WaitMsBeforeAsync: 10000 }, ...extra });
const edit = { toolCallId: 'edit', kind: 'edit', status: 'pending', title: 'Run client_edit_file?', content: [{ path: '/project/notes.txt', oldText: 'one\n', newText: 'two\n', _meta: { kind: 'modify' }, type: 'diff' }], locations: [{ path: '/project/notes.txt' }], rawInput: { code_content: 'two\n', target_file: '/project/notes.txt' } };
const create = { toolCallId: 'new', kind: 'edit', status: 'pending', title: 'Run client_create_file?', content: [{ path: '/project/new.txt', newText: 'one\n', _meta: { kind: 'add' }, type: 'diff' }], rawInput: { code_content: 'one\n', target_file: '/project/new.txt' } };

test('a command becomes a command step with its real output and exit code', () => {
  const output = { commandLine: 'ls /gone', exitCode: 1, exit_code: 1, combinedOutput: 'ls: /gone: No such file or directory\r\n' };
  assert.deepEqual(acpToolItem(command('completed', { rawOutput: output })), { id: 'cmd', type: 'command_execution', command: 'git status', aggregated_output: 'ls: /gone: No such file or directory', exit_code: 1 });
  // While it runs the runtime spells the input differently.
  assert.equal(acpToolItem({ toolCallId: 'cmd', kind: 'execute', status: 'in_progress', title: 'x', rawInput: { command_line: 'npm test', working_dir: '/project' } }).command, 'npm test');
});

test('a file step keeps its path and diff, a read names its file, and a failure says why', () => {
  assert.deepEqual(acpToolItem(edit), { id: 'edit', type: 'agent_tool', name: 'Edit', input: { file_path: '/project/notes.txt', old_string: 'one\n', new_string: 'two\n' }, result: '', failed: false });
  const written = acpToolItem(create);
  assert.equal(written.name, 'Write'); assert.equal(written.input.content, 'one\n'); assert.equal(written.result, 'Created', 'The timeline shows a new file as created.');
  const read = acpToolItem({ toolCallId: 'read', title: 'Running view_file', kind: 'read', status: 'failed', locations: [{ path: '/project' }], rawInput: { file_path: '/project', start_line: 0, end_line: 799 }, rawOutput: 'Cannot view file:///project because it is a directory, not a file.' });
  assert.deepEqual([read.name, read.input, read.failed], ['Read', { file_path: '/project' }, true]);
  assert.match(read.result, /is a directory/);
});

test('web searches read as searches, other runtime tools by name, and an agent without rawInput keeps its title', () => {
  const web = acpToolItem({ toolCallId: 'web', kind: 'search', status: 'completed', title: 'Running search_web', rawInput: { query: 'Node LTS', domain: '' }, content: [{ content: { text: 'Node 26' } }] });
  assert.deepEqual([web.name, web.input, web.result], ['WebSearch', { query: 'Node LTS' }, 'Node 26']);
  const other = acpToolItem({ toolCallId: 'task', kind: 'other', status: 'in_progress', title: 'Running run_workflow', rawInput: { script: 'x' } });
  assert.deepEqual([other.type, other.name, other.input], ['agent_tool', 'run_workflow', { script: 'x' }]);
  assert.deepEqual(acpToolItem({ toolCallId: 'plain', title: 'Run tests', status: 'in_progress' }), { id: 'plain', type: 'mcp_tool_call', tool: 'Run tests', result: '' });
});

test('approval rules can read a Gemini command: a safe one needs no prompt, and any single command can be remembered', () => {
  const workspaces = ['/project'], safe = acpApprovalRequest(command('pending'));
  assert.deepEqual(safe, { kind: 'execute', title: 'git status', input: { command: 'git status', cwd: '/project' } });
  assert.equal(readOnlyRequest(safe, { workspaces }), true);
  assert.equal(approvalScope(safe, { provider: 'gemini', workspaces }).kind, 'command');
  // Reading the real command must not make an unsafe one look safe.
  for (const line of ['rm -rf src', 'git status; rm -rf src', 'npm test']) assert.equal(readOnlyRequest(acpApprovalRequest({ ...command('pending'), rawInput: { CommandLine: line, Cwd: '/project' } }), { workspaces }), false, line);
  assert.equal(readOnlyRequest(acpApprovalRequest({ ...command('pending'), rawInput: { CommandLine: 'cat /etc/passwd', Cwd: '/project' } }), { workspaces }), false);
  const change = acpApprovalRequest(edit);
  assert.equal(change.title, undefined, 'The runtime’s own "Run client_edit_file?" is not shown to the person.');
  assert.equal(change.input.file_path, '/project/notes.txt');
  assert.equal(approvalScope(change, { provider: 'gemini', workspaces }).label, 'Edit notes.txt');
});

class Client extends EventEmitter {
  requests = []; replies = []; pending = new Map(); paused = [];
  constructor(script) { super(); this.script = script; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } };
    if (method === 'session/new') return { sessionId: 's', models: { currentModelId: 'm' } };
    if (method === 'session/prompt') { await this.script(this); return { stopReason: 'end_turn' }; }
    throw new Error('Unexpected method: ' + method);
  }
  send(message) { this.replies.push(message); this.pending.get(message.id)?.(message); this.pending.delete(message.id); }
  rpc(method, params, id = this.requests.length + this.replies.length + 10) { return new Promise(resolve => { this.pending.set(id, resolve); this.emit('message', { jsonrpc: '2.0', id, method, params: { sessionId: 's', ...params } }); }); }
  update(update) { this.emit('message', { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } }); }
  text(text) { this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }); }
  pauseSilence(value) { this.paused.push(value); }
  close() {}
  fail(error) { throw error; }
}
const options = [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }];
async function drive(script, { workspace = '/project', approval = async () => true } = {}) {
  const events = [], client = new Client(script);
  await runGemini({ workspace, mode: 'edit', prompt: 'p', model: 'm' }, { clientFactory: () => client, probe: async () => ({ status: 0, stdout: '0.66.0' }), invocation: () => ({ cleanup() {} }), event: value => events.push(value), metadata() {}, approval });
  return { events, client };
}

test('text on either side of a tool is two messages in the order they happened, and late completions keep them apart', async () => {
  const { events } = await drive(async c => {
    c.text('I will check '); c.text('the status.');
    c.update({ sessionUpdate: 'tool_call', ...command('pending') });
    c.update({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'completed', rawOutput: { exitCode: 0, combinedOutput: 'clean\r\n' } });
    c.text('It launched in the background.');
    c.update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Running client_view_file', kind: 'read', status: 'in_progress', rawInput: { absolute_path: '/project/a.md' } });
    c.text('All done.');
    // Antigravity reports its file steps finished only here, after the closing text.
    c.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' });
  });
  const order = events.filter(event => event.type === 'relay.delta' || event.item?.type !== 'agent_message' && event.item).map(event => event.type === 'relay.delta' ? `${event.id}:${event.text}` : `${event.item.id}:${event.type}`);
  assert.deepEqual(order, ['response:I will check ', 'response:the status.', 'cmd:item.started', 'cmd:item.completed', 'response-1:It launched in the background.', 'read:item.started', 'response-2:All done.', 'read:item.completed']);
  assert.deepEqual(events.filter(event => event.item?.type === 'agent_message').map(event => [event.item.id, event.item.text]), [['response', 'I will check the status.'], ['response-1', 'It launched in the background.'], ['response-2', 'All done.']]);
  assert.equal(events.find(event => event.item?.id === 'cmd' && event.type === 'item.completed').item.aggregated_output, 'clean');
});

test('what Gemini says when a background command ends is a new message, not more of its notice', async () => {
  const { events } = await drive(async c => {
    c.update({ sessionUpdate: 'tool_call', ...command('pending') });
    c.update({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'in_progress' });
    c.text('Task task-16 has been launched in the background.');
    c.update({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'completed', rawOutput: { exitCode: 0, combinedOutput: 'slept\r\n' } });
    c.text('I will now run the next step.');
    // A file step finishing at the end of the turn doesn't split a message.
    c.update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Running view_file', kind: 'read', status: 'in_progress' });
    c.text('One ');
    c.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' });
    c.text('sentence.');
  });
  assert.deepEqual(events.filter(event => event.item?.type === 'agent_message').map(event => event.item.text), ['Task task-16 has been launched in the background.', 'I will now run the next step.', 'One sentence.']);
});

test('one edit asks once: a write the person allowed goes through, and different bytes still ask', async t => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-acp-'))); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, 'notes.txt'); fs.writeFileSync(file, 'one\n');
  const toolCall = { ...edit, content: [{ ...edit.content[0], path: file }] }, asked = [];
  await drive(async c => {
    assert.equal((await c.rpc('session/request_permission', { toolCall, options })).result.outcome.optionId, 'allow');
    assert.deepEqual((await c.rpc('fs/write_text_file', { path: file, content: 'two\n' })).result, {});
    assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
    // The permission covered that one write, not the file from now on.
    assert.deepEqual((await c.rpc('fs/write_text_file', { path: file, content: 'two\n' })).result, {});
    assert.deepEqual((await c.rpc('fs/write_text_file', { path: file, content: 'three\n' })).result, {});
  }, { workspace, approval: async request => { asked.push(request.kind); return true; } });
  assert.deepEqual(asked, ['edit', 'write_file', 'write_file']);
});

test('a read that fails is the agent’s to handle: the run still succeeds', async t => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-acp-'))); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'folder')); fs.writeFileSync(path.join(workspace, 'big.txt'), 'x'.repeat(300 * 1024));
  const { events } = await drive(async c => {
    for (const name of ['folder', 'missing.txt', 'big.txt']) assert.match((await c.rpc('fs/read_text_file', { path: path.join(workspace, name) })).error.message, /folder|Only regular|Cannot access/, name);
    c.text('I worked around it.');
  }, { workspace });
  assert.equal(events.at(-1).type, 'turn.completed');
  await assert.rejects(drive(async c => { assert((await c.rpc('fs/read_text_file', { path: '/etc/passwd' })).error); }, { workspace }), /denied or unsupported/, 'A path outside the workspace is still reported.');
});

test('the silence limit pauses while an approval or a command is in progress', async () => {
  const seen = [];
  await drive(async c => {
    c.update({ sessionUpdate: 'tool_call', ...command('pending') }); seen.push(c.paused.at(-1));
    await c.rpc('session/request_permission', { toolCall: command('pending'), options }); seen.push(c.paused.at(-1));
    c.update({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'in_progress' }); seen.push(c.paused.at(-1));
    c.update({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'completed' }); seen.push(c.paused.at(-1));
    // A file step reports finishing only at the end of the turn, so it must not hold the limit open.
    c.update({ sessionUpdate: 'tool_call', toolCallId: 'read', kind: 'read', status: 'in_progress', title: 'Running view_file' }); seen.push(c.paused.at(-1));
  });
  assert.deepEqual(seen, [true, true, true, false, false]);
});

function fakeProcess() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  return child;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('an active turn outlasts the silence limit, a silent one ends, and a pause holds it open', async () => {
  const start = () => { const child = fakeProcess(); return { child, client: new GeminiClient({ bin: 'x', cwd: '/', args: [], env: {}, spawnImpl: () => child }) }; };
  const frame = child => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }) + '\n');

  const active = start(); let settled = false;
  const working = active.client.request('session/prompt', {}, 60, { silence: true }).finally(() => { settled = true; });
  for (let i = 0; i < 6; i++) { await wait(25); frame(active.child); }
  assert.equal(settled, false, 'Still working after more than twice the limit.');
  active.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }) + '\n');
  assert.deepEqual(await working, { stopReason: 'end_turn' });

  await assert.rejects(start().client.request('session/prompt', {}, 30, { silence: true }), /Gemini protocol timed out: no activity/);

  const held = start(); let ended = false;
  const waiting = held.client.request('session/prompt', {}, 30, { silence: true }).catch(error => { ended = error; });
  held.client.pauseSilence(true);
  await wait(90); assert.equal(ended, false, 'A long command or an unanswered approval does not count.');
  held.client.pauseSilence(false);
  await waiting; assert.match(ended.message, /no activity/);

  // A request without the option keeps its fixed limit however busy the agent is.
  const fixed = start(), request = fixed.client.request('session/new', {}, 40);
  const ticks = setInterval(() => frame(fixed.child), 10);
  await assert.rejects(request, /timed out: session\/new/); clearInterval(ticks);
});

test('Antigravity’s commands get the person’s tools on PATH, not the app’s bare one', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-acp-'))), saved = process.env.PATH, relay = process.env.AI_RELAY_TEST_VALUE;
  t.after(() => { process.env.PATH = saved; if (relay === undefined) delete process.env.AI_RELAY_TEST_VALUE; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'; process.env.AI_RELAY_TEST_VALUE = 'private';
  const { env } = antigravityInvocation({ bin: path.join(root, 'agy_acp_server.par'), googleRoot: root, mode: 'edit', relay: null });
  const entries = env.PATH.split(path.delimiter);
  assert.equal(entries[0], root, 'The runtime’s folder comes first.');
  if (process.platform !== 'win32') for (const folder of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) assert(entries.includes(folder), folder);
  assert.equal(env.AI_RELAY_TEST_VALUE, undefined, 'Codeshi’s own settings stay out of the agent’s commands.');
});

test('the runtime’s stray skill is removed after a run, and only that', async t => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-acp-'))); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const folder = path.join(workspace, 'skills/system/run-workflow'), file = path.join(folder, 'SKILL.md'), runtime = '---\nname: run-workflow\nmetadata:\n    namespace: system\n---\n';
  const plant = (content = runtime) => { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(file, content); };

  let remove = removeRuntimeSkill(workspace); plant(); remove();
  assert.equal(fs.existsSync(path.join(workspace, 'skills')), false, 'A folder only the runtime used is gone.');

  remove = removeRuntimeSkill(workspace); plant(); fs.writeFileSync(path.join(workspace, 'skills/mine.md'), 'Mine'); remove();
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(path.join(workspace, 'skills/mine.md'), 'utf8'), 'Mine', 'The person’s own skill stays.');
  fs.rmSync(path.join(workspace, 'skills'), { recursive: true });

  plant(); remove = removeRuntimeSkill(workspace); remove();
  assert.equal(fs.existsSync(file), true, 'A copy that was there before this run is left alone.');
  fs.rmSync(path.join(workspace, 'skills'), { recursive: true });

  remove = removeRuntimeSkill(workspace); plant('---\nname: my-own-workflow\n---\n'); remove();
  assert.equal(fs.existsSync(file), true, 'A file at that path with other contents isn’t the runtime’s.');
  fs.rmSync(path.join(workspace, 'skills'), { recursive: true });

  removeRuntimeSkill(workspace)();
  assert.equal(fs.existsSync(path.join(workspace, 'skills')), false, 'Nothing to remove is not an error.');
});

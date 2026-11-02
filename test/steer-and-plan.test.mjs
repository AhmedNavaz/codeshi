import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { runCodex, runClaude } from '../src/providers.mjs';
import { runGemini } from '../src/gemini.mjs';
import { Broker } from '../src/broker.mjs';

const until = async (check, tries = 500) => { for (let i = 0; i < tries && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert(check(), 'Timed out waiting.'); };

test('Codex adds a note to the running turn with turn/steer, reports its plan, and stops taking notes when the turn ends', async () => {
  class Client extends EventEmitter {
    requests = []; async initialize() {} close() {}
    async request(method, params) {
      this.requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    }
  }
  const client = new Client(), events = []; let steer;
  const done = runCodex({ workspace: '/project', prompt: 'Build the feature', mode: 'edit', model: 'model', effort: 'low' }, { clientFactory: () => client, event: value => events.push(value), metadata() {}, approval: async () => true, steerable: handler => { steer = handler; } });
  await until(() => steer);
  client.emit('message', { method: 'turn/plan/updated', params: { threadId: 'thread', turnId: 'turn-1', explanation: 'Three steps', plan: [{ step: 'Read the code', status: 'completed' }, { step: 'Write tests', status: 'inProgress' }, { step: 'Run them', status: 'pending' }] } });
  await steer('Also update the docs');
  assert.deepEqual(client.requests.at(-1), { method: 'turn/steer', params: { threadId: 'thread', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'Also update the docs' }] } });
  client.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await done;
  assert.equal(steer, null, 'A finished turn takes no more notes.');
  assert.deepEqual(client.requests.find(row => row.method === 'thread/start').params.config['tools.update_plan'], { enabled: true }, 'Codex keeps its plan with its plan tool.');
  assert.deepEqual(events.find(event => event.type === 'relay.plan'), { type: 'relay.plan', explanation: 'Three steps', steps: [{ text: 'Read the code', status: 'done' }, { text: 'Write tests', status: 'active' }, { text: 'Run them', status: 'pending' }] });
});

test('a Codex that does not know the plan setting starts without it', async () => {
  class Client extends EventEmitter {
    requests = []; async initialize() {} close() {}
    async request(method, params) {
      this.requests.push({ method, params: structuredClone(params) });
      if (method === 'thread/start') { if (params.config['tools.update_plan']) throw new Error('failed to load configuration: unknown field `update_plan`'); return { thread: { id: 'thread' } }; }
      if (method === 'turn/start') { queueMicrotask(() => this.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } })); return { turn: { id: 'turn' } }; }
    }
  }
  const client = new Client();
  await runCodex({ workspace: '/project', prompt: 'Build', mode: 'edit', model: 'model', effort: 'low' }, { clientFactory: () => client, event() {}, metadata() {}, approval: async () => true });
  assert.deepEqual(client.requests.filter(row => row.method === 'thread/start').map(row => 'tools.update_plan' in row.params.config), [true, false]);
});

test('Claude takes a note into the running turn from its streamed input, closes input at the result, and its to-do list becomes the plan', async () => {
  const received = [], events = []; let steer, handler, noteSent;
  const noted = new Promise(resolve => { noteSent = resolve; });
  async function* queryImpl({ prompt }) {
    const input = prompt[Symbol.asyncIterator]();
    received.push((await input.next()).value);
    yield { type: 'assistant', message: { id: 'one', content: [
      { type: 'tool_use', id: 'todo', name: 'TodoWrite', input: { todos: [{ content: 'Read the code', status: 'completed', activeForm: 'Reading the code' }, { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }, { content: 'Run them', status: 'pending', activeForm: 'Running them' }] } },
      { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'npm test' } },
    ] } };
    await noted;
    received.push((await input.next()).value);
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'todo', content: 'Todos updated' }, { type: 'tool_result', tool_use_id: 'bash', content: 'pass' }] } };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Done' };
    received.push(await input.next());
  }
  const done = runClaude({ workspace: '/project', prompt: 'Build the feature', mode: 'edit' }, { queryImpl, event: value => events.push(value), metadata() {}, approval: async () => true, steerable: value => { steer = value; if (value) handler = value; } });
  await until(() => steer && events.length);
  await steer('Also update the docs'); noteSent();
  await done;
  assert.deepEqual(received[0].message, { role: 'user', content: 'Build the feature' });
  assert.deepEqual(received[1], { type: 'user', parent_tool_use_id: null, priority: 'next', message: { role: 'user', content: 'Also update the docs' } }, 'The note joins the turn at its next step.');
  assert.equal(received[2].done, true, 'Input closes once the turn has its result.');
  assert.equal(steer, null); await assert.rejects(handler('Too late'), /finished/);
  assert.deepEqual(events.find(event => event.type === 'relay.plan').steps, [{ text: 'Read the code', status: 'done' }, { text: 'Writing tests', status: 'active' }, { text: 'Run them', status: 'pending' }], 'The step in progress reads as what is happening now.');
  assert.deepEqual(events.find(event => event.type === 'assistant').message.content.map(block => block.name), ['Bash'], 'The to-do list is not shown as tool activity.');
  assert.deepEqual(events.find(event => event.type === 'user').message.content.map(block => block.tool_use_id), ['bash']);
});

test('Gemini takes a note by stopping its prompt and continuing the same session with it, and reports its plan', async () => {
  class Client extends EventEmitter {
    requests = []; sent = [];
    async request(method, params) {
      this.requests.push({ method, params });
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
      if (method === 'session/new') return { sessionId: 'session', models: { currentModelId: 'model' } };
      if (method !== 'session/prompt') throw new Error('Unexpected ' + method);
      if (this.requests.filter(row => row.method === 'session/prompt').length === 1) {
        this.update({ sessionUpdate: 'plan', entries: [{ content: 'Read the code', priority: 'high', status: 'completed' }, { content: 'Edit the form', priority: 'high', status: 'in_progress' }] });
        this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it.' } });
        await new Promise(resolve => { this.cancelled = resolve; });
        this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The request was cancelled by the client.' } });
        return { stopReason: 'cancelled' };
      }
      this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done, docs too.' } });
      return { stopReason: 'end_turn' };
    }
    send(message) { this.sent.push(message); if (message.method === 'session/cancel') this.cancelled?.(); }
    update(update) { this.emit('message', { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session', update } }); }
    close() {} fail(error) { throw error; }
  }
  const client = new Client(), events = []; let steer;
  const done = runGemini({ workspace: '/project', mode: 'edit', prompt: 'Build the feature', model: 'model' }, { clientFactory: () => client, probe: async () => ({ status: 0, stdout: '0.66.0' }), invocation: () => ({ cleanup() {} }), event: value => events.push(value), metadata() {}, approval: async () => true, steerable: handler => { steer = handler; } });
  await until(() => steer && events.some(event => event.text === 'Working on it.'));
  await steer('Also update the docs'); await steer('And the changelog');
  await done;
  assert.equal(client.sent.filter(message => message.method === 'session/cancel').length, 1, 'Two quick notes stop the prompt once.');
  assert(!JSON.stringify(events).includes('cancelled by the client'), 'The runtime’s cancel notice is not shown as a reply.');
  const prompts = client.requests.filter(row => row.method === 'session/prompt');
  assert.equal(prompts.length, 2); assert.equal(prompts[1].params.sessionId, 'session', 'The same session continues.');
  assert.match(prompts[1].params.prompt[0].text, /added this to the current task:\n\nAlso update the docs\n\nAnd the changelog\n\n.*carry on/s);
  assert.deepEqual(events.filter(event => event.type === 'item.completed').map(event => [event.item.id, event.item.text]), [['response', 'Working on it.'], ['response-1', 'Done, docs too.']], 'The reply after the note is its own message.');
  assert.equal(events.at(-1).type, 'turn.completed'); assert.equal(steer, null);
  assert.deepEqual(events.find(event => event.type === 'relay.plan').steps, [{ text: 'Read the code', status: 'done' }, { text: 'Edit the form', status: 'active' }]);
});

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));
test('the broker records a note added to the run inside that run, queues it first when the run cannot take it, and keeps the plan', { skip: scriptCLIs }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-steer-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({ 'Hold the workspace': { behavior: 'hold' } }));
  const bins = { codex: path.join(root, 'codex-mock.mjs') };
  fs.writeFileSync(bins.codex, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  const broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id), captures = path.join(workspace, '.mock-captures.jsonl');
  // Only complete lines: the mock agent may be writing the next one.
  const requests = () => fs.existsSync(captures) ? fs.readFileSync(captures, 'utf8').split('\n').slice(0, -1).map(JSON.parse).map(entry => entry.context.currentRequest) : [];
  broker.start(c, { text: 'Hold the workspace', provider: 'codex', mode: 'edit' });
  await until(() => requests().length);
  const run = broker.running;
  assert.equal(broker.view(c).canAddToRun, false, 'The plain CLI connection cannot take notes.');
  await assert.rejects(broker.addToRun(c, { text: 'Also the docs' }), /cannot take more input/);

  // The worker answers as a connection that takes notes would.
  let accept = true; const send = run.child.send.bind(run.child);
  run.steerable = true;
  run.child.send = (message, callback) => {
    if (message.type !== 'steer') return send(message, callback);
    callback?.(null); setImmediate(() => run.child.emit('message', { type: 'steer-result', id: message.id, ok: accept, error: accept ? null : 'The turn has finished.' })); return true;
  };
  assert.equal(broker.view(c).canAddToRun, true);
  await assert.rejects(broker.addToRun(c, { text: '  ' }), /between 1 and 100,000/);
  const added = await broker.addToRun(c, { text: 'Also update the docs' });
  assert.equal(added.added, true);
  const note = c.messages.at(-1);
  assert.deepEqual([note.role, note.text, note.steer, note.runId, note.provider], ['user', 'Also update the docs', true, run.id, 'codex']);

  broker.queueAction(c, { action: 'add', text: 'Later work', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  accept = false;
  const queued = await broker.addToRun(c, { text: 'And the changelog' });
  assert.deepEqual([queued.added, queued.queued], [false, true]);
  assert.deepEqual(c.queue.map(item => [item.text, item.provider, item.mode]), [['And the changelog', 'codex', 'edit'], ['Later work', 'codex', 'edit']], 'A note that missed its run goes first in the queue, with that run’s settings.');

  broker.event(run, { type: 'relay.plan', steps: [{ text: 'Read the code', status: 'done' }, { text: ' ', status: 'done' }, { text: 'Write tests', status: 'unknown' }] });
  assert.deepEqual(c.activeRun.plan.steps, [{ text: 'Read the code', status: 'done' }, { text: 'Write tests', status: 'pending' }]);
  fs.writeFileSync(path.join(workspace, '.release'), '');
  await run.done;
  assert.deepEqual(c.lastRun.plan.steps.map(step => step.text), ['Read the code', 'Write tests'], 'The plan stays with the finished run.');
  for (let i = 0; i < 1500 && (c.queue.length || broker.running); i++) { if (broker.running) await broker.running.done; else await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.deepEqual(requests().slice(1), ['And the changelog', 'Later work']);
  await assert.rejects(broker.addToRun(c, { text: 'Anything else' }), /Nothing is running/);
});

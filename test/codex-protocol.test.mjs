import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexClient, runCodex } from '../src/providers.mjs';

function setup(t) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const client = new CodexClient({ bin: '/fixture/codex', spawnImpl: () => child });
  const messages = [], failures = [];
  client.on('message', message => messages.push(message));
  client.on('closed', error => failures.push(error));
  t.after(() => client.close());
  return { client, child, messages, failures };
}

test('Codex JSONL retains Unicode separators and large pasted prompts across UTF-8 pipe chunks', async t => {
  const { client, child, messages, failures } = setup(t);
  const text = 'A pasted request\u2028with paragraphs\u2029and emoji 🧭\u0085'.repeat(700);
  const event = { method: 'item/completed', params: { item: { type: 'userMessage', text } } };
  const response = client.request('turn/start');
  const bytes = Buffer.from(JSON.stringify(event) + '\n' + JSON.stringify({ id: 1, result: { turn: { id: 'turn' } } }) + '\n');
  // Each byte of a multibyte separator/emoji can arrive in a separate read. No event is complete until LF arrives.
  for (let index = 0; index < bytes.length; index++) child.stdout.write(bytes.subarray(index, index + 1));
  assert.deepEqual(await response, { turn: { id: 'turn' } });
  assert.deepEqual(messages, [event]);
  assert.deepEqual(failures, []);
});

test('Codex JSONL waits for a complete frame and accepts CRLF and several frames per chunk', async t => {
  const { client, child, messages } = setup(t);
  const response = client.request('initialize');
  child.stdout.write('{"method":"notice","params":{"text":"first');
  assert.equal(messages.length, 0);
  child.stdout.write('\\nsecond\\rthird"}}\r\n{"id":1,"result":{"ok":true}}\r\n');
  assert.deepEqual(await response, { ok: true });
  assert.equal(messages[0].params.text, 'first\nsecond\rthird');
});

test('Codex JSONL preserves a complete last response without a newline', async t => {
  const { client, child } = setup(t);
  const response = client.request('initialize');
  child.stdout.end('{"id":1,"result":{"ok":true}}');
  assert.deepEqual(await response, { ok: true });
});

test('malformed Codex frames reject all requests and ignore later valid responses', async t => {
  const { client, child, messages, failures } = setup(t);
  const first = assert.rejects(client.request('initialize'), /Invalid Codex JSON-RPC protocol/);
  const second = assert.rejects(client.request('model/list'), /Invalid Codex JSON-RPC protocol/);
  child.stdout.write('invalid-json\n{"id":1,"result":{}}\n{"method":"notice"}\n');
  child.emit('close', 1, null);
  await Promise.all([first, second]);
  assert.equal(failures.length, 1);
  assert.equal(messages.length, 0);
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.request('turn/start'), /closed/);
});

test('a Codex command approval keeps the kind Codeshi’s rules know, whatever kind Codex names in it', async () => {
  // What Codex 0.165 sends for a command its sandbox blocked, taken from a real run: the whole line it would run, and a
  // kind of its own. That kind once replaced Codeshi's, so the folder guard and remembered approvals passed these by.
  const method = 'item/commandExecution/requestApproval';
  const params = { threadId: 'thread', turnId: 'turn', itemId: 'exec-1', startedAtMs: 1, environmentId: 'local', kind: 'command', reason: 'May I push?', command: "/bin/zsh -lc 'git push origin main'", cwd: '/project', commandActions: [{ type: 'unknown', command: 'git push origin main' }], proposedExecpolicyAmendment: ['git', 'push', 'origin', 'main'], availableDecisions: ['accept', 'cancel'] };
  class Client extends EventEmitter {
    sent = []; async initialize() {} close() {}
    ask(id, more) { queueMicrotask(() => this.emit('message', { id, method, params: { ...params, ...more } })); }
    send(message) {
      this.sent.push(message);
      if (message.id === 51) this.ask(52, { itemId: 'exec-2', kind: 'writeStdin' });
      if (message.id === 52) queueMicrotask(() => this.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } }));
    }
    async request(name) {
      if (name === 'thread/start') return { thread: { id: 'thread' } };
      if (name === 'turn/start') { this.ask(51, {}); return { turn: { id: 'turn' } }; }
      return {};
    }
  }
  const client = new Client(), asked = [];
  await runCodex({ workspace: '/project', prompt: 'Push', mode: 'edit', model: 'm', effort: 'low' }, { clientFactory: () => client, event() {}, metadata() {}, approval: async request => { asked.push(request); return request.id === '51'; } });
  assert.deepEqual(asked.map(request => [request.id, request.kind, request.codexKind]), [['51', method, undefined], ['52', method, 'writeStdin']], 'Input for a running terminal is marked, as it is not the command it names.');
  assert.equal(asked[0].command, params.command);
  assert.deepEqual(client.sent.filter(message => message.id > 50), [{ id: 51, result: { decision: 'accept' } }, { id: 52, result: { decision: 'decline' } }]);
});

test('a truncated Codex event at EOF fails without discarding it or submitting again', async t => {
  const { client, child, messages, failures } = setup(t);
  const response = assert.rejects(client.request('turn/start'), /Invalid Codex JSON-RPC protocol/);
  child.stdout.end('{"method":"item/completed","params":{"text":"unfinished');
  await response;
  child.emit('close', 1, null);
  assert.equal(failures.length, 1);
  assert.equal(messages.length, 0);
  assert.equal(client.counter, 1);
});

for (const access of [
  { name: 'Ask before changes', mode: 'edit', approvalPolicy: 'ask', expected: 'untrusted' },
  { name: 'default Ask before changes', mode: 'edit', expected: 'untrusted' },
  { name: 'Full auto-approval', mode: 'edit', approvalPolicy: 'auto', expected: 'on-request' },
  { name: 'Read only', mode: 'read', approvalPolicy: 'ask', expected: 'never' },
]) {
  for (const resumed of [false, true]) {
    test(`Codex ${access.name} sets thread and turn permissions in a ${resumed ? 'resumed' : 'new'} conversation`, async () => {
      class Client extends EventEmitter {
        requests = []; async initialize() {} close() {}
        async request(method, params) {
          this.requests.push({ method, params });
          if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } };
          if (method === 'turn/start') {
            queueMicrotask(() => this.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } }));
            return { turn: { id: 'turn' } };
          }
          throw new Error(`Unexpected request: ${method}`);
        }
      }
      const client = new Client();
      await runCodex({ workspace: '/project', workspaces: ['/project', '/site'], prompt: 'Continue', mode: access.mode,
        ...(access.approvalPolicy ? { approvalPolicy: access.approvalPolicy } : {}),
        ...(resumed ? { sessionId: 'thread' } : {}), model: 'm', effort: 'low' },
      { clientFactory: () => client, event() {}, metadata() {}, approval() { assert.fail('This fixture does not request approval.'); } });
      assert.deepEqual(client.requests.map(request => request.method), [resumed ? 'thread/resume' : 'thread/start', 'turn/start']);
      const [thread, turn] = client.requests.map(request => request.params);
      assert.equal(thread.threadId, resumed ? 'thread' : undefined);
      assert.equal(turn.threadId, 'thread');
      for (const params of [thread, turn]) {
        assert.equal(params.approvalPolicy, access.expected, 'The current choice overrides saved thread and turn permissions.');
        assert.equal(params.approvalsReviewer, 'user', 'Approvals must reach Codeshi.');
        assert.equal(params.cwd, '/project');
      }
      const readOnly = access.mode === 'read', networkAccess = access.approvalPolicy === 'auto';
      assert.equal(thread.sandbox, readOnly ? 'read-only' : 'workspace-write');
      assert.deepEqual(thread.config['sandbox_workspace_write.writable_roots'], readOnly ? [] : ['/project', '/site']);
      assert.equal(thread.config['sandbox_workspace_write.network_access'], networkAccess);
      assert.deepEqual(turn.sandboxPolicy, readOnly
        ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', writableRoots: ['/project', '/site'], networkAccess });
    });
  }
}

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexClient } from '../src/providers.mjs';

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

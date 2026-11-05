import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { runCodex } from '../src/providers.mjs';
import { codexAsyncQuestions } from '../src/agent-questions.mjs';

const questions = [{ title: 'Do you already have a Firebase project?', options: ['No project yet', 'Yes—I’ll send the project ID'] }];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-async-questions-'));
  const brokers = [];
  const open = () => {
    const broker = new Broker({ workspace: root, dataDir: path.join(root, 'data') });
    brokers.push(broker); return broker;
  };
  const broker = open(), c = broker.get(broker.create().id);
  broker.record(c, { type: 'run_start', id: 'run-one', provider: 'codex', mode: 'read', approvalPolicy: 'ask' });
  const run = { id: 'run-one', c, provider: 'codex', mode: 'read', approvals: new Map(), steers: new Map() };
  const emit = (patch = {}) => broker.event(run, { type: 'item.completed', item: { id: 'ask', type: 'agent_message', text: 'Do you already have a Firebase project?\n- No project yet\n- Yes—I’ll send the project ID', questions, ...patch } });
  t.after(async () => { for (const value of brokers) await value.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { broker, c, run, emit, open };
}

test('Codex async questions accept string options, free text and untrusted or empty input', () => {
  const normalized = codexAsyncQuestions([...questions, { title: 'Project ID?', options: null }, { title: '' }, null]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].question, questions[0].title);
  assert.equal(normalized[0].other, true);
  assert.deepEqual(normalized[0].options.map(option => option.label), questions[0].options);
  assert.equal(normalized[1].other, true);
  assert.deepEqual(codexAsyncQuestions(null), []);
});

test('the real Codex adapter preserves async questions without waiting for an RPC answer', async () => {
  class Client extends EventEmitter {
    async initialize() {} close() {} send() { assert.fail('An async question is not a server RPC request.'); }
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.emit('message', { method: 'item/completed', params: { threadId: 'thread', item: { id: 'ask', type: 'agentMessage', text: 'Firebase?', questions } } });
          this.emit('message', { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
        });
        return { turn: { id: 'turn' } };
      }
      return {};
    }
  }
  const events = [];
  await runCodex({ workspace: '/project', prompt: 'Connect remotely', mode: 'read', model: 'model', effort: 'high' }, { clientFactory: () => new Client(), event: event => events.push(event), metadata() {}, approval: async () => false, question: async () => assert.fail('Async questions do not block the provider.') });
  assert.deepEqual(events.find(event => event.item?.id === 'ask').item.questions, questions);
  assert.equal(events.at(-1).type, 'turn.completed');
});

test('async questions become answer cards once, without pretending Codex paused; reviews cannot ask', t => {
  const { broker, c, run, emit } = fixture(t), notices = [];
  broker.on('notify', notice => notices.push(notice));
  emit(); emit();
  const [item] = broker.view(c).pendingApprovals;
  assert.equal(broker.pendingCount(), 1);
  assert.equal(item.kind, 'question'); assert.equal(item.blocking, false);
  assert.equal(item.runId, 'run-one'); assert.equal(item.questions[0].question, questions[0].title);
  assert.equal(notices.length, 1);
  assert.equal(run.approvals.size, 0, 'Optional questions do not block an agent or an automatic handoff.');
  assert.equal(c.messages.filter(message => message.role === 'assistant').length, 1);
  run.review = {};
  emit({ id: 'review-question' });
  assert.equal(broker.pendingCount(), 1);
});

test('a live answer reaches the existing steering path once and validates the selected conversation', async t => {
  const { broker, c, run, emit } = fixture(t);
  broker.running = run; run.steerable = true;
  emit(); const item = broker.view(c).pendingApprovals[0];
  const other = broker.get(broker.create().id);
  assert.throws(() => broker.answer(run.id, item.id, [['No project yet']], other), { status: 409 });
  await assert.rejects(broker.answer(run.id, item.id, [[]], c), { status: 400 });
  let calls = 0, deliver;
  broker.addToRun = async (conversation, input) => { calls++; assert.equal(conversation, c); assert.match(input.text, /Firebase project.*→ No project yet/); await new Promise(resolve => { deliver = resolve; }); return { added: true }; };
  const sending = broker.answer(run.id, item.id, [['No project yet']], c);
  await assert.rejects(broker.answer(run.id, item.id, [['No project yet']], c), { status: 409 });
  deliver(); assert.deepEqual(await sending, { resolved: true, added: true });
  assert.equal(calls, 1); assert.equal(broker.pendingCount(), 0);
  assert.throws(() => broker.answer(run.id, item.id, [['No project yet']], c), { status: 409 });
  broker.running = null;
});

test('failed live delivery keeps the question answerable', async t => {
  const { broker, c, run, emit } = fixture(t);
  broker.running = run; run.steerable = true; emit();
  const item = broker.view(c).pendingApprovals[0];
  broker.addToRun = async () => { throw new Error('Connection lost'); };
  await assert.rejects(broker.answer(run.id, item.id, [['No project yet']], c), /Connection lost/);
  assert.equal(broker.pendingCount(), 1);
  broker.running = null;
});

test('unanswered async questions survive completion and restart; answering prepares a draft without starting work', async t => {
  const { broker, c, emit, open } = fixture(t);
  emit(); broker.record(c, { type: 'run_end', status: 'complete' });
  const reloaded = open(), saved = reloaded.get(c.id), item = reloaded.view(saved).pendingApprovals[0];
  assert.equal(item.blocking, false);
  reloaded.start = () => assert.fail('Choosing an answer must not start a new billed run.');
  const result = await reloaded.answer(item.runId, item.id, [['codeshi-project']], saved);
  assert.equal(result.resolved, true); assert.match(result.draft, /→ codeshi-project/);
  assert.equal(reloaded.pendingCount(), 0);
  assert.equal(open().pendingCount(), 0, 'A resolved question stays resolved after restart.');
});

test('skip dismisses an optional question without executing anything; a new prompt supersedes old questions', async t => {
  const { broker, c, emit } = fixture(t);
  emit(); const item = broker.view(c).pendingApprovals[0];
  assert.deepEqual(await broker.answer(item.runId, item.id, null, c), { resolved: true });
  assert.equal(broker.pendingCount(), 0);
  emit({ id: 'second' }); assert.equal(broker.pendingCount(), 1);
  broker.record(c, { type: 'submission', requestId: 'next', fingerprint: 'fp', runId: 'next', provider: 'codex', mode: 'read', approvalPolicy: 'ask' });
  assert.equal(broker.pendingCount(), 0);
});

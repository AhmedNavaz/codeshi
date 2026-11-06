import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { contextReading } from '../src/context-state.mjs';
import { runClaude } from '../src/providers.mjs';

// An agent near its context window compacts before it does anything else, so a failure here stops every retry too.
for (const provider of ['codex', 'claude']) {
  test(`${provider} compacting its context doesn't stop the run, and is counted once per compaction`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-compaction-'));
    const broker = new Broker({ workspace: root, dataDir: path.join(root, 'data') });
    t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const c = broker.get(broker.create().id);
    broker.record(c, { type: 'run_start', id: 'run-one', provider, mode: 'read', approvalPolicy: 'ask' });
    const run = { id: 'run-one', c, provider, mode: 'read', approvals: new Map(), steers: new Map() };

    const compact = () => broker.event(run, { type: 'relay.progress', phase: 'compacting' });
    compact();
    compact();
    assert.equal(run.compactions, 1, 'Repeated reports of one compaction count once.');
    assert.equal(c.activeRun.compactions, 1);

    broker.event(run, { type: 'relay.progress', phase: 'working' });
    compact();
    assert.equal(run.compactions, 2, 'Compacting again after working is a second compaction.');
    assert.equal(c.activeRun.compactions, 2);
    assert.equal(run.failed, undefined);
  });
}

test('native compaction boundaries persist, deduplicate, invalidate old context readings and survive restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-compaction-'));
  const options = { workspace: root, dataDir: path.join(root, 'data') };
  const broker = new Broker(options), c = broker.get(broker.create().id);
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  broker.record(c, { type: 'run_start', id: 'run-one', provider: 'claude' });
  broker.record(c, { type: 'session', provider: 'claude', id: 'same-session' });
  const run = { id: 'run-one', c, provider: 'claude', mode: 'read', approvals: new Map(), steers: new Map() };
  broker.record(c, { type: 'run_metadata', metadata: { transport: 'cli' } });
  broker.event(run, { type: 'assistant', message: { content: [] }, context_usage: { total_tokens: 50000, raw_max_tokens: 100000 } });
  assert.equal(c.activeRun.contextUsage.used, 50000, 'The CLI fallback retains reported context readings too.');
  broker.event(run, { type: 'relay.progress', phase: 'compacting' });
  assert.equal(c.activeRun.contextUsage.used, null, 'The old context snapshot is no longer current.');
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary-1', compact_metadata: { trigger: 'auto', pre_tokens: 50000, post_tokens: 8000 } };
  broker.event(run, boundary); broker.event(run, boundary);
  assert.equal(c.activeRun.compactions, 1);
  assert.equal(c.activeRun.compactionEvents.length, 1);
  assert.equal(c.activeRun.compactionEvents[0].beforeTokens, 50000);
  assert.equal(c.activeRun.contextUsage.used, 8000);
  assert.equal(c.sessions.claude.needsContextRefresh, true);
  broker.record(c, { type: 'run_end', status: 'complete' });
  broker.record(c, { type: 'checkpoint', provider: 'claude' });
  assert.equal(c.sessions.claude.needsContextRefresh, true, 'Finishing the compacted run does not falsely clear restoration.');
  const ledger = await broker.ledger(c);
  assert.equal(ledger.runs[0].compactions, 1);
  assert.equal(ledger.runs[0].compactionEvents[0].afterTokens, 8000);
  await broker.close();
  const restarted = new Broker(options);
  try {
    const restored = restarted.get(c.id);
    assert.equal(restored.lastRun.compactions, 1);
    assert.equal(restored.lastRun.compactionEvents.length, 1);
    assert.equal(restored.sessions.claude.needsContextRefresh, true);
  } finally { await restarted.close(); }
});

test('context occupancy, last request input and cumulative usage are separate readings', () => {
  const at = '2026-11-07T00:00:00.000Z';
  const codex = contextReading('codex', { usage: { total: { inputTokens: 900000 }, last: { inputTokens: 12000 }, modelContextWindow: 200000 } }, at);
  assert.equal(codex.used, null);
  assert.equal(codex.lastRequestInput, 12000);
  assert.equal(codex.capacity, 200000);
  assert.equal(codex.observedAt, at);
  assert.equal(contextReading('claude', { usage: { input_tokens: 123 } }, at), null);
  assert.equal(contextReading('gemini', { usage: { used: 5000, size: 100000 } }, at).used, 5000);
});

test('Claude context reports retain their estimate and window meaning without issuing a context request', async () => {
  const metadata = [];
  async function* queryImpl() {
    yield { type: 'assistant', message: { id: 'context', content: [] }, context_usage: { model: 'm', total_tokens: 20001, raw_max_tokens: 20000 } };
  }
  await runClaude({ bin: '/fake', workspace: '/project', mode: 'read', prompt: 'Go' }, { queryImpl, metadata: value => metadata.push(value), event() {}, approval: async () => false });
  const reading = metadata.find(value => value.contextUsage).contextUsage;
  assert.equal(reading.used, 20001, 'Over-limit estimates are not clamped.');
  assert.equal(reading.estimated, true);
  assert.equal(reading.windowKind, 'compaction-policy-or-model');
});

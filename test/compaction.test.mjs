import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';

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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ProjectRegistry } from '../src/projects.mjs';
import { createCheckpointRoutes } from '../src/checkpoint-routes.mjs';

test('checkpoint routes list history, enforce the workspace lease and restore only after preview confirmation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-timeline-routes-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'before\n');
  const registry = new ProjectRegistry({ dataRoot: path.join(root, 'data'), lock: false });
  t.after(async () => { await registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = registry.add({ path: workspace }), broker = registry.broker(project.id), c = broker.get(registry.mainConversation(project.id).id);
  const run = { id: randomUUID(), provider: 'codex' };
  broker.record(c, { type: 'run_start', ...run, message: { text: 'Change the file' } });
  await broker.checkpoints.before(c, run);
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'after\n');
  broker.record(c, { type: 'run_end', status: 'complete' });
  broker.checkpoints.after(c, run); await broker.checkpoints.idle();
  let result;
  const route = createCheckpointRoutes({ registry, body: async req => req.input, json: (_res, status, value) => { result = { status, value }; } });
  const call = async (pathname, method = 'GET', input = {}, suffix = '') => { result = null; await route({ req: { method, input }, res: {}, url: new URL(`http://localhost${pathname}?projectId=${project.id}${suffix}`) }); return result; };
  const history = await call('/api/checkpoints');
  assert.equal(history.status, 200);
  assert.equal(history.value.entries[0].provider, 'codex');
  const target = history.value.entries[0].checkpoints[0].target;
  const preview = await call('/api/checkpoints/preview', 'POST', { target });
  assert.equal(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf8'), 'after\n');
  const lease = registry.mutations.acquireMany([workspace], 'parallel test task');
  try { await assert.rejects(call('/api/checkpoints/apply', 'POST', { target, digest: preview.value.digest }), error => error.status === 409); }
  finally { lease.release(); }
  await assert.rejects(call('/api/checkpoints/apply', 'POST', { target, digest: 'stale' }), /Review the changes again/);
  await assert.rejects(call('/api/checkpoints', 'GET', {}, '&task=parallel'), /main workspace conversation/);
  await assert.rejects(call('/api/checkpoints', 'POST'), error => error.status === 405);
  assert.equal((await call('/api/checkpoints/apply', 'POST', { target, digest: preview.value.digest })).status, 200);
  assert.equal(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf8'), 'before\n');
  assert.equal((await call('/api/checkpoints')).value.entries[0].kind, 'restore');
});

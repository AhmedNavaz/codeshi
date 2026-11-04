import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeWithin, SHUTDOWN_LIMIT, writeShutdownLog } from '../desktop/shutdown.mjs';

// Time that moves only when the test says so.
function clock() {
  let time = 1000, pending = null;
  return { now: () => time, timers: { setTimeout: (fn, delay) => { pending = { fn, delay }; return pending; }, clearTimeout: () => { pending = null; } },
    pass(ms) { time += ms; }, expire() { const task = pending; pending = null; task?.fn(); }, get limit() { return pending?.delay; } };
}

test('a shutdown step that never finishes cannot hold the app open, and is written down', async () => {
  const time = clock(), lines = [];
  const closing = closeWithin(({ onStep }) => { onStep({ name: 'reviews', ms: 4 }); return new Promise(() => {}); }, { log: line => lines.push(line), now: time.now, timers: time.timers });
  await new Promise(setImmediate);
  assert.equal(time.limit, SHUTDOWN_LIMIT);
  assert(SHUTDOWN_LIMIT < 120000, 'It gives up well before the installer stops waiting for Codeshi to quit.');
  time.pass(SHUTDOWN_LIMIT); time.expire();
  assert.equal(await closing, false);
  assert.match(lines[0], /stopped waiting: reviews 4 ms\./);
});

test('a quick shutdown forces connections closed and writes nothing', async () => {
  const time = clock(), lines = [];
  let options = null;
  assert.equal(await closeWithin(given => { options = given; return Promise.resolve(); }, { log: line => lines.push(line), now: time.now, timers: time.timers }), true);
  assert.equal(options.force, true, 'The page goes away with the app, so a request in flight has nothing to wait for.');
  assert.deepEqual(lines, []);
  assert.equal(time.limit, undefined, 'The timer is cleared.');
});

test('a slow or failed shutdown is written down with what each step took', async () => {
  const time = clock(), lines = [];
  await closeWithin(({ onStep }) => { onStep({ name: 'workspaces', ms: 3000 }); time.pass(3000); return Promise.resolve(); }, { log: line => lines.push(line), now: time.now, timers: time.timers });
  assert.match(lines[0], /Shutdown took 3000 ms: workspaces 3000 ms\.$/);
  assert.equal(await closeWithin(({ onStep }) => { onStep({ name: 'terminals', ms: 1, error: 'gone' }); return Promise.reject(new Error('gone')); }, { log: line => lines.push(line), now: time.now, timers: time.timers }), true, 'A failed step still counts as finished, so quitting carries on.');
  assert.match(lines[1], /terminals 1 ms \(gone\)\. gone$/);
});

test('the shutdown log stays small, and a log that cannot be written does not stop quitting', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-shutdown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'shutdown.log');
  writeShutdownLog(file, 'first');
  writeShutdownLog(file, 'second');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first\nsecond\n');
  fs.writeFileSync(file, 'x'.repeat(70 * 1024));
  writeShutdownLog(file, 'after');
  assert.equal(fs.readFileSync(file, 'utf8'), 'after\n', 'An oversized log starts again.');
  assert.doesNotThrow(() => writeShutdownLog(path.join(root, 'missing', 'folder', 'shutdown.log'), 'line'));
});

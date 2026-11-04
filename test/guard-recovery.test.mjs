import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { noSymlinks } from './platform.mjs';
import { withFileGuard, processStart, ABANDONED_EMPTY_GUARD_MS } from '../src/mutation-lock.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-guard-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, filename: path.join(root, 'server.lock') };
}
async function holder(t, filename) {
  const child = fork(new URL('./fixtures/guard-client.mjs', import.meta.url), [filename, 'hold'], { stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(filename + '.ready') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(fs.existsSync(filename + '.ready'), 'The child must hold the real guard before continuing.');
  return child;
}
test('a process crash while holding a guard recovers without changing the protected file', async t => {
  const { filename } = fixture(t); fs.writeFileSync(filename, 'saved lock');
  const child = await holder(t, filename), exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  let calls = 0; withFileGuard(filename, () => { calls++; assert.equal(fs.readFileSync(filename, 'utf8'), 'saved lock'); });
  assert.equal(calls, 1); assert(!fs.existsSync(filename + '.guard'));
});
test('an old guard owned by a live process is never expired by age', async t => {
  const { filename } = fixture(t); await holder(t, filename);
  const guard = filename + '.guard', earlier = new Date(Date.now() - 86400000); fs.utimesSync(guard, earlier, earlier);
  const before = fs.readdirSync(guard);
  assert.throws(() => withFileGuard(filename, () => assert.fail('A live owner still holds this guard.')), { status: 409 });
  assert.deepEqual(fs.readdirSync(guard), before);
});
test('a second crash while claiming a dead guard can also recover', async t => {
  const { filename } = fixture(t), first = await holder(t, filename), exited = once(first, 'exit'); first.kill('SIGKILL'); await exited;
  const recovery = fork(new URL('./fixtures/guard-client.mjs', import.meta.url), [filename, 'recover-and-crash'], { stdio: 'ignore' });
  await once(recovery, 'exit'); assert(fs.existsSync(filename + '.claimed'));
  withFileGuard(filename, () => {}); assert(!fs.existsSync(filename + '.guard'));
});
test('concurrent crash recovery serializes every subsequent filesystem transaction', async t => {
  // More than once, because recovering processes collide differently each time.
  for (let round = 0; round < 3; round++) {
    const { root, filename } = fixture(t), counter = path.join(root, 'counter'); fs.writeFileSync(counter, '0');
    const child = await holder(t, filename), exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const workers = Array.from({ length: 8 }, () => fork(new URL('./fixtures/guard-client.mjs', import.meta.url), [filename, 'increment', counter], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    const results = await Promise.all(workers.map(async worker => { let error = ''; worker.stderr.on('data', chunk => { error += chunk; }); const [code] = await once(worker, 'exit'); assert.equal(code, 0, error); }));
    assert.equal(results.length, 8); assert.equal(fs.readFileSync(counter, 'utf8'), '64'); assert(!fs.existsSync(filename + '.guard'));
    assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('.guard')), [], 'Nothing is left behind.');
  }
});
// Marker names for processes that are running (this one) and that have exited.
const uuid = () => randomUUID();
const liveMarker = () => `owner-${process.pid}-${processStart(process.pid) ? Buffer.from(processStart(process.pid)).toString('base64url') : 'none'}-${uuid()}.json`;
const deadMarker = () => `owner-${spawnSync(process.execPath, ['-e', '']).pid}-none-${uuid()}.json`;
test('a recovering process that finds another at work backs off, then recovers once it has gone', t => {
  const { filename } = fixture(t), guard = filename + '.guard', dead = deadMarker(), other = liveMarker();
  fs.mkdirSync(guard); fs.writeFileSync(path.join(guard, dead), '{}'); fs.writeFileSync(path.join(guard, other), '{}');
  assert.throws(() => withFileGuard(filename, () => assert.fail('Another process is recovering this guard.')), { status: 409 });
  assert.deepEqual(fs.readdirSync(guard).sort(), [dead, other].sort(), 'It takes its own claim back and touches nothing else.');
  fs.unlinkSync(path.join(guard, other));
  let calls = 0; withFileGuard(filename, () => { calls++; }); assert.equal(calls, 1); assert(!fs.existsSync(guard));
});
test('markers from several crashed processes do not block recovery, but anything unidentifiable among them does', t => {
  const { filename } = fixture(t), guard = filename + '.guard', first = deadMarker(), second = deadMarker();
  fs.mkdirSync(guard); fs.writeFileSync(path.join(guard, first), '{}'); fs.writeFileSync(path.join(guard, second), '{}');
  fs.writeFileSync(path.join(guard, 'unknown'), 'preserve');
  assert.throws(() => withFileGuard(filename, () => assert.fail()), { status: 409 });
  assert.deepEqual(fs.readdirSync(guard).sort(), [first, second, 'unknown'].sort());
  fs.unlinkSync(path.join(guard, 'unknown'));
  const folder = deadMarker(); fs.mkdirSync(path.join(guard, folder));
  assert.throws(() => withFileGuard(filename, () => assert.fail()), { status: 409 }, 'A folder is not a marker, whatever its name.');
  fs.rmdirSync(path.join(guard, folder));
  withFileGuard(filename, () => {}); assert(!fs.existsSync(guard));
});
test('a claim that cannot be written is tried again, and the guard stays protected until one can', t => {
  // macOS answers EINVAL when the folder is being retired by another process at that moment.
  const { filename } = fixture(t), guard = filename + '.guard', dead = deadMarker(), write = fs.writeFileSync;
  fs.mkdirSync(guard); write(path.join(guard, dead), '{}');
  let refusals = 0, always = true;
  fs.writeFileSync = function (file, ...args) { if (String(file).includes(path.join(filename + '.guard', 'owner-')) && (always || refusals < 2)) { refusals++; throw Object.assign(new Error('Directory changed'), { code: 'EINVAL' }); } return write.call(fs, file, ...args); };
  try {
    assert.throws(() => withFileGuard(filename, () => assert.fail()), { status: 409 });
    assert.deepEqual(fs.readdirSync(guard), [dead], 'Nothing was removed.');
    always = false; refusals = 0;
    let calls = 0; withFileGuard(filename, () => { calls++; }); assert.equal(calls, 1); assert.equal(refusals, 2);
  } finally { fs.writeFileSync = write; }
  assert(!fs.existsSync(guard));
});
test('releasing a guard outlasts a moment when it cannot be renamed, and survives what others left in it', t => {
  const { root, filename } = fixture(t), guard = filename + '.guard', rename = fs.renameSync;
  let refusals = 0;
  fs.renameSync = (source, destination) => { if (source === guard && refusals < 2) { refusals++; throw Object.assign(new Error('In use'), { code: 'EPERM' }); } return rename.call(fs, source, destination); };
  try { withFileGuard(filename, () => {}); } finally { fs.renameSync = rename; }
  assert.equal(refusals, 2); assert(!fs.existsSync(guard));
  withFileGuard(filename, () => fs.writeFileSync(path.join(guard, deadMarker()), '{}'));
  assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('.guard')), [], 'A file left by a process that backed off goes with the guard.');
  withFileGuard(filename, () => fs.rmSync(guard, { recursive: true }));
  assert(!fs.existsSync(guard), 'A guard removed by hand while held is simply released.');
  const stale = filename + '.guard.retired-left-behind'; fs.mkdirSync(stale); const old = new Date(Date.now() - 120000); fs.utimesSync(stale, old, old);
  withFileGuard(filename, () => {}); assert(!fs.existsSync(stale), 'A retired folder that could not be removed is swept once it is old.');
});
test('a guard that stays in use is reported rather than ignored', t => {
  const { filename } = fixture(t), guard = filename + '.guard', rename = fs.renameSync;
  fs.renameSync = (source, destination) => { if (source === guard) throw Object.assign(new Error('In use'), { code: 'EPERM' }); return rename.call(fs, source, destination); };
  try { assert.throws(() => withFileGuard(filename, () => {}), { code: 'EPERM' }); } finally { fs.renameSync = rename; }
  assert(fs.existsSync(guard)); fs.rmSync(guard, { recursive: true });
});
test('a guard never exists without its owner, and an empty one left by an earlier version is replaced at once', { skip: process.platform === 'win32' }, t => {
  const { filename } = fixture(t), guard = filename + '.guard'; fs.mkdirSync(guard);
  assert.equal(withFileGuard(filename, () => fs.readdirSync(guard).filter(name => name.startsWith('owner-')).length), 1, 'The guard holds its owner from the moment it exists.');
  assert(!fs.existsSync(guard));
  fs.mkdirSync(guard); fs.writeFileSync(path.join(guard, 'unknown'), 'preserve');
  assert.throws(() => withFileGuard(filename, () => assert.fail()), { status: 409 }, 'Unknown contents stay protected.');
  assert.equal(fs.readFileSync(path.join(guard, 'unknown'), 'utf8'), 'preserve');
  fs.unlinkSync(path.join(guard, 'unknown'));
  const marker = `owner-${process.pid}-${Buffer.from('unrecognized start time').toString('base64url')}-00000000-0000-4000-8000-000000000000.json`; fs.writeFileSync(path.join(guard, marker), '{}');
  assert.throws(() => withFileGuard(filename, () => assert.fail()), { status: 409 }); assert(fs.existsSync(path.join(guard, marker)));
  // A staging folder left by a process stopped before its rename is swept once it is old.
  fs.rmSync(guard, { recursive: true }); const stale = filename + '.guard.new-left-behind'; fs.mkdirSync(stale);
  const old = new Date(Date.now() - 120000); fs.utimesSync(stale, old, old);
  withFileGuard(filename, () => {}); assert(!fs.existsSync(stale));
});
test('guard symlinks never redirect automatic recovery into another folder', { skip: noSymlinks }, t => {
  const { root, filename } = fixture(t), target = path.join(root, 'target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'preserve'); fs.symlinkSync(target, filename + '.guard');
  assert.throws(() => withFileGuard(filename, () => assert.fail()), { status: 409 }); assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'preserve'); assert(fs.lstatSync(filename + '.guard').isSymbolicLink());
});
test('a reused process ID is distinguished from the guard’s recorded process start', t => {
  if (!processStart(process.pid)) return t.skip('Process start identity is currently available on macOS.');
  const { filename } = fixture(t), guard = filename + '.guard'; fs.mkdirSync(guard);
  const earlier = Buffer.from('Thu Jan  1 00:00:00 1970').toString('base64url');
  fs.writeFileSync(path.join(guard, `owner-${process.pid}-${earlier}-00000000-0000-4000-8000-000000000000.json`), '{}');
  withFileGuard(filename, () => {}); assert(!fs.existsSync(guard));
});
test('failed ownership writes and callback errors release the guard', t => {
  const { filename } = fixture(t), original = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) { if (String(file).includes(filename + '.guard.new-') && String(file).includes(path.sep + 'owner-')) throw Object.assign(new Error('Full disk'), { code: 'ENOSPC' }); return original.call(fs, file, ...args); };
  try { assert.throws(() => withFileGuard(filename, () => assert.fail()), { code: 'ENOSPC' }); } finally { fs.writeFileSync = original; }
  assert(!fs.existsSync(filename + '.guard')); assert.deepEqual(fs.readdirSync(path.dirname(filename)).filter(name => name.includes('.guard')), [], 'No staging folder is left behind.');
  assert.throws(() => withFileGuard(filename, () => { throw new Error('Transaction failed'); }), /Transaction failed/);
  assert(!fs.existsSync(filename + '.guard')); withFileGuard(filename, () => {});
});

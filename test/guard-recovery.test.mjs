import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
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
  const { root, filename } = fixture(t), counter = path.join(root, 'counter'); fs.writeFileSync(counter, '0');
  const child = await holder(t, filename), exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const workers = Array.from({ length: 8 }, () => fork(new URL('./fixtures/guard-client.mjs', import.meta.url), [filename, 'increment', counter], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const results = await Promise.all(workers.map(async worker => { let error = ''; worker.stderr.on('data', chunk => { error += chunk; }); const [code] = await once(worker, 'exit'); assert.equal(code, 0, error); }));
  assert.equal(results.length, 8); assert.equal(fs.readFileSync(counter, 'utf8'), '64'); assert(!fs.existsSync(filename + '.guard'));
});
test('a lost recovery claim retries macOS rename races without hiding other rename failures',async t=>{
  for(const disappeared of [true,false]) {
    const {filename}=fixture(t),child=await holder(t,filename),exited=once(child,'exit');child.kill('SIGKILL');await exited;
    const rename=fs.renameSync;let injected=false;
    fs.renameSync=(source,destination)=>{if(!injected&&String(source).includes(path.join(filename+'.guard','owner-'))){injected=true;if(disappeared){fs.unlinkSync(source);fs.rmdirSync(filename+'.guard');}throw Object.assign(new Error('Directory changed during rename'),{code:'EINVAL'});}return rename.call(fs,source,destination);};
    try {if(disappeared)withFileGuard(filename,()=>{});else assert.throws(()=>withFileGuard(filename,()=>assert.fail()),{code:'EINVAL'});}finally{fs.renameSync=rename;}
    assert(injected);if(!disappeared){assert(fs.existsSync(filename+'.guard'));withFileGuard(filename,()=>{});}assert(!fs.existsSync(filename+'.guard'));
  }
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importBackup, readBackup } from '../src/backup.mjs';
import { createMoveReceiver, createMoveRoutes, createMoveSender, formatCode, localAddresses, parseCode, privateAddress, sweepMoves } from '../src/move.mjs';
import { ProjectRegistry } from '../src/projects.mjs';

const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-move-')));
const noOrigin = () => null;
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
// The old computer: one workspace with a conversation. Both sides run here, over loopback.
async function computers() {
  const root = temporary(), folder = path.join(root, 'code', 'app'); fs.mkdirSync(folder, { recursive: true });
  const registry = new ProjectRegistry({ dataRoot: path.join(root, 'old'), lock: false });
  const project = registry.add({ folders: [folder], name: 'My app' });
  const broker = registry.broker(project.id), conversation = broker.get(registry.mainConversationId(project.id));
  broker.message(conversation, 'user', 'Moving this conversation');
  await registry.close();
  const target = new ProjectRegistry({ dataRoot: path.join(root, 'new'), lock: false }); fs.mkdirSync(target.dataRoot, { recursive: true });
  const sender = createMoveSender({ registry, settings: () => ({ appearance: 'dark' }), addresses: () => ['127.0.0.1'], host: '127.0.0.1' });
  const receiver = createMoveReceiver({ registry: target, allowLoopback: true, checkEvery: 20 });
  return { root, folder, registry, project, target, sender, receiver };
}

test('move codes are an address, a port and 80 bits, typed loosely and only for a local network', () => {
  const secret = Buffer.from('00112233445566778899', 'hex'), code = formatCode('192.168.1.20', 52143, secret);
  assert.match(code, /^192\.168\.1\.20:52143\/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const parsed = parseCode(`  the code is ${code.toLowerCase().replace(/-/g, ' ')}  thanks`);
  assert.deepEqual([parsed.address, parsed.port, parsed.secret.toString('hex')], ['192.168.1.20', 52143, '00112233445566778899']);
  // O, I and L read as 0, 1 and 1, as Crockford's alphabet has none of them.
  const letters = code.split('/')[1];
  assert.equal(parseCode(`192.168.1.20:52143/${letters.replace(/0/g, 'O').replace(/1/g, 'l')}`).secret.toString('hex'), '00112233445566778899');
  assert.throws(() => parseCode('8.8.8.8:52143/' + letters), /isn’t on a local network/);
  assert.throws(() => parseCode('127.0.0.1:52143/' + letters), /isn’t on a local network/);
  assert.throws(() => parseCode('192.168.1.20:80/' + letters), /isn’t complete/);
  assert.throws(() => parseCode('192.168.1.20:52143/ABCD-EFGH'), /Type the whole move code/);
  assert.throws(() => parseCode('192.168.1.20:52143/UUUU-UUUU-UUUU-UUUU'), /letters after the slash/);
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.0.1', '169.254.1.1', '100.64.0.1']) assert.equal(privateAddress(address), true, address);
  for (const address of ['172.32.0.1', '8.8.8.8', '127.0.0.1', '100.128.0.1', '192.168.1', '1.2.3.4.5', '010.0.0.1x']) assert.equal(privateAddress(address), false, address);
  assert.deepEqual(localAddresses({ lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], utun3: [{ family: 'IPv4', address: '100.70.1.2', internal: false }], en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.20', internal: false }], vpn: [{ family: 'IPv4', address: '203.0.113.5', internal: false }] }), ['192.168.1.20', '100.70.1.2']);
});

test('a move is sent only after Allow, both sides show the same digits, and it imports as a backup', async () => {
  const c = await computers();
  const started = await c.sender.start({ workspaces: [{ id: c.project.id }], includeSettings: true });
  assert.equal(started.state, 'waiting');
  assert.ok(fs.readdirSync(c.registry.dataRoot).some(name => name.startsWith('.move-')), 'the backup waits in the data folder');
  const asking = await c.receiver.connect(started.codes[0]);
  assert.equal(asking.state, 'asking');
  assert.equal(asking.path, undefined, 'nothing arrives before Allow');
  const request = c.sender.view().requests[0];
  assert.equal(request.check, asking.check);
  assert.match(request.check, /^\d{6}$/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.receiver.view().state, 'asking');

  c.sender.allow(request.id);
  const ready = await until(() => { const view = c.receiver.view(); return view.state === 'ready' && view; });
  assert.equal(ready.received, ready.bytes);
  assert.equal(c.sender.view().state, 'sent');
  const read = await readBackup({ registry: c.target, file: ready.path, passphrase: ready.passphrase, origin: noOrigin });
  assert.deepEqual(read.workspaces.map(item => item.name), ['My app']);
  assert.deepEqual(read.settings, ['appearance']);
  const imported = await importBackup({ registry: c.target, file: ready.path, passphrase: ready.passphrase, workspaces: [{ key: 'w1', folders: { [c.project.folders[0].id]: c.folder } }], origin: noOrigin });
  assert.equal(imported.workspaces[0].created, true);
  const moved = c.target.get(imported.workspaces[0].id);
  assert.match(fs.readFileSync(path.join(c.target.dataRoot, moved.id, `${moved.conversationId}.jsonl`), 'utf8'), /Moving this conversation/);

  // The listener closes after sending and its backup is deleted; the received copy goes when you're done.
  await until(() => !fs.readdirSync(c.registry.dataRoot).some(name => name.startsWith('.move-')));
  c.receiver.stop();
  assert.equal(fs.existsSync(ready.path), false);
  await c.target.close();
});

test('a wrong code is refused, Deny turns a computer away, and stopping ends the move for the other side', async () => {
  const c = await computers();
  const { codes } = await c.sender.start({ workspaces: [{ id: c.project.id }] });
  const [where, letters] = codes[0].split('/'), wrong = `${where}/${letters[0] === 'A' ? 'B' : 'A'}${letters.slice(1)}`;
  await assert.rejects(c.receiver.connect(wrong), error => error.status === 403 && /isn’t right/.test(error.message));
  assert.equal(c.sender.view().requests.length, 0);

  await c.receiver.connect(codes[0]);
  c.sender.deny(c.sender.view().requests[0].id);
  assert.equal((await until(() => { const view = c.receiver.view(); return view.state === 'denied' && view; })).path, undefined);

  // A second computer asks; then the move is stopped before anyone is allowed.
  await c.receiver.connect(codes[0]);
  assert.equal(c.sender.view().requests.length, 2);
  c.sender.stop();
  const failed = await until(() => { const view = c.receiver.view(); return view.state === 'failed' && view; });
  assert.match(failed.error, /ended on the other computer|Couldn’t reach/);
  assert.equal(fs.readdirSync(c.registry.dataRoot).some(name => name.startsWith('.move-')), false);
  await assert.rejects(c.receiver.connect(codes[0]), /ended on the other computer|Couldn’t reach/);
  c.receiver.stop();
  assert.equal(fs.readdirSync(c.target.dataRoot).some(name => name.startsWith('.move-')), false);
  await c.target.close();
});

test('too many wrong codes close the move', async () => {
  const c = await computers();
  const { codes } = await c.sender.start({ workspaces: [{ id: c.project.id }] });
  const [where, letters] = codes[0].split('/');
  for (let index = 0; index < 20; index++) {
    const swapped = `${where}/${letters.slice(0, -1)}${letters.at(-1) === 'A' ? 'B' : 'A'}`;
    await assert.rejects(c.receiver.connect(swapped));
  }
  assert.equal(c.sender.view().state, 'failed');
  assert.match(c.sender.view().error, /Too many connections with a wrong code/);
  await c.target.close();
});

test('the routes refuse the phone, and leftover move files are swept', async () => {
  const root = temporary();
  fs.writeFileSync(path.join(root, '.move-old.codeshibackup'), 'x'); fs.writeFileSync(path.join(root, '..move-old.codeshibackup.1234.partial'), 'x'); fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  sweepMoves(root);
  assert.deepEqual(fs.readdirSync(root), ['settings.json']);
  const routes = createMoveRoutes({ registry: { dataRoot: root }, body: async () => ({}), json: (res, status, data) => Object.assign(res, { status, data }), settings: () => ({}), sender: { view: () => ({ state: 'idle' }), close() {} }, receiver: { view: () => ({ state: 'idle' }), close() {} } });
  const call = async (method, pathname, extra = {}) => { const res = {}; const handled = await routes({ req: { method, ...extra }, res, url: new URL(`http://x${pathname}`) }); return { handled, ...res }; };
  assert.equal((await call('GET', '/api/backup')).handled, false);
  assert.deepEqual((await call('GET', '/api/move/send')).data, { state: 'idle' });
  await assert.rejects(call('GET', '/api/move/send', { phoneClient: true }), error => error.status === 403);
  await assert.rejects(call('GET', '/api/move/other'), error => error.status === 404);
  await assert.rejects(call('POST', '/api/move/send/unknown'), error => error.status === 404);
});

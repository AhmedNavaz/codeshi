import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createSharingServer } from '../server.mjs';
import { SharingClient, validateSharingURL } from '../../src/sharing-client.mjs';
import { sealPackage, sealSolution, sha256, canonicalStringify } from '../../src/collaboration-format.mjs';

const caps = () => ({ view: randomBytes(32).toString('base64url'), submit: randomBytes(32).toString('base64url'), owner: randomBytes(32).toString('base64url') });
function handoff() {
  const content = 'export const total = 1;\n';
  return sealPackage({ schema: 'ai-relay.handoff', version: 1, id: randomUUID(), createdAt: new Date().toISOString(),
    mode: 'source', goal: 'Fix the calculation', problem: 'The result is incorrect.', expectedOutcome: 'The result is 2.',
    decisions: ['Preserve the existing interface.'], tasks: ['Fix total.'], messages: [{ role: 'user', text: 'Please help with this calculation.' }],
    files: [{ path: 'src/total.js', content, sha256: sha256(content) }], baseline: [{ path: 'src/total.js', sha256: sha256(content) }] });
}
function solution(pkg, extra = {}) {
  return sealSolution({ schema: 'ai-relay.solution', version: 1, id: randomUUID(), handoffId: pkg.id,
    createdAt: new Date().toISOString(), explanation: 'Update total while preserving the export.', assumptions: [],
    verification: ['Contributor reports: inspected the replacement.'], patch: { format: 'ai-relay.text.v1', files: [
      { path: 'src/total.js', baseHash: pkg.baseline[0].sha256, content: 'export const total = 2;\n' },
    ] }, ...extra });
}
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-relay-sharing-'));
  const dataDir = path.join(directory, 'remote');
  const apps = [];
  const launch = async () => {
    const app = createSharingServer({ dataDir, ...options });
    apps.push(app); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    return { app, url: `http://127.0.0.1:${app.server.address().port}` };
  };
  t.after(async () => { for (const app of apps.reverse()) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...await launch(), launch, directory, dataDir };
}
function request(base, route, token, method = 'GET', value) {
  return fetch(`${base}${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}

test('private link round trip returns exact patches without importing or calling a provider', async t => {
  const f = await fixture(t);
  const pkg = handoff();
  const storePath = path.join(f.directory, 'local', 'delivery.json');
  const client = new SharingClient({ baseUrl: f.url, storePath });
  const record = await client.publish(pkg, { requestId: pkg.id });
  assert.equal(record.status, 'active'); assert.equal(record.localOnly, true);
  assert.equal(new URL(record.viewURL).search, '');
  const link = new URL(record.viewURL);
  const fragment = new URLSearchParams(link.hash.slice(1));
  assert.equal(fragment.get('view'), record.viewToken); assert.equal(fragment.get('submit'), record.submitToken);
  assert.equal(record.viewURL.includes(record.ownerToken), false);
  const page = await fetch(`${f.url}${link.pathname}`);
  assert.equal(page.status, 200); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /uses? your own|using your own/);
  const format = await fetch(`${f.url}/format.mjs`);
  assert.equal(format.status, 200);
  assert.match(format.headers.get('content-type'), /javascript/);
  assert.equal(await format.text(), fs.readFileSync(new URL('../../src/collaboration-format.mjs', import.meta.url), 'utf8'));
  const base = `/api/requests/${record.remoteId}`;
  assert.equal((await request(f.url, base)).status, 403);
  assert.equal((await request(f.url, base, record.submitToken)).status, 403);
  assert.equal((await request(f.url, `${base}/solutions`, record.viewToken)).status, 403);
  const viewed = await (await request(f.url, base, record.viewToken)).json();
  assert.deepEqual(viewed.package, pkg); assert.equal('tokenHashes' in viewed, false);
  assert.deepEqual(await (await request(f.url, `${base}/package`, record.viewToken)).json(), pkg);
  const source = await request(f.url, `${base}/source?path=src%2Ftotal.js`, record.viewToken);
  assert.equal(await source.text(), pkg.files[0].content);
  assert.equal((await request(f.url, `${base}/source?path=../../etc/passwd`, record.viewToken)).status, 404);
  const returned = solution(pkg);
  assert.equal((await request(f.url, `${base}/solutions`, record.submitToken, 'POST', returned)).status, 201);
  const result = await client.retrieve(record);
  assert.deepEqual(result.solutions, [returned]);
  const restarted = new SharingClient({ baseUrl: f.url, storePath });
  assert.deepEqual(restarted.status(pkg.id).solutions, [returned]);
  const disk = fs.readFileSync(path.join(f.dataDir, `${record.remoteId}.json`), 'utf8');
  for (const capability of [record.viewToken, record.submitToken, record.ownerToken]) assert.equal(disk.includes(capability), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
  for (const filename of ['server.mjs', 'store.mjs']) {
    const code = fs.readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /(?:from|import\s*)\s*['"][^'"]*(?:broker|provider|child_process)/);
  }
});

test('lost upload responses retry from durable state without duplicate uploads or solutions', async t => {
  const f = await fixture(t); const pkg = handoff(); const storePath = path.join(f.directory, 'client.json');
  let dropped = false;
  const interrupted = new SharingClient({ baseUrl: f.url, storePath, fetchImpl: async (...args) => {
    const response = await fetch(...args);
    if (!dropped) { dropped = true; await response.text(); throw new Error('connection ended after accepted upload'); }
    return response;
  } });
  await assert.rejects(interrupted.publish(pkg), error => error.retryable === true);
  const pending = interrupted.status(pkg.id); assert.equal(pending.status, 'pending');
  const resumed = new SharingClient({ baseUrl: f.url, storePath });
  const record = await resumed.publish(pkg);
  assert.equal(record.uploadId, pending.uploadId); assert.equal(record.ownerToken, pending.ownerToken);
  assert.equal(f.app.store.records.size, 1);
  assert.equal((await resumed.publish(pkg)).remoteId, record.remoteId);
  const returned = solution(pkg); const route = `/api/requests/${record.remoteId}/solutions`;
  assert.equal((await request(f.url, route, record.submitToken, 'POST', returned)).status, 201);
  assert.equal((await request(f.url, route, record.submitToken, 'POST', returned)).status, 200);
  const changed = sealSolution({ ...returned, explanation: 'Different contents under the same ID.' });
  assert.equal((await request(f.url, route, record.submitToken, 'POST', changed)).status, 409);
  assert.equal((await resumed.retrieve(record)).solutions.length, 1);
  const tampered = await request(f.url, '/api/requests', null, 'POST', { uploadId: record.uploadId,
    package: pkg, expiresInSeconds: record.expiresInSeconds, capabilities: caps() });
  assert.equal(tampered.status, 409);
});

test('expiration and revocation erase remote material and return gone while owner revocation is idempotent', async t => {
  let clock = Date.now(); const f = await fixture(t, { now: () => clock }); const pkg = handoff();
  const client = new SharingClient({ baseUrl: f.url });
  const expired = await client.publish(pkg, { expiresInSeconds: 60 });
  clock += 61000;
  const base = `/api/requests/${expired.remoteId}`;
  for (const route of [base, `${base}/package`, `${base}/source?path=src/total.js`]) assert.equal((await request(f.url, route, expired.viewToken)).status, 410);
  assert.equal((await request(f.url, `${base}/solutions`, expired.submitToken, 'POST', solution(pkg))).status, 410);
  await assert.rejects(client.retrieve(expired), error => error.status === 410);
  assert.equal(client.status(pkg.id).status, 'expired'); assert.equal(f.app.store.records.get(expired.remoteId).package, null);
  const active = await client.publish(handoff());
  assert.equal((await client.revoke(active)).status, 'revoked'); assert.equal((await client.revoke(active)).status, 'revoked');
  assert.equal((await request(f.url, `/api/requests/${active.remoteId}`, active.viewToken)).status, 410);
  const stored = f.app.store.records.get(active.remoteId); assert.equal(stored.package, null); assert.deepEqual(stored.solutions, []);
});

test('rejects malformed, altered, unsafe or over-limit submissions and enforces deployment creation key', async t => {
  const f = await fixture(t, { createKey: 'deployment-only-key', maxSolutions: 1 }); const pkg = handoff();
  const unauthorized = new SharingClient({ baseUrl: f.url });
  await assert.rejects(unauthorized.publish(pkg), error => error.status === 403);
  const client = new SharingClient({ baseUrl: f.url, createKey: 'deployment-only-key' });
  const record = await client.publish(pkg); const route = `/api/requests/${record.remoteId}/solutions`;
  const malformed = await fetch(`${f.url}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${record.submitToken}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const good = solution(pkg); const changed = { ...good, explanation: 'Changed without a new hash.' };
  assert.equal((await request(f.url, route, record.submitToken, 'POST', changed)).status, 400);
  const unsafe = { ...good, patch: { format: 'ai-relay.text.v1', files: [{ path: '../../outside.txt', baseHash: null, content: 'bad' }] } };
  const { integrity, ...base } = unsafe; unsafe.integrity = sha256(canonicalStringify(base));
  assert.equal((await request(f.url, route, record.submitToken, 'POST', unsafe)).status, 400);
  assert.equal((await request(f.url, route, record.submitToken, 'POST', solution(handoff()))).status, 400);
  assert.equal((await request(f.url, route, record.submitToken, 'POST', good)).status, 201);
  assert.equal((await request(f.url, route, record.submitToken, 'POST', solution(pkg))).status, 413);
  assert.equal((await fetch(`${f.url}/api/requests`, { method: 'OPTIONS' })).status, 403);
  assert.equal((await request(f.url, `/api/requests/${randomUUID()}`, record.viewToken)).status, 404);
});

test('limits storage and active request counts without model availability', async t => {
  const f = await fixture(t, { maxRequests: 1 }); const client = new SharingClient({ baseUrl: f.url });
  const first = await client.publish(handoff());
  await assert.rejects(client.publish(handoff()), error => error.status === 507);
  await client.revoke(first);
  assert.equal((await client.publish(handoff())).status, 'active');
  const small = await fixture(t, { maxStorageBytes: 10 });
  await assert.rejects(new SharingClient({ baseUrl: small.url }).publish(handoff()), error => error.status === 507);
  assert.equal(small.app.store.records.size, 0);
});

test('service restart preserves private requests and returned solutions', async t => {
  const f = await fixture(t); const pkg = handoff(); const client = new SharingClient({ baseUrl: f.url });
  const record = await client.publish(pkg); const returned = solution(pkg, { patch: { format: 'ai-relay.text.v1', files: [] } });
  await request(f.url, `/api/requests/${record.remoteId}/solutions`, record.submitToken, 'POST', returned);
  await f.app.close(); const restarted = await f.launch();
  const response = await request(restarted.url, `/api/requests/${record.remoteId}/solutions`, record.ownerToken);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).solutions, [returned]);
});

test('production transport rejects plaintext external origins, credentials and redirects', async () => {
  for (const url of ['http://example.com', 'ftp://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?key=value']) assert.throws(() => validateSharingURL(url));
  assert.equal(validateSharingURL('https://example.com/'), 'https://example.com');
  assert.equal(validateSharingURL('http://127.0.0.1:4319'), 'http://127.0.0.1:4319');
  let calls = 0;
  const client = new SharingClient({ baseUrl: 'https://example.com', fetchImpl: async (_url, options) => {
    calls++; assert.equal(options.redirect, 'error'); throw new Error('offline');
  } });
  const pkg = handoff(); await assert.rejects(client.publish(pkg), error => error.retryable === true);
  assert.equal(calls, 1); assert.equal(client.status(pkg.id).status, 'pending');
});

test('simultaneous solution uploads retain both submissions', async t => {
  const f = await fixture(t); const pkg = handoff(); const client = new SharingClient({ baseUrl: f.url });
  const record = await client.publish(pkg); const values = [solution(pkg), solution(pkg)];
  const responses = await Promise.all(values.map(value => request(f.url, `/api/requests/${record.remoteId}/solutions`, record.submitToken, 'POST', value)));
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  const received = await client.retrieve(record);
  assert.deepEqual(received.solutions.map(value => value.id).sort(), values.map(value => value.id).sort());
});

test('combined solution responses remain bounded at 2 MiB', async t => {
  const f = await fixture(t); const pkg = handoff(); const client = new SharingClient({ baseUrl: f.url });
  const record = await client.publish(pkg); const route = `/api/requests/${record.remoteId}/solutions`;
  for (let i = 0; i < 8; i++) {
    const value = solution(pkg, { patch: { format: 'ai-relay.text.v1', files: [
      { path: 'src/total.js', baseHash: pkg.baseline[0].sha256, content: 'x'.repeat(256 * 1024) },
    ] } });
    const response = await request(f.url, route, record.submitToken, 'POST', value);
    assert.equal(response.status, i < 7 ? 201 : 413);
  }
  const response = await request(f.url, route, record.ownerToken);
  const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024);
  assert.equal(JSON.parse(text).solutions.length, 7);
});

test('HTTP body limit rejects oversized uploads before saving content', async t => {
  const f = await fixture(t);
  let rejected = false;
  try {
    const response = await fetch(`${f.url}/api/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oversized: 'x'.repeat(2 * 1024 * 1024 + 1) }) });
    assert.equal(response.status, 413); rejected = true;
  } catch (error) {
    // Node can close an over-limit incoming stream before its peer receives the error body.
    if (error.cause?.code === 'ECONNRESET' || error.cause?.code === 'UND_ERR_SOCKET') rejected = true;
    else throw error;
  }
  assert.equal(rejected, true); assert.equal(f.app.store.records.size, 0);
});

test('a binary source downloads as its bytes and a binary solution returns intact (#25)', async t => {
  const f = await fixture(t);
  const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
  const content = logo.toString('base64'), hash = sha256(new Uint8Array(logo));
  const pkg = sealPackage({ schema: 'ai-relay.handoff', version: 1, id: randomUUID(), createdAt: new Date().toISOString(),
    mode: 'source', goal: 'Replace the logo', problem: 'It is blurry.', expectedOutcome: 'A sharp logo.', decisions: [], tasks: [], messages: [],
    files: [{ path: 'assets/logo.png', content, sha256: hash, encoding: 'base64' }], baseline: [{ path: 'assets/logo.png', sha256: hash }] });
  const client = new SharingClient({ baseUrl: f.url, storePath: path.join(f.directory, 'local', 'delivery.json') });
  const record = await client.publish(pkg, { requestId: pkg.id });
  const base = `/api/requests/${record.remoteId}`;
  const source = await request(f.url, `${base}/source?path=assets%2Flogo.png`, record.viewToken);
  assert.equal(source.headers.get('content-type'), 'application/octet-stream');
  assert(Buffer.from(await source.arrayBuffer()).equals(logo));
  const sharp = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 3, 4, 5]).toString('base64');
  const returned = solution(pkg, { patch: { format: 'ai-relay.files.v1', files: [{ path: 'assets/logo.png', baseHash: hash, content: sharp, encoding: 'base64' }] } });
  assert.equal((await request(f.url, `${base}/solutions`, record.submitToken, 'POST', returned)).status, 201);
  assert.deepEqual((await client.retrieve(record)).solutions, [returned]);
});

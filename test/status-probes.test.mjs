import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { accountStatus } from '../src/providers.mjs';
import { Broker } from '../src/broker.mjs';

function fixture(t, { stage = '', output = '{"loggedIn":true,"authMethod":"oauth"}', code = 0, authCode = 0, wait = 3000, keep = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-probes-'));
  const bin = path.join(root, 'fake-cli');
  fs.writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const root = ${JSON.stringify(root)}, stage = process.argv[2] === '--version' ? 'version' : 'auth';
fs.appendFileSync(root + '/calls', stage + '\\n');
if (stage === ${JSON.stringify(stage)}) {
  fs.writeFileSync(root + '/started.' + process.pid, String(process.pid)); fs.renameSync(root + '/started.' + process.pid, root + '/started');
  const until = Date.now() + ${wait};
  while (!fs.existsSync(root + '/release') && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
process.stdout.write(stage === 'version' ? '  fake 1.0\\n' : ${JSON.stringify(output)});
process.exit(stage === 'version' ? ${code} : ${authCode});\n`, { mode: 0o755 });
  if (!keep) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, bin };
}
// Makes every CLI check the broker has made look older by ms.
const later = (broker, ms) => { for (const check of Object.values(broker.providerChecks)) check.at -= ms; };
async function waitFor(filename) {
  for (let i = 0; i < 500; i++) { if (fs.existsSync(filename)) return; await delay(10); }
  assert.fail('Fake CLI did not start');
}
for (const [route, stage] of [['/api/providers/claude/account', 'version'], ['/api/providers/claude/account', 'auth'], ['/api/status', 'version']]) {
  test(`${route} keeps HTTP responsive during ${stage}`, { skip: scriptCLIs }, async t => {
    const f = fixture(t, { stage, keep: true });
    const child = fork(new URL('./fixtures/status-server.mjs', import.meta.url), [], { env: { ...process.env, TEST_ROOT: f.root, AI_RELAY_CLAUDE_BIN: f.bin, AI_RELAY_CODEX_BIN: f.bin }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(async () => {
      fs.writeFileSync(f.root + '/release', '');
      if (child.exitCode === null) { child.send('close'); await once(child, 'exit'); }
      fs.rmSync(f.root, { recursive: true, force: true });
    });
    const [ready] = await once(child, 'message');
    const base = `http://127.0.0.1:${ready.port}`;
    const pending = fetch(base + route).then(r => r.json());
    const concurrent = route === '/api/status' ? fetch(base + route).then(r => r.json()) : null;
    await waitFor(f.root + '/started');
    try {
      const response = await fetch(base + '/api/projects', { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      assert.equal(fs.existsSync(f.root + '/release'), false);
      assert.doesNotThrow(() => process.kill(Number(fs.readFileSync(f.root + '/started', 'utf8')), 0), 'probe remains alive behind the release barrier');
    } finally { fs.writeFileSync(f.root + '/release', ''); }
    const result = await pending;
    if (concurrent) assert.deepEqual((await concurrent).providers, result.providers);
    assert.equal(route === '/api/status' ? result.providers.claude.available : result.installed, true);
    if (route === '/api/status') {
      await fetch(base + route);
      assert.equal(fs.readFileSync(f.root + '/calls', 'utf8').trim().split('\n').length, 2, 'warm cache does not spawn again');
    }
  });
}
test('account probe preserves version, authentication and malformed/error results', { skip: scriptCLIs }, async t => {
  const good = fixture(t);
  const result = await accountStatus('claude', { bin: good.bin });
  assert.equal(result.version, 'fake 1.0'); assert.equal(result.authenticated, true); assert.equal(result.billingSource, 'subscription');
  const malformed = fixture(t, { output: 'not json' });
  assert.equal((await accountStatus('claude', { bin: malformed.bin })).authenticated, 'unknown');
  const failed = fixture(t, { code: 1 });
  assert.equal((await accountStatus('claude', { bin: failed.bin })).errorCategory, 'installation');
  assert.equal((await accountStatus('claude', { bin: good.root + '/missing' })).errorCategory, 'installation');
});

// Claude Code's `auth status` says "pro" for a Max account; the profile in its config says which plan it really is.
test('the Claude plan comes from the account profile, with the CLI’s word only as a fallback', { skip: scriptCLIs }, async t => {
  const pro = fixture(t, { output: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}' });
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = pro.root;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const fallback = await accountStatus('claude', { bin: pro.bin });
  assert.equal(fallback.subscriptionType, 'pro'); assert.equal(fallback.planType, 'Pro', 'With no profile, the CLI’s word stands.');
  fs.writeFileSync(path.join(pro.root, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' } }));
  const max = await accountStatus('claude', { bin: pro.bin });
  assert.equal(max.planType, 'Max 5x', 'The profile outranks the CLI.'); assert.equal(max.subscriptionType, 'pro', 'What the CLI said is kept as it was.');
  assert.equal(max.billingSource, 'subscription');
  const signedOut = fixture(t, { output: '{"loggedIn":false}' });
  assert.equal((await accountStatus('claude', { bin: signedOut.bin })).planType, undefined, 'No plan is claimed for an account that is not signed in.');
});

for (const stage of ['version', 'auth']) {
  test(`account ${stage} timeout kills the child and reports a timeout, not a missing CLI`, { skip: scriptCLIs }, async t => {
    const f = fixture(t, { stage, wait: 15000 });
    const pending = accountStatus('claude', { bin: f.bin });
    await waitFor(f.root + '/started');
    const pid = Number(fs.readFileSync(f.root + '/started', 'utf8'));
    const result = await pending;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(result.installed, true); assert.equal(result.authenticated, 'unknown'); assert.equal(result.errorCategory, 'timeout');
  });
}
test('status checks never report a slow CLI as missing or make the conversation wait for it', { skip: scriptCLIs }, async t => {
  const broker = bin => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-status-')), value = new Broker({ workspace: root, dataDir: path.join(root, 'data'), bins: { claude: bin, codex: bin } }); t.after(async () => { await value.close(); fs.rmSync(root, { recursive: true, force: true }); }); return value; };
  const slow = fixture(t, { stage: 'version', wait: 15000 }), steady = fixture(t, { stage: 'version', wait: 15000 });
  fs.writeFileSync(steady.root + '/release', '');
  const known = broker(steady.bin);
  assert.equal((await known.status()).providers.claude.version, 'fake 1.0');
  fs.rmSync(steady.root + '/release'); later(known, 5 * 60 * 1000);
  const first = broker(slow.bin).status(), started = Date.now(), cached = await known.status();
  assert(Date.now() - started < 1000, 'A later check answers from the last result while the CLI is checked again.');
  assert.equal(cached.providers.claude.available, true);
  const fresh = await first;
  assert.equal(fresh.providers.claude.available, true, 'An installed CLI that answers slowly stays usable.'); assert.equal(fresh.providers.claude.errorCategory, 'timeout');
  await known.providerStatusPending;
  const kept = (await known.status()).providers.claude;
  assert.equal(kept.available, true); assert.equal(kept.version, 'fake 1.0', 'A timed-out recheck keeps the last known result.'); assert.equal(kept.errorCategory, undefined);
  const calls = () => fs.readFileSync(steady.root + '/calls', 'utf8').trim().split('\n').length;
  assert.equal(calls(), 4, 'Claude and Codex were each checked twice.');
  fs.writeFileSync(steady.root + '/release', ''); later(known, 10000);
  await known.status(); await known.providerStatusPending;
  assert.equal(calls(), 6, 'A check that timed out is made again after ten seconds.');
  assert.equal((await known.status()).providers.claude.version, 'fake 1.0');
});
test('status starts each CLI again only when the CLI changes, not on every refresh', { skip: scriptCLIs }, async t => {
  const f = fixture(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-status-'));
  const broker = new Broker({ workspace: root, dataDir: path.join(root, 'data'), bins: { claude: f.bin, codex: f.bin } });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = () => fs.readFileSync(f.root + '/calls', 'utf8').trim().split('\n').length;
  await broker.status();
  assert.equal(calls(), 2, 'Claude and Codex are each checked once');
  // The window asks for status every 15 seconds while it is shown.
  for (let i = 0; i < 3; i++) { later(broker, 15000); await broker.status(); await broker.providerStatusPending; }
  assert.equal(calls(), 2, 'an unchanged CLI is not started again');
  fs.appendFileSync(f.bin, '\n// updated\n');
  await broker.status(); await broker.providerStatusPending;
  assert.equal(calls(), 4, 'an updated CLI is checked again');
  later(broker, 5 * 60 * 1000);
  await broker.status(); await broker.providerStatusPending;
  assert.equal(calls(), 6, 'and every CLI is checked again after five minutes');
});
test('status checks a CLI that failed again after ten seconds, so one that starts working is seen', { skip: scriptCLIs }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-status-'));
  let broker;
  t.after(async () => { await broker?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Each fake CLI fails while its "broken" file exists, as a Node script does while Node is missing, and then works
  // again without its own file changing.
  const cli = name => {
    const bin = path.join(root, name);
    fs.writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, ${JSON.stringify(name)} + '\\n');\nif (fs.existsSync(${JSON.stringify(path.join(root, 'broken-' + name))})) process.exit(1);\nprocess.stdout.write('${name} 1.0\\n');\n`, { mode: 0o755 });
    return bin;
  };
  const calls = name => fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').filter(line => line === name).length;
  fs.writeFileSync(path.join(root, 'broken-claude'), '');
  broker = new Broker({ workspace: root, dataDir: path.join(root, 'data'), bins: { claude: cli('claude'), codex: cli('codex') } });
  const first = (await broker.status()).providers;
  assert.deepEqual([first.claude.available, first.codex.available], [false, true]);
  fs.rmSync(path.join(root, 'broken-claude'));
  later(broker, 10000);
  await broker.status(); await broker.providerStatusPending;
  const fixed = (await broker.status()).providers;
  assert.equal(fixed.claude.available, true, 'A CLI that failed and then works is seen ten seconds later.');
  assert.equal(fixed.claude.version, 'claude 1.0');
  assert.deepEqual([calls('claude'), calls('codex')], [2, 1], 'The CLI that worked is not started again.');
  for (let i = 0; i < 3; i++) { later(broker, 15000); await broker.status(); await broker.providerStatusPending; }
  assert.deepEqual([calls('claude'), calls('codex')], [2, 1], 'Once it works, its check is reused too.');
});
test('Claude auth nonzero output keeps the existing parse behavior', { skip: scriptCLIs }, async t => {
  const f = fixture(t, { authCode: 1, output: '{"loggedIn":false,"authMethod":"api_key"}' });
  const result = await accountStatus('claude', { bin: f.bin });
  assert.equal(result.installed, true); assert.equal(result.authenticated, false); assert.equal(result.billingSource, 'api');
});

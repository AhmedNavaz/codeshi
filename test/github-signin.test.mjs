import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLIENT_ID, createGitHubSignIn, encryptedVault } from '../src/github-signin.mjs';
import { createGitHubRepos } from '../src/github-repos.mjs';

// A vault that keeps text in memory, as the encrypted desktop vault does on disk.
function memoryVault() {
  let text = null;
  return { available: () => true, read: () => text, write: value => { text = value; }, clear: () => { text = null; }, peek: () => text };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A GitHub that answers the device flow with a queue of poll results.
function fakeGitHub(polls = [], { expiresIn = 8 * 3600, login = 'octo' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null, auth: options.headers?.Authorization || null });
    if (String(url).endsWith('/login/device/code')) return json({ device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (String(url).endsWith('/login/oauth/access_token')) return json(polls.shift());
    if (String(url).endsWith('/user')) return json({ login });
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls };
}
function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: ms => { at += ms; } };
}

test('the device flow sends only the public client ID and stores the token in the vault', async () => {
  const gh = fakeGitHub([{ access_token: 'gho_secret', refresh_token: 'ghr_1', expires_in: 28800, refresh_token_expires_in: 15552000 }]);
  const vault = memoryVault(), time = clock();
  const signin = createGitHubSignIn({ vault, fetchImpl: gh.fetchImpl, now: time.now });
  const started = await signin.start();
  assert.equal(started.state, 'pending');
  assert.equal(started.userCode, 'ABCD-1234');
  assert.equal(gh.calls[0].body.client_id, CLIENT_ID);
  assert.equal(gh.calls[0].body.client_secret, undefined);
  assert.equal(gh.calls[0].body.scope, undefined);
  // Too early to ask again: no request to GitHub.
  assert.equal((await signin.status()).state, 'pending');
  assert.equal(gh.calls.length, 1);
  time.advance(5000);
  assert.equal((await signin.status()).state, 'signed-in');
  assert.equal((await signin.status()).login, 'octo');
  assert.match(vault.peek(), /gho_secret/);
  assert.equal(gh.calls[1].body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
});

test('authorization_pending keeps waiting, slow_down lengthens the interval, and denial or expiry is reported', async () => {
  const gh = fakeGitHub([{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { error: 'access_denied' }]);
  const time = clock();
  const signin = createGitHubSignIn({ vault: memoryVault(), fetchImpl: gh.fetchImpl, now: time.now });
  await signin.start();
  time.advance(5000); assert.equal((await signin.status()).state, 'pending');
  time.advance(5000); assert.equal((await signin.status()).state, 'pending');
  time.advance(5000); assert.equal((await signin.status()).state, 'pending', 'slow_down waits longer than 5 seconds');
  time.advance(10000); assert.equal((await signin.status()).state, 'denied');
});

test('an expired code is reported, and no sign-in without a vault', async () => {
  const gh = fakeGitHub([]);
  const time = clock();
  const signin = createGitHubSignIn({ vault: memoryVault(), fetchImpl: gh.fetchImpl, now: time.now });
  await signin.start();
  time.advance(900 * 1000 + 1);
  assert.equal((await signin.status()).state, 'expired');
  const none = createGitHubSignIn({ vault: null, fetchImpl: gh.fetchImpl });
  assert.equal((await none.status()).state, 'unavailable');
  await assert.rejects(none.start(), /secure storage/);
});

test('an expiring token is refreshed, and a failed refresh signs out', async () => {
  let refreshed = false;
  const fetchImpl = async (url, options = {}) => {
    const body = Object.fromEntries(new URLSearchParams(options.body));
    if (body.grant_type === 'refresh_token') { refreshed = true; return json({ access_token: 'gho_new', refresh_token: 'ghr_2', expires_in: 28800, refresh_token_expires_in: 15552000 }); }
    return json({});
  };
  const vault = memoryVault(), time = clock();
  vault.write(JSON.stringify({ accessToken: 'gho_old', refreshToken: 'ghr_1', expiresAt: time.now() + 60_000, refreshExpiresAt: time.now() + 1e9, login: 'octo' }));
  const signin = createGitHubSignIn({ vault, fetchImpl, now: time.now });
  assert.equal(await signin.token(), 'gho_new');
  assert.equal(refreshed, true);
  assert.equal(JSON.parse(vault.peek()).refreshToken, 'ghr_2');
  assert.equal(JSON.parse(vault.peek()).login, 'octo', 'the login is kept across a refresh');
  // A refresh that GitHub refuses ends the sign-in.
  vault.write(JSON.stringify({ accessToken: 'gho_old', refreshToken: 'ghr_bad', expiresAt: time.now() - 1, refreshExpiresAt: null, login: 'octo' }));
  const refusing = createGitHubSignIn({ vault, fetchImpl: async () => json({ error: 'bad_refresh_token' }), now: time.now });
  assert.equal(await refusing.token(), null);
  assert.equal(vault.peek(), null);
});

test('sign out deletes the stored token and the pending code', async () => {
  const gh = fakeGitHub([{ access_token: 'gho_secret', expires_in: 28800 }]);
  const vault = memoryVault(), time = clock();
  const signin = createGitHubSignIn({ vault, fetchImpl: gh.fetchImpl, now: time.now });
  await signin.start(); time.advance(5000); await signin.status();
  assert.equal((await signin.signOut()).state, 'signed-out');
  assert.equal(vault.peek(), null);
  assert.equal(await signin.token(), null);
});

test('the encrypted vault writes only ciphertext and needs keychain encryption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-signin-'));
  const file = path.join(dir, 'github-sign-in.bin');
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(`enc:${text}`), decryptString: buffer => buffer.toString().slice(4) };
  const vault = encryptedVault({ file, safeStorage });
  vault.write('{"accessToken":"gho_secret"}');
  assert.equal(fs.readFileSync(file, 'utf8').includes('gho_secret'), true, 'the fake cipher stands in for encryption');
  assert.equal(vault.read(), '{"accessToken":"gho_secret"}');
  vault.clear();
  assert.equal(vault.read(), null);
  const locked = encryptedVault({ file, safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal(locked.available(), false);
  assert.throws(() => locked.write('x'), /Secure storage/);
});

test('with a sign-in token and no gh login, repositories are listed and cloned over HTTPS', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-signin-repos-')));
  const cloneFolder = path.join(root, 'Developer');
  fs.mkdirSync(cloneFolder);
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url: String(url), auth: options.headers?.Authorization });
    if (String(url).endsWith('/user')) return json({ login: 'octo', name: 'Octo', avatar_url: null });
    if (String(url).includes('/user/repos')) return json([{ full_name: 'octo/app', description: 'Mine', private: true, fork: false, archived: false, pushed_at: '2026-11-01T00:00:00Z', html_url: 'https://github.com/octo/app' }]);
    throw new Error(`unexpected ${url}`);
  };
  const run = async () => { const error = new Error('gh: not found'); error.code = 'ENOENT'; throw error; };
  const clones = [];
  const repos = createGitHubRepos({
    run,
    signin: { token: async () => 'gho_secret' },
    fetchImpl,
    gitClone: async (url, target, token) => { clones.push({ url, target, token }); fs.mkdirSync(target); },
    origin: () => null,
  });
  const listed = await repos.list({ folders: [], cloneFolder, host: 'github.com' });
  assert.equal(listed.via, 'github');
  assert.equal(listed.repos[0].fullName, 'octo/app');
  assert.equal(listed.repos[0].private, true);
  assert.ok(seen.every(item => item.auth === 'Bearer gho_secret'));
  const cloned = await repos.clone({ repository: 'octo/app', cloneFolder, folders: [], host: 'github.com' });
  assert.equal(cloned.cloned, true);
  assert.equal(clones[0].url, 'https://github.com/octo/app.git');
  assert.equal(clones[0].target, path.join(cloneFolder, 'app'));
  fs.rmSync(root, { recursive: true, force: true });
});

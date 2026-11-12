import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitHubRepoRoutes, createGitHubRepos, localClones, suggestedCloneFolder, validRepository } from '../src/github-repos.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';

const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-github-repos-')));
function repository(folder, origin) {
  fs.mkdirSync(folder, { recursive: true });
  spawnSync(gitExecutable(), ['init', '-q', folder]);
  if (origin) spawnSync(gitExecutable(), ['-C', folder, 'remote', 'add', 'origin', origin]);
  return folder;
}
const row = (fullName, extra = {}) => JSON.stringify({ fullName, description: null, private: false, fork: false, archived: false, pushedAt: '2026-11-01T00:00:00Z', url: `https://github.com/${fullName}`, ...extra });
// A gh that answers the account, the repository pages and clones, and records what it was asked.
function fakeGh({ pages = [[row('me/app')]], clone = null, fail = null } = {}) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push(args);
    assert.equal(bin, 'gh');
    if (fail) throw fail;
    if (args[1] === 'user') return '{"login":"me","name":"Me"}';
    if (args[0] === 'api') return (pages[Number(new URL(args[1], 'https://x/').searchParams.get('page')) - 1] || []).join('\n');
    if (args[0] === 'repo' && args[1] === 'clone') return clone ? clone(args[2], args[3]) : repository(args[3], `https://github.com/${args[2]}.git`);
    throw new Error(`Unexpected gh ${args.join(' ')}`);
  };
  return { run, calls };
}

test('only owner/name repository names are accepted', () => {
  assert.equal(validRepository(' me/app '), 'me/app');
  for (const bad of ['', 'app', 'me/app/x', '../app', 'me/..', 'me/.', '-me/app', 'me/a b', 42]) assert.throws(() => validRepository(bad), /Choose a repository/);
});

test('existing clones are found by their GitHub origin, in workspace folders and in the clone folder', () => {
  const root = temporary();
  const workspace = repository(path.join(root, 'work'), 'git@github.com:Me/App.git');
  const clones = path.join(root, 'clones');
  repository(path.join(clones, 'renamed-folder'), 'https://github.com/me/lib');
  repository(path.join(clones, 'elsewhere'), 'https://gitlab.com/me/other.git');
  fs.mkdirSync(path.join(clones, 'plain'));
  const found = localClones({ folders: [workspace, path.join(root, 'missing')], cloneFolder: clones });
  assert.deepEqual(Object.fromEntries(found), { 'me/app': workspace, 'me/lib': path.join(clones, 'renamed-folder') });
});

test('the list reads the account and up to five pages, marks local clones and drops odd names', async () => {
  const root = temporary(), local = repository(path.join(root, 'app'), 'https://github.com/me/app.git');
  const full = Array.from({ length: 100 }, (_, index) => row(`me/r${index}`));
  const gh = fakeGh({ pages: [[row('me/app', { private: true, description: 'x'.repeat(400) }), row('bad name/x'), ...full.slice(2)], full, full, full, full] });
  const result = await createGitHubRepos({ run: gh.run }).list({ folders: [local] });
  assert.deepEqual(result.account, { login: 'me', name: 'Me' });
  assert.equal(result.more, true, 'a fifth full page means there may be more');
  assert.equal(gh.calls.filter(args => args[1].startsWith('user/repos')).length, 5);
  assert.match(gh.calls[1][1], /sort=pushed&affiliation=owner,collaborator,organization_member/);
  assert.equal(result.repos[0].local, local);
  assert.equal(result.repos[0].private, true);
  assert.equal(result.repos[0].description.length, 300);
  assert.ok(!result.repos.some(repo => repo.fullName === 'bad name/x'));
  assert.equal(result.repos[1].local, null);
});

test('gh missing or signed out is explained for this panel', async () => {
  const missing = createGitHubRepos({ run: fakeGh({ fail: new Error('GitHub CLI unavailable') }).run });
  await assert.rejects(missing.list(), error => error.status === 400 && /Install the GitHub CLI \(gh\).*see your repositories here/.test(error.message));
  const signedOut = createGitHubRepos({ run: fakeGh({ fail: Object.assign(new Error('failed'), { stderr: 'To get started with GitHub CLI, please run:  gh auth login' }) }).run });
  await assert.rejects(signedOut.list(), /Sign in to the GitHub CLI with gh auth login/);
});

test('a repository already on this computer opens its folder without cloning', async () => {
  const root = temporary(), local = repository(path.join(root, 'app'), 'https://github.com/me/app');
  const gh = fakeGh();
  const result = await createGitHubRepos({ run: gh.run }).clone({ repository: 'ME/APP', cloneFolder: null, folders: [local] });
  assert.deepEqual(result, { path: local, cloned: false });
  assert.equal(gh.calls.length, 0);
});

test('cloning makes the clone folder one level deep and refuses a name that is taken', async () => {
  const root = temporary(), gh = fakeGh(), repos = createGitHubRepos({ run: gh.run });
  const result = await repos.clone({ repository: 'me/app', cloneFolder: path.join(root, 'code') });
  assert.deepEqual(result, { path: path.join(root, 'code', 'app'), cloned: true });
  assert.deepEqual(gh.calls.at(-1), ['repo', 'clone', 'me/app', path.join(root, 'code', 'app')]);
  await assert.rejects(repos.clone({ repository: 'me/x', cloneFolder: path.join(root, 'a', 'b') }), error => error.status === 404 && /isn't a folder/.test(error.message));
  assert.equal(fs.existsSync(path.join(root, 'a')), false);
  fs.mkdirSync(path.join(root, 'code', 'site'));
  await assert.rejects(repos.clone({ repository: 'me/site', cloneFolder: path.join(root, 'code') }), error => error.status === 409 && /already exists and isn't a clone of me\/site/.test(error.message));
  await assert.rejects(repos.clone({ repository: 'me/site' }), /Choose a folder to clone into/);
});

test('a failed clone says why and leaves no half-made folder', async () => {
  const root = temporary();
  const timedOut = createGitHubRepos({ run: fakeGh({ clone: (name, target) => { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'partial'), ''); throw Object.assign(new Error('killed'), { killed: true }); } }).run });
  await assert.rejects(timedOut.clone({ repository: 'me/big', cloneFolder: root }), error => error.status === 504 && /longer than 10 minutes/.test(error.message));
  assert.equal(fs.existsSync(path.join(root, 'big')), false);
  const denied = createGitHubRepos({ run: fakeGh({ clone: () => { throw Object.assign(new Error('failed'), { stderr: "GraphQL: Could not resolve to a Repository with the name 'me/gone'." }); } }).run });
  await assert.rejects(denied.clone({ repository: 'me/gone', cloneFolder: root }), error => error.status === 404 && /Couldn't find me\/gone/.test(error.message));
  const other = createGitHubRepos({ run: fakeGh({ clone: () => { throw Object.assign(new Error('failed'), { stderr: 'one\ntwo\nthree\nfatal: disk full' }); } }).run });
  await assert.rejects(other.clone({ repository: 'me/app', cloneFolder: root }), error => error.status === 502 && error.message === "Couldn't clone me/app.\ntwo\nthree\nfatal: disk full");
});

test('the routes remember the clone folder after a clone, open the workspace and refuse the phone', async () => {
  const root = temporary(), added = [], saved = [];
  let settings = {};
  const registry = { list: () => [], add: input => { added.push(input); return { id: 'p1', folders: input.folders }; } };
  const route = createGitHubRepoRoutes({ registry, body: async req => req.input, json: (res, status, data) => Object.assign(res, { status, data }), settings: () => settings, saveSettings: patch => { saved.push(patch); settings = { ...settings, ...patch }; }, repos: createGitHubRepos({ run: fakeGh().run }) });
  const call = async (method, pathname, input, extra = {}) => { const res = {}; const handled = await route({ req: { method, input, ...extra }, res, url: new URL(`http://x${pathname}`) }); return { handled, ...res }; };

  assert.equal((await call('GET', '/api/projects')).handled, false);
  await assert.rejects(call('GET', '/api/github/repos', undefined, { phoneClient: true }), error => error.status === 403);
  const listed = await call('GET', '/api/github/repos');
  assert.equal(listed.data.cloneFolder, null);
  assert.equal(typeof listed.data.suggestedFolder, 'string');

  const cloned = await call('POST', '/api/github/clone', { repository: 'me/app', cloneFolder: root });
  assert.equal(cloned.status, 201);
  assert.equal(cloned.data.cloned, true);
  assert.deepEqual(added, [{ folders: [path.join(root, 'app')] }]);
  assert.deepEqual(saved, [{ githubCloneFolder: root }]);
  // Opening an existing clone needs no folder, and saves nothing.
  const again = await call('POST', '/api/github/clone', { repository: 'me/app' });
  assert.equal(again.data.cloned, false);
  assert.equal(saved.length, 1);
  await assert.rejects(call('POST', '/api/github/clone', { repository: 'me/x', cloneFolder: 'relative/path' }), /absolute path or one beginning with ~\//);
});

test('the first suggestion is the folder most workspaces sit in', () => {
  const home = os.homedir();
  assert.equal(suggestedCloneFolder([path.join(home, 'code', 'a'), path.join(home, 'code', 'b'), path.join(home, 'other', 'c')]), '~/code');
  assert.equal(suggestedCloneFolder([path.join(home, 'a')]), '~/Developer');
  assert.equal(suggestedCloneFolder([]), '~/Developer');
});

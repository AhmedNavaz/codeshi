import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoutingReferences } from '../src/routing-references.mjs';

test('issue references retrieve requirements and recent comments, cache briefly, and refresh after expiry', async () => {
  let now = 0, calls = [];
  const resolver = new RoutingReferences({ now: () => now, run: async (bin, args) => {
    calls.push({ bin, args });
    if (bin !== 'gh') return 'git@github.com:owner/project.git\n';
    if (args.at(-1).includes('/comments?')) return JSON.stringify([{ body: 'Remaining work: fix replay' }]);
    return JSON.stringify({ title: 'Context management', body: 'Implement durable history', state: 'open', comments: 7 });
  } });
  const broker = { workspace: '/tmp/primary', workspaceFolders: [] };
  const first = await resolver.resolve('do #85', broker);
  assert.equal(first[0].reference, 'owner/project#85');
  assert.match(first[0].body, /durable history/);
  assert.match(first[0].recentComments[0], /fix replay/);
  assert.equal(first[0].commentsOmitted, 6);
  assert.match(calls.at(-1).args.at(-1), /per_page=3&page=3$/);
  await resolver.resolve('do https://github.com/owner/project/issues/85', broker);
  assert.equal(calls.length, 3, 'Cached issue reuses fetched evidence across reference forms.');
  await resolver.resolve('implement issue number 85', broker);
  assert.equal(calls.length, 4, 'Number-only wording resolves the primary origin and reuses issue contents.');
  now = 60001;
  await resolver.resolve('do owner/project#85', broker);
  assert.equal(calls.length, 6);
});

test('ordinary prompts do no retrieval; unavailable issues remain explicit and reference count is bounded', async () => {
  let calls = 0;
  const resolver = new RoutingReferences({ run: async () => { calls++; throw new Error('not authenticated'); } });
  assert.deepEqual(await resolver.resolve('Fix this function', {}), []);
  assert.equal(calls, 0);
  const refs = await resolver.resolve('do team/repo#1 and team/repo#2 and team/repo#3 and team/repo#4', {});
  assert.equal(refs.length, 3); assert.equal(calls, 3);
  assert(refs.every(ref => ref.unavailable));
});

test('issue bodies, comments and total evidence remain bounded', async () => {
  const resolver = new RoutingReferences({ run: async (_bin, args) => JSON.stringify(args.at(-1).includes('/comments?')
    ? Array.from({ length: 3 }, () => ({ body: 'x'.repeat(10000) }))
    : { title: 'x'.repeat(1000), body: 'x'.repeat(50000), comments: 3 }) });
  const refs = await resolver.resolve('do a/b#1 a/b#2 a/b#3', {});
  assert(JSON.stringify(refs).length < 9300);
  assert.match(refs[0].body, /Excerpt truncated/);
  assert(refs.some(ref => ref.unavailable));
});

test('plan evidence respects folder identity, fresh contents, ambiguity and private/symlink boundaries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-plans-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folders = ['api', 'web'].map(name => ({ name, path: path.join(root, name) }));
  for (const folder of folders) { await fs.mkdir(folder.path); await fs.writeFile(path.join(folder.path, 'plan.md'), '- [ ] Implement replay\n- [x] Old work'); }
  const resolver = new RoutingReferences(), broker = { workspaceFolders: folders };
  assert.match((await resolver.resolve('do plan.md', broker))[0].unavailable, /Ambiguous/);
  const first = (await resolver.resolve('implement api/plan.md', broker))[0];
  assert.equal(first.reference, 'api/plan.md'); assert.deepEqual(first.pendingSteps, ['- [ ] Implement replay']);
  await fs.writeFile(path.join(folders[0].path, 'plan.md'), '- [ ] Changed scope');
  assert.match((await resolver.resolve('do api/plan.md', broker))[0].body, /Changed scope/);
  await fs.mkdir(path.join(folders[0].path, '.aws'));
  await fs.writeFile(path.join(folders[0].path, '.aws', 'plan.md'), 'private');
  await fs.symlink(path.join(folders[0].path, '.aws', 'plan.md'), path.join(folders[0].path, 'secret-plan.md'));
  await fs.writeFile(path.join(root, 'outside.md'), 'outside');
  await fs.symlink(path.join(root, 'outside.md'), path.join(folders[0].path, 'outside-plan.md'));
  for (const token of ['api/.aws/plan.md', 'api/secret-plan.md', 'api/outside-plan.md', '../outside.md']) {
    assert((await resolver.resolve(`do plan ${token}`, broker))[0].unavailable, token);
  }
});

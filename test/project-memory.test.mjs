import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { continuationRequest, emptyContext, prepareContext } from '../src/context.mjs';
import { exportConversation } from '../src/conversation-export.mjs';
import { memoryForTask, memorySuggestions, newEntry } from '../src/project-memory.mjs';

function workspace(t, files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-memory-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folders = ['desktop', 'website'].map(name => { const folder = path.join(root, name); fs.mkdirSync(folder); return { id: name, name, path: folder }; });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content);
  return { root, folders, desktop: folders[0], website: folders[1] };
}
function open(t, env) {
  const broker = new Broker({ workspace: env.desktop.path, workspaceFolders: env.folders, dataDir: path.join(env.root, 'data'), bins: {} });
  t.after(() => broker.close());
  return broker;
}
const entry = (input, folders) => newEntry(input, folders);
const conversation = (extra = {}) => ({ id: 'c', provider: 'claude', mode: 'edit', context: emptyContext(), sessions: {}, runs: [], lastRun: null, messages: [], memory: [], ...extra });
const envelope = prepared => JSON.parse(prepared.prompt.slice(prepared.prompt.indexOf('\n') + 1));

test('entries are kept in the journal and survive a restart, and every change goes through the person', async t => {
  const env = workspace(t, { 'desktop/a.js': 'one' }), broker = open(t, env), c = broker.get(broker.create().id);
  const added = broker.changeMemory(c, { action: 'add', kind: 'convention', text: 'Dates are UTC, see a.js', folderId: 'desktop', messageId: 'm1', runId: 'r1' });
  const [saved] = added.entries;
  assert.deepEqual([saved.kind, saved.folderId, saved.status, saved.source.messageId, saved.source.runId], ['convention', 'desktop', 'active', 'm1', 'r1']);
  assert.deepEqual(saved.files.map(file => file.path), ['a.js']);
  broker.changeMemory(c, { action: 'edit', id: saved.id, kind: 'decision', text: 'Dates are always UTC', folderId: null });
  broker.changeMemory(c, { action: 'retire', id: saved.id });
  const reopened = new Broker({ workspace: env.desktop.path, workspaceFolders: env.folders, dataDir: path.join(env.root, 'data'), bins: {} }); t.after(() => reopened.close());
  const [back] = reopened.memory(reopened.get(c.id)).entries;
  assert.deepEqual([back.kind, back.text, back.status], ['decision', 'Dates are always UTC', 'retired']);
  broker.changeMemory(c, { action: 'restore', id: saved.id });
  assert.equal(broker.memory(c).entries[0].status, 'active');
  assert.deepEqual(broker.changeMemory(c, { action: 'remove', id: saved.id }).entries, []);
  for (const [input, pattern] of [[{ action: 'add', kind: 'convention', text: '  ' }, /what should be remembered/], [{ action: 'add', kind: 'nonsense', text: 'x' }, /what kind/], [{ action: 'add', kind: 'decision', text: 'x'.repeat(2001) }, /at most/], [{ action: 'add', kind: 'decision', text: 'x', folderId: 'gone' }, /no longer in this workspace/], [{ action: 'retire', id: 'gone' }, /no longer here/], [{ action: 'other' }, /Unknown/], [{ action: 'dismiss', key: 'bad' }, /suggestion/]]) assert.throws(() => broker.changeMemory(c, input), pattern);
});

test('changing memory leaves a pending handoff offer and the saved context alone', t => {
  const env = workspace(t), broker = open(t, env), c = broker.get(broker.create().id), before = JSON.stringify(c.context), scope = broker.handoff.scope(c, { id: 'run' });
  broker.changeMemory(c, { action: 'add', kind: 'decision', text: 'Use tabs here' });
  assert.equal(JSON.stringify(c.context), before);
  assert.equal(broker.handoff.scope(c, { id: 'run' }), scope, 'An offer is bound to the saved context, which memory is not part of.');
  assert.equal('memory' in broker.view(c), false, 'It is not sent with every conversation update.');
});

test('a task hears standing rules for its folders, and fixes only when it mentions what they are about', t => {
  const env = workspace(t), { folders } = env;
  const c = conversation({ memory: [
    entry({ kind: 'convention', text: 'Commit messages describe behavior' }, folders),
    entry({ kind: 'decision', text: 'Website uses Tailwind tokens', folderId: 'website' }, folders),
    entry({ kind: 'decision', text: 'Desktop keeps plain JavaScript', folderId: 'desktop' }, folders),
    entry({ kind: 'failed-approach', text: 'Bundling the terminal addon broke the preload' }, folders),
    { ...entry({ kind: 'convention', text: 'Retired rule' }, folders), status: 'retired' },
  ] });
  const sent = (words, scope) => memoryForTask(c, { words, scope, folders, fresh: true, provider: 'claude' }).entries.map(item => item.text);
  assert.deepEqual(sent('Fix the hero', ['website']).sort(), ['Commit messages describe behavior', 'Website uses Tailwind tokens']);
  assert.equal(sent('Fix the hero', ['desktop', 'website']).length, 3, 'A fix about something else stays out, and so does a retired entry.');
  assert(sent('The terminal addon crashes', ['desktop']).includes('Bundling the terminal addon broke the preload'));
});

test('sending is bounded, and a resumed session only hears what it has not been told', t => {
  const env = workspace(t), { folders } = env, many = Array.from({ length: 40 }, (_, index) => entry({ kind: 'convention', text: `Rule ${index} ${'x'.repeat(300)}` }, folders));
  const bounded = memoryForTask(conversation({ memory: many }), { words: 'task', scope: ['desktop'], folders, fresh: true, provider: 'claude' });
  assert(Buffer.byteLength(JSON.stringify(bounded.entries)) <= 4000);
  assert(bounded.left > 0);
  const one = entry({ kind: 'convention', text: 'Keep it short' }, folders), first = memoryForTask(conversation({ memory: [one] }), { words: 'x', scope: ['desktop'], folders, fresh: true, provider: 'claude' });
  const resumed = conversation({ memory: [one], lastRun: { provider: 'claude', context: { memory: first.ids } } });
  assert.deepEqual(memoryForTask(resumed, { words: 'x', scope: ['desktop'], folders, fresh: false, provider: 'claude' }).entries, []);
  assert.equal(memoryForTask(resumed, { words: 'x', scope: ['desktop'], folders, fresh: true, provider: 'claude' }).entries.length, 1, 'A fresh agent has been told nothing.');
  assert.equal(memoryForTask(resumed, { words: 'x', scope: ['desktop'], folders, fresh: false, provider: 'codex' }).entries.length, 1, 'Nor has another agent.');
  const edited = conversation({ memory: [{ ...one, text: 'Keep it shorter', updatedAt: '2099-01-01T00:00:00.000Z' }], lastRun: { provider: 'claude', context: { memory: first.ids } } });
  assert.equal(memoryForTask(edited, { words: 'x', scope: ['desktop'], folders, fresh: false, provider: 'claude' }).entries[0].text, 'Keep it shorter', 'An edit counts as new.');
});

test('an entry whose file changed is marked for a recheck rather than sent as fact', t => {
  const env = workspace(t, { 'desktop/a.js': 'one' }), { folders } = env, kept = entry({ kind: 'convention', text: 'a.js holds the rules' }, folders);
  const send = () => memoryForTask(conversation({ memory: [kept] }), { words: 'x', scope: ['desktop'], folders, fresh: true, provider: 'claude' }).entries[0];
  assert.equal(send().needsRecheck, undefined);
  fs.writeFileSync(path.join(env.desktop.path, 'a.js'), 'two');
  assert.deepEqual([send().needsRecheck, send().changedFiles], [true, ['a.js']]);
  fs.rmSync(path.join(env.desktop.path, 'a.js'));
  assert.equal(send().needsRecheck, true);
});

test('a prompt carries memory as evidence below the person\'s request, and the older selection never does', t => {
  const env = workspace(t), { folders, desktop } = env;
  const c = conversation({ memory: [entry({ kind: 'convention', text: 'MEMORY-RULE use tabs' }, folders)] });
  const options = { workspace: desktop.path, workspaceFolders: folders, fresh: true, provider: 'claude', readAttachment: () => ({ text: '' }) };
  const prepared = prepareContext(c, 'Use spaces in this file, not tabs', { ...options, policy: 'task' }), value = envelope(prepared);
  assert.equal(value.currentRequest, 'Use spaces in this file, not tabs');
  assert.equal(value.brief.memory[0].text, 'MEMORY-RULE use tabs');
  assert.match(value.brief.note, /person's requests take priority over both/);
  assert.equal(prepared.metadata.memory.length, 1);
  assert.equal(prepareContext(c, 'Next', { ...options, policy: 'recency' }).prompt.includes('MEMORY-RULE'), false);
});

test('suggestions come from what the person wrote and what tests verified, and are never sent until kept', t => {
  const env = workspace(t), { folders, desktop } = env;
  const c = conversation({ messages: [
    { id: 'a', role: 'user', text: 'Add it. Decision: prices show the currency code first.\nRemember that the API rounds down.\nAlways run the linter before pushing.' },
    { id: 'b', role: 'assistant', text: 'Decision: I will rewrite everything.' },
    { id: 'c', role: 'activity', runId: 'run', text: `$ npm run build\nError: webpack failed in ${desktop.path}` },
    { id: 'd', role: 'activity', runId: 'run', text: '$ npm test\nError: 1 failing' },
    { id: 'e', role: 'activity', runId: 'open', text: '$ make\nError: failed' },
    { id: 'f', role: 'user', text: continuationRequest },
  ], runs: [{ id: 'run', taskId: 'run', check: { status: 'passed', command: 'npm test' } }, { id: 'open', taskId: 'open' }] });
  const found = memorySuggestions(c, folders);
  assert.deepEqual(found.filter(item => item.kind !== 'failed-approach').map(item => [item.kind, item.text]).sort(), [['convention', 'Always run the linter before pushing.'], ['convention', 'the API rounds down.'], ['decision', 'prices show the currency code first.']]);
  const failed = found.filter(item => item.kind === 'failed-approach');
  assert.equal(failed.length, 1, 'Not the test command itself, and not a task whose tests never passed.');
  assert.match(failed[0].text, /^npm run build: /);
  assert.equal(failed[0].folderId, 'desktop');
  assert.equal(JSON.stringify(found).includes('rewrite everything'), false, 'An agent can not suggest its own rules.');
  assert.equal(prepareContext(c, 'Next', { workspace: desktop.path, workspaceFolders: folders, fresh: true, provider: 'claude', policy: 'task', readAttachment: () => ({ text: '' }) }).prompt.includes('"memory":'), false);
  assert.equal(memorySuggestions({ ...c, memoryDismissed: [found[0].key] }, folders).some(item => item.key === found[0].key), false, 'A dismissed one stays gone.');
  assert.equal(memorySuggestions({ ...c, memory: [{ kind: found[0].kind, text: found[0].text }] }, folders).some(item => item.key === found[0].key), false, 'A kept one is not suggested again.');
});

test('memory stays in its own workspace, and out of conversation exports', t => {
  const env = workspace(t), broker = open(t, env), c = broker.get(broker.create().id);
  broker.changeMemory(c, { action: 'add', kind: 'decision', text: 'PRIVATE-MEMORY' });
  const other = workspace(t), elsewhere = open(t, other), d = elsewhere.get(elsewhere.create().id);
  assert.deepEqual(elsewhere.memory(d).entries, []);
  const exported = exportConversation(broker.view(c), { name: 'x', folders: env.folders }, { range: 'all', activity: true, redact: true });
  assert.equal(JSON.stringify(exported).includes('PRIVATE-MEMORY'), false);
});

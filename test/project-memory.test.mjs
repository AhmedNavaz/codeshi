import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { continuationRequest, emptyContext, prepareContext } from '../src/context.mjs';
import { exportConversation } from '../src/conversation-export.mjs';
import { memoryForTask, memorySuggestions, memoryView, newEntry } from '../src/project-memory.mjs';
import { execFileSync } from 'node:child_process';

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

function gitRepo(folder) {
  const git = (...args) => execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args], { cwd: folder.path, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', 'start');
  return git;
}
const stateOf = (saved, folders) => memoryView(conversation({ memory: [saved] }), folders).entries[0];

test('a commit flags no memory; a branch switch flags working fixes and failed approaches, but not your rules', t => {
  const env = workspace(t, { 'desktop/a.js': 'one' }), { folders, desktop } = env, git = gitRepo(desktop);
  const rule = entry({ kind: 'convention', text: 'Dates are UTC', folderId: 'desktop' }, folders);
  const fix = entry({ kind: 'solution', text: 'Restart the watcher after changing routes', folderId: 'desktop' }, folders);
  const shared = entry({ kind: 'failed-approach', text: 'Caching the session broke logout' }, folders);
  assert.deepEqual([rule, fix, shared].map(item => item.source.revision.branch), ['main', 'main', 'main']);
  git('commit', '-q', '--allow-empty', '-m', 'unrelated');
  for (const item of [rule, fix, shared]) assert.equal(stateOf(item, folders).needsRecheck, false, `A commit by itself leaves "${item.text}" as it was.`);
  git('switch', '-q', '-c', 'feature');
  assert.equal(stateOf(rule, folders).needsRecheck, false, 'A rule you set holds on any branch.');
  for (const item of [fix, shared]) assert.deepEqual(['needsRecheck', 'branchChanged', 'savedBranch', 'currentBranch'].map(key => stateOf(item, folders)[key]), [true, true, 'main', 'feature']);
  const sent = memoryForTask(conversation({ memory: [fix] }), { words: 'watcher routes', scope: ['desktop'], folders, fresh: true, provider: 'claude' }).entries[0];
  assert.deepEqual([sent.needsRecheck, sent.branchChanged, sent.savedOnBranch], [true, true, 'main']);
  git('switch', '-q', 'main');
  assert.equal(stateOf(fix, folders).needsRecheck, false, 'Back on its branch, it holds again.');
});

test('a dependency change flags facts about the code, and a version bump or a lock file does not', t => {
  const manifest = deps => JSON.stringify({ name: 'app', version: '1.0.0', dependencies: deps });
  const env = workspace(t, { 'desktop/package.json': manifest({ react: '^18.0.0' }), 'desktop/package-lock.json': '{}' }), { folders, desktop } = env;
  const write = (name, text) => fs.writeFileSync(path.join(desktop.path, name), text);
  const rule = entry({ kind: 'decision', text: 'Forms use controlled inputs', folderId: 'desktop' }, folders);
  const fix = entry({ kind: 'solution', text: 'Wrap the router in StrictMode last', folderId: 'desktop' }, folders);
  assert.equal(stateOf(fix, folders).needsRecheck, false);
  write('package.json', JSON.stringify({ name: 'app', version: '1.4.0', scripts: { test: 'node --test' }, dependencies: { react: '^18.0.0' } }, null, 2));
  write('package-lock.json', '{"lockfileVersion":3}');
  assert.equal(stateOf(fix, folders).needsRecheck, false, 'A new version, a script or the lock file is not a dependency change.');
  write('package.json', manifest({ react: '^19.0.0' }));
  assert.deepEqual([stateOf(fix, folders).needsRecheck, stateOf(fix, folders).dependenciesChanged], [true, ['package.json']]);
  assert.equal(stateOf(rule, folders).needsRecheck, false, 'A rule you set is not flagged by dependencies.');
  write('package.json', manifest({ react: '^18.0.0' }));
  assert.equal(stateOf(fix, folders).needsRecheck, false);
  write('requirements.txt', 'flask==3.0\n');
  assert.deepEqual(stateOf(fix, folders).dependenciesChanged, ['requirements.txt'], 'A manifest that appears counts too.');
});

test('Cargo.toml and pyproject.toml ignore their own version but not a dependency version', t => {
  const cargo = (own, serde) => `[package]\nname = "app"\nversion = "${own}"\n\n[dependencies.serde]\nversion = "${serde}"\n`;
  const env = workspace(t, { 'desktop/Cargo.toml': cargo('0.1.0', '1.0'), 'desktop/pyproject.toml': '[project]\nname = "tool"\nversion = "1"\ndependencies = ["httpx>=0.27"]\n' }), { folders, desktop } = env;
  const fix = entry({ kind: 'solution', text: 'Enable the derive feature', folderId: 'desktop' }, folders);
  fs.writeFileSync(path.join(desktop.path, 'Cargo.toml'), cargo('0.2.0', '1.0'));
  fs.writeFileSync(path.join(desktop.path, 'pyproject.toml'), '[project]\nname = "tool"\nversion = "2"\ndependencies = ["httpx>=0.27"]\n');
  assert.equal(stateOf(fix, folders).needsRecheck, false);
  fs.writeFileSync(path.join(desktop.path, 'Cargo.toml'), cargo('0.2.0', '2.0'));
  assert.deepEqual(stateOf(fix, folders).dependenciesChanged, ['Cargo.toml']);
});

test('memories saved before this rule are no longer flagged by a commit, and saving an edit checks one again', async t => {
  const env = workspace(t), { folders, desktop } = env, git = gitRepo(desktop), broker = open(t, env), c = broker.get(broker.create().id);
  const old = entry({ kind: 'convention', text: 'Dates are UTC', folderId: 'desktop' }, folders);
  delete old.dependencies;
  git('commit', '-q', '--allow-empty', '-m', 'later');
  assert.equal(stateOf(old, folders).needsRecheck, false, 'An entry from 0.30.0 to 0.46.0 kept the commit, and a later commit flagged it.');
  const [saved] = broker.changeMemory(c, { action: 'add', kind: 'solution', text: 'Clear the build cache first', folderId: 'desktop', messageId: 'm1' }).entries;
  git('switch', '-q', '-c', 'feature');
  assert.equal(broker.memory(c).entries[0].needsRecheck, true);
  const [edited] = broker.changeMemory(c, { action: 'edit', id: saved.id, kind: 'solution', text: 'Clear the build cache first', folderId: 'desktop' }).entries;
  assert.deepEqual([edited.needsRecheck, edited.source.revision.branch, edited.source.messageId], [false, 'feature', 'm1'], 'Saving it again checks it on this branch, and keeps where it came from.');
});

test('a resumed session revalidates already-delivered memory and resends changed validation state', t => {
  const env = workspace(t, { 'desktop/a.js': 'one' }), { folders } = env;
  const kept = entry({ kind: 'convention', text: 'a.js holds the rules', folderId: 'desktop' }, folders);
  const c = conversation({ memory: [kept] }), options = { words: 'x', scope: ['desktop'], folders, fresh: false, provider: 'claude' };
  const first = memoryForTask(c, options);
  c.lastRun = { provider: 'claude', context: { memory: first.ids } };
  assert.equal(memoryForTask(c, options).entries.length, 0);
  fs.writeFileSync(path.join(env.desktop.path, 'a.js'), 'two');
  const changed = memoryForTask(c, options);
  assert.equal(changed.entries[0].needsRecheck, true);
  assert.deepEqual(changed.entries[0].changedFiles, ['a.js']);
  assert.notDeepEqual(changed.ids, first.ids);
  c.lastRun.context.memory = changed.ids;
  fs.rmSync(path.join(env.desktop.path, 'a.js'));
  assert.equal(memoryForTask(c, options).entries[0].needsRecheck, true, 'Deletion is another validation change.');
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

test('a check that failed, then passed after edits, is suggested as a working fix instead of a failed approach', t => {
  const env = workspace(t), { folders, desktop, website } = env;
  const edit = (id, file) => ({ id, role: 'activity', runId: 'run', text: `Edit\n${JSON.stringify({ file_path: path.join(desktop.path, file) })}` });
  const c = conversation({ messages: [
    { id: 'a', role: 'activity', runId: 'run', text: '$ npm run build\nCompiling…\nError: Cannot find module ./dates' },
    edit('b', 'src/dates.mjs'),
    { id: 'c', role: 'activity', runId: 'run', text: `File changes: ${JSON.stringify([{ path: path.join(desktop.path, 'src/index.mjs') }, { path: path.join(desktop.path, '.env') }, { path: '/elsewhere/x.js' }])}` },
    { id: 'd', role: 'activity', runId: 'run', text: '$ npm run build\nBuilt in 1.2s' },
    { id: 'e', role: 'activity', runId: 'run', text: '$ npm run lint\nError: 2 problems' },
    { id: 'f', role: 'activity', runId: 'run', text: '$ npm run lint\nAll clean' },
    { id: 'g', role: 'activity', runId: 'run', text: '$ cat missing.txt\nError: no such file' },
    edit('h', 'missing.txt'),
    { id: 'i', role: 'activity', runId: 'run', text: '$ cat missing.txt\nhello' },
  ], runs: [{ id: 'run', taskId: 'run', check: { status: 'passed', command: 'npm test' } }] });
  const found = memorySuggestions(c, folders), fixes = found.filter(item => item.kind === 'solution');
  assert.equal(fixes.length, 1, 'Lint passed with nothing edited, which is not a fix; cat is not a check.');
  assert.equal(fixes[0].text, '`npm run build` failed with “Error: Cannot find module ./dates”; it passed after changes to src/dates.mjs, src/index.mjs.');
  assert.deepEqual([fixes[0].folderId, fixes[0].messageId], ['desktop', 'a']);
  assert.equal(found.some(item => item.kind === 'failed-approach' && item.text.startsWith('npm run build')), false, 'A fixed command is not also a failed approach.');
  assert.equal(found.some(item => item.text.includes('.env') || item.text.includes('elsewhere')), false, 'Private files and paths outside the workspace stay out.');
  assert.equal(memorySuggestions({ ...c, runs: [{ id: 'run', taskId: 'run' }] }, folders).length, 0, 'Nothing is suggested from a task whose tests never passed.');
  assert.equal(memorySuggestions({ ...c, messages: c.messages.map(message => message.id === 'b' || message.id === 'c' ? { ...message, text: `Edit\n${JSON.stringify({ file_path: path.join(website.path, 'page.js') })}` } : message) }, folders).find(item => item.kind === 'solution').folderId, 'website');
});

test('Keep saves an edited suggestion as the person changed it, and the suggestion does not come back', t => {
  const env = workspace(t), broker = open(t, env), c = broker.get(broker.create().id);
  c.messages.push({ id: 'said', role: 'user', text: 'Remember that the API rounds prices down.' });
  const [suggestion] = broker.memory(c).suggestions;
  assert.equal(suggestion.text, 'the API rounds prices down.');
  const kept = broker.changeMemory(c, { action: 'add', kind: 'decision', text: 'The pricing API rounds down to whole cents.', folderId: 'website', messageId: suggestion.messageId, suggested: true, suggestion: suggestion.key });
  assert.deepEqual(kept.suggestions, [], 'Kept under different words, it is still the same suggestion.');
  const [saved] = kept.entries;
  assert.deepEqual([saved.kind, saved.text, saved.folderId, saved.source.messageId, saved.source.suggested, saved.source.suggestion], ['decision', 'The pricing API rounds down to whole cents.', 'website', 'said', true, suggestion.key]);
  const plain = broker.changeMemory(c, { action: 'add', kind: 'convention', text: 'Something typed by hand', suggestion: 'f'.repeat(16) }).entries.at(-1);
  assert.equal('suggestion' in plain.source, false, 'Only a kept suggestion records one.');
  assert.equal('suggestion' in newEntry({ kind: 'convention', text: 'Odd key', suggested: true, suggestion: 'not-a-key' }, env.folders).source, false);
});

test('memory stays in its own workspace, and out of conversation exports', t => {
  const env = workspace(t), broker = open(t, env), c = broker.get(broker.create().id);
  broker.changeMemory(c, { action: 'add', kind: 'decision', text: 'PRIVATE-MEMORY' });
  const other = workspace(t), elsewhere = open(t, other), d = elsewhere.get(elsewhere.create().id);
  assert.deepEqual(elsewhere.memory(d).entries, []);
  const exported = exportConversation(broker.view(c), { name: 'x', folders: env.folders }, { range: 'all', activity: true, redact: true });
  assert.equal(JSON.stringify(exported).includes('PRIVATE-MEMORY'), false);
});

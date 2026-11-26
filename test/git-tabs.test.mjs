import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Exercise the real Git frontend with independently owned tab elements. Layout is checked in the app.
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = new Map(); this.dataset = {}; this.hidden = true; this.value = ''; this.className = ''; this.listeners = new Map(); this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  set textContent(value) { this.replaceChildren(String(value)); }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML must stay text.'); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name); }
  matches() { return false; }
  closest() { return null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.children.some(child => typeof child !== 'string' && child.contains(node)); }
  querySelector(selector) { return this.children.filter(child => typeof child !== 'string').map(child => selector === '[aria-current="true"]' && child.getAttribute('aria-current') === 'true' ? child : child.querySelector(selector)).find(Boolean) || null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const diff = (path, text) => ({ path, code: ' M', diff: `@@ -1 +1 @@\n-old\n+${text}\n` });
function fixture({ saved = [] } = {}) {
  const nodes = new Map(), events = new Map(), entries = new Map(), calls = [], sidebar = [];
  const state = { projectId: null, provider: 'codex', model: '', effort: '', accounts: {}, conversation: {}, projects: [{ id: 'one', folders: [{ id: 'frontend' }] }, { id: 'two', folders: [{ id: 'backend' }] }] };
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, document.createElement('div')); return nodes.get(id); }, createElement(tag) { const element = new Element(tag); element.ownerDocument = document; return element; }, addEventListener() {}, hidden: false };
  let respond = async () => ({ totalChanges: 0, repositories: [] });
  const window = {
    relayUI: { getState: () => state, isRunning: () => false, api(path, options, projectId) { calls.push({ path, projectId }); return respond(path, projectId); }, showNotice() {} },
    relayTabs: {
      upsert(entry) { entries.set(JSON.stringify([entry.projectId, entry.id]), entry); },
      select(id) { entries.get(JSON.stringify([state.projectId, id]))?.onSelect?.(); },
      getSaved(projectId, kind) { return saved.filter(entry => entry.projectId === projectId && entry.kind === kind); },
    },
    relaySidebar: { show(view) { sidebar.push(view); } },
    addEventListener(name, callback) { const list = events.get(name) || []; list.push(callback); events.set(name, list); },
    dispatchEvent(event) { for (const callback of events.get(event.type) || []) callback(event); },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/insights.js', import.meta.url), 'utf8'), { document, window, localStorage: { getItem: () => null }, setInterval() {}, CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }, console });
  const choose = id => { state.projectId = id; window.dispatchEvent({ type: 'relay-state' }); };
  return { window, entries, calls, nodes, sidebar, choose, respond: callback => { respond = callback; }, state };
}

test('Git file tabs keep concurrent reads, folders and workspaces independent', async () => {
  const ui = fixture(), first = deferred(), second = deferred(), third = deferred();
  ui.choose('one');
  ui.respond((path, projectId) => projectId === 'two' ? third.promise : path.includes('first.js') ? first.promise : second.promise);
  ui.window.relayGit.openDiff({ folderId: 'frontend', name: 'Frontend' }, { path: 'first.js' }, 'modified');
  ui.window.relayGit.openDiff({ folderId: 'frontend', name: 'Frontend' }, { path: 'second.js' }, 'modified');
  ui.choose('two');
  ui.window.relayGit.openDiff({ folderId: 'backend', name: 'Backend' }, { path: 'first.js' }, 'modified');
  second.resolve(diff('second.js', 'second result')); third.resolve(diff('first.js', 'other workspace')); first.resolve(diff('first.js', '<script>first result</script>'));
  await flush();
  const entries = [...ui.entries.values()];
  assert.equal(entries.length, 3);
  assert.match(entries.find(entry => entry.projectId === 'one' && entry.restore.path === 'first.js').element.textContent, /<script>first result<\/script>/);
  assert.match(entries.find(entry => entry.restore.path === 'second.js').element.textContent, /second result/);
  assert.match(entries.find(entry => entry.projectId === 'two').element.textContent, /other workspace/);
  assert.deepEqual(ui.calls.map(call => call.projectId), ['one', 'one', 'two']);
  assert.equal(ui.nodes.get('diff-dialog').open, undefined, 'Diff tabs never open the old modal.');
});

test('closing a diff during its read cannot recreate the closed tab', async () => {
  const ui = fixture(), pending = deferred(); ui.choose('one'); ui.respond(() => pending.promise);
  ui.window.relayGit.openDiff({ folderId: 'frontend', name: 'Frontend' }, { path: 'first.js' }, 'modified');
  const [key, entry] = [...ui.entries][0]; entry.onClose(); ui.entries.delete(key);
  pending.resolve(diff('first.js', 'late result')); await flush();
  assert.equal(ui.entries.size, 0);
});

test('Git commit tabs read local commit changes without invoking a write', async () => {
  const ui = fixture(); ui.choose('one');
  ui.respond(async () => ({ shortHash: 'aaaaaaa', totalFiles: 2, body: 'Details', files: [{ path: 'first.js', status: 'modified', diff: '@@ -1 +1 @@\n-old\n+new\n' }, { path: 'image.png', status: 'added', binary: true }] }));
  ui.window.relayGit.openCommit({ folderId: 'frontend', name: 'Frontend' }, { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'Update files' });
  await flush();
  assert.equal(ui.calls.length, 1); assert.match(ui.calls[0].path, /^\/api\/checkpoints\/commit\?/); assert.equal(ui.calls[0].projectId, 'one');
  const entry = [...ui.entries.values()][0];
  assert.match(entry.element.textContent, /first\.js/); assert.match(entry.element.textContent, /Binary file/);
  assert.equal(entry.restore.type, 'commit'); assert.equal(entry.restore.hash, 'a'.repeat(40));
});

test('remembered diffs restore metadata, read on selection and skip removed folders', async () => {
  const ui = fixture({ saved: [
    { projectId: 'one', kind: 'diff', restore: { type: 'file', folderId: 'frontend', folderName: 'Frontend', path: 'first.js' } },
    { projectId: 'one', kind: 'diff', restore: { type: 'file', folderId: 'removed', folderName: 'Removed', path: 'first.js' } },
  ] });
  ui.choose('one'); assert.equal(ui.entries.size, 1); assert.equal(ui.calls.length, 0);
  ui.respond(async () => diff('first.js', 'fresh result'));
  const entry = [...ui.entries.values()][0]; ui.window.relayTabs.select(entry.id); await flush();
  assert.equal(ui.calls.length, 1); assert.match(entry.element.textContent, /fresh result/);
  assert.equal(entry.restore.diff, undefined, 'Only identity is saved; file contents are read again.');
});

test('opening Git chooses its sidebar independently of right-hand panels', async () => {
  const ui = fixture(); ui.choose('one'); ui.window.relayGit.open(); await flush(); ui.window.relayGit.close();
  assert.deepEqual(ui.sidebar, ['git']); assert.equal(ui.calls[0].path, '/api/git');
});

test('Flow opens file changes directly, refreshes the selected diff and keeps navigation in one window', async () => {
  const ui = fixture(); ui.window.relayFlow = { view: () => 'flow' }; ui.choose('one');
  const repo = { folderId: 'frontend', name: 'Frontend', available: true, totalChanges: 2, commits: [], changes: [{ path: 'first.js', code: ' M', added: 1 }, { path: 'second.js', code: ' M', added: 1 }] };
  let version = 'original';
  ui.respond(async request => request === '/api/git' ? { repositories: [repo] } : diff(request.includes('first.js') ? 'first.js' : 'second.js', version));
  await ui.window.relayGit.openDiff(repo, repo.changes[1]); await flush();
  assert.equal(ui.nodes.get('diff-dialog').open, true); assert.equal(ui.entries.size, 0);
  assert.equal(ui.nodes.get('diff-title').textContent, 'second.js'); assert.match(ui.nodes.get('diff-content').textContent, /original/);
  const list = ui.nodes.get('diff-files'); assert.match(list.textContent, /first\.js.*second\.js/);
  ui.nodes.get('diff-content').scrollTop = 80; version = 'updated'; await ui.window.relayGit.refresh(); await flush();
  assert.match(ui.nodes.get('diff-content').textContent, /updated/); assert.equal(ui.nodes.get('diff-content').scrollTop, 80);
  list.listeners.get('keydown')({ key: 'ArrowUp', preventDefault() {} }); await flush();
  assert.equal(ui.nodes.get('diff-title').textContent, 'first.js'); assert.equal(ui.nodes.get('diff-dialog').open, true);
  ui.choose('two'); assert.equal(ui.nodes.get('diff-dialog').open, false);
});

test('Flow ignores late diff reads after changing files or closing the changes window', async () => {
  const ui = fixture(); ui.window.relayFlow = { view: () => 'flow' }; ui.choose('one');
  const first = deferred(), second = deferred(), repo = { folderId: 'frontend', name: 'Frontend', available: true, totalChanges: 2, commits: [], changes: [{ path: 'first.js', code: ' M' }, { path: 'second.js', code: ' M' }] };
  ui.respond(request => request === '/api/git' ? Promise.resolve({ repositories: [repo] }) : request.includes('first.js') ? first.promise : second.promise);
  await ui.window.relayGit.review(); await flush();
  ui.nodes.get('diff-files').listeners.get('keydown')({ key: 'ArrowDown', preventDefault() {} });
  second.resolve(diff('second.js', 'second content')); await flush(); first.resolve(diff('first.js', 'late first content')); await flush();
  assert.equal(ui.nodes.get('diff-title').textContent, 'second.js'); assert.match(ui.nodes.get('diff-content').textContent, /second content/); assert.doesNotMatch(ui.nodes.get('diff-content').textContent, /late first/);
  const late = deferred(); ui.respond(request => request === '/api/git' ? Promise.resolve({ repositories: [repo] }) : late.promise);
  await ui.window.relayGit.refresh(); ui.nodes.get('diff-dialog').close(); late.resolve(diff('second.js', 'after closing')); await flush();
  assert.equal(ui.nodes.get('diff-dialog').open, false); assert.doesNotMatch(ui.nodes.get('diff-content').textContent, /after closing/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('remote phone progress refreshes chat without repeatedly loading projects, and pauses queued background work', async () => {
  const source = fs.readFileSync(new URL('../public/phone.js', import.meta.url), 'utf8');
  // Execute the shipped refresh/connection logic with a controlled clock and API; no layout claims are made here.
  const refresh = source.slice(source.indexOf('  let refreshing ='), source.indexOf('  // ---- A sound'));
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { hidden: false }), events = new EventTarget(); events.readyState = 1;
  let now = 100000, nextTimer = 0, approvals = [], status = 'running';
  const timers = new Map(), intervals = [], requests = [];
  const S = { projectId: 'p', projects: [{ id: 'p' }], c: { id: 'c', status, pendingApprovals: [] }, messages: [], view: 0, loaded: true, limit: 40, online: true, settings: {} };
  const context = { window, document, S, MINUTE: 60000, transport: { remote: true, events: () => events }, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id), setInterval: fn => intervals.push(fn),
    api: async path => { requests.push(path); return path === '/api/projects' ? [{ id: 'p' }] : { id: 'c', status, delta: true, messages: [], pendingApprovals: approvals }; },
    phoneFetch: async () => ({ status: 200, ok: true }), $: () => ({}), render() {}, offerHomeScreen() {}, recall: () => null,
    L: { mergeMessages: (current, update) => update.messages },
  };
  const controls = vm.runInNewContext(`${refresh}\n({connect, refreshProjects, scheduleConversation, scheduleProjects})`, context);
  controls.connect(); await controls.refreshProjects(); requests.length = 0;
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      const current = [...timers]; timers.clear(); for (const [, { fn }] of current) fn();
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  const progress = () => events.dispatchEvent(new MessageEvent('update', { data: '{}' }));
  for (let i = 0; i < 10; i++) { progress(); await flush(); }
  assert.equal(requests.filter(path => path.startsWith('/api/conversation')).length, 10);
  assert.equal(requests.filter(path => path === '/api/projects').length, 0);
  now += 15000; intervals[0](); await flush();
  assert.equal(requests.filter(path => path === '/api/projects').length, 0);
  now += 45000; intervals[0](); await flush();
  assert.equal(requests.filter(path => path === '/api/projects').length, 1, 'A minute heartbeat refreshes workspace metadata.');
  approvals = [{ id: 'approval' }]; progress(); await flush();
  assert.equal(requests.filter(path => path === '/api/projects').length, 2, 'An approval updates workspace indicators promptly.');
  status = 'complete'; progress(); await flush();
  assert.equal(requests.filter(path => path === '/api/projects').length, 3, 'Completion updates workspace indicators promptly.');
  events.dispatchEvent(new Event('projects')); await flush();
  assert.equal(requests.filter(path => path === '/api/projects').length, 4, 'An actual workspace change still refreshes immediately.');
  const before = requests.length;
  controls.scheduleConversation(); controls.scheduleProjects(); document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  intervals[0](); window.dispatchEvent(new Event('online')); await flush();
  assert.equal(requests.length, before, 'Hidden pages cancel scheduled reads and do not poll.');
});

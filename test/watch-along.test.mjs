import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWatchAlong, watchView, parseWatchLink, watchLink } from '../src/watch-along.mjs';

// An in-memory stand-in for the Firebase relay: a JSON tree with PUT, GET, DELETE and live watches, one identity per client.
function fakeRelay() {
  const tree = {}, watchers = new Set();
  const parts = key => key.split('/').filter(Boolean);
  const get = key => parts(key).reduce((node, part) => node?.[part], tree) ?? null;
  const set = (key, value) => {
    const list = parts(key); let node = tree;
    for (const part of list.slice(0, -1)) node = node[part] ||= {};
    if (value === null) delete node[list.at(-1)]; else node[list.at(-1)] = structuredClone(value);
    for (const watcher of watchers) if (watcher.key.startsWith(key) || key.startsWith(watcher.key)) queueMicrotask(() => watcher.changed(get(watcher.key)));
  };
  let next = 0;
  const factory = () => {
    const uid = `user-${++next}`, mine = new Set();
    return {
      uid,
      identity: async () => ({ uid }),
      request: async (key, method = 'GET', value) => { if (method === 'GET') return get(key); set(key, method === 'DELETE' ? null : value); return null; },
      watch: (key, changed) => { const watcher = { key, changed }; watchers.add(watcher); mine.add(watcher); queueMicrotask(() => changed(get(key))); return () => { watchers.delete(watcher); mine.delete(watcher); }; },
      close: () => { for (const watcher of mine) watchers.delete(watcher); },
    };
  };
  return { factory, get };
}
const config = { projectId: 'codeshi-test', apiKey: 'A'.repeat(30), databaseURL: 'https://codeshi-test.firebaseio.com', phoneURL: 'https://phone.example.com' };
const until = async (check, label) => { for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error(`Timed out: ${label}`); };

test('a watcher sees an allowlisted view: no host paths, raw step output or settings', () => {
  const view = watchView({
    id: 'c1', title: 'Fix login', status: 'running', provider: 'claude', model: 'opus', queue: [{ text: 'secret queued prompt' }], routing: { mode: 'auto' },
    activeRun: { id: 'r1', provider: 'claude', model: 'opus', startedAt: 't', purpose: 'x' },
    pendingApprovals: [{ kind: 'fileChange', provider: 'claude', input: { file_path: '/Users/host/private/demo-app/utils.js' } }, { kind: 'question', questions: [{ question: 'Which branch?' }] }],
    messages: [
      { id: 'm1', role: 'user', text: 'Fix it', attachments: [{ name: 'shot.png', kind: 'image', path: '/Users/host/x.png' }] },
      { id: 'a1', role: 'activity', text: '$ npm test\nTOKEN=abc123 leaked output' },
      { id: 'm2', role: 'assistant', provider: 'claude', text: 'Working on it.', runId: 'r1' },
    ],
  });
  assert.deepEqual(Object.keys(view).sort(), ['activeRun', 'earlier', 'id', 'messages', 'model', 'provider', 'status', 'step', 'title', 'waiting']);
  assert.equal(view.step, 'Running npm test');
  assert.deepEqual(view.waiting.map(item => item.label), ['Change demo-app/utils.js', 'Which branch?']);
  assert.deepEqual(view.messages.map(message => message.id), ['m1', 'm2']);
  assert.deepEqual(view.messages[0].attachments, [{ name: 'shot.png', kind: 'image' }]);
  assert.deepEqual(view.activeRun, { provider: 'claude', model: 'opus', startedAt: 't' });
  assert.doesNotMatch(JSON.stringify(view), /\/Users\/host|abc123|secret queued/);
});

test('a long conversation drops its oldest messages to fit one relay packet', () => {
  const messages = Array.from({ length: 50 }, (_, index) => ({ id: `m${index}`, role: 'assistant', text: 'x'.repeat(19_000) }));
  const view = watchView({ id: 'c', status: 'idle', messages });
  assert.ok(view.messages.length < 50 && view.messages.at(-1).id === 'm49');
  assert.equal(view.earlier, 50 - view.messages.length);
  assert.ok(JSON.stringify(view).length < 900_000);
});

test('invite links are read from pasted text', () => {
  const id = 'a'.repeat(64), secret = 'b'.repeat(64);
  assert.equal(watchLink(id, secret), `codeshi://watch/${id}.${secret}`);
  for (const text of [watchLink(id, secret), `  <${watchLink(id, secret)}>  `, `${id}.${secret}`, `Join me: ${watchLink(id, secret)}`]) assert.deepEqual(parseWatchLink(text), { id, secret });
  assert.equal(parseWatchLink('codeshi://watch/abc.def'), null);
});

test('invite, matching codes, allow, live view, suggestion, one use only, and stop sharing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-test-')), relay = fakeRelay();
  let messages = [{ id: 'm1', role: 'user', text: 'Fix the login bug' }, { id: 'm2', role: 'assistant', provider: 'claude', text: 'Looking. '.repeat(30) }];
  let hostChanges = 0;
  const host = createWatchAlong({ config, storeFile: path.join(dir, 'host.json'), clientFactory: relay.factory, workspaceName: id => { if (id !== 'p1') throw Object.assign(Error('Project not found.'), { status: 404 }); return 'demo-app'; },
    readConversation: () => watchView({ id: 'c1', title: 'Login', status: 'idle', messages }), onChange: () => { hostChanges++; } });
  const viewer = createWatchAlong({ config, storeFile: path.join(dir, 'viewer.json'), clientFactory: relay.factory, readConversation: () => { throw Error('unused'); } });
  const intruder = createWatchAlong({ config, storeFile: path.join(dir, 'intruder.json'), clientFactory: relay.factory, readConversation: () => { throw Error('unused'); } });
  try {
    await assert.rejects(host.manage({ action: 'invite', projectId: 'nope' }), /Project not found/);
    await host.manage({ action: 'invite', projectId: 'p1' });
    const link = host.status('p1').host.invite.link;
    const joined = await viewer.manage({ action: 'join', link, name: '  Sara  ' });
    const mine = viewer.status().watching[0], asked = host.status('p1').host.watchers[0];
    assert.equal(mine.state, 'pending'); assert.equal(mine.workspace, 'demo-app');
    assert.equal(asked.name, 'Sara'); assert.equal(asked.state, 'pending'); assert.equal(asked.code, mine.code);
    assert.equal(host.status('p1').host.invite, null, 'an answered invite stops being offered');
    // Before the host allows it, nothing is shown and suggestions are refused.
    await assert.rejects(viewer.manage({ action: 'suggest', id: joined.joined, text: 'hi' }), /hasn’t allowed you/);
    // A second person with the same link is refused.
    await assert.rejects(intruder.manage({ action: 'join', link, name: 'Eve' }), /expired or was already used/);
    await viewer.manage({ action: 'look', id: joined.joined, looking: true });
    await host.manage({ action: 'allow', projectId: 'p1', id: asked.id });
    const first = await until(() => viewer.status().watching[0].view, 'first view');
    assert.deepEqual(first.messages.map(message => message.text.slice(0, 7)), ['Fix the', 'Looking']);
    assert.equal(host.status('p1').host.watchers[0].watchingNow, true);
    // A reply that grows arrives as an append and decodes to the full text.
    messages = [messages[0], { ...messages[1], text: messages[1].text + 'Found it.' }, { id: 'm3', role: 'assistant', text: 'Done.' }];
    await viewer.manage({ action: 'refresh', id: joined.joined });
    assert.equal(viewer.status().watching[0].view.messages[1].text, messages[1].text);
    assert.equal(viewer.status().watching[0].view.messages.length, 3);
    // Suggestions wait on the host until dismissed, and are limited in size.
    await viewer.manage({ action: 'suggest', id: joined.joined, text: 'Check the refresh token too' });
    await assert.rejects(viewer.manage({ action: 'suggest', id: joined.joined, text: 'x'.repeat(2001) }), /under 2000/);
    const [suggestion] = host.status('p1').host.suggestions;
    assert.equal(suggestion.from, 'Sara'); assert.equal(suggestion.text, 'Check the refresh token too');
    assert.equal(host.status('other').host.suggestions.length, 0, 'suggestions stay with their workspace');
    await host.manage({ action: 'dismiss', projectId: 'p1', id: suggestion.id });
    assert.equal(host.status('p1').host.suggestions.length, 0);
    // Closing the window marks the watcher away; it stops getting the view.
    await viewer.manage({ action: 'look', id: joined.joined, looking: false });
    await until(() => host.status('p1').host.watchers[0].watchingNow === false, 'away');
    assert.equal(viewer.status().watching[0].view, null);
    // Stopping removes the room, and the watcher sees that sharing ended.
    await host.manage({ action: 'stop', projectId: 'p1', id: asked.id });
    assert.equal(host.status('p1').host.watchers.length, 0);
    assert.equal(relay.get(`rooms/${asked.id}`), null);
    assert.ok(hostChanges > 0);
  } finally { await host.close(); await viewer.close(); await intruder.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('allowed watchers survive a restart; unanswered invites do not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-test-')), relay = fakeRelay();
  const options = { config, storeFile: path.join(dir, 'host.json'), workspaceName: () => 'demo-app', readConversation: () => watchView({ id: 'c1', status: 'idle', messages: [] }) };
  const hostClient = relay.factory(), host = createWatchAlong({ ...options, clientFactory: () => hostClient });
  const viewer = createWatchAlong({ config, storeFile: path.join(dir, 'viewer.json'), clientFactory: relay.factory, readConversation: () => null });
  try {
    await host.manage({ action: 'invite', projectId: 'p1' });
    const { joined } = await viewer.manage({ action: 'join', link: host.status('p1').host.invite.link, name: 'Sara' });
    await host.manage({ action: 'allow', projectId: 'p1', id: host.status('p1').host.watchers[0].id });
    await host.manage({ action: 'invite', projectId: 'p1' });
    const unused = host.status('p1').host.invite.link;
    await host.close();
    const saved = JSON.parse(fs.readFileSync(options.storeFile, 'utf8'));
    assert.equal(saved.rooms.length, 1); assert.equal(saved.rooms[0].name, 'Sara');
    assert.equal(relay.get(`rooms/${parseWatchLink(unused).id}`), null, 'the unused invite is removed on quit');
    const again = createWatchAlong({ ...options, clientFactory: () => hostClient });
    try {
      assert.equal(again.status('p1').host.watchers[0].state, 'active');
      await viewer.manage({ action: 'look', id: joined, looking: true });
      await until(() => viewer.status().watching[0].view, 'view after restart');
    } finally { await again.close(); }
  } finally { await viewer.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

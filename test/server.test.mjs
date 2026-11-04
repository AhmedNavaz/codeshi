import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { noSymlinks } from './platform.mjs';
import { createRelayServer } from '../src/server.mjs';
import { ProjectRegistry } from '../src/projects.mjs';

test('source layout reopens root-level development history and serves assets outside its working directory', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-source-layout-')));
  let app;
  t.after(async () => { try { await app?.close(); } finally { fs.rmSync(directory, { recursive: true, force: true }); } });
  fs.cpSync(new URL('../src/', import.meta.url), path.join(directory, 'src'), { recursive: true });
  fs.cpSync(new URL('../public/', import.meta.url), path.join(directory, 'public'), { recursive: true });
  const workspace = path.join(directory, 'project');
  fs.mkdirSync(workspace);
  const dataRoot = path.join(directory, '.data');
  const previous = new ProjectRegistry({ dataRoot, lock: false });
  const saved = previous.add({ path: workspace });
  await previous.close();
  const registryBefore = fs.readFileSync(path.join(dataRoot, 'projects.json'), 'utf8');
  const { createRelayServer: createCopiedServer } = await import(pathToFileURL(path.join(directory, 'src/server.mjs')));
  app = createCopiedServer({ lock: false });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  assert.equal(app.registry.dataRoot, dataRoot);
  assert.equal(app.registry.list()[0].id, saved.id);
  assert.equal(fs.readFileSync(path.join(dataRoot, 'projects.json'), 'utf8'), registryBefore);
  assert.equal(fs.existsSync(path.join(directory, 'src/.data')), false);
  const page = await fetch(`http://127.0.0.1:${app.server.address().port}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Codeshi/);
});

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-relay-http-'));
  const workspace = path.join(directory, 'project');
  const dataDir = path.join(directory, 'history');
  fs.mkdirSync(workspace);
  const instances = [];
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const app of instances.reverse()) await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const launch = async () => {
    // Status probes only execute `node --version`; no assistant or live inference is used.
    const app = createRelayServer({ workspace, dataDir,
      bins: { codex: process.execPath, claude: process.execPath }, lock: false, ...options });
    instances.push(app);
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const port = app.server.address().port;
    return { app, port, url: `http://127.0.0.1:${port}` };
  };

  return { ...await launch(), directory, workspace, launch, controllers };
}

function post(url, value, extraHeaders = {}) {
  return fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-AI-Relay': '1', ...extraHeaders,
  }, body: JSON.stringify(value) });
}

function requestWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/conversations',
      headers: { Host: host } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
}

function eventReader(reader) {
  let buffered = '';
  const decoder = new TextDecoder();
  return async () => {
    while (!buffered.includes('\n\n')) {
      const { value, done } = await reader.read();
      assert.equal(done, false, 'The SSE stream should remain open.');
      buffered += decoder.decode(value, { stream: true });
    }
    const boundary = buffered.indexOf('\n\n');
    const block = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 2);
    const lines = block.split('\n');
    return { type: lines.find(line => line.startsWith('event: '))?.slice(7),
      data: JSON.parse(lines.find(line => line.startsWith('data: ')).slice(6)) };
  };
}

test('serves the local interface and probes provider versions without inference', async t => {
  const f = await fixture(t);
  const page = await fetch(f.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /<title>Codeshi/);
  assert.match(html, /id="select-codex"/);
  assert.match(html, /id="select-claude"/);
  for (const [, attribute, assetPath] of html.matchAll(/<(?:script|link)\b[^>]*\b(src|href)="(\/[^\"]+\.(?:js|css))"/g)) {
    const asset = await fetch(`${f.url}${assetPath}`);
    assert.equal(asset.status, 200, `The page needs ${assetPath}.`);
    assert.match(asset.headers.get('content-type'), attribute === 'src' ? /javascript/ : /text\/css/);
    assert.ok((await asset.text()).length > 0);
  }
  const statusResponse = await fetch(`${f.url}/api/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.workspace, fs.realpathSync(f.workspace));
  assert.equal(status.runningConversationId, null);
  for (const provider of ['codex', 'claude']) {
    assert.equal(status.providers[provider].available, true);
    assert.equal(status.providers[provider].version, process.version);
  }
});

test('a forced close drops requests still in flight instead of waiting for them', async t => {
  const f = await fixture(t);
  const socket = (await import('node:net')).connect(f.port, '127.0.0.1');
  await once(socket, 'connect');
  socket.on('error', () => {}); socket.write('GET /api/projects HTTP/1.1\r\nHost: 127.0.0.1\r\n'); // headers never finish, so the request stays in flight
  await new Promise(resolve => setTimeout(resolve, 50));
  const started = Date.now();
  await f.app.close({ force: true });
  assert.ok(Date.now() - started < 1000, 'Start fresh does not wait for launch-time requests to finish.');
  await once(socket, 'close');
});

test('opens one permanent project chat and reuses it across requests, switching and restart', async t => {
  const f = await fixture(t);
  const initial=await (await fetch(`${f.url}/api/conversation`)).json();
  const changes=await (await fetch(`${f.url}/api/conversation?since=${initial.cursor}`)).json();assert.equal(changes.messageCount,initial.messages.length,'An update asks only for what changed.');assert.deepEqual(changes.messages,[]);
  assert.equal((await (await fetch(`${f.url}/api/conversation?since=nonsense`)).json()).messageCount,undefined,'A position that makes no sense gets the whole conversation.');
  assert.equal((await (await fetch(`${f.url}/api/conversations`)).json()).length,1);
  const createdResponse = await post(`${f.url}/api/conversations`, {}, { Origin: f.url });
  assert.equal(createdResponse.status, 200);
  assert.equal((await (await fetch(`${f.url}/api/conversation`)).json()).id,initial.id);
  const created = await createdResponse.json();
  assert.match(created.id, /^[\da-f-]{36}$/);
  assert.equal(created.provider, 'codex');
  assert.equal(created.mode, 'edit');
  assert.deepEqual(created.messages, []);
  assert.equal(Object.hasOwn(created, 'sessions'), false);

  const endpoint = `/api/conversations/${created.id}`;
  const changedResponse = await post(`${f.url}${endpoint}/provider`, { provider: 'claude', mode: 'read' });
  assert.equal(changedResponse.status, 200);
  const changed = await changedResponse.json();
  assert.equal(changed.id, created.id);
  assert.equal(changed.provider, 'claude');
  assert.equal(changed.mode, 'read');
  assert.deepEqual(await (await fetch(`${f.url}${endpoint}`)).json(), changed);
  const list = await (await fetch(`${f.url}/api/conversations`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
  assert.equal(list[0].provider, 'claude');
  assert.equal(list[0].mode, 'read');

  await f.app.close();
  const reopened = await f.launch();
  const savedResponse = await fetch(`${reopened.url}${endpoint}`);
  assert.equal(savedResponse.status, 200);
  assert.deepEqual(await savedResponse.json(), changed);
});

test('rejects invalid providers, malformed JSON and unknown conversations', async t => {
  const f = await fixture(t);
  const created = await (await post(`${f.url}/api/conversations`, {})).json();
  const endpoint = `${f.url}/api/conversations/${created.id}`;
  for (const input of [{ provider: 'other' }, { mode: 'unrestricted' }]) {
    const response = await post(`${endpoint}/provider`, input);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Choose Codex, Claude or Gemini/);
  }
  assert.deepEqual(await (await fetch(endpoint)).json(), created);

  for (const body of ['{', '[]', 'null', '"text"']) {
    const response = await fetch(`${f.url}/api/conversations`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-AI-Relay': '1',
    }, body });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Invalid JSON/);
  }
  const unsupported = await fetch(`${f.url}/api/conversations`, {
    method: 'POST', headers: { 'X-AI-Relay': '1' }, body: '{}',
  });
  assert.equal(unsupported.status, 415);
  const unknown = `${f.url}/api/conversations/${randomUUID()}`;
  assert.equal((await fetch(unknown)).status, 404);
  assert.equal((await post(`${unknown}/provider`, { provider: 'claude' })).status, 404);
  assert.equal((await fetch(`${f.url}/unknown`)).status, 404);
  assert.equal((await (await fetch(`${f.url}/api/conversations`)).json()).length, 1);
});

test('an answer reaches only a question still waiting, and skipping must be said outright', async t => {
  const f = await fixture(t);
  const created = await (await post(`${f.url}/api/conversations`, {})).json(), endpoint = `${f.url}/api/conversations/${created.id}/answer`;
  const stale = await post(endpoint, { runId: 'run-one', questionId: 'ask-1', skip: true });
  assert.equal(stale.status, 409); assert.match((await stale.json()).error, /no longer waiting/);
  // A run waiting on a question, as the broker holds it while its agent waits.
  const { broker } = [...f.app.registry.brokers.values()][0], c = broker.get(created.id), sent = [];
  const question = { id: 'ask-1', kind: 'question', runId: 'run-one', provider: 'claude', questions: [{ id: 'q1', header: 'Region', question: 'Which region?', options: [{ label: 'EU', description: '', recommended: false }], multiple: false, other: false, secret: false }] };
  broker.running = { id: 'run-one', c, provider: 'claude', approvals: new Map([['ask-1', question]]), child: { send: message => sent.push(message) } };
  t.after(() => { broker.running = null; });
  const missing = await post(endpoint, { runId: 'run-one', questionId: 'ask-1' });
  assert.equal(missing.status, 400, 'No answers is not a skip.'); assert.match((await missing.json()).error, /Answer each question, or skip them/);
  assert.equal((await post(`${f.url}/api/conversations/${created.id}/approval`, { runId: 'run-one', approvalId: 'ask-1', allow: true })).status, 409, 'A question is not approved.');
  const answered = await post(endpoint, { runId: 'run-one', questionId: 'ask-1', answers: [['EU']] });
  assert.equal(answered.status, 200); assert.deepEqual(await answered.json(), { resolved: true });
  assert.deepEqual(sent, [{ type: 'question-result', id: 'ask-1', answers: [['EU']] }]);
  broker.running.approvals.set('ask-1', question);
  assert.equal((await post(endpoint, { runId: 'run-one', questionId: 'ask-1', skip: true })).status, 200);
  assert.deepEqual(sent.at(-1), { type: 'question-result', id: 'ask-1', answers: null });
  assert.deepEqual(c.messages.filter(message => message.role === 'activity').map(message => message.text), ['Answered:\nWhich region? → EU', 'Skipped the question; the agent continues on its own judgement.']);
});

test('keeps multi-byte characters that arrive split across request chunks', async t => {
  const f = await fixture(t);
  const { id } = await (await fetch(`${f.url}/api/conversation`)).json();
  const body = Buffer.from(JSON.stringify({ goal: 'Café ☕ 東京' })), split = body.indexOf(Buffer.from('é')) + 1;
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${f.url}/api/conversations/${id}/context`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    // Two writes with a pause arrive as separate chunks, with the two bytes of "é" on either side.
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 50);
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.context.goal, 'Café ☕ 東京');
});

test('rejects foreign origins, rebinding hosts and mutations without the application header', async t => {
  const f = await fixture(t);
  for (const origin of ['https://attacker.example', `http://127.0.0.1:${f.port + 1}`, 'null']) {
    const response = await post(`${f.url}/api/conversations`, {}, { Origin: origin });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /Cross-origin/);
  }
  const foreignRead = await fetch(`${f.url}/api/conversations`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(foreignRead.status, 403);
  for (const host of [`attacker.example:${f.port}`, `127.0.0.1.attacker.example:${f.port}`]) {
    const response = await requestWithHost(f.port, host);
    assert.equal(response.status, 403);
    assert.match(response.body.error, /Only localhost/);
  }
  const noHeader = await fetch(`${f.url}/api/conversations`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  assert.match((await noHeader.json()).error, /application header/);
  const wrongHeader = await post(`${f.url}/api/conversations`, {}, { 'X-AI-Relay': '0' });
  assert.equal(wrongHeader.status, 403);
  assert.equal(f.app.registry.brokers.size,0,'Rejected requests cannot open a workspace chat.');

  const created = await (await post(`${f.url}/api/conversations`, {})).json();
  const deniedSwitch = await fetch(`${f.url}/api/conversations/${created.id}/provider`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"provider":"claude"}',
  });
  assert.equal(deniedSwitch.status, 403);
  assert.equal((await (await fetch(`${f.url}/api/conversations/${created.id}`)).json()).provider, 'codex');
});

test('streams readiness and updates for persisted conversation changes', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const [project] = await (await fetch(`${f.url}/api/projects`)).json();
  const controller = new AbortController();
  f.controllers.push(controller);
  const response = await fetch(`${f.url}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const nextEvent = eventReader(reader);
  assert.deepEqual(await nextEvent(), { type: 'ready', data: {} });

  const created = await (await post(`${f.url}/api/conversations`, {})).json();
  assert.deepEqual(await nextEvent(), { type: 'update', data: { projectId: project.id, conversationId: created.id } });
  assert.deepEqual(await nextEvent(), {type:'projects',data:{}});
  const switched = await post(`${f.url}/api/conversations/${created.id}/provider`, { provider: 'claude' });
  assert.equal(switched.status, 200);
  await switched.json();
  assert.deepEqual(await nextEvent(), { type: 'update', data: { projectId: project.id, conversationId: created.id } });
  assert.equal((await (await fetch(`${f.url}/api/conversations/${created.id}`)).json()).provider, 'claude');
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('adds multiple projects and keeps their conversations isolated across switches and restarts', async t => {
  const f = await fixture(t);
  const [first] = await (await fetch(`${f.url}/api/projects`)).json();
  const secondPath = path.join(f.directory, 'second-project');
  fs.mkdirSync(secondPath);
  const added = await post(`${f.url}/api/projects`, { path: secondPath, name: 'Second project' });
  assert.equal(added.status, 201);
  const second = await added.json();
  assert.equal(second.name, 'Second project');
  assert.equal(second.path, fs.realpathSync(secondPath));
  assert.notEqual(second.id, first.id);
  assert.equal((await (await fetch(`${f.url}/api/projects`)).json()).length, 2);
  assert.equal((await fetch(`${f.url}/api/conversations`)).status, 400, 'Ambiguous requests must not pick a folder.');
  assert.equal((await fetch(`${f.url}/api/status?projectId=unknown`)).status, 404);

  const scoped = (route, project) => `${f.url}${route}?projectId=${project.id}`;
  const firstChat = await (await post(scoped('/api/conversations', first), {})).json();
  const secondChat = await (await post(scoped('/api/conversations', second), {})).json();
  await post(scoped(`/api/conversations/${firstChat.id}/provider`, first), { provider: 'claude', mode: 'read' });
  assert.equal((await fetch(scoped(`/api/conversations/${firstChat.id}`, second))).status, 404);
  assert.equal((await fetch(scoped(`/api/conversations/${secondChat.id}`, first))).status, 404);
  const firstList = await (await fetch(scoped('/api/conversations', first))).json();
  const secondList = await (await fetch(scoped('/api/conversations', second))).json();
  assert.deepEqual(firstList.map(c => c.id), [firstChat.id]);
  assert.deepEqual(secondList.map(c => c.id), [secondChat.id]);
  assert.equal(firstList[0].provider, 'claude');
  assert.equal(secondList[0].provider, 'codex');
  const firstStatus = await (await fetch(scoped('/api/status', first))).json();
  const secondStatus = await (await fetch(scoped('/api/status', second))).json();
  assert.equal(firstStatus.workspace, first.path);
  assert.equal(secondStatus.workspace, second.path);

  await f.app.close();
  const reopened = await f.launch();
  const savedProjects = await (await fetch(`${reopened.url}/api/projects`)).json();
  assert.equal(savedProjects.length, 2);
  assert.equal(savedProjects.find(project => project.id === second.id).name, 'Second project');
  for (const [project, chat] of [[first, firstChat], [second, secondChat]]) {
    const response = await fetch(`${reopened.url}/api/conversations?projectId=${project.id}`);
    assert.deepEqual((await response.json()).map(item => item.id), [chat.id]);
  }
});

test('validates project folders and deduplicates canonical paths', { skip: noSymlinks }, async t => {
  const f = await fixture(t);
  const [first] = await (await fetch(`${f.url}/api/projects`)).json();
  for (const input of [{}, { path: 123 }, { path: 'relative/folder' }, { path: path.join(f.directory, 'missing') }]) {
    const response = await post(`${f.url}/api/projects`, input);
    assert.equal(response.status, 400);
  }
  const file = path.join(f.directory, 'plain.txt');
  fs.writeFileSync(file, 'not a directory');
  assert.equal((await post(`${f.url}/api/projects`, { path: file })).status, 400);
  const duplicate = await post(`${f.url}/api/projects`, { path: path.join(f.workspace, '.') });
  assert.equal((await duplicate.json()).id, first.id);
  const link = path.join(f.directory, 'project-link');
  fs.symlinkSync(f.workspace, link, 'dir');
  assert.equal((await (await post(`${f.url}/api/projects`, { path: link })).json()).id, first.id);
  assert.equal((await (await fetch(`${f.url}/api/projects`)).json()).length, 1);
});

test('starts as a generic empty app without a default repository', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-relay-empty-'));
  const app = createRelayServer({ dataRoot: directory, lock: false });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.deepEqual(await (await fetch(`${url}/api/projects`)).json(), []);
  assert.equal((await fetch(`${url}/api/conversations`)).status, 400);
  assert.equal((await fetch(url)).status, 200);
});

test('workspace removal and Undo require the local header and retain the canonical chat', async t => {
  const f = await fixture(t);
  const [project] = await (await fetch(`${f.url}/api/projects`)).json();
  const conversation = await (await fetch(`${f.url}/api/conversation?projectId=${project.id}`)).json();
  const removeURL = `${f.url}/api/projects/${project.id}/remove`;
  const denied = await fetch(removeURL, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 403);
  assert.equal((await post(removeURL, {})).status, 200);
  assert.deepEqual(await (await fetch(`${f.url}/api/projects`)).json(), []);
  assert.equal((await fetch(`${f.url}/api/conversation?projectId=${project.id}`)).status, 404);
  assert.equal(fs.statSync(f.workspace).isDirectory(), true);
  assert.equal((await post(removeURL, {})).status, 200);
  assert.equal((await post(`${f.url}/api/projects/${project.id}/restore`, {})).status, 200);
  assert.equal((await (await fetch(`${f.url}/api/conversation?projectId=${project.id}`)).json()).id, conversation.id);
});

test('setup preferences survive restart, apply only to new chats, and do not change provider billing', async t => {
  const f=await fixture(t), oldChat=await (await fetch(`${f.url}/api/conversation`)).json();
  const invalid=await post(`${f.url}/api/preferences`,{defaults:{provider:'invalid'}});assert.equal(invalid.status,400);
  const noHeader=await fetch(`${f.url}/api/preferences`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(noHeader.status,403);
  const saved=await post(`${f.url}/api/preferences`,{defaults:{provider:'claude',model:'fixture-model',effort:'high',mode:'read',billing:'subscription'},theme:'light',onboarding:{step:3,completed:true}});
  assert.equal(saved.status,200);const preferences=await saved.json();assert.equal(preferences.theme,'light');assert.ok(preferences.onboarding.completedAt);
  const unchanged=await (await fetch(`${f.url}/api/conversation`)).json();assert.equal(unchanged.id,oldChat.id);assert.equal(unchanged.provider,oldChat.provider);
  const folder=path.join(f.directory,'new-workspace');fs.mkdirSync(folder);
  const project=await (await post(`${f.url}/api/projects`,{path:folder})).json();
  const fresh=await (await fetch(`${f.url}/api/conversation?projectId=${project.id}`)).json();
  assert.equal(fresh.provider,'claude');assert.equal(fresh.model,'fixture-model');assert.equal(fresh.effort,'high');assert.equal(fresh.mode,'read');assert.equal(fresh.messages.length,0);
  await f.app.close();const reopened=await f.launch();const restored=await (await fetch(`${reopened.url}/api/preferences`)).json();
  assert.deepEqual(restored.defaults,preferences.defaults);assert.equal(restored.theme,'light');assert.equal(restored.onboarding.completedAt,preferences.onboarding.completedAt);assert.equal(restored.firstRun,false);
});

test('desktop keep awake preference persists without overwriting theme or assistant defaults',async t=>{
  const f=await fixture(t);assert.equal(f.app.getKeepAwakePreference(),false);
  await post(`${f.url}/api/preferences`,{theme:'light',defaults:{provider:'claude'}});
  f.app.setKeepAwakePreference(true);assert.throws(()=>f.app.setKeepAwakePreference('true'),/enabled or disabled/);
  await f.app.close();const next=await f.launch();assert.equal(next.app.getKeepAwakePreference(),true);
  const prefs=await (await fetch(`${next.url}/api/preferences`)).json();assert.equal(prefs.theme,'light');assert.equal(prefs.defaults.provider,'claude');
});

test('a settings file that cannot be read is named when Codeshi starts and when a setting is saved, and is left as it is',async t=>{
  const f=await fixture(t),settings=path.join(f.directory,'history','settings.json');f.app.setKeepAwakePreference(true);
  const named={message:`Cannot read the settings file: ${settings}. Fix it, or remove it to start with the default settings.`};
  // Codeshi saves the whole file at once, so files like these were changed by something else.
  for(const contents of ['{"appearance":"light","keep','','null','[]','"light"']){
    fs.writeFileSync(settings,contents);
    assert.throws(()=>f.app.setKeepAwakePreference(false),named);
    assert.equal(f.app.getKeepAwakePreference(),true);assert.equal(fs.readFileSync(settings,'utf8'),contents);
    await assert.rejects(f.launch(),named);
  }
});

const savedAppearance=async url=>(await (await fetch(`${url}/api/appearance`)).json()).theme;
test('a new profile follows the system appearance, and Light or Dark saved by an earlier version survives the upgrade',async t=>{
  const f=await fixture(t);let current=f;
  assert.equal(await savedAppearance(f.url),'system');assert.equal((await (await fetch(`${f.url}/api/preferences`)).json()).theme,'system');assert.equal(f.app.getAppearancePreference(),'system');
  // Settings as earlier versions wrote them: the status bar saved only the palette, and onboarding saved it with its other choices.
  for(const [saved,theme] of [[{appearance:'light'},'light'],[{appearance:'graphite',defaults:{provider:'claude'},onboarding:{step:3,completedAt:'2026-10-29T00:00:00.000Z'}},'graphite']]){
    await current.app.close();fs.writeFileSync(path.join(f.directory,'history','settings.json'),JSON.stringify(saved));current=await f.launch();
    assert.equal(await savedAppearance(current.url),theme);assert.equal((await (await fetch(`${current.url}/api/preferences`)).json()).theme,theme);assert.equal(current.app.getAppearancePreference(),theme);
  }
});

test('System, Light and Dark are saved through both appearance requests and survive a restart',async t=>{
  const f=await fixture(t);
  for(const theme of ['light','system','graphite']){const saved=await post(`${f.url}/api/appearance`,{theme});assert.equal(saved.status,200);assert.deepEqual(await saved.json(),{theme});assert.equal(await savedAppearance(f.url),theme);}
  assert.equal((await post(`${f.url}/api/appearance`,{theme:'dark'})).status,400,'Dark is saved as graphite.');assert.equal(await savedAppearance(f.url),'graphite');
  const system=await post(`${f.url}/api/preferences`,{theme:'system'});assert.equal(system.status,200);assert.equal((await system.json()).theme,'system');
  assert.equal((await post(`${f.url}/api/preferences`,{theme:'auto'})).status,400);assert.equal(await savedAppearance(f.url),'system');
  await post(`${f.url}/api/appearance`,{theme:'light'});await f.app.close();const next=await f.launch();
  assert.equal(await savedAppearance(next.url),'light');assert.equal(next.app.getAppearancePreference(),'light');
});

test('the desktop app hears about each saved appearance, whichever request saved it',async t=>{
  const changes=[],f=await fixture(t,{onAppearance:theme=>changes.push(theme)});
  await post(`${f.url}/api/appearance`,{theme:'light'});await post(`${f.url}/api/preferences`,{theme:'system',defaults:{provider:'claude'}});
  await post(`${f.url}/api/preferences`,{defaults:{provider:'codex'}});await post(`${f.url}/api/appearance`,{theme:'blue'});f.app.setKeepAwakePreference(true);
  assert.deepEqual(changes,['light','system'],'Other settings and rejected values leave the window alone.');
});

test('handoff preferences default to offering at 90% without switching unasked, reject other values and persist',async t=>{
  const f=await fixture(t);assert.deepEqual(f.app.getHandoffPreferences(),{threshold:90,automatic:false});
  assert.deepEqual(f.app.registry.handoffPreferences(),{threshold:90,automatic:false},'Brokers read the same preferences.');
  f.app.setHandoffPreferences({threshold:80});f.app.setHandoffPreferences({automatic:true});
  assert.deepEqual(f.app.registry.handoffPreferences(),{threshold:80,automatic:true},'A change applies to runs already working.');
  for(const patch of [{threshold:85},{threshold:'90'},{automatic:'yes'}])assert.throws(()=>f.app.setHandoffPreferences(patch),/80, 90 or 95 percent or never/);
  f.app.setHandoffPreferences({threshold:0});
  // The Agents panel reads and changes the same preferences.
  assert.deepEqual(await (await fetch(`${f.url}/api/handoff-preferences`)).json(),{threshold:0,automatic:true});
  const changed=await post(`${f.url}/api/handoff-preferences`,{threshold:95});assert.deepEqual(await changed.json(),{threshold:95,automatic:true});
  const refused=await post(`${f.url}/api/handoff-preferences`,{threshold:50});assert.equal(refused.status,400);
  await f.app.close();const next=await f.launch();assert.deepEqual(next.app.getHandoffPreferences(),{threshold:95,automatic:true});
});

test('answering a handoff offer that is no longer current is refused with the current offer, and Not now is accepted',async t=>{
  const f=await fixture(t),created=await (await post(`${f.url}/api/conversations`,{})).json(),endpoint=`${f.url}/api/conversations/${created.id}/handoff`;
  const stale=await post(endpoint,{offerId:randomUUID()});
  assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'This handoff offer is no longer current.',offer:null,billingRequired:false});
  const dismissed=await post(endpoint,{accept:false,offerId:randomUUID()});
  assert.equal(dismissed.status,200);assert.equal((await dismissed.json()).handoffOffer,null);
});

test('a note for the working run is refused clearly when nothing is running',async t=>{
  const f=await fixture(t),created=await (await post(`${f.url}/api/conversations`,{})).json();
  const refused=await post(`${f.url}/api/conversations/${created.id}/steer`,{text:'Also update the docs'});
  assert.equal(refused.status,409);assert.match((await refused.json()).error,/Nothing is running in this workspace/);
});

test('desktop alert preferences default to on and silent, reject other values and persist',async t=>{
  const f=await fixture(t),every={attention:true,finished:true,stopped:true};
  assert.deepEqual(f.app.getNotificationPreferences(),{banner:{on:true,...every,panel:false},sound:{on:false,...every,volume:70,background:false},bounce:{on:true,...every},badge:{on:true,...every},statusItem:true},'The menu bar status shows unless hidden; the panel near the top of the screen only when asked for.');
  f.app.setNotificationPreferences({sound:{on:true}});assert.equal(f.app.getNotificationPreferences().sound.on,true);
  f.app.setNotificationPreferences({banner:{on:false,panel:true},bounce:{finished:false}});assert.throws(()=>f.app.setNotificationPreferences({banner:{on:'no'}}),/on or off/);
  assert.throws(()=>f.app.setNotificationPreferences({enabled:false}),/Unknown alert setting/,'Only known preferences are saved.');
  await f.app.close();const next=await f.launch(),saved=next.app.getNotificationPreferences();
  assert.deepEqual([saved.banner,saved.sound.on,saved.bounce],[{on:false,...every,panel:true},true,{on:true,...every,finished:false}]);
});

test('alert settings saved by an earlier version keep working and are saved in the current shape when changed',async t=>{
  const f=await fixture(t),settings=path.join(f.app.registry.dataRoot,'settings.json');await f.app.close();
  const saved=fs.existsSync(settings)?JSON.parse(fs.readFileSync(settings,'utf8')):{};
  fs.writeFileSync(settings,JSON.stringify({...saved,notifications:{enabled:false,sound:true,statusItem:true,overlay:true,sounds:{attention:true,finished:false,stopped:true,background:false,volume:40}}}));
  const next=await f.launch(),before=next.app.getNotificationPreferences();
  assert.deepEqual([before.banner.on,before.bounce.on,before.banner.panel,before.sound.on,before.sound.finished,before.sound.volume],[false,false,true,true,false,40]);
  next.app.setNotificationPreferences({badge:{on:false}});
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(settings,'utf8')).notifications).sort(),['badge','banner','bounce','sound','statusItem']);
});

test('alerts tell the page which sound to play, as chosen per moment, and sound settings are checked and kept', { timeout: 10000 }, async t => {
  const f = await fixture(t), defaults = { on: false, attention: true, finished: true, stopped: true, volume: 70, background: false };
  assert.deepEqual((await (await fetch(`${f.url}/api/notifications`)).json()).sound, defaults);
  const controller = new AbortController(); f.controllers.push(controller);
  const reader = (await fetch(`${f.url}/api/events`, { signal: controller.signal })).body.getReader(), nextEvent = eventReader(reader);
  assert.deepEqual(await nextEvent(), { type: 'ready', data: {} });
  f.app.registry.emit('notify', { kind: 'finished', title: 'Task finished', projectId: 'p1' });
  const saved = await (await post(`${f.url}/api/notifications`, { sound: { on: true, finished: false, volume: 40 } })).json();
  assert.deepEqual(saved.sound, { ...defaults, on: true, finished: false, volume: 40 });
  f.app.registry.emit('notify', { kind: 'finished', title: 'Task finished', projectId: 'p1' });
  f.app.registry.emit('notify', { kind: 'started', title: 'Continuing with Claude', projectId: 'p1' });
  f.app.registry.emit('notify', { kind: 'approval', title: 'Approval needed', projectId: 'p1', approvalId: 'a1' });
  // Sounds off, a kind turned off, and a kind with no sound all stay quiet: the first alert on the stream is the approval.
  const alert = await nextEvent();
  assert.equal(alert.type, 'alert'); assert.match(alert.data.id, /^[\da-f-]{36}$/);
  assert.deepEqual({ ...alert.data, id: null }, { id: null, sound: 'attention', volume: 40, background: false, kind: 'approval', projectId: 'p1' });
  f.app.registry.emit('notify', { kind: 'stopped', title: 'Task stopped', projectId: 'p1' });
  assert.equal((await nextEvent()).data.sound, 'stopped');
  for (const wrong of [{ sound: { volume: 101 } }, { sound: { volume: 2.5 } }, { sound: { finished: 'yes' } }, { sound: { chime: true } }, { sound: 'on' }, { banner: true }, { sound: [] }, { sounds: { volume: 40 } }]) assert.equal((await post(`${f.url}/api/notifications`, wrong)).status, 400, JSON.stringify(wrong));
  controller.abort(); await reader.cancel().catch(() => {});
  await f.app.close(); const next = await f.launch();
  assert.deepEqual(next.app.getNotificationPreferences().sound, { ...defaults, on: true, finished: false, volume: 40 }, 'Sound settings are kept across restarts.');
});

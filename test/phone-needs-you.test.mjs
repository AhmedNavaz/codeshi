import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { once } from 'node:events';
import { buildNeedsYou, NEEDS_YOU_KINDS } from '../src/needs-you.mjs';
import { phoneRemotePath } from '../src/phone-remote.mjs';
import { CHECK_PAUSE } from '../src/run-checks.mjs';
import { createRelayServer } from '../src/server.mjs';

// Needs you (#201): everything waiting for you across workspaces, for the phone.

function broker({ c, pending = [], tasks = [], lanes = new Map(), missed = [] }) {
  return {
    conversations: new Map([[c.id, c]]),
    pendingApprovals: item => item === c ? pending : [],
    tasks: { lanes, list: () => tasks },
    schedules: { missed: () => missed },
    resume: { view: () => ({ agents: { claude: { resetsAt: '2026-11-27T18:00:00.000Z' } } }) },
  };
}
const lane = (pending, c = { id: 'lane' }) => ({ c, broker: { conversations: new Map([[c.id, c]]), pendingApprovals: item => item === c ? pending : [] } });
function registry(entries) {
  return {
    list: () => entries.map(({ id, name, conversationId }) => ({ id, name, conversationId })),
    brokers: new Map(entries.filter(entry => entry.broker).map(entry => [entry.id, { broker: entry.broker }])),
  };
}

test('Needs you lists every kind of waiting item across open workspaces, most pressing first, each saying where it opens', () => {
  const site = { id: 'chat-a', orchestrations: [{ id: 'p', status: 'draft', goal: 'Rebuild the checkout', steps: [{}, {}, {}] }], retryOffer: { id: 'r', provider: 'claude' } };
  const api = { id: 'chat-b', handoffOffer: { from: { provider: 'codex' }, to: { provider: 'gemini' } }, resume: { providers: ['claude'] }, queuePaused: null };
  const result = buildNeedsYou({ registry: registry([
    { id: 'a', name: 'Site', conversationId: 'chat-a', broker: broker({
      c: site,
      pending: [{ id: '1', kind: 'commandExecution', command: 'npm publish --access public', provider: 'codex' }, { id: '2', kind: 'question', provider: 'claude', questions: [{ question: 'Which database?' }] }],
      tasks: [
        { id: 't1', title: 'Fix login', status: 'running', approvals: 1 },
        { id: 't2', title: 'Add search', status: 'complete', hasWorktree: true, provider: 'codex', endedAt: '2026-11-27T10:00:00.000Z' },
        { id: 't3', title: 'Card: header', status: 'complete', hasWorktree: true, board: { cardId: 'x' }, cardColumn: 'review' },
        { id: 't4', title: 'Tests', status: 'complete', hasWorktree: true, stepCheck: { status: 'complete', outcome: 'failed' } },
        { id: 't5', title: 'Later', status: 'waiting', held: true },
        { id: 't6', title: 'Merged', status: 'integrated' },
        { id: 't7', title: 'Flow part', status: 'complete', hasWorktree: true, managed: true },
      ],
      lanes: new Map([['t1', lane([{ id: 'l1', kind: 'fileChange', input: { file_path: '/repo/src/login.js' }, provider: 'claude' }])]]),
      missed: [{ id: 's1', title: 'Nightly tests', dueAt: '2026-11-27T02:00:00.000Z', reason: 'The computer was asleep' }],
    }) },
    { id: 'b', name: 'API', conversationId: 'chat-b', broker: broker({ c: api }) },
    { id: 'c', name: 'Not opened since Codeshi started', conversationId: 'chat-c' },
  ]) });

  const kinds = result.items.map(item => item.kind);
  assert.deepEqual([...kinds].sort((x, y) => NEEDS_YOU_KINDS.indexOf(x) - NEEDS_YOU_KINDS.indexOf(y)), kinds, 'Most pressing first.');
  for (const kind of ['approval', 'question', 'handoff', 'retry', 'plan', 'check', 'review', 'card', 'held', 'limit', 'schedule']) assert.ok(kinds.includes(kind), kind);
  assert.equal(result.total, result.items.length);

  const by = (kind, taskId) => result.items.find(item => item.kind === kind && (taskId === undefined || item.taskId === taskId));
  assert.deepEqual(by('approval', null), { id: 'approval:a:chat', kind: 'approval', projectId: 'a', workspace: 'Site', taskId: null, title: 'Workspace chat', detail: 'Run npm publish --access public', provider: 'codex', count: 1 });
  assert.equal(by('approval', 't1').detail, 'Change login.js', 'A file is named, never its contents or folder path.');
  assert.equal(by('approval', 't1').title, 'Fix login');
  assert.equal(by('question').detail, 'Which database?');
  assert.equal(by('handoff').projectId, 'b');
  assert.match(by('handoff').detail, /Codex to Gemini/);
  assert.match(by('retry').detail, /Try again with Claude/);
  assert.match(by('plan').detail, /3 steps/);
  assert.equal(by('check').taskId, 't4');
  assert.equal(by('review').taskId, 't2');
  assert.equal(by('card').taskId, 't3', 'A Plan card waits on the Plan, not as a task to merge.');
  assert.equal(by('held').taskId, 't5');
  assert.equal(by('limit').at, '2026-11-27T18:00:00.000Z', 'The reset time comes from the usage watch.');
  assert.equal(by('schedule').id, 'schedule:a:s1');
  assert.ok(!result.items.some(item => ['t6', 't7'].includes(item.taskId)), 'Merged tasks and Flow’s own parts are left out.');
  assert.ok(!result.items.some(item => item.projectId === 'c'));
  assert.equal(new Set(result.items.map(item => item.id)).size, result.items.length, 'Each line has its own id.');
  assert.ok(!JSON.stringify(result).includes('/repo/'), 'No folder paths leave the computer.');
});

test('a failed test that paused the queue shows in Needs you, and a quiet workspace adds nothing', () => {
  const paused = { id: 'c', queuePaused: { reason: CHECK_PAUSE }, queue: [{}, {}] };
  const result = buildNeedsYou({ registry: registry([
    { id: 'a', name: 'Site', conversationId: 'c', broker: broker({ c: paused }) },
    { id: 'b', name: 'Quiet', conversationId: 'q', broker: broker({ c: { id: 'q', queuePaused: { reason: 'You paused it.' }, queue: [{}] } }) },
  ]) });
  assert.deepEqual(result.items.map(item => [item.kind, item.projectId, item.detail]), [['check', 'a', 'Tests failed, so 2 queued messages wait']]);
});

test('a phone may read Needs you and nothing else new: it is GET only and the allowlist still refuses the rest', () => {
  assert.equal(phoneRemotePath('GET', '/api/needs-you'), '/api/needs-you');
  assert.equal(phoneRemotePath('GET', '/api/needs-you?projectId=a'), '/api/needs-you?projectId=a');
  assert.equal(phoneRemotePath('POST', '/api/needs-you'), null);
  for (const [method, url] of [['GET', '/api/recap?since=2026-11-01'], ['GET', '/api/files/preview?path=a'], ['POST', '/api/files/save'], ['GET', '/api/phone'], ['POST', '/api/terminal'], ['GET', '/api/needs-you/../files'], ['GET', '//api/needs-you']]) {
    assert.equal(phoneRemotePath(method, url), null, `${method} ${url}`);
  }
});

test('the Needs you route needs the desktop token like every other API route', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-needs-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createRelayServer({ workspace, dataRoot: path.join(root, 'server'), accessToken: 'local-test', bins: { codex: process.execPath, claude: process.execPath } });
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/needs-you`;
  assert.equal((await fetch(url)).status, 403, 'Without the token it is refused.');
  assert.equal((await fetch(url, { headers: { 'X-AI-Relay-Token': 'wrong' } })).status, 403);
  const response = await fetch(url, { headers: { 'X-AI-Relay-Token': 'local-test' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.items, []); assert.equal(body.total, 0);
});

// The phone page's part, run from the shipped file with just enough of a page.
const source = fs.readFileSync(new URL('../public/phone.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('  function needsElsewhere()'), source.indexOf('  // ---- The message box.'));
function element(tag, cls = '', text) {
  const listeners = {};
  const value = { tag, className: cls, textContent: text ?? '', children: [], dataset: {}, attributes: {}, hidden: false,
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    setAttribute(name, val) { this.attributes[name] = val; }, toggleAttribute(name, on) { if (on) this.attributes[name] = ''; else delete this.attributes[name]; },
    addEventListener(type, fn) { listeners[type] = fn; }, fire(type) { return listeners[type]?.(); } };
  return value;
}
const flat = root => [root, ...root.children.flatMap(flat)];
function page({ needs, projectId = 'a', thread = null, remote = true, status = 200 } = {}) {
  const calls = [], sheets = [], toasts = [], elements = {};
  const S = { projects: [{ id: 'a', name: 'Site' }, { id: 'b', name: 'API' }], projectId, thread, draft: null, needs: null };
  const context = {
    S, MINUTE: 60000, transport: { remote }, document: { hidden: false }, sheet: { open: false },
    $: id => (elements[id] ||= element('div')), node: element, button: (text, handler, cls) => Object.assign(element('button', cls, text), { handler }),
    attempt: fn => Promise.resolve().then(fn), toast: text => toasts.push(text), render() {}, closeSheet() { context.sheet.open = false; },
    openSheet(title, build, keyOf) { const body = element('body'); build(body); context.sheet.open = true; sheets.push({ title, body, key: keyOf?.() }); },
    api: async (url, options) => { calls.push({ url, options }); if (status !== 200) throw Object.assign(new Error('No'), { status }); return { items: needs }; },
    selectProject: async (id, taskId) => { calls.push({ select: id, taskId }); S.projectId = id; S.thread = taskId; },
    selectThread: async taskId => { calls.push({ thread: taskId }); S.thread = taskId; },
    project: () => S.projects.find(item => item.id === S.projectId), tasks: () => [], recall: () => null,
  };
  vm.runInNewContext(`${section}\nObject.assign(globalThis, { needsElsewhere, loadNeeds, needsSheet, openNeed, needHere, scheduleNeeds })`, context);
  return { context, S, calls, sheets, toasts, elements };
}
const NEEDS = [
  { id: 'approval:b:t9', kind: 'approval', projectId: 'b', workspace: 'API', taskId: 't9', title: 'Fix login', detail: 'Run npm test' },
  { id: 'approval:a:chat', kind: 'approval', projectId: 'a', workspace: 'Site', taskId: null, title: 'Workspace chat', detail: 'Run ls' },
  { id: 'review:a:t2', kind: 'review', projectId: 'a', workspace: 'Site', taskId: 't2', title: 'Add search', detail: 'Finished. Ready to review and merge' },
];

test('the phone opens Needs you first when something waits elsewhere, and each line opens where you can act on it (#201)', async () => {
  const p = page({ needs: NEEDS });
  await p.context.loadNeeds();
  assert.equal(p.calls[0].url, '/api/needs-you'); assert.equal(p.calls[0].options.project, null, 'One request for every workspace.');
  assert.equal(p.sheets.length, 1, 'It comes first when something waits.');
  assert.equal(p.sheets[0].title, 'Needs you');
  const rows = flat(p.sheets[0].body).filter(item => item.tag === 'button');
  assert.deepEqual(rows.map(row => row.children[1].children[0].textContent), ['Fix login', 'Workspace chat', 'Add search'], 'In the computer’s order.');
  assert.deepEqual(flat(p.sheets[0].body).filter(item => item.className === 'sheet-label').map(item => item.textContent), ['API', 'Site'], 'Grouped by workspace.');
  assert.match(rows[1].className, /current/, 'The conversation you are in is marked.');

  // The line above the chat names what holds an agent up elsewhere: here, the other workspace's approval.
  assert.equal(p.context.needsElsewhere().text, 'API · Fix login: needs approval');
  await p.context.loadNeeds(); assert.equal(p.sheets.length, 1, 'It opens by itself once, not on every refresh.');
  const asked = p.calls.length; p.context.scheduleNeeds();
  assert.equal(p.calls.length, asked, 'Away from home, progress updates ask for the list at most every 15 seconds.');

  await rows[0].handler();
  assert.equal(JSON.stringify(p.calls.at(-1)), JSON.stringify({ select: 'b', taskId: 't9' }), 'Another workspace’s task opens in its workspace.');
  p.S.projectId = 'a'; p.S.thread = null;
  await rows[2].handler();
  assert.equal(JSON.stringify(p.calls.at(-1)), JSON.stringify({ thread: 't2' }));
  assert.deepEqual(p.toasts, ['Review and merge it on your computer.'], 'What isn’t on the phone yet says where to do it.');
});

test('the Needs you count leaves out what is on screen, and an older computer keeps the old line (#201)', async () => {
  const p = page({ needs: [NEEDS[1]] });
  await p.context.loadNeeds();
  assert.equal(p.sheets.length, 0, 'Nothing waits elsewhere, so the chat stays in front.');
  assert.equal(p.context.needsElsewhere(), null);
  assert.equal(p.context.needHere(NEEDS[1]), true);

  const old = page({ status: 403 });
  old.S.needs = [];
  await old.context.loadNeeds();
  assert.equal(old.S.needs, null, 'A computer without the list falls back to the approvals line.');
  assert.equal(old.sheets.length, 0);
});

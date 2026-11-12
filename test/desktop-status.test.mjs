import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { alertMenu, currentAction, overlayBounds, progressLine, progressTrack, statusClickTarget, statusMenu, statusSnapshot, statusTitle, statusTooltip, taskbarIsLight } from '../desktop/status.mjs';
import { alertPreferences } from '../src/alerts.mjs';
import { createOverlay } from '../desktop/overlay.mjs';
import { appDetails, appOrder, giveFrontBack } from '../desktop/front.mjs';

// A registry stand-in: workspaces with their main conversation and, when an agent works, its run.
function registry(workspaces) {
  return {
    list: () => workspaces.map(({ id, name }) => ({ id, name })),
    brokers: new Map(workspaces.map(({ id, c, running = null }) => [id, { broker: { mainConversationId: c.id, conversations: new Map([[c.id, c]]), running: running && { c, ...running } } }])),
  };
}
const conversation = (id, extra = {}) => ({ id, messages: [], runs: [], queue: [], queuePaused: null, activeRun: null, lastRun: null, resume: null, retryOffer: null, handoffOffer: null, ...extra });
const step = text => ({ role: 'activity', runId: 'r', text });
const working = (messages, extra = {}) => conversation('c', { activeRun: { id: 'r', provider: 'codex', phase: 'tool' }, messages, ...extra });

test('a run’s current action is said in general words with a count, never a command, file path or the agent’s text', () => {
  const edits = step('File changes: [{"path":"src/checkout.js","kind":"modify"},{"path":"src/promo.js","kind":"add"}]');
  assert.equal(currentAction(working([edits])), 'Editing · 2 files changed');
  assert.equal(currentAction(working([step('Edit\n{"file_path":"/w/src/cart.js","old_string":"a","new_string":"b"}')])), 'Editing · 1 file changed');
  assert.equal(currentAction(working([step('$ npm test\n24 passing')])), 'Running tests');
  assert.equal(currentAction(working([step('$ curl -H "Authorization: Bearer secret" https://api.example.com')])), 'Running a command');
  assert.equal(currentAction(working([step('Bash\n{"command":"git push --force","description":"Push the secret branch"}')])), 'Running a command', 'The agent’s description is its own text and stays in the app.');
  assert.equal(currentAction(working([edits, step('Read\n{"file_path":"/w/src/cart.js"}')])), 'Reading files');
  assert.equal(currentAction(working([step('Grep\n{"pattern":"promo"}')])), 'Searching the project');
  assert.equal(currentAction(working([edits, step('mcp_tool_call: something')])), 'Working · 2 files changed');
  assert.equal(currentAction(working([{ ...step('$ npm test'), runId: 'earlier' }])), 'Working', 'Only the running run’s steps count.');
  assert.equal(currentAction(working([], { activeRun: { id: 'r', provider: 'codex', phase: 'starting' } })), 'Starting');
  assert.equal(currentAction(conversation('idle')), '');
});

test('the status lists busy workspaces, most urgent first, and leaves quiet ones out', () => {
  const approval = { id: 'ap1', title: 'Install the rate limiter', command: 'npm install express-rate-limit' };
  const snapshot = statusSnapshot(registry([
    { id: 'shop', name: 'acme-shop', c: working([step('$ npm test')]), running: { provider: 'codex', approvals: new Map() } },
    { id: 'api', name: 'payments-api', c: working([]), running: { provider: 'claude', approvals: new Map([['ap1', approval]]) } },
    { id: 'docs', name: 'docs', c: conversation('d', { resume: { providers: ['claude'] } }) },
    { id: 'web', name: 'web', c: conversation('w', { lastRun: { id: 'x', check: { status: 'failed' } } }) },
    { id: 'cli', name: 'cli', c: conversation('q', { queue: [{ id: 'q1' }, { id: 'q2' }], queuePaused: { reason: 'You stopped the run.' } }) },
    { id: 'idle', name: 'idle', c: conversation('i') },
  ]));
  assert.deepEqual(snapshot.rows.map(row => [row.name, row.kind, row.text]), [
    ['payments-api', 'approval', 'Approval needed · Claude'],
    ['web', 'failed', 'Tests failed'],
    ['acme-shop', 'running', 'Codex · Running tests'],
    ['docs', 'waiting', 'Waiting for a usage limit to reset'],
    ['cli', 'paused', 'Queue paused · 2 waiting'],
  ]);
  assert.deepEqual([snapshot.attention, snapshot.running], [2, 1]);
  assert.equal(snapshot.rows[0].approvalId, 'ap1');
  const offer = statusSnapshot(registry([{ id: 'shop', name: 'acme-shop', c: conversation('o', { retryOffer: { provider: 'claude' } }) }]));
  assert.deepEqual(offer.rows.map(row => [row.kind, row.text]), [['offer', 'Tests failed · retry with Claude?']]);
});

test('a scheduled run’s approval says it is scheduled and opens its task, and a schedule waiting for a reset is listed (#132)', () => {
  const c = conversation('m'), lanes = new Map();
  const lane = (id, requestId, approval) => lanes.set(id, { broker: { running: { provider: 'claude', approvals: new Map([[approval.id, approval]]) } }, c: { activeRun: { id: `run-${id}` }, messages: [] }, task: { id, requestId, folderName: 'api', status: 'running' } });
  lane('t1', 'schedule-abc-xyz-card', { id: 'ap1', title: 'Run the migration' });
  lane('t2', 'plan-1', { id: 'ap2', kind: 'question', questions: [] });
  const snapshot = statusSnapshot({ list: () => [{ id: 'p', name: 'payments' }], brokers: new Map([['p', { broker: { mainConversationId: 'm', conversations: new Map([['m', c]]), running: null, tasks: { lanes }, schedules: { resets: [{ id: 's1', title: 'Nightly tidy', provider: 'codex', resetsAt: null }] } } }]]) });
  assert.deepEqual(snapshot.rows.map(row => [row.kind, row.text, row.approvalId || null, row.taskId || null]), [
    ['approval', 'api: scheduled run needs approval', 'ap1', 't1'],
    ['approval', 'api: has a question', 'ap2', 't2'],
    ['waiting', 'Scheduled run waiting for Codex to reset', null, null],
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot.rows), /Nightly tidy|Run the migration/, 'A card’s title and the request stay in the app.');
  const opened = []; statusMenu(snapshot, { open: target => opened.push(target) })[2].click();
  assert.deepEqual(opened, [{ projectId: 'p', approvalId: 'ap1', taskId: 't1' }], 'It opens the task, where the approval is answered.');
  assert.equal(statusClickTarget({ rows: [snapshot.rows[0]] }).taskId, 't1');
});

test('the words beside the icon say what needs you, or what the one running agent is doing, or how many are working', () => {
  const rows = (...kinds) => ({ rows: kinds.map((kind, index) => ({ kind, attention: ['approval', 'failed', 'offer'].includes(kind), agent: 'Codex', action: index ? 'Reading files' : 'Editing checkout.js and 2 more files today' })), attention: kinds.filter(kind => ['approval', 'failed', 'offer'].includes(kind)).length, running: kinds.filter(kind => kind === 'running').length });
  assert.equal(statusTitle(rows()), '');
  assert.equal(statusTitle(rows('running')), 'Codex · Editing checkout.js and…', 'A long action is shortened.');
  assert.equal(statusTitle(rows('running', 'running')), '2 working');
  assert.equal(statusTitle(rows('approval', 'running')), 'Approval needed');
  assert.equal(statusTitle(rows('failed')), 'Tests failed');
  assert.equal(statusTitle(rows('approval', 'offer', 'running')), '2 need you');
  for (const kinds of [['running'], ['approval', 'running'], ['failed']]) assert.equal(statusTitle(rows(...kinds), undefined, { focused: true }), '', 'With a Codeshi window in front, the menu bar has no words.');
  assert.equal(statusTooltip(rows('approval')), 'Codeshi — Approval needed', 'The Windows tooltip only shows on hover, so it keeps its words.');
});

test('an agent’s question waits like an approval, says it is a question, and keeps its words in the app', () => {
  const question = { id: 'ask-1', kind: 'question', questions: [{ id: 'q1', header: 'Storage', question: 'Where should the secret sessions be kept?', options: [], multiple: false, other: true, secret: false }] };
  const snapshot = statusSnapshot(registry([{ id: 'api', name: 'payments-api', c: working([]), running: { provider: 'claude', approvals: new Map([['ask-1', question]]) } }]));
  assert.deepEqual(snapshot.rows.map(row => [row.name, row.kind, row.text, row.approvalId]), [['payments-api', 'approval', 'Claude has a question', 'ask-1']]);
  assert.equal(snapshot.attention, 1);
  assert.equal(statusTitle(snapshot), 'Question for you');
  assert.doesNotMatch(JSON.stringify(snapshot.rows), /secret sessions/, 'The question itself is the agent’s text and stays in the app.');
});

test('the status menu opens the right workspace or request and only changes Keep Awake when it is clicked', () => {
  const calls = [];
  const snapshot = { rows: [{ projectId: 'api', name: 'payments-api', kind: 'approval', text: 'Approval needed: npm install', approvalId: 'ap1', attention: true }, { projectId: 'shop', name: 'acme-shop', kind: 'running', text: 'Codex · Reading files' }], attention: 1, running: 1 };
  const alerts = alertPreferences({ sound: { on: true } });
  const template = statusMenu(snapshot, { keepAwake: { enabled: true, active: true }, alerts, setAlerts: patch => calls.push(['alerts', patch]), alertSettings: () => calls.push(['alert-settings']), open: target => calls.push(['open', target]), show: () => calls.push(['show']), setKeepAwake: value => calls.push(['keep-awake', value]), hide: () => calls.push(['hide']), quit: () => calls.push(['quit']) });
  const labels = items => items.map(item => item.type === 'separator' ? '-' : item.label);
  assert.deepEqual(labels(template), ['1 needs you · 1 working', '-', 'payments-api — Approval needed: npm install', 'acme-shop — Codex · Reading files', '-', 'Open Codeshi', 'Keep Awake', 'Keeping your Mac awake while agents work', 'Alerts', 'Hide from Menu Bar', '-', 'Quit Codeshi']);
  assert.equal(calls.length, 0, 'Building the menu changes nothing.');
  const item = label => template.find(entry => entry.label === label);
  // The status item's own Alerts menu turns each way on or off; hiding the status item has its own item.
  const submenu = item('Alerts').submenu, way = label => submenu.find(entry => entry.label === label);
  assert.deepEqual(labels(submenu), ['Banners', 'Sounds', 'Bounce the Dock Icon', 'Badge on the Dock Icon', '-', 'Pill Under the Menu Bar', '-', 'Alert Settings…']);
  assert.deepEqual(['Banners', 'Sounds', 'Bounce the Dock Icon', 'Badge on the Dock Icon'].map(label => [way(label).type, way(label).checked]), [['checkbox', true], ['checkbox', true], ['checkbox', true], ['checkbox', true]]);
  item('payments-api — Approval needed: npm install').click(); item('acme-shop — Codex · Reading files').click();
  item('Keep Awake').click(); way('Sounds').click(); way('Badge on the Dock Icon').click(); way('Alert Settings…').click(); item('Hide from Menu Bar').click();
  assert.deepEqual(calls, [['open', { projectId: 'api', approvalId: 'ap1' }], ['open', { projectId: 'shop' }], ['keep-awake', false], ['alerts', { sound: { on: false } }], ['alerts', { badge: { on: false } }], ['alert-settings'], ['hide']]);
  assert.equal(item('Keep Awake').checked, true);
  assert.equal(statusMenu({ rows: [], attention: 0, running: 0 })[0].label, 'Nothing running');
});

test('the Alerts menu lists the ways each system has: the taskbar flashes elsewhere, and Windows has its notification area', () => {
  const changes = [], labels = items => items.map(item => item.type === 'separator' ? '-' : item.label);
  const mac = alertMenu(alertPreferences({ statusItem: false }), { set: patch => changes.push(patch) });
  assert.deepEqual(labels(mac), ['Banners', 'Sounds', 'Bounce the Dock Icon', 'Badge on the Dock Icon', '-', 'Status in the Menu Bar', 'Pill Under the Menu Bar', '-', 'Alert Settings…']);
  mac.find(entry => entry.label === 'Status in the Menu Bar').click(); mac.find(entry => entry.label === 'Banners').click();
  assert.deepEqual(changes, [{ statusItem: true }, { banner: { on: false } }]);
  const windows = alertMenu(alertPreferences(), { platform: 'win32', set: patch => changes.push(patch) });
  assert.deepEqual(labels(windows), ['Banners', 'Sounds', 'Flash the Taskbar Button', '-', 'Status in the Notification Area', '-', 'Alert Settings…']);
  windows.find(entry => entry.label === 'Status in the Notification Area').click();
  assert.deepEqual(changes.at(-1), { statusItem: false });
  assert.deepEqual(labels(alertMenu(alertPreferences(), { platform: 'linux' })), ['Banners', 'Sounds', 'Flash the Taskbar Button', '-', 'Alert Settings…']);
  // A way is ticked only while it tells you about some moment, as Settings shows it; ticked with none, it gets all three.
  const none = alertMenu(alertPreferences({ sound: { on: true, attention: false, finished: false, stopped: false }, progressPill: true }), { set: patch => changes.push(patch) });
  assert.deepEqual(['Sounds', 'Pill Under the Menu Bar'].map(label => none.find(entry => entry.label === label).checked), [false, true]);
  none.find(entry => entry.label === 'Sounds').click(); none.find(entry => entry.label === 'Pill Under the Menu Bar').click();
  assert.deepEqual(changes.slice(-2), [{ sound: { on: true, attention: true, finished: true, stopped: true } }, { progressPill: false }]);
  const status = statusMenu({ rows: [], attention: 0, running: 0 }).find(item => item.label === 'Alerts').submenu.map(item => item.label).filter(Boolean);
  assert.deepEqual(status, ['Banners', 'Sounds', 'Bounce the Dock Icon', 'Badge on the Dock Icon', 'Pill Under the Menu Bar', 'Alert Settings…'], 'The status item’s own menu has the pill but leaves its status to Hide from Menu Bar.');
});

test('in the Windows notification area the state is in the tooltip, a click opens what needs you, and the menu uses Windows words (#74)', () => {
  const row = (kind, extra = {}) => ({ projectId: 'api', name: 'payments-api', kind, text: 'x', attention: ['approval', 'failed', 'offer'].includes(kind), ...extra });
  const snapshot = (...rows) => ({ rows, attention: rows.filter(item => item.attention).length, running: rows.filter(item => item.kind === 'running').length });
  assert.equal(statusTooltip(snapshot()), 'Codeshi');
  assert.equal(statusTooltip(snapshot(row('approval', { approvalId: 'ap1' }))), 'Codeshi — Approval needed');
  assert.equal(statusTooltip(snapshot(row('running', { agent: 'Codex', action: 'Reading files' }))), 'Codeshi — Codex · Reading files');
  assert.equal(statusTooltip(snapshot(row('approval'), row('failed'), row('running'))), 'Codeshi — 2 need you');
  assert(statusTooltip(snapshot(row('running', { agent: 'Codex', action: 'Working · '.repeat(40) }))).length < 128, 'Windows cuts a tooltip off at 127 characters.');
  // One thing waiting: the click goes to it. An approval opens its request card and is never answered on the way.
  assert.deepEqual(statusClickTarget(snapshot(row('approval', { approvalId: 'ap1' }), row('running'))), { projectId: 'api', approvalId: 'ap1' });
  assert.deepEqual(statusClickTarget(snapshot(row('failed'))), { projectId: 'api' });
  assert.deepEqual(statusClickTarget(snapshot(row('approval'))), { projectId: 'api' }, 'A task beside the main conversation asks in the window.');
  assert.equal(statusClickTarget(snapshot(row('approval', { approvalId: 'ap1' }), row('failed'))), null, 'With several waiting the window just comes forward.');
  assert.equal(statusClickTarget(snapshot(row('running'))), null);
  assert.equal(statusClickTarget(snapshot()), null);
  const labels = statusMenu(snapshot(), { platform: 'win32', keepAwake: { enabled: true, active: true } }).map(item => item.type === 'separator' ? '-' : item.label);
  assert.deepEqual(labels, ['Nothing running', '-', 'Open Codeshi', 'Keep Awake', 'Keeping your PC awake while agents work', 'Alerts', 'Hide from Notification Area', '-', 'Quit Codeshi']);
  assert.deepEqual(statusMenu(snapshot(), { platform: 'win32' }).find(item => item.label === 'Alerts').submenu.map(item => item.label).filter(Boolean), ['Banners', 'Sounds', 'Flash the Taskbar Button', 'Alert Settings…']);
  // The taskbar's colour, from `reg query`. Anything unreadable means dark, as Windows starts out.
  const reg = value => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\r\n    SystemUsesLightTheme    REG_DWORD    ${value}\r\n\r\n`;
  assert.deepEqual([reg('0x1'), reg('0x0'), reg('0x00000001'), '', undefined, 'ERROR: The system was unable to find the specified registry key or value.'].map(taskbarIsLight), [true, false, true, false, false, false]);
});

test('the overlay sits centred under the menu bar of its display, and its page runs only its own script', () => {
  assert.deepEqual(overlayBounds({ workArea: { x: 0, y: 38, width: 1512, height: 944 } }), { x: 546, y: 46, width: 420, height: 88 }, 'Below the menu bar, which is taller on a Mac with a notch.');
  assert.deepEqual(overlayBounds({ workArea: { x: 1512, y: 25, width: 2560, height: 1415 } }), { x: 2582, y: 33, width: 420, height: 88 }, 'On a second display, centred on that one.');
  const page = fs.readFileSync(new URL('../desktop/overlay.html', import.meta.url), 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert(page.includes(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`), 'The policy allows exactly the page’s script; update its hash when the script changes.');
  assert.match(page, /default-src 'none'/);
});

test('an alert taken away while the panel’s page loads never shows, and of several waiting only the latest does', () => {
  // The panel loads its page on the first alert. One that goes in the meantime must not leave an empty panel on top.
  function overlay() {
    const panel = { loaded: [], sent: [], shown: 0 };
    class Panel {
      constructor() { this.webContents = { isLoading: () => true, once: (_name, callback) => panel.loaded.push(callback), send: (_channel, alert) => panel.sent.push(alert.title), setWindowOpenHandler() {}, on() {} }; }
      setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile() {} setBounds() {} hide() {} destroy() {} isDestroyed() { return false; } showInactive() { panel.shown++; }
    }
    const screen = { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }) };
    return { panel, overlay: createOverlay({ BrowserWindow: Panel, screen, ipcMain: { on() {}, off() {} }, root: '/app', open() {}, mac: true }) };
  }
  const first = overlay();
  first.overlay.show({ kind: 'approval', title: 'Approval needed', projectName: 'Shop' }); first.overlay.hide();
  for (const callback of first.panel.loaded) callback();
  assert.deepEqual([first.panel.sent, first.panel.shown], [[], 0]);
  first.overlay.dispose();
  const second = overlay();
  second.overlay.show({ kind: 'finished', title: 'Task finished' }); second.overlay.show({ kind: 'failed', title: 'Task failed' });
  for (const callback of second.panel.loaded) callback();
  assert.deepEqual([second.panel.sent, second.panel.shown], [['Task failed'], 1]);
  second.overlay.dispose();
});

// Two workspaces whose runs have their own ids, as real runs do.
const busy = (shopSteps, apiSteps = null) => statusSnapshot(registry([
  { id: 'shop', name: 'acme-shop', c: conversation('s', { activeRun: { id: 'r1', provider: 'codex', phase: 'tool' }, messages: shopSteps.map(text => ({ role: 'activity', runId: 'r1', text })) }), running: { provider: 'codex', approvals: new Map() } },
  ...(apiSteps ? [{ id: 'api', name: 'payments-api', c: conversation('a', { activeRun: { id: 'r2', provider: 'claude', phase: 'tool' }, messages: apiSteps.map(text => ({ role: 'activity', runId: 'r2', text })) }), running: { provider: 'claude', approvals: new Map() } }] : []),
]));

test('the progress pill reads like the menu bar for one run, and gives the count and the latest step for several (#75)', () => {
  const one = busy(['$ npm test']);
  assert.deepEqual(one.rows.map(row => row.key), ['run:r1'], 'Each running row names its run.');
  let track = progressTrack(undefined, one);
  assert.deepEqual(progressLine(one, track.latest), { title: 'Codex · Running tests', detail: 'acme-shop', projectId: 'shop' });
  // Payments starts; it is the latest to change.
  const two = busy(['$ npm test'], ['Read\n{"file_path":"/w/a.js"}']);
  track = progressTrack(track, two);
  assert.deepEqual(progressLine(two, track.latest), { title: '2 working', detail: 'payments-api: Claude · Reading files', projectId: 'api' });
  // Then the shop's step changes, and the pill names it.
  const edited = busy(['$ npm test', 'Edit\n{"file_path":"/w/cart.js","old_string":"a","new_string":"b"}'], ['Read\n{"file_path":"/w/a.js"}']);
  track = progressTrack(track, edited);
  assert.equal(progressLine(edited, track.latest).detail, 'acme-shop: Codex · Editing · 1 file changed');
  // Nothing running says nothing.
  const quiet = statusSnapshot(registry([{ id: 'idle', name: 'idle', c: conversation('i') }]));
  assert.equal(progressLine(quiet, progressTrack(track, quiet).latest), null);
  assert.equal(progressTrack(track, quiet).latest, null, 'A run that ended is forgotten.');
});

test('the progress pill shows only away from Codeshi, stays put as its words change, gives way to alerts and hides with its × until Codeshi has been in front again (#75)', () => {
  const panel = { sent: [], shown: 0, bounds: 0, hidden: 0 }, handlers = {}, opened = [];
  class Panel {
    constructor() { panel.window = this; this.webContents = { isLoading: () => false, once() {}, send: (_channel, content) => panel.sent.push(`${content.kind}: ${content.title}${content.body ? ` | ${content.body}` : ''}`), setWindowOpenHandler() {}, on() {} }; }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile() {} setBounds() { panel.bounds++; } hide() { panel.hidden++; } destroy() {} isDestroyed() { return false; } showInactive() { panel.shown++; }
  }
  const screen = { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }) };
  let focused = false, clock = 0, yielded = 0;
  const overlay = createOverlay({ BrowserWindow: Panel, screen, ipcMain: { on: (name, callback) => { handlers[name] = callback; }, off() {} }, root: '/app', open: target => opened.push(target), mac: true, isFocused: () => focused, yieldFront: () => { yielded++; }, now: () => clock });
  const click = name => handlers[name]({ sender: panel.window.webContents });
  const one = busy(['$ npm test']);
  overlay.progress(one, { enabled: false });
  assert.equal(panel.sent.length, 0, 'Off until turned on.');
  focused = true; overlay.progress(one, { enabled: true });
  assert.equal(panel.sent.length, 0, 'Not while Codeshi is in front.');
  focused = false; overlay.refresh();
  assert.deepEqual([panel.sent, panel.shown, panel.bounds], [['progress: Codex · Running tests | acme-shop'], 1, 1]);
  overlay.progress(one, { enabled: true });
  assert.equal(panel.sent.length, 1, 'The same words are not sent again.');
  overlay.progress(busy(['$ npm test'], ['Grep\n{"pattern":"x"}']), { enabled: true });
  assert.deepEqual([panel.sent.at(-1), panel.shown, panel.bounds], ['progress: 2 working | payments-api: Claude · Searching the project', 1, 1], 'Changed in place, without moving or showing again.');
  // An alert takes the panel, and the pill comes back when it goes, without the panel hiding in between.
  overlay.show({ kind: 'finished', title: 'Task finished', projectName: 'docs' });
  assert.equal(panel.sent.at(-1), 'finished: Task finished');
  overlay.progress(busy(['$ npm test'], ['Read\n{"file_path":"/w/a.js"}']), { enabled: true });
  assert.equal(panel.sent.at(-1), 'finished: Task finished', 'Progress waits while an alert shows.');
  const hidden = panel.hidden; overlay.hide();
  assert.deepEqual([panel.sent.at(-1), panel.hidden], ['progress: 2 working | payments-api: Claude · Reading files', hidden]);
  // Clicking opens the workspace it names.
  click('overlay:open');
  assert.deepEqual(opened, [{ projectId: 'api' }]);
  focused = true; overlay.refresh(); focused = false;
  // × hides it for this time away, whatever runs go on or start, and leaves the person in the app they were in.
  clock = 10000; overlay.refresh(); click('overlay:dismiss');
  assert.deepEqual([overlay.pill, yielded], [null, 0], 'Codeshi did not come forward, so there is no front to give back.');
  const before = panel.sent.length;
  overlay.progress(busy(['$ npm test', 'Grep\n{"pattern":"y"}'], ['Read\n{"file_path":"/w/a.js"}']), { enabled: true });
  const next = statusSnapshot(registry([{ id: 'shop', name: 'acme-shop', c: conversation('s', { activeRun: { id: 'r3', provider: 'codex', phase: 'starting' } }), running: { provider: 'codex', approvals: new Map() } }]));
  overlay.progress(next, { enabled: true });
  assert.equal(panel.sent.length, before, 'It stays hidden as steps change and as another run starts.');
  // Back from a visit to Codeshi, it shows again.
  clock = 20000; focused = true; overlay.refresh(); focused = false; overlay.refresh();
  assert.equal(panel.sent.at(-1), 'progress: Codex · Starting | acme-shop');
  // macOS brings Codeshi forward on a press in the panel, which takes the pill away before the press is heard.
  // The × still counts, the front goes back, and the focus the press caused is not a visit.
  clock = 30000; focused = true; overlay.hide(); overlay.refresh();
  assert.equal(overlay.pill, null);
  clock = 30040; click('overlay:dismiss');
  assert.equal(yielded, 1, 'The front is given back.');
  clock = 30200; overlay.refresh(); focused = false; overlay.refresh();
  assert.equal(overlay.pill, null, 'Still hidden once the other app is in front again.');
  // The press heard first, and Codeshi coming forward after it.
  clock = 40000; focused = true; overlay.refresh(); focused = false; overlay.refresh();
  assert.notEqual(overlay.pill, null);
  clock = 50000; click('overlay:dismiss'); clock = 50030; focused = true; overlay.hide(); overlay.refresh(); focused = false; overlay.refresh();
  assert.equal(overlay.pill, null);
  // A press long after the panel went is about nothing.
  clock = 60000; const opens = opened.length; click('overlay:open'); click('overlay:dismiss');
  assert.deepEqual([opened.length, yielded], [opens, 1]);
  clock = 70000; focused = true; overlay.refresh(); focused = false; overlay.refresh();
  assert.equal(panel.sent.at(-1), 'progress: Codex · Starting | acme-shop');
  // When the work ends, the pill goes.
  const hiddenBefore = panel.hidden;
  overlay.progress(statusSnapshot(registry([{ id: 'idle', name: 'idle', c: conversation('i') }])), { enabled: true });
  assert.deepEqual([overlay.pill, panel.hidden], [null, hiddenBefore + 1]);
  overlay.dispose();
});

test('a press that brought Codeshi forward still opens what the panel named', () => {
  const handlers = {}, opened = []; let window = null, focused = false, clock = 0;
  class Panel {
    constructor() { window = this; this.webContents = { isLoading: () => false, once() {}, send() {}, setWindowOpenHandler() {}, on() {} }; }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile() {} setBounds() {} hide() {} destroy() {} isDestroyed() { return false; } showInactive() {}
  }
  const screen = { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }) };
  let yielded = 0;
  const overlay = createOverlay({ BrowserWindow: Panel, screen, ipcMain: { on: (name, callback) => { handlers[name] = callback; }, off() {} }, root: '/app', open: target => opened.push(target.approvalId), mac: true, isFocused: () => focused, yieldFront: () => { yielded++; }, now: () => clock });
  overlay.show({ kind: 'approval', title: 'Approval needed', projectId: 'shop', approvalId: 'a1' });
  // The window's focus takes the alert away first, then the press arrives.
  focused = true; overlay.hide(); clock = 50; handlers['overlay:open']({ sender: window.webContents });
  assert.deepEqual([opened, yielded], [['a1'], 0]);
  handlers['overlay:open']({ sender: window.webContents });
  assert.equal(opened.length, 1, 'Once.');
  // An alert's × gives the front back too.
  focused = false; overlay.show({ kind: 'approval', title: 'Approval needed', projectId: 'shop', approvalId: 'a2' });
  focused = true; overlay.hide(); clock = 100; handlers['overlay:dismiss']({ sender: window.webContents });
  assert.deepEqual([opened.length, yielded], [1, 1]);
  overlay.dispose();
});

test('the front goes back to the app behind Codeshi, and only when Codeshi is in front', async () => {
  assert.deepEqual(appOrder('ASN:0x0-0x2f3af38-"Codeshi": ASN:0x0-0x27af7ad-"ChatGPT": ASN:0x0-0x2b02b-"Finder":'), ['ASN:0x0-0x2f3af38', 'ASN:0x0-0x27af7ad', 'ASN:0x0-0x2b02b']);
  assert.deepEqual(appDetails('[ NULL ]  ASN:0x0-0x27af7ad: \n    bundle path="/Applications/ChatGPT.app"\n    pid = 81069 !cgsConnection'), { pid: 81069, path: '/Applications/ChatGPT.app' });
  assert.deepEqual(appDetails('    bundle path=[ NULL ] \n'), { pid: null, path: null });
  const info = { 'ASN:0x0-0x1': 'bundle path="/Applications/Codeshi.app"\n pid = 7 !', 'ASN:0x0-0x2': 'bundle path=[ NULL ]\n pid = 8 !', 'ASN:0x0-0x3': 'bundle path="/Applications/Notes.app"\n pid = 9 !' };
  const machine = front => { const calls = []; return { calls, execFile: (file, args, _options, done) => { calls.push([file.split('/').pop(), ...args].join(' ')); done(null, file.endsWith('open') ? '' : args[0] === 'front' ? `${front}:\n` : args[0] === 'visibleProcessList' ? 'ASN:0x0-0x1-"Codeshi": ASN:0x0-0x2-"Helper": ASN:0x0-0x3-"Notes":' : info[args[3]]); } }; };
  const ours = machine('ASN:0x0-0x1');
  assert.equal(await giveFrontBack({ pid: 7, execFile: ours.execFile, platform: 'darwin' }), true);
  assert.equal(ours.calls.at(-1), 'open /Applications/Notes.app', 'The first app behind it that can be opened.');
  const theirs = machine('ASN:0x0-0x3');
  assert.equal(await giveFrontBack({ pid: 7, execFile: theirs.execFile, platform: 'darwin' }), false);
  assert(!theirs.calls.some(call => call.startsWith('open')), 'Another app is in front already, so nothing is brought forward.');
  assert.equal(await giveFrontBack({ pid: 7, execFile: ours.execFile, platform: 'win32' }), false);
});

test('the panel announces alerts, but its progress pill is quiet: no announcement and no drop animation', () => {
  const page = fs.readFileSync(new URL('../desktop/overlay.html', import.meta.url), 'utf8');
  assert.match(page, /if \(progress\) alert\.removeAttribute\('role'\)/);
  assert.match(page, /#alert:not\(\[hidden\]\):not\(\[data-kind="progress"\]\) \{ animation: drop/);
  assert.match(page, /\[data-kind="progress"\]#alert \{[^}]*backdrop-filter: none/, 'Nothing to redraw while it stays on screen.');
});

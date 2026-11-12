import { alertDefaults } from '../src/alerts.mjs';
import { latestEdit } from '../src/activity-format.mjs';
import { runSteps, TESTS } from '../src/recap.mjs';
import { english } from '../src/i18n.mjs';

// Live status outside the window: a status item in the macOS menu bar (#13) or an icon in the Windows notification
// area (#74) and, on macOS when turned on, alerts near the top of the screen. They read the same run state as the
// page and the Dock badge, from the workspaces Codeshi has open; nothing here starts, answers or changes work, except Keep Awake when it is clicked. Like notifications,
// they never show commands, chat text or file paths, which anyone looking at the screen could read: an action is
// said in general words with a count. The state and the menu are built without Electron so they can be tested;
// desktop/main.mjs shows them. Their words come from `text`, the interface language (#27); English when not given.
const agents = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
const clip = (text, max) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value; };

// The latest edit in a workspace's running task, for the preview's toolbar (#102). Null when nothing is running there.
export function runningEdit(registry, projectId) {
  let entry = null; try { entry = registry.brokers.get(projectId); } catch { return null; }
  const broker = entry?.broker, c = broker?.running?.c, run = c?.activeRun;
  if (!run) return null;
  return latestEdit(c.messages.filter(message => message.runId === run.id).slice(-200), (broker.workspaces || []).map(String));
}

// What a run is doing, from its latest step, in general words: "Editing · 3 files changed", "Running tests".
export function currentAction(c, { t, tn } = english) {
  const run = c.activeRun;
  if (!run) return '';
  if (c.runs?.some(item => item.check?.status === 'running')) return t('Running the tests');
  const steps = c.messages?.filter(message => message.runId === run.id && message.role === 'activity') || [];
  const text = String(steps.at(-1)?.text || ''), changed = runSteps(steps).files.length;
  const tool = text.match(/^([A-Za-z_][\w-]*)\n(\{.*\})/);
  let input = {}; if (tool) try { input = JSON.parse(tool[2]); } catch { /* Only the tool's name is known. */ }
  if (text.startsWith('File changes:') || ['Edit', 'MultiEdit', 'Write', 'edit_file', 'write_file', 'NotebookEdit'].includes(tool?.[1])) return changed ? tn(changed, 'Editing · 1 file changed', 'Editing · {count} files changed') : t('Editing');
  if (text.startsWith('$ ') || tool?.[1] === 'Bash') return TESTS.test(text.startsWith('$ ') ? text.split('\n')[0] : String(input.command || '')) ? t('Running tests') : t('Running a command');
  if (['Read', 'read_file'].includes(tool?.[1])) return t('Reading files');
  if (['Grep', 'Glob', 'search_files'].includes(tool?.[1])) return t('Searching the project');
  if (['WebFetch', 'WebSearch', 'search_web'].includes(tool?.[1])) return t('Searching the web');
  return run.phase === 'starting' ? t('Starting') : changed ? tn(changed, 'Working · 1 file changed', 'Working · {count} files changed') : t('Working');
}

// One row for each workspace that is busy or needs the person, most urgent first: an approval, then failed tests, a
// retry or handoff to answer, then work in progress, a wait for a limit to reset and a paused queue. Quiet
// workspaces are left out.
export function statusSnapshot(registry, text = english) {
  const { t } = text;
  const names = new Map(registry.list().map(project => [project.id, project.name]));
  const rows = [];
  for (const [projectId, { broker }] of registry.brokers) {
    const c = broker.conversations.get(broker.mainConversationId) || [...broker.conversations.values()][0];
    if (!c) continue;
    const name = names.get(projectId) || t('Workspace'), running = broker.running?.c === c ? broker.running : null;
    const add = (kind, text, extra = {}) => rows.push({ projectId, name, kind, text, attention: ['approval', 'failed', 'offer'].includes(kind), ...extra });
    const approval = running && [...running.approvals.values()][0];
    // An agent's question waits like an approval, and says it is a question.
    if (approval) add('approval', approval.kind === 'question' ? agents[running.provider] ? t('{agent} has a question', { agent: agents[running.provider] }) : t('The agent has a question') : t('Approval needed · {agent}', { agent: agents[running.provider] || t('Agent') }), { approvalId: approval.id, agent: agents[running.provider], ...(approval.kind === 'question' ? { question: true } : {}) });
    else if (c.retryOffer && !running) add('offer', t('Tests failed · retry with {agent}?', { agent: agents[c.retryOffer.provider] }));
    else if (c.handoffOffer && running) add('offer', t('{agent} is at {percent}% · hand off?', { agent: agents[c.handoffOffer.from.provider], percent: Math.round(c.handoffOffer.from.usedPercent) }));
    else if (!running && c.lastRun?.check?.status === 'failed' && !c.resume) add('failed', t('Tests failed'));
    // A running row's key names its run, so the panel near the top of the screen can tell runs apart (#75).
    else if (running && c.activeRun) { const action = currentAction(c, text); add('running', `${agents[running.provider] || t('Agent')} · ${action}`, { agent: agents[running.provider], action, key: `run:${c.activeRun.id}` }); }
    else if (c.runs?.some(run => run.check?.status === 'running')) add('running', t('Running the tests'), { action: t('Running the tests'), key: `tests:${projectId}` });
    else if (c.resume) add('waiting', t('Waiting for a usage limit to reset'));
    else if (c.queue?.length && c.queuePaused) add('paused', text.tn(c.queue.length, 'Queue paused · 1 waiting', 'Queue paused · {count} waiting'));
    // Tasks beside the main conversation (#88). Their approvals are answered in the window, where the task says what it's asking.
    for (const { broker: lane, c: own, task } of broker.tasks?.lanes.values() || []) {
      const run = lane.running, asking = run && [...run.approvals.values()][0];
      if (asking) add('approval', asking.kind === 'question' ? t('{folder}: has a question', { folder: task.folderName }) : t('{folder}: approval needed', { folder: task.folderName }));
      else if (run && own?.activeRun) { const action = currentAction(own, text); add('running', `${task.folderName} · ${agents[run.provider] || t('Agent')} · ${action}`, { agent: agents[run.provider], action, key: `run:${own.activeRun.id}` }); }
      else if (task.worktree && task.status === 'complete') add('offer', t('{folder}: ready to merge', { folder: task.folderName }));
    }
  }
  const order = ['approval', 'failed', 'offer', 'running', 'waiting', 'paused'];
  rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
  return { rows, attention: rows.filter(row => row.attention).length, running: rows.filter(row => row.kind === 'running').length };
}

// The words beside the icon: what needs the person, or what the one running agent is doing, or how many are working.
// While a Codeshi window is in front there are none: the window already shows it. The icon and its menu stay.
export function statusTitle({ rows, attention, running }, { t, tn } = english, { focused = false } = {}) {
  if (focused) return '';
  if (attention === 1) { const row = rows.find(item => item.attention); return row.kind === 'approval' ? row.question ? t('Question for you') : t('Approval needed') : row.kind === 'failed' ? t('Tests failed') : t('Needs you'); }
  if (attention > 1) return tn(attention, '1 needs you', '{count} need you');
  if (running === 1) { const row = rows.find(item => item.kind === 'running'); return clip(row.agent ? `${row.agent} · ${row.action}` : row.action, 32); }
  if (running > 1) return tn(running, '1 working', '{count} working');
  return '';
}

// Live progress in the panel near the top of the screen (#75). `track` remembers each run's words, so the pill can
// name the run whose step changed last; it starts from `progressTrack()` and is replaced by each new result.
export function progressTrack(previous = { texts: new Map(), latest: null }, snapshot) {
  const texts = new Map(); let latest = previous.latest;
  for (const row of snapshot?.rows || []) if (row.kind === 'running' && row.key) { texts.set(row.key, row.text); if (previous.texts.get(row.key) !== row.text) latest = row.key; }
  return { texts, latest: texts.has(latest) ? latest : null };
}

// The pill's one line, or null when nothing is running. One
// run reads like the menu bar ("Codex · Editing · 3 files changed") with its workspace; several give the count and
// the run whose step changed last ("2 working", "Shop: Codex · Editing").
export function progressLine(snapshot, latest, { t, tn } = english) {
  const running = (snapshot?.rows || []).filter(row => row.kind === 'running' && row.key);
  if (!running.length) return null;
  const row = running.find(item => item.key === latest) || running[0];
  if (running.length === 1) return { title: clip(row.text, 60), detail: clip(row.name, 40), projectId: row.projectId };
  return { title: tn(running.length, '1 working', '{count} working'), detail: clip(`${row.name}: ${row.text}`, 70), projectId: row.projectId };
}

// Windows shows no words beside a notification area icon (#74), so they go in its tooltip, after the app's name.
export function statusTooltip(snapshot, text = english) {
  const title = statusTitle(snapshot, text);
  return title ? `Codeshi — ${title}` : 'Codeshi';
}

// A left click on the Windows icon brings Codeshi forward. When exactly one thing needs the person it opens that
// workspace, or that approval's request card, which is never answered on the way; otherwise the window as it is.
export function statusClickTarget(snapshot) {
  const waiting = snapshot.rows.filter(row => row.attention);
  if (waiting.length !== 1) return null;
  const [row] = waiting;
  return row.kind === 'approval' && row.approvalId ? { projectId: row.projectId, approvalId: row.approvalId } : { projectId: row.projectId };
}

// Windows colours its taskbar apart from its apps, so the icon follows the taskbar's own setting, read from the
// output of `reg query …\Themes\Personalize /v SystemUsesLightTheme`. Unknown means dark, as Windows starts out.
export function taskbarIsLight(output) {
  return /SystemUsesLightTheme\s+REG_DWORD\s+0x0*1\b/i.test(String(output || ''));
}

export function statusMenu(snapshot, { platform = 'darwin', text = english, keepAwake = { enabled: false, active: false }, alerts = alertDefaults, setAlerts = () => {}, alertSettings = () => {}, open = () => {}, show = () => {}, setKeepAwake = () => {}, hide = () => {}, quit = () => {} } = {}) {
  const separator = { type: 'separator' }, mac = platform === 'darwin', { t, tn } = text;
  const summary = snapshot.rows.length ? [snapshot.attention ? tn(snapshot.attention, '1 needs you', '{count} need you') : '', snapshot.running ? tn(snapshot.running, '1 working', '{count} working') : ''].filter(Boolean).join(' · ') || t('Waiting') : t('Nothing running');
  // An approval opens its own request card; it is never answered from here.
  const rows = snapshot.rows.map(row => ({ label: `${row.name} — ${row.text}`, click: () => open(row.kind === 'approval' ? { projectId: row.projectId, approvalId: row.approvalId } : { projectId: row.projectId }) }));
  return [
    { label: summary, enabled: false },
    ...rows.length ? [separator, ...rows] : [],
    separator,
    { label: t('Open Codeshi'), click: show },
    { label: t('Keep Awake'), type: 'checkbox', checked: keepAwake.enabled, click: () => setKeepAwake(!keepAwake.enabled) },
    ...keepAwake.active ? [{ label: mac ? t('Keeping your Mac awake while agents work') : t('Keeping your PC awake while agents work'), enabled: false }] : [],
    // This menu belongs to the status item, so hiding it has its own item rather than a switch under Alerts.
    { label: t('Alerts'), submenu: alertMenu(alerts, { platform, text, statusItem: false, set: setAlerts, settings: alertSettings }) },
    { label: mac ? t('Hide from Menu Bar') : t('Hide from Notification Area'), click: hide },
    separator,
    { label: t('Quit Codeshi'), click: quit },
  ];
}

// The ways Codeshi alerts you while you are in another app, each on or off, for the Agent menu and the status
// item's menu. Alert Settings… chooses each way for each moment, and how banners show. Other systems have no Dock:
// the taskbar button flashes instead of the icon bouncing. Windows has its status in the notification area (#74).
export function alertMenu(preferences, { platform = 'darwin', text = english, statusItem = true, set = () => {}, settings = () => {} } = {}) {
  // A way is ticked when it tells you about at least one moment, as Settings shows it. Ticking a way that has no
  // moment left turns it on for all three.
  const { t } = text, mac = platform === 'darwin', windows = platform === 'win32', moments = ['attention', 'finished', 'stopped'];
  const way = (label, channel) => {
    const value = preferences[channel], some = moments.some(moment => value[moment]), checked = Boolean(value.on && some);
    return { label, type: 'checkbox', checked, click: () => set({ [channel]: checked ? { on: false } : { on: true, ...some ? {} : Object.fromEntries(moments.map(moment => [moment, true])) } }) };
  };
  // Live status after the alerts, as in Settings: the menu bar status and the pill under it (#75) both say what
  // agents are doing, quietly. The status item's own menu leaves its status out, as it has Hide from Menu Bar.
  const live = [
    ...(mac || windows) && statusItem ? [{ label: mac ? t('Status in the Menu Bar') : t('Status in the Notification Area'), type: 'checkbox', checked: preferences.statusItem, click: () => set({ statusItem: !preferences.statusItem }) }] : [],
    ...mac && typeof preferences.progressPill === 'boolean' ? [{ label: t('Pill Under the Menu Bar'), type: 'checkbox', checked: preferences.progressPill, click: () => set({ progressPill: !preferences.progressPill }) }] : [],
  ];
  return [
    way(t('Banners'), 'banner'),
    way(t('Sounds'), 'sound'),
    way(mac ? t('Bounce the Dock Icon') : t('Flash the Taskbar Button'), 'bounce'),
    ...mac ? [way(t('Badge on the Dock Icon'), 'badge')] : [],
    ...live.length ? [{ type: 'separator' }, ...live] : [],
    { type: 'separator' },
    { label: t('Alert Settings…'), click: settings },
  ];
}

// The overlay sits centred under the menu bar of the display the pointer is on, clear of the notch.
export function overlayBounds(display, { width = 420, height = 88 } = {}) {
  const area = display.workArea;
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + 8), width, height };
}

import { runSteps, TESTS } from '../src/recap.mjs';

// Live status outside the window on macOS (#13): a status item in the menu bar and, when turned on, alerts near the
// top of the screen. Both read the same run state as the page and the Dock badge, from the workspaces Throughline
// has open; nothing here starts, answers or changes work, except Keep Awake when it is clicked. Like notifications,
// they never show commands, chat text or file paths, which anyone looking at the screen could read: an action is
// said in general words with a count. The state and the menu are built without Electron so they can be tested;
// desktop/main.mjs shows them.
const agents = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
const clip = (text, max) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value; };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// What a run is doing, from its latest step, in general words: "Editing · 3 files changed", "Running tests".
export function currentAction(c) {
  const run = c.activeRun;
  if (!run) return '';
  if (c.runs?.some(item => item.check?.status === 'running')) return 'Running the tests';
  const steps = c.messages?.filter(message => message.runId === run.id && message.role === 'activity') || [];
  const text = String(steps.at(-1)?.text || ''), changed = runSteps(steps).files.length;
  const tool = text.match(/^([A-Za-z_][\w-]*)\n(\{.*\})/);
  let input = {}; if (tool) try { input = JSON.parse(tool[2]); } catch { /* Only the tool's name is known. */ }
  if (text.startsWith('File changes:') || ['Edit', 'MultiEdit', 'Write', 'edit_file', 'write_file', 'NotebookEdit'].includes(tool?.[1])) return changed ? `Editing · ${plural(changed, 'file')} changed` : 'Editing';
  if (text.startsWith('$ ') || tool?.[1] === 'Bash') return TESTS.test(text.startsWith('$ ') ? text.split('\n')[0] : String(input.command || '')) ? 'Running tests' : 'Running a command';
  if (['Read', 'read_file'].includes(tool?.[1])) return 'Reading files';
  if (['Grep', 'Glob', 'search_files'].includes(tool?.[1])) return 'Searching the project';
  if (['WebFetch', 'WebSearch', 'search_web'].includes(tool?.[1])) return 'Searching the web';
  return run.phase === 'starting' ? 'Starting' : changed ? `Working · ${plural(changed, 'file')} changed` : 'Working';
}

// One row for each workspace that is busy or needs the person, most urgent first: an approval, then failed tests, a
// retry or handoff to answer, then work in progress, a wait for a limit to reset and a paused queue. Quiet
// workspaces are left out.
export function statusSnapshot(registry) {
  const names = new Map(registry.list().map(project => [project.id, project.name]));
  const rows = [];
  for (const [projectId, { broker }] of registry.brokers) {
    const c = broker.conversations.get(broker.mainConversationId) || [...broker.conversations.values()][0];
    if (!c) continue;
    const name = names.get(projectId) || 'Workspace', running = broker.running?.c === c ? broker.running : null;
    const add = (kind, text, extra = {}) => rows.push({ projectId, name, kind, text, attention: ['approval', 'failed', 'offer'].includes(kind), ...extra });
    const approval = running && [...running.approvals.values()][0];
    // An agent's question waits like an approval, and says it is a question.
    if (approval) add('approval', approval.kind === 'question' ? `${agents[running.provider] || 'The agent'} has a question` : `Approval needed · ${agents[running.provider] || 'Agent'}`, { approvalId: approval.id, agent: agents[running.provider], ...(approval.kind === 'question' ? { question: true } : {}) });
    else if (c.retryOffer && !running) add('offer', `Tests failed · retry with ${agents[c.retryOffer.provider]}?`);
    else if (c.handoffOffer && running) add('offer', `${agents[c.handoffOffer.from.provider]} is at ${Math.round(c.handoffOffer.from.usedPercent)}% · hand off?`);
    else if (!running && c.lastRun?.check?.status === 'failed' && !c.resume) add('failed', 'Tests failed');
    else if (running && c.activeRun) add('running', `${agents[running.provider] || 'Agent'} · ${currentAction(c)}`, { agent: agents[running.provider], action: currentAction(c) });
    else if (c.runs?.some(run => run.check?.status === 'running')) add('running', 'Running the tests', { action: 'Running the tests' });
    else if (c.resume) add('waiting', 'Waiting for a usage limit to reset');
    else if (c.queue?.length && c.queuePaused) add('paused', `Queue paused · ${c.queue.length} waiting`);
  }
  const order = ['approval', 'failed', 'offer', 'running', 'waiting', 'paused'];
  rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
  return { rows, attention: rows.filter(row => row.attention).length, running: rows.filter(row => row.kind === 'running').length };
}

// The words beside the icon: what needs the person, or what the one running agent is doing, or how many are working.
export function statusTitle({ rows, attention, running }) {
  if (attention === 1) { const row = rows.find(item => item.attention); return row.kind === 'approval' ? row.question ? 'Question for you' : 'Approval needed' : row.kind === 'failed' ? 'Tests failed' : 'Needs you'; }
  if (attention > 1) return `${attention} need you`;
  if (running === 1) { const row = rows.find(item => item.kind === 'running'); return clip(row.agent ? `${row.agent} · ${row.action}` : row.action, 32); }
  if (running > 1) return `${running} working`;
  return '';
}

export function statusMenu(snapshot, { keepAwake = { enabled: false, active: false }, overlay = false, open = () => {}, show = () => {}, setKeepAwake = () => {}, setOverlay = () => {}, hide = () => {}, quit = () => {} } = {}) {
  const separator = { type: 'separator' };
  const summary = snapshot.rows.length ? [snapshot.attention ? `${snapshot.attention} need${snapshot.attention === 1 ? 's' : ''} you` : '', snapshot.running ? `${snapshot.running} working` : ''].filter(Boolean).join(' · ') || 'Waiting' : 'Nothing running';
  // An approval opens its own request card; it is never answered from here.
  const rows = snapshot.rows.map(row => ({ label: `${row.name} — ${row.text}`, click: () => open(row.kind === 'approval' ? { projectId: row.projectId, approvalId: row.approvalId } : { projectId: row.projectId }) }));
  return [
    { label: summary, enabled: false },
    ...rows.length ? [separator, ...rows] : [],
    separator,
    { label: 'Open Throughline', click: show },
    { label: 'Keep Awake', type: 'checkbox', checked: keepAwake.enabled, click: () => setKeepAwake(!keepAwake.enabled) },
    ...keepAwake.active ? [{ label: 'Keeping your Mac awake while agents work', enabled: false }] : [],
    { label: 'Show Alerts Near the Top of the Screen', type: 'checkbox', checked: overlay, click: () => setOverlay(!overlay) },
    { label: 'Hide from Menu Bar', click: hide },
    separator,
    { label: 'Quit Throughline', click: quit },
  ];
}

// Where an alert goes when something finishes or needs an answer while the window is elsewhere. The Dock badge
// always counts it. The overlay, when turned on, takes the place of the system banner, so an alert is never shown twice.
export function alertChannels({ focused, preferences, overlayAvailable = true }) {
  if (focused) return { badge: false, bounce: false, notification: false, overlay: false };
  if (!preferences.enabled) return { badge: true, bounce: false, notification: false, overlay: false };
  const overlay = preferences.overlay === true && overlayAvailable;
  return { badge: true, bounce: true, notification: !overlay, overlay };
}

// The overlay sits centred under the menu bar of the display the pointer is on, clear of the notch.
export function overlayBounds(display, { width = 420, height = 88 } = {}) {
  const area = display.workArea;
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + 8), width, height };
}

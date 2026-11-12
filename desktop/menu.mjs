// The menu bar. The template is built without Electron so it can be tested; desktop/main.mjs builds it with
// Menu.buildFromTemplate and rebuilds it when the page, the saved appearance or Keep Awake changes. Items that
// act on the page send it a command, so each runs the same code as the shortcut or button it stands for.
import { alertDefaults } from '../src/alerts.mjs';
import { alertMenu } from './status.mjs';
import { english } from '../src/i18n.mjs';

const repository = 'https://github.com/AhmedNavaz/codeshi', patreon = 'https://www.patreon.com/17048317/join';
const agents = ['codex', 'claude', 'gemini'], names = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini' };
const flags = ['workspace', 'running', 'codex', 'claude', 'gemini', 'files', 'git', 'terminal', 'flow', 'flowLocked', 'imports', 'export'];
// What the menu offers until the page reports: nothing that needs a workspace.
const initial = { workspace: false, running: false, agent: 'codex', codex: false, claude: false, gemini: false, continue: null, files: false, git: false, terminal: false, flow: false, flowLocked: false, imports: false, export: false, workspaces: [] };

// The page reports what it shows. Anything not in exactly this shape is ignored.
export function menuState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== flags.length + 3) return null;
  if (!flags.every(key => typeof input[key] === 'boolean') || !agents.includes(input.agent) || !(input.continue === null || agents.includes(input.continue))) return null;
  const listed = input.workspaces;
  if (!Array.isArray(listed) || listed.length > 9 || !listed.every(item => item && typeof item === 'object' && Object.keys(item).length === 2 && typeof item.name === 'string' && item.name.length >= 1 && item.name.length <= 120 && typeof item.current === 'boolean')) return null;
  return { ...Object.fromEntries(flags.map(key => [key, input[key]])), agent: input.agent, continue: input.continue, workspaces: listed.map(({ name, current }) => ({ name, current })) };
}

// The bug report form asks for the system it happened on.
function system(platform, osVersion, arch) {
  const name = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform] || platform;
  return `${name} ${osVersion}, ${platform === 'darwin' ? arch === 'arm64' ? 'Apple Silicon' : 'Intel' : arch}`;
}

export function menuTemplate({ platform, packaged, updates = false, version, osVersion, arch, state, appearance, keepAwake, notifications = alertDefaults, setNotifications = () => {}, handoff = { threshold: 90, automatic: false }, setHandoff = () => {}, send, open, tracing = false, recordTrace = () => {}, command: shellCommand = null, text: words = english }) {
  // The menus' words are in the interface language (#27); names of workspaces and agents stay as they are.
  const { t } = words, page = state || initial, mac = platform === 'darwin', separator = () => ({ type: 'separator' });
  const command = (label, name, options = {}) => ({ label, ...options, click: () => send(...name) });
  const link = (label, url) => ({ label, click: () => open(url) });
  // & marks a keyboard mnemonic in Windows and Linux menus; doubled, it shows as itself.
  const text = name => mac ? name : name.replaceAll('&', '&&');
  const settings = command(t('Settings…'), ['settings'], { accelerator: 'CmdOrCtrl+,' }), setup = command(t('Setup Guide'), ['setup-guide']);
  // The codeshi command (#90): a link in /usr/local/bin on macOS and a small launcher on the PATH on Windows. Remove is
  // offered only for Codeshi's own. It sits in the Codeshi menu on macOS and in File on Windows.
  const cli = !shellCommand ? [] : [shellCommand.state === 'installed'
    ? { label: t('Remove ‘codeshi’ Command'), id: 'codeshi-command', click: () => shellCommand.uninstall() }
    : { label: t('Install ‘codeshi’ Command…'), id: 'codeshi-command', click: () => shellCommand.install() }];
  const file = { label: t('File'), submenu: [
    command(t('New Workspace'), ['new-workspace'], { accelerator: 'CmdOrCtrl+N' }),
    command(t('Add Folder to Workspace…'), ['add-folder'], { enabled: page.workspace && !page.running }),
    separator(),
    command(t('Previous Chats…'), ['previous-chats'], { enabled: page.imports }),
    command(t('Export Conversation…'), ['export'], { enabled: page.export }),
    command(t('Review Changes with Other Agent…'), ['review'], { enabled: page.workspace && !page.running }),
    command(t('Ask a Friend…'), ['ask-friend'], { enabled: page.workspace }),
    separator(),
    command(t('Export Codeshi Backup…'), ['backup-export']),
    command(t('Import Codeshi Backup…'), ['backup-import']),
    separator(),
    command(t('Share Live…'), ['share-live'], { enabled: page.workspace }),
    command(t('Watch a Teammate…'), ['watch-teammate']),
    separator(),
    ...mac ? [] : [settings, ...cli, separator()],
    { role: 'close' },
    ...mac ? [] : [{ role: 'quit' }],
  ] };
  const edit = { label: t('Edit'), submenu: [
    { role: 'undo' }, { role: 'redo' }, separator(), { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
    ...mac ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] : [{ role: 'delete' }, separator(), { role: 'selectAll' }],
    separator(),
    command(t('Find in Conversation'), ['find'], { accelerator: 'CmdOrCtrl+F', enabled: page.workspace }),
    // ⇧⌘G is Show Git Activity, so Find Previous has no shortcut; Shift+Enter in the find field still goes back.
    command(t('Find Next'), ['find-next'], { accelerator: 'CmdOrCtrl+G', enabled: page.workspace }),
    command(t('Find Previous'), ['find-previous'], { enabled: page.workspace }),
    separator(),
    command(t('Filter Workspaces'), ['filter-workspaces'], { accelerator: 'CmdOrCtrl+K' }),
    ...mac ? [separator(), { label: t('Speech'), submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }] : [],
  ] };
  const view = { label: t('View'), submenu: [
    command(t('Show Git Activity'), ['git'], { type: 'checkbox', checked: page.git, accelerator: 'CmdOrCtrl+Shift+G', enabled: page.workspace }),
    command(t('Show Files'), ['files'], { type: 'checkbox', checked: page.files, enabled: page.workspace }),
    // ⌃` as in VS Code, on every system: ⌘` switches windows on macOS.
    command(t('Terminal'), ['terminal'], { type: 'checkbox', checked: page.terminal, accelerator: 'Ctrl+`', enabled: page.workspace && !page.flow }),
    // Just the chat, with plain-language cards either side; the panels come back as they were on leaving (#107).
    command(t('Flow Mode'), ['flow'], { type: 'checkbox', checked: page.flow, accelerator: 'CmdOrCtrl+Shift+F', enabled: page.workspace && !page.running && !page.flowLocked }),
    command(t('Focus Message Box'), ['focus-message'], { accelerator: 'CmdOrCtrl+L', enabled: page.workspace }),
    separator(),
    { label: t('Appearance'), submenu: [['system', t('System')], ['light', t('Light')], ['dark', t('Dark')], ['graphite', t('Graphite')]].map(([value, label]) => command(label, ['appearance', value], { id: `appearance-${value}`, type: 'radio', checked: appearance === value })) },
    separator(),
    ...packaged ? [] : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, separator()],
    { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, separator(), { role: 'togglefullscreen' },
  ] };
  const agent = { label: t('Agent'), submenu: [
    // In Flow, routing chooses the agent for each message, so these wait until the normal view (#107).
    ...agents.map(name => command(t('Use {agent}', { agent: names[name] }), ['agent', name], { type: 'radio', checked: page.agent === name, enabled: page[name] && !page.flow })),
    command(t('Continue Locally…'), ['local-models'], { enabled: page.workspace && !page.running }),
    separator(),
    command(t('Stop Run'), ['stop'], { accelerator: 'CmdOrCtrl+.', enabled: page.running }),
    // Speech is recognized on the computer itself, on macOS and Windows (#73); Linux gets voice input later.
    ...mac || platform === 'win32' ? [command(t('Voice Input'), ['voice'], { accelerator: mac ? 'Alt+Cmd+V' : 'Ctrl+Alt+V', enabled: page.workspace })] : [],
    // The page's Continue button continues with the same agent unless a usage limit stopped the run.
    command(page.continue ? t('Continue with {agent}', { agent: names[page.continue] }) : t('Continue with…'), ['continue'], { id: 'continue', enabled: page.continue !== null }),
    separator(),
    command(t('Keep Awake'), ['keep-awake'], { type: 'checkbox', checked: keepAwake }),
    // How Codeshi tells you about work while you are in another app: each way on or off here, and for each moment
    // in Settings.
    { label: t('Alerts'), submenu: alertMenu(notifications, { platform, text: words, set: setNotifications, settings: () => send('alert-settings') }) },
    separator(),
    // When to offer moving a run to another agent before its usage limit stops it, and whether to do it unasked.
    { label: t('Hand Off Near Usage Limits'), submenu: [
      ...[[0, t('Never Offer')], [80, t('Offer at {percent}%', { percent: 80 })], [90, t('Offer at {percent}%', { percent: 90 })], [95, t('Offer at {percent}%', { percent: 95 })]].map(([threshold, label]) => ({ label, type: 'radio', checked: handoff.threshold === threshold, click: () => setHandoff({ threshold }) })),
      separator(),
      { label: t('Hand Off Automatically to Subscription Agents'), type: 'checkbox', checked: handoff.automatic, enabled: handoff.threshold > 0, click: () => setHandoff({ automatic: !handoff.automatic }) },
    ] },
  ] };
  // Numbered as ⌘1–9 number them: the first nine workspaces the sidebar filter shows.
  const workspace = { label: t('Workspace'), submenu: [
    ...page.workspaces.map(({ name, current }, index) => command(text(name), ['workspace', index + 1], { id: `workspace-${index + 1}`, type: 'checkbox', checked: current, accelerator: `CmdOrCtrl+${index + 1}` })),
    ...page.workspaces.length ? [separator()] : [],
    command(t('Workspace Settings…'), ['workspace-settings'], { enabled: page.workspace }),
    command(t('Remove Workspace…'), ['remove-workspace'], { enabled: page.workspace && !page.running }),
  ] };
  const report = `${repository}/issues/new?${new URLSearchParams({ template: 'bug_report.yml', version, system: system(platform, osVersion, arch) })}`;
  const help = { role: 'help', submenu: [
    link(t('Codeshi Guide'), `${repository}/blob/main/docs/guide.md`),
    link(t('Keyboard Shortcuts'), `${repository}/blob/main/docs/guide.md#keyboard-shortcuts`),
    ...mac ? [] : [setup],
    separator(),
    link(t('Report a Bug'), report),
    link(t('Share Design Feedback'), `${repository}/issues/new?template=ux_feedback.yml`),
    // Measures Codeshi itself while it seems slow or warm, and saves the trace on this computer.
    tracing ? { label: t('Recording Performance Trace…'), enabled: false } : { label: t('Record Performance Trace'), click: () => recordTrace() },
    separator(),
    link(t('Roadmap'), `${repository}/blob/main/ROADMAP.md`),
    command(t('What’s New'), ['whats-new'], { id: 'whats-new' }),
    separator(),
    // Codeshi is free: a star helps contributors find it, and Patreon supports its development.
    link(t('Star Codeshi on GitHub'), repository),
    link(t('Support Codeshi on Patreon'), patreon),
    ...mac ? [] : [separator(), { role: 'about' }],
  ] };
  const application = { label: 'Codeshi', submenu: [{ role: 'about' }, ...updates ? [command(t('Check for Updates…'), ['check-updates'], { id: 'check-updates' })] : [], separator(), settings, setup, ...cli, separator(), { role: 'services' }, separator(), { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, separator(), { role: 'quit' }] };
  return [...mac ? [application] : [], file, edit, view, agent, workspace, { role: 'windowMenu' }, help];
}

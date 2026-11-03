// The menu bar. The template is built without Electron so it can be tested; desktop/main.mjs builds it with
// Menu.buildFromTemplate and rebuilds it when the page, the saved appearance or Keep Awake changes. Items that
// act on the page send it a command, so each runs the same code as the shortcut or button it stands for.
import { alertDefaults } from '../src/alerts.mjs';
import { alertMenu } from './status.mjs';

const repository = 'https://github.com/AhmedNavaz/codeshi';
const agents = ['codex', 'claude', 'gemini'], names = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini' };
const flags = ['workspace', 'running', 'codex', 'claude', 'gemini', 'files', 'git', 'terminal', 'imports', 'export'];
// What the menu offers until the page reports: nothing that needs a workspace.
const initial = { workspace: false, running: false, agent: 'codex', codex: false, claude: false, gemini: false, continue: null, files: false, git: false, imports: false, export: false, workspaces: [] };

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

export function menuTemplate({ platform, packaged, updates = false, version, osVersion, arch, state, appearance, keepAwake, notifications = alertDefaults, setNotifications = () => {}, handoff = { threshold: 90, automatic: false }, setHandoff = () => {}, send, open }) {
  const page = state || initial, mac = platform === 'darwin', separator = () => ({ type: 'separator' });
  const command = (label, name, options = {}) => ({ label, ...options, click: () => send(...name) });
  const link = (label, url) => ({ label, click: () => open(url) });
  // & marks a keyboard mnemonic in Windows and Linux menus; doubled, it shows as itself.
  const text = name => mac ? name : name.replaceAll('&', '&&');
  const settings = command('Settings…', ['settings'], { accelerator: 'CmdOrCtrl+,' }), setup = command('Setup Guide', ['setup-guide']);
  const file = { label: 'File', submenu: [
    command('New Workspace', ['new-workspace'], { accelerator: 'CmdOrCtrl+N' }),
    command('Add Folder to Workspace…', ['add-folder'], { enabled: page.workspace && !page.running }),
    separator(),
    command('Previous Chats…', ['previous-chats'], { enabled: page.imports }),
    command('Export Conversation…', ['export'], { enabled: page.export }),
    command('Review Changes with Other Agent…', ['review'], { enabled: page.workspace && !page.running }),
    command('Ask a Friend…', ['ask-friend'], { enabled: page.workspace }),
    separator(),
    ...mac ? [] : [settings, separator()],
    { role: 'close' },
    ...mac ? [] : [{ role: 'quit' }],
  ] };
  const edit = { label: 'Edit', submenu: [
    { role: 'undo' }, { role: 'redo' }, separator(), { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
    ...mac ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] : [{ role: 'delete' }, separator(), { role: 'selectAll' }],
    separator(),
    command('Find in Conversation', ['find'], { accelerator: 'CmdOrCtrl+F', enabled: page.workspace }),
    // ⇧⌘G is Show Git Activity, so Find Previous has no shortcut; Shift+Enter in the find field still goes back.
    command('Find Next', ['find-next'], { accelerator: 'CmdOrCtrl+G', enabled: page.workspace }),
    command('Find Previous', ['find-previous'], { enabled: page.workspace }),
    separator(),
    command('Filter Workspaces', ['filter-workspaces'], { accelerator: 'CmdOrCtrl+K' }),
    ...mac ? [separator(), { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }] : [],
  ] };
  const view = { label: 'View', submenu: [
    command('Show Git Activity', ['git'], { type: 'checkbox', checked: page.git, accelerator: 'CmdOrCtrl+Shift+G', enabled: page.workspace }),
    command('Show Files', ['files'], { type: 'checkbox', checked: page.files, enabled: page.workspace }),
    // ⌃` as in VS Code, on every system: ⌘` switches windows on macOS.
    command('Terminal', ['terminal'], { type: 'checkbox', checked: page.terminal, accelerator: 'Ctrl+`', enabled: page.workspace }),
    command('Focus Message Box', ['focus-message'], { accelerator: 'CmdOrCtrl+L', enabled: page.workspace }),
    separator(),
    { label: 'Appearance', submenu: [['system', 'System'], ['graphite', 'Dark'], ['light', 'Light']].map(([value, label]) => command(label, ['appearance', value], { id: `appearance-${value}`, type: 'radio', checked: appearance === value })) },
    separator(),
    ...packaged ? [] : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, separator()],
    { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, separator(), { role: 'togglefullscreen' },
  ] };
  const agent = { label: 'Agent', submenu: [
    ...agents.map(name => command(`Use ${names[name]}`, ['agent', name], { type: 'radio', checked: page.agent === name, enabled: page[name] })),
    command('Continue Locally…', ['local-models'], { enabled: page.workspace && !page.running }),
    separator(),
    command('Stop Run', ['stop'], { accelerator: 'CmdOrCtrl+.', enabled: page.running }),
    // Speech is recognized on the Mac itself; other systems get voice input later.
    ...mac ? [command('Voice Input', ['voice'], { accelerator: 'Alt+Cmd+V', enabled: page.workspace })] : [],
    // The page's Continue button continues with the same agent unless a usage limit stopped the run.
    command(page.continue ? `Continue with ${names[page.continue]}` : 'Continue with…', ['continue'], { id: 'continue', enabled: page.continue !== null }),
    separator(),
    command('Keep Awake', ['keep-awake'], { type: 'checkbox', checked: keepAwake }),
    // How Codeshi tells you about work while you are in another app: each way on or off here, and for each moment
    // in Settings.
    { label: 'Alerts', submenu: alertMenu(notifications, { platform, set: setNotifications, settings: () => send('alert-settings') }) },
    separator(),
    // When to offer moving a run to another agent before its usage limit stops it, and whether to do it unasked.
    { label: 'Hand Off Near Usage Limits', submenu: [
      ...[[0, 'Never Offer'], [80, 'Offer at 80%'], [90, 'Offer at 90%'], [95, 'Offer at 95%']].map(([threshold, label]) => ({ label, type: 'radio', checked: handoff.threshold === threshold, click: () => setHandoff({ threshold }) })),
      separator(),
      { label: 'Hand Off Automatically to Subscription Agents', type: 'checkbox', checked: handoff.automatic, enabled: handoff.threshold > 0, click: () => setHandoff({ automatic: !handoff.automatic }) },
    ] },
  ] };
  // Numbered as ⌘1–9 number them: the first nine workspaces the sidebar filter shows.
  const workspace = { label: 'Workspace', submenu: [
    ...page.workspaces.map(({ name, current }, index) => command(text(name), ['workspace', index + 1], { id: `workspace-${index + 1}`, type: 'checkbox', checked: current, accelerator: `CmdOrCtrl+${index + 1}` })),
    ...page.workspaces.length ? [separator()] : [],
    command('Workspace Settings…', ['workspace-settings'], { enabled: page.workspace }),
    command('Remove Workspace…', ['remove-workspace'], { enabled: page.workspace && !page.running }),
  ] };
  const report = `${repository}/issues/new?${new URLSearchParams({ template: 'bug_report.yml', version, system: system(platform, osVersion, arch) })}`;
  const help = { role: 'help', submenu: [
    link('Codeshi Guide', `${repository}/blob/main/docs/guide.md`),
    link('Keyboard Shortcuts', `${repository}/blob/main/docs/guide.md#keyboard-shortcuts`),
    ...mac ? [] : [setup],
    separator(),
    link('Report a Bug', report),
    link('Share Design Feedback', `${repository}/issues/new?template=ux_feedback.yml`),
    separator(),
    link('Roadmap', `${repository}/blob/main/ROADMAP.md`),
    command('What’s New', ['whats-new'], { id: 'whats-new' }),
    ...mac ? [] : [separator(), { role: 'about' }],
  ] };
  const application = { label: 'Codeshi', submenu: [{ role: 'about' }, ...updates ? [command('Check for Updates…', ['check-updates'], { id: 'check-updates' })] : [], separator(), settings, setup, separator(), { role: 'services' }, separator(), { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, separator(), { role: 'quit' }] };
  return [...mac ? [application] : [], file, edit, view, agent, workspace, { role: 'windowMenu' }, help];
}

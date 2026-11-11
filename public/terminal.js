(() => {
  'use strict';
  // The workspace terminal (#7, #70): a tab of the bottom panel with the workspace's shells. Each shell is a tab,
  // listed at the right of the terminal and named after its folder, and a tab can be split into two panes, side by
  // side or stacked, each with its own shell. + opens another, in a folder you choose when the workspace has several;
  // closing a tab or ending a pane stops that shell and what it started. Switching workspaces swaps the list, and
  // hiding the panel leaves every shell running. Input goes to the pane it was typed in, never to another. Keys typed
  // here belong to the shell, not to the message box.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('terminal-panel');
  if (!api || !panel) return;
  const Terminal = window.Terminal, FitAddon = window.FitAddon?.FitAddon, WebLinksAddon = window.WebLinksAddon?.WebLinksAddon;
  // Views by session id; each workspace's sessions as the server lists them; and each workspace's open tab and the pane
  // last used in each of its tabs.
  const views = new Map(), lists = new Map(), layouts = new Map();
  const MAX_SESSIONS = 8;
  let busy = false;

  // xterm.js adds <style> elements for its layout and colours. The page's security policy allows those only with this
  // page load's nonce, so the elements it creates get it.
  const nonce = document.querySelector('meta[name="relay-style-nonce"]')?.getAttribute('content');
  if (nonce && !document.createElement.relayNonce) {
    const create = document.createElement.bind(document);
    document.createElement = Object.assign((tag, options) => { const element = create(tag, options); if (String(tag).toLowerCase() === 'style') element.nonce = nonce; return element; }, { relayNonce: true });
  }

  const token = () => window.relayDesktop?.token;
  const projectId = () => api.getState().projectId;
  const project = () => api.getState().projects?.find(item => item.id === projectId());
  // What the panel says: that the terminal could not load, why a shell failed, the last thing that went wrong, or,
  // less loudly, that shells are ending. It stays until the next action succeeds, so a failure isn't cleared by the
  // next redraw.
  let notice = '', tone = '';
  function showNotice() {
    const failed = focusedPane(activeTab())?.status === 'failed' ? focusedPane(activeTab()).error : '';
    const shown = !Terminal || !FitAddon ? 'The terminal could not load. Reinstall Codeshi to restore it.' : notice || failed;
    $('terminal-message').textContent = shown || ''; $('terminal-message').hidden = !shown;
    $('terminal-message').dataset.tone = shown && shown === notice ? tone : '';
  }
  const message = (text, kind = '') => { notice = text || ''; tone = kind; showNotice(); };
  const element = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const live = session => session?.status === 'running';
  const shellName = session => String(session?.shell || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');

  // Colours follow the app's theme; the sixteen terminal colours are VS Code's for each appearance.
  const palettes = {
    dark: { black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5' },
    light: { black: '#000000', red: '#cd3131', green: '#107c10', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5' },
  };
  function theme() {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null, read = name => style?.getPropertyValue(name).trim() || '';
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return { ...palettes[light ? 'light' : 'dark'], background: read('--panel-bg') || (light ? '#f4efe6' : '#161513'), foreground: read('--text') || (light ? '#3d362f' : '#d6cec2'), cursor: read('--text-strong') || read('--text'), cursorAccent: read('--panel-bg') || (light ? '#f8f8f8' : '#181818'), selectionBackground: light ? '#add6ff' : '#264f78' };
  }

  // Links in a shell's output open in the browser with a click (#83): addresses it prints, also when they wrap onto the
  // next line, and links a program marks up itself (OSC 8). Both follow the desktop bridge's rules, checked here too so
  // a web browser opens the same ones, in a new tab: HTTPS, or HTTP to this computer, with no name or password. One
  // that can't open says so in the panel. xterm opens a link on any button's release, so a right-click, or a drag that
  // selects text in a link, is left to do what it does.
  const opens = url => !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  async function openLink(event, term, uri) {
    if (event.button !== 0 || term.hasSelection()) return;
    let url = null; try { url = new URL(uri); } catch { /* Not an address. */ }
    if (!url || !opens(url)) { message('That link didn’t open. The terminal opens HTTPS links, and HTTP links to localhost, without a name or password.'); return; }
    try { if (window.relayDesktop?.openExternal) await window.relayDesktop.openExternal(url.href); else window.open(url.href, '_blank', 'noopener,noreferrer'); message(''); }
    catch (error) { message(`That link didn’t open. ${String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')}`); }
  }

  // Add to message (#71) puts terminal output in the message box as a code block that names its folder: the selection,
  // or with nothing selected, the screen as it shows. It only happens when asked, and nothing reaches an agent until
  // the message is sent. Output over 200 lines keeps its first 50 and last 150, where a command and its error usually
  // are, and at most 16,000 characters. Likely secrets are left in and pointed out, with the patterns conversation
  // export looks for (src/collaboration-format.mjs).
  const OUTPUT_LINES = 200, OUTPUT_HEAD = 50, OUTPUT_CHARS = 16000, OUTPUT_CHARS_HEAD = 4000;
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{16,})\b/,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_./+=-]{16,}/i,
  ];
  // The screen as it shows, with a line the terminal wrapped joined back into one.
  function screenText(term) {
    const buffer = term.buffer?.active, lines = [];
    if (!buffer) return '';
    for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row++) {
      const line = buffer.getLine(row);
      if (!line) break;
      if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(false); else lines.push(line.translateToString(false));
    }
    return lines.join('\n');
  }
  function shorten(text) {
    let lines = String(text).replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()), cut = false;
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines.at(-1)) lines.pop();
    if (lines.length > OUTPUT_LINES) { lines = [...lines.slice(0, OUTPUT_HEAD), `… ${lines.length - OUTPUT_LINES} lines left out …`, ...lines.slice(OUTPUT_HEAD - OUTPUT_LINES)]; cut = true; }
    let body = lines.join('\n');
    if (body.length > OUTPUT_CHARS) { body = `${body.slice(0, OUTPUT_CHARS_HEAD)}\n… ${body.length - OUTPUT_CHARS} characters left out …\n${body.slice(OUTPUT_CHARS_HEAD - OUTPUT_CHARS)}`; cut = true; }
    return { body, cut };
  }
  const selectionOf = view => view?.term.hasSelection?.() ? String(view.term.getSelection?.() || '') : '';
  function addOutput(view = views.get(focusedPane(activeTab())?.id)) {
    const input = $('message-input');
    if (!view || !input) return;
    const selected = selectionOf(view), { body, cut } = shorten(selected.trim() ? selected : screenText(view.term));
    if (!body) { message('There is no output to add yet.', 'progress'); return; }
    const folder = sessions(view.projectId).find(item => item.id === view.id)?.folderName || 'the workspace';
    // The fence is longer than any run of backticks in the output, so the output can't end the block early.
    const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) || []).map(run => run.length + 1)));
    const block = `Terminal output from \`${folder}\`:\n\n${fence}text\n${body}\n${fence}`;
    input.value = input.value.trim() ? `${input.value.trimEnd()}\n\n${block}\n` : `${block}\n`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus?.(); input.setSelectionRange?.(input.value.length, input.value.length);
    message('');
    api.showNotice?.(`${selected.trim() ? 'The selected terminal output' : 'The terminal screen'} is in the message box. Nothing is sent until you send the message.${cut ? ' It was shortened: the start and end are kept.' : ''}${secretPatterns.some(pattern => pattern.test(body)) ? ' It may contain a secret, such as a token, key or password. Check it before you send.' : ''}`);
  }

  // A workspace's tabs in the order they opened, each with its panes in order.
  const sessions = (id = projectId()) => lists.get(id) || [];
  const layout = (id = projectId()) => { if (!layouts.has(id)) layouts.set(id, { tab: null, focus: new Map() }); return layouts.get(id); };
  function tabs(id = projectId()) {
    const found = new Map();
    for (const session of sessions(id)) { if (!found.has(session.tabId)) found.set(session.tabId, { id: session.tabId, panes: [] }); found.get(session.tabId).panes.push(session); }
    const list = [...found.values()];
    for (const tab of list) tab.panes.sort((a, b) => a.pane - b.pane);
    return list.sort((a, b) => a.panes[0].order - b.panes[0].order);
  }
  const activeTab = (id = projectId()) => { const list = tabs(id); return list.find(tab => tab.id === layout(id).tab) || list.at(-1) || null; };
  // The pane the header's buttons act on: the one last clicked or typed in, else the tab's first.
  const focusedPane = (tab, id = projectId()) => tab ? tab.panes.find(pane => pane.id === layout(id).focus.get(tab.id)) || tab.panes[0] : null;
  // A tab is named after its folders; tabs with the same name are numbered.
  function labels(list) {
    const counts = new Map();
    return list.map(tab => { const base = [...new Set(tab.panes.map(pane => pane.folderName))].join(' · '), seen = (counts.get(base) || 0) + 1; counts.set(base, seen); return seen > 1 ? `${base} ${seen}` : base; });
  }

  // Keeps a session's latest state in its workspace's list, in the place of the one it replaces.
  function remember(session, replaced = null) {
    const list = sessions(session.projectId).filter(item => item.id !== session.id), at = replaced ? list.findIndex(item => item.id === replaced) : -1;
    if (at >= 0) list.splice(at, 1, session); else list.push(session);
    lists.set(session.projectId, list);
  }
  // A session that ended or was closed leaves its list; the other pane of its tab becomes the tab's only one.
  function forget(id, sessionId) {
    const list = sessions(id), gone = list.find(item => item.id === sessionId);
    lists.set(id, list.filter(item => item.id !== sessionId).map(item => gone && item.tabId === gone.tabId ? { ...item, pane: 0, split: null } : item));
    views.get(sessionId)?.dispose(); views.delete(sessionId);
  }

  // One view per session: its xterm, its stream and an ordered queue of input.
  function viewFor(session) {
    let view = views.get(session.id);
    if (view) return view;
    const host = element('div', 'terminal-view');
    host.dataset.projectId = session.projectId; host.dataset.sessionId = session.id; host.hidden = true;
    $('terminal-views').append(host);
    // An OSC 8 link's text needn't be its address, so pointing at one shows where it goes. Other schemes reach openLink
    // too, so a file link says why it stays closed rather than not being a link.
    const linkHandler = { activate: (event, uri) => openLink(event, term, uri), hover: (event, uri) => { host.title = uri; }, leave: () => { host.title = ''; }, allowNonHttpProtocols: true };
    const term = new Terminal({ cursorBlink: true, fontFamily: (typeof getComputedStyle === 'function' && getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()) || 'Menlo, monospace', fontSize: 13, lineHeight: 1.25, scrollback: 5000, allowProposedApi: false, macOptionIsMeta: false, linkHandler, theme: theme() });
    const fit = new FitAddon();
    term.loadAddon(fit); if (WebLinksAddon) term.loadAddon(new WebLinksAddon((event, uri) => openLink(event, term, uri))); term.open(host);
    view = { id: session.id, projectId: session.projectId, term, fit, host, stream: null, queue: '', sending: false, resizeTimer: null };
    // The pane last clicked or typed in is the one End and New session act on.
    const use = () => { const current = sessions(view.projectId).find(item => item.id === view.id); if (current && layout(view.projectId).focus.get(current.tabId) !== view.id) { layout(view.projectId).focus.set(current.tabId, view.id); if (view.projectId === projectId()) render(); } };
    host.addEventListener('mousedown', use); host.addEventListener('focusin', use);
    // The Add to message button says whether it takes the selection or the screen; a right-click offers it too.
    term.onSelectionChange?.(() => { if (view.projectId === projectId()) renderCapture(); });
    host.addEventListener('contextmenu', event => { event.preventDefault(); use(); openContext(view, event); });
    // Input is sent in order, batched while a request is in flight.
    const send = async () => {
      if (view.sending || !view.queue || !live(sessions(view.projectId).find(item => item.id === view.id))) return;
      view.sending = true;
      const data = view.queue; view.queue = '';
      try { await api.post('/api/terminal/input', { id: view.id, data }, view.projectId); }
      catch (error) { if (view.projectId === projectId()) message(error.message); }
      finally { view.sending = false; if (view.queue) send(); }
    };
    term.onData(data => { view.queue += data; send(); });
    term.onResize(({ cols, rows }) => {
      clearTimeout(view.resizeTimer);
      view.resizeTimer = setTimeout(() => api.post('/api/terminal/resize', { id: view.id, cols, rows }, view.projectId).catch(() => {}), 80);
    });
    // Output follows the session's stream; a stream that reconnects resumes where it left off.
    const query = Object.entries({ projectId: session.projectId, id: session.id, ...(token() ? { token: token() } : {}) }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    view.stream = new EventSource('/api/terminal/stream?' + query);
    view.stream.addEventListener('reset', event => { term.reset(); term.write(JSON.parse(event.data).data); });
    view.stream.addEventListener('data', event => term.write(JSON.parse(event.data).data));
    view.stream.addEventListener('exit', event => {
      const ended = JSON.parse(event.data); view.stream.close();
      const known = sessions(view.projectId).find(item => item.id === view.id);
      if (known) remember({ ...known, ...ended, tabId: known.tabId, pane: known.pane, split: known.split, order: known.order });
      // The shell's end is said once, under its last output, as a terminal does.
      if (ended.status !== 'failed') term.write(`\r\n\x1b[2m[The shell exited${Number.isInteger(ended.exitCode) ? ` with code ${ended.exitCode}` : ''}. Its output stays until you close this tab or start a new session.]\x1b[22m\r\n`);
      if (view.projectId === projectId()) render();
    });
    view.dispose = () => { view.stream?.close(); clearTimeout(view.resizeTimer); term.dispose(); host.remove(); };
    views.set(session.id, view);
    return view;
  }

  function fitVisible() { for (const view of views.values()) if (!panel.hidden && !view.host.hidden) try { view.fit.fit(); } catch { /* Not laid out yet. */ } }
  function focusPane() { const pane = focusedPane(activeTab()); if (pane && !panel.hidden) views.get(pane.id)?.term.focus(); }

  function renderTabs(list, open) {
    const names = labels(list), host = $('terminal-tabs');
    host.replaceChildren(...list.map((tab, index) => {
      const item = element('div', 'terminal-tab'), pick = element('button', 'terminal-tab-pick'), close = element('button', 'icon-button terminal-tab-close'), current = tab.id === open?.id;
      item.dataset.tabId = tab.id; item.dataset.state = tab.panes.some(live) ? 'running' : 'ended';
      if (tab.panes.length > 1) item.dataset.split = tab.panes[1].split || 'right';
      // Tab reaches the open shell's row and its ×; the arrow keys move between rows.
      pick.type = 'button'; pick.setAttribute('role', 'tab'); pick.setAttribute('aria-selected', String(current)); pick.tabIndex = current ? 0 : -1; close.tabIndex = current ? 0 : -1;
      pick.append(element('span', 'terminal-tab-name', names[index]));
      pick.title = tab.panes.map(pane => `${shellName(pane)} in ${pane.cwd}${live(pane) ? '' : pane.status === 'failed' ? ' · could not start' : ' · exited'}`).join('\n');
      pick.addEventListener('click', () => { layout().tab = tab.id; render(); focusPane(); });
      close.type = 'button'; close.disabled = busy; close.setAttribute('aria-label', `Close ${names[index]}`);
      close.title = tab.panes.some(live) ? 'Close: ends its shell and what it started' : 'Close';
      close.addEventListener('click', () => closeTab(tab));
      item.append(pick, close);
      return item;
    }));
    host.hidden = !list.length;
  }

  function render() {
    const id = projectId(), list = tabs(id), open = activeTab(id), pane = focusedPane(open), folders = project()?.folders || [];
    if (open) layout(id).tab = open.id;
    // Only the open tab's panes show, side by side or stacked when it is split.
    for (const view of views.values()) {
      const shown = open?.panes.find(item => item.id === view.id);
      view.host.hidden = panel.hidden || !shown;
      if (shown) { view.host.style.order = String(shown.pane); view.host.dataset.pane = String(shown.pane); view.host.dataset.active = String(open.panes.length > 1 && shown === pane); }
    }
    $('terminal-views').dataset.split = open?.panes.length > 1 ? open.panes[1].split || 'right' : '';
    renderTabs(list, open);
    $('terminal-new').hidden = !id || !Terminal || !FitAddon; $('terminal-new').disabled = busy || sessions(id).length >= MAX_SESSIONS;
    $('terminal-new').title = sessions(id).length >= MAX_SESSIONS ? 'A workspace keeps up to 8 terminals' : folders.length > 1 ? 'New terminal in a folder you choose (⌃⇧`)' : 'New terminal (⌃⇧`)';
    $('terminal-split').hidden = !open; $('terminal-split').disabled = busy || !open || open.panes.length > 1 || !live(pane) || sessions(id).length >= MAX_SESSIONS;
    $('terminal-end').hidden = !live(pane); $('terminal-end').disabled = busy;
    renderCapture();
    $('terminal-restart').hidden = !pane || live(pane); $('terminal-restart').disabled = busy;
    $('terminal-start').hidden = list.length > 0 || folders.length < 2;
    showNotice();
    // With no shell yet and several folders, each folder is a button that opens one there.
    $('terminal-folders').replaceChildren(...folders.map(folder => {
      const button = element('button', 'command-chip terminal-folder'); button.type = 'button'; button.dataset.folderId = folder.id;
      button.append(element('span', 'command-chip-name', folder.displayName || folder.name));
      button.title = folder.path || ''; button.disabled = busy;
      button.addEventListener('click', () => start(folder.id));
      return button;
    }));
    requestAnimationFrame(fitVisible);
  }

  async function load() {
    const id = projectId();
    if (!id || !Terminal || !FitAddon) { render(); return; }
    try {
      const { sessions: listed = [] } = await api.api('/api/terminal', {}, id);
      if (id !== projectId()) return;
      lists.set(id, listed);
      for (const session of listed) viewFor(session);
      for (const [sessionId, view] of views) if (view.projectId === id && !listed.some(session => session.id === sessionId)) { view.dispose(); views.delete(sessionId); }
      // A single-folder workspace opens its shell at once; with several folders, the person chooses one.
      if (!listed.length && !panel.hidden && (project()?.folders || []).length === 1) await start(project().folders[0].id);
    } catch (error) { message(error.message); }
    render();
  }

  // A new shell in a tab of its own, beside the open pane (split), or in place of a pane whose shell ended (replace).
  async function start(folderId, { split = null, replace = null } = {}) {
    const id = projectId();
    if (busy || !id || !folderId) return;
    // A shell starts at once, so nothing is said unless it fails.
    busy = true; message(''); render();
    try {
      const like = views.get(split?.of || replace || focusedPane(activeTab(id))?.id), size = like ? { cols: like.term.cols, rows: like.term.rows } : { cols: 100, rows: 24 };
      const session = await api.post('/api/terminal/start', { folderId, ...size, ...(split ? { split } : {}), ...(replace ? { replace } : {}) }, id);
      if (replace) { views.get(replace)?.dispose(); views.delete(replace); }
      remember(session, replace);
      layout(id).tab = session.tabId; layout(id).focus.set(session.tabId, session.id);
      if (id === projectId()) { viewFor(session); message(''); }
    } catch (error) { if (id === projectId()) message(error.message); }
    finally { busy = false; render(); if (id === projectId()) focusPane(); }
  }

  // Ends shells: each one and everything it started. A pane closes with its shell.
  async function end(ids) {
    const id = projectId();
    if (busy || !id || !ids.length) return;
    // A shell that ignores the request to end is stopped after a grace period, so this can take a moment.
    busy = true; message(ids.length > 1 ? 'Ending the shells…' : 'Ending the session…', 'progress'); render();
    try { for (const sessionId of ids) { await api.post('/api/terminal/stop', { id: sessionId }, id); forget(id, sessionId); } message(''); }
    catch (error) { message(error.message); }
    finally { busy = false; render(); focusPane(); }
  }
  const closeTab = tab => end(tab.panes.map(pane => pane.id));

  // Add to message stays for a shell that exited, since its output does.
  const captureKeys = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⇧⌘L' : 'Ctrl+Shift+L';
  function renderCapture() {
    const pane = focusedPane(activeTab()), button = $('terminal-capture');
    if (!button) return;
    button.hidden = !pane;
    button.title = `${selectionOf(views.get(pane?.id)).trim() ? 'Add the selection to your message' : 'Add the terminal screen to your message'} (${captureKeys})`;
  }
  $('terminal-capture')?.addEventListener('click', () => addOutput());
  // A right-click in a pane offers Add to message, and Copy when text is selected.
  const context = element('div', 'terminal-menu terminal-context'); context.setAttribute('role', 'menu'); context.setAttribute('aria-label', 'Terminal output'); context.hidden = true; panel.append(context);
  function closeContext() { context.hidden = true; }
  function openContext(view, event) {
    const selected = selectionOf(view), item = (label, act) => { const button = element('button', 'terminal-menu-item'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.append(element('span', 'terminal-menu-name', label)); button.addEventListener('click', () => { closeContext(); act(); }); return button; };
    context.replaceChildren(item(selected.trim() ? 'Add selection to message' : 'Add screen to message', () => addOutput(view)), ...(selected ? [item('Copy', () => { navigator.clipboard?.writeText(selected).catch(() => message('The selection could not be copied.')); view.term.focus(); })] : []));
    context.hidden = false;
    const width = context.offsetWidth || 200, height = context.offsetHeight || 64;
    context.style.left = `${Math.max(4, Math.min(event.clientX, (window.innerWidth || 0) - width - 4))}px`; context.style.top = `${Math.max(4, Math.min(event.clientY, (window.innerHeight || 0) - height - 4))}px`;
  }
  context.addEventListener('keydown', event => { if (event.key === 'Escape') { closeContext(); focusPane(); } });
  document.addEventListener('mousedown', event => { if (!context.hidden && !event.target?.closest?.('.terminal-context')) closeContext(); });
  // ⇧⌘L (Ctrl+Shift+L elsewhere) adds from the pane you're in, beside ⌘L for the message box. It is taken before the
  // shell sees it.
  document.addEventListener('keydown', event => {
    const mac = captureKeys === '⇧⌘L';
    if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) || !event.shiftKey || event.altKey || String(event.key).toLowerCase() !== 'l' || panel.hidden || !event.target?.closest?.('#terminal-panel')) return;
    event.preventDefault(); event.stopPropagation(); closeContext(); addOutput();
  }, true);

  // + opens a shell in the workspace's folder, or, with several folders, offers them.
  const menu = $('terminal-new-menu');
  function closeMenu() { menu.hidden = true; $('terminal-new').setAttribute('aria-expanded', 'false'); }
  function openMenu() {
    const folders = project()?.folders || [];
    if (folders.length < 2) { start(folders[0]?.id); return; }
    if (!menu.hidden) { closeMenu(); return; }
    menu.replaceChildren(...folders.map(folder => {
      const item = element('button', 'terminal-menu-item'); item.type = 'button'; item.setAttribute('role', 'menuitem');
      item.append(element('span', 'terminal-menu-name', folder.displayName || folder.name), element('span', 'terminal-menu-path', String(folder.path || '').replace(/^\/(?:Users|home)\/[^/]+/, '~')));
      item.addEventListener('click', () => { closeMenu(); start(folder.id); });
      return item;
    }));
    menu.hidden = false; $('terminal-new').setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus?.();
  }
  $('terminal-new').addEventListener('click', openMenu);
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(); $('terminal-new').focus(); } });
  document.addEventListener('mousedown', event => { if (!menu.hidden && !event.target?.closest?.('.terminal-add')) closeMenu(); });
  // Split puts a new shell, in the same folder, beside the open pane; with ⌥ held, under it.
  $('terminal-split').addEventListener('click', event => { const pane = focusedPane(activeTab()); if (pane) start(pane.folderId, { split: { of: pane.id, direction: event.altKey ? 'down' : 'right' } }); });
  $('terminal-end').addEventListener('click', () => { const pane = focusedPane(activeTab()); if (pane) end([pane.id]); });
  $('terminal-restart').addEventListener('click', () => { const pane = focusedPane(activeTab()); if (pane) start(pane.folderId, { replace: pane.id }); });
  // The list moves with the arrow keys, as a vertical tab list does; Home and End go to its first and last rows.
  $('terminal-tabs').addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const list = tabs(), at = list.findIndex(tab => tab.id === activeTab()?.id);
    if (!list.length) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
    event.preventDefault(); layout().tab = list[next].id; render();
    $('terminal-tabs').querySelector('[aria-selected="true"]')?.focus();
  });

  // The bottom panel decides when the terminal shows; it says so with a relay-panel event.
  const shown = () => !panel.hidden;
  const toggle = () => window.relayPanel?.toggle('terminal');
  window.addEventListener('relay-panel', () => { if (shown()) load().then(() => { if (shown()) focusPane(); }); else { closeMenu(); render(); } });
  // ⌃` shows or hides the terminal, and ⌃⇧` opens another shell in the folder of the one in use, as in VS Code.
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || event.metaKey || event.altKey || !(event.key === '`' || event.key === '~' || event.code === 'Backquote') || !api.getState().projectId) return;
    event.preventDefault();
    if (window.relayFlow?.isOn?.()) return;
    if (!event.shiftKey) { toggle(); return; }
    const folderId = focusedPane(activeTab())?.folderId || project()?.folders?.[0]?.id;
    if (!shown()) window.relayPanel?.show('terminal');
    start(folderId);
  });
  // Dragging a panel or the window changes the size many times a second, and each fit measures and redraws the
  // terminal, so it waits for the size to settle.
  let fitTimer = null;
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = setTimeout(fitVisible, 80); }).observe($('terminal-views'));
  if (typeof MutationObserver === 'function') new MutationObserver(() => { const colours = theme(); for (const view of views.values()) view.term.options.theme = colours; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let lastProject = null;
  window.addEventListener('relay-state', () => {
    if (projectId() === lastProject) return;
    lastProject = projectId(); closeMenu(); closeContext(); notice = '';
    if (shown()) load(); else render();
  });
  window.relayTerminal = { theme, toggle, open: () => window.relayPanel?.show('terminal'), close: () => { if (window.relayPanel?.isOpen('terminal')) window.relayPanel.hide(); }, isOpen: () => shown() };
})();

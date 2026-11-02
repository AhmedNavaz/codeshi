(() => {
  'use strict';
  // The workspace terminal (#7): a tab of the bottom panel with an interactive shell for the open workspace. Each
  // workspace has its own session and its own view; switching workspaces swaps the view, and hiding the panel or
  // switching to another tab leaves the shell running.
  // Input goes to the session it was typed in, never to another workspace's. Keys typed here belong to the shell, not
  // to the message box.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('terminal-panel');
  if (!api || !panel) return;
  const Terminal = window.Terminal, FitAddon = window.FitAddon?.FitAddon;
  const views = new Map();
  let current = null, busy = false;

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
  const message = text => { $('terminal-message').textContent = text || ''; $('terminal-message').hidden = !text; };

  // Colours follow the app's theme; the sixteen terminal colours are VS Code's for each appearance.
  const palettes = {
    dark: { black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5' },
    light: { black: '#000000', red: '#cd3131', green: '#107c10', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5' },
  };
  function theme() {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null, read = name => style?.getPropertyValue(name).trim() || '';
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return { ...palettes[light ? 'light' : 'dark'], background: read('--panel-bg') || (light ? '#f8f8f8' : '#181818'), foreground: read('--text') || (light ? '#1f1f1f' : '#cccccc'), cursor: read('--text-strong') || read('--text'), cursorAccent: read('--panel-bg') || (light ? '#f8f8f8' : '#181818'), selectionBackground: light ? '#add6ff' : '#264f78' };
  }

  // One view per session: its xterm, its stream and an ordered queue of input.
  function viewFor(session) {
    let view = views.get(session.projectId);
    if (view?.id === session.id) return view;
    view?.dispose();
    const host = document.createElement('div');
    host.className = 'terminal-view'; host.dataset.projectId = session.projectId; host.hidden = panel.hidden || session.projectId !== projectId();
    $('terminal-views').append(host);
    const term = new Terminal({ cursorBlink: true, fontFamily: (typeof getComputedStyle === 'function' && getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()) || 'Menlo, monospace', fontSize: 13, lineHeight: 1.25, scrollback: 5000, allowProposedApi: false, macOptionIsMeta: false, theme: theme() });
    const fit = new FitAddon();
    term.loadAddon(fit); term.open(host);
    view = { id: session.id, projectId: session.projectId, session, term, fit, host, stream: null, queue: '', sending: false, resizeTimer: null };
    // Input is sent in order, batched while a request is in flight.
    const send = async () => {
      if (view.sending || !view.queue || view.session.status !== 'running') return;
      view.sending = true;
      const data = view.queue; view.queue = '';
      try { await api.post('/api/terminal/input', { id: view.id, data }, view.projectId); }
      catch (error) { if (views.get(view.projectId) === view) message(error.message); }
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
      view.session = JSON.parse(event.data); view.stream.close();
      // The shell's end is said once, under its last output, as a terminal does.
      if (view.session.status !== 'failed') term.write(`\r\n\x1b[2m[The shell exited${Number.isInteger(view.session.exitCode) ? ` with code ${view.session.exitCode}` : ''}. Its output stays until you start a new session.]\x1b[22m\r\n`);
      if (views.get(view.projectId) === view) render();
    });
    view.dispose = () => { view.stream?.close(); clearTimeout(view.resizeTimer); term.dispose(); host.remove(); };
    views.set(session.projectId, view);
    return view;
  }

  function fitCurrent() {
    const view = current && views.get(current);
    if (!view || panel.hidden || view.host.hidden) return;
    try { view.fit.fit(); } catch { /* Not laid out yet. */ }
  }

  function render() {
    const id = projectId(), view = views.get(id), session = view?.session || null;
    for (const item of views.values()) item.host.hidden = item.projectId !== id || panel.hidden;
    current = id;
    const folders = project()?.folders || [];
    // The header names the shell and the folder it runs in, and says when it has ended.
    const shell = String(session?.shell || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
    $('terminal-place').textContent = session ? [shell, session.folderName, session.status === 'running' ? '' : session.status === 'failed' ? 'could not start' : 'exited'].filter(Boolean).join(' · ') : '';
    $('terminal-place').title = session?.cwd || '';
    $('terminal-place').dataset.status = session?.status || '';
    $('terminal-end').hidden = !session || session.status !== 'running';
    $('terminal-restart').hidden = !session || session.status === 'running';
    $('terminal-start').hidden = Boolean(session) || folders.length < 2;
    if (!Terminal || !FitAddon) message('The terminal could not load. Reinstall Throughline to restore it.');
    else if (session?.status === 'failed') message(session.error);
    else message('');
    // With several folders, each is a button that opens the shell there.
    $('terminal-folders').replaceChildren(...folders.map(folder => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'command-chip terminal-folder'; button.dataset.folderId = folder.id;
      const name = document.createElement('span'); name.className = 'command-chip-name'; name.textContent = folder.displayName || folder.name; button.append(name);
      button.title = folder.path || ''; button.disabled = busy;
      button.addEventListener('click', () => start(folder.id));
      return button;
    }));
    requestAnimationFrame(fitCurrent);
  }

  async function load() {
    const id = projectId();
    if (!id || !Terminal || !FitAddon) { render(); return; }
    try {
      const { session } = await api.api('/api/terminal', {}, id);
      if (id !== projectId()) return;
      if (session) viewFor(session);
      else { views.get(id)?.dispose(); views.delete(id); }
      // A single-folder workspace opens its shell at once; with several folders, the person chooses one.
      if (!session && !panel.hidden && (project()?.folders || []).length === 1) await start(project().folders[0].id);
    } catch (error) { message(error.message); }
    render();
  }

  async function start(folderId) {
    const id = projectId();
    if (busy || !id || !folderId) return;
    busy = true; message('Starting the shell…');
    try {
      const view = views.get(id);
      const size = view ? { cols: view.term.cols, rows: view.term.rows } : { cols: 100, rows: 24 };
      const session = await api.post('/api/terminal/start', { folderId, ...size }, id);
      if (id === projectId()) { viewFor(session); message(''); }
    } catch (error) { message(error.message); }
    finally { busy = false; render(); views.get(id)?.term.focus(); }
  }

  async function end() {
    const id = projectId(), view = views.get(id);
    if (!view || busy) return;
    busy = true; message('Ending the session…');
    try { await api.post('/api/terminal/stop', { id: view.id }, id); view.dispose(); views.delete(id); }
    catch (error) { message(error.message); }
    finally { busy = false; render(); }
  }

  // The bottom panel decides when the terminal shows; it says so with a relay-panel event.
  const shown = () => !panel.hidden;
  const toggle = () => window.relayPanel?.toggle('terminal');
  window.addEventListener('relay-panel', () => { if (shown()) load().then(() => { if (shown()) views.get(projectId())?.term.focus(); }); else render(); });

  $('terminal-end').addEventListener('click', end);
  $('terminal-restart').addEventListener('click', () => { const view = views.get(projectId()); view?.dispose(); views.delete(projectId()); start(view?.session.folderId || project()?.folders?.[0]?.id); });
  // ⌃` shows or hides the terminal, as in VS Code.
  document.addEventListener('keydown', event => { if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === '`' || event.code === 'Backquote') && api.getState().projectId) { event.preventDefault(); toggle(); } });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitCurrent()).observe($('terminal-views'));
  if (typeof MutationObserver === 'function') new MutationObserver(() => { const colours = theme(); for (const view of views.values()) view.term.options.theme = colours; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let lastProject = null;
  window.addEventListener('relay-state', () => {
    if (projectId() === lastProject) return;
    lastProject = projectId();
    if (shown()) load(); else render();
  });
  window.relayTerminal = { toggle, open: () => window.relayPanel?.show('terminal'), close: () => { if (window.relayPanel?.isOpen('terminal')) window.relayPanel.hide(); }, isOpen: () => shown() };
})();

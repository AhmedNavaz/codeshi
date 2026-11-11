(() => {
  'use strict';
  // The codeshi command (#90) in a tab of the window. CLI in the status bar runs the real command, the one a terminal
  // runs, in the conversation's place, with Chat and CLI as two tabs above it. Both are clients of the same engine and
  // the same conversation, so a message sent in one shows in the other, and a run, an approval or a handoff can be
  // answered from either. Chat goes back to the conversation and leaves the command running; × (or Ctrl+D, /exit) ends
  // the command, never a run: the run carries on in the chat. Each workspace has its own CLI tab. Flow keeps its own
  // layout, so the tab waits behind it and comes back when Flow is turned off.
  const $ = id => document.getElementById(id), api = window.relayUI, main = document.querySelector('.main-panel');
  const strip = $('main-tabs'), view = $('cli-view'), hosts = $('cli-views'), button = $('status-cli');
  if (!api || !main || !strip || !view || !hosts) return;
  const Terminal = window.Terminal, FitAddon = window.FitAddon?.FitAddon, WebLinksAddon = window.WebLinksAddon?.WebLinksAddon;
  const loaded = Boolean(Terminal && FitAddon);
  // Each workspace's tab: its session as the engine reports it, whether it is in front, and its terminal once made.
  const tabs = new Map();
  let available = false, busy = false, notice = '';
  const projectId = () => api.getState().projectId;
  const flowOn = () => Boolean(window.relayFlow?.isOn?.());
  const token = () => window.relayDesktop?.token;
  const live = session => ['running', 'stopping'].includes(session?.status);
  const tab = (id = projectId()) => { if (!tabs.has(id)) tabs.set(id, { session: null, front: false, term: null }); return tabs.get(id); };
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  function say(text) { notice = text || ''; $('cli-message').textContent = notice; $('cli-message').hidden = !notice; }

  // The terminal's colours and font follow the window's, as the bottom panel's terminal does.
  function theme() { return window.relayTerminal?.theme?.() || {}; }
  const opens = url => !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  async function openLink(event, term, uri) {
    if (event.button !== 0 || term.hasSelection()) return;
    let url = null; try { url = new URL(uri); } catch { /* Not an address. */ }
    if (!url || !opens(url)) return;
    try { if (window.relayDesktop?.openExternal) await window.relayDesktop.openExternal(url.href); else window.open(url.href, '_blank', 'noopener,noreferrer'); } catch { /* The link stays as text. */ }
  }

  // A terminal for the workspace's tab, made before the command starts so it starts at the size it will show.
  function terminalFor(id) {
    const entry = tab(id);
    if (entry.term) return entry;
    const host = document.createElement('div'); host.className = 'cli-host'; host.dataset.projectId = id; host.hidden = true;
    hosts.append(host);
    const font = (typeof getComputedStyle === 'function' && getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()) || 'Menlo, monospace';
    const term = new Terminal({ cursorBlink: true, fontFamily: font, fontSize: 13, lineHeight: 1.2, scrollback: 10000, allowProposedApi: false, macOptionIsMeta: false, theme: theme(), linkHandler: { activate: (event, uri) => openLink(event, term, uri), allowNonHttpProtocols: false } });
    const fit = new FitAddon();
    term.loadAddon(fit); if (WebLinksAddon) term.loadAddon(new WebLinksAddon((event, uri) => openLink(event, term, uri))); term.open(host);
    Object.assign(entry, { term, fit, host, stream: null, queue: '', sending: false, resizeTimer: null });
    // Option+Enter and Shift+Enter start a new line in the message, as in a terminal that reports them.
    term.attachCustomKeyEventHandler?.(event => {
      if (event.type === 'keydown' && event.key === 'Enter' && (event.altKey || event.shiftKey) && !event.metaKey && !event.ctrlKey) { input(id, '\x1b\r'); return false; }
      return true;
    });
    term.onData(data => {
      // After the command ended with a problem, Enter starts it again.
      if (!live(entry.session)) { if (data === '\r' && entry.session) restart(id); return; }
      input(id, data);
    });
    term.onResize(({ cols, rows }) => {
      clearTimeout(entry.resizeTimer);
      if (!live(entry.session)) return;
      entry.resizeTimer = setTimeout(() => api.post('/api/terminal/resize', { id: entry.session.id, cols, rows }, id).catch(() => {}), 80);
    });
    return entry;
  }
  // Keys go to the command in order, batched while a request is in flight.
  function input(id, data) {
    const entry = tab(id);
    entry.queue += data;
    const send = async () => {
      if (entry.sending || !entry.queue || !live(entry.session)) return;
      entry.sending = true;
      const chunk = entry.queue; entry.queue = '';
      try { await api.post('/api/terminal/input', { id: entry.session.id, data: chunk }, id); }
      catch (error) { if (id === projectId()) say(error.message); }
      finally { entry.sending = false; if (entry.queue) send(); }
    };
    send();
  }
  // The command's output, from where this view left off.
  function follow(id) {
    const entry = tab(id), session = entry.session;
    entry.stream?.close();
    const query = Object.entries({ projectId: id, id: session.id, ...(token() ? { token: token() } : {}) }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    entry.stream = new EventSource('/api/terminal/stream?' + query);
    entry.stream.addEventListener('reset', event => { entry.term.reset(); entry.term.write(JSON.parse(event.data).data); });
    entry.stream.addEventListener('data', event => entry.term.write(JSON.parse(event.data).data));
    entry.stream.addEventListener('exit', event => {
      const ended = JSON.parse(event.data); entry.stream.close(); entry.stream = null;
      entry.session = { ...entry.session, ...ended };
      // Leaving the command (Ctrl+D, /exit) closes its tab and shows the chat. A problem stays on screen to read.
      if (ended.exitCode === 0 && !ended.signal) { close(id); return; }
      entry.term.write(`\r\n\x1b[2m[codeshi ended${Number.isInteger(ended.exitCode) ? ` with code ${ended.exitCode}` : ''}. Press Enter to start it again, or close this tab.]\x1b[22m\r\n`);
      render();
    });
  }
  function dispose(entry) {
    entry.stream?.close(); clearTimeout(entry.resizeTimer);
    entry.term?.dispose(); entry.host?.remove();
    Object.assign(entry, { term: null, fit: null, host: null, stream: null, queue: '', session: null });
  }

  const fitShown = () => { const entry = tabs.get(projectId()); if (entry?.term && !entry.host.hidden) try { entry.fit.fit(); } catch { /* Not laid out yet. */ } };
  const focus = () => { const entry = tabs.get(projectId()); if (entry?.term && entry.front) entry.term.focus(); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

  function render() {
    const id = projectId(), entry = id ? tabs.get(id) : null, flow = flowOn();
    const front = Boolean(entry?.front) && !flow, open = Boolean(entry && (entry.front || entry.session)) && !flow;
    strip.hidden = !open;
    main.classList.toggle('cli-front', front);
    view.hidden = !front;
    for (const [key, other] of tabs) if (other.host) other.host.hidden = !(front && key === id);
    $('main-tab-chat').setAttribute('aria-selected', String(!front)); $('main-tab-chat').tabIndex = front ? -1 : 0;
    $('main-tab-cli').setAttribute('aria-selected', String(front)); $('main-tab-cli').tabIndex = front ? 0 : -1;
    $('main-tab-cli').dataset.state = entry?.session ? (live(entry.session) ? 'running' : 'ended') : 'starting';
    if (button) {
      button.hidden = !available || !loaded;
      button.disabled = !id || busy;
      button.setAttribute('aria-pressed', String(front));
      button.title = front ? 'Back to the chat. The CLI keeps running.' : 'CLI: this conversation in the codeshi command, in a tab. Same agent, same runs.';
    }
    if (front) requestAnimationFrame(fitShown);
  }

  // Opens the workspace's CLI tab, starting the command if it isn't running.
  async function open() {
    const id = projectId();
    if (!id || !available || !loaded || busy || flowOn()) return;
    const entry = tab(id);
    entry.front = true; say('');
    if (live(entry.session)) { render(); focus(); return; }
    busy = true;
    try {
      if (entry.session) dispose(entry);
      terminalFor(id); render(); await frame(); fitShown();
      const session = await api.post('/api/terminal/start', { kind: 'cli', cols: entry.term.cols, rows: entry.term.rows }, id);
      entry.session = session;
      if (session.status === 'failed') say(session.error || 'codeshi could not start.');
      else follow(id);
    } catch (error) { say(error.message); }
    finally { busy = false; render(); focus(); }
  }
  async function restart(id) { if (id !== projectId()) return; await close(id, { quiet: true }); await open(); }
  function showChat() {
    const entry = tabs.get(projectId());
    if (!entry?.front) return;
    entry.front = false; render();
    $('message-input')?.focus?.();
  }
  // × ends the command; a run it started carries on, in the chat.
  async function close(id = projectId(), { quiet = false } = {}) {
    const entry = tabs.get(id);
    if (!entry) return;
    const session = entry.session;
    entry.front = false; dispose(entry); say(''); render();
    if (id === projectId() && !quiet) $('message-input')?.focus?.();
    // The engine ends the command if it still runs, and forgets it either way.
    if (session) { try { await api.post('/api/terminal/stop', { id: session.id }, id); } catch { /* It ends with the app anyway. */ } }
  }

  // A CLI tab that runs keeps running while another workspace is open; opening that workspace again shows it as it was.
  async function load() {
    const id = projectId();
    if (!id) { render(); return; }
    try {
      const state = await api.api('/api/terminal', {}, id);
      if (id !== projectId()) return;
      available = state.cliAvailable === true;
      const entry = tab(id);
      if (state.cli && live(state.cli) && (!entry.session || entry.session.id !== state.cli.id)) {
        entry.session = state.cli; terminalFor(id); follow(id);
      } else if (!state.cli && entry.session && live(entry.session)) dispose(entry);
    } catch { /* The button stays as it was. */ }
    render();
  }

  button?.addEventListener('click', () => { const entry = tabs.get(projectId()); if (entry?.front) showChat(); else open(); });
  $('main-tab-chat').addEventListener('click', showChat);
  $('main-tab-cli').addEventListener('click', () => open());
  $('main-tab-cli-close').addEventListener('click', () => close());
  // The two tabs move with the arrow keys, as tabs do.
  strip.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !event.target?.closest?.('[role="tab"]')) return;
    event.preventDefault();
    if (tabs.get(projectId())?.front) { showChat(); $('main-tab-chat').focus(); } else { open(); $('main-tab-cli').focus(); }
  });
  // /open in the CLI asks the window to show this conversation: the chat tab comes to the front.
  window.relayDesktop?.onMenuCommand?.((name, value) => { if (name === 'open-workspace' && value === projectId()) showChat(); });

  let fitTimer = null;
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = setTimeout(fitShown, 80); }).observe(hosts);
  if (typeof MutationObserver === 'function') new MutationObserver(() => { const colours = theme(); for (const entry of tabs.values()) if (entry.term) entry.term.options.theme = colours; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('relay-flow', render);
  let lastProject;
  window.addEventListener('relay-state', () => {
    if (projectId() === lastProject) return;
    lastProject = projectId(); say(''); load();
  });
  // ⌘J and friends stay with the window; on other systems, Ctrl keys typed here belong to the command.
  if (!mac) view.addEventListener('keydown', event => { if (event.ctrlKey) event.stopPropagation(); });
  render();
  window.relayCli = { open, showChat, close: () => close(), isFront: () => Boolean(tabs.get(projectId())?.front) && !flowOn() };
})();

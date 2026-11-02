(() => {
  'use strict';
  // Updates (#2): when a newer release is out, the status bar says so. Its popover links the release notes and installs
  // the update with one click: the app downloads and checks it, then restarts into the new version once no agent is
  // working. A version can be skipped, and automatic checks can be turned off in Settings.
  const bridge = window.relayDesktop, api = window.relayUI, $ = id => document.getElementById(id);
  const button = $('update-status'), popover = $('update-popover');
  if (!bridge?.getUpdateState || !api || !button || !popover) return;
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const action = (text, handler, cls = 'secondary-button') => { const value = node('button', text, cls); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const size = bytes => `${(bytes / 1048576).toFixed(bytes >= 104857600 ? 0 : 1)} MB`;
  const isOpen = () => typeof popover.matches === 'function' && popover.matches(':popover-open');
  // Agents working in any workspace; the update waits for them.
  const working = () => (api.getState().projects || []).some(project => project.runningConversationId);
  let state = null, attempted = false, settingsHost = null;

  const offered = () => state?.status === 'available' && state.latest && state.latest.version !== state.skipped;
  const visible = () => Boolean(state?.supported && (offered() || ['downloading', 'waiting', 'installing'].includes(state.status) || state.status === 'error' && attempted));
  function label() {
    const progress = state.progress, percent = progress?.total ? Math.min(100, Math.round(progress.received / progress.total * 100)) : null;
    return { available: `Update available · ${state.latest?.version}`, downloading: percent === null ? 'Downloading update…' : `Downloading update · ${percent}%`, waiting: 'Updates after this run', installing: 'Restarting to update…', error: 'Update failed' }[state.status] || 'Update';
  }
  function openNotes() { if (state?.latest?.notesUrl) bridge.openExternal(state.latest.notesUrl).catch(error => api.showNotice(error.message)); }
  async function call(work) {
    try { state = await work(); } catch (error) { api.showNotice(error.message); }
    render();
  }
  const install = () => { attempted = true; call(() => bridge.installUpdate()); };

  function body() {
    const host = node('div', undefined, 'update-body'), latest = state.latest, text = (value, cls = 'update-text') => host.append(node('p', value, cls));
    const row = (...buttons) => { const group = node('div', undefined, 'update-actions'); group.append(...buttons); host.append(group); };
    if (state.status === 'checking') { text('Checking for updates…'); return host; }
    if (state.status === 'current' || state.status === 'idle') { text(`Throughline ${state.version} is the latest version.`); return host; }
    if (state.status === 'error' && !latest) { text(state.error, 'update-text update-error'); row(action('Try again', () => call(() => bridge.checkForUpdates()))); return host; }
    if (latest) { const notes = action('Release notes ↗', openNotes, 'text-link update-notes'); host.append(notes); }
    if (state.status === 'downloading') {
      const progress = state.progress, bar = node('div', undefined, 'update-progress'), fill = node('span');
      fill.style.width = progress?.total ? `${Math.min(100, progress.received / progress.total * 100)}%` : '8%';
      bar.append(fill); host.append(bar);
      text(progress?.total ? `Downloading ${size(progress.received)} of ${size(progress.total)}` : progress?.received ? `Downloading ${size(progress.received)}` : 'Starting the download…');
      row(action('Cancel', () => call(() => bridge.cancelUpdate())));
      return host;
    }
    if (state.status === 'waiting') {
      text('Downloaded and checked. Throughline restarts into the new version as soon as no agent is working, and opens your workspaces as they were.');
      row(action('Cancel', () => call(() => bridge.cancelUpdate())));
      return host;
    }
    if (state.status === 'installing') { text('Restarting into the new version…'); return host; }
    if (state.status === 'error') text(state.error, 'update-text update-error');
    if (state.blocked) {
      text(state.blocked === 'translocated' ? 'Throughline is running from a temporary copy, so it can’t replace itself. Move it to your Applications folder, or download the update.' : 'Throughline can’t replace itself in this folder. Download the update to install it yourself.');
      row(action('Download ↗', openNotes, 'primary-button'));
      return host;
    }
    const busy = working();
    text(busy ? 'An agent is working. The update downloads now and Throughline restarts once the run finishes, never in the middle of one.' : 'Throughline downloads the update for this Mac, checks it, and restarts. Your workspaces and conversations are kept.');
    const skip = action('Skip this version', () => call(() => bridge.skipUpdate(latest.version)), 'text-link');
    row(skip, action(state.status === 'error' ? 'Try again' : busy ? 'Update after this run' : 'Update and restart', install, 'primary-button'));
    return host;
  }

  function position() {
    if (!isOpen()) return;
    const edge = 12, gap = 10, width = Math.min(320, window.innerWidth - edge * 2);
    popover.style.width = width + 'px';
    const anchor = (visible() ? button : $('relay-settings')).getBoundingClientRect(), height = popover.getBoundingClientRect().height;
    popover.style.left = Math.max(edge, Math.min(anchor.right - width, window.innerWidth - width - edge)) + 'px';
    popover.style.top = Math.max(edge, anchor.top - gap - height) + 'px';
  }
  function render() {
    if (!state) return;
    button.hidden = !visible();
    button.dataset.status = state.status;
    $('update-status-label').textContent = label();
    if (isOpen()) {
      const latest = state.latest && ['available', 'downloading', 'waiting', 'installing', 'error'].includes(state.status);
      $('update-title').textContent = latest ? `Throughline ${state.latest.version}` : 'Software update';
      $('update-subtitle').textContent = `You have ${state.version}`;
      $('update-content').replaceChildren(body());
      position();
    }
    if (settingsHost?.isConnected) renderSettings(settingsHost);
  }
  function open() {
    if (!isOpen()) popover.showPopover();
    button.setAttribute('aria-expanded', 'true');
    render();
  }
  function close() { if (isOpen()) popover.hidePopover(); }

  // The Updates part of Settings: automatic checks, a manual check and the last result.
  function renderSettings(host) {
    settingsHost = host;
    host.replaceChildren();
    host.append(node('h3', 'Updates'));
    if (!state?.supported) { host.append(node('p', window.relayDesktop?.platform === 'win32' ? 'Updates install in the Throughline app for macOS. On Windows, run the installer again or download the latest release to update.' : 'Updates install in the Throughline app for macOS. This copy is updated from its source instead.', 'section-description')); return; }
    const checked = state.checkedAt ? new Date(state.checkedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
    const summary = state.status === 'checking' ? 'Checking for updates…' : offered() || ['downloading', 'waiting', 'installing'].includes(state.status) ? `Throughline ${state.latest.version} is available. You have ${state.version}.` : state.status === 'error' ? state.error : `You have ${state.version}${state.status === 'current' ? ', the latest version' : ''}.${checked ? ` Last checked ${checked}.` : ''}`;
    host.append(node('p', summary, 'section-description'));
    const toggle = node('label', undefined, 'review-check'), input = node('input');
    input.type = 'checkbox'; input.checked = state.automatic;
    input.addEventListener('change', () => call(() => bridge.setAutomaticUpdates(input.checked)));
    toggle.append(input, document.createTextNode('Check for updates automatically'));
    host.append(toggle);
    const group = node('div', undefined, 'workbench-actions');
    const check = action(state.status === 'checking' ? 'Checking…' : 'Check now', () => call(() => bridge.checkForUpdates()));
    check.disabled = ['checking', 'downloading', 'waiting', 'installing'].includes(state.status);
    group.append(check);
    if (state.latest && (offered() || state.skipped === state.latest.version)) group.append(action('Show update', () => open()));
    host.append(group);
  }

  button.addEventListener('click', () => { if (isOpen()) close(); else open(); });
  $('close-update').addEventListener('click', () => { close(); button.focus(); });
  popover.addEventListener('toggle', () => { if (!isOpen()) button.setAttribute('aria-expanded', 'false'); });
  window.addEventListener('resize', position);
  // Agents starting or finishing change what the Update button promises.
  window.addEventListener('relay-state', () => { if (isOpen()) render(); });
  bridge.onUpdateState(next => { state = next; render(); });
  bridge.getUpdateState().then(next => { state ||= next; render(); }).catch(() => {});

  window.relayUpdater = {
    // Check for Updates… in the app menu: checks now and shows the answer, including a skipped version.
    async checkNow() {
      if (!state?.supported) return false;
      open();
      state = await bridge.checkForUpdates().catch(error => ({ ...state, status: 'error', error: error.message }));
      if (state.status === 'available' && state.skipped === state.latest?.version) state = { ...state, skipped: null };
      render();
      return true;
    },
    settings: host => renderSettings(host),
    open,
  };
})();

(() => {
  'use strict';
  // Updates (#2): when a newer release is out, the status bar shows Update to <version>. One click downloads the update
  // for this Mac and checks it, with a ring for the download, and the button becomes Restart to update. Restarting
  // never stops an agent: it waits for the run to finish. Quitting instead installs the update as Throughline closes.
  // The chevron beside the button has the release notes and Skip this version, and Settings turns automatic checks
  // off.
  const bridge = window.relayDesktop, api = window.relayUI, $ = id => document.getElementById(id);
  const button = $('update-status'), more = $('update-more'), popover = $('update-popover');
  if (!bridge?.getUpdateState || !api || !button || !popover) return;
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const action = (text, handler, cls = 'secondary-button') => { const value = node('button', text, cls); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const isOpen = () => typeof popover.matches === 'function' && popover.matches(':popover-open');
  // Agents working in any workspace; a restart waits for them.
  const working = () => (api.getState().projects || []).some(project => project.runningConversationId);
  let state = null, attempted = false, settingsHost = null, anchor = button;

  const offered = () => state?.status === 'available' && state.latest && state.latest.version !== state.skipped;
  const visible = () => Boolean(state?.supported && (offered() || ['downloading', 'ready', 'waiting', 'installing'].includes(state.status) || state.status === 'error' && attempted));
  // The button does what it says when it can: Update downloads, Restart to update restarts. Otherwise it opens the
  // details, to cancel the download, try again, or download the update by hand.
  const direct = () => !state?.blocked && (offered() || state?.status === 'ready');
  // How far the download is, from 0 to 100, or null while its size is unknown.
  const percent = () => { const progress = state?.progress; return progress?.total ? Math.min(100, Math.round(progress.received / progress.total * 100)) : null; };
  const label = () => ({ available: `Update to ${state.latest?.version}`, downloading: 'Downloading update', ready: 'Restart to update', waiting: 'Restarts after this run', installing: 'Restarting…', error: 'Update failed' })[state.status] || 'Update';
  function openNotes() { if (state?.latest?.notesUrl) bridge.openExternal(state.latest.notesUrl).catch(error => api.showNotice(error.message)); }
  async function call(work) {
    try { state = await work(); } catch (error) { api.showNotice(error.message); }
    render();
  }
  const install = () => { attempted = true; call(() => bridge.installUpdate()); };
  const restart = () => call(() => bridge.restartToUpdate());

  function body() {
    const host = node('div', undefined, 'update-body'), latest = state.latest, text = (value, cls = 'update-text') => host.append(node('p', value, cls));
    const row = (...buttons) => { const group = node('div', undefined, 'update-actions'); group.append(...buttons); host.append(group); };
    if (state.status === 'checking') { text('Checking for updates…'); return host; }
    if (state.status === 'current' || state.status === 'idle') { text(`Throughline ${state.version} is the latest version.`); return host; }
    if (state.status === 'error' && !latest) { text(state.error, 'update-text update-error'); row(action('Try again', () => call(() => bridge.checkForUpdates()))); return host; }
    if (latest) { const notes = action('Release notes ↗', openNotes, 'text-link update-notes'); host.append(notes); }
    if (state.status === 'downloading') {
      const value = percent(), bar = node('div', undefined, 'update-progress'), fill = node('span');
      if (value === null) bar.classList.add('indeterminate'); else fill.style.width = `${value}%`;
      bar.append(fill); host.append(bar);
      text('Downloading the update for this Mac and checking it. You can keep working.');
      row(action('Cancel', () => call(() => bridge.cancelUpdate())));
      return host;
    }
    if (state.status === 'ready') {
      const busy = working();
      text(`Downloaded and checked. ${busy ? 'Throughline restarts once the agent finishes, never in the middle of a run.' : 'Restart to use it; your workspaces and conversations stay as they are.'} If you quit instead, it installs as Throughline closes.`);
      row(action(busy ? 'Restart after this run' : 'Restart now', restart, 'primary-button'));
      return host;
    }
    if (state.status === 'waiting') {
      text('Throughline restarts into the new version as soon as no agent is working, and opens your workspaces as they were.');
      row(action('Don’t restart', () => call(() => bridge.cancelUpdate())));
      return host;
    }
    if (state.status === 'installing') { text('Restarting into the new version…'); return host; }
    if (state.status === 'error') text(state.error, 'update-text update-error');
    if (state.blocked) {
      text(state.blocked === 'translocated' ? 'Throughline is running from a temporary copy, so it can’t replace itself. Move it to your Applications folder, or download the update.' : 'Throughline can’t replace itself in this folder. Download the update to install it yourself.');
      row(action('Download ↗', openNotes, 'primary-button'));
      return host;
    }
    text('Throughline downloads the update for this Mac and checks it. You restart when you’re ready, never in the middle of a run.');
    const skip = action('Skip this version', () => call(() => bridge.skipUpdate(latest.version)), 'text-link');
    row(skip, action(state.status === 'error' ? 'Try again' : 'Update', install, 'primary-button'));
    return host;
  }

  function position() {
    if (!isOpen()) return;
    const edge = 12, gap = 10, width = Math.min(320, window.innerWidth - edge * 2);
    popover.style.width = width + 'px';
    const target = visible() ? (anchor.hidden ? button : anchor) : $('relay-settings'), rect = target.getBoundingClientRect(), height = popover.getBoundingClientRect().height;
    popover.style.left = Math.max(edge, Math.min(rect.right - width, window.innerWidth - width - edge)) + 'px';
    popover.style.top = Math.max(edge, rect.top - gap - height) + 'px';
  }
  function render() {
    if (!state) return;
    const shown = visible(), value = state.status === 'downloading' ? percent() : null;
    button.hidden = !shown;
    button.dataset.status = state.status;
    // The download shows as a ring; its percentage is only in the button's name and tooltip.
    button.dataset.progress = state.status === 'downloading' && value !== null ? 'determinate' : 'indeterminate';
    button.style.setProperty('--update-progress', String(value ?? 0));
    $('update-status-label').textContent = label();
    button.setAttribute('aria-label', value === null ? label() : `${label()}, ${value}%`);
    button.title = { available: `Download Throughline ${state.latest?.version} and check it`, downloading: value === null ? 'Downloading the update' : `Downloading the update · ${value}%`, ready: 'Restart into the new version; your workspaces stay as they are', waiting: 'Throughline restarts once no agent is working', installing: 'Restarting into the new version', error: state.error || 'The update failed' }[state.status] || '';
    button.setAttribute('aria-haspopup', direct() ? 'false' : 'dialog');
    if (more) more.hidden = !shown || !direct();
    if (isOpen()) {
      const latest = state.latest && ['available', 'downloading', 'ready', 'waiting', 'installing', 'error'].includes(state.status);
      $('update-title').textContent = latest ? `Throughline ${state.latest.version}` : 'Software update';
      $('update-subtitle').textContent = `You have ${state.version}`;
      $('update-content').replaceChildren(body());
      position();
    }
    if (settingsHost?.isConnected) renderSettings(settingsHost);
  }
  function open(from = button) {
    anchor = from;
    if (!isOpen()) popover.showPopover();
    from.setAttribute('aria-expanded', 'true');
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
    const summary = state.status === 'checking' ? 'Checking for updates…'
      : ['ready', 'waiting'].includes(state.status) ? `Throughline ${state.latest.version} is downloaded and checked. Restart to use it.`
      : offered() || ['downloading', 'installing'].includes(state.status) ? `Throughline ${state.latest.version} is available. You have ${state.version}.`
      : state.status === 'error' ? state.error : `You have ${state.version}${state.status === 'current' ? ', the latest version' : ''}.${checked ? ` Last checked ${checked}.` : ''}`;
    host.append(node('p', summary, 'section-description'));
    const toggle = node('label', undefined, 'review-check'), input = node('input');
    input.type = 'checkbox'; input.checked = state.automatic;
    input.addEventListener('change', () => call(() => bridge.setAutomaticUpdates(input.checked)));
    toggle.append(input, document.createTextNode('Check for updates automatically'));
    host.append(toggle);
    const group = node('div', undefined, 'workbench-actions');
    const check = action(state.status === 'checking' ? 'Checking…' : 'Check now', () => call(() => bridge.checkForUpdates()));
    check.disabled = ['checking', 'downloading', 'ready', 'waiting', 'installing'].includes(state.status);
    group.append(check);
    if (state.latest && (offered() || state.skipped === state.latest.version)) group.append(action('Show update', () => open()));
    host.append(group);
  }

  button.addEventListener('click', () => {
    if (!state) return;
    if (!direct()) { if (isOpen()) close(); else open(button); return; }
    close();
    if (state.status === 'ready') restart(); else install();
  });
  more?.addEventListener('click', () => { if (isOpen()) close(); else open(more); });
  $('close-update').addEventListener('click', () => { close(); (anchor.hidden ? button : anchor).focus(); });
  popover.addEventListener('toggle', () => { if (!isOpen()) for (const control of [button, more].filter(Boolean)) control.setAttribute('aria-expanded', 'false'); });
  window.addEventListener('resize', position);
  // Agents starting or finishing change what Restart promises.
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

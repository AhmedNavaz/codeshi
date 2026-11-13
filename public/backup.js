(() => {
  'use strict';
  // Move to another computer (#160): Export Codeshi Backup writes workspaces, their conversations and settings to one
  // file locked with a passphrase; Import Codeshi Backup opens one, asks which folder each workspace folder is on this
  // computer (one already here, a fresh clone, or none), and asks before replacing a conversation that changed here too.
  // Nothing goes through a server; the file is moved however you like. Move to Another Computer sends the same backup
  // directly over this network instead: the old computer shows a move code, the new one types it, both show the same six
  // digits, and nothing is sent until you choose Allow on the old one. The new computer then imports it as a file.
  const $ = id => document.getElementById(id), api = () => window.relayUI, bridge = window.relayDesktop;
  const dialog = $('backup-dialog');
  if (!dialog) return;
  const { t, tn } = window.codeshiText;
  const content = $('backup-content'), error = $('backup-error'), status = $('backup-status'), submit = $('backup-submit'), cancel = $('backup-cancel');
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const bytes = value => { const units = [['gigabyte', 1e9], ['megabyte', 1e6], ['kilobyte', 1e3]], [unit, size] = units.find(([, size]) => value >= size) || ['byte', 1]; return new Intl.NumberFormat(undefined, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: size >= 1e9 ? 1 : 0 }).format(value / size); };
  const when = value => { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); };
  const SETTING_NAMES = () => ({ appearance: t('theme'), language: t('language'), defaults: t('default agent and access'), notifications: t('alerts'), handoff: t('handoffs'), contextLimit: t('context limit'), verificationCadence: t('testing cadence'), suggestions: t('suggestions') });
  let screen = 'export', busy = false, summary = null, opened = null, file = '', picked = '', passphrase = '', choices = {}, includeSettings = false, decisions = {}, conflicts = [], result = null, exported = null;
  let exportChoice = { workspaces: new Set(), checkpoints: false, settings: true }, reload = false;
  let sendState = null, receiveState = null, polling = null, drawn = '', received = false;

  function showError(message) { error.textContent = message || ''; error.hidden = !message; }
  function heading(title, description) { $('backup-title').textContent = title; $('backup-description').textContent = description || ''; }
  function setBusy(value, text = '') {
    busy = value; status.textContent = text; dialog.setAttribute('aria-busy', String(value));
    for (const control of dialog.querySelectorAll('input, select, button')) if (control !== cancel || !value) control.disabled = value || control.dataset.locked === 'true';
    cancel.disabled = value;
  }
  // A labelled text field with Choose… beside it in the desktop app.
  function pathField({ id, label, value, placeholder, choose }) {
    const wrap = node('div', undefined, 'backup-path'), name = node('label', label, 'brief-label'), row = node('div', undefined, 'backup-path-row'), input = node('input');
    name.htmlFor = id; input.id = id; input.type = 'text'; input.value = value || ''; input.placeholder = placeholder || ''; input.spellcheck = false; input.autocomplete = 'off';
    row.append(input);
    if (choose) { const button = node('button', t('Choose…'), 'secondary-button'); button.type = 'button'; button.addEventListener('click', async () => { const chosen = await choose(); if (chosen) { input.value = chosen; input.dispatchEvent(new Event('input')); } input.focus(); }); row.append(button); }
    wrap.append(name, row); return { wrap, input };
  }
  function check(label, description, checked, onChange, locked = false) {
    const row = node('label', undefined, 'backup-check'), box = node('input'), text = node('span', undefined, 'backup-check-text');
    box.type = 'checkbox'; box.checked = checked; box.disabled = locked; if (locked) box.dataset.locked = 'true';
    box.addEventListener('change', () => onChange(box.checked));
    text.append(node('span', label, 'backup-check-label')); if (description) text.append(node('span', description, 'backup-check-description'));
    row.append(box, text); return row;
  }
  function password(id, label, autocomplete) {
    const wrap = node('div', undefined, 'backup-field'), name = node('label', label, 'brief-label'), input = node('input');
    name.htmlFor = id; input.id = id; input.type = 'password'; input.autocomplete = autocomplete; input.spellcheck = false;
    wrap.append(name, input); return { wrap, input };
  }
  function focusFirst() { (content.querySelector('input:not([disabled]):not([type=checkbox]):not([type=radio]), select') || content.querySelector('input:not([disabled])') || submit).focus(); }

  // Export: which workspaces, whether checkpoints and settings go too, a passphrase twice and where to save.
  function renderExport() {
    heading(t('Export Codeshi backup'), t('One file with your workspaces, their conversations, memory, skills, board cards and tasks, and your settings, locked with a passphrase. On the other computer, open it with Import Codeshi Backup.'));
    submit.textContent = t('Export'); content.replaceChildren();
    if (!summary) { content.append(node('p', t('Reading your workspaces…'), 'backup-note')); return; }
    const [list, extras, size] = choiceFields();
    const first = password('backup-passphrase', t('Passphrase'), 'new-password'), second = password('backup-passphrase-again', t('Passphrase again'), 'new-password');
    const fields = node('div', undefined, 'backup-fields'); fields.append(first.wrap, second.wrap);
    const warning = node('p', t('At least 8 characters. Codeshi can’t recover a forgotten passphrase, and anyone with the file and the passphrase can read everything in it.'), 'backup-note');
    const name = `Codeshi Backup ${new Date().toISOString().slice(0, 10)}.codeshibackup`;
    const target = pathField({ id: 'backup-file', label: t('Save as'), value: file || `${summary.suggestedFolder}/${name}`, choose: bridge?.pickBackup ? async () => { const chosen = await bridge.pickBackup({ mode: 'save', name }); if (chosen) picked = chosen; return chosen; } : null });
    content.append(list, extras, size, fields, warning, target.wrap, staysHere());
    total();
  }
  const staysHere = () => { const stays = node('details', undefined, 'backup-details'); stays.append(node('summary', t('What stays on this computer')), node('p', t('Agent sign-ins, your GitHub login, phone pairings, anything in the keychain, approvals you chose to always allow, and the working copies parallel tasks use. The code itself isn’t included: it stays in its folders and in Git.'), 'backup-note')); return stays; };
  // Which workspaces go, and whether checkpoints and settings go too: shared by Export and Move.
  function choiceFields() {
    const list = node('fieldset', undefined, 'backup-list'); list.append(node('legend', t('Workspaces'), 'brief-label'));
    if (!summary.workspaces.length) list.append(node('p', t('There are no workspaces yet. Settings can still be exported.'), 'backup-note'));
    for (const workspace of summary.workspaces) {
      const meta = workspace.running ? t('Working now. Wait for it to finish to include it.') : `${workspace.folders.join(', ')} · ${bytes(workspace.bytes)}`;
      list.append(check(workspace.name, meta, exportChoice.workspaces.has(workspace.id), on => { if (on) exportChoice.workspaces.add(workspace.id); else exportChoice.workspaces.delete(workspace.id); total(); }, workspace.running));
    }
    const checkpointBytes = summary.workspaces.reduce((sum, item) => sum + item.checkpointBytes, 0);
    const extras = node('fieldset', undefined, 'backup-list'); extras.append(node('legend', t('Also include'), 'brief-label'));
    if (checkpointBytes) extras.append(check(t('Checkpoints'), t('Undo and Timeline restore keep working on the other computer. Adds up to {size}.', { size: bytes(checkpointBytes) }), exportChoice.checkpoints, on => { exportChoice.checkpoints = on; total(); }));
    extras.append(check(t('Settings'), t('Theme, language, alerts, handoffs, testing and the default agent.'), exportChoice.settings, on => { exportChoice.settings = on; }));
    const size = node('p', '', 'backup-note'); size.id = 'backup-size';
    return [list, extras, size];
  }
  function total() {
    const line = $('backup-size'); if (!line || !summary) return;
    const chosen = summary.workspaces.filter(item => exportChoice.workspaces.has(item.id)), amount = chosen.reduce((sum, item) => sum + item.bytes + (exportChoice.checkpoints ? item.checkpointBytes : 0), 0);
    line.textContent = chosen.length ? tn(chosen.length, 'About {size} for 1 workspace.', 'About {size} for {count} workspaces.', { size: bytes(amount) }) : t('No workspaces chosen.');
  }
  async function runExport() {
    const first = $('backup-passphrase').value, second = $('backup-passphrase-again').value, target = $('backup-file').value.trim();
    if (!exportChoice.workspaces.size && !exportChoice.settings) throw new Error(t('Choose at least one workspace, or settings.'));
    if (first.length < 8) throw new Error(t('Use a passphrase of at least 8 characters.'));
    if (first !== second) throw new Error(t('The two passphrases don’t match.'));
    if (!target) throw new Error(t('Choose where to save the backup.'));
    file = target;
    setBusy(true, t('Encrypting and saving…'));
    try { exported = await api().post('/api/backup/export', { path: target, passphrase: first, workspaces: [...exportChoice.workspaces].map(id => ({ id, checkpoints: exportChoice.checkpoints })), settings: exportChoice.settings, replace: Boolean(picked) && picked === target }); }
    finally { setBusy(false); }
    screen = 'exported'; render();
  }
  function renderExported() {
    heading(t('Backup saved'), '');
    submit.textContent = t('Done'); content.replaceChildren();
    const where = exported.path.split(/[\\/]/), name = where.pop();
    content.append(node('p', t('Saved {file} ({size}) in {folder}.', { file: name, size: bytes(exported.bytes), folder: where.join('/') || '/' }), 'backup-lead'));
    content.append(node('p', t('Copy it to the other computer however you like, such as AirDrop or a drive, then open it there with File › Import Codeshi Backup and the same passphrase.'), 'backup-note'));
  }

  // Import, first: which file, and its passphrase.
  function renderOpen() {
    heading(t('Import Codeshi backup'), t('Brings workspaces, conversations and settings from another computer’s Codeshi. Nothing here is deleted, and a conversation that also changed here is replaced only if you choose.'));
    submit.textContent = t('Open'); content.replaceChildren();
    const source = pathField({ id: 'backup-file', label: t('Backup file'), value: file, placeholder: '~/Downloads/Codeshi Backup.codeshibackup', choose: bridge?.pickBackup ? () => bridge.pickBackup({ mode: 'open' }) : null });
    const secret = password('backup-passphrase', t('Passphrase'), 'current-password'); secret.input.value = passphrase;
    const other = node('p', undefined, 'backup-note'), link = node('button', t('Receive from a computer on this network'), 'text-link');
    link.type = 'button'; link.addEventListener('click', () => { screen = 'receive'; render(); focusFirst(); });
    other.append(t('No file? '), link, '.');
    content.append(source.wrap, secret.wrap, other);
  }
  async function runOpen() {
    const source = $('backup-file').value.trim(), secret = $('backup-passphrase').value;
    if (!source) throw new Error(t('Choose the backup file.'));
    if (!secret) throw new Error(t('Enter the backup’s passphrase.'));
    setBusy(true, t('Opening the backup…'));
    try { opened = await api().post('/api/backup/read', { path: source, passphrase: secret }); }
    finally { setBusy(false); }
    file = source; passphrase = secret; decisions = {}; conflicts = [];
    choices = Object.fromEntries(opened.workspaces.map(workspace => [workspace.key, { include: true, folders: Object.fromEntries(workspace.folders.map(folder => [folder.id, folder.suggestion ? { kind: 'suggested', path: folder.suggestion.path } : folder.repository ? { kind: 'clone' } : { kind: 'path', path: '' }])) }]));
    includeSettings = Boolean(opened.settings?.length) && !opened.hasWorkspaces;
    screen = 'map'; render();
  }

  // Import, second: where each workspace's folders are on this computer.
  function folderRow(workspace, folder) {
    const choice = choices[workspace.key].folders[folder.id], row = node('div', undefined, 'backup-folder'), id = `backup-folder-${workspace.key}-${folder.id}`;
    const label = node('label', undefined, 'backup-folder-name'); label.htmlFor = id;
    label.append(node('span', folder.displayName)); if (folder.repository) label.append(node('span', folder.repository, 'backup-folder-repo'));
    label.title = t('On the other computer: {path}', { path: folder.path });
    const select = node('select'); select.id = id;
    const option = (value, text) => { const item = node('option', text); item.value = value; select.append(item); };
    if (folder.suggestion) option('suggested', folder.suggestion.reason === 'clone' ? t('{path} (already cloned here)', { path: folder.suggestion.path }) : t('{path} (same place)', { path: folder.suggestion.path }));
    if (folder.repository) option('clone', t('Clone {repository} into {folder}', { repository: folder.repository, folder: opened.cloneFolder }));
    option('path', t('Another folder…')); option('skip', t('Leave this folder out'));
    select.value = choice.kind;
    select.addEventListener('change', () => { choices[workspace.key].folders[folder.id] = select.value === 'suggested' ? { kind: 'suggested', path: folder.suggestion.path } : { kind: select.value, path: select.value === 'path' ? choice.path || '' : '' }; render(); $(id)?.focus(); });
    row.append(label, select);
    if (choice.kind === 'path') {
      const input = node('input', undefined, 'backup-folder-path'); input.type = 'text'; input.value = choice.path || ''; input.placeholder = t('Folder on this computer, e.g. ~/Projects/{name}', { name: folder.name }); input.setAttribute('aria-label', t('Folder for {name}', { name: folder.displayName })); input.spellcheck = false;
      input.addEventListener('input', () => { choices[workspace.key].folders[folder.id].path = input.value; });
      const wrap = node('div', undefined, 'backup-path-row backup-folder-custom'); wrap.append(input);
      if (bridge?.pickFolder) { const button = node('button', t('Choose…'), 'secondary-button'); button.type = 'button'; button.setAttribute('aria-label', t('Choose the folder for {name}', { name: folder.displayName })); button.addEventListener('click', async () => { const chosen = await bridge.pickFolder(); if (chosen?.[0]) { input.value = chosen[0]; choices[workspace.key].folders[folder.id].path = chosen[0]; } input.focus(); }); wrap.append(button); }
      row.append(wrap);
    }
    return row;
  }
  function renderMap() {
    heading(t('Import Codeshi backup'), t('From {computer}, saved {date}.', { computer: opened.computer || t('another computer'), date: when(opened.createdAt) }));
    submit.textContent = t('Import'); content.replaceChildren();
    if (opened.workspaces.length) content.append(node('p', t('Choose where each folder is on this computer. A workspace whose folders are already a workspace here is added to it.'), 'backup-note'));
    for (const workspace of opened.workspaces) {
      const choice = choices[workspace.key], section = node('section', undefined, 'backup-workspace');
      const meta = [tn(workspace.conversations, '1 conversation', '{count} conversations'), bytes(workspace.bytes), workspace.checkpoints ? t('with checkpoints') : ''].filter(Boolean).join(' · ');
      section.append(check(workspace.name, meta, choice.include, on => { choice.include = on; render(); }));
      if (choice.include) { const folders = node('div', undefined, 'backup-folders'); folders.append(...workspace.folders.map(folder => folderRow(workspace, folder))); section.append(folders); }
      content.append(section);
    }
    if (opened.settings?.length) {
      const names = SETTING_NAMES(), list = opened.settings.map(key => names[key] || key).join(', ');
      content.append(check(t('Settings from the backup'), opened.hasWorkspaces ? t('Replaces these settings here: {list}.', { list }) : t('Includes {list}.', { list }), includeSettings, on => { includeSettings = on; }));
    }
    content.append(node('p', t('Sign-ins never move. Connect your agents on this computer in Settings › Agents & accounts.'), 'backup-note'));
  }
  async function runImport() {
    const picked = opened.workspaces.filter(workspace => choices[workspace.key].include);
    for (const workspace of picked) {
      const folders = Object.values(choices[workspace.key].folders);
      if (folders.every(folder => folder.kind === 'skip')) throw new Error(t('{name}: choose a folder for at least one of its folders, or leave the workspace out.', { name: workspace.name }));
      for (const folder of workspace.folders) { const choice = choices[workspace.key].folders[folder.id]; if (choice.kind === 'path' && !choice.path.trim()) throw new Error(t('{name}: choose a folder on this computer, or leave it out.', { name: folder.displayName })); }
    }
    if (!picked.length && !includeSettings) throw new Error(t('Choose a workspace or settings to import.'));
    setBusy(true);
    try {
      // Clones first, one at a time; a folder that's cloned stays chosen if the import is tried again.
      for (const workspace of picked) for (const folder of workspace.folders) {
        const choice = choices[workspace.key].folders[folder.id];
        if (choice.kind !== 'clone') continue;
        status.textContent = t('Cloning {repository}…', { repository: folder.repository });
        const cloned = await api().post('/api/github/clone', { repository: folder.repository, cloneFolder: opened.cloneFolder, workspace: false });
        choices[workspace.key].folders[folder.id] = { kind: 'path', path: cloned.path };
      }
      status.textContent = t('Importing…');
      result = await api().post('/api/backup/import', { path: file, passphrase, settings: includeSettings, decisions, workspaces: picked.map(workspace => ({ key: workspace.key, folders: Object.fromEntries(workspace.folders.map(folder => { const choice = choices[workspace.key].folders[folder.id]; return [folder.id, choice.kind === 'skip' ? null : choice.path.trim()]; })) })) });
    } catch (failure) {
      if (failure.status === 409 && Array.isArray(failure.details?.conflicts)) { conflicts = failure.details.conflicts; for (const item of conflicts) decisions[item.key] ||= 'keep'; setBusy(false); screen = 'conflicts'; render(); return; }
      setBusy(false); if (screen === 'map') render(); throw failure;
    }
    setBusy(false); passphrase = '';
    if (received) { received = false; api().post('/api/move/receive/stop', {}).catch(() => {}); }
    try { await api().refreshProjects?.(); } catch { /* The list refreshes on its own. */ }
    // Imported settings show at once: the theme now, the language when the dialog closes, as choosing one does.
    if (result.settings?.includes('appearance')) { try { window.relayTheme?.follow?.((await api().api('/api/appearance')).theme); } catch { /* Shown after the next reload. */ } }
    reload = result.settings?.includes('language') === true;
    window.dispatchEvent(new CustomEvent('relay-backup-imported', { detail: { workspaces: result.workspaces.map(item => ({ id: item.id, name: item.name, created: item.created })) } }));
    screen = 'done'; render();
  }

  // Import, when needed: conversations that changed on both computers since they were last the same.
  function renderConflicts() {
    heading(t('Choose which to keep'), t('These conversations changed on this computer and in the backup since they were last the same.'));
    submit.textContent = t('Import'); content.replaceChildren();
    for (const item of conflicts) {
      const group = node('fieldset', undefined, 'backup-conflict');
      group.append(node('legend', item.current ? t('{workspace}: its current conversation', { workspace: item.workspace }) : t('{workspace}: an earlier conversation', { workspace: item.workspace })));
      for (const [value, label, detail] of [['keep', t('Keep this computer’s'), t('Changed {date} · {size}', { date: when(item.here.modifiedAt), size: bytes(item.here.bytes) })], ['backup', t('Use the backup’s'), t('Changed {date} · {size}. This computer’s copy is kept in Codeshi’s data folder.', { date: when(item.backup.modifiedAt), size: bytes(item.backup.bytes) })]]) {
        const row = node('label', undefined, 'backup-check'), radio = node('input'), text = node('span', undefined, 'backup-check-text');
        radio.type = 'radio'; radio.name = `backup-${item.key}`; radio.value = value; radio.checked = decisions[item.key] === value;
        radio.addEventListener('change', () => { decisions[item.key] = value; });
        text.append(node('span', label, 'backup-check-label'), node('span', detail, 'backup-check-description')); row.append(radio, text); group.append(row);
      }
      content.append(group);
    }
  }
  function renderDone() {
    heading(t('Backup imported'), result.from?.computer ? t('From {computer}.', { computer: result.from.computer }) : '');
    content.replaceChildren();
    const list = node('ul', undefined, 'backup-results');
    for (const item of result.workspaces) {
      const entry = node('li'), lines = [];
      entry.append(node('strong', item.name));
      lines.push(item.created ? t('Added as a new workspace.') : t('Added to the workspace already here.'));
      if (item.added) lines.push(tn(item.added, '1 conversation added.', '{count} conversations added.'));
      if (item.updated) lines.push(tn(item.updated, '1 conversation brought up to date.', '{count} conversations brought up to date.'));
      if (item.replaced) lines.push(tn(item.replaced, '1 conversation replaced by the backup’s; this computer’s copy is kept.', '{count} conversations replaced by the backup’s; this computer’s copies are kept.'));
      if (item.kept) lines.push(tn(item.kept, '1 conversation here was kept as it is.', '{count} conversations here were kept as they are.'));
      if (item.previous) lines.push(t('Its own conversation stays current; the moved one is under Previous conversations.'));
      if (item.skippedFolders.length) lines.push(t('Left out: {folders}.', { folders: item.skippedFolders.join(', ') }));
      if (item.skippedCheckpoints) lines.push(tn(item.skippedCheckpoints, 'Checkpoints for 1 folder were left out, as it already has its own here.', 'Checkpoints for {count} folders were left out, as they already have their own here.'));
      entry.append(node('span', ' ' + lines.join(' ')));
      list.append(entry);
    }
    if (result.workspaces.length) content.append(list);
    if (result.settings?.length) { const names = SETTING_NAMES(); content.append(node('p', t('Settings brought over: {list}.', { list: result.settings.map(key => names[key] || key).join(', ') }), 'backup-note')); }
    content.append(node('p', t('Sign in to your agents on this computer in Settings › Agents & accounts. Sign-ins never move.'), 'backup-note'));
    const first = result.workspaces[0];
    submit.textContent = result.workspaces.length === 1 && !$('setup-dialog')?.open ? t('Open {name}', { name: first.name }) : t('Done');
  }

  // Move, on the old computer: what goes, then the code to type on the new one and its request to allow.
  function renderSend() {
    heading(t('Move to another computer'), t('Sends your workspaces, their conversations, memory, skills, board cards and tasks, and your settings straight to another computer on this network. Nothing goes through a server, and nothing here is deleted.'));
    submit.textContent = t('Start'); content.replaceChildren();
    if (!summary) { content.append(node('p', t('Reading your workspaces…'), 'backup-note')); return; }
    const [list, extras, size] = choiceFields();
    content.append(list, extras, size, node('p', t('Both computers need to be on the same Wi-Fi or network. Otherwise, use Export Codeshi Backup and copy the file.'), 'backup-note'), staysHere());
    total();
  }
  async function runSend() {
    if (!exportChoice.workspaces.size && !exportChoice.settings) throw new Error(t('Choose at least one workspace, or settings.'));
    setBusy(true, t('Encrypting…'));
    try { sendState = await api().post('/api/move/send', { workspaces: [...exportChoice.workspaces].map(id => ({ id, checkpoints: exportChoice.checkpoints })), settings: exportChoice.settings }); }
    finally { setBusy(false); }
    screen = 'sending'; drawn = ''; render(); poll();
  }
  const codeBlock = code => { const value = node('p', code, 'move-code'); value.setAttribute('aria-label', t('Move code: {code}', { code: code.split('').join(' ') })); return value; };
  function renderSending() {
    const state = sendState?.state || 'idle', requests = sendState?.requests || [];
    // Redrawn only when something you can act on changes, so a focused Allow button keeps its focus.
    const key = JSON.stringify([state, requests.map(item => [item.id, item.state]), sendState?.error]);
    const progress = $('move-progress');
    if (progress && state === 'sending') progress.textContent = t('Sending: {sent} of {size}', { sent: bytes(sendState.sent || 0), size: bytes(sendState.bytes || 0) });
    if (key === drawn && content.childElementCount) return;
    drawn = key; content.replaceChildren(); submit.hidden = false;
    const allowed = requests.find(item => item.state === 'allowed');
    if (state === 'waiting' || state === 'sending') {
      heading(t('Move to another computer'), t('Ready to send {size}. Open until {time}.', { size: bytes(sendState.bytes), time: new Date(sendState.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }));
      submit.hidden = true; cancel.textContent = t('Stop');
      if (state === 'sending') {
        content.append(node('p', t('Sending to {computer}. Keep both computers awake and Codeshi open until it finishes.', { computer: allowed?.computer || t('the other computer') }), 'backup-lead'));
        const line = node('p', t('Sending: {sent} of {size}', { sent: bytes(sendState.sent || 0), size: bytes(sendState.bytes || 0) }), 'backup-note'); line.id = 'move-progress'; content.append(line);
        return;
      }
      content.append(node('p', t('On the other computer, choose File › Receive from Another Computer… and type this code:'), 'backup-lead'), codeBlock(sendState.codes[0]));
      if (sendState.codes.length > 1) { const more = node('details', undefined, 'backup-details'); more.append(node('summary', t('Other addresses of this computer')), node('p', t('If the code above doesn’t connect, try one of these.'), 'backup-note'), ...sendState.codes.slice(1).map(codeBlock)); content.append(more); }
      const pending = requests.filter(item => item.state === 'pending');
      if (allowed) content.append(node('p', t('Allowed {computer}. Waiting for it to start receiving…', { computer: allowed.computer }), 'backup-note'));
      else if (!pending.length) content.append(node('p', t('Waiting for the other computer… If this computer asks whether Codeshi may accept incoming connections, choose Allow.'), 'backup-note'));
      for (const item of pending) {
        const row = node('section', undefined, 'move-request');
        row.append(node('p', t('{computer} wants to receive this move. Allow it only if that computer shows these digits:', { computer: item.computer }), 'backup-lead'), node('p', item.check.replace(/(\d{3})(\d{3})/, '$1 $2'), 'move-check'));
        const actions = node('div', undefined, 'move-actions'), deny = node('button', t('Deny'), 'secondary-button'), allow = node('button', t('Allow'), 'primary-button');
        deny.type = allow.type = 'button';
        deny.addEventListener('click', () => answer('deny', item.id)); allow.addEventListener('click', () => answer('allow', item.id));
        actions.append(deny, allow); row.append(actions); content.append(row);
      }
      if (pending.length) content.querySelector('.move-request .primary-button')?.focus();
      return;
    }
    cancel.textContent = t('Close');
    if (state === 'sent') {
      heading(t('Moved'), '');
      submit.textContent = t('Done');
      content.append(node('p', t('Sent {size} to {computer}. Finish there: choose where each workspace’s folders are.', { size: bytes(sendState.bytes), computer: allowed?.computer || t('the other computer') }), 'backup-lead'), node('p', t('Nothing on this computer was changed or deleted.'), 'backup-note'));
      return;
    }
    heading(t('Move to another computer'), '');
    submit.textContent = t('Start again');
    content.append(node('p', state === 'expired' ? t('The move was open for 15 minutes and has closed. Nothing was sent.') : sendState?.error || t('The move was stopped. Nothing was sent.'), 'backup-lead'));
  }
  async function answer(kind, id) {
    try { sendState = await api().post(`/api/move/send/${kind}`, { id }); renderSending(); }
    catch (failure) { showError(failure.message); }
  }

  // Move, on the new computer: type the code, compare the digits, then import what arrives as a backup file.
  function renderReceive() {
    heading(t('Receive from another computer'), t('Brings workspaces, conversations and settings from Codeshi on another computer on this network. Nothing here is deleted, and a conversation that also changed here is replaced only if you choose.'));
    submit.textContent = t('Connect'); content.replaceChildren();
    const wrap = node('div', undefined, 'backup-field'), label = node('label', t('Move code'), 'brief-label'), input = node('input');
    label.htmlFor = input.id = 'move-code-input'; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = '192.168.1.20:52143/7KQM-2XHD-9PTA-W3CZ'; input.className = 'move-code-input';
    wrap.append(label, input);
    content.append(node('p', t('On the old computer, choose File › Move to Another Computer… It shows a move code to type here.'), 'backup-note'), wrap);
  }
  async function runReceive() {
    const code = $('move-code-input').value.trim();
    if (!code) throw new Error(t('Type the move code shown on the other computer.'));
    setBusy(true, t('Connecting…'));
    try { receiveState = await api().post('/api/move/receive', { code }); }
    finally { setBusy(false); }
    screen = 'receiving'; drawn = ''; render(); poll();
  }
  function renderReceiving() {
    const state = receiveState?.state || 'idle', progress = $('move-progress');
    if (progress && state === 'receiving') progress.textContent = t('Receiving: {received} of {size}', { received: bytes(receiveState.received || 0), size: bytes(receiveState.bytes || 0) });
    const key = JSON.stringify([state, receiveState?.error]);
    if (key === drawn && content.childElementCount) return;
    drawn = key; content.replaceChildren(); submit.hidden = false;
    heading(t('Receive from another computer'), receiveState?.computer ? t('From {computer}, {size}.', { computer: receiveState.computer, size: bytes(receiveState.bytes) }) : '');
    if (state === 'asking' || state === 'connecting') {
      submit.hidden = true; cancel.textContent = t('Stop');
      content.append(node('p', t('Check that {computer} shows these digits, then choose Allow there:', { computer: receiveState.computer || t('the other computer') }), 'backup-lead'), node('p', receiveState.check.replace(/(\d{3})(\d{3})/, '$1 $2'), 'move-check'));
      content.append(node('p', t('If the digits are different, choose Deny there: another computer is asking.'), 'backup-note'));
      return;
    }
    if (state === 'receiving' || state === 'ready') {
      submit.hidden = true; cancel.textContent = t('Stop');
      const line = node('p', t('Receiving: {received} of {size}', { received: bytes(receiveState.received || 0), size: bytes(receiveState.bytes || 0) }), 'backup-lead'); line.id = 'move-progress';
      content.append(line, node('p', t('Keep both computers awake and Codeshi open until it finishes.'), 'backup-note'));
      return;
    }
    cancel.textContent = t('Close'); submit.textContent = t('Try again');
    content.append(node('p', state === 'denied' ? t('The other computer chose Deny. Nothing was received.') : receiveState?.error || t('The move stopped. Nothing was imported.'), 'backup-lead'));
  }
  // Once the backup has arrived, it opens as a file would, and the usual import screens follow.
  async function openReceived() {
    const arrived = receiveState; stopPolling();
    setBusy(true, t('Opening…'));
    try { opened = await api().post('/api/backup/read', { path: arrived.path, passphrase: arrived.passphrase }); }
    catch (failure) { setBusy(false); receiveState = { ...arrived, state: 'failed', error: failure.message }; drawn = ''; render(); return; }
    setBusy(false);
    received = true; file = arrived.path; passphrase = arrived.passphrase; decisions = {}; conflicts = [];
    choices = Object.fromEntries(opened.workspaces.map(workspace => [workspace.key, { include: true, folders: Object.fromEntries(workspace.folders.map(folder => [folder.id, folder.suggestion ? { kind: 'suggested', path: folder.suggestion.path } : folder.repository ? { kind: 'clone' } : { kind: 'path', path: '' }])) }]));
    includeSettings = Boolean(opened.settings?.length) && !opened.hasWorkspaces;
    screen = 'map'; render(); focusFirst();
  }

  // One check a second while a move is open, only while this dialog shows it.
  function stopPolling() { clearTimeout(polling); polling = null; }
  function poll() {
    stopPolling();
    const sending = screen === 'sending', path = sending ? '/api/move/send' : '/api/move/receive';
    if (!dialog.open || !['sending', 'receiving'].includes(screen)) return;
    polling = setTimeout(async () => {
      try {
        const value = await api().api(path);
        if (sending) sendState = value; else receiveState = value;
        if (screen === 'sending' && sending) renderSending();
        else if (screen === 'receiving' && !sending) { if (value.state === 'ready') { await openReceived(); return; } renderReceiving(); }
        if (['waiting', 'sending', 'asking', 'connecting', 'receiving'].includes(value.state)) poll();
      } catch { poll(); }
    }, 1000);
  }
  // Leaving a move screen stops the move, so a listener never stays open behind a closed dialog.
  function stopMove() {
    stopPolling();
    if (screen === 'sending' && ['waiting', 'sending'].includes(sendState?.state)) api().post('/api/move/send/stop', {}).catch(() => {});
    if (screen === 'receiving' || received) { received = false; api().post('/api/move/receive/stop', {}).catch(() => {}); }
  }

  const RENDER = { export: renderExport, exported: renderExported, open: renderOpen, map: renderMap, conflicts: renderConflicts, done: renderDone, send: renderSend, sending: renderSending, receive: renderReceive, receiving: renderReceiving };
  function render() { showError(''); submit.hidden = false; cancel.textContent = ['done', 'exported'].includes(screen) ? t('Close') : t('Cancel'); RENDER[screen](); }

  $('backup-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    if (screen === 'exported') { dialog.close(); return; }
    if (screen === 'sending') { if (sendState?.state === 'sent') { dialog.close(); return; } screen = 'send'; render(); focusFirst(); return; }
    if (screen === 'receiving') { stopMove(); screen = 'receive'; render(); focusFirst(); return; }
    if (screen === 'done') { const only = result.workspaces.length === 1 && !$('setup-dialog')?.open ? result.workspaces[0] : null; dialog.close(); if (only) await api().selectProject?.(only.id); return; }
    try { if (screen === 'export') await runExport(); else if (screen === 'send') await runSend(); else if (screen === 'receive') await runReceive(); else if (screen === 'open') await runOpen(); else await runImport(); }
    catch (failure) { setBusy(false); showError(failure.message || t('This could not be done. Please try again.')); }
    if (dialog.open) focusFirst();
  });
  cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { stopMove(); sendState = null; receiveState = null; drawn = ''; submit.hidden = false; passphrase = ''; opened = null; result = null; conflicts = []; decisions = {}; content.replaceChildren(); if (reload) { reload = false; window.location.reload(); } });

  async function open(kind = 'export') {
    if (busy) return;
    if (dialog.open) dialog.close();
    window.relaySettings?.isOpen?.() && window.relaySettings.close();
    screen = { import: 'open', send: 'send', receive: 'receive' }[kind] || 'export'; file = ''; picked = ''; exported = null;
    render(); dialog.showModal();
    if (screen === 'export' || screen === 'send') {
      summary = null; render();
      try { summary = await api().api('/api/backup'); exportChoice = { workspaces: new Set(summary.workspaces.filter(item => !item.running).map(item => item.id)), checkpoints: false, settings: true }; render(); }
      catch (failure) { showError(failure.message); }
    }
    focusFirst();
  }
  window.relayBackup = { open };
})();

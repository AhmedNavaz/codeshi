(() => {
  'use strict';
  // From GitHub in New workspace (#159): your repositories through your gh login, then one click clones one (or opens
  // the copy already on this computer) and opens it as a workspace. The list is read when the tab opens, never in the
  // background, and nothing is pushed.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('project-panel');
  if (!api || !panel || !$('github-repos')) return;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const tabs = { folders: $('project-source-folders'), github: $('project-source-github') };
  const list = $('github-repos-list'), search = $('github-repos-search'), folder = $('github-clone-folder'), status = $('github-repos-status'), error = $('github-repos-error');
  const FOLDERS_TEXT = 'Add one or more project folders. Their files stay in their current locations.';
  const GITHUB_TEXT = 'Clone one of your repositories, or open the copy already on this computer, as a new workspace.';
  let loaded = null, loadedAt = 0, loading = null, busy = null, generation = 0;

  function ago(value) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time)) return '';
    const seconds = Math.round((time - Date.now()) / 1000), format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    return format.format(0, 'minute');
  }
  function showError(message) { error.textContent = message || ''; error.hidden = !message; }

  function select(source, { focus = false } = {}) {
    const github = source === 'github';
    for (const [name, tab] of Object.entries(tabs)) { const on = name === source; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; }
    $('github-repos').hidden = !github; $('project-form').hidden = github;
    $('project-panel-alternative').hidden = github; if (github) $('project-error').hidden = true;
    $('project-panel-description').textContent = github ? GITHUB_TEXT : FOLDERS_TEXT;
    if (focus) tabs[source].focus();
    if (github) load();
  }

  function row(repo) {
    const item = el('div', undefined, 'github-repo'); item.setAttribute('role', 'listitem');
    const button = el('button', undefined, 'github-repo-button'); button.type = 'button'; button.dataset.repo = repo.fullName;
    const [owner, name] = repo.fullName.split('/');
    const title = el('span', undefined, 'github-repo-title');
    title.append(el('span', `${owner}/`, 'github-repo-owner'), el('span', name, 'github-repo-name'));
    for (const [on, text] of [[repo.private, 'Private'], [repo.fork, 'Fork'], [repo.archived, 'Archived']]) if (on) title.append(el('span', text, 'github-repo-badge'));
    const meta = el('span', repo.local ? 'Open' : ago(repo.pushedAt), repo.local ? 'github-repo-open' : 'github-repo-time');
    button.append(title, meta);
    if (repo.description) button.append(el('span', repo.description, 'github-repo-description'));
    button.title = repo.local ? `Already on this computer: ${repo.local}` : `Clone ${repo.fullName} into ${folder.value.trim() || folder.placeholder}`;
    button.setAttribute('aria-label', [repo.fullName, repo.private && 'private', repo.fork && 'fork', repo.archived && 'archived', repo.local ? 'already on this computer, opens it' : `pushed ${ago(repo.pushedAt)}`, repo.description].filter(Boolean).join(', '));
    button.addEventListener('click', () => open(repo, button));
    item.append(button);
    return item;
  }
  function render() {
    list.replaceChildren();
    if (!loaded) return;
    const query = search.value.trim().toLowerCase();
    const repos = loaded.repos.filter(repo => !query || repo.fullName.toLowerCase().includes(query) || repo.description.toLowerCase().includes(query));
    if (!repos.length) list.append(el('p', query ? `No repositories match “${search.value.trim()}”.` : 'Your gh login can’t see any repositories yet.', 'github-repos-empty'));
    else list.append(...repos.slice(0, 200).map(row));
    const total = loaded.repos.length, shown = Math.min(repos.length, 200);
    status.textContent = `${query ? `${shown} of ${total}` : total} ${total === 1 ? 'repository' : 'repositories'} · signed in to gh as ${loaded.account.login}${loaded.more ? ' · showing the 500 most recently pushed' : ''}`;
  }
  async function load(force = false) {
    if (loading || busy) return loading;
    if (loaded && !force && Date.now() - loadedAt < 5 * 60 * 1000) { render(); return; }
    const run = ++generation;
    showError(''); status.textContent = 'Reading your repositories through gh…'; list.setAttribute('aria-busy', 'true'); search.disabled = true;
    loading = api.api('/api/github/repos').then(data => {
      if (run !== generation) return;
      loaded = data; loadedAt = Date.now();
      if (!folder.value.trim()) folder.value = data.cloneFolder || data.suggestedFolder || '';
      search.disabled = false; render();
    }).catch(failure => {
      if (run !== generation) return;
      loaded = null; list.replaceChildren(); status.textContent = ''; showError(failure.message);
    }).finally(() => { loading = null; list.setAttribute('aria-busy', 'false'); });
    return loading;
  }
  function controls(disabled) {
    for (const node of [search, folder, $('github-clone-pick'), tabs.folders, tabs.github, ...list.querySelectorAll('button')]) node.disabled = disabled;
    $('github-repos').setAttribute('aria-busy', String(disabled));
  }
  async function open(repo, button) {
    if (busy) return;
    const target = folder.value.trim();
    if (!repo.local && !target) { showError('Choose a folder to clone into.'); folder.focus(); return; }
    busy = repo.fullName; showError(''); controls(true); button.classList.add('busy');
    const meta = button.querySelector('.github-repo-open, .github-repo-time'); if (meta) meta.textContent = repo.local ? 'Opening…' : 'Cloning…';
    status.textContent = repo.local ? `Opening ${repo.fullName}…` : `Cloning ${repo.fullName}… A large repository can take a few minutes.`;
    try {
      const result = await api.post('/api/github/clone', { repository: repo.fullName, ...(repo.local ? {} : { cloneFolder: target }) }, null);
      loaded = null; busy = null; controls(false);
      if (result.cloneFolder) folder.value = result.cloneFolder;
      await api.refreshProjects().catch(() => {});
      await api.selectProject(result.project.id);
      // Choosing the workspace that is already open changes nothing, so the panel is closed here as well.
      if (!panel.hidden) { panel.hidden = true; $('add-project')?.setAttribute('aria-expanded', 'false'); $('message-input')?.focus(); }
      api.announce(result.cloned ? `Cloned ${repo.fullName} into ${result.path} and opened it.` : `Opened ${repo.fullName} from ${result.path}.`);
    } catch (failure) {
      busy = null; controls(false); button.classList.remove('busy');
      if (meta) meta.textContent = repo.local ? 'Open' : ago(repo.pushedAt);
      render(); showError(failure.message);
      list.querySelector(`[data-repo="${CSS.escape(repo.fullName)}"]`)?.focus();
    }
  }

  // The two tabs move with the arrow keys, Home and End, as the other tab rows do.
  for (const [name, tab] of Object.entries(tabs)) {
    tab.addEventListener('click', () => select(name));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      select(event.key === 'Home' ? 'folders' : event.key === 'End' ? 'github' : name === 'folders' ? 'github' : 'folders', { focus: true });
    });
  }
  search.addEventListener('input', render);
  search.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('button')?.focus(); } });
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...list.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) { search.focus(); return; }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  });
  if (window.relayDesktop?.pickFolder) {
    $('github-clone-pick').hidden = false;
    $('github-clone-pick').addEventListener('click', async () => {
      try { const picked = await window.relayDesktop.pickFolder(); const chosen = Array.isArray(picked) ? picked[0] : picked; if (chosen) { folder.value = chosen; render(); } }
      catch (failure) { showError(failure.message); }
    });
  }
  folder.addEventListener('change', render);
  // The panel opens on Folders each time; the list is read again if it is older than five minutes.
  new MutationObserver(() => { if (panel.hidden && !busy) select('folders'); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
})();

(() => {
  'use strict';
  // Skills (#86), under the Brief panel: procedures any agent can follow, used by typing /name in a prompt or when a task
  // clearly matches. The panel lists what is enabled; Add skills opens everything found, which only reads descriptions.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('brief-panel'), list = $('skills-list');
  if (!api || !list || !panel) return;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'text-link') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const conversation = () => api.getState().conversation;
  const SOURCE = { starter: 'Starter', repository: 'This repository', folder: 'Your folder', memory: 'From memory' };
  let view = null, shown = null, fromEntry = null;

  async function change(input) {
    const c = conversation();
    if (!c) return null;
    const result = await api.post(`/api/conversations/${c.id}/skills`, input);
    if (!input.action.startsWith('preview')) { view = result; render(); window.relayBrief?.reload?.(); }
    return result;
  }
  const act = input => change(input).catch(error => api.showNotice(error.message));
  function notes(skill) {
    const host = node('div', 'panel-row-meta skill-notes');
    for (const item of skill.compatibility?.unavailable || []) host.append(node('span', item.blocking ? 'bad' : '', item.detail));
    return host;
  }
  function renderEnabled(skill) {
    const row = node('li', `panel-row${skill.enabled ? '' : ' off'}`), title = node('div', 'panel-row-title');
    const toggle = node('button', 'mini-switch'); toggle.type = 'button'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(skill.enabled)); toggle.setAttribute('aria-label', `${skill.name} ${skill.enabled ? 'on' : 'off'}`); toggle.title = skill.enabled ? 'Turn off' : 'Turn on';
    toggle.addEventListener('click', () => act({ action: skill.enabled ? 'disable' : 'restore', name: skill.name }));
    title.append(node('code', 'skill-name', `/${skill.name}`), toggle);
    const description = node('div', 'panel-row-text clamp', skill.description);
    const meta = node('div', 'panel-row-meta');
    // A description longer than two lines can be opened in place, so the full text is always one click away.
    if (skill.description.length > 110) { const more = node('button', 'panel-row-more', 'More'); more.type = 'button'; more.setAttribute('aria-expanded', 'false'); more.addEventListener('click', () => { const open = !description.classList.contains('expanded'); description.classList.toggle('expanded', open); more.textContent = open ? 'Less' : 'More'; more.setAttribute('aria-expanded', String(open)); }); meta.append(more); }
    meta.append(node('span', '', [SOURCE[skill.sourceKind] || skill.sourceLabel, skill.version.slice(0, 7), skill.license, skill.pinned ? 'Pinned' : null, skill.sourceMissing ? 'Source folder gone' : null].filter(Boolean).join(' · ')));
    if (skill.updateAvailable) meta.append(node('span', 'ok', 'Update available'));
    const actions = node('span', 'panel-row-actions');
    if (skill.updateAvailable) actions.append(button('See update', async () => {
      try {
        const preview = await change({ action: 'preview-update', name: skill.name });
        row.querySelector('.skill-diff')?.remove();
        const block = node('div', 'skill-diff');
        block.append(node('p', 'panel-muted', `From ${preview.source}. Your own files aren't changed.`), node('pre', '', preview.diff || 'No differences in its text.'), button('Use this version', () => act({ action: 'update', path: skill.sourcePath, acceptPartial: true })));
        row.append(block);
      } catch (error) { api.showNotice(error.message); }
    }));
    actions.append(button(skill.pinned ? 'Unpin' : 'Pin', () => act({ action: skill.pinned ? 'unpin' : 'pin', name: skill.name })), button('Remove', () => act({ action: 'remove', name: skill.name })));
    meta.append(actions);
    row.append(title, description, meta, notes(skill));
    return row;
  }
  function renderAvailable(skill) {
    const row = node('li', 'panel-row');
    const title = node('div', 'panel-row-title'); title.append(node('code', 'skill-name', skill.name));
    row.append(title);
    if (skill.problems?.length) { row.append(node('div', 'panel-row-meta bad', `Can't be used: ${skill.problems.join('; ')}`)); return row; }
    // The whole description shows here: this is where a skill is chosen.
    const blocking = skill.compatibility?.blocking;
    title.append(button(blocking ? 'Enable as instructions only' : 'Enable', () => act({ action: 'enable', path: skill.path, ...(blocking ? { acceptPartial: true } : {}) }), 'secondary-button'));
    row.append(node('div', 'panel-row-text', skill.description), node('div', 'panel-row-meta', [skill.license, skill.conflict ? 'Same name as another skill' : null].filter(Boolean).join(' · ')), notes(skill));
    return row;
  }
  function render() {
    const enabled = view?.enabled || [], on = enabled.filter(skill => skill.enabled);
    $('skills-empty').hidden = enabled.length > 0;
    $('skills-count').hidden = !on.length; $('skills-count').textContent = String(on.length);
    list.replaceChildren(...enabled.map(renderEnabled));
    renderAvailable_();
  }
  // Everything found, grouped by where it comes from, in the Add skills dialog.
  function renderAvailable_() {
    const available = view?.available || [], host = $('skills-available'), groups = [['starter', 'Starter set, from Codeshi'], ['repository', 'In this repository'], ['folder', 'From your folders']];
    host.replaceChildren();
    for (const [kind, title] of groups) {
      const items = available.filter(item => item.source.kind === kind);
      if (!items.length) continue;
      const group = node('section', 'panel-group'); group.append(node('h4', 'panel-group-title', title));
      const list = node('ul', 'panel-list'); list.append(...items.map(renderAvailable)); group.append(list); host.append(group);
    }
    $('skills-available-empty').hidden = available.length > 0;
    $('skills-folders').replaceChildren(...(view?.dirs || []).map(folder => { const row = node('li', 'skill-folder'); row.append(node('span', '', folder), button('Remove', () => act({ action: 'remove-folder', path: folder }))); return row; }));
    $('skills-add-folder').hidden = !window.relayDesktop?.pickFolder;
  }
  const scope = () => { const state = api.getState(), c = state.conversation; return c ? `${state.projectId}:${c.id}` : null; };
  async function load(force = false) {
    const key = scope();
    if (panel.hidden || !key || (!force && key === shown)) return;
    shown = key;
    try { view = await api.api('/api/skills'); render(); } catch { shown = null; }
  }
  $('skills-add').addEventListener('click', async () => { await load(true); $('skills-add-dialog').showModal(); });
  $('skills-add-close').addEventListener('click', () => $('skills-add-dialog').close());
  $('skills-add-folder').addEventListener('click', async () => {
    const folder = await window.relayDesktop.pickFolder().catch(() => null);
    if (folder) act({ action: 'add-folder', path: folder });
  });
  // From a memory entry. The person reads and edits it here, and only saving makes it a skill.
  function fromMemory(entry) {
    fromEntry = entry;
    $('skill-name').value = entry.text.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 4).join('-').slice(0, 64) || '';
    $('skill-description').value = entry.text.split('\n')[0].slice(0, 300);
    $('skill-body').value = entry.text;
    $('skill-source').textContent = `Saved from a memory${entry.source?.commit ? ` at ${entry.source.commit}` : ''}. Check that it holds in general before saving it.`;
    $('skill-error').hidden = true;
    $('skill-dialog').showModal();
  }
  $('skill-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { await change({ action: 'from-memory', entryId: fromEntry?.id, name: $('skill-name').value.trim(), description: $('skill-description').value, body: $('skill-body').value }); $('skill-dialog').close(); }
    catch (error) { $('skill-error').textContent = error.message; $('skill-error').hidden = false; }
  });
  $('skill-cancel').addEventListener('click', () => $('skill-dialog').close());
  window.addEventListener('relay-state', () => load());
  window.addEventListener('relay-side-panel', () => load(true));
  window.relaySkills = { fromMemory, load };
})();

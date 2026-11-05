(() => {
  'use strict';
  // Memory (#21), under the Brief panel: what every agent in this workspace should keep knowing. Nothing enters without the
  // person choosing it, with Remember on a message or step, Add here, or Keep on a suggestion made by local rules.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('brief-panel'), list = $('memory-list'), dialog = $('memory-dialog');
  if (!api || !list || !dialog || !panel) return;
  const KINDS = { convention: 'Convention', decision: 'Decision', solution: 'Working fix', 'failed-approach': 'Failed approach' };
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'text-link') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const conversation = () => api.getState().conversation;
  const foldersOf = () => { const state = api.getState(); return state.projects?.find(project => project.id === state.projectId)?.folders || []; };
  let view = null, editing = null, shown = null;

  async function change(input) {
    const c = conversation();
    if (!c) return null;
    view = await api.post(`/api/conversations/${c.id}/memory`, input);
    render();
    window.relayBrief?.reload?.();
    return view;
  }
  const act = input => change(input).catch(error => api.showNotice(error.message));

  const kind = entry => { const dot = node('span', 'kind-dot'); dot.dataset.kind = entry.kind; dot.setAttribute('aria-hidden', 'true'); return dot; };
  function renderEntry(entry) {
    const row = node('li', `panel-row${entry.status === 'retired' ? ' retired' : ''}`), folder = foldersOf().find(item => item.id === entry.folderId);
    const title = node('div', 'panel-row-title'); title.append(kind(entry), node('span', 'panel-row-text', entry.text));
    const meta = node('div', 'panel-row-meta');
    meta.append(node('span', '', [KINDS[entry.kind], folder?.displayName || folder?.name, entry.source?.commit].filter(Boolean).join(' · ')));
    if (entry.needsRecheck && entry.status !== 'retired') { const flag = node('span', 'bad', 'Needs recheck'); flag.title = entry.changedFiles?.length ? `Changed since this was saved: ${entry.changedFiles.join(', ')}` : 'Its folder is no longer in this workspace.'; meta.append(flag); }
    const actions = node('span', 'panel-row-actions');
    actions.append(button('Edit', () => open(entry)));
    if (window.relaySkills && entry.status === 'active') actions.append(button('Make a skill', () => window.relaySkills.fromMemory(entry)));
    // Deleting takes two steps, through Retire, and retiring can be undone.
    if (entry.status === 'retired') actions.append(button('Restore', () => act({ action: 'restore', id: entry.id })), button('Delete', () => act({ action: 'remove', id: entry.id })));
    else actions.append(button('Retire', () => act({ action: 'retire', id: entry.id })));
    meta.append(actions);
    row.append(title, meta);
    return row;
  }
  function renderSuggestion(item) {
    const row = node('li', 'panel-row suggestion'), title = node('div', 'panel-row-title');
    title.append(kind(item), node('span', 'panel-row-text', item.text));
    const actions = node('span', 'panel-row-actions always'), meta = node('div', 'panel-row-meta', `Suggested ${(KINDS[item.kind] || '').toLowerCase()}`);
    actions.append(button('Keep', () => act({ action: 'add', kind: item.kind, text: item.text, folderId: item.folderId, messageId: item.messageId, runId: item.runId, suggested: true })), button('Dismiss', () => act({ action: 'dismiss', key: item.key })));
    meta.append(actions);
    row.append(title, meta);
    return row;
  }
  function render() {
    const entries = view?.entries || [], suggestions = view?.suggestions || [], active = entries.filter(entry => entry.status === 'active');
    $('memory-empty').hidden = entries.length > 0 || suggestions.length > 0;
    $('memory-count').hidden = !active.length; $('memory-count').textContent = String(active.length);
    $('memory-suggested').hidden = !suggestions.length;
    $('memory-suggestions').replaceChildren(...suggestions.map(renderSuggestion));
    list.replaceChildren(...[...active, ...entries.filter(entry => entry.status !== 'active')].map(renderEntry));
    $('memory-export').hidden = !entries.length;
    window.relayBrief?.rerender?.();
  }
  const scope = () => { const state = api.getState(), c = state.conversation; return c ? `${state.projectId}:${c.id}:${c.lastRun?.id || ''}:${c.status}` : null; };
  async function load() {
    const key = scope();
    if (panel.hidden || !key || key === shown) return;
    shown = key;
    try { view = await api.api('/api/memory'); render(); } catch { shown = null; }
  }

  function open(entry = null, prefill = {}) {
    editing = entry;
    $('memory-dialog-title').textContent = entry ? 'Edit this memory' : 'Remember this';
    $('memory-text').value = entry?.text || prefill.text || '';
    $('memory-kind').value = entry?.kind || prefill.kind || 'convention';
    const folders = foldersOf(), select = $('memory-folder');
    select.replaceChildren(node('option', '', 'All folders'), ...folders.map(folder => { const option = node('option', '', folder.displayName || folder.name); option.value = folder.id; return option; }));
    select.firstChild.value = '';
    select.value = entry?.folderId || prefill.folderId || '';
    $('memory-folder-row').hidden = folders.length < 2;
    $('memory-error').hidden = true;
    dialog.prefill = prefill;
    dialog.showModal();
    $('memory-text').focus?.();
  }
  // What was selected in the message, if anything, since that is usually the part worth keeping.
  function remember({ text = '', messageId = null, runId = null, host = null }) {
    const selected = String(window.getSelection?.() || '').trim(), inside = selected && host?.contains?.(window.getSelection().anchorNode);
    open(null, { text: (inside ? selected : text).slice(0, 2000), messageId, runId });
  }
  $('memory-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = { kind: $('memory-kind').value, text: $('memory-text').value, folderId: $('memory-folder').value || null };
    try {
      await change(editing ? { action: 'edit', id: editing.id, ...input } : { action: 'add', ...input, messageId: dialog.prefill?.messageId, runId: dialog.prefill?.runId });
      dialog.close();
      if (!panel.hidden) load();
    } catch (error) { $('memory-error').textContent = error.message; $('memory-error').hidden = false; }
  });
  $('memory-cancel').addEventListener('click', () => dialog.close());
  $('memory-add').addEventListener('click', () => open());
  $('memory-export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(view?.entries || [], null, 2)], { type: 'application/json' })), link = document.createElement('a');
    link.href = url; link.download = 'codeshi-project-memory.json'; document.body?.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener('relay-state', load);
  window.addEventListener('relay-side-panel', load);
  window.relayMemory = { remember, open, activeCount: () => view ? view.entries.filter(entry => entry.status === 'active').length : null };
})();

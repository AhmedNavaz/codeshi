(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI;
  const strip = $('main-tabs'), list = $('main-tool-tabs'), area = $('main-work-area');
  if (!api || !strip || !list || !area) return;
  const KEY = 'throughline:work-tabs:v1', workspaces = new Map();
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* Optional layout. */ }
  const project = () => api.getState().projectId;
  const normal = () => !['flow', 'plan'].includes(window.relayFlow?.view?.());
  const node = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  let serial = 0, dragged = null, dragging = null, rendering = false;
  function workspace(id = project()) {
    if (!workspaces.has(id)) {
      const old = saved[id] || {};
      workspaces.set(id, { entries: new Map(), order: [], savedOrder: Array.isArray(old.tabs) ? old.tabs.map(t => t.id) : [], active: old.active || 'chat', beside: old.beside || null, focused: 'chat', ratio: Math.max(25, Math.min(75, Number(old.ratio) || 50)) });
    }
    return workspaces.get(id);
  }
  function persist(id = project()) {
    if (!id) return;
    const ws = workspace(id), previous = Array.isArray(saved[id]?.tabs) ? saved[id].tabs : [];
    // Modules restore asynchronously. Keep descriptors and original order until the person reorders tabs.
    const seen = new Set(), tabs = [];
    const currentOf = key => { const e = ws.entries.get(key); return { id: e.id, title: e.title, ...(e.customTitle ? { customTitle: e.customTitle } : {}), kind: e.kind, restore: e.restore }; };
    if (ws.savedOrder.length) for (const old of previous) { if (ws.removed?.has(old.id) || seen.has(old.id)) continue; seen.add(old.id); tabs.push(ws.entries.has(old.id) ? currentOf(old.id) : old); }
    for (const key of ws.order) if (!seen.has(key)) { seen.add(key); tabs.push(currentOf(key)); }
    for (const old of previous) if (!seen.has(old.id) && !ws.removed?.has(old.id)) { seen.add(old.id); tabs.push(old); }
    saved[id] = { tabs: tabs.slice(0, 60), active: ws.active, beside: ws.beside, ratio: ws.ratio };
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* Tabs still work without storage. */ }
  }
  const isVisible = (id, projectId = project()) => projectId === project() && normal() && (workspace(projectId).active === id || workspace(projectId).beside === id && workspace(projectId).active === 'chat');
  function call(fn, ...args) { try { const result = fn?.(...args); result?.catch?.(error => api.showNotice?.(error.message)); } catch (error) { api.showNotice?.(error.message); } }
  function render() {
    if (rendering) return;
    rendering = true;
    try {
      const id = project(), ws = workspace(id), on = normal() && Boolean(id);
      const active = ws.entries.get(ws.active), beside = ws.active === 'chat' ? ws.entries.get(ws.beside) : null;
      strip.hidden = !on;
      $('chat-stage').hidden = on && Boolean(active);
      $('tab-primary').hidden = !on || !active;
      $('tab-beside').hidden = !on || !beside;
      area.classList.toggle('has-beside', on && Boolean(beside));
      area.style.setProperty('--chat-share', `${ws.ratio}%`);
      $('tab-divider').setAttribute('aria-valuenow', String(ws.ratio));
      $('tab-beside-title').textContent = beside?.title || '';
      $('main-tab-chat').setAttribute('aria-selected', String(!active));
      $('main-tab-chat').tabIndex = active ? -1 : 0;
      for (const [scope, other] of workspaces) for (const entry of other.entries.values()) {
        const front = on && scope === id && (entry === active || entry === beside);
        const host = front ? entry === beside ? $('tab-secondary') : $('tab-primary') : $('tab-parking');
        if (entry.element && entry.element.parentNode !== host) host.append(entry.element);
        if (entry.element) entry.element.hidden = !front;
        entry.button.setAttribute('aria-selected', String(scope === id && entry === active));
        entry.button.tabIndex = scope === id && entry === active ? 0 : -1;
        entry.row.hidden = scope !== id;
        entry.row.dataset.state = entry.state || 'stopped';
        entry.row.classList.toggle('tab-unread', Boolean(entry.unread));
        entry.row.classList.toggle('tab-in-split', scope === id && entry === beside);
        entry.marker.textContent = entry.state === 'failed' ? '!' : entry.state === 'finished' ? '✓' : entry.state === 'restart' ? '↻' : '•';
        entry.marker.setAttribute('aria-label', `${entry.state || 'stopped'}${entry.unread ? ', new output' : ''}`);
        entry.label.textContent = entry.title;
        entry.button.title = `${entry.title} · ${entry.state || 'stopped'}${entry.unread ? ' · New output' : ''}`;
        entry.besideButton?.setAttribute('aria-label', `Open ${entry.title} beside chat`);
        entry.closeButton?.setAttribute('aria-label', `Close ${entry.title}`);
      }
      for (const key of ws.order) list.append(ws.entries.get(key).row);
      $('main-tab-new').disabled = !id;
    } finally { rendering = false; }
    window.dispatchEvent(new CustomEvent('relay-tabs'));
  }
  function select(id, { projectId = project(), focus = true } = {}) {
    const ws = workspace(projectId), entry = ws.entries.get(id);
    if (id !== 'chat' && !entry) return false;
    ws.active = id; ws.focused = id;
    if (id !== 'chat') ws.beside = null;
    if (entry) entry.unread = false;
    persist(projectId); render();
    if (projectId === project() && normal()) {
      call(entry?.onSelect);
      if (focus && id === 'chat') $('message-input')?.focus();
    }
    return true;
  }
  function openBeside(id) {
    const ws = workspace(), entry = ws.entries.get(id);
    if (!entry) return;
    ws.active = 'chat'; ws.beside = id; ws.focused = id; entry.unread = false;
    persist(); render(); call(entry.onSelect);
  }
  function remove(id, { projectId = project() } = {}) {
    const ws = workspace(projectId), entry = ws.entries.get(id);
    if (!entry) return;
    entry.row.remove(); entry.element?.remove(); ws.entries.delete(id); ws.order = ws.order.filter(key => key !== id);
    (ws.removed ||= new Set()).add(id);
    if (ws.active === id) ws.active = 'chat';
    if (ws.beside === id) ws.beside = null;
    if (ws.focused === id) ws.focused = 'chat';
    persist(projectId); render();
  }
  async function close(id, projectId = project()) {
    const entry = workspace(projectId).entries.get(id);
    if (!entry || entry.closing) return false;
    entry.closing = true;
    try { if (await entry.onClose?.() === false) return false; remove(id, { projectId }); return true; }
    catch (error) { api.showNotice?.(`Could not close ${entry.title}. ${error.message}`); return false; }
    finally { entry.closing = false; }
  }
  function rename(entry) {
    const input = node('input', 'main-tab-name'); input.value = entry.title; input.maxLength = 60; input.setAttribute('aria-label', 'Tab name');
    entry.label.hidden = true; entry.button.append(input); input.focus(); input.select?.();
    let done = false;
    const finish = save => { if (done) return; done = true; const title = input.value.trim(); input.remove(); entry.label.hidden = false; if (save && title) { entry.customTitle = title; entry.title = title; call(entry.onRename, title); persist(entry.projectId); } render(); };
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finish(e.key === 'Enter'); } });
    input.addEventListener('blur', () => finish(true));
  }
  function move(id, before) {
    const ws = workspace(), at = ws.order.indexOf(id), target = ws.order.indexOf(before);
    if (at < 0 || target < 0 || at === target) return;
    ws.savedOrder = []; ws.order.splice(at, 1); ws.order.splice(target, 0, id); persist(); render();
  }
  function upsert(spec) {
    if (!spec?.id || !spec.projectId) return;
    const ws = workspace(spec.projectId);
    let entry = ws.entries.get(spec.id);
    if (!entry) {
      const oldTab = (saved[spec.projectId]?.tabs || []).find(t => t.id === spec.id);
      const customTitle = spec.customTitle || oldTab?.customTitle || '';
      entry = { ...spec, ...(customTitle ? { customTitle, title: customTitle } : {}), unread: false };
      const row = node('span', 'work-tab'), button = node('button', 'main-tab'), label = node('span', 'main-tab-label'), marker = node('span', 'main-tab-state');
      button.type = 'button'; button.id = `work-tab-${++serial}`; button.setAttribute('role', 'tab'); row.dataset.tabId = spec.id;
      button.append(marker, label); row.append(button);
      const beside = node('button', 'tab-action', '◧'); beside.type = 'button'; beside.title = 'Open beside chat'; beside.setAttribute('aria-label', `Open ${entry.title} beside chat`);
      beside.addEventListener('click', () => openBeside(entry.id));
      const end = node('button', 'tab-action', '×'); end.type = 'button'; end.title = 'Close tab'; end.setAttribute('aria-label', `Close ${entry.title}`);
      end.addEventListener('click', () => close(entry.id, entry.projectId)); row.append(beside, end);
      button.addEventListener('click', () => select(entry.id)); button.addEventListener('dblclick', () => rename(entry));
      button.draggable = true;
      button.addEventListener('dragstart', e => { dragged = entry.id; e.dataTransfer?.setData('text/plain', entry.id); });
      button.addEventListener('dragend', () => { dragged = null; area.classList.remove('tab-drop-beside'); });
      row.addEventListener('dragover', e => { if (dragged) e.preventDefault(); });
      row.addEventListener('drop', e => { if (dragged) { e.preventDefault(); move(dragged, entry.id); dragged = null; } });
      button.addEventListener('keydown', e => { if (e.key === 'F2') { e.preventDefault(); rename(entry); } if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); const next = ws.order[ws.order.indexOf(entry.id) + (e.key === 'ArrowRight' ? 1 : -1)]; if (next) move(entry.id, next); button.focus(); } });
      Object.assign(entry, { row, button, label, marker, besideButton: beside, closeButton: end }); ws.entries.set(spec.id, entry); ws.order.push(spec.id);
      if (ws.savedOrder.length) ws.order.sort((a, b) => (ws.savedOrder.includes(a) ? ws.savedOrder.indexOf(a) : 1000) - (ws.savedOrder.includes(b) ? ws.savedOrder.indexOf(b) : 1000));
    } else {
      const customTitle = spec.customTitle ?? entry.customTitle;
      Object.assign(entry, spec);
      if (customTitle) { entry.customTitle = customTitle; entry.title = customTitle; }
    }
    if (entry.element) {
      if (!entry.element.id) entry.element.id = `work-view-${entry.button.id}`;
      entry.button.setAttribute('aria-controls', entry.element.id);
      entry.element.setAttribute('role', 'tabpanel'); entry.element.setAttribute('aria-labelledby', entry.button.id);
    }
    persist(spec.projectId); render(); return entry;
  }
  function notify(id, projectId = project()) { const entry = workspace(projectId).entries.get(id); if (entry && !isVisible(id, projectId)) { entry.unread = true; render(); } }
  $('main-tab-chat').addEventListener('click', () => select('chat'));
  $('main-tab-new').addEventListener('click', () => window.relayTerminal?.new?.());
  $('tab-unsplit').addEventListener('click', () => { workspace().beside = null; select('chat'); });
  area.addEventListener('focusin', event => { const ws = workspace(); ws.focused = $('tab-secondary').contains(event.target) ? ws.beside : ws.active; });
  area.addEventListener('dragover', event => { if (!dragged) return; const rect = area.getBoundingClientRect(); const right = event.clientX > rect.right - Math.min(180, rect.width / 3); area.classList.toggle('tab-drop-beside', right); if (right) event.preventDefault(); });
  area.addEventListener('drop', event => { if (dragged && area.classList.contains('tab-drop-beside')) { event.preventDefault(); openBeside(dragged); dragged = null; area.classList.remove('tab-drop-beside'); } });
  const resize = value => { workspace().ratio = Math.max(25, Math.min(75, Math.round(value))); render(); };
  const divider = $('tab-divider');
  divider.addEventListener('pointerdown', event => { if (event.button !== 0) return; dragging = event.pointerId; divider.setPointerCapture?.(event.pointerId); event.preventDefault(); });
  divider.addEventListener('pointermove', event => { if (dragging === null || dragging !== event.pointerId) return; const rect = area.getBoundingClientRect(); resize((event.clientX - rect.left) / rect.width * 100); });
  const endResize = () => { if (dragging === null) return; dragging = null; persist(); };
  divider.addEventListener('pointerup', endResize); divider.addEventListener('pointercancel', endResize); divider.addEventListener('lostpointercapture', endResize); window.addEventListener('blur', endResize);
  divider.addEventListener('dblclick', () => { resize(50); persist(); });
  divider.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); resize(event.key === 'Home' ? 25 : event.key === 'End' ? 75 : workspace().ratio + (event.key === 'ArrowRight' ? 5 : -5)); persist(); });
  function cycle(direction) { const ws = workspace(), keys = ['chat', ...ws.order], index = keys.indexOf(ws.focused || ws.active); select(keys[(index + direction + keys.length) % keys.length]); }
  strip.addEventListener('keydown', event => { if (event.altKey || event.target?.tagName === 'INPUT' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); if (event.key === 'Home') select('chat'); else if (event.key === 'End') select(workspace().order.at(-1) || 'chat'); else cycle(event.key === 'ArrowRight' ? 1 : -1); (workspace().entries.get(workspace().active)?.button || $('main-tab-chat')).focus(); });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  document.addEventListener('keydown', event => {
    if (!normal() || !project() || document.querySelector('dialog[open]')) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); cycle(event.shiftKey ? -1 : 1); }
    if ((mac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
      const ws = workspace(), target = ws.focused !== 'chat' ? ws.focused : ws.active;
      if (target && target !== 'chat' && ws.entries.has(target)) { event.preventDefault(); event.stopPropagation(); close(target); }
    }
  }, true);
  let lastProject;
  window.addEventListener('relay-state', () => { if (lastProject === project()) return; lastProject = project(); render(); const ws = workspace(); call(ws.entries.get(ws.active === 'chat' ? ws.beside : ws.active)?.onSelect); });
  window.addEventListener('relay-flow', render);
  window.relayTabs = { upsert, select, remove, close, openBeside, notify, isVisible, isActive: (id, scope = project()) => scope === project() && workspace(scope).active === id, active: () => workspace().focused || workspace().active, showChat: () => select('chat'), getSaved: (id, kind) => (Array.isArray(saved[id]?.tabs) ? saved[id].tabs : []).filter(t => !kind || t.kind === kind).map(t => ({ ...t })), render };
  render();
})();

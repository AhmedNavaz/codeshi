// The task board (#132, first stage), full window, opened by Board beside Plan. A workspace's cards in five columns:
// Backlog and Ready are yours to fill and order (drag a card, or use the buttons in its drawer); Doing and Review follow the
// task a card started; Done is what you accepted. Selecting a card opens it in a drawer to edit and act on. Run Ready opens
// the same drawer with the Ready cards to choose from, and runs exactly the ones ticked.
// The Canvas view (#97) shows the same cards placed freely, with arrows for what waits for what: drag a card to place it,
// drag from the dot on its right edge to another card to make that one wait, and undo either. Columns stays the list for
// the keyboard and screen readers. Export saves the board as Markdown with a Mermaid chart.
// Schedules (#132) run a Ready card, or a prompt, once at a set time or every day, weekday or week, from the same drawer.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('board-view'), api = window.relayUI;
  if (!dialog || !api) return;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'secondary-button') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  // The modifier that moves a card on the canvas, named as the keyboard labels it.
  const altKey = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? 'Option' : 'Alt';
  const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
  const listed = items => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  const COLUMNS = [
    ['backlog', 'Backlog', 'Work for later. Move a card to Ready when it’s clear enough to run.'],
    ['ready', 'Ready', 'Cards with an agent, ready to run.'],
    ['doing', 'Doing', 'An agent is working on these, each as its own task.'],
    ['review', 'Review', 'Finished, waiting for you to accept or send back.'],
    ['done', 'Done', 'Work you accepted.'],
  ];
  const AGENTS = [['codex', 'Codex'], ['claude', 'Claude'], ['gemini', 'Gemini']], AGENT = Object.fromEntries(AGENTS);
  const PRIORITIES = [['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];
  const OUTCOME = { complete: 'Finished', integrated: 'Merged', kept: 'Kept as a branch', stopped: 'Stopped', failed: 'Didn’t finish', cancelled: 'Cancelled', discarded: 'Discarded', blocked: 'Blocked', lost: 'Copy gone', detached: 'Folder removed' };
  const when = iso => { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); } catch { return ''; } };
  // A due date is a calendar day (YYYY-MM-DD), compared with today where you are.
  const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
  const dayName = day => { const [y, m, d] = day.split('-').map(Number); try { return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) }); } catch { return day; } };
  function dueOf(card) {
    if (!card.due) return null;
    if (card.column === 'done') return { text: `Due ${dayName(card.due)}`, tone: '' };
    const now = today();
    if (card.due < now) return { text: `Overdue · ${dayName(card.due)}`, tone: 'late' };
    return card.due === now ? { text: 'Due today', tone: 'soon' } : { text: `Due ${dayName(card.due)}`, tone: '' };
  }
  const commentIcon = () => { const icon = svg('svg'); icon.setAttribute('class', 'icon'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); const path = svg('path'); path.setAttribute('d', 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'); icon.append(path); return icon; };

  // board: the last answer from the server. selected: the card in the drawer, 'new' for a new one, 'run' for Run Ready.
  // draft: what the drawer edits, kept apart so a refresh never overwrites typing. picked: the cards ticked in Run Ready.
  // seen: what the board was last loaded for; cleared when a load fails, so the next update tries again.
  // sdraft: the schedule being written, when selected is 'schedule'; 'schedules' lists them all.
  // filter: the label whose cards are shown, lower case, or '' for all. threads: each card's comments once read, and
  // asked: the comment count they were read for, so a card is asked again only when that changes. said: a comment being
  // written, per card, kept when the drawer is drawn again.
  let seen = null, board = null, selected = null, draft = null, sdraft = null, picked = new Set(), failure = '', busy = false, loading = 0, drawn = null, dragging = null;
  let filter = '', threads = new Map(), asked = new Map(), said = new Map();
  const cards = () => board?.cards || [];
  const shown = card => !filter || (card.labels || []).some(name => name.toLowerCase() === filter);
  // Every label on the board, in the case first used, with how many cards have it.
  function allLabels() {
    const out = new Map();
    for (const card of cards()) for (const name of card.labels || []) { const key = name.toLowerCase(), had = out.get(key); out.set(key, had ? { ...had, count: had.count + 1 } : { name, count: 1 }); }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  const cardBy = id => cards().find(card => card.id === id);
  const folderName = id => board?.folders.find(folder => folder.id === id)?.name || '';
  const VIEW_KEY = 'throughline:board-view';
  let view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'canvas' ? 'canvas' : 'columns'; } catch { return 'columns'; } })();
  // Canvas changes in flight: a load that answers meanwhile would draw cards back where they were, so it waits.
  let writes = 0, written = 0;

  async function load() {
    if (!api.getState().projectId) return;
    const request = ++loading;
    try { const result = await api.api('/api/board'); if (request === loading) { if (writes) { seen = null; return; } board = result; render(); } }
    catch (error) { if (request === loading) { seen = null; failure = error.message; render(); } }
  }
  async function act(path, input = {}, done) {
    if (busy) return; busy = true; failure = ''; render();
    try { const result = await api.post(path, input); board = result.board || board; done?.(result); }
    catch (error) { failure = error.message; }
    finally { busy = false; render(); }
  }

  // ---- The columns
  // What a card says about itself in one short line, from its task while it has one.
  function stateOf(card) {
    const task = card.taskState;
    if (card.column === 'doing') {
      if (task?.approvals) return { text: 'Needs you', tone: 'attention' };
      if (task?.status === 'running') return { text: 'Working', tone: 'running' };
      return { text: task?.held ? 'Held' : 'Waiting', tone: 'waiting', detail: task?.reason || '' };
    }
    if (card.column === 'review') {
      if (task?.hasWorktree) return { text: 'Merge first', tone: 'attention', detail: 'Its changes are in the task’s own copy. Review and merge them in its task.' };
      if (card.result?.tests === 'failed') return { text: 'Tests failed', tone: 'trouble' };
      return { text: card.result?.tests === 'passed' ? 'Tests passed' : 'Finished', tone: 'done' };
    }
    if (card.column === 'ready' && card.reason) return { text: 'Back', tone: 'trouble', detail: card.reason };
    return null;
  }
  function cardButton(card, onCanvas = false) {
    const item = node('button', 'board-card'); item.type = 'button';
    item.dataset.card = card.id; item.dataset.column = card.column; item.dataset.priority = card.priority;
    item.setAttribute('aria-pressed', String(selected === card.id));
    const state = stateOf(card), top = node('span', 'board-card-top');
    // On the canvas there are no columns to say where a card stands, so the card says it.
    if (onCanvas) top.append(node('span', 'board-card-column', COLUMNS.find(([id]) => id === card.column)[1]));
    if (card.priority !== 'normal') top.append(node('span', `board-priority ${card.priority}`, card.priority === 'high' ? 'High' : 'Low'));
    if (state) { const badge = node('span', 'board-card-state', state.text); badge.dataset.tone = state.tone; top.append(badge); }
    const title = node('span', 'board-card-title', card.title);
    // Up to three labels, then how many more; the one being filtered by is marked.
    const names = card.labels || [], tags = node('span', 'board-card-labels');
    for (const name of names.slice(0, names.length > 3 ? 2 : 3)) { const tag = node('span', 'board-label', name); if (filter && name.toLowerCase() === filter) tag.classList.add('current'); tags.append(tag); }
    if (names.length > 3) { const more = node('span', 'board-label more', `+${names.length - 2}`); more.title = names.slice(2).join(', '); tags.append(more); }
    const meta = node('span', 'board-card-meta'), provider = card.taskState?.provider || card.agent?.provider;
    const icon = node('i', `agent-icon ${provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true');
    meta.append(icon, node('span', provider ? 'board-card-agent' : 'board-card-missing', provider ? AGENT[provider] : 'No agent yet'));
    if (card.checks?.length) meta.append(node('span', 'board-card-checks', `${card.checks.filter(item => item.done).length}/${card.checks.length}`));
    const due = dueOf(card);
    if (due) { const day = node('span', `board-card-due${due.tone ? ` ${due.tone}` : ''}`, due.text); day.title = card.due; meta.append(day); }
    if (card.commentCount) { const count = node('span', 'board-card-comments'); count.append(commentIcon(), document.createTextNode(String(card.commentCount))); count.title = plural(card.commentCount, 'comment'); meta.append(count); }
    const timed = schedulesOf(card), soon = timed.filter(item => !item.paused && item.nextAt).sort((a, b) => a.nextAt.localeCompare(b.nextAt))[0];
    if (timed.some(item => item.missed)) meta.append(node('span', 'board-card-schedule missed', 'Scheduled run missed'));
    else if (soon) meta.append(node('span', 'board-card-schedule', `Runs ${when(soon.nextAt)}`));
    const after = (card.dependsOn || []).map(cardBy).filter(item => item && item.column !== 'done');
    if (after.length && ['backlog', 'ready'].includes(card.column)) meta.append(node('span', 'board-card-after', `After ${after.map(item => item.title).join(', ')}`));
    item.append(top, title, ...(names.length ? [tags] : []), meta);
    if (state?.detail && card.column === 'ready') item.append(node('span', 'board-card-reason', state.detail));
    item.title = state?.detail || card.title;
    item.setAttribute('aria-label', [card.title, card.priority !== 'normal' ? `${card.priority} priority` : '', names.length ? `${names.length === 1 ? 'label' : 'labels'} ${listed(names)}` : '', provider ? AGENT[provider] : 'no agent yet', due?.text || '', card.commentCount ? plural(card.commentCount, 'comment') : '', state?.text || '', state?.detail || '', timed.some(item => item.missed) ? 'a scheduled run was missed' : soon ? `scheduled to run ${when(soon.nextAt)}` : ''].filter(Boolean).join('. '));
    item.addEventListener('click', () => { if (moved === card.id) { moved = null; return; } select(card.id); });
    // Backlog, Ready and Done cards can be dragged: between Backlog and Ready, back from Done, and into a new order.
    if (!onCanvas && ['backlog', 'ready', 'done'].includes(card.column)) {
      item.draggable = true;
      item.addEventListener('dragstart', event => { dragging = card.id; event.dataTransfer?.setData('text/plain', card.id); item.classList.add('dragging'); });
      item.addEventListener('dragend', () => { dragging = null; item.classList.remove('dragging'); for (const zone of dialog.querySelectorAll('.board-column.drop')) zone.classList.remove('drop'); });
    }
    return item;
  }
  function dropTarget(column, zone, list) {
    const accepts = id => { const card = cardBy(id); return card && (card.column === column || ({ backlog: ['ready', 'done'], ready: ['backlog', 'done'] }[column] || []).includes(card.column)); };
    zone.addEventListener('dragover', event => { if (!dragging || !accepts(dragging)) return; event.preventDefault(); zone.classList.add('drop'); });
    zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop'); });
    zone.addEventListener('drop', event => {
      const id = dragging; zone.classList.remove('drop');
      if (!id || !accepts(id)) return; event.preventDefault();
      const under = [...list.querySelectorAll('.board-card')].find(element => element.dataset.card !== id && event.clientY < element.getBoundingClientRect().top + element.offsetHeight / 2);
      act(`/api/board/cards/${id}/move`, { column, before: under?.dataset.card || null });
    });
  }
  function drawColumns() {
    $('board-columns').replaceChildren(...COLUMNS.map(([id, name, hint]) => {
      const column = node('section', 'board-column'), head = node('header', 'board-column-head'), list = node('div', 'board-column-cards'), all = cards().filter(card => card.column === id), own = all.filter(shown);
      // With a label chosen, a column shows only its cards with that label, and says how many of its cards that is.
      const count = filter ? `${own.length} of ${all.length}` : String(all.length);
      column.dataset.column = id; column.setAttribute('aria-label', `${name}, ${filter ? `${own.length} of ${plural(all.length, 'card')} shown` : plural(all.length, 'card')}`);
      head.append(node('span', 'board-column-name', name), node('span', 'board-column-count', count));
      if (id === 'backlog' || id === 'ready') { const add = button('+', () => openNew(id), 'icon-button board-column-add'); add.setAttribute('aria-label', `New card in ${name}`); add.title = `New card in ${name}`; head.append(add); }
      list.append(...own.map(card => cardButton(card)));
      if (!own.length) list.append(node('p', 'board-column-empty', all.length ? 'No cards here with this label.' : hint));
      column.append(head, list);
      if (id === 'backlog' || id === 'ready') dropTarget(id, column, list);
      return column;
    }));
  }

  // ---- The drawer
  const blank = (column, at = null) => ({ title: '', notes: '', priority: 'normal', labels: filter ? [allLabels().find(item => item.name.toLowerCase() === filter)?.name].filter(Boolean) : [], due: null, agent: null, folderId: null, dependsOn: [], checks: [], column, revision: null, at });
  const editable = card => ({ title: card.title, notes: card.notes || '', priority: card.priority, labels: [...(card.labels || [])], due: card.due || null, agent: card.agent ? { ...card.agent } : null, folderId: card.folderId || null, dependsOn: [...(card.dependsOn || [])], checks: (card.checks || []).map(item => ({ ...item })), column: card.column, revision: card.revision });
  const fields = value => JSON.stringify([value.title.trim(), value.notes.trim(), value.priority, value.labels, value.due, value.agent?.provider || null, value.folderId, [...value.dependsOn].sort(), value.checks.map(item => [item.text.trim(), item.done])]);
  const dirty = () => { if (!draft) return false; if (selected === 'new') return Boolean(draft.title.trim() || draft.notes.trim()); const card = cardBy(selected); return card ? fields(draft) !== fields(editable(card)) : false; };
  function select(id) {
    if (selected && selected !== id && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = selected === id ? null : id; failure = '';
    draft = selected && cardBy(selected) ? editable(cardBy(selected)) : null; drawn = null;
    render();
    if (selected) $('board-drawer-body').querySelector('input, textarea, button')?.focus();
  }
  function openNew(column = 'backlog', at = null) {
    if (selected && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = 'new'; draft = blank(column, at); failure = ''; drawn = null; render();
    $('board-drawer-body').querySelector('.board-field-title')?.focus();
  }
  function openRun() {
    if (selected && selected !== 'run' && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = 'run'; draft = null; failure = ''; drawn = null;
    picked = new Set(cards().filter(card => card.column === 'ready' && card.agent).map(card => card.id));
    render();
  }
  function closeDrawer() { if (dirty() && !window.confirm('Leave this card without saving your changes?')) return; const was = selected; selected = null; draft = null; failure = ''; render(); if (was) $('board-columns').querySelector(`[data-card="${was}"]`)?.focus(); }

  function segment(label, options, current, choose, disabled) {
    const group = node('div', 'board-segment'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    for (const [value, text, iconClass] of options) {
      const choice = node('button', 'board-choice'); choice.type = 'button'; choice.disabled = disabled;
      if (iconClass) { const icon = node('i', iconClass); icon.setAttribute('aria-hidden', 'true'); choice.append(icon); }
      choice.append(document.createTextNode(text)); choice.setAttribute('aria-pressed', String(value === current));
      choice.addEventListener('click', () => { choose(value); for (const other of group.children) other.setAttribute('aria-pressed', String(other === choice)); changed(); });
      group.append(choice);
    }
    return group;
  }
  const labelled = (text, control, note) => { const row = node('div', 'board-field'); row.append(node('span', 'board-field-label', text), control); if (note) row.append(node('span', 'board-field-note', note)); return row; };
  // Typing changes only the draft and the Save button; the drawer itself is rebuilt only when the card or the mode changes.
  function changed() { failure = ''; const save = $('board-drawer-body').querySelector('.board-save'); if (save) save.disabled = busy || !dirty() || !draft.title.trim(); const revert = $('board-drawer-body').querySelector('.board-revert'); if (revert) revert.hidden = selected === 'new' || !dirty(); showError(); }

  function editor(card) {
    const locked = card?.column === 'doing', parts = [];
    const title = node('input', 'board-input board-field-title'); title.value = draft.title; title.maxLength = board?.limits?.title || 200; title.placeholder = 'What needs doing'; title.setAttribute('aria-label', 'Card title'); title.disabled = locked;
    title.addEventListener('input', () => { draft.title = title.value; changed(); });
    const notes = node('textarea', 'board-input board-field-notes'); notes.value = draft.notes; notes.rows = 5; notes.maxLength = board?.limits?.notes || 20000; notes.placeholder = 'Details the agent needs: where, what, and anything to avoid'; notes.setAttribute('aria-label', 'Card description'); notes.disabled = locked;
    notes.addEventListener('input', () => { draft.notes = notes.value; changed(); });
    parts.push(title, notes);
    if (locked) parts.push(node('p', 'board-note', 'An agent is working from this card. Stop it to change what it says.'));
    parts.push(labelled('Priority', segment('Priority', PRIORITIES, draft.priority, value => { draft.priority = value; }, false)));
    // Labels and the due date are yours to sort and plan by: the agent isn't told them, so they can change while it works.
    const tags = node('div', 'board-labels-edit'), entry$ = node('input', 'board-label-input'), options = node('datalist');
    options.id = 'board-label-options'; entry$.setAttribute('list', options.id);
    entry$.maxLength = board?.limits?.label || 32; entry$.placeholder = draft.labels.length ? 'Add another' : 'Add a label'; entry$.setAttribute('aria-label', 'Add a label');
    const most = board?.limits?.labels || 8;
    const addLabel = () => {
      const name = entry$.value.replace(/\s+/g, ' ').replace(/,/g, '').trim(); entry$.value = '';
      if (!name || draft.labels.some(item => item.toLowerCase() === name.toLowerCase())) return;
      if (draft.labels.length >= most) { failure = `A card can have up to ${most} labels.`; showError(); return; }
      // A label already on the board keeps the case it was first written in, so the filter finds one label, not two.
      draft.labels = [...draft.labels, allLabels().find(item => item.name.toLowerCase() === name.toLowerCase())?.name || name]; drawTags(); changed();
    };
    const drawTags = () => {
      const chips = draft.labels.map((name, index) => {
        const chip = node('span', 'board-label editable'), remove = button('×', () => { draft.labels = draft.labels.filter((_, at) => at !== index); drawTags(); changed(); entry$.focus(); }, 'board-label-remove');
        remove.setAttribute('aria-label', `Remove the label “${name}”`); remove.title = 'Remove';
        chip.append(node('span', '', name), remove); return chip;
      });
      options.replaceChildren(...allLabels().filter(item => !draft.labels.some(name => name.toLowerCase() === item.name.toLowerCase())).map(item => { const option = node('option'); option.value = item.name; return option; }));
      entry$.hidden = draft.labels.length >= most; entry$.placeholder = draft.labels.length ? 'Add another' : 'Add a label';
      tags.replaceChildren(...chips, entry$, options);
    };
    entry$.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addLabel(); }
      else if (event.key === 'Backspace' && !entry$.value && draft.labels.length) { draft.labels = draft.labels.slice(0, -1); drawTags(); changed(); }
    });
    // Choosing a suggestion, or leaving the field with a name typed, adds it too.
    entry$.addEventListener('input', event => { if (event.inputType === 'insertReplacementText' || (!event.inputType && allLabels().some(item => item.name === entry$.value))) addLabel(); });
    entry$.addEventListener('blur', () => { if (entry$.value.trim()) addLabel(); });
    tags.addEventListener('click', event => { if (event.target === tags) entry$.focus(); });
    drawTags();
    parts.push(labelled('Labels', tags));
    const day = node('input', 'board-input board-due-input'); day.type = 'date'; day.value = draft.due || ''; day.setAttribute('aria-label', 'Due date');
    const clear = button('Clear', () => { draft.due = null; day.value = ''; clear.hidden = true; changed(); day.focus(); }, 'text-link board-due-clear'); clear.hidden = !draft.due;
    day.addEventListener('change', () => { draft.due = /^\d{4}-\d{2}-\d{2}$/.test(day.value) ? day.value : null; clear.hidden = !draft.due; changed(); });
    const dueRow = node('div', 'board-due'); dueRow.append(day, clear);
    parts.push(labelled('Due', dueRow));
    parts.push(labelled('Agent', segment('Agent', AGENTS.map(([value, text]) => [value, text, `agent-icon ${value}`]), draft.agent?.provider || null, value => { draft.agent = { provider: value, model: null, effort: null }; }, locked), draft.agent ? 'Runs with this agent’s default model and effort.' : 'Choose an agent before the card can run.'));
    if ((board?.folders || []).length > 1) {
      const folder = node('select', 'board-input'); folder.setAttribute('aria-label', 'Folder the card works in'); folder.disabled = locked;
      folder.append(...[['', 'Choose a folder'], ...board.folders.map(item => [item.id, item.name])].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
      folder.value = draft.folderId || ''; folder.addEventListener('change', () => { draft.folderId = folder.value || null; changed(); });
      parts.push(labelled('Works in', folder));
    }
    // Waits for: the cards chosen, each with a way to take it off, and a menu of the other cards not yet done.
    const others = cards().filter(other => other.id !== card?.id && other.column !== 'done');
    if (others.length || draft.dependsOn.length) {
      const waits = node('div', 'board-waits');
      const drawWaits = () => {
        const chosen = draft.dependsOn.map(id => cardBy(id)).filter(Boolean), list = node('ul', 'board-wait-list');
        list.append(...chosen.map(other => {
          const row = node('li', 'board-wait'), name = node('span', 'board-wait-title', other.title); name.title = other.title;
          const remove = button('×', () => { draft.dependsOn = draft.dependsOn.filter(id => id !== other.id); drawWaits(); changed(); }, 'icon-button board-check-remove');
          remove.setAttribute('aria-label', `Stop waiting for “${other.title}”`); remove.disabled = locked;
          row.append(name, node('span', 'board-wait-column', COLUMNS.find(([id]) => id === other.column)[1]), remove); return row;
        }));
        const add = node('select', 'board-input'); add.setAttribute('aria-label', 'Add a card this one waits for'); add.disabled = locked;
        const left = others.filter(other => !draft.dependsOn.includes(other.id));
        add.append(...[['', left.length ? 'Add a card it waits for…' : 'No other cards to wait for'], ...left.map(other => [other.id, other.title])].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
        add.disabled = locked || !left.length;
        add.addEventListener('change', () => { if (!add.value) return; draft.dependsOn = [...draft.dependsOn, add.value]; drawWaits(); changed(); waits.querySelector('select')?.focus(); });
        waits.replaceChildren(...(chosen.length ? [list] : []), add);
      };
      drawWaits();
      parts.push(labelled('Waits for', waits, 'It runs only after these are done, or together with them.'));
    }
    // Done means: what you'll check before accepting it. The agent is told these; ticking one isn't a change to the card.
    const checks = node('ul', 'board-checks');
    const drawChecks = () => checks.replaceChildren(...draft.checks.map((item, index) => {
      const row = node('li', 'board-check'), tick = node('input'); tick.type = 'checkbox'; tick.checked = item.done; tick.setAttribute('aria-label', `Done: ${item.text || 'check'}`);
      tick.addEventListener('change', () => { item.done = tick.checked; changed(); });
      const text = node('input', 'board-input'); text.value = item.text; text.maxLength = board?.limits?.check || 300; text.placeholder = 'Something you’ll check'; text.setAttribute('aria-label', `Check ${index + 1}`); text.disabled = locked;
      text.addEventListener('input', () => { item.text = text.value; changed(); });
      const remove = button('×', () => { draft.checks.splice(index, 1); drawChecks(); changed(); }, 'icon-button board-check-remove'); remove.setAttribute('aria-label', `Remove check ${index + 1}`); remove.disabled = locked;
      row.append(tick, text, remove); return row;
    }));
    drawChecks();
    const addCheck = button('Add a check', () => { draft.checks.push({ text: '', done: false }); drawChecks(); checks.lastElementChild?.querySelector('.board-input')?.focus(); changed(); }, 'text-link board-add-check'); addCheck.disabled = locked || draft.checks.length >= (board?.limits?.checks || 20);
    const checksField = labelled('Done means', checks); checksField.append(addCheck);
    parts.push(checksField);
    const save = button(selected === 'new' ? 'Add card' : 'Save', save$ , 'primary-button board-save');
    const revert = button('Revert', () => { draft = editable(cardBy(selected)); drawn = null; render(); }, 'text-link board-revert');
    const saving = node('div', 'board-save-row'); saving.append(revert, save);
    parts.push(saving);
    return parts;
  }
  function save$() {
    if (!draft?.title.trim()) return;
    const input = { title: draft.title, notes: draft.notes, priority: draft.priority, labels: draft.labels, due: draft.due, agent: draft.agent, folderId: draft.folderId, dependsOn: draft.dependsOn, checks: draft.checks.filter(item => item.text.trim()) };
    if (selected === 'new') act('/api/board/cards', { ...input, column: draft.column, ...(draft.at ? { at: draft.at } : {}) }, result => { selected = result.card.id; draft = editable(result.card); drawn = null; api.announce(`Added “${result.card.title}” to ${COLUMNS.find(([id]) => id === result.card.column)[1]}.`); });
    else act(`/api/board/cards/${selected}/edit`, { ...input, revision: draft.revision }, result => { draft = editable(result.card); drawn = null; api.announce('Card saved.'); });
  }
  const openTask = card => { dialog.close(); window.relayTaskThreads?.select(card.taskState.id); };
  // What can be done with a card where it is now.
  function actions(card) {
    const row = node('div', 'board-actions'), state = stateOf(card);
    const move = (text, column) => button(text, () => act(`/api/board/cards/${card.id}/move`, { column }));
    const remove = button('Remove', () => { if (window.confirm(`Remove “${card.title}” from the board?`)) act(`/api/board/cards/${card.id}/remove`, {}, () => { selected = null; draft = null; api.announce('Card removed.'); }); }, 'text-link board-remove');
    if (card.column === 'backlog') row.append(move('Move to Ready', 'ready'), remove);
    if (card.column === 'ready') {
      const run = button('Run', () => act('/api/board/run', { ids: [card.id], executionRevision: undefined }, () => api.announce(`“${card.title}” is running as a task.`)), 'primary-button');
      run.disabled = !card.agent || dirty(); run.title = !card.agent ? 'Choose an agent first.' : dirty() ? 'Save your changes first.' : 'Run this card as its own task.';
      row.append(run, scheduleButton(card), move('Move to Backlog', 'backlog'), remove);
    }
    if (card.column === 'doing') row.append(button('Open its task', () => openTask(card), 'primary-button'), button(card.taskState?.status === 'running' ? 'Stop' : 'Cancel', () => act(`/api/board/cards/${card.id}/stop`)));
    if (card.column === 'review') {
      const accept = button('Accept', () => act(`/api/board/cards/${card.id}/accept`, {}, () => api.announce(`“${card.title}” is done.`)), 'primary-button');
      if (card.taskState?.hasWorktree) { row.append(button('Review and merge', () => openTask(card), 'primary-button')); accept.className = 'secondary-button'; accept.disabled = true; accept.title = state?.detail || ''; }
      row.append(accept);
      if (!card.taskState?.hasWorktree) row.append(button('Send back…', () => sendBack(card)));
      if (card.taskState) row.append(button('Open its task', () => openTask(card), 'text-link'));
    }
    if (card.column === 'done') row.append(move('Reopen', 'ready'), scheduleButton(card), remove);
    return row;
  }
  function sendBack(card) {
    const reason = window.prompt('What should change? It goes back to Ready with this note. (Optional)', '');
    if (reason === null) return;
    act(`/api/board/cards/${card.id}/send-back`, { reason }, () => api.announce(`“${card.title}” is back in Ready.`));
  }
  // Where a card stands: why it's waiting or back, and what its last run did.
  function status(card) {
    const parts = [], state = stateOf(card);
    if (card.column === 'doing' && state) parts.push(node('p', 'board-status', state.detail ? `${state.text}: ${state.detail}` : state.text));
    if (card.column === 'ready' && card.reason) parts.push(node('p', 'board-status trouble', card.reason));
    if (card.result && ['review', 'done'].includes(card.column)) {
      const box = node('div', 'board-result'), facts = [card.result.files != null ? plural(card.result.files, 'file') + ' changed' : '', card.result.tests ? `tests ${card.result.tests}` : 'no tests recorded', card.result.inCopy ? (card.result.status === 'complete' ? 'in its own copy, not merged yet' : OUTCOME[card.result.status]?.toLowerCase()) : ''].filter(Boolean);
      const line = facts.join(' · ');
      box.append(node('p', 'board-result-facts', line.charAt(0).toUpperCase() + line.slice(1)));
      if (card.result.summary) box.append(node('p', 'board-result-summary', card.result.summary));
      parts.push(box);
    }
    if (card.column === 'done' && card.acceptedAt) parts.push(node('p', 'board-status done', `Accepted by you, ${when(card.acceptedAt)}.`));
    return parts;
  }
  function history(card) {
    if (!card.attempts?.length) return [];
    const list = node('ol', 'board-history');
    list.append(...[...card.attempts].reverse().map(item => node('li', '', `${AGENT[item.provider] || item.provider} · ${item.outcome ? OUTCOME[item.outcome] || item.outcome : 'Running'} · ${when(item.endedAt || item.startedAt)}`)));
    const box = node('details', 'board-history-box'); box.append(node('summary', '', `Runs (${card.attempts.length})`), list);
    return [box];
  }

  // ---- Comments (#97)
  // Read when a card opens, and again only when its count changes. Each says who wrote it and when; the agent is told
  // yours the next time the card runs.
  const authorOf = by => by?.kind === 'agent' ? [AGENT[by.provider] || by.provider, by.model].filter(Boolean).join(' · ') || 'Agent' : by?.kind === 'guest' ? `${by.name || 'Guest'} (guest)` : 'You';
  async function readComments(id) {
    const count = cardBy(id)?.commentCount || 0;
    if (asked.get(id) === count) return; asked.set(id, count);
    if (!count) { threads.set(id, []); return; }
    try { const result = await api.api(`/api/board/cards/${id}/comments`); threads.set(id, result.comments || []); }
    catch (error) { asked.delete(id); failure = error.message; showError(); return; }
    if (selected === id) { drawn = null; renderDrawer(); }
  }
  function commentsPanel(card) {
    const box = node('section', 'board-comments'), list = node('ol', 'board-comment-list'), thread = threads.get(card.id);
    box.setAttribute('aria-label', 'Comments');
    box.append(node('h4', 'board-field-label', card.commentCount ? `Comments (${card.commentCount})` : 'Comments'));
    if (!thread && card.commentCount) list.append(node('li', 'board-comment-empty', 'Loading comments…'));
    for (const item of thread || []) {
      const row = node('li', 'board-comment'), head = node('div', 'board-comment-head'), stamp = node('time', 'board-comment-when', when(item.at));
      stamp.setAttribute('datetime', item.at);
      const remove = button('Remove', () => { if (window.confirm('Remove this comment? The agent won’t be told it any more.')) act(`/api/board/cards/${card.id}/uncomment`, { commentId: item.id }, result => took(card.id, result, 'Comment removed.')); }, 'text-link board-comment-remove');
      remove.setAttribute('aria-label', `Remove your comment from ${when(item.at)}`); remove.disabled = busy;
      head.append(node('span', 'board-comment-author', authorOf(item.by)), stamp, ...(item.by?.kind === 'you' ? [remove] : []));
      row.append(head, node('p', 'board-comment-text', item.text)); list.append(row);
    }
    if (list.children.length) box.append(list);
    const write = node('textarea', 'board-input board-comment-input'); write.rows = 2; write.maxLength = board?.limits?.comment || 4000;
    write.placeholder = 'Leave a comment'; write.setAttribute('aria-label', 'New comment'); write.value = said.get(card.id) || '';
    const send = button('Comment', () => postComment(card), 'secondary-button board-comment-send'); send.disabled = busy || !write.value.trim();
    write.addEventListener('input', () => { said.set(card.id, write.value); send.disabled = busy || !write.value.trim(); });
    write.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); postComment(card); } });
    const foot = node('div', 'board-comment-foot');
    foot.append(node('span', 'board-field-note', card.column === 'doing' ? 'The agent working now started without it. It’s told your comments the next time this card runs.' : 'The agent is told your comments when this card runs.'), send);
    box.append(write, foot);
    return [box];
  }
  // A comment changes what the agent is told, so it's a new revision of the card. A card you're editing keeps your
  // changes: its draft moves on to the new revision when that comment was the only difference.
  function took(id, result, said$) {
    threads.set(id, result.comments || []); asked.set(id, result.card?.commentCount ?? (result.comments || []).length);
    if (draft && selected === id && result.card && draft.revision === result.card.revision - 1) draft.revision = result.card.revision;
    drawn = null; api.announce(said$);
  }
  function postComment(card) {
    const text = (said.get(card.id) || '').trim();
    if (!text || busy) return;
    act(`/api/board/cards/${card.id}/comment`, { text }, result => { said.delete(card.id); took(card.id, result, 'Comment added.'); });
  }

  // Run Ready: the Ready cards with a box each. A card that waits for one that isn't done must run with it.
  function runPanel() {
    const ready = cards().filter(card => card.column === 'ready'), parts = [];
    if (!ready.length) { parts.push(node('p', 'board-note', 'Nothing is in Ready. Move cards there, with an agent each, to run them.')); return parts; }
    const blocked = card => !card.agent ? 'Choose an agent first.' : (card.dependsOn || []).map(cardBy).filter(item => item && item.column !== 'done' && !picked.has(item.id)).map(item => `Waits for “${item.title}”`)[0] || '';
    const list = node('ul', 'board-run-list');
    for (const card of ready) {
      const row = node('li', 'board-run-row'), label = node('label', 'board-run-label'), tick = node('input'); tick.type = 'checkbox';
      tick.checked = picked.has(card.id); tick.disabled = !card.agent || busy;
      tick.addEventListener('change', () => { if (tick.checked) picked.add(card.id); else picked.delete(card.id); drawn = null; render(); });
      const icon = node('i', `agent-icon ${card.agent?.provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true');
      label.append(tick, node('span', 'board-run-title', card.title), icon, node('span', 'board-run-agent', card.agent ? AGENT[card.agent.provider] : 'No agent'));
      row.append(label);
      const why = picked.has(card.id) || !card.agent ? blocked(card) : '';
      if (why || !card.agent) { const note = node('span', 'board-run-why', why || 'Choose an agent first.'); row.append(note); row.dataset.blocked = 'true'; }
      list.append(row);
    }
    parts.push(list);
    const access = board.access, how = access.mode === 'read' ? 'read only' : access.approvalPolicy === 'auto' ? 'can edit files, and approves its own requests' : 'can edit files, and asks before anything that needs approval';
    parts.push(node('p', 'board-note', `Each card runs as its own task with its agent, using this workspace’s access: ${how}. A card that waits for another starts after it. Tasks at once in the task limits decides how many run together. Nothing is pushed or published.`));
    const chosen = ready.filter(card => picked.has(card.id)), problem = chosen.map(blocked).find(Boolean);
    const run = button(chosen.length ? `Run ${plural(chosen.length, 'card')}` : 'Run', () => act('/api/board/run', { ids: chosen.map(card => card.id) }, () => { api.announce(`${plural(chosen.length, 'card')} running as tasks.`); selected = null; }), 'primary-button');
    run.disabled = busy || !chosen.length || Boolean(problem); if (problem) run.title = problem;
    const row = node('div', 'board-save-row'); row.append(run); parts.push(row);
    return parts;
  }

  // ---- Schedules (#132)
  // A card or a prompt run at a set time, in the computer's local time, with the agent and the workspace's access saved
  // with it. The server keeps the time and starts the run; this only writes and shows them.
  const REPEAT = [['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week']];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const schedules = () => board?.schedules || [];
  const schedulesOf = card => schedules().filter(item => item.target.type === 'card' && item.target.cardId === card.id);
  const pad = value => String(value).padStart(2, '0');
  const localDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = time => { const [hour, minute] = time.split(':').map(Number); return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
  function describe(time) {
    const at = clock(time.time);
    if (time.repeat === 'daily') return `Every day at ${at}`;
    if (time.repeat === 'weekdays') return `Weekdays at ${at}`;
    if (time.repeat === 'weekly') return `Every ${DAYS[time.weekday]} at ${at}`;
    const [year, month, day] = time.date.split('-').map(Number);
    return `Once, ${new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${at}`;
  }
  const how = access => access.mode === 'read' ? 'read only' : access.approvalPolicy === 'auto' ? 'can edit files, and approves its own requests' : 'can edit files, and asks before anything that needs approval';
  const LAST = { running: 'Working', waiting: 'Waiting to start' };
  function scheduleButton(card) {
    const value = button('Schedule…', () => newSchedule({ type: 'card', cardId: card.id }, card.id));
    value.disabled = !card.agent || dirty(); value.title = !card.agent ? 'Choose an agent first.' : dirty() ? 'Save your changes first.' : 'Run this card at a set time, once or on repeat.';
    return value;
  }
  function newSchedule(target, back) {
    if (selected && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    const soon = new Date(Date.now() + 3600000); soon.setMinutes(0, 0, 0);
    sdraft = { id: null, back, target, title: '', text: '', agent: null, folderId: null, when: { repeat: 'once', time: `${pad(soon.getHours())}:00`, date: localDate(soon), weekday: soon.getDay() }, runLate: false };
    selected = 'schedule'; draft = null; failure = ''; drawn = null; render();
    $('board-drawer-body').querySelector('input, textarea, button')?.focus();
  }
  function editSchedule(item, back) {
    const today = new Date(), prompt = item.target.type === 'prompt';
    sdraft = { id: item.id, back, target: prompt ? { type: 'prompt' } : { type: 'card', cardId: item.target.cardId }, title: prompt ? item.title || '' : '', text: item.target.text || '', agent: item.target.agent ? { ...item.target.agent } : null, folderId: item.target.folderId || null, when: { date: localDate(today), weekday: today.getDay(), ...item.when }, runLate: item.runLate === true };
    selected = 'schedule'; draft = null; failure = ''; drawn = null; render();
    $('board-drawer-body').querySelector('input, textarea, button')?.focus();
  }
  function leaveSchedule() { const back = sdraft?.back; sdraft = null; selected = back && (back === 'schedules' || cardBy(back)) ? back : 'schedules'; draft = cardBy(selected) ? editable(cardBy(selected)) : null; failure = ''; drawn = null; render(); }
  function scheduleRow(item, back) {
    const row = node('li', 'board-schedule'); row.dataset.state = item.missed ? 'missed' : item.paused ? 'paused' : 'waiting';
    const head = node('div', 'board-schedule-head'), icon = node('i', `agent-icon ${item.agent?.provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true');
    head.append(icon, node('span', 'board-schedule-title', item.title), node('span', 'board-schedule-kind', item.target.type === 'card' ? 'Card' : 'Prompt'));
    row.append(head, node('p', 'board-schedule-when', `${describe(item.when)} · ${item.paused ? 'Paused' : item.nextAt ? `next ${when(item.nextAt)}` : 'nothing left to run'}`));
    if (item.missed) row.append(node('p', 'board-status trouble', `The run for ${when(item.missed.dueAt)} didn’t start. ${item.missed.reason}`));
    else if (item.changed) row.append(node('p', 'board-status', 'The card changed after it was scheduled, so it won’t run on its own. Run it now, or save the schedule again.'));
    if (item.last) row.append(node('p', 'board-schedule-last', `Last run ${when(item.last.at)}${item.last.manual ? ', started by you' : ''}${item.last.status ? ` · ${LAST[item.last.status] || OUTCOME[item.last.status] || item.last.status}` : ''}`));
    const actions = node('div', 'board-schedule-actions');
    actions.append(button('Run now', () => act(`/api/board/schedules/${item.id}/run`, {}, () => api.announce(`“${item.title}” is running as a task.`)), item.missed ? 'primary-button' : 'secondary-button'));
    if (item.missed) actions.append(button('Dismiss', () => act(`/api/board/schedules/${item.id}/dismiss`)));
    actions.append(button('Edit', () => editSchedule(item, back)));
    if (item.nextAt || item.paused) actions.append(button(item.paused ? 'Resume' : 'Pause', () => act(`/api/board/schedules/${item.id}/${item.paused ? 'resume' : 'pause'}`, {}, () => api.announce(item.paused ? 'Schedule resumed.' : 'Schedule paused.'))));
    actions.append(button('Remove', () => { if (window.confirm(`Remove the schedule for “${item.title}”?`)) act(`/api/board/schedules/${item.id}/remove`, {}, () => api.announce('Schedule removed.')); }, 'text-link board-remove'));
    row.append(actions);
    return row;
  }
  function cardSchedules(card) {
    const own = schedulesOf(card);
    if (!own.length) return [];
    const list = node('ul', 'board-schedules'); list.setAttribute('aria-label', 'Schedules for this card'); list.append(...own.map(item => scheduleRow(item, card.id)));
    return [list];
  }
  function schedulesPanel() {
    const parts = [node('p', 'board-note', 'Run a card or a prompt at a set time, once or on repeat, with its agent and this workspace’s access saved with it. Schedules run while Codeshi is open and the computer is awake; while one is waiting, closing the window leaves Codeshi in the menu bar.')];
    if (schedules().length) { const list = node('ul', 'board-schedules'); list.append(...schedules().map(item => scheduleRow(item, 'schedules'))); parts.push(list); }
    else parts.push(node('p', 'board-note', 'Nothing is scheduled. Open a Ready card and choose Schedule…, or schedule a prompt.'));
    const row = node('div', 'board-save-row'); row.append(button('Schedule a prompt…', () => newSchedule({ type: 'prompt' }, 'schedules'), 'primary-button')); parts.push(row);
    return parts;
  }
  function scheduleForm() {
    const plan = sdraft, parts = [], card = plan.target.type === 'card' ? cardBy(plan.target.cardId) : null;
    if (plan.target.type === 'card' && !card) { parts.push(node('p', 'board-note', 'That card is no longer on the board.')); return parts; }
    if (card) parts.push(node('p', 'board-status', `Runs “${card.title}” with ${card.agent ? AGENT[card.agent.provider] : 'its agent'}, as the card says when you save. A card that repeats runs again from Ready or Done; if it’s still in Doing or Review, that time is skipped and shown here.`));
    else {
      const title = node('input', 'board-input'); title.value = plan.title; title.maxLength = 200; title.placeholder = 'Name (optional)'; title.setAttribute('aria-label', 'Schedule name');
      title.addEventListener('input', () => { plan.title = title.value; });
      const text = node('textarea', 'board-input board-field-notes'); text.value = plan.text; text.rows = 5; text.maxLength = 20000; text.placeholder = 'What the agent should do each time'; text.setAttribute('aria-label', 'Prompt');
      text.addEventListener('input', () => { plan.text = text.value; });
      parts.push(title, text);
      parts.push(labelled('Agent', segment('Agent', AGENTS.map(([value, name]) => [value, name, `agent-icon ${value}`]), plan.agent?.provider || null, value => { plan.agent = { provider: value, model: null, effort: null }; }, false), 'Runs with this agent’s default model and effort.'));
      if ((board?.folders || []).length > 1) {
        const folder = node('select', 'board-input'); folder.setAttribute('aria-label', 'Folder it works in');
        folder.append(...[['', 'Choose a folder'], ...board.folders.map(item => [item.id, item.name])].map(([value, name]) => { const option = node('option', '', name); option.value = value; return option; }));
        folder.value = plan.folderId || ''; folder.addEventListener('change', () => { plan.folderId = folder.value || null; });
        parts.push(labelled('Works in', folder));
      }
    }
    parts.push(labelled('Repeat', segment('Repeat', REPEAT, plan.when.repeat, value => { plan.when.repeat = value; drawn = null; render(); $('board-drawer-body').querySelector('.board-segment[aria-label="Repeat"] [aria-pressed="true"]')?.focus(); }, false)));
    const at = node('div', 'board-schedule-at');
    if (plan.when.repeat === 'once') { const date = node('input', 'board-input'); date.type = 'date'; date.value = plan.when.date; date.min = localDate(new Date()); date.setAttribute('aria-label', 'Date'); date.addEventListener('input', () => { plan.when.date = date.value; }); at.append(date); }
    if (plan.when.repeat === 'weekly') {
      const day = node('select', 'board-input'); day.setAttribute('aria-label', 'Day of the week');
      day.append(...DAYS.map((name, index) => { const option = node('option', '', name); option.value = String(index); return option; }));
      day.value = String(plan.when.weekday); day.addEventListener('change', () => { plan.when.weekday = Number(day.value); }); at.append(day);
    }
    const time = node('input', 'board-input'); time.type = 'time'; time.value = plan.when.time; time.setAttribute('aria-label', 'Time'); time.addEventListener('input', () => { plan.when.time = time.value; }); at.append(time);
    parts.push(labelled(plan.when.repeat === 'once' ? 'On' : 'At', at, 'In this computer’s time.'));
    const late = node('label', 'board-schedule-late'), box = node('input'); box.type = 'checkbox'; box.checked = plan.runLate;
    box.addEventListener('change', () => { plan.runLate = box.checked; });
    late.append(box, node('span', '', 'Run late if Codeshi was closed or the computer was asleep at that time. Otherwise a missed time waits for you.'));
    parts.push(late);
    parts.push(node('p', 'board-note', `It runs as its own task with this workspace’s access as it is now: ${how(board.access)}. Changing the workspace later doesn’t change it; saving the schedule again does.${card ? ' If the card is edited, it waits for you instead of running.' : ''} The agent is told not to push, deploy or publish anything.`));
    const save = button(plan.id ? 'Save schedule' : 'Schedule', saveSchedule, 'primary-button board-schedule-save'); save.disabled = busy;
    const row = node('div', 'board-save-row'); row.append(button('Cancel', leaveSchedule, 'text-link'), save); parts.push(row);
    return parts;
  }
  function saveSchedule() {
    const plan = sdraft; if (!plan) return;
    const time = { repeat: plan.when.repeat, time: plan.when.time, ...(plan.when.repeat === 'once' ? { date: plan.when.date } : {}), ...(plan.when.repeat === 'weekly' ? { weekday: Number(plan.when.weekday) } : {}) };
    const target = plan.target.type === 'card' ? plan.target : { type: 'prompt', text: plan.text, agent: plan.agent, folderId: plan.folderId };
    act(plan.id ? `/api/board/schedules/${plan.id}/edit` : '/api/board/schedules', { target, when: time, runLate: plan.runLate, ...(target.type === 'prompt' ? { title: plan.title } : {}) }, result => { api.announce(`Scheduled: ${describe(result.schedule.when)}.`); leaveSchedule(); });
  }

  function renderDrawer() {
    const aside = $('board-drawer'), body = $('board-drawer-body');
    if (!selected || (!['new', 'run', 'schedules', 'schedule'].includes(selected) && !cardBy(selected))) { aside.hidden = true; body.replaceChildren(); drawn = null; if (selected && !cardBy(selected)) { selected = null; draft = null; } return; }
    aside.hidden = false;
    const card = cardBy(selected);
    // An untouched draft follows the card when it changes elsewhere; one you're editing waits for Save.
    if (card && draft && !dirty() && draft.revision !== card.revision) draft = editable(card);
    // A schedule being written is drawn again only when its kind of time changes, so typing keeps its place.
    if (card) readComments(card.id);
    const key = JSON.stringify([selected, card && [card.column, card.revision, card.reason, card.taskState, card.result, card.acceptedAt, card.attempts?.length, card.priority, card.labels, card.due, card.checks, card.commentCount, threads.get(card.id)?.length ?? null, schedulesOf(card)], selected === 'run' ? [...picked] : null, selected === 'run' ? cards().map(item => [item.id, item.column, item.agent?.provider, item.dependsOn]) : null, selected === 'schedules' ? schedules() : null, selected === 'schedule' ? [sdraft?.id, sdraft?.when.repeat, sdraft?.target] : null, busy]);
    if (key === drawn) { changed(); return; }
    drawn = key;
    if (selected === 'run') { $('board-drawer-title').textContent = 'Run Ready cards'; body.replaceChildren(...runPanel()); return; }
    if (selected === 'schedules') { $('board-drawer-title').textContent = 'Schedules'; body.replaceChildren(...schedulesPanel()); return; }
    if (selected === 'schedule') { if (!sdraft) { selected = 'schedules'; drawn = null; renderDrawer(); return; } $('board-drawer-title').textContent = sdraft.id ? 'Edit schedule' : 'New schedule'; body.replaceChildren(...scheduleForm()); return; }
    $('board-drawer-title').textContent = selected === 'new' ? `New card · ${COLUMNS.find(([id]) => id === draft.column)[1]}` : `${COLUMNS.find(([id]) => id === card.column)[1]}${card.agent ? ` · ${AGENT[card.agent.provider]}` : ''}`;
    // Someone writing a comment keeps their place when the drawer is drawn again.
    const writing = ['board-comment-input', 'board-comment-send'].some(name => document.activeElement?.classList?.contains(name)) && body.contains(document.activeElement);
    body.replaceChildren(...(card ? [...status(card), actions(card), ...cardSchedules(card)] : []), ...editor(card), ...(card ? [...commentsPanel(card), ...history(card)] : []));
    if (writing) { const box = body.querySelector('.board-comment-input'); box?.focus(); box?.setSelectionRange?.(box.value.length, box.value.length); }
    changed();
  }
  function showError() { $('board-error').textContent = failure; $('board-error').hidden = !failure; }

  // ---- The canvas (#97)
  // A world of cards at their saved places, moved and scaled as one by the camera: screen = world × zoom + offset. A card
  // nobody has placed yet is laid out by what it waits for, below the placed ones, and stays there until it's dragged.
  const SVG = 'http://www.w3.org/2000/svg', WIDTH = 220, FALLBACK = 88, STEP_X = 290, GAP_Y = 22, ZOOM = [0.25, 2];
  const frame = fn => (window.requestAnimationFrame ? window.requestAnimationFrame(fn) : fn());
  // camera: { x, y, z }, null until the canvas is first shown, when it fits the cards. heights: each card's last measured
  // height. gesture: a drag, a pan or a new arrow in progress. picked: the arrow chosen, as [from, to]. moved: the card
  // just dragged, whose click that ends the drag isn't a selection. undos and redos: what Undo and Redo do, newest last.
  let camera = null, heights = new Map(), gesture = null, picked$ = null, moved = null, stale = false, undos = [], redos = [];
  const space = $('board-space');
  const svg = tag => document.createElementNS ? document.createElementNS(SVG, tag) : document.createElement(tag);
  const height = id => heights.get(id) || FALLBACK;
  const title = id => `“${cardBy(id)?.title || 'a card'}”`;

  // How deep each card sits in its chain of waits, among the given cards only.
  function layout(list, top, left) {
    const own = new Map(list.map(card => [card.id, card])), depth = new Map(), rows = new Map(), out = new Map();
    const deep = (id, trail) => {
      if (depth.has(id)) return depth.get(id);
      if (trail.has(id)) return 0; trail.add(id);
      const value = Math.max(-1, ...(own.get(id).dependsOn || []).filter(other => own.has(other)).map(other => deep(other, trail))) + 1;
      depth.set(id, value); return value;
    };
    // Cards in a chain stand in a column per step of it; cards with no arrows at all fill a grid below, so a board of
    // unconnected cards doesn't become one long column.
    const linked = new Set(list.flatMap(card => { const waits = (card.dependsOn || []).filter(id => own.has(id)); return waits.length ? [card.id, ...waits] : []; }));
    const chained = list.filter(card => linked.has(card.id)), single = list.filter(card => !linked.has(card.id));
    for (const card of chained) {
      const level = deep(card.id, new Set()), y = rows.get(level) ?? top;
      out.set(card.id, { x: left + level * STEP_X, y }); rows.set(level, y + height(card.id) + GAP_Y);
    }
    const across = Math.max(4, rows.size), start = chained.length ? Math.max(...rows.values()) + 60 : top;
    let y = start;
    for (let first = 0; first < single.length; first += across) {
      const line = single.slice(first, first + across);
      line.forEach((card, index) => out.set(card.id, { x: left + index * (WIDTH + 30), y }));
      y += Math.max(...line.map(card => height(card.id))) + GAP_Y;
    }
    return out;
  }
  function places() {
    const all = cards(), placed = all.filter(card => card.at), out = new Map(placed.map(card => [card.id, { x: card.at.x, y: card.at.y }]));
    const loose = all.filter(card => !card.at);
    if (loose.length) {
      const top = placed.length ? Math.max(...placed.map(card => card.at.y + height(card.id))) + 80 : 0, left = placed.length ? Math.min(...placed.map(card => card.at.x)) : 0;
      for (const [id, at] of layout(loose, top, left)) out.set(id, at);
    }
    if (gesture?.kind === 'move') out.set(gesture.id, gesture.at);
    return out;
  }
  const toWorld = (event, rect = space.getBoundingClientRect()) => ({ x: (event.clientX - rect.left - camera.x) / camera.z, y: (event.clientY - rect.top - camera.y) / camera.z });
  const cardAt = (point, at, skip) => [...cards()].reverse().find(card => { const p = at.get(card.id); return card.id !== skip && p && point.x >= p.x && point.x <= p.x + WIDTH && point.y >= p.y && point.y <= p.y + height(card.id); });

  function aim() {
    const world = space.querySelector('.board-world'); if (!world || !camera) return;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`;
    const zoom = space.querySelector('.board-zoom-level'); if (zoom) zoom.textContent = `${Math.round(camera.z * 100)}%`;
    space.style.backgroundSize = `${18 * camera.z}px ${18 * camera.z}px`; space.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
  }
  function fit() {
    const rect = space.getBoundingClientRect(), at = places(), all = cards();
    if (!all.length || !rect.width) { camera = { x: 40, y: 40, z: 1 }; aim(); return; }
    const xs = all.map(card => at.get(card.id).x), ys = all.map(card => at.get(card.id).y);
    const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs) + WIDTH, bottom = Math.max(...all.map(card => at.get(card.id).y + height(card.id)));
    const z = Math.max(ZOOM[0], Math.min(1, (rect.width - 80) / (right - left), (rect.height - 120) / (bottom - top)));
    camera = { x: (rect.width - (right - left) * z) / 2 - left * z, y: Math.max(40, (rect.height - 60 - (bottom - top) * z) / 2) - top * z, z };
    aim();
  }
  function zoom(factor, around = null) {
    const rect = space.getBoundingClientRect(), point = around || { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const z = Math.max(ZOOM[0], Math.min(ZOOM[1], camera.z * factor)), sx = point.clientX - rect.left, sy = point.clientY - rect.top;
    camera = { x: sx - (sx - camera.x) * z / camera.z, y: sy - (sy - camera.y) * z / camera.z, z };
    aim();
    if (picked$) drawLinks();
  }

  // An arrow from the card waited for to the card that waits, leaving one's right edge and entering the other's left.
  function curve(from, to, fromHeight, toHeight) {
    const x0 = from.x + WIDTH, y0 = from.y + fromHeight / 2, x3 = to.x, y3 = to.y + toHeight / 2, bend = Math.max(40, Math.abs(x3 - x0) / 2);
    return { d: `M${x0} ${y0} C${x0 + bend} ${y0} ${x3 - bend} ${y3} ${x3} ${y3}`, mid: { x: (x0 + x3) / 2, y: (y0 + y3) / 2 } };
  }
  function links() {
    const out = [];
    for (const card of cards()) for (const from of card.dependsOn || []) if (cardBy(from)) out.push([from, card.id]);
    return out;
  }
  function drawLinks(at = places()) {
    const layer = space.querySelector('.board-links'); if (!layer) return;
    const head = svg('marker'); head.setAttribute('id', 'board-link-head'); head.setAttribute('viewBox', '0 0 8 8'); head.setAttribute('refX', '7'); head.setAttribute('refY', '4');
    head.setAttribute('markerWidth', '8'); head.setAttribute('markerHeight', '8'); head.setAttribute('orient', 'auto-start-reverse');
    const tip = svg('path'); tip.setAttribute('d', 'M0 0L8 4L0 8z'); head.append(tip);
    const defs = svg('defs'); defs.append(head);
    const drawn$ = [defs];
    for (const [from, to] of links()) {
      const line = curve(at.get(from), at.get(to), height(from), height(to)), done = cardBy(from).column === 'done';
      const chosen = picked$ && picked$[0] === from && picked$[1] === to, related = selected === from || selected === to;
      const path = svg('path'); path.setAttribute('d', line.d); path.setAttribute('marker-end', 'url(#board-link-head)'); path.dataset.from = from; path.dataset.to = to;
      path.setAttribute('class', `board-link${done ? ' done' : ''}${related ? ' related' : ''}${chosen ? ' picked' : ''}${filter && !(shown(cardBy(from)) && shown(cardBy(to))) ? ' faded' : ''}`);
      // A wider, invisible line over it is what the pointer catches.
      const hit = svg('path'); hit.setAttribute('d', line.d); hit.setAttribute('class', 'board-link-hit'); hit.dataset.from = from; hit.dataset.to = to;
      const tooltip = svg('title'); tooltip.textContent = `${title(to)} waits for ${title(from)}`; hit.append(tooltip);
      hit.addEventListener('pointerdown', event => { event.stopPropagation?.(); });
      hit.addEventListener('click', event => { event.stopPropagation?.(); picked$ = chosen ? null : [from, to]; drawLinks(); });
      drawn$.push(path, hit);
    }
    // An arrow being drawn is its own line (startLink), kept across a redraw.
    const drafting = gesture?.kind === 'link' ? [...layer.children].filter(line => line.getAttribute?.('class')?.includes('drafting')) : [];
    layer.replaceChildren(...drawn$, ...drafting);
    // The chosen arrow gets a button at its middle to take it away.
    space.querySelector('.board-link-remove')?.remove();
    if (picked$ && cardBy(picked$[0]) && cardBy(picked$[1])?.dependsOn?.includes(picked$[0])) {
      const [from, to] = picked$, mid = curve(at.get(from), at.get(to), height(from), height(to)).mid;
      const remove = button('×', () => disconnect(from, to), 'icon-button board-link-remove');
      remove.setAttribute('aria-label', `Stop ${title(to)} waiting for ${title(from)}`); remove.title = `Stop ${title(to)} waiting for ${title(from)} (Delete)`;
      // Kept the same size at any zoom, so it's always easy to hit.
      remove.style.transform = `translate(${mid.x}px, ${mid.y}px) scale(${1 / (camera?.z || 1)}) translate(-50%, -50%)`;
      space.querySelector('.board-world').append(remove);
    } else picked$ = null;
  }

  function tools() {
    const bar = node('div', 'board-canvas-tools'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Canvas');
    const tool = (text, label, handler, cls = '') => { const value = button(text, handler, `board-tool ${cls}`.trim()); value.setAttribute('aria-label', label); value.title = label; return value; };
    const undo = tool('Undo', `Undo${undos.length ? `: ${undos.at(-1).label}` : ''} (⌘Z)`, () => step(undos, redos)), redo = tool('Redo', `Redo${redos.length ? `: ${redos.at(-1).label}` : ''} (⇧⌘Z)`, () => step(redos, undos));
    undo.disabled = !undos.length; redo.disabled = !redos.length;
    const level = tool('100%', 'Zoom to 100%', () => { zoom(1 / camera.z); }, 'board-zoom-level');
    bar.append(undo, redo, node('span', 'board-tool-gap'), tool('−', 'Zoom out', () => zoom(1 / 1.2)), level, tool('+', 'Zoom in', () => zoom(1.2)), tool('Fit', 'Fit the cards in view', fit), node('span', 'board-tool-gap'), tool('Arrange', 'Lay every card out by what it waits for', arrange));
    return bar;
  }
  // A card on the canvas is built again only when something it shows changes; the rest keep their elements, so a board of
  // a few hundred cards redraws in a few milliseconds when one changes (#97). Its place isn't part of this: it's only where
  // the element is moved to.
  let world$ = null, built = new Map();
  const nodeKey = card => JSON.stringify([{ ...card, at: undefined }, selected === card.id, filter, schedulesOf(card), (card.dependsOn || []).map(id => { const other = cardBy(id); return other ? [other.title, other.column] : null; }), today()]);
  function canvasNode(card) {
    // A card without the chosen label stays in its place, faded, so the arrows around it still make sense.
    const item = node('div', `board-node${shown(card) ? '' : ' faded'}`); item.dataset.card = card.id;
    const face = cardButton(card, true);
    face.addEventListener('pointerdown', event => startMove(event, card.id));
    face.addEventListener('keydown', event => nudge(event, card.id));
    face.setAttribute('aria-describedby', 'board-canvas-keys');
    // The dot on the right edge starts an arrow to a card that will wait for this one.
    const port = node('span', 'board-port'); port.setAttribute('aria-hidden', 'true'); port.title = 'Drag to a card that should wait for this one';
    port.addEventListener('pointerdown', event => startLink(event, card.id));
    item.append(face, port);
    return item;
  }
  function drawSpace() {
    // A drag keeps its cards under the pointer: anything that arrives meanwhile is drawn when it ends.
    if (gesture) { stale = true; return; }
    stale = false;
    // The frame is made once, and again only if something else took the canvas's place (a loading or error message).
    if (!world$ || world$.parentNode !== space) {
      world$ = node('div', 'board-world'); built = new Map();
      const layer = svg('svg'); layer.setAttribute('class', 'board-links'); layer.setAttribute('aria-hidden', 'true'); layer.setAttribute('width', '1'); layer.setAttribute('height', '1');
      world$.append(layer);
      // The keyboard way to do what dragging does, read with each card (#26).
      const keys = node('p', 'sr-only', `${altKey} and the arrow keys move this card. Open it to choose which cards it waits for.`); keys.id = 'board-canvas-keys';
      space.replaceChildren(world$, tools(), node('p', 'board-canvas-hint', `Drag a card to place it, or use ${altKey} and the arrow keys. Drag its dot onto another card to make that card wait. Double-click to add a card.`), keys);
    } else space.querySelector('.board-canvas-tools')?.replaceWith(tools());
    const world = world$, fresh = [], present = new Set();
    for (const card of cards()) {
      const key = nodeKey(card), had = built.get(card.id);
      present.add(card.id);
      if (had?.key === key) continue;
      const item = canvasNode(card);
      if (had) had.item.replaceWith(item); else world.append(item);
      built.set(card.id, { key, item }); fresh.push(item);
    }
    for (const [id, had] of built) if (!present.has(id)) { had.item.remove(); built.delete(id); }
    const at = places();
    for (const [id, { item }] of built) { const place = at.get(id); item.style.transform = `translate(${place.x}px, ${place.y}px)`; }
    space.querySelector('.board-canvas-empty')?.remove();
    if (!cards().length) space.append(node('p', 'board-canvas-empty', 'No cards yet. Double-click anywhere to add one, or use New card.'));
    frame(() => {
      // Only cards just built can have changed height.
      let changed = false;
      for (const item of fresh) { if (!item.parentNode) continue; const measured = item.offsetHeight; if (measured && measured !== heights.get(item.dataset.card)) { heights.set(item.dataset.card, measured); changed = true; } }
      if (!camera) fit(); else aim();
      // Cards not placed yet sit by their heights: once those are known, they're drawn again where they belong.
      if (changed && cards().some(card => !card.at)) { const again = places(); for (const item of world.querySelectorAll('.board-node')) { const p = again.get(item.dataset.card); if (p) item.style.transform = `translate(${p.x}px, ${p.y}px)`; } drawLinks(again); }
      else drawLinks(at);
    });
  }

  // ---- Gestures
  function follow(onMove, onEnd) {
    const move = event => onMove(event), end = event => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); onEnd(event); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  function startMove(event, id) {
    if (event.button !== 0 || gesture) return;
    const at = places(), start = at.get(id), origin = toWorld(event);
    // Only this card moves, so only its own arrows are drawn again on each move, from the places when the drag began.
    const item = built.get(id)?.item || space.querySelector(`.board-node[data-card="${id}"]`);
    const own = [...(space.querySelector('.board-links')?.children || [])].filter(line => line.dataset?.from === id || line.dataset?.to === id);
    gesture = { kind: 'move', id, at: { ...start }, start, moved: false };
    follow(next => {
      const point = toWorld(next), x = Math.round(start.x + point.x - origin.x), y = Math.round(start.y + point.y - origin.y);
      if (!gesture.moved && Math.hypot(x - start.x, y - start.y) < 4) return;
      gesture.moved = true; gesture.at = { x, y }; at.set(id, gesture.at);
      if (item) { item.style.transform = `translate(${x}px, ${y}px)`; item.classList.add('moving'); }
      for (const line of own) line.setAttribute('d', curve(at.get(line.dataset.from), at.get(line.dataset.to), height(line.dataset.from), height(line.dataset.to)).d);
      if (picked$?.includes(id)) space.querySelector('.board-link-remove')?.remove();
    }, () => {
      const done = gesture; gesture = null;
      space.querySelector('.board-node.moving')?.classList.remove('moving');
      if (!done.moved) { if (stale) drawSpace(); return; }
      moved = id; setTimeout(() => { if (moved === id) moved = null; }, 0);
      const before = cardBy(id)?.at || null;
      record(`Move ${title(id)}`, { [id]: before }, { [id]: done.at });
      place({ [id]: done.at });
    });
  }
  function startLink(event, from) {
    if (event.button !== 0 || gesture) return;
    event.preventDefault(); event.stopPropagation?.();
    gesture = { kind: 'link', from, to: null, over: null };
    // The new arrow is one line that follows the pointer; the others stay as they are until it's dropped.
    const at = places(), layer = space.querySelector('.board-links'), line = svg('path');
    line.setAttribute('class', 'board-link drafting'); line.setAttribute('marker-end', 'url(#board-link-head)');
    follow(next => {
      gesture.to = toWorld(next);
      const over = cardAt(gesture.to, at, from)?.id || null;
      if (over !== gesture.over) { space.querySelector('.board-node.link-target')?.classList.remove('link-target'); if (over) space.querySelector(`.board-node[data-card="${over}"]`)?.classList.add('link-target'); gesture.over = over; }
      const start = at.get(from), end = gesture.to, x0 = start.x + WIDTH, y0 = start.y + height(from) / 2, bend = Math.max(40, Math.abs(end.x - x0) / 2);
      line.setAttribute('d', `M${x0} ${y0} C${x0 + bend} ${y0} ${end.x - bend} ${end.y} ${end.x} ${end.y}`);
      if (!line.parentNode) layer?.append(line);
    }, () => {
      line.remove();
      const target = gesture.over; gesture = null;
      space.querySelector('.board-node.link-target')?.classList.remove('link-target');
      if (target) connect(from, target); else if (stale) drawSpace(); else drawLinks();
    });
  }
  function startPan(event) {
    if (event.button !== 0 || gesture || event.target.closest?.('.board-node, .board-canvas-tools, .board-link-remove')) return;
    const origin = { x: event.clientX, y: event.clientY, cx: camera.x, cy: camera.y };
    gesture = { kind: 'pan' }; space.classList.add('panning');
    if (picked$) { picked$ = null; drawLinks(); }
    follow(next => { camera = { ...camera, x: origin.cx + next.clientX - origin.x, y: origin.cy + next.clientY - origin.y }; aim(); }, () => { gesture = null; space.classList.remove('panning'); if (stale) drawSpace(); });
  }
  // Alt and an arrow key move the focused card, for those who'd rather not drag.
  function nudge(event, id) {
    const by = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (!by || !event.altKey) return;
    event.preventDefault();
    const from = places().get(id), to = { x: from.x + by[0], y: from.y + by[1] };
    record(`Move ${title(id)}`, { [id]: cardBy(id)?.at || null }, { [id]: to });
    place({ [id]: to });
  }

  // ---- Changes, and undoing them
  // Canvas changes show at once and are saved behind; one that fails reloads the board as it is.
  async function quietly(path, input) {
    const request = ++written; writes++; failure = '';
    try { const result = await api.post(path, input); writes--; if (request === written && result.board) { board = result.board; render(); } return true; }
    catch (error) { writes--; failure = error.message; showError(); await load(); return false; }
  }
  function place(positions) {
    for (const [id, at] of Object.entries(positions)) { const card = cardBy(id); if (card) card.at = at; }
    render();
    return quietly('/api/board/place', { positions });
  }
  // Waits are part of what an agent is told, so they change through the card's own edit, which checks for circles.
  function setWaits(id, change) {
    const card = cardBy(id); if (!card) return Promise.resolve(false);
    const dependsOn = change(card.dependsOn || []);
    card.dependsOn = dependsOn; render();
    return quietly(`/api/board/cards/${id}/edit`, { dependsOn, revision: card.revision });
  }
  async function connect(from, to) {
    const card = cardBy(to);
    if (!card || card.dependsOn?.includes(from)) { drawSpace(); return; }
    if (card.column === 'doing') { failure = `An agent is working on ${title(to)}. Stop it before changing what it waits for.`; showError(); drawSpace(); return; }
    if (await setWaits(to, waits => [...waits, from])) { record(`${title(to)} waits for ${title(from)}`, null, null, { undo: () => setWaits(to, waits => waits.filter(id => id !== from)), redo: () => setWaits(to, waits => [...new Set([...waits, from])]) }); api.announce(`${title(to)} now waits for ${title(from)}.`); }
  }
  async function disconnect(from, to) {
    picked$ = null;
    if (cardBy(to)?.column === 'doing') { failure = `An agent is working on ${title(to)}. Stop it before changing what it waits for.`; showError(); drawSpace(); return; }
    if (await setWaits(to, waits => waits.filter(id => id !== from))) { record(`${title(to)} stops waiting for ${title(from)}`, null, null, { undo: () => setWaits(to, waits => [...new Set([...waits, from])]), redo: () => setWaits(to, waits => waits.filter(id => id !== from)) }); api.announce(`${title(to)} no longer waits for ${title(from)}.`); }
  }
  function arrange() {
    const all = cards(); if (!all.length) return;
    const before = Object.fromEntries(all.map(card => [card.id, card.at || null])), after = Object.fromEntries([...layout(all, 0, 0)].map(([id, at]) => [id, at]));
    record('Arrange', before, after);
    place(after).then(() => fit());
  }
  // A move undoes to the places before it; an arrow undoes with its own pair of changes.
  function record(label, before, after, own = null) {
    undos.push(own ? { label, ...own } : { label, undo: () => place(before), redo: () => place(after) });
    if (undos.length > 100) undos.shift();
    redos = []; refreshTools();
  }
  async function step(from, to) {
    const entry = from.pop(); if (!entry) return;
    const ok = await (from === undos ? entry.undo() : entry.redo());
    if (ok !== false) { to.push(entry); api.announce(`${from === undos ? 'Undone' : 'Redone'}: ${entry.label}.`); }
    refreshTools();
  }
  function refreshTools() {
    const bar = space.querySelector('.board-canvas-tools');
    if (!bar || view !== 'canvas') return;
    bar.replaceWith(tools()); aim();
  }

  function showView(next) {
    view = next; try { localStorage.setItem(VIEW_KEY, next); } catch {}
    for (const [id, mode] of [['board-columns-mode', 'columns'], ['board-canvas-mode', 'canvas']]) $(id)?.setAttribute('aria-pressed', String(view === mode));
    picked$ = null; render();
  }
  async function exportBoard() {
    try {
      const result = await api.api('/api/board/export'), url = URL.createObjectURL(new Blob([result.markdown], { type: 'text/markdown' })), link = document.createElement('a');
      link.href = url; link.download = result.filename || 'codeshi-board.md'; document.body?.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      api.announce('Board saved as Markdown.');
    } catch (error) { failure = error.message; showError(); }
  }

  function render() {
    if (!dialog.open) { entry(); return; }
    const onCanvas = view === 'canvas';
    $('board-canvas').classList.toggle('canvas-mode', onCanvas); $('board-columns').hidden = onCanvas; space.hidden = !onCanvas;
    for (const [id, mode] of [['board-columns-mode', 'columns'], ['board-canvas-mode', 'canvas']]) $(id)?.setAttribute('aria-pressed', String(view === mode));
    if (!board) { const message = node('p', 'plan-view-empty', failure ? `The board couldn’t be loaded. ${failure}` : 'Loading the board…'); (onCanvas ? space : $('board-columns')).replaceChildren(message); return; }
    drawFilter();
    const ready = cards().filter(card => card.column === 'ready');
    $('board-run-ready').disabled = busy || !ready.some(card => card.agent);
    $('board-run-ready').title = ready.length ? 'Choose Ready cards to run' : 'Nothing is in Ready';
    const timed = $('board-schedules'), waitingFor = schedules().filter(item => item.missed).length, active = schedules().filter(item => !item.paused && item.nextAt).length;
    if (timed) { const count = $('board-schedules-count'); count.textContent = String(waitingFor || active || ''); count.hidden = !(waitingFor || active); timed.dataset.state = waitingFor ? 'missed' : ''; timed.title = waitingFor ? `${plural(waitingFor, 'scheduled run')} didn’t start` : active ? `${plural(active, 'schedule')} waiting` : 'Run a card or a prompt at a set time'; }
    // Typing keeps its place: the columns are drawn again only when the cards change.
    const where = onCanvas ? space : $('board-columns'), focused = document.activeElement?.closest?.(onCanvas ? '#board-space' : '#board-columns') ? document.activeElement.dataset?.card : null;
    if (onCanvas) drawSpace(); else drawColumns();
    if (focused) where.querySelector(`.board-card[data-card="${focused}"]`)?.focus();
    renderDrawer(); showError(); entry();
  }
  // The label filter appears once a card has a label. A label no card has any more stops being the filter.
  function drawFilter() {
    const pick = $('board-label-filter'); if (!pick) return;
    const labels = allLabels();
    if (filter && !labels.some(item => item.name.toLowerCase() === filter)) filter = '';
    pick.hidden = !labels.length && !filter;
    pick.classList.toggle('active', Boolean(filter));
    const want = JSON.stringify([labels, filter]);
    if (pick.dataset.drawn === want) return;
    const option = (value, text) => { const item = node('option', '', text); item.value = value; return item; };
    pick.replaceChildren(option('', 'All labels'), ...labels.map(item => option(item.name.toLowerCase(), `${item.name} (${item.count})`)));
    pick.value = filter; pick.dataset.drawn = want;
  }
  $('board-label-filter')?.addEventListener('change', () => {
    filter = $('board-label-filter').value; render();
    const name = allLabels().find(item => item.name.toLowerCase() === filter)?.name, count = cards().filter(shown).length;
    api.announce(filter ? `Showing ${plural(count, 'card')} labelled ${name}.` : 'Showing every card.');
  });

  // The Board button says how many cards wait for you in Review.
  function entry() {
    const button = $('open-board'); if (!button) return;
    button.disabled = !api.getState().projectId;
    const waiting = cards().filter(card => card.column === 'review').length, badge = $('open-board-state');
    if (badge) { badge.textContent = waiting ? String(waiting) : ''; badge.hidden = !waiting; }
    button.title = waiting ? `Board: ${plural(waiting, 'card')} to review` : 'Board: cards for this workspace, run by hand';
  }

  function open() {
    if (dialog.open || !api.getState().projectId) return;
    selected = null; draft = null; failure = ''; drawn = null;
    dialog.showModal(); render(); load().then(() => (view === 'canvas' ? space : $('board-columns')).querySelector('.board-card')?.focus());
  }
  dialog.addEventListener('cancel', event => {
    if (picked$) { event.preventDefault(); picked$ = null; drawLinks(); }
    else if (selected) { event.preventDefault(); closeDrawer(); } else if (dirty()) event.preventDefault();
  });
  $('board-columns-mode')?.addEventListener('click', () => showView('columns'));
  $('board-canvas-mode')?.addEventListener('click', () => showView('canvas'));
  $('board-export')?.addEventListener('click', exportBoard);
  // The canvas: drag empty space to pan, scroll to pan, pinch or ⌘-scroll to zoom, double-click for a new card there.
  const onCard = event => event.target?.closest?.('.board-node') || event.target?.closest?.('.board-canvas-tools') || event.target?.closest?.('.board-link-remove');
  space.addEventListener('pointerdown', startPan);
  space.addEventListener('wheel', event => {
    if (!camera) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY * 0.01), event);
    else { camera = { ...camera, x: camera.x - event.deltaX, y: camera.y - event.deltaY }; aim(); }
  }, { passive: false });
  space.addEventListener('dblclick', event => {
    if (!camera || onCard(event)) return;
    const point = toWorld(event);
    openNew('backlog', { x: Math.round(point.x - WIDTH / 2), y: Math.round(point.y - 20) });
  });
  // ⌘Z and ⇧⌘Z undo and redo canvas changes; Delete takes away the chosen arrow. Typing in a field keeps its own undo.
  dialog.addEventListener('keydown', event => {
    if (view !== 'canvas' || !board) return;
    const target = event.target, typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable || target?.closest?.('#board-drawer');
    if (typing) return;
    const key = String(event.key || '').toLowerCase(), command = event.metaKey || event.ctrlKey;
    if (command && key === 'z') { event.preventDefault(); if (event.shiftKey) step(redos, undos); else step(undos, redos); }
    else if (command && key === 'y') { event.preventDefault(); step(redos, undos); }
    else if ((key === 'delete' || key === 'backspace') && picked$) { event.preventDefault(); disconnect(...picked$); }
  });
  dialog.addEventListener('close', () => { selected = null; draft = null; sdraft = null; drawn = null; entry(); });
  $('board-close').addEventListener('click', () => { if (!dirty() || window.confirm('Leave this card without saving your changes?')) { selected = null; draft = null; dialog.close(); } });
  $('board-drawer-close').addEventListener('click', closeDrawer);
  $('board-new').addEventListener('click', () => openNew('backlog'));
  $('board-run-ready').addEventListener('click', openRun);
  $('board-schedules')?.addEventListener('click', () => { if (selected === 'schedules') { closeDrawer(); return; } if (selected && dirty() && !window.confirm('Leave this card without saving your changes?')) return; selected = 'schedules'; draft = null; sdraft = null; failure = ''; drawn = null; render(); });
  $('open-board')?.addEventListener('click', open);
  // The board is read again when its cards or their tasks change: the workspace chat says when, and so do the tasks.
  let project = null;
  window.addEventListener('relay-state', () => {
    const state = api.getState();
    if (state.projectId !== project) { project = state.projectId; board = null; seen = null; camera = null; heights = new Map(); undos = []; redos = []; picked$ = null; filter = ''; threads = new Map(); asked = new Map(); said = new Map(); if (dialog.open) dialog.close(); }
    const key = JSON.stringify([state.projectId, state.conversation?.boardRevision, (state.conversation?.parallelTasks || []).map(task => [task.id, task.status, task.approvals, task.hasWorktree])]);
    if (key === seen) { entry(); return; }
    seen = key;
    if (state.projectId) load(); else entry();
  });
  window.relayBoard = { open, close: () => { if (dialog.open) dialog.close(); }, isOpen: () => dialog.open, reload: load };
})();

// The task board (#132, first stage), full window, opened by Board beside Plan. A workspace's cards in five columns:
// Backlog and Ready are yours to fill and order (drag a card, or use the buttons in its drawer); Doing and Review follow the
// task a card started; Done is what you accepted. Selecting a card opens it in a drawer to edit and act on. Run Ready opens
// the same drawer with the Ready cards to choose from, and runs exactly the ones ticked.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('board-view'), api = window.relayUI;
  if (!dialog || !api) return;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'secondary-button') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
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
  const when = iso => { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

  // board: the last answer from the server. selected: the card in the drawer, 'new' for a new one, 'run' for Run Ready.
  // draft: what the drawer edits, kept apart so a refresh never overwrites typing. picked: the cards ticked in Run Ready.
  // seen: what the board was last loaded for; cleared when a load fails, so the next update tries again.
  let seen = null, board = null, selected = null, draft = null, picked = new Set(), failure = '', busy = false, loading = 0, drawn = null, dragging = null;
  const cards = () => board?.cards || [];
  const cardBy = id => cards().find(card => card.id === id);
  const folderName = id => board?.folders.find(folder => folder.id === id)?.name || '';

  async function load() {
    if (!api.getState().projectId) return;
    const request = ++loading;
    try { const result = await api.api('/api/board'); if (request === loading) { board = result; render(); } }
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
  function cardButton(card) {
    const item = node('button', 'board-card'); item.type = 'button';
    item.dataset.card = card.id; item.dataset.column = card.column; item.dataset.priority = card.priority;
    item.setAttribute('aria-pressed', String(selected === card.id));
    const state = stateOf(card), top = node('span', 'board-card-top');
    if (card.priority !== 'normal') top.append(node('span', `board-priority ${card.priority}`, card.priority === 'high' ? 'High' : 'Low'));
    if (state) { const badge = node('span', 'board-card-state', state.text); badge.dataset.tone = state.tone; top.append(badge); }
    const title = node('span', 'board-card-title', card.title);
    const meta = node('span', 'board-card-meta'), provider = card.taskState?.provider || card.agent?.provider;
    const icon = node('i', `agent-icon ${provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true');
    meta.append(icon, node('span', provider ? 'board-card-agent' : 'board-card-missing', provider ? AGENT[provider] : 'No agent yet'));
    if (card.checks?.length) meta.append(node('span', 'board-card-checks', `${card.checks.filter(item => item.done).length}/${card.checks.length}`));
    const after = (card.dependsOn || []).map(cardBy).filter(item => item && item.column !== 'done');
    if (after.length && ['backlog', 'ready'].includes(card.column)) meta.append(node('span', 'board-card-after', `After ${after.map(item => item.title).join(', ')}`));
    item.append(top, title, meta);
    if (state?.detail && card.column === 'ready') item.append(node('span', 'board-card-reason', state.detail));
    item.title = state?.detail || card.title;
    item.setAttribute('aria-label', [card.title, card.priority !== 'normal' ? `${card.priority} priority` : '', provider ? AGENT[provider] : 'no agent yet', state?.text || '', state?.detail || ''].filter(Boolean).join('. '));
    item.addEventListener('click', () => select(card.id));
    // Backlog, Ready and Done cards can be dragged: between Backlog and Ready, back from Done, and into a new order.
    if (['backlog', 'ready', 'done'].includes(card.column)) {
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
      const column = node('section', 'board-column'), head = node('header', 'board-column-head'), list = node('div', 'board-column-cards'), own = cards().filter(card => card.column === id);
      column.dataset.column = id; column.setAttribute('aria-label', `${name}, ${plural(own.length, 'card')}`);
      head.append(node('span', 'board-column-name', name), node('span', 'board-column-count', String(own.length)));
      if (id === 'backlog' || id === 'ready') { const add = button('+', () => openNew(id), 'icon-button board-column-add'); add.setAttribute('aria-label', `New card in ${name}`); add.title = `New card in ${name}`; head.append(add); }
      list.append(...own.map(cardButton));
      if (!own.length) list.append(node('p', 'board-column-empty', hint));
      column.append(head, list);
      if (id === 'backlog' || id === 'ready') dropTarget(id, column, list);
      return column;
    }));
  }

  // ---- The drawer
  const blank = column => ({ title: '', notes: '', priority: 'normal', agent: null, folderId: null, dependsOn: [], checks: [], column, revision: null });
  const editable = card => ({ title: card.title, notes: card.notes || '', priority: card.priority, agent: card.agent ? { ...card.agent } : null, folderId: card.folderId || null, dependsOn: [...(card.dependsOn || [])], checks: (card.checks || []).map(item => ({ ...item })), column: card.column, revision: card.revision });
  const fields = value => JSON.stringify([value.title.trim(), value.notes.trim(), value.priority, value.agent?.provider || null, value.folderId, [...value.dependsOn].sort(), value.checks.map(item => [item.text.trim(), item.done])]);
  const dirty = () => { if (!draft) return false; if (selected === 'new') return Boolean(draft.title.trim() || draft.notes.trim()); const card = cardBy(selected); return card ? fields(draft) !== fields(editable(card)) : false; };
  function select(id) {
    if (selected && selected !== id && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = selected === id ? null : id; failure = '';
    draft = selected && cardBy(selected) ? editable(cardBy(selected)) : null; drawn = null;
    render();
    if (selected) $('board-drawer-body').querySelector('input, textarea, button')?.focus();
  }
  function openNew(column = 'backlog') {
    if (selected && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = 'new'; draft = blank(column); failure = ''; drawn = null; render();
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
    const input = { title: draft.title, notes: draft.notes, priority: draft.priority, agent: draft.agent, folderId: draft.folderId, dependsOn: draft.dependsOn, checks: draft.checks.filter(item => item.text.trim()) };
    if (selected === 'new') act('/api/board/cards', { ...input, column: draft.column }, result => { selected = result.card.id; draft = editable(result.card); drawn = null; api.announce(`Added “${result.card.title}” to ${COLUMNS.find(([id]) => id === result.card.column)[1]}.`); });
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
      row.append(run, move('Move to Backlog', 'backlog'), remove);
    }
    if (card.column === 'doing') row.append(button('Open its task', () => openTask(card), 'primary-button'), button(card.taskState?.status === 'running' ? 'Stop' : 'Cancel', () => act(`/api/board/cards/${card.id}/stop`)));
    if (card.column === 'review') {
      const accept = button('Accept', () => act(`/api/board/cards/${card.id}/accept`, {}, () => api.announce(`“${card.title}” is done.`)), 'primary-button');
      if (card.taskState?.hasWorktree) { row.append(button('Review and merge', () => openTask(card), 'primary-button')); accept.className = 'secondary-button'; accept.disabled = true; accept.title = state?.detail || ''; }
      row.append(accept);
      if (!card.taskState?.hasWorktree) row.append(button('Send back…', () => sendBack(card)));
      if (card.taskState) row.append(button('Open its task', () => openTask(card), 'text-link'));
    }
    if (card.column === 'done') row.append(move('Reopen', 'ready'), remove);
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

  function renderDrawer() {
    const aside = $('board-drawer'), body = $('board-drawer-body');
    if (!selected || (selected !== 'new' && selected !== 'run' && !cardBy(selected))) { aside.hidden = true; body.replaceChildren(); drawn = null; if (selected && !cardBy(selected)) { selected = null; draft = null; } return; }
    aside.hidden = false;
    const card = cardBy(selected);
    // An untouched draft follows the card when it changes elsewhere; one you're editing waits for Save.
    if (card && draft && !dirty() && draft.revision !== card.revision) draft = editable(card);
    const key = JSON.stringify([selected, card && [card.column, card.revision, card.reason, card.taskState, card.result, card.acceptedAt, card.attempts?.length, card.priority, card.checks], selected === 'run' ? [...picked] : null, selected === 'run' ? cards().map(item => [item.id, item.column, item.agent?.provider, item.dependsOn]) : null, busy]);
    if (key === drawn) { changed(); return; }
    drawn = key;
    if (selected === 'run') { $('board-drawer-title').textContent = 'Run Ready cards'; body.replaceChildren(...runPanel()); return; }
    $('board-drawer-title').textContent = selected === 'new' ? `New card · ${COLUMNS.find(([id]) => id === draft.column)[1]}` : `${COLUMNS.find(([id]) => id === card.column)[1]}${card.agent ? ` · ${AGENT[card.agent.provider]}` : ''}`;
    body.replaceChildren(...(card ? [...status(card), actions(card)] : []), ...editor(card), ...(card ? history(card) : []));
    changed();
  }
  function showError() { $('board-error').textContent = failure; $('board-error').hidden = !failure; }

  function render() {
    if (!dialog.open) { entry(); return; }
    if (!board) { $('board-columns').replaceChildren(node('p', 'plan-view-empty', failure ? `The board couldn’t be loaded. ${failure}` : 'Loading the board…')); return; }
    const ready = cards().filter(card => card.column === 'ready');
    $('board-run-ready').disabled = busy || !ready.some(card => card.agent);
    $('board-run-ready').title = ready.length ? 'Choose Ready cards to run' : 'Nothing is in Ready';
    // Typing keeps its place: the columns are drawn again only when the cards change.
    const focused = document.activeElement?.closest?.('#board-columns') ? document.activeElement.dataset?.card : null;
    drawColumns();
    if (focused) $('board-columns').querySelector(`[data-card="${focused}"]`)?.focus();
    renderDrawer(); showError(); entry();
  }
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
    dialog.showModal(); render(); load().then(() => $('board-columns').querySelector('.board-card')?.focus());
  }
  dialog.addEventListener('cancel', event => { if (selected) { event.preventDefault(); closeDrawer(); } else if (dirty()) event.preventDefault(); });
  dialog.addEventListener('close', () => { selected = null; draft = null; drawn = null; entry(); });
  $('board-close').addEventListener('click', () => { if (!dirty() || window.confirm('Leave this card without saving your changes?')) { selected = null; draft = null; dialog.close(); } });
  $('board-drawer-close').addEventListener('click', closeDrawer);
  $('board-new').addEventListener('click', () => openNew('backlog'));
  $('board-run-ready').addEventListener('click', openRun);
  $('open-board')?.addEventListener('click', open);
  // The board is read again when its cards or their tasks change: the workspace chat says when, and so do the tasks.
  let project = null;
  window.addEventListener('relay-state', () => {
    const state = api.getState();
    if (state.projectId !== project) { project = state.projectId; board = null; seen = null; if (dialog.open) dialog.close(); }
    const key = JSON.stringify([state.projectId, state.conversation?.boardRevision, (state.conversation?.parallelTasks || []).map(task => [task.id, task.status, task.approvals, task.hasWorktree])]);
    if (key === seen) { entry(); return; }
    seen = key;
    if (state.projectId) load(); else entry();
  });
  window.relayBoard = { open, close: () => { if (dialog.open) dialog.close(); }, isOpen: () => dialog.open, reload: load };
})();

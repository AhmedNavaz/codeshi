(() => {
  'use strict';
  // Flow mode (#107): just the chat, with plain-language cards in the space either side. Each card reads what
  // Codeshi has already recorded, with no extra model call: how routing and handoff are working and what another
  // choice would change, what's left on each plan, the plan and the queue, and the files changed with Undo.
  // Entering hides the sidebar and the panels behind a short seal moment; leaving brings them back as they were.
  // Approvals, questions and Stop stay in the chat, so they are never hidden.
  const $ = id => document.getElementById(id), api = window.relayUI, shell = $('app-shell');
  const left = $('flow-left'), right = $('flow-right'), strip = $('flow-strip'), peek = $('flow-peek'), peekBody = $('flow-peek-body'), toggle = $('toggle-flow'), veil = $('flow-veil'), status = $('flow-status');
  if (!api || !shell || !left || !right || !strip || !peek || !toggle) return;
  const KEY = 'throughline:flow';
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* A convenience only. */ } };
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (cls, text, handler) => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const clip = (text, length) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > length ? value.slice(0, length - 1) + '…' : value; };
  const lower = text => text ? text.charAt(0).toLowerCase() + text.slice(1) : '';
  const agentNames = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const agentName = (provider, local = false) => local ? 'The local model' : agentNames[provider] || 'The agent';
  // The same three answers as the Agents panel, said in terms of what happens rather than which model does it. Flow
  // always routes, so there is no manual mode here; leaving Flow is how you choose the agent and model by hand.
  // Handoff follows the mode too, with no separate setting: the task moves to another agent at the mode's share of a limit.
  const modes = [
    { mode: 'saving', name: 'Cost saving', hint: 'Lighter models and agents with allowance left. Hands off at 80% of a limit.', does: 'Codeshi favors lighter models and agents with allowance left, and moves the task to another agent at 80% of a limit.', would: 'Codeshi would favor lighter models and agents with allowance left, moving the task on at 80% of a limit.' },
    { mode: 'balanced', name: 'Balanced', hint: 'The model and effort matched to each message. Hands off at 90%.', does: 'Codeshi matches the model and effort to each message, and moves the task to another agent at 90% of a limit.', would: 'Codeshi would match the model and effort to each message, moving the task on at 90% of a limit.' },
    { mode: 'quality', name: 'Maximum quality', hint: 'Stronger models and deeper reasoning. Hands off only at 95%.', does: 'Codeshi favors stronger models and deeper reasoning, and holds on until 95% of a limit before moving the task.', would: 'Codeshi would favor stronger models and deeper reasoning, moving the task on only at 95% of a limit.' },
  ];
  // The four cards, always present: each has a job, so none can be closed.
  const CARDS = [
    { id: 'working', title: 'How it’s working now', side: left },
    { id: 'plans', title: 'What’s left on your plans', side: left },
    { id: 'next', title: 'What’s next', side: right },
    { id: 'files', title: 'Files changed', side: right },
  ];
  let on = false, saved = null, pending = null, busy = false, focusConfirm = false, changeOpen = false, peeking = null, scheduled = false, ticker = null;
  let checkingMode = false, transitioning = false, restored = false;
  const LOCK_MESSAGE = 'Finish or stop workspace work, cancel its reset wait, or pause its queue before changing views.';
  function activityBusy(activity) { return activity?.busy === true || ['running', 'checking', 'reviewing', 'waiting', 'queued'].some(key => activity?.[key] > 0); }
  function lockReason() {
    const s = api.getState(), c = s.conversation;
    if (!s.projectId) return 'Open a workspace to use Flow.';
    if (!s.ready || s.loading || s.pending || s.settingsPending || s.taskDraft) return 'Finish the current action before changing views.';
    if (api.isRunning() || s.status?.runningConversationId || activityBusy(s.status?.workspaceActivity) || c?.resume || c?.limitSwitching ||
      c?.parallelTasks?.some(task => task.status === 'running' || task.status === 'waiting' && !task.held) ||
      c?.reviews?.some(review => review.status === 'running') || c?.runs?.some(run => run.check?.status === 'running') ||
      c?.queue?.length && !c.queuePaused) return LOCK_MESSAGE;
    return null;
  }
  const modeChanged = () => window.dispatchEvent(new CustomEvent('relay-flow', { detail: { on } }));
  const narrowQuery = window.matchMedia?.('(max-width: 1180px)') || null, narrow = () => Boolean(narrowQuery?.matches);
  const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const routing = () => api.getState().conversation?.routing || null;
  // Routing belongs to Flow (#12, #107): entering turns it on, with the mode this workspace last used in Flow or
  // Balanced, and leaving turns it off, so the normal view chooses the agent and model by hand. The choice is kept per browser.
  const ROUTING_KEY = id => `throughline:flow-routing:${id}`;
  let routingPending = false, routingReleasing = false;
  function rememberRouting() { const current = routing(), id = api.getState().projectId; if (current && id) write(ROUTING_KEY(id), JSON.stringify({ mode: current.mode, allowApi: current.allowApi === true, check: current.check === true })); }
  function savedRouting(id) { try { const saved = JSON.parse(read(ROUTING_KEY(id)) || 'null'); return saved && modes.some(option => option.mode === saved.mode) ? saved : null; } catch { return null; } }
  async function ensureRouting() {
    if (!on || routing() || routingPending || !api.getState().projectId) return;
    const choice = savedRouting(api.getState().projectId) || { mode: 'balanced', allowApi: false, check: false };
    routingPending = true; schedule();
    try { await api.setRouting({ mode: choice.mode, allowApi: choice.allowApi === true, check: choice.check === true }); }
    catch (error) { api.showNotice?.(`Flow could not turn routing on. ${error.message}`); }
    finally { routingPending = false; schedule(); }
  }
  // Outside Flow routing is off. A failure here is not reported: the next idle moment tries again.
  async function releaseRouting() {
    if (!routing() || routingReleasing) return;
    routingReleasing = true; rememberRouting();
    try { await api.setRouting({ mode: null }); } catch { /* Tried again when the workspace is idle. */ }
    finally { routingReleasing = false; schedule(); }
  }
  const sidePanels = ['agents', 'git', 'brief', 'tasks', 'timeline'];
  const openSidePanel = () => sidePanels.find(name => $(`${name}-panel`) && !$(`${name}-panel`).hidden) || null;
  const detail = $('flow-detail'), detailBody = $('flow-detail-body');
  let detailPanel = null, detailFocus = null, detailCard = null, detailScheduled = false, detailScope = null;
  const scope = () => `${api.getState().projectId || ''}:${api.getState().taskId || ''}`;
  const panelInfo = {
    agents: ['Your agents', 'What each agent has left, and how messages are routed. Handoff follows the routing mode.'],
    timeline: ['Your timeline', 'Explore saved checkpoints and preview a restore before changing files.'],
    git: ['Your changes', 'Review the workspace diff, stage files, and commit when ready.'],
    brief: ['Workspace context', 'The instructions and context your agents share.'],
    tasks: ['Your tasks', 'Review progress, usage, and limits across tasks.'],
    review: ['Code review', 'Feedback on a saved snapshot of your changes.'],
    phone: ['Remote access', 'Pick up the conversation on your phone, on the same Wi-Fi or away from home.'],
  };
  const panelAPI = name => { const key = { agents: 'relayAgents', timeline: 'relayTimeline', git: 'relayGit', brief: 'relayBrief', tasks: 'relayTasks', review: 'relayReviews' }[name]; return key ? window[key] : null; };
  // Remote access is drawn into the sheet by the same module as in Settings, with the Settings kit's markup, so
  // pairing, approvals and the QR code work the same way. Only the buttons report errors here instead of in Settings.
  const phoneHost = node('div', 'flow-phone');
  function phoneKit() {
    const kit = window.relaySettings?.kit; if (!kit) return null;
    return { ...kit,
      group(parent, heading, description) {
        const group = node('section', 'settings-group');
        if (heading) group.append(node('h3', 'settings-group-title', heading));
        if (description) group.append(node('p', 'settings-group-description', description));
        const rows = node('div', 'settings-rows'); group.append(rows); parent.append(group); return rows;
      },
      button(text, onClick, kind = '') {
        const value = button(`settings-button${kind ? ' ' + kind : ''}`, text, async () => {
          if (value.disabled) return; value.disabled = true;
          try { await onClick(); } catch (error) { api.showNotice?.(error.message || 'This could not be done. Please try again.'); }
          finally { value.disabled = false; }
        });
        return value;
      },
    };
  }
  function releaseDetail() {
    if (!detailPanel) return;
    if (detailPanel === 'phone') { phoneHost.replaceChildren(); phoneHost.remove(); }
    const panel = $(`${detailPanel}-panel`);
    if (panel) shell.append(panel);
    detailPanel = null;
  }
  function showSheet(name) {
    if (detailPanel && detailPanel !== name) { const old = detailPanel; releaseDetail(); if (old === 'review') panelAPI(old)?.closePanel?.(); else panelAPI(old)?.close?.(); }
    if (!detailPanel) { detailFocus = document.activeElement; detailCard = peeking; }
    closePeek();
    detailPanel = name;
    detailScope = scope();
    const [title, description] = panelInfo[name];
    $('flow-detail-title').textContent = title; $('flow-detail-description').textContent = description;
    detailBody.append(name === 'phone' ? phoneHost : $(`${name}-panel`));
    if (!detail.open) detail.showModal();
    $('flow-detail-close')?.focus();
  }
  function showPhone() {
    const kit = on && detail && window.relayPhone?.settings ? phoneKit() : null;
    if (!kit) return false;
    if (detailPanel === 'phone') { $('flow-detail-close')?.focus(); return true; }
    phoneHost.replaceChildren();
    window.relayPhone.settings(phoneHost, kit, () => Boolean(detail.open) && detailPanel === 'phone');
    showSheet('phone');
    return true;
  }
  function closeDetail() {
    const name = detailPanel;
    releaseDetail();
    if (name === 'review') panelAPI(name)?.closePanel?.(); else if (name) panelAPI(name)?.close?.();
    if (detail?.open) detail.close();
    if (on && narrow() && detailCard) peekCard(detailCard);
    if (detailFocus?.isConnected && !detailFocus.closest?.('[hidden]')) detailFocus.focus();
    else if (on) $('message-input')?.focus();
    detailFocus = null;
    detailCard = null;
    detailScope = null;
  }
  // Reuse the working controls and data, but present them in Flow's own sheet. Nothing is cloned: input state,
  // refreshes, previews and existing permission checks remain attached to their original elements.
  function syncDetail() {
    detailScheduled = false;
    if (!on || !detail) return;
    const shown = [...sidePanels, 'review'].filter(name => $(`${name}-panel`)?.hidden === false);
    const name = shown.find(name => name !== detailPanel) || shown[0];
    // The remote-access sheet is not a side panel, so a panel closing elsewhere leaves it alone.
    if (!name) { if (detailPanel && detailPanel !== 'phone') closeDetail(); return; }
    if (name === detailPanel) return;
    showSheet(name);
  }
  function scheduleDetail() { if (!detailScheduled) { detailScheduled = true; Promise.resolve().then(syncDetail); } }

  // ---- The cards. Each is built once; renders replace only its body and footer.
  const cards = new Map(CARDS.map(card => {
    const element = node('section', 'flow-card'), head = node('div', 'flow-card-head'), title = node('h2', undefined, card.title), body = node('div', 'flow-card-body'), foot = node('div', 'flow-card-foot');
    element.id = `flow-card-${card.id}`; title.id = `flow-card-${card.id}-title`; element.setAttribute('aria-labelledby', title.id);
    head.append(title); element.append(head, body, foot);
    return [card.id, { ...card, element, body, foot, signature: null }];
  }));
  // Quiet utility areas anchor the two rails, separate from the live task cards.
  const space = node('section', 'flow-utility flow-space'), connect = node('section', 'flow-utility flow-connect');
  space.id = 'flow-space'; connect.id = 'flow-connect';
  space.setAttribute('aria-label', 'Your space'); connect.setAttribute('aria-label', 'Stay connected');
  space.append(node('h2', undefined, 'Your space'), node('p', 'flow-utility-hint', 'Appearance and preferences.'));
  const appearance = node('div', 'flow-appearance'); appearance.append(node('span', 'flow-utility-label', 'Appearance'));
  space.append(appearance);
  connect.append(node('h2', undefined, 'Stay connected'), node('p', 'flow-utility-hint', 'Pick up the conversation on your phone.'));
  const preferences = node('div', 'flow-preferences');
  // Move the actual controls so connection counts, update progress and theme state keep updating in Flow.
  const movedControls = [];
  function moveControls() {
    for (const id of ['flow-status', 'connect-phone', 'relay-settings', 'appearance-options', 'keep-awake', 'update-status', 'update-more']) {
      const control = $(id); if (!control) continue;
      const marker = node('span'); marker.hidden = true;
      control.parentNode.insertBefore(marker, control); movedControls.push({ control, marker });
      if (id === 'flow-status') cards.get('working').element.insertBefore(control, cards.get('working').body);
      else if (id === 'appearance-options') appearance.append(control);
      else if (id === 'relay-settings') space.append(control);
      else connect.append(control);
    }
  }
  function restoreControls() { for (const { control, marker } of movedControls.splice(0)) { marker.parentNode.insertBefore(control, marker); marker.remove(); } }
  // In Flow the header leaves the chat column and spans the window, so the seal sits beside the window controls,
  // search is in the middle of the window and the way out is at its far right. Leaving puts it back where it was.
  const header = $('conversation-header');
  let headerMarker = null;
  function liftHeader() {
    if (!header || headerMarker) return;
    headerMarker = node('span'); headerMarker.hidden = true;
    header.parentNode.insertBefore(headerMarker, header);
    if (shell.children[0]) shell.insertBefore(header, shell.children[0]); else shell.append(header);
  }
  function dropHeader() {
    if (!headerMarker) return;
    headerMarker.parentNode.insertBefore(header, headerMarker); headerMarker.remove(); headerMarker = null;
  }
  function place() {
    for (const side of [left, right]) side.replaceChildren(...CARDS.filter(card => card.side === side && peeking !== card.id).map(card => cards.get(card.id).element));
    if (peeking !== 'space') { left.append(space); right.append(connect); }
  }

  // How it's working now: the routing mode first, with what it does and when it hands off in plain words, what the next
  // message would do, and a way to change the mode that says first what would change. Access, approvals and billing stay.
  function modeSentence(current) {
    const option = modes.find(item => item.mode === current?.mode), extras = [];
    if (!option) return routingPending ? 'Turning routing on…' : 'Routing is off. Flow turns it on when the workspace is idle.';
    if (current?.allowApi) extras.push('Agents billed by use can be chosen.');
    if (current?.check) extras.push(api.getState().status?.verificationCadence === 'review-first' ? 'Routine automatic tests wait while you review. A selected build/review workflow still checks.' : 'After a run changes files, your tests run; if they fail, it tries once more, one step up.');
    return [option.does, ...extras].join(' ');
  }
  const draft = () => ({ text: $('message-input')?.value.trim() || '', files: window.relayFiles?.ids?.().length || 0 });
  // "go to Claude, Sonnet, low effort: a short fix", or why Codeshi can't choose.
  function routeWords(routed) {
    if (!routed) return null;
    if (routed.error) return { error: `Codeshi can’t choose yet. ${routed.error}` };
    const model = routed.modelName || 'its default model';
    return { words: `go to ${agentNames[routed.provider] || 'an agent'}, ${model}${routed.effort ? `, ${routed.effort} effort` : ''}: ${lower(routed.reason || '')}` };
  }
  function nextLine() {
    const state = api.getState(), c = state.conversation;
    if (api.isRunning()) { const run = c?.activeRun; return `${agentName(run?.provider, run?.connection === 'local')} is working on it now.`; }
    if (c?.resume) return 'Waiting for a usage limit to reset, then it carries on.';
    if (routing()) {
      const { text, files } = draft();
      if (!text && !files) return 'Type a message to see who would take it.';
      const route = routeWords(api.routeFor(text, files));
      return route?.error || (route ? `It would ${route.words}.` : 'Codeshi would pick the agent, model and effort.');
    }
    const model = state.model ? window.relayModelPicker?.modelName?.(state.provider, state.model) || state.model : null;
    return `Your next message goes to ${agentNames[state.provider] || 'the agent'}${model ? `, ${model}` : ''}.`;
  }
  async function choose(option) {
    if (busy) return;
    const current = routing();
    busy = true; render();
    try { await api.setRouting({ mode: option.mode, allowApi: current?.allowApi === true, check: current?.check === true }); pending = null; api.announce?.(`Now ${option.name}.`); }
    catch (error) { api.showNotice?.(error.message); }
    finally { busy = false; render(); }
  }
  function confirmBlock(option, current) {
    const block = node('div', 'flow-confirm'); block.setAttribute('role', 'group'); block.setAttribute('aria-label', `Switch to ${option.name}`);
    block.append(node('strong', undefined, `Switch to ${option.name}?`));
    const { text, files } = draft();
    let would;
    if (text || files) { const route = routeWords(api.routeFor(text, files, option.mode)); would = route?.error || (route ? `Your draft would ${route.words}.` : option.would); }
    else would = option.would;
    block.append(node('p', undefined, would));
    block.append(node('p', 'flow-note', `Access and permissions stay as they are${current?.allowApi ? ', and agents billed by use stay allowed' : ', and agents billed by use stay off'}.`));
    const actions = node('div', 'flow-actions'), apply = button('flow-apply', `Switch to ${option.name}`, () => choose(option)), currentName = (modes.find(item => item.mode === current?.mode) || modes[1]).name;
    apply.disabled = busy;
    actions.append(apply, button('text-link', `Keep ${currentName}`, () => { pending = null; render(); }));
    block.append(actions);
    return block;
  }
  function renderWorking(card) {
    const state = api.getState(), current = routing(), locked = busy || routingPending || !current || !state.projectId || api.isRunning();
    const currentMode = current?.mode || null;
    if (pending && pending.mode === currentMode) pending = null;
    const signature = JSON.stringify([current, pending?.mode, busy, locked, routingPending, nextLine(), state.provider, state.model, changeOpen, state.status?.verificationCadence]);
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren();
    // The mode comes first and large: it is the one choice Flow makes on your behalf.
    const option = modes.find(item => item.mode === currentMode), mode = node('div', 'flow-mode');
    mode.append(node('span', 'flow-mode-eyebrow', 'Routing'), node('strong', 'flow-mode-name', option ? option.name : routingPending ? 'Turning on…' : 'Off'), node('p', 'flow-mode-text', modeSentence(current)));
    body.append(mode);
    const facts = node('dl', 'flow-facts');
    const fact = (term, text) => { const row = node('div'), detail = node('dd', undefined, text); row.append(node('dt', undefined, term), detail); facts.append(row); return detail; };
    fact('Next message', nextLine());
    const testing = fact('Testing', state.status?.verificationCadence === 'review-first' ? 'Review first: small safeguards now; verify when you ask to finalize.' : 'Checks as needed, focused on what changed.');
    testing.append(' ', button('text-link', 'Change…', () => window.relaySettings?.open?.('general', 'Testing')));
    body.append(facts);
    const change = node('details', 'flow-change'), summary = node('summary', undefined, 'Change how it works');
    change.open = changeOpen; change.addEventListener('toggle', () => { changeOpen = change.open; });
    const group = node('div', 'flow-options'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'How Codeshi chooses the agent and model');
    const radios = modes.map(option => {
      const selected = currentMode === option.mode, row = node('button', 'routing-option'); row.type = 'button'; row.disabled = locked;
      row.setAttribute('role', 'radio'); row.setAttribute('aria-checked', String(selected)); row.dataset.mode = option.mode;
      const text = node('span', 'routing-option-text'); text.append(node('strong', undefined, option.name), node('small', undefined, option.hint));
      row.append(node('span', 'routing-option-mark'), text);
      row.addEventListener('click', () => { if (selected) { pending = null; render(); return; } pending = option; focusConfirm = true; render(); });
      return row;
    });
    group.append(...radios);
    // The arrow keys move between the choices, as in a group of radio buttons; Enter or Space picks one.
    group.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const index = radios.indexOf(event.target); if (index < 0) return;
      event.preventDefault(); radios[(index + (event.key === 'ArrowDown' ? 1 : radios.length - 1)) % radios.length].focus();
    });
    change.append(summary, group);
    if (locked && state.projectId) change.append(node('p', 'flow-locked', busy ? 'Changing…' : routingPending || !current ? 'Available once routing is on.' : 'Available when the current run finishes.'));
    body.append(change);
    if (pending) { changeOpen = true; change.open = true; const block = confirmBlock(pending, current); body.append(block); if (focusConfirm) { focusConfirm = false; block.querySelector('.flow-apply')?.focus(); } }
    card.foot.replaceChildren(button('text-link', 'Agent settings', () => window.relayAgents?.open?.()));
  }

  // What's left on your plans: each connected agent's tightest limit in plain words. Readings come from the agents'
  // own accounts, as in Plan usage; nothing here is a guess.
  const resetWords = value => { const at = new Date(value || ''); if (Number.isNaN(at.getTime())) return ''; return 'resets ' + at.toLocaleString(undefined, at.toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
  function periodWords(label) {
    const [period, ...scope] = String(label || '').split(' · ');
    const words = /hour/i.test(period) ? 'for the next few hours' : /^weekly$/i.test(period) ? 'this week' : /^daily$/i.test(period) ? 'today' : period.toLowerCase();
    return scope.length ? `${words} for ${scope.join(' · ')}` : words;
  }
  const remaining = row => Math.max(0, Math.min(100, Math.round(100 - row.usedPercent)));
  const level = percent => percent <= 10 ? 'critical' : percent <= 25 ? 'low' : 'ok';
  function planRows() {
    const state = api.getState();
    return ['codex', 'claude', 'gemini'].filter(provider => state.accounts?.[provider]?.authenticated === true).map(provider => {
      const usage = window.relayUsage?.snapshot?.(provider), windows = (usage?.available && Array.isArray(usage.windows) ? usage.windows : []).filter(row => Number.isFinite(row.usedPercent) && !row.disabled);
      const tightest = windows.reduce((low, row) => !low || row.usedPercent > low.usedPercent ? row : low, null);
      return { provider, reported: usage?.available !== false, tightest, others: windows.length - (tightest ? 1 : 0) };
    });
  }
  function renderPlans(card) {
    const state = api.getState(), rows = planRows();
    const signature = JSON.stringify([rows, state.provider]);
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    if (!rows.length) {
      body.append(node('p', 'flow-empty', 'Connect an agent in Settings to see what’s left on its plan.'));
      card.foot.append(button('text-link', 'Open Settings', () => window.relaySettings?.open?.('accounts')));
      return;
    }
    const list = node('ul', 'flow-plans');
    for (const row of rows) {
      const item = node('li', 'flow-plan'), head = node('div', 'flow-plan-head'), icon = node('i', `agent-icon ${row.provider}`);
      item.dataset.provider = row.provider; icon.setAttribute('aria-hidden', 'true');
      head.append(icon, node('strong', undefined, agentNames[row.provider]));
      if (!row.tightest) {
        head.append(node('span', 'flow-plan-value', row.reported ? 'No reading yet' : 'Not reported'));
        item.append(head);
        if (window.relayUsage?.load) item.append(button('text-link', 'Check now', () => window.relayUsage.load(row.provider)));
      } else {
        const percent = remaining(row.tightest);
        item.dataset.level = level(percent);
        head.append(node('span', 'flow-plan-value', `${percent}% left`));
        const meter = node('div', 'flow-meter'); meter.style.setProperty('--left', `${percent}%`); meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', `${percent}% of ${agentNames[row.provider]}’s allowance left ${periodWords(row.tightest.label)}`);
        const reset = resetWords(row.tightest.resetsAt);
        item.append(head, meter, node('span', 'flow-plan-when', `${periodWords(row.tightest.label)}${reset ? ` · ${reset}` : ''}${row.others ? ` · ${plural(row.others, 'other limit')}` : ''}`));
      }
      list.append(item);
    }
    body.append(list);
    const chosen = rows.some(row => row.provider === state.provider) ? state.provider : rows[0].provider;
    card.foot.append(button('text-link', 'All limits', () => window.relayUsage?.open?.(chosen)));
  }

  // What's next: the agent's plan for the task, then what's queued. The plan stays while the task can still go on.
  function planFor() {
    const c = api.getState().conversation, last = c?.lastRun, running = api.isRunning();
    const held = !running && last && last.status !== 'complete' && last.plan?.steps?.some(step => step.status !== 'done');
    const run = running ? c?.activeRun : held ? last : null;
    return { steps: run?.plan?.steps || [], held: Boolean(held), running, run };
  }
  const currentStep = steps => steps.find(step => step.status === 'active') || steps.find(step => step.status === 'pending') || null;
  function renderNext(card) {
    const state = api.getState(), c = state.conversation, { steps, held, running, run } = planFor(), queue = c?.queue || [], tasks = c?.parallelTasks || [];
    const folders = state.projects?.find(project => project.id === state.projectId)?.folders || [];
    const signature = JSON.stringify([steps, held, running, queue, c?.queuePaused, state.projectId, state.taskId, state.taskDraft, folders, tasks.map(task => [task.id, task.title, task.status, task.conversationId, task.folderName])]);
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    const selectTask = id => window.relayTaskThreads.select(id).catch(error => api.showNotice?.(error.message));
    const others = tasks.filter(task => task.id !== state.taskId && !['integrated', 'kept', 'discarded', 'cancelled', 'lost', 'detached'].includes(task.status) && (task.conversationId || task.status === 'waiting'));
    if (!steps.length && !queue.length) body.append(node('p', 'flow-empty', state.taskDraft ? 'Describe the new task in the message box. Nothing starts until you send it.' : running ? `${agentName(run?.provider, run?.connection === 'local')} is working. Its plan appears here as it makes one.` : 'Describe what you want in the chat to get started. This card tracks the agent’s steps and your queued follow-ups.'));
    if (steps.length) {
      const done = steps.filter(step => step.status === 'done').length, current = currentStep(steps);
      body.append(node('p', 'flow-lead', done === steps.length ? 'All steps done.' : `${done} of ${steps.length} done${held ? ' · stopped' : ''}.`));
      const list = node('ol', 'flow-steps');
      for (const step of steps) {
        const item = node('li', `flow-step ${step.status}`), mark = node('span', 'flow-step-mark'); mark.setAttribute('aria-hidden', 'true');
        item.append(mark, node('span', 'flow-step-text', step.text));
        if (step === current && !held && step.status === 'active') item.setAttribute('aria-current', 'step');
        item.setAttribute('aria-label', `${step.status === 'done' ? 'Done' : step.status === 'active' ? (held ? 'Stopped at' : 'Now') : 'To do'}: ${step.text}`);
        list.append(item);
      }
      body.append(list);
    }
    if (queue.length) {
      body.append(node('h3', 'flow-subhead', `Then · ${plural(queue.length, 'queued message')}${c.queuePaused ? ' · paused' : ''}`));
      const list = node('ol', 'flow-queue');
      for (const item of queue.slice(0, 5)) list.append(node('li', 'flow-queue-item', clip(item.text, 110)));
      if (queue.length > 5) list.append(node('li', 'flow-queue-more', `and ${queue.length - 5} more`));
      body.append(list);
    }
    // Tasks running beside this chat, started from the normal view or a folder choice, stay reachable here with their
    // own Stop and Cancel; a task thread can come back to the whole workspace.
    if (others.length || state.taskId) {
      body.append(node('h3', 'flow-subhead', state.taskId ? 'This task runs beside the workspace chat' : 'Running beside this chat'));
      const list = node('ul', 'flow-tasks'), taskWords = task => task.status === 'waiting' ? 'waiting to start' : task.status === 'running' ? 'working' : task.status === 'complete' ? 'finished' : task.status;
      for (const task of others) { const item = node('li', 'flow-task'); item.append(button('text-link', clip(task.title, 45), () => selectTask(task.id)), node('span', 'flow-task-meta', `${task.folderName ? `${task.folderName} · ` : ''}${taskWords(task)}`)); list.append(item); }
      if (state.taskId) { const item = node('li', 'flow-task'); item.append(button('text-link', 'Workspace chat', () => selectTask(null)), node('span', 'flow-task-meta', 'the whole workspace')); list.append(item); }
      body.append(list);
    }
  }

  // Files changed: each run that changed files, newest first, with the same Undo as the run's line in the chat.
  const when = value => { const at = new Date(value || ''); if (Number.isNaN(at.getTime())) return ''; return at.toLocaleString(undefined, at.toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
  function changedRuns() {
    const c = api.getState().conversation, saved = c?.checkpoints || {}, runs = c?.runs || [];
    return Object.entries(saved).filter(([, entry]) => entry?.files).map(([runId, entry]) => ({ runId, files: entry.files, undone: entry.undone || null, run: runs.find(run => run.id === runId) || null }))
      .sort((a, b) => String(b.run?.startedAt || '').localeCompare(String(a.run?.startedAt || '')));
  }
  function renderFiles(card) {
    const rows = changedRuns(), running = api.isRunning();
    const signature = JSON.stringify([rows.map(row => [row.runId, row.files, row.undone, row.run?.provider, row.run?.startedAt]), running]);
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    card.foot.append(button('text-link', 'Timeline', () => window.relayTimeline?.open?.()), button('text-link', 'Review changes', () => window.relayGit?.open?.()));
    if (!rows.length) { body.append(node('p', 'flow-empty', 'No files changed in this conversation yet. Each run that changes files appears here, with Undo.')); return; }
    const total = rows.filter(row => !row.undone).reduce((sum, row) => sum + row.files, 0);
    body.append(node('p', 'flow-lead', `${plural(total, 'file')} changed, across ${plural(rows.length, 'run')}.`));
    const list = node('ul', 'flow-runs');
    for (const row of rows.slice(0, 6)) {
      const item = node('li', 'flow-run');
      item.append(node('span', 'flow-run-title', row.undone ? 'Changes undone' : `${plural(row.files, 'file')} changed`));
      item.append(node('span', 'flow-run-meta', [agentName(row.run?.provider, row.run?.local), when(row.run?.startedAt)].filter(Boolean).join(' · ')));
      const action = button('text-link flow-run-action', row.undone ? 'Redo' : 'Undo', () => window.relayRewind?.open?.(row.undone ? { kind: 'rewind', id: row.undone } : { kind: 'run', id: row.runId }));
      action.disabled = running || !window.relayRewind; action.title = running ? 'Available when the current run finishes' : row.undone ? 'Put this run’s changes back' : 'Review this run’s changes, then undo them';
      item.append(action); list.append(item);
    }
    body.append(list);
  }
  const renderers = { working: renderWorking, plans: renderPlans, next: renderNext, files: renderFiles };

  // ---- Live status in the working card. Remote access and Settings sit below it; no footer is needed.
  const phaseWords = { starting: 'starting', reasoning: 'thinking', responding: 'writing', tool: 'running tools', compacting: 'organizing its context', approval: 'waiting for you' };
  const elapsedWords = since => { const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since || '')) / 1000)); if (!Number.isFinite(seconds)) return ''; const minutes = Math.floor(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; };
  function statusLine() {
    const state = api.getState(), c = state.conversation;
    if (!c) return { text: 'Ready', live: false };
    const waiting = c.pendingApprovals || [];
    if (waiting.length) return { text: waiting.some(item => item.kind === 'question') ? `${agentName(c.activeRun?.provider, c.activeRun?.connection === 'local')} has a question for you` : 'Waiting for your approval', live: true, attention: true };
    if (api.isRunning()) {
      const run = c.activeRun, agent = agentName(run?.provider, run?.connection === 'local'), step = currentStep(run?.plan?.steps || []), elapsed = elapsedWords(run?.startedAt);
      const doing = step ? `is on “${clip(step.text, 70)}”` : `is ${phaseWords[run?.phase] || 'working'}`;
      return { text: `${agent} ${doing}${elapsed ? ` · ${elapsed}` : ''}`, live: true };
    }
    if (c.resume || c.limitSwitching) return { text: 'Waiting for a usage limit to reset', live: true };
    const last = c.lastRun;
    if (!last) return { text: 'Ready', live: false };
    if (last.status === 'complete') { const files = c.checkpoints?.[last.id]?.files; return { text: `Done${files ? ` · ${plural(files, 'file')} changed` : ''}`, live: false }; }
    return { text: last.status === 'interrupted' ? 'Stopped' : 'The last run didn’t finish', live: false, attention: last.status !== 'interrupted' };
  }
  function renderStatus() {
    if (!status) return;
    status.hidden = !on;
    if (!on) return;
    const line = statusLine(), text = $('flow-status-text');
    if (text) text.textContent = line.text; else status.textContent = line.text;
    status.dataset.live = String(Boolean(line.live)); status.dataset.attention = String(Boolean(line.attention));
  }

  // ---- A narrow window: the cards leave the sides and become a row of chips under the header; one opens at a time.
  function chipText(id) {
    const state = api.getState();
    if (id === 'working') return modes.find(item => item.mode === routing()?.mode)?.name || 'Routing';
    if (id === 'plans') { const rows = planRows(), row = rows.find(item => item.provider === state.provider) || rows[0]; return row?.tightest ? `${agentNames[row.provider]} ${remaining(row.tightest)}% left` : 'Plans'; }
    if (id === 'next') { const { steps } = planFor(), queue = state.conversation?.queue || []; return steps.length ? `${steps.filter(step => step.status === 'done').length} of ${steps.length} steps` : queue.length ? plural(queue.length, 'queued message') : 'What’s next'; }
    const total = changedRuns().filter(row => !row.undone).reduce((sum, row) => sum + row.files, 0);
    return total ? `${plural(total, 'file')} changed` : 'Files';
  }
  function renderStrip() {
    if (strip.hidden) return;
    strip.replaceChildren(...CARDS.map(card => {
      const chip = button('flow-chip', chipText(card.id), () => peekCard(card.id));
      chip.setAttribute('aria-pressed', String(peeking === card.id)); chip.setAttribute('aria-label', `${card.title}: ${chipText(card.id)}`);
      return chip;
    }));
    const options = button('flow-chip flow-space-chip', 'Your space', () => peekCard('space'));
    options.setAttribute('aria-pressed', String(peeking === 'space')); options.setAttribute('aria-label', 'Your space: appearance, settings and phone access');
    strip.append(options);
  }
  function peekCard(id) {
    if (peeking === id) { closePeek(); return; }
    closePeek();
    const card = id === 'space' ? { element: preferences, title: 'Your space' } : cards.get(id); if (!card) return;
    if (id === 'space') preferences.replaceChildren(space, connect);
    peeking = id; peekBody.replaceChildren(card.element); peek.hidden = false; peek.setAttribute('aria-label', card.title);
    renderStrip(); $('flow-peek-close')?.focus();
  }
  function closePeek() {
    if (!peeking) return;
    peeking = null; peek.hidden = true; place(); renderStrip();
  }

  // ---- The way in and out. A veil covers the change of layout; going in, the seal appears on it for a moment.
  // Without motion, or in a page that can't animate, the layout just changes.
  function stage(change, seal, done) {
    if (!veil || typeof veil.animate !== 'function' || reducedMotion()) { try { change(); } finally { done(); } return; }
    veil.hidden = false; veil.classList.toggle('with-seal', seal);
    const mark = veil.querySelector('img');
    if (mark) mark.style.opacity = '0';
    const fadeIn = veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out', fill: 'forwards' });
    fadeIn.onfinish = () => {
      const changed = change() !== false;
      if (changed && seal && mark?.animate) mark.animate([{ opacity: 0, transform: 'scale(.55) rotate(-10deg)' }, { opacity: 1, transform: 'scale(1) rotate(0)', offset: .45 }, { opacity: 1, transform: 'scale(1)', offset: .75 }, { opacity: 0, transform: 'scale(1.05)' }], { duration: 700, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      const fadeOut = veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: changed && seal ? 380 : 160, delay: changed && seal ? 320 : 0, easing: 'ease-in', fill: 'forwards' });
      fadeOut.onfinish = () => { veil.hidden = true; done(); };
    };
  }
  // The status line's elapsed time moves while a run works.
  function tick() { clearTimeout(ticker); if (!on) return; if (api.isRunning()) renderStatus(); ticker = setTimeout(tick, 1000); }
  function applyMode(wanted, remember, projectId, force = false) {
    transitioning = true; render(); modeChanged();
    stage(() => {
      const reason = !force && (api.getState().projectId !== projectId ? 'The workspace changed. Choose the view again.' : lockReason());
      if (reason) { api.showNotice?.(reason); return false; }
      if (wanted) {
        saved = { panel: openSidePanel(), bottom: window.relayPanel?.isOpen?.() ? window.relayPanel.active() : null };
        window.relayAgents?.close?.(); window.relayGit?.close?.(); window.relayBrief?.close?.(); window.relayTasks?.close?.(); window.relayTimeline?.close?.(); window.relayReviews?.closePanel?.();
        if (saved.bottom) window.relayPanel?.hide?.();
        on = true; shell.classList.add('flow'); liftHeader(); moveControls(); place(); tick(); ensureRouting();
      } else {
        on = false; pending = null; closeDetail(); closePeek(); window.relayPanel?.hide?.(); releaseRouting();
        clearTimeout(ticker); ticker = null;
        const previous = saved; saved = null;
        shell.classList.remove('flow'); restoreControls(); dropHeader();
        if (previous?.panel) api.showSidePanel?.(previous.panel);
        if (previous?.bottom) window.relayPanel?.show?.(previous.bottom);
      }
      if (remember) write(KEY, on ? 'on' : 'off');
      render(); modeChanged();
      api.announce?.(on ? 'Flow on. Your routing, permissions and handoff settings stay as selected.' : 'Flow off.');
      return true;
    }, wanted, () => { transitioning = false; render(); modeChanged(); });
  }
  function changeMode(wanted, remember = true) {
    if (wanted === on) return true;
    const reason = lockReason();
    if (reason || checkingMode || transitioning) { api.showNotice?.(reason || 'The view is changing. Try again in a moment.'); return false; }
    const state = api.getState(), projectId = state.projectId, taskId = state.taskId;
    checkingMode = true; render(); modeChanged();
    // Refresh the workspace-wide status, rather than trusting only the task currently visible in this browser.
    api.api('/api/status', {}, projectId).then(status => {
      checkingMode = false;
      if (api.getState().projectId !== projectId || api.getState().taskId !== taskId) return;
      if (status.runningConversationId || activityBusy(status.workspaceActivity)) { api.showNotice?.(LOCK_MESSAGE); return; }
      const currentReason = lockReason();
      if (currentReason) { api.showNotice?.(currentReason); return; }
      applyMode(wanted, remember, projectId);
    }).catch(error => api.showNotice?.(`Could not check workspace activity. ${error.message}`)).finally(() => { checkingMode = false; render(); modeChanged(); });
    return true;
  }
  function toggleFlow() { return changeMode(!on); }
  // Flow has its own voice: the seal and the word in the header, and a message box that asks what to build.
  const shortcutNote = (toggle.title.match(/\s\([^)]*\)\s*$/) || [''])[0], DEFAULT_PLACEHOLDER = 'Describe the task or ask a question…', FLOW_PLACEHOLDER = 'What should we build next?';
  function brand() {
    const state = api.getState(), label = $('toggle-flow-label'), mark = $('flow-brand'), input = $('message-input');
    if (label) label.textContent = on ? 'Leave Flow' : 'Flow';
    toggle.title = (lockReason() || (checkingMode ? 'Checking workspace activity…' : transitioning ? 'Changing view…' : on ? 'Leave Flow: the panels come back as they were' : 'Flow: just the chat, with plain-language cards either side')) + shortcutNote;
    if (mark) { mark.hidden = !on; const name = state.projects?.find(project => project.id === state.projectId)?.name || ''; if ($('flow-brand-workspace')) $('flow-brand-workspace').textContent = name; }
    if (input) { if (on && input.placeholder === DEFAULT_PLACEHOLDER) input.placeholder = FLOW_PLACEHOLDER; else if (!on && input.placeholder === FLOW_PLACEHOLDER) input.placeholder = DEFAULT_PLACEHOLDER; }
  }
  function render() {
    const state = api.getState(), tight = narrow();
    toggle.setAttribute('aria-pressed', String(on)); toggle.disabled = Boolean(lockReason() || checkingMode || transitioning);
    brand(); renderStatus();
    left.hidden = right.hidden = !on || tight;
    strip.hidden = !on || !tight;
    if (!on || !tight) closePeek();
    if (!on) return;
    for (const card of CARDS) renderers[card.id](cards.get(card.id));
    renderStrip();
  }
  function schedule() { if (scheduled) return; scheduled = true; Promise.resolve().then(() => { scheduled = false; render(); }); }

  toggle.addEventListener('click', toggleFlow);
  $('flow-detail-close')?.addEventListener('click', closeDetail);
  detail?.addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
  detail?.addEventListener('close', () => { if (detailPanel) closeDetail(); });
  detail?.addEventListener('click', event => {
    if (event.target !== detail) return;
    const rect = detail.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDetail();
  });
  window.addEventListener('relay-side-panel', scheduleDetail);
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(scheduleDetail);
    for (const name of [...sidePanels, 'review']) if ($(`${name}-panel`)) observer.observe($(`${name}-panel`), { attributes: true, attributeFilter: ['hidden'] });
  }
  $('flow-peek-close')?.addEventListener('click', closePeek);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && peeking && !event.isComposing) { event.preventDefault(); closePeek(); } });
  narrowQuery?.addEventListener?.('change', schedule);
  window.addEventListener('relay-state', () => {
    if (detailPanel && detailScope !== scope()) closeDetail();
    const has = Boolean(api.getState().projectId);
    if (has && api.getState().ready && !restored) { restored = true; if (!on && read(KEY) === 'on' && !lockReason()) changeMode(true, false); }
    if (!has && on && !transitioning) applyMode(false, false, null, true);
    // Routing follows the view: on in Flow, off outside it, put right at the next idle moment if something else changed it.
    const idle = has && api.getState().ready && !transitioning && !checkingMode && !api.isRunning();
    if (idle && on) { if (routing()) rememberRouting(); else ensureRouting(); }
    else if (idle && !on && routing()) releaseRouting();
    schedule();
  });
  for (const type of ['relay-account', 'relay-billing']) window.addEventListener(type, schedule);
  // The next-message line follows the draft as it is typed.
  $('message-input')?.addEventListener('input', () => { if (on) schedule(); });
  // remoteAccess: the phone entry asks Flow first; true means the sheet opened, so Settings need not.
  window.relayFlow = { toggle: toggleFlow, enter: () => changeMode(true), leave: () => changeMode(false), isOn: () => on, isLocked: () => Boolean(lockReason() || checkingMode || transitioning), peek: peekCard, cards: () => CARDS.map(card => ({ id: card.id, title: card.title })), remoteAccess: showPhone };
  render();
})();

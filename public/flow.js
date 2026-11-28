(() => {
  'use strict';
  // Flow mode (#107, #128, #194): the chat in the middle, with a few plain-language panels either side. Each reads what
  // Codeshi has already recorded, with no extra model call: what the agent is doing and why it was chosen, the tasks beside
  // the chat, what's left on each plan, the files that changed with Undo, and running the app.
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
  const agentNames = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const agentName = (provider, local = false) => local ? 'The local model' : agentNames[provider] || 'The agent';
  // Flow always routes, so there is no manual mode here; the mode is chosen and shown in the message box's model picker.
  const modes = [{ mode: 'saver', name: 'Saver' }, { mode: 'smart', name: 'Smart' }, { mode: 'ultra', name: 'Ultra' }];
  const canonicalMode = mode => window.relayRouting?.normalizeMode?.(mode) || mode || null;
  // The panels (#194). Each names itself in its head, shows what it holds on its face and acts in one click. The left rail
  // is the agents and work: what the agent is doing, the tasks beside the chat, and what's left on each plan. The right
  // rail is your project: the files that changed and running the app. The chat stays in the middle.
  const CARDS = [
    { id: 'activity', title: 'Activity', side: 'left' },
    { id: 'tasks', title: 'Tasks', side: 'left' },
    { id: 'usage', title: 'Usage', side: 'left' },
    { id: 'changes', title: 'Changes', side: 'right' },
    { id: 'app', title: 'Your app', side: 'right' },
  ];
  // The window shows one of three views: Normal, Flow or the Plan (#162). on is true in Flow alone. Routing is its own
  // setting: Flow turns it on, Normal turns it off, and the Plan keeps it as it was, so the Plan never waits for work.
  const VIEW_KEY = 'throughline:view';
  let view = 'normal', on = false, routed = false, saved = null, peeking = null, scheduled = false, ticker = null;
  let checkingMode = false, transitioning = false, restored = false;
  const normalButton = $('view-normal'), planButton = $('open-plan');
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
  const modeChanged = () => window.dispatchEvent(new CustomEvent('relay-flow', { detail: { on, view, routed } }));
  const narrowQuery = window.matchMedia?.('(max-width: 1180px)') || null, narrow = () => Boolean(narrowQuery?.matches);
  const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const routing = () => api.getState().conversation?.routing || null;
  // Routing belongs to Flow (#12, #107, #128): entering turns it on, with the mode this workspace last used in Flow or
  // Smart, and leaving turns it off, so the normal view chooses the agent and model by hand. The choice is kept per browser.
  const ROUTING_KEY = id => `throughline:flow-routing:${id}`;
  let routingPending = false, routingReleasing = false;
  function rememberRouting() { const current = routing(), id = api.getState().projectId; if (current && id) write(ROUTING_KEY(id), JSON.stringify({ mode: canonicalMode(current.mode), allowApi: current.allowApi === true, check: current.check === true })); }
  function savedRouting(id) { try { const saved = JSON.parse(read(ROUTING_KEY(id)) || 'null'), mode = canonicalMode(saved?.mode); return saved && modes.some(option => option.mode === mode) ? { ...saved, mode } : null; } catch { return null; } }
  // Flow has no manual mode: entering turns routing on with the mode this workspace last used in Flow, or Smart.
  // Routing can't change while the shown conversation runs, such as a Plan card's task, so it waits for the run to end
  // and is turned on at the next idle moment.
  const conversationBusy = () => { const c = api.getState().conversation; return Boolean(api.isRunning() || c?.activeRun || c?.status === 'running'); };
  async function ensureRouting() {
    if (!routed || routing() || routingPending || !api.getState().projectId || conversationBusy()) return;
    const choice = savedRouting(api.getState().projectId) || { mode: 'smart', allowApi: false, check: false };
    routingPending = true; schedule();
    try { await api.setRouting({ mode: choice.mode, allowApi: choice.allowApi === true, check: choice.check === true }); }
    // A run that started meanwhile answers 409; routing is tried again when it ends.
    catch (error) { if (error.status !== 409) api.showNotice?.(`Flow could not turn routing on. ${error.message}`); }
    finally { routingPending = false; schedule(); }
  }
  const needsManualControl = () => {
    const execution = api.getState().conversation?.execution;
    return Boolean(routing() || execution?.defaults?.mode === 'flow' || execution?.active?.mode === 'flow');
  };
  // Outside Flow routing and task automation are off, including tasks saved before this behavior was enforced.
  async function releaseRouting() {
    if (!needsManualControl() || routingReleasing) return;
    routingReleasing = true; rememberRouting();
    try { await api.setRouting({ mode: null }); } catch { /* Tried again when the workspace is idle. */ }
    finally { routingReleasing = false; schedule(); }
  }
  const sidePanels = () => window.relaySidebar ? ['agents', 'brief', 'timeline'] : ['agents', 'git', 'brief', 'timeline'];
  const openSidePanel = () => sidePanels().find(name => $(`${name}-panel`) && !$(`${name}-panel`).hidden) || null;
  const detail = $('flow-detail'), detailBody = $('flow-detail-body');
  let detailPanel = null, detailFocus = null, detailCard = null, detailScheduled = false, detailScope = null;
  const scope = () => `${api.getState().projectId || ''}:${api.getState().taskId || ''}`;
  const panelInfo = {
    agents: ['Your agents', 'What each agent has left, and how messages are routed. Handoff follows the routing mode.'],
    timeline: ['Your timeline', 'Explore saved checkpoints and preview a restore before changing files.'],
    git: ['Your changes', 'Review the workspace diff, stage files, and commit when ready.'],
    brief: ['Workspace context', 'The instructions and context your agents share.'],
    review: ['Code review', 'Feedback on a saved snapshot of your changes.'],
    phone: ['Remote access', 'Pick up the conversation on your phone, on the same Wi-Fi or away from home.'],
  };
  const panelAPI = name => { const key = { agents: 'relayAgents', timeline: 'relayTimeline', git: 'relayGit', brief: 'relayBrief', review: 'relayReviews' }[name]; return key ? window[key] : null; };
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
  // Flow and the Plan have no side panels: a panel opened there, such as Agents from ⌘K, shows in this sheet instead.
  const sheeted = () => view !== 'normal';
  function releaseDetail() {
    if (!detailPanel) return;
    if (detailPanel === 'phone') { phoneHost.replaceChildren(); phoneHost.remove(); }
    const panel = $(`${detailPanel}-panel`);
    if (panel) (detailPanel === 'git' ? document.querySelector('.sidebar') || shell : shell).append(panel);
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
    const kit = on && detail && window.relayPhone?.settings && window.relayExperimental?.enabled('remote') !== false ? phoneKit() : null;
    if (!kit) return false;
    if (detailPanel === 'phone') { $('flow-detail-close')?.focus(); return true; }
    phoneHost.replaceChildren();
    window.relayPhone.settings(phoneHost, kit, () => Boolean(detail.open) && detailPanel === 'phone');
    showSheet('phone');
    return true;
  }
  function closeDetail() {
    const name = detailPanel;
    // With no sheet open there's nothing to close, and focus stays where it is.
    if (!name && !detail?.open) return;
    releaseDetail();
    if (name === 'review') panelAPI(name)?.closePanel?.(); else if (name) panelAPI(name)?.close?.();
    if (detail?.open) detail.close();
    if (on && detailCard) peekCard(detailCard);
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
    if (!sheeted() || !detail) return;
    const shown = ['agents', 'git', 'brief', 'timeline', 'review'].filter(name => $(`${name}-panel`)?.hidden === false);
    const name = shown.find(name => name !== detailPanel) || shown[0];
    // The remote-access sheet is not a side panel, so a panel closing elsewhere leaves it alone.
    if (!name) { if (detailPanel && detailPanel !== 'phone') closeDetail(); return; }
    if (name === detailPanel) return;
    showSheet(name);
  }
  function scheduleDetail() { if (!detailScheduled) { detailScheduled = true; Promise.resolve().then(syncDetail); } }

  // ---- The panels (#194). Each is built once: a head with its name, how many it holds and a word for where it stands,
  // then its rows, then its actions. What it holds shows on its face and one click acts on it, so nothing opens a second
  // window to be useful. Tasks side by side and Your app are experimental (#176); off, they leave the rails and the strip.
  const cardOff = id => (id === 'tasks' && window.relayExperimental?.enabled('tasks') === false) || (id === 'app' && window.relayExperimental?.enabled('review') === false);
  const cards = new Map(CARDS.map(card => {
    const element = node('section', 'flow-card flow-panel'), head = node('header', 'flow-panel-head'), icon = node('i', 'flow-panel-icon'), title = node('h2', 'flow-panel-title', card.title);
    const count = node('span', 'flow-panel-count'), state = node('span', 'flow-panel-state'), tools = node('span', 'flow-panel-tools'), body = node('div', 'flow-panel-body'), foot = node('div', 'flow-panel-foot');
    element.id = `flow-card-${card.id}`; element.dataset.card = card.id; element.dataset.state = 'idle'; title.id = `flow-card-${card.id}-title`; element.setAttribute('aria-labelledby', title.id);
    icon.setAttribute('aria-hidden', 'true'); count.hidden = true;
    if (card.id === 'tasks') title.append(window.relayExperimental?.badge() || '');
    head.append(icon, title, count, state, tools); element.append(head, body, foot);
    return [card.id, { ...card, element, head, count, state, tools, body, foot, signature: null, shown: true, quiet: false, attention: false, live: false, label: card.title }];
  }));
  // A panel's head: how many it holds and a word for where it stands. Live is the accent; attention is amber, and comes
  // first among a narrow window's chips. A quiet panel has nothing to say, so it gets no chip there.
  function headline(card, { shown = true, count = '', word = '', live = false, attention = false, quiet = false, label = '' } = {}) {
    card.shown = shown; card.live = shown && live; card.attention = shown && attention; card.quiet = quiet; card.label = label || card.title;
    card.element.hidden = !shown; card.element.dataset.state = card.attention ? 'attention' : card.live ? 'live' : 'idle';
    const total = count ? String(count) : '';
    card.count.hidden = !total; if (card.count.textContent !== total) card.count.textContent = total;
    if (typeof word === 'string' && card.state.textContent !== word) card.state.textContent = word;
  }
  const mark = (cls, icon) => { const value = node('i', cls); if (icon) value.dataset.icon = icon; value.setAttribute('aria-hidden', 'true'); return value; };
  const actionButton = (text, handler, { icon = '', hint = '', primary = false, disabled = false } = {}) => {
    const value = button(`flow-action${primary ? ' flow-action-primary' : ''}`, undefined, handler);
    if (icon) value.append(mark('flow-action-icon', icon));
    value.append(node('span', undefined, text)); if (hint) value.title = hint; value.disabled = Boolean(disabled);
    return value;
  };
  const toolButton = (icon, label, handler) => { const value = button('icon-button flow-tool', undefined, handler); value.dataset.icon = icon; value.setAttribute('aria-label', label); value.title = label; return value; };
  // A panel redrawn while one of its buttons has the focus gives it back to the button that says the same.
  const buttonName = item => item?.dataset?.key || item?.getAttribute?.('aria-label') || item?.textContent || '';
  function redraw(card, draw) {
    const focused = card.element.contains(document.activeElement) ? document.activeElement : null, name = buttonName(focused);
    draw();
    if (!focused || focused.isConnected || !name) return;
    [...card.element.querySelectorAll('button')].find(item => buttonName(item) === name && !item.disabled)?.focus({ preventScroll: true });
  }
  // Quiet utility areas anchor the rails, apart from the panels: your preferences on the left, staying connected on the right.
  const space = node('section', 'flow-utility flow-space'), connect = node('section', 'flow-utility flow-connect');
  space.id = 'flow-space'; connect.id = 'flow-connect';
  space.setAttribute('aria-label', 'Your space'); connect.setAttribute('aria-label', 'Stay connected');
  space.append(node('h2', undefined, 'Your space'));
  // Each preference is one row: its name on the left, a small control on the right. The Lounge fills in the weather.
  const appearance = node('div', 'flow-pref flow-appearance'); appearance.append(node('span', 'flow-utility-label', 'Appearance'));
  const weather = node('div', 'flow-pref flow-weather'); weather.id = 'flow-weather';
  space.append(appearance, weather);
  connect.append(node('h2', undefined, 'Stay connected'));
  // Remote access, Share live and Keep awake sit side by side in one row.
  const connectRow = node('div', 'flow-connect-row'); connect.append(connectRow);
  const preferences = node('div', 'flow-preferences');
  // Move the actual controls so connection counts, update progress and theme state keep updating in Flow. The status
  // line moves too: it leads the chips of a narrow window, and in a wide one it stays for screen readers alone, as
  // Activity shows the same thing.
  const movedControls = [];
  function moveControls() {
    for (const id of ['flow-status', 'connect-phone', 'status-watch', 'status-watch-menu', 'relay-settings', 'appearance-options', 'keep-awake', 'update-status', 'update-more']) {
      const control = $(id); if (!control) continue;
      const marker = node('span'); marker.hidden = true;
      control.parentNode.insertBefore(marker, control); movedControls.push({ control, marker });
      if (id === 'flow-status') left.append(control);
      else if (id === 'appearance-options') appearance.append(control);
      else if (id === 'relay-settings') space.append(control);
      else if (['connect-phone', 'status-watch', 'keep-awake'].includes(id)) connectRow.append(control);
      else connect.append(control);
    }
  }
  // Moving an element takes focus off it. When the button or control in use moves with the header or into a panel,
  // focus goes back to it so the keyboard and screen readers stay where they were (#26).
  function keepFocus(move) {
    const focused = document.activeElement;
    move();
    if (focused && focused !== document.body && focused !== document.activeElement && focused.isConnected && !focused.closest('[hidden]')) focused.focus({ preventScroll: true });
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
  // The panels scroll in their own area of each rail, so the utility section under the rule stays at its foot. A panel
  // keeps its place whatever it says, so each is always found where it was.
  const rails = { left: node('div', 'flow-side-cards'), right: node('div', 'flow-side-cards') };
  rails.left.id = 'flow-left-cards'; rails.right.id = 'flow-right-cards';
  function place() {
    const tight = narrow();
    for (const side of ['left', 'right']) rails[side].replaceChildren(...CARDS.filter(card => card.side === side && card.id !== peeking).map(card => cards.get(card.id).element));
    left.replaceChildren(...(status && movedControls.length && !tight ? [status] : []), rails.left); right.replaceChildren(rails.right);
    if (peeking !== 'space') { left.append(space); right.append(connect); }
  }

  const limitParts = label => { const [period, ...scope] = String(label || "").split(" · "); return { period, scope: scope.join(" · ") }; };
  function limitName(label) {
    const { period, scope } = limitParts(label), name = /^(?:\d+-hour|Weekly|Daily|Current)$/.test(period) ? `${period} limit` : period;
    return scope ? `${name} for ${scope}` : name;
  }
  function activeWorkingProviders() {
    const state = api.getState(), c = state.conversation;
    const working = new Set();
    if (api.isRunning() && c?.status === "running" && c?.activeRun) {
      const p = c.activeRun.connection === "local" ? "local" : c.activeRun.provider;
      if (p) working.add(p);
    }
    for (const task of (c?.parallelTasks || [])) {
      if (task.status === "running") {
        const p = task.runningProvider || task.provider || task.activeRun?.provider;
        if (p) working.add(p);
      }
    }
    return working;
  }
  // The same model-aware five-hour headline and secondary allowance shown in Agents.
  const resetWords = value => { const at = new Date(value || ''); if (Number.isNaN(at.getTime())) return ''; return 'resets ' + at.toLocaleString(undefined, at.toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit', hour12: true } : { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }); };
  const remaining = row => Math.max(0, Math.min(100, Math.round(100 - row.usedPercent)));
  const level = percent => percent <= 10 ? 'critical' : percent <= 25 ? 'low' : 'ok';
  function planRows() {
    const state = api.getState();
    return ['codex', 'claude', 'gemini'].filter(provider => state.accounts?.[provider]?.authenticated === true).map(provider => {
      const usage = window.relayUsage?.snapshot?.(provider), summary = window.relayUsage?.summary?.(provider);
      return { provider, reported: usage?.available !== false, primary: summary?.primary || null, secondary: summary?.secondary || null, warning: summary?.warning || null };
    });
  }
  const leftOf = row => Math.min(...[row.primary, row.secondary].filter(Boolean).map(remaining));
  const when = value => { const at = new Date(value || ''); if (Number.isNaN(at.getTime())) return ''; return at.toLocaleString(undefined, at.toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit', hour12: true } : { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }); };
  const cap = text => text ? text[0].toUpperCase() + text.slice(1) : '';
  const selectTask = id => { if (peeking) closePeek(); return window.relayTaskThreads?.select?.(id)?.catch?.(error => api.showNotice?.(error.message)); };
  const workspaceFolders = () => api.getState().projects?.find(project => project.id === api.getState().projectId)?.folders || [];

  // ---- Activity: what's happening in the conversation that's open. While an agent works it leads with who, on what
  // and for how long, then the steps of its plan. While it waits for you it says so first. Afterwards it keeps how the
  // last run ended. Why Codeshi chose the agent is under it, as recorded at the time, with earlier runs behind a fold.
  function planFor() {
    const c = api.getState().conversation, last = c?.lastRun, running = api.isRunning();
    const held = !running && last && last.status !== 'complete' && last.plan?.steps?.some(step => step.status !== 'done');
    const run = running ? c?.activeRun : held ? last : null;
    return { steps: run?.plan?.steps || [], held: Boolean(held), running, run };
  }
  const currentStep = steps => steps.find(step => step.status === 'active') || steps.find(step => step.status === 'pending') || null;
  // An Orchestrate plan that is being made or waits for approval holds the queue, so What's next leads with it.
  function waitingPlan() {
    const plan = window.relayOrchestration?.waiting?.();
    if (!plan) return null;
    const count = plan.steps?.length || 0;
    if (plan.status === 'planning') return { chip: 'Planning', text: `${agentName(plan.planner?.provider)} is drafting the plan. Its cards show on the Plan when they’re ready.` };
    if (plan.status === 'moved') return { chip: 'Drafts waiting', board: true, text: `${plural(plan.drafts, 'drafted card')} ${plan.drafts === 1 ? 'waits' : 'wait'} on the Plan. Nothing from ${plan.drafts === 1 ? 'it' : 'them'} runs until you accept ${plan.drafts === 1 ? 'it' : 'them'}.` };
    if (plan.status === 'draft') return { chip: 'Plan waiting', text: count ? `A plan of ${plural(count, 'step')} is waiting. Nothing from it runs until you approve it.` : 'An empty plan is waiting. Open the plan to add its steps.' };
    // A draft that ended without cards shows on the Plan, beside the cards you already have, with Draft again and Dismiss.
    if (window.relayOrchestration?.notReady?.()) return { chip: 'Draft not used', board: true, text: plan.status === 'interrupted' ? 'Drafting cards stopped, so nothing was added to the Plan.' : `${agentName(plan.planner?.provider)}’s drafted cards couldn’t be used, so nothing was added to the Plan. Draft again or dismiss it there.` };
    return null;
  }
  // What happened (#107): the decisions Codeshi made on the latest finished runs, each with the reason it recorded at the
  // time and how the run ended. Read from the saved runs, with no model call; a reason is shown as recorded, never invented.
  const tierWords = { light: 'a small task', standard: 'a medium task', deep: 'a complex task' };
  function runAgent(run) {
    const model = run.model ? (window.relayModelPicker?.modelName?.(run.provider, run.model) || run.model) : '';
    return `${agentName(run.provider, run.local)}${model ? ` · ${model}` : ''}${run.effort ? ` (${run.effort})` : ''}`;
  }
  function decision(run) {
    const agent = runAgent(run), name = agentName(run.provider, run.local), why = run.routing?.reason || '';
    if (run.relation === 'review' || run.review) return { kind: 'review', title: `${name} reviewed the changes`, why: '' };
    if (run.retryOf) return { kind: 'retry', title: `Tests failed, so it tried again with ${agent}`, why: 'One step up from the run that failed, once only.' };
    if (run.fallback?.from) return { kind: 'handoff', title: `Switched from ${agentName(run.fallback.from)} to ${agent}`, why: run.fallback.reason || 'The first choice was near its usage limit.' };
    if (run.relation === 'continuation' && run.previousProvider) return { kind: 'handoff', title: `Handed the task from ${agentName(run.previousProvider)} to ${agent}`, why };
    if (run.relation === 'continuation') return { kind: 'refresh', title: `Continued with a fresh ${name} session`, why: why || 'Started over with the task’s brief so the agent’s context stays small.' };
    if (run.routing) return { kind: 'route', title: `Chose ${agent}${tierWords[run.routing.tier] ? ` for ${tierWords[run.routing.tier]}` : ''}`, why };
    return { kind: 'manual', title: `You chose ${agent}`, why: '' };
  }
  function outcome(run) {
    if (run.errorCategory === 'quota') return { text: 'Stopped at a usage limit', tone: 'bad' };
    if (run.status === 'interrupted') return { text: 'Stopped', tone: 'muted' };
    if (run.status === 'failed' || run.status === 'incomplete') return { text: 'Didn’t finish', tone: 'bad' };
    const check = run.check?.status;
    if (check === 'passed') return { text: 'Tests passed', tone: 'good' };
    if (check === 'failed') return { text: 'Tests failed', tone: 'bad' };
    if (check === 'deferred') return { text: 'Tests wait for your review', tone: 'muted' };
    if (check === 'running') return { text: 'Testing…', tone: 'muted' };
    return { text: 'Done', tone: 'muted' };
  }
  // Why this agent (#107): the run working now leads, or the latest finished run.
  function happening() {
    const c = api.getState().conversation, runs = c?.runs || [], active = api.isRunning() ? c?.activeRun : null;
    if (active && !active.purpose && active.routing) return { run: active, ...decision(active) };
    const finished = runs.filter(run => run.endedAt && run.relation !== 'assessment');
    const last = finished[finished.length - 1];
    return last ? { run: last, ...decision(last) } : null;
  }
  const phaseWords = { starting: 'starting', probing: 'checking usage', reasoning: 'thinking', responding: 'writing', tool: 'running tools', compacting: 'organizing its context', approval: 'waiting for you' };
  const elapsedWords = since => { const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since || '')) / 1000)); if (!Number.isFinite(seconds)) return ''; const minutes = Math.floor(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; };
  const modelLabel = run => run?.model ? (window.relayModelPicker?.modelName?.(run.provider, run.model) || run.model) : '';
  const runIcon = run => run?.connection === 'local' || run?.local === true ? 'local' : run?.provider || '';
  // The approval, question or offer is in the chat: this brings it into view.
  const showLatest = () => { const jump = $('jump-latest'), scroller = $('messages-scroll'); if (jump && !jump.hidden) jump.click(); else if (scroller) scroller.scrollTop = scroller.scrollHeight; };
  function activityView(state) {
    const c = state.conversation, view = { tone: 'idle', word: '', lead: null, notices: [], steps: [], held: false, queue: 0, paused: false, label: '' };
    if (!c) return view;
    const approvals = c.pendingApprovals || [], running = api.isRunning() && c.activeRun ? c.activeRun : null, plan = waitingPlan(), { steps, held } = planFor();
    const split = (c.splitRuns || []).findLast?.(run => run.status === 'working'), last = running ? null : c.lastRun || null, done = steps.filter(step => step.status === 'done').length;
    const agent = run => agentName(run?.provider, run?.connection === 'local' || run?.local === true);
    view.queue = (c.queue || []).length; view.paused = Boolean(c.queuePaused); view.waitsForSlot = Boolean(c.queueWaitsForSlot);
    if (c.handoffOffer) { const offer = c.handoffOffer; view.notices.push({ text: `${agentName(offer.from.provider)} has used ${Math.round(offer.from.usedPercent)}% of its limit. Hand off to ${agentName(offer.to.provider)}${offer.to?.billingSource !== 'subscription' ? ' and accept its charges' : ''} in the chat.`, label: 'Show', run: showLatest }); }
    if (plan?.chip === 'Plan waiting') view.notices.push({ text: plan.text, label: 'Open plan', run: () => window.relayPlanView?.open?.() });
    else if (plan?.board) view.notices.push({ text: plan.text, label: 'Open the Plan', run: () => window.relayBoard?.open?.() });
    if (approvals.length) {
      const asking = approvals.every(item => item.kind === 'question');
      view.tone = 'attention'; view.word = 'Needs you'; view.steps = steps;
      view.lead = { icon: runIcon(running), title: running ? agent(running) : 'The agent', model: modelLabel(running), detail: asking ? (approvals.length === 1 ? 'Has a question for you' : `Has ${approvals.length} questions for you`) : approvals.length === 1 ? 'Waiting for your approval' : `Waiting for ${approvals.length} approvals`, since: running?.startedAt || null, action: { label: asking ? 'Answer' : 'Review', run: showLatest, hint: 'Show it in the chat' } };
    } else if (running) {
      view.tone = 'live'; view.word = 'Working'; view.steps = steps;
      if (running.purpose === 'routing') view.lead = { icon: runIcon(running), title: 'Choosing an agent', detail: `${agent(running)} is ${running.phase === 'probing' ? 'checking usage' : 'rating the task'}`, since: running.startedAt };
      else if (running.purpose === 'review') view.lead = { icon: runIcon(running), title: agent(running), model: modelLabel(running), detail: 'Reviewing the changes', since: running.startedAt };
      else view.lead = { icon: runIcon(running), title: agent(running), model: modelLabel(running), detail: cap(phaseWords[running.phase] || 'working'), since: running.startedAt, progress: steps.length ? { done, total: steps.length } : null };
    } else if (c.resume || c.limitSwitching) {
      const waiting = c.resume?.providers?.[0], reset = c.resume?.resetsAt ? resetWords(c.resume.resetsAt) : '';
      view.tone = 'live'; view.word = 'Waiting';
      view.lead = { icon: waiting || '', title: `Waiting for ${agentName(waiting)}’s limit`, detail: reset ? cap(reset) : 'Continues when it resets' };
    } else if (plan) {
      view.tone = plan.chip === 'Planning' ? 'live' : plan.chip === 'Plan waiting' ? 'attention' : 'idle';
      view.word = plan.chip === 'Planning' ? 'Planning' : plan.chip === 'Plan waiting' ? 'Needs you' : '';
      if (plan.chip === 'Planning') view.lead = { icon: '', title: 'Drafting a plan', detail: 'Its cards show on the Plan when they’re ready' };
    } else if (split) {
      // Activity carries the split's steps (what and how each part is being done) and Stop; Tasks lists openable chats.
      const model = window.relaySplitProgress?.describe?.(c), asking = model?.rows.find(row => row.task?.approvals);
      view.tone = asking ? 'attention' : 'live'; view.word = asking ? 'Needs you' : 'Working'; view.split = true;
      // The title says how the parts run, and the detail which step it's on, so one glance tells side by side from in turn.
      view.lead = { icon: '', title: model ? (model.layout === 'unknown' ? model.title : cap(model.shape)) : `Working in ${plural(split.cards?.length || 2, 'part')}`, detail: model ? (model.asking ? model.summary : [model.where, model.summary].filter(Boolean).join(' · ')) : 'Working', since: split.startedAt || null,
        ...(model ? { progress: { done: model.done, total: model.parts, word: 'part' } } : {}),
        ...(asking ? { action: { label: 'Answer', run: () => window.relaySplitProgress.watch(asking.task), hint: `Open “${asking.label}”` } } : {}) };
    } else if (last && !state.taskDraft) {
      const files = c.checkpoints?.[last.id]?.files, ended = outcome(last), stopped = last.status !== 'complete';
      // A finished run keeps the steps it worked through as a recap, when it marked every one of them done.
      const recap = last.plan?.steps || [];
      view.steps = held ? steps : !stopped && recap.every(step => step.status === 'done') ? recap : []; view.held = Boolean(held);
      view.tone = stopped && last.status !== 'interrupted' ? 'attention' : 'idle';
      view.word = last.status === 'interrupted' ? 'Stopped' : last.errorCategory === 'quota' ? 'At a limit' : stopped ? 'Didn’t finish' : 'Done';
      const detail = held && steps.length ? `Stopped at step ${Math.min(done + 1, steps.length)} of ${steps.length}` : [ended.text, files && !stopped ? `${plural(files, 'file')} changed` : ''].filter(Boolean).join(' · ');
      view.lead = { icon: runIcon(last), title: agent(last), model: modelLabel(last), detail, at: when(last.endedAt) };
    }
    if (!view.lead && !view.notices.length) view.word = view.queue ? (view.paused ? 'Queue paused' : 'Queued') : 'Idle';
    if (c.handoffOffer) { view.tone = 'attention'; view.word = 'Needs you'; }
    view.label = c.handoffOffer ? 'Handoff needs your approval' : view.lead ? [view.lead.title, view.lead.detail, view.lead.progress && !view.split ? `step ${Math.min(view.lead.progress.done + 1, view.lead.progress.total)} of ${view.lead.progress.total}` : ''].filter(Boolean).join(' · ') : view.notices[0]?.text || (view.queue ? `${plural(view.queue, 'message')} queued${view.paused ? ' · paused' : ''}` : '');
    return view;
  }
  // Under the lead, which already names the agent and model, why it was chosen is said without them.
  function shortDecision(row) {
    const run = row.run;
    if (row.kind === 'route') return tierWords[run.routing?.tier] ? `Chosen for ${tierWords[run.routing.tier]}` : 'Chosen by routing';
    if (row.kind === 'retry') return 'A second try, after tests failed';
    if (row.kind === 'handoff') { const from = run.fallback?.from || run.previousProvider; return from ? `Took over from ${agentName(from)}` : 'Took over the task'; }
    if (row.kind === 'refresh') return 'Continued in a fresh session';
    return row.title;
  }
  // The time an agent has worked moves each second without redrawing the panel.
  let clock = null, activityScope = '';
  function tickClock() { if (!clock?.element) return; const text = elapsedWords(clock.since); if (text && clock.element.textContent !== text) clock.element.textContent = text; }
  // A long plan shows the steps around where the agent is: the one it just finished, the one it's on and what comes next.
  const STEPS_SHOWN = 7, STEPS_AROUND = 5;
  function stepList(steps, held) {
    const list = node('ol', 'flow-steps'), current = currentStep(steps), long = steps.length > STEPS_SHOWN;
    const at = current ? steps.indexOf(current) : steps.length - 1, from = long ? Math.max(0, Math.min(at - 1, steps.length - STEPS_AROUND)) : 0, to = long ? from + STEPS_AROUND : steps.length;
    const more = (cls, text) => { const item = node('li', `flow-step flow-step-more ${cls}`), tick = node('span', 'flow-step-mark'); tick.setAttribute('aria-hidden', 'true'); item.append(tick, node('span', 'flow-step-text', text)); return item; };
    if (from) list.append(more('done', `${plural(from, 'earlier step')} done`));
    for (const step of steps.slice(from, to)) {
      const item = node('li', `flow-step ${step.status}`), tick = node('span', 'flow-step-mark'); tick.setAttribute('aria-hidden', 'true');
      item.append(tick, node('span', 'flow-step-text', step.text));
      if (held && step.status === 'active') item.dataset.held = 'true';
      if (step === current && !held && step.status === 'active') item.setAttribute('aria-current', 'step');
      item.setAttribute('aria-label', `${step.status === 'done' ? 'Done' : step.status === 'active' ? (held ? 'Stopped at' : 'Now') : 'To do'}: ${step.text}`);
      list.append(item);
    }
    if (to < steps.length) list.append(more(steps.slice(to).every(step => step.status === 'done') ? 'done' : 'pending', `${plural(steps.length - to, 'more step')}`));
    return list;
  }
  // The steps of a split Flow is finishing by itself: grouped by step when some run side by side, numbered when in turn,
  // showing what each part is doing, its agent/model, its size, and an Answer button if it needs your approval.
  function splitStepList(split) {
    const stepped = split.layout === 'mixed', numbered = split.layout === 'chain';
    const list = node('ol', `flow-split-steps${stepped ? ' flow-split-stepped' : ''}`);
    list.setAttribute('aria-label', `The steps of “${split.run.group || 'this message'}”`);
    const heading = (label, note) => { const li = node('li', 'flow-split-step'); li.setAttribute('role', 'presentation'); li.append(node('span', '', label)); if (note) li.append(node('span', 'flow-split-step-note', note)); return li; };
    const stepItem = row => {
      const li = node('li', 'flow-split-step-item');
      li.dataset.state = row.state;
      if (row.kind !== 'part') li.dataset.kind = row.kind;
      const tick = node('span', 'flow-step-mark'); tick.setAttribute('aria-hidden', 'true');
      const main = node('div', 'flow-split-step-main'), head = node('div', 'flow-split-step-head'), sub = node('div', 'flow-split-step-sub');
      if (numbered && row.step !== undefined) { const num = node('span', 'flow-split-num', `${row.step + 1}`); num.setAttribute('aria-hidden', 'true'); head.append(num); }
      const title = node('span', 'flow-split-step-title', row.label); title.title = row.label; head.append(title);
      if (row.size) { const size = node('span', 'flow-split-size', row.size); size.dataset.size = row.size; size.title = row.sizeWhy; head.append(size); }
      const words = row.kind === 'review' && row.state === 'waiting' ? 'After every part' : row.doing ? `${row.words} · ${clip(row.doing, 56)}` : row.words;
      const statusEl = node('span', 'flow-split-step-status', words); statusEl.title = row.doing ? `${row.words} · ${row.doing}` : words; sub.append(statusEl);
      if (row.agent) {
        const icon = node('i', `agent-icon ${row.provider}`), agent = node('span', 'flow-split-agent', row.agent);
        icon.setAttribute('aria-hidden', 'true'); agent.title = row.agent;
        sub.append(node('span', 'task-row-sub', '·'), icon, agent);
      }
      main.append(head, sub); li.append(tick, main);
      if (row.task?.approvals) {
        const act = button('flow-row-action', 'Answer', () => window.relaySplitProgress.watch(row.task));
        act.title = `Open “${row.label}” to answer`;
        li.append(act);
      }
      return li;
    };
    if (stepped) {
      for (const step of split.steps) {
        list.append(heading(`Step ${step.step + 1}`, step.rows.length > 1 ? `${step.rows.length} side by side` : ''));
        for (const row of step.rows) list.append(stepItem(row));
      }
    } else for (const row of split.rows.filter(row => row.kind === 'part')) list.append(stepItem(row));
    const extra = split.rows.filter(row => row.kind !== 'part');
    if (extra.length && stepped) list.append(heading('Then', 'checked together'));
    for (const row of extra) list.append(stepItem(row));
    return list;
  }
  function renderActivity(card) {
    const state = api.getState(), nextScope = scope();
    if (nextScope !== activityScope) { activityScope = nextScope; }
    const view = activityView(state), row = happening(), reason = row && row.kind !== 'manual' ? row : null;
    const splitModel = view.split ? window.relaySplitProgress?.describe?.(state.conversation) : null;
    const splitStopping = view.split ? Boolean(window.relaySplitProgress?.stopping?.()) : false;
    const splitSig = splitModel ? [splitModel.run.id, splitModel.shape, splitModel.where, splitModel.summary, splitModel.done, splitModel.parts, splitStopping, splitModel.rows.map(item => [item.key, item.label, item.state, item.words, item.doing, item.agent, item.size, item.step, item.task?.approvals || 0, Boolean(item.task?.conversationId)])] : null;
    headline(card, { word: view.word, live: view.tone === 'live', attention: view.tone === 'attention', quiet: !view.lead && !view.notices.length && !view.queue, label: view.label });
    const signature = JSON.stringify([state.projectId, state.taskId, view, splitSig, reason ? [reason.run.id, reason.kind, reason.title, reason.why] : null]);
    if (signature === card.signature) { tickClock(); return; }
    card.signature = signature; clock = null;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    if (view.lead) {
      const lead = node('div', 'flow-now'), line = node('div', 'flow-now-line'), who = node('span', 'flow-now-who'), sub = node('div', 'flow-now-sub');
      lead.dataset.tone = view.tone;
      who.append(node('strong', undefined, view.lead.title)); if (view.lead.model) who.append(node('span', 'flow-now-model', view.lead.model));
      line.append(mark(view.lead.icon ? `agent-icon ${view.lead.icon}` : 'flow-now-mark'), who);
      if (view.lead.since) { const time = node('span', 'flow-now-time', elapsedWords(view.lead.since)); clock = { element: time, since: view.lead.since }; line.append(time); }
      else if (view.lead.at) line.append(node('span', 'flow-now-time', view.lead.at));
      sub.append(node('span', 'flow-now-detail', view.lead.detail));
      if (view.lead.progress && !view.split) sub.append(node('span', 'flow-now-count', `${view.lead.progress.done} of ${view.lead.progress.total} done`));
      if (view.lead.action) { const act = button('flow-now-action', view.lead.action.label, () => view.lead.action.run()); if (view.lead.action.hint) act.title = view.lead.action.hint; sub.append(act); }
      lead.append(line, sub);
      if (view.split && splitModel && window.relaySplitProgress?.bar) {
        lead.append(window.relaySplitProgress.bar(splitModel, 'flow-split-bar flow-now-split-bar'));
      } else if (view.lead.progress) {
        const bar = node('div', 'flow-progress'), { done, total } = view.lead.progress;
        bar.style.setProperty('--done', `${Math.round(done / total * 100)}%`);
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(total)); bar.setAttribute('aria-valuenow', String(done)); bar.setAttribute('aria-label', `${done} of ${plural(total, view.lead.progress.word || 'step')} done`);
        lead.append(bar);
      }
      body.append(lead);
    }
    for (const notice of view.notices) {
      const item = node('div', 'flow-notice'); item.append(node('span', 'flow-notice-text', notice.text));
      if (notice.label) item.append(button('flow-now-action', notice.label, () => notice.run()));
      body.append(item);
    }
    if (view.split && splitModel?.rows?.length) body.append(splitStepList(splitModel));
    else if (view.steps.length) body.append(stepList(view.steps, view.held));
    if (view.queue) body.append(node('p', 'flow-queued', `${plural(view.queue, 'message')} queued after this${view.paused ? ' · paused' : view.waitsForSlot ? ' · starts when a task finishes' : ''}`));
    if (view.split && window.relaySplitProgress?.stop) {
      card.foot.append(actionButton(splitStopping ? 'Stopping…' : 'Stop', () => window.relaySplitProgress.stop(), { hint: 'Stop every part and move them to the Plan', disabled: splitStopping }));
    }
    // Why this agent: the run that's working or the last one, as recorded when it was chosen. A split's parts each have
    // their own agent, shown above, so an earlier run's reason isn't repeated under it.
    if (reason && view.lead && !view.split) {
      const why = node('div', 'flow-why'), title = node('span', 'flow-why-title');
      why.dataset.kind = reason.kind; title.append(mark('flow-why-icon'), node('span', undefined, shortDecision(reason))); why.append(title);
      if (reason.why) { why.append(node('span', 'flow-why-reason', reason.why)); }
      body.append(why);
    }
  }

  // ---- Tasks: the workspace chat and every task running beside it (#88, #107), in the sidebar's own order and words:
  // what needs you first, then what's working, then what finished. A row switches to its conversation, and a task that
  // is ready offers its review there and then.
  // A split's parts that Flow is finishing by itself (task.managed) share one group here, with each part under it
  // (split-progress.js describes them), and never appear as rows of their own, on the Plan row, or outside Flow.
  // The Plan chat (#162) shows only when it waits for an approval; the Plan view lists it with the cards' tasks.
  const visibleTasks = state => (state.conversation?.parallelTasks || []).filter(task => !task.managed && (task.purpose === 'plan-chat' ? Boolean(task.approvals || task.id === state.taskId) : task.purpose !== 'project-review' || task.id === state.taskId || task.approvals));
  const taskMergeable = task => Boolean(task.hasWorktree && ['complete', 'stopped', 'failed'].includes(task.status));
  const taskEnded = task => !['running', 'waiting'].includes(task.status) && !taskMergeable(task);
  const TASK_STATUS_WORDS = { complete: 'finished', stopped: 'stopped', failed: 'didn’t finish', discarded: 'discarded', cancelled: 'cancelled', blocked: 'blocked', lost: 'copy gone', detached: 'folder removed' };
  function taskStatusText(task) {
    if (task.testing) return 'Checking combined result…';
    if (task.status === 'waiting') return task.held ? 'paused — ready to start' : 'waiting to start';
    if (task.status === 'integrated') return task.integration?.files ? `${plural(task.integration.files, 'file')} merged` : 'merged';
    if (task.status === 'kept') return task.integration?.branch ? `kept on ${task.integration.branch}` : 'kept as branch';
    return TASK_STATUS_WORDS[task.status] || task.status;
  }
  const TASKS_SHOWN = 6;
  let tasksProjectId = null, tasksAll = false;
  const SPLIT_ROW_STATE = { running: 'working', waiting: 'waiting', done: 'finished' };
  const describeTask = task => window.relayTaskThreads?.describe?.(task) || {
    state: task.approvals > 0 ? 'approval' : taskMergeable(task) ? 'review' : task.status === 'running' ? 'working' : task.status === 'waiting' ? (task.held ? 'paused' : 'waiting') : ['complete', 'integrated', 'kept'].includes(task.status) ? 'finished' : ['failed', 'blocked', 'lost'].includes(task.status) ? 'failed' : 'stopped',
    word: task.approvals > 0 ? plural(task.approvals, 'approval') : taskMergeable(task) ? 'Ready to review' : cap(taskStatusText(task)), time: '', rank: 0, mergeable: taskMergeable(task),
    bucket: task.approvals > 0 || taskMergeable(task) || (task.status === 'waiting' && task.held) ? 0 : ['running', 'waiting'].includes(task.status) ? 1 : 2,
  };
  // In Flow the agent creates tasks automatically, so this panel lists them without a manual New task button.
  // For a running split, Activity carries the steps and progress; Tasks lists only the openable part chats so you can switch into each one.
  function renderTasks(card) {
    const state = api.getState(), c = state.conversation, folders = workspaceFolders();
    if (state.projectId !== tasksProjectId) { tasksAll = false; tasksProjectId = state.projectId; }
    if (cardOff('tasks')) { headline(card, { shown: false }); card.signature = null; card.body.replaceChildren(); card.foot.replaceChildren(); card.tools.replaceChildren(); return; }
    const tasks = visibleTasks(state);
    // A Plan's cards and the Plan chat run as tasks too, but they're followed and read on the Plan, so they share one row
    // here that opens the Plan view instead of keeping the Plan chat or a card inside Flow.
    const isPlanTask = task => Boolean(task && !task.managed && (task.board || task.purpose === 'plan-chat'));
    const planChatTask = tasks.find(task => task.purpose === 'plan-chat') || null;
    const planOpen = tasks.filter(task => task.board && (['doing', 'review'].includes(task.cardColumn) || task.id === state.taskId || task.approvals > 0));
    const own = tasks.filter(task => !isPlanTask(task)).map((task, index) => ({ task, about: describeTask(task), index })).sort((a, b) => a.about.bucket - b.about.bucket || a.about.rank - b.about.rank || a.index - b.index);
    const elsewhere = Boolean(state.taskId), mainRunning = Boolean(elsewhere ? state.status?.runningConversationId : api.isRunning());
    const mainPending = elsewhere ? (Array.isArray(state.status?.pendingApprovals) ? state.status.pendingApprovals : []) : (c?.pendingApprovals || []);
    const planWorking = planOpen.filter(task => task.status === 'running').length + (planChatTask?.status === 'running' ? 1 : 0), planWaiting = planOpen.filter(task => task.status === 'waiting').length;
    const planNeeds = planOpen.reduce((sum, task) => sum + (task.approvals || 0), 0) + (planChatTask?.approvals || 0), planReview = planOpen.filter(task => task.cardColumn === 'review').length;
    const split = window.relaySplitProgress?.describe?.(c) || null;
    const splitChats = split
      ? split.rows.filter(item => item.task && (item.task.conversationId || item.task.approvals || item.task.id === state.taskId)).map(item => ({ task: item.task, label: item.label, state: item.state === 'attention' ? (item.task.approvals ? 'approval' : 'failed') : SPLIT_ROW_STATE[item.state] || 'waiting', word: item.words, agent: item.agent }))
      : (c?.parallelTasks || []).filter(task => task.managed && (task.conversationId || task.approvals || task.id === state.taskId)).map(task => { const about = describeTask(task); return { task, label: task.title, state: about.state, word: about.word, agent: '' }; });
    const splitRunning = splitChats.filter(item => item.task.status === 'running').length;
    const splitAsking = splitChats.filter(item => item.task.approvals > 0).length;
    const needs = own.filter(item => item.about.bucket === 0).length + (planNeeds ? 1 : 0) + (splitAsking ? 1 : 0), working = own.filter(item => item.task.status === 'running').length + planWorking + splitRunning;
    const total = own.length + planOpen.length + splitChats.length, listed = Boolean(own.length || planOpen.length || planChatTask || state.taskId || splitChats.length);
    headline(card, { count: total, word: listed ? '' : 'None', live: working > 0, attention: needs > 0, quiet: !listed, label: `Tasks${needs ? ` · ${needs} need${needs === 1 ? 's' : ''} you` : working ? ` · ${working} working` : total ? ` · ${total}` : ''}` });
    const signature = JSON.stringify([
      state.projectId, state.taskId, mainRunning, mainPending.map(item => item.kind), tasksAll, total ? Math.floor(Date.now() / 60000) : 0,
      folders.map(folder => [folder.id, folder.displayName || folder.name]),
      tasks.map(task => [task.id, task.title, task.status, task.folderName, task.mode, task.provider, task.runningProvider, task.runningModel, task.model, task.managed, task.runningPhase, task.runningStep, task.approvals, task.questions, task.testing, task.hasWorktree, task.held, task.reason, task.conversationId, task.integration?.files, task.integration?.branch, task.cardColumn]),
      splitChats.map(item => [item.task.id, item.label, item.state, item.word, item.agent, item.task.status, item.task.runningProvider, item.task.runningModel, item.task.runningStep, item.task.approvals, item.task.conversationId]),
    ]);
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    // Task limits live in Settings › Routing & handoffs (#190); this is one click from the tasks they limit.
    card.tools.replaceChildren(...(total && window.relayLimits?.open ? [toolButton('sliders', 'Task limits: working time, tokens, spend and agents', () => window.relayLimits.open())] : []));
    if (!listed) return;
    // One row per conversation, drawn as the sidebar draws it. The whole row switches to it; the one you're in is marked
    // and isn't a button.
    const list = node('ul', 'flow-tasks');
    const row = ({ key, title, visual, word, sub, badge, here, main, onOpen, openLabel, note, actions = [], end = null }) => {
      const item = node('li', 'flow-task'), face = here ? node('div', 'task-row flow-task-row') : button('task-row flow-task-row', undefined, onOpen), icon = node('span', main ? 'task-row-main-icon' : 'task-row-icon');
      if (key) item.dataset.taskId = key; else item.dataset.role = 'main';
      if (main) face.classList.add('task-row-main');
      if (here) { item.classList.add('flow-task-selected'); item.setAttribute('aria-current', 'true'); face.classList.add('active'); }
      else { face.title = openLabel; face.setAttribute('aria-label', `${openLabel}${word ? `, ${word.toLowerCase()}` : ''}`); }
      face.dataset.state = visual; icon.setAttribute('aria-hidden', 'true');
      const name = node('span', 'task-row-title', title); name.title = title;
      if (word) {
        const text = node('span', 'task-row-body'), top = node('span', 'task-row-head'), meta = node('span', 'task-row-meta');
        face.classList.add('task-row-detailed'); top.append(name);
        if (badge) top.append(node('span', 'task-row-badge flow-task-badge', String(badge)));
        meta.append(node('span', 'task-row-state', word)); if (sub) meta.append(node('span', 'task-row-sub', ` · ${sub}`));
        text.append(top, meta); face.append(icon, text);
      } else face.append(icon, name);
      item.append(face); if (end) item.append(end);
      if (note) { const line = node('p', 'flow-task-note', clip(note, 110)); line.title = note; item.append(line); }
      if (actions.length) { const offers = node('div', 'flow-task-actions'); offers.append(...actions); item.append(offers); }
      return item;
    };
    const asking = mainPending.length > 0 && mainPending.every(item => item.kind === 'question');
    list.append(row({ title: 'Workspace chat', main: true, visual: mainPending.length ? (asking ? 'question' : 'approval') : mainRunning ? 'working' : 'idle', word: mainPending.length ? (asking ? (mainPending.length === 1 ? 'Needs your answer' : `${mainPending.length} questions`) : mainPending.length === 1 ? 'Needs approval' : `${mainPending.length} approvals`) : mainRunning ? 'Working' : '', badge: mainPending.length, here: !elsewhere, onOpen: () => selectTask(null), openLabel: 'Switch to the workspace chat' }));
    const several = folders.length > 1;
    for (const { task, label, state: visual, word, agent } of splitChats) {
      const provider = (task.status === 'running' && task.runningProvider) || task.provider;
      const modelId = task.runningModel || task.model, model = modelId ? window.relayModelPicker?.modelName?.(provider, modelId) || modelId : '';
      const who = agent || [agentNames[provider] || '', model].filter(Boolean).join(' · ');
      const doing = task.status === 'running' && task.runningStep ? `on “${clip(task.runningStep, 32)}”` : '';
      list.append(row({ key: task.id, title: label, visual, word, sub: [doing || who, several ? task.folderName : ''].filter(Boolean).join(' · '), badge: task.approvals || 0, here: !state.taskDraft && state.taskId === task.id, onOpen: () => selectTask(task.id), openLabel: `Open “${label}”` }));
    }
    if (planOpen.length || planChatTask) {
      const targetId = (planChatTask && (planChatTask.approvals > 0 || state.taskId === planChatTask.id)) ? planChatTask.id
        : (state.taskId && planOpen.some(task => task.id === state.taskId)) ? state.taskId
          : (planOpen.find(task => task.approvals > 0)?.id || (planOpen.length === 1 ? planOpen[0].id : null));
      const word = planNeeds ? (planNeeds === 1 ? 'Needs approval' : `${planNeeds} approvals`) : planWorking ? `${planWorking} working` : planReview ? `${planReview} to review` : planWaiting ? `${planWaiting} waiting` : planOpen.length ? plural(planOpen.length, 'card') : 'Chat';
      const sub = [planWorking && planNeeds ? `${planWorking} working` : '', planWaiting && (planWorking || planNeeds) ? `${planWaiting} waiting` : '', planReview && (planWorking || planNeeds) ? `${planReview} to review` : ''].filter(Boolean).join(' · ');
      list.append(row({ key: 'plan', title: 'Plan', visual: planNeeds ? 'approval' : planWorking ? 'working' : planReview ? 'review' : 'waiting', word, sub, badge: planNeeds, here: false, onOpen: () => { if (peeking) closePeek(); return window.relayBoard?.openTask?.(targetId ?? null) ?? window.relayBoard?.open?.(); }, openLabel: 'Open the Plan to follow its cards and read their results' }));
    }
    for (const { task, about } of tasksAll ? own : own.slice(0, TASKS_SHOWN)) {
      const provider = (task.status === 'running' && task.runningProvider) || task.provider, running = task.status === 'running', actions = []; let end = null;
      const doing = running && task.runningStep ? `on “${clip(task.runningStep, 32)}”` : '';
      if (task.status === 'waiting' && task.held && window.relayTaskThreads?.resume) actions.push(button('flow-row-action', 'Start', () => window.relayTaskThreads.resume(task.id)));
      if (task.managed) { /* Flow finishes it. */ }
      else if (about.mergeable && window.relayTaskThreads?.review) { const act = button('flow-row-action', 'Review & merge', () => window.relayTaskThreads.review(task.id)); act.title = `Review and merge “${task.title}”`; actions.push(act); }
      else if (taskEnded(task) && window.relayTaskThreads?.close) { const remove = toolButton('close', `${window.relayTaskThreads.removeLabel || 'Remove from list'}: ${task.title}`, () => window.relayTaskThreads.close(task.id)); remove.title = [window.relayTaskThreads.removeLabel || 'Remove from list', window.relayTaskThreads.removeHint?.(task.id) || ''].filter(Boolean).join('. '); remove.classList.add('flow-row-remove'); end = remove; }
      list.append(row({ key: task.id, title: task.title, visual: about.state, word: about.bucket < 2 ? about.word : '', sub: [doing || agentNames[provider] || '', several ? task.folderName : '', about.time].filter(Boolean).join(' · '), badge: task.approvals || 0, here: !state.taskDraft && state.taskId === task.id, onOpen: () => selectTask(task.id), openLabel: `Switch to “${task.title}”`, note: task.reason && ['waiting', 'failed', 'stopped', 'blocked'].includes(task.status) ? task.reason : '', actions, end }));
    }
    body.append(list);
    if (own.length > TASKS_SHOWN) {
      const toggle = button('flow-fold', tasksAll ? 'Show fewer' : `${own.length - TASKS_SHOWN} more`, () => { tasksAll = !tasksAll; render(); });
      toggle.dataset.key = 'more-tasks'; toggle.setAttribute('aria-expanded', String(tasksAll)); card.foot.append(toggle);
    }
  }

  // ---- Usage: what's left on each connected agent's plan, one row each. A row opens all of that agent's limits. When
  // an agent runs low the panel says so, with what Flow does about it.
  function renderUsage(card) {
    const state = api.getState(), rows = planRows(), working = activeWorkingProviders(), read = rows.filter(row => row.primary);
    const low = read.filter(row => leftOf(row) <= 25).sort((a, b) => leftOf(a) - leftOf(b)), worst = low[0] || null, others = read.filter(row => leftOf(row) > 25).map(row => agentNames[row.provider]);
    headline(card, { word: worst ? `${agentNames[worst.provider]} ${leftOf(worst) ? 'is low' : 'is at its limit'}` : '', attention: Boolean(worst && leftOf(worst) <= 10), quiet: !rows.length, label: read.map(row => `${agentNames[row.provider]} ${leftOf(row)}% left`).join(' · ') || 'Usage' });
    card.element.dataset.level = worst ? level(leftOf(worst)) : 'ok';
    const signature = JSON.stringify([rows, state.provider, [...working].sort()]);
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    if (!rows.length) {
      body.append(node('p', 'flow-empty', 'No agent is connected.'));
      card.foot.append(actionButton('Connect an agent', () => window.relaySettings?.open?.('accounts')));
      return;
    }
    const list = node('ul', 'flow-plans');
    for (const row of rows) {
      const name = agentNames[row.provider], item = node('li', 'flow-plan'), open = button('flow-usage-row', undefined, event => window.relayUsage?.open?.(row.provider, event.currentTarget || open));
      const top = node('span', 'flow-plan-head'), icon = node('i', `agent-icon ${row.provider}`); icon.setAttribute('aria-hidden', 'true');
      item.dataset.provider = row.provider; open.dataset.provider = row.provider; open.dataset.key = `usage-${row.provider}`;
      top.append(icon, node('strong', undefined, name));
      if (working.has(row.provider)) { item.classList.add('flow-plan-active'); const badge = node('span', 'flow-plan-working-badge'), dot = node('span', 'flow-pulse-dot'); dot.setAttribute('aria-hidden', 'true'); badge.setAttribute('aria-label', `${name} is working`); badge.append(dot); top.append(badge); }
      if (!row.primary) {
        top.append(node('span', 'flow-plan-value', row.reported ? 'No reading yet' : 'Not reported'));
        open.append(top); open.title = `${name}: check its limits`;
      } else {
        const limits = [row.primary, row.secondary].filter(Boolean).sort((a, b) => remaining(a) - remaining(b)), [primary, secondary] = limits;
        const percent = remaining(primary), reset = resetWords(primary.resetsAt), meter = node('span', 'flow-meter'), foot = node('span', 'flow-plan-foot');
        item.dataset.level = level(percent); open.dataset.level = level(percent);
        top.append(node('span', 'flow-plan-value', `${percent}% left`));
        meter.style.setProperty('--left', `${percent}%`); meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', `${percent}% of ${name}’s ${primary.label} allowance left`);
        foot.append(node('span', 'flow-plan-when', `${limitName(primary.label)}${reset ? ` · ${reset}` : ''}`));
        if (secondary) { const other = node('span', 'flow-plan-secondary', `${secondary.label} · ${remaining(secondary)}% left`), otherReset = resetWords(secondary.resetsAt); other.dataset.level = level(remaining(secondary)); if (otherReset) other.title = cap(otherReset); foot.append(other); }
        open.append(top, meter, foot); open.title = `All of ${name}’s limits`;
      }
      open.setAttribute('aria-label', `${name}${row.primary ? `: ${leftOf(row)}% left at its closest limit` : ''}. Show all its limits`);
      item.append(open); list.append(item);
    }
    body.append(list);
    if (worst) body.append(node('p', 'flow-usage-note', others.length ? `Flow moves new work to ${others.join(' or ')} before ${agentNames[worst.provider]} runs out.` : 'No other agent has much left. Flow waits for the reset, or offers a local model.'));
  }

  // ---- Changes: the files that differ from the last commit, one row each with what happened to it and the lines it
  // gained and lost. A row opens that file's changes, with the other files beside it. Undo takes the last run back out
  // after showing what would change. A folder without Git lists what each run changed instead.
  function changedRuns() {
    const c = api.getState().conversation, saved = c?.checkpoints || {}, runs = c?.runs || [];
    return Object.entries(saved).filter(([, entry]) => entry?.files).map(([runId, entry]) => ({ runId, files: entry.files, undone: entry.undone || null, run: runs.find(run => run.id === runId) || null }))
      .sort((a, b) => String(b.run?.startedAt || '').localeCompare(String(a.run?.startedAt || '')));
  }
  const FILES_SHOWN = 8;
  let gitKey = '', gitAsked = 0, gitCost = 0;
  // Git is read again when a run changes files, and now and then while Flow shows: more often while an agent works,
  // and less often in a folder where reading it is slow.
  function watchGit() {
    if (!on || document.hidden || !window.relayGit?.refresh) return;
    const state = api.getState(); if (!state.projectId || !state.ready) return;
    const key = `${state.projectId}:${JSON.stringify(state.conversation?.checkpoints || {})}`, age = Date.now() - gitAsked;
    if (key === gitKey && age < Math.max(api.isRunning() ? 10000 : 45000, gitCost * 25)) return;
    const asked = gitAsked = Date.now(); gitKey = key;
    Promise.resolve(window.relayGit.refresh()).then(() => { if (asked === gitAsked) gitCost = Date.now() - asked; }, () => {});
  }
  const undoRun = runId => window.relayRewind?.open?.({ kind: 'run', id: runId }), redoRun = rewindId => window.relayRewind?.open?.({ kind: 'rewind', id: rewindId });
  function renderChanges(card) {
    const state = api.getState(), git = window.relayGit?.data?.() || null, runs = changedRuns(), running = api.isRunning(), latest = runs[0] || null;
    const repos = (git?.repositories || []).filter(repo => repo.available), groups = repos.map(repo => ({ repo, files: window.relayGit.files(repo) })).filter(group => group.files.length);
    const files = groups.flatMap(group => group.files.map(file => ({ repo: group.repo, file }))), clipped = repos.some(repo => repo.changesClipped), noGit = Boolean(git) && !repos.length;
    const totals = files.length ? window.relayGit.totals(files.map(entry => entry.file)) : { added: 0, removed: 0 };
    // The number of files, as the Git panel counts them: a new folder too big to list counts its files, not one row.
    const rowFiles = file => window.relayGit.filesIn?.(file) ?? (file.files?.length || file.fileCount || 1);
    const groupTotal = group => window.relayGit.fileTotal?.(group.repo) ?? group.files.reduce((sum, file) => sum + rowFiles(file), 0);
    const changed = groups.reduce((sum, group) => sum + groupTotal(group), 0);
    const locked = running || !window.relayRewind || Boolean(state.taskId), lockHint = running ? 'Available when the current run finishes' : state.taskId ? 'Open the workspace chat to undo its runs' : '';
    const fallback = !files.length && noGit ? runs.slice(0, 5) : [];
    card.openDirect = files.length ? () => { closePeek(); window.relayGit.review({}); } : null;
    headline(card, { count: files.length ? `${changed}${clipped ? '+' : ''}` : '', word: null, quiet: !files.length && !fallback.length, label: files.length ? `${plural(changed, 'file')} changed` : fallback.length ? `${plural(fallback.filter(row => !row.undone).reduce((sum, row) => sum + row.files, 0), 'file')} changed` : latest?.undone ? 'Changes undone' : 'No changes' });
    const signature = JSON.stringify([state.projectId, state.taskId, running, Boolean(git), noGit, clipped, Boolean(window.relayRewind), groups.map(group => [group.repo.folderId, group.repo.name, group.repo.totalChanges, group.repo.changesClipped, group.files.map(file => [file.path, file.code, file.added, file.removed, file.fileCount])]), runs.map(row => [row.runId, row.files, row.undone, row.run?.provider, row.run?.startedAt])]);
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    card.state.replaceChildren(...(files.length ? [totals.added ? node('span', 'diff-added', `+${totals.added}`) : '', totals.removed ? node('span', 'diff-removed', `−${totals.removed}`) : ''].filter(Boolean) : [document.createTextNode(git && !fallback.length ? (latest?.undone ? 'Undone' : 'None') : '')]));
    card.tools.replaceChildren(...(runs.length && !state.taskId && window.relayTimeline?.open ? [toolButton('history', 'Timeline: every checkpoint, to look at or restore', () => window.relayTimeline.open())] : []));
    if (files.length) {
      const list = node('div', 'flow-files'), limits = groups.map(() => 0);
      // Share row slots across changed folders so a busy first folder never hides the others.
      let left = FILES_SHOWN, grew = true;
      while (left > 0 && grew) {
        grew = false;
        for (let i = 0; i < groups.length && left > 0; i++) {
          if (limits[i] < groups[i].files.length) { limits[i]++; left--; grew = true; }
        }
      }
      let omittedFiles = 0, omittedClipped = false, firstOmitted = null;
      groups.forEach((group, index) => {
        const limit = limits[index], total = groupTotal(group);
        if (!limit) { omittedFiles += total; if (group.repo.changesClipped) omittedClipped = true; if (!firstOmitted) firstOmitted = { repo: group.repo, file: group.files[0] }; return; }
        if (groups.length > 1) {
          const head = node('h3', 'flow-subhead');
          head.append(node('span', undefined, group.repo.name), node('span', 'flow-subhead-count', `${total}${group.repo.changesClipped ? '+' : ''}`));
          list.append(head);
        }
        let shownFiles = 0;
        for (let i = 0; i < limit; i++) {
          const file = group.files[i];
          shownFiles += rowFiles(file);
          list.append(window.relayGit.changeRow(group.repo, file, () => window.relayGit.review({ folderId: group.repo.folderId, path: file.path })));
        }
        const remaining = Math.max(0, total - shownFiles);
        if (remaining > 0) {
          const next = group.files[limit] || group.files[0];
          const more = button('flow-fold', `${remaining}${group.repo.changesClipped ? '+' : ''} more`, () => window.relayGit.review({ folderId: group.repo.folderId, path: next.path }));
          more.dataset.key = groups.length > 1 ? `more-files-${group.repo.folderId}` : 'more-files';
          more.title = 'See the rest in the changes window';
          list.append(more);
        }
      });
      if (omittedFiles > 0 && firstOmitted) {
        const more = button('flow-fold', `${omittedFiles}${omittedClipped ? '+' : ''} more`, () => window.relayGit.review({ folderId: firstOmitted.repo.folderId, path: firstOmitted.file.path }));
        more.dataset.key = 'more-files'; more.title = 'See the rest in the changes window';
        list.append(more);
      }
      body.append(list);
    } else if (fallback.length) {
      // No Git here: what each run changed, newest first, with the same Undo as the run's line in the chat.
      const list = node('ul', 'flow-runs');
      for (const row of fallback) {
        const item = node('li', 'flow-run'), text = node('span', 'flow-run-text');
        text.append(node('span', 'flow-run-title', row.undone ? 'Changes undone' : `${plural(row.files, 'file')} changed`), node('span', 'flow-run-meta', [agentName(row.run?.provider, row.run?.local), when(row.run?.startedAt)].filter(Boolean).join(' · ')));
        const act = button('flow-row-action', row.undone ? 'Redo' : 'Undo', () => row.undone ? redoRun(row.undone) : undoRun(row.runId));
        act.dataset.key = `run-${row.runId}`; act.disabled = locked; act.title = lockHint || (row.undone ? 'Put this run’s changes back' : 'Review this run’s changes, then undo them');
        item.append(text, act); list.append(item);
      }
      body.append(list);
    }
    if (files.length) card.foot.append(actionButton('Review', () => window.relayGit.review({}), { hint: 'Read every changed file, one after another' }));
    if (latest && !fallback.length) card.foot.append(latest.undone
      ? actionButton('Redo', () => redoRun(latest.undone), { hint: lockHint || 'Put the last run’s changes back', disabled: locked })
      : actionButton('Undo last run', () => undoRun(latest.runId), { hint: lockHint || 'See what the last run changed, then take it back out', disabled: locked }));
    if (files.length) card.foot.append(actionButton('Commit…', () => window.relayGit.open(), { hint: 'Write a message and commit these changes' }));
  }

  // ---- Your app: the launch map's services and how they stand, with Start, Stop and the preview on its face
  // (project-review.js draws them).
  function renderApp(card) {
    const review = window.relayProjectReview, app = !cardOff('app') && review?.glance ? review.glance() : null;
    if (!app) { headline(card, { shown: false }); return; }
    review.render(card);
    const word = app.approvals ? 'Needs you' : app.failed ? 'Didn’t start' : app.ready ? 'Running' : app.starting ? 'Starting' : app.preparing ? 'Preparing' : '';
    const label = app.approvals ? 'Preparing your app needs your approval' : app.preparing ? 'Preparing how to run your app' : app.failed ? 'Your app didn’t start' : app.ready ? (app.address ? `Running at ${app.address}` : 'Your app is running') : app.starting ? 'Starting your app' : app.profile ? 'Start your app' : 'Set up your app';
    headline(card, { word, live: Boolean(app.ready || app.starting || app.preparing), attention: Boolean(app.approvals || app.failed), label });
  }

  // ---- The status line. A narrow window shows it before the chips; a wide one keeps it for screen readers.
  function statusLine() {
    const state = api.getState(), c = state.conversation;
    if (!c) return { text: 'Ready', live: false };
    const waiting = c.pendingApprovals || [];
    if (waiting.length) return { text: waiting.some(item => item.kind === 'question') ? `${agentName(c.activeRun?.provider, c.activeRun?.connection === 'local')} has a question for you` : 'Waiting for your approval', live: true, attention: true };
    if (api.isRunning()) {
      const run = c.activeRun, agent = agentName(run?.provider, run?.connection === 'local'), step = currentStep(run?.plan?.steps || []), elapsed = elapsedWords(run?.startedAt);
      if (run?.purpose === 'routing') {
        return { text: `Routing assessor: ${agent} is ${run.phase === 'probing' ? 'checking usage' : 'assessing the task'}${elapsed ? ` · ${elapsed}` : ''}`, live: true };
      }
      if (run?.purpose === 'review') {
        return { text: `Reviewer: ${agent} is reviewing changes${elapsed ? ` · ${elapsed}` : ''}`, live: true };
      }
      const doing = step ? `is on “${clip(step.text, 70)}”` : `is ${phaseWords[run?.phase] || 'working'}`;
      return { text: `${agent} ${doing}${elapsed ? ` · ${elapsed}` : ''}`, live: true };
    }
    if (c.resume || c.limitSwitching) return { text: 'Waiting for a usage limit to reset', live: true };
    const activeSplit = (c.splitRuns || []).findLast(run => run.status === 'working');
    if (activeSplit) {
      const model = window.relaySplitProgress?.describe?.(c);
      return { text: model ? (model.layout === 'unknown' ? model.title : cap(model.shape)) : `Working in ${plural(activeSplit.cards?.length || 2, 'part')} side by side`, live: true };
    }
    const last = c.lastRun;
    if (last && (last.status === 'interrupted' || last.errorCategory === 'quota' || last.status === 'incomplete' || last.status === 'failed')) {
      return { text: last.status === 'interrupted' ? 'Stopped' : last.errorCategory === 'quota' ? 'Stopped at a usage limit' : 'The last run didn’t finish', live: false, attention: last.status !== 'interrupted' };
    }
    const runningLanes = (c.parallelTasks || []).filter(task => task.status === 'running' && !task.managed);
    if (runningLanes.length) {
      const lane = runningLanes[0];
      const laneAgent = agentName(lane.runningProvider || lane.provider);
      return { text: `Task lane “${clip(lane.title, 40)}” working (${laneAgent})`, live: true };
    }
    if (!last) return { text: 'Ready', live: false };
    if (last.status === 'complete') { const files = c.checkpoints?.[last.id]?.files; return { text: `Done${files ? ` · ${plural(files, 'file')} changed` : ''}`, live: false }; }
    return { text: 'Ready', live: false };
  }
  function renderStatus() {
    if (!status) return;
    status.hidden = !on;
    if (!on) return;
    const line = statusLine(), text = $('flow-status-text');
    const c = api.getState().conversation, run = api.isRunning() ? c?.activeRun : c?.lastRun;
    const native = run?.contextUsage;
    const context = typeof native?.used === 'number' ? ` · ${native.estimated ? '≈' : ''}${native.used.toLocaleString()} context tokens` : '';
    const compact = run?.compactions > 0 ? ` · context organized ${run.compactions}×` : '';
    if (text) text.textContent = line.text + context + compact; else status.textContent = line.text + context + compact;
    status.title = run ? `${run.compactions || 0} native compaction notifications observed. ${typeof native?.used === 'number' ? 'Context snapshot observed ' + (native.observedAt || 'at an unknown time') : 'Native context usage not reported.'}${run.context?.restoredAfterCompaction ? ' Task context restored in the same native session.' : ''}` : '';
    status.dataset.live = String(Boolean(line.live)); status.dataset.attention = String(Boolean(line.attention));
    const workingProviders = activeWorkingProviders();
    status.dataset.provider = (api.isRunning() && run?.provider) || (workingProviders.size ? [...workingProviders][0] : '');
  }

  const renderers = { activity: renderActivity, tasks: renderTasks, usage: renderUsage, changes: renderChanges, app: renderApp };
  function renderCards() {
    for (const { id } of CARDS) { const card = cards.get(id); redraw(card, () => renderers[id](card)); }
    // A panel that leaves while it's open in a narrow window closes.
    if (peeking && peeking !== 'space' && !cards.get(peeking)?.shown) closePeek();
  }

  // ---- A narrow window: the rails step aside and the panels become a row of chips under the header, after the status
  // line. A chip opens its panel over the chat; one opens at a time. What needs you comes first.
  function renderStrip() {
    if (strip.hidden) return;
    const focusedChip = strip.contains(document.activeElement) ? document.activeElement.dataset.card : null;
    const shown = CARDS.map(card => cards.get(card.id)).filter(card => card.shown && (!card.quiet || peeking === card.id));
    const chips = [...shown.filter(card => card.attention), ...shown.filter(card => !card.attention)].map(card => {
      const chip = button('flow-chip', undefined, () => card.openDirect ? card.openDirect() : peekCard(card.id)); chip.append(node('span', 'flow-chip-text', card.label)); chip.dataset.card = card.id; chip.dataset.attention = String(card.attention); chip.dataset.live = String(card.live);
      if (card.openDirect) chip.setAttribute('aria-haspopup', 'dialog'); else chip.setAttribute('aria-pressed', String(peeking === card.id));
      chip.setAttribute('aria-label', `${card.title}: ${card.label}${card.openDirect ? '. Review changes' : ''}`); chip.title = card.openDirect ? 'Review changes' : card.title;
      return chip;
    });
    const options = button('flow-chip flow-space-chip', 'Your space', () => peekCard('space')); options.dataset.card = 'space';
    options.setAttribute('aria-pressed', String(peeking === 'space')); options.setAttribute('aria-label', 'Your space: appearance, weather, settings and phone access');
    strip.replaceChildren(...(status && movedControls.length ? [status] : []), ...chips, options);
    if (focusedChip) [...strip.querySelectorAll('.flow-chip')].find(chip => chip.dataset.card === focusedChip)?.focus({ preventScroll: true });
  }
  // In a narrow window a panel opens in the peek, over the chat. In a wide one every panel is already on its rail, so
  // this only brings it into view.
  const peekTitle = $('flow-peek-title'), peekClose = $('flow-peek-close');
  const inPeek = target => Boolean(target && (target === peekClose || peek.contains(target) || peekBody?.contains(target)));
  function peekCard(id) {
    if (peeking === id) { closePeek(); return; }
    const card = id === 'space' ? null : cardOff(id) ? null : cards.get(id);
    if (id !== 'space' && !card) return;
    if (!narrow()) { (card?.element || space).scrollIntoView?.({ block: 'nearest' }); (card?.element || space).querySelector('button')?.focus(); return; }
    closePeek();
    if (id === 'space') preferences.replaceChildren(space, connect);
    peeking = id; peekBody.replaceChildren(id === 'space' ? preferences : card.element);
    const title = id === 'space' ? 'Your space' : card.title;
    if (peekTitle) peekTitle.textContent = title;
    peek.hidden = false; peek.setAttribute('aria-label', title); peek.dataset.card = id;
    render(); peekClose?.focus();
  }
  function closePeek() {
    if (!peeking) return;
    const id = peeking, returnFocus = inPeek(document.activeElement);
    peeking = null; peek.hidden = true; delete peek.dataset.card;
    if (on) { keepFocus(place); renderStrip(); }
    const back = returnFocus && !strip.hidden ? [...strip.querySelectorAll('.flow-chip')].find(chip => chip.dataset.card === id) : null;
    if (back && !back.hidden && !back.closest('[hidden]')) back.focus({ preventScroll: true });
  }

  // ---- The way in and out. A veil covers the change of layout; going in, the seal appears on it for a moment.
  // Without motion, or in a page that can't animate, the layout just changes.
  function stage(change, seal, done) {
    if (!veil || typeof veil.animate !== 'function' || reducedMotion() || document.documentElement.dataset.smokeTest === 'true') { try { change(); } finally { done(); } return; }
    veil.hidden = false; veil.classList.toggle('with-seal', seal);
    const mark = veil.querySelector('img'), title = veil.querySelector('.flow-veil-title'), line = veil.querySelector('.flow-veil-line');
    const fadeIn = veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: seal ? 260 : 150, easing: 'ease-out', fill: 'forwards' });
    fadeIn.onfinish = () => {
      const changed = change() !== false, welcome = changed && seal, shown = [];
      veil.classList.toggle('with-seal', welcome);
      // Going in: the seal lands, then the word and one line saying what Flow does rise in after it, and stay long enough to read.
      if (welcome) {
        const ease = 'cubic-bezier(.2, .8, .2, 1)', rise = [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }];
        if (mark?.animate) shown.push(mark.animate([{ opacity: 0, transform: 'scale(.55) rotate(-10deg)' }, { opacity: 1, transform: 'scale(1) rotate(0)' }], { duration: 380, easing: ease, fill: 'forwards' }));
        if (title?.animate) shown.push(title.animate(rise, { duration: 300, delay: 140, easing: ease, fill: 'both' }));
        if (line?.animate) shown.push(line.animate(rise, { duration: 300, delay: 220, easing: ease, fill: 'both' }));
      }
      const fadeOut = veil.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: welcome ? 'scale(1.03)' : 'scale(1)' }], { duration: welcome ? 340 : 160, delay: welcome ? 1200 : 0, easing: 'ease-in', fill: 'forwards' });
      fadeOut.onfinish = () => { veil.hidden = true; veil.classList.remove('with-seal'); for (const animation of shown) animation.cancel?.(); done(); };
    };
  }
  // The status line's and Activity's elapsed time move while a run works, and Git is read again now and then.
  function tick() { clearTimeout(ticker); if (!on) return; const c = api.getState().conversation, splitActive = Boolean((c?.splitRuns || []).findLast?.(run => run.status === 'working')); if (api.isRunning() || splitActive) { renderStatus(); renderCards(); renderStrip(); } watchGit(); ticker = setTimeout(tick, 1000); }
  // Changing view. Normal keeps every panel; Flow and the Plan lift the header across the window and set the panels
  // aside, to come back as they were in Normal. Only a change of routing waits for the workspace to be idle.
  const routedIn = target => target === 'flow' ? true : target === 'normal' ? false : routed;
  const VIEW_NOTES = { normal: 'Normal view. You choose the agent and model.', flow: 'Flow on. Codeshi chooses the agent and model.', plan: 'Plan view. The chat is on the right.' };
  function applyView(target, remember, projectId, force = false) {
    transitioning = true; render(); modeChanged();
    stage(() => {
      const from = view, nextRouted = routedIn(target);
      const reason = !force && (api.getState().projectId !== projectId ? 'The workspace changed. Choose the view again.' : nextRouted !== routed ? lockReason() : null);
      if (reason) { api.showNotice?.(reason); return false; }
      if (from === target) return false;
      if (from === 'normal') {
        saved = { panel: openSidePanel(), bottom: window.relayPanel?.isOpen?.() ? window.relayPanel.active() : null };
        window.relayAgents?.close?.(); window.relayGit?.close?.(); window.relayBrief?.close?.(); window.relayTimeline?.close?.(); window.relayReviews?.closePanel?.();
        if (saved.bottom) window.relayPanel?.hide?.();
      } else closeDetail();
      if (from === 'flow') { const s = api.getState(), conv = s.conversation, openTask = s.taskId && ((conv?.task?.id === s.taskId ? conv.task : null) || (conv?.parallelTasks || []).find(task => task.id === s.taskId)); if (openTask?.managed) api.setTask?.(null)?.catch?.(() => {}); on = false; closePeek(); clearTimeout(ticker); ticker = null; shell.classList.remove('flow'); keepFocus(restoreControls); }
      if (from === 'plan') { shell.classList.remove('plan'); window.relayBoard?.hide?.(); }
      view = target; routed = nextRouted;
      if (target === 'normal') {
        window.relayPanel?.hide?.();
        const previous = saved; saved = null;
        keepFocus(dropHeader);
        if (previous?.panel) api.showSidePanel?.(previous.panel);
        if (previous?.bottom) window.relayPanel?.show?.(previous.bottom);
      } else keepFocus(liftHeader);
      if (target === 'flow') { on = true; shell.classList.add('flow'); keepFocus(moveControls); keepFocus(place); tick(); }
      if (target === 'plan') { shell.classList.add('plan'); window.relayBoard?.show?.(); }
      if (routed) ensureRouting(); else releaseRouting();
      if (remember) { write(KEY, routed ? 'on' : 'off'); write(VIEW_KEY, view === 'plan' ? 'plan' : 'chat'); }
      render(); modeChanged();
      api.announce?.(VIEW_NOTES[view]);
      return true;
    }, target === 'flow', () => { transitioning = false; render(); modeChanged(); });
  }
  function changeView(target, remember = true) {
    if (!['normal', 'flow', 'plan'].includes(target)) return false;
    if (target === view) return true;
    if (target === 'plan' && window.relayExperimental?.enabled('plan') === false) { api.showNotice?.('The Plan is turned off. Turn it on in Settings › Experimental.'); return false; }
    if (!api.getState().projectId) { api.showNotice?.(target === 'plan' ? 'Open a workspace to use the Plan.' : 'Open a workspace to use Flow.'); return false; }
    if (checkingMode || transitioning) { api.showNotice?.('The view is changing. Try again in a moment.'); return false; }
    // A card with unsaved edits asks before the Plan goes.
    if (view === 'plan' && window.relayBoard?.canLeave?.() === false) return false;
    const state = api.getState(), projectId = state.projectId, taskId = state.taskId;
    if (routedIn(target) === routed) { applyView(target, remember, projectId); return true; }
    const reason = lockReason();
    if (reason) { api.showNotice?.(reason); return false; }
    checkingMode = true; render(); modeChanged();
    // Refresh the workspace-wide status, rather than trusting only the task currently visible in this browser.
    api.api('/api/status', {}, projectId).then(status => {
      checkingMode = false;
      if (api.getState().projectId !== projectId || api.getState().taskId !== taskId) return;
      if (status.runningConversationId || activityBusy(status.workspaceActivity)) { api.showNotice?.(LOCK_MESSAGE); return; }
      const currentReason = lockReason();
      if (currentReason) { api.showNotice?.(currentReason); return; }
      applyView(target, remember, projectId);
    }).catch(error => api.showNotice?.(`Could not check workspace activity. ${error.message}`)).finally(() => { checkingMode = false; render(); modeChanged(); });
    return true;
  }
  function toggleFlow() { return changeView(on ? 'normal' : 'flow'); }
  // Whether changing to a view would have to wait: only a change of routing waits for the workspace to be idle.
  const blocked = target => checkingMode || transitioning || target !== view && routedIn(target) !== routed && Boolean(lockReason());
  // Flow has its own voice: the seal and the word in the header, and a message box that asks what to build.
  const shortcutNote = (toggle.title.match(/\s\([^)]*\)\s*$/) || [''])[0], DEFAULT_PLACEHOLDER = 'Describe the task or ask a question…', FLOW_PLACEHOLDER = 'What should we build next?';
  function brand() {
    const state = api.getState(), label = $('toggle-flow-label'), mark = $('flow-brand'), input = $('message-input');
    // This runs on every update, so the header's words are written only when they change: writing the same word again
    // would paint the top bar on each update, all through a long run (#162).
    if (label && label.textContent !== 'Flow') label.textContent = 'Flow';
    const wait = checkingMode ? 'Checking workspace activity…' : transitioning ? 'Changing view…' : '';
    toggle.title = (wait || (blocked('flow') ? lockReason() : on ? 'Flow: the view you are in' : 'Flow: just the chat, with plain-language cards either side, and Codeshi chooses the agent and model')) + shortcutNote;
    if (normalButton) normalButton.title = wait || (blocked('normal') ? lockReason() : 'Normal: every panel, and you choose the agent and model');
    if (mark) {
      mark.hidden = view === 'normal';
      mark.dataset.view = view;
      const word = mark.querySelector('.flow-brand-name'), brandName = view === 'plan' ? 'Plan' : 'Flow'; if (word && word.textContent !== brandName) word.textContent = brandName;
      // The workspace name opens the workspace menu, as Flow and the Plan have no sidebar to switch from.
      const name = state.projects?.find(project => project.id === state.projectId)?.name || '', button = $('flow-brand-workspace');
      if (button) {
        // Other workspaces' approvals and running agents show beside the name, so they are seen without opening the menu.
        const others = (state.projects || []).filter(project => project.id !== state.projectId && project.available !== false);
        const waiting = others.reduce((sum, project) => sum + (project.pendingApprovals || 0), 0), working = others.filter(project => project.runningConversationId).length;
        const note = [waiting ? `${plural(waiting, 'approval')} waiting in other workspaces` : '', working ? `${working === 1 ? 'An agent is' : `${working} agents are`} working in ${working === 1 ? 'another workspace' : 'other workspaces'}` : ''].filter(Boolean).join('; ');
        const signature = JSON.stringify([name, waiting, working]);
        if (button.dataset.signature !== signature) {
          button.dataset.signature = signature;
          const parts = [node('span', '', name)];
          if (waiting) { const badge = node('span', 'flow-brand-badge waiting', String(waiting)); badge.setAttribute('aria-hidden', 'true'); parts.push(badge); }
          if (working) { const dot = node('span', 'flow-brand-badge working'); dot.setAttribute('aria-hidden', 'true'); parts.push(dot); }
          button.replaceChildren(...parts);
        }
        button.hidden = !name; button.title = `${name}: switch workspace${note ? `. ${note}` : ''}`; button.setAttribute('aria-label', `Workspace: ${name}.${note ? ` ${note}.` : ''} Switch workspace`);
      }
    }
    if (input) { if (on && input.placeholder === DEFAULT_PLACEHOLDER) input.placeholder = FLOW_PLACEHOLDER; else if (!on && input.placeholder === FLOW_PLACEHOLDER) input.placeholder = DEFAULT_PLACEHOLDER; }
  }
  function render() {
    const state = api.getState(), tight = narrow();
    // Each view's button is pressed while it shows, and disabled while changing to it would have to wait for work.
    // While the view is checked and changes, the buttons stay focusable, so pressing one from the keyboard keeps focus
    // on it instead of dropping to the page (#26). Another press meanwhile only explains the wait.
    const changing = String(Boolean(checkingMode || transitioning)), noWorkspace = !state.projectId;
    for (const [button, name] of [[normalButton, 'normal'], [toggle, 'flow'], [planButton, 'plan']]) {
      if (!button) continue;
      button.setAttribute('aria-pressed', String(view === name)); button.setAttribute('aria-disabled', changing);
      button.disabled = noWorkspace || view !== name && Boolean(routedIn(name) !== routed && lockReason());
    }
    brand(); renderStatus();
    const loungeToggle = $('toggle-flow-lounge');
    if (loungeToggle) loungeToggle.hidden = !on;
    if (window.relayFlowLounge?.sync) window.relayFlowLounge.sync(on);
    const lounging = Boolean(window.relayFlowLounge?.isActive?.());
    left.hidden = right.hidden = !on || tight || lounging;
    // Narrow, the panels become chips after the status line; wide, each is on its rail.
    const wasTight = !strip.hidden;
    strip.hidden = !on || !tight;
    if (!on) { closePeek(); return; }
    if (wasTight !== tight) { if (peeking) closePeek(); keepFocus(place); }
    watchGit();
    renderCards();
    renderStrip();
  }
  function schedule() { if (scheduled) return; scheduled = true; Promise.resolve().then(() => { scheduled = false; render(); }); }

  toggle.addEventListener('click', () => changeView('flow'));
  normalButton?.addEventListener('click', () => changeView('normal'));
  planButton?.addEventListener('click', () => changeView('plan'));
  // Turning the Plan off while it shows returns to Normal; the other flags only hide entry points, so a redraw is enough.
  window.relayExperimental?.onChange(() => { if (view === 'plan' && window.relayExperimental.enabled('plan') === false) changeView('normal'); if (peeking && cardOff(peeking)) closePeek(); schedule(); });
  api.wireWorkspaceButton?.($('flow-brand-workspace'));
  $('flow-detail-close')?.addEventListener('click', closeDetail);
  detail?.addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
  // The close event comes after the dialog has closed, so a sheet opened straight after another may already be showing.
  detail?.addEventListener('close', () => { if (detailPanel && !detail.open) closeDetail(); });
  detail?.addEventListener('click', event => {
    if (event.target !== detail) return;
    const rect = detail.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDetail();
  });
  window.addEventListener('relay-side-panel', scheduleDetail);
  window.addEventListener('relay-project-review', schedule);
  window.addEventListener('relay-git', schedule);
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(scheduleDetail);
    // Watch Git too: whether it lives in the side panel or the left sidebar is only known once sidebar-tools.js loads.
    for (const name of ['agents', 'git', 'brief', 'timeline', 'review']) if ($(`${name}-panel`)) observer.observe($(`${name}-panel`), { attributes: true, attributeFilter: ['hidden'] });
  }
  $('flow-peek-close')?.addEventListener('click', closePeek);
  // A card's details close when you go back to the chat, as a menu does. Dialogs they open, such as Undo's preview, don't count.
  document.addEventListener('pointerdown', event => {
    const target = event.target;
    if (!peeking || !target?.closest || inPeek(target) || target.closest('.flow-strip, dialog, [popover]')) return;
    closePeek();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && peeking && !event.isComposing) { event.preventDefault(); closePeek(); } });
  narrowQuery?.addEventListener?.('change', schedule);
  window.addEventListener('relay-state', () => {
    if (detailPanel && detailScope !== scope()) closeDetail();
    const has = Boolean(api.getState().projectId);
    // The view comes back after a restart. The Plan keeps the routing it had, unless turning it on would have to wait.
    if (has && api.getState().ready && !restored) {
      restored = true;
      const flowWanted = read(KEY) === 'on' && !lockReason();
      if (read(VIEW_KEY) === 'plan' && view === 'normal' && window.relayExperimental?.enabled('plan') !== false) { routed = flowWanted; applyView('plan', false, api.getState().projectId); }
      else if (flowWanted && view === 'normal') changeView('flow', false);
    }
    if (!has && view !== 'normal' && !transitioning) applyView('normal', false, null, true);
    // Routing follows the view: on in Flow, off in Normal, as it was in the Plan, put right at the next idle moment if
    // something else changed it.
    const idle = has && api.getState().ready && !transitioning && !checkingMode && !api.isRunning();
    if (idle && routed) { if (routing()) rememberRouting(); else ensureRouting(); }
    else if (idle && !routed && needsManualControl()) releaseRouting();
    schedule();
  });
  for (const type of ['relay-account', 'relay-billing']) window.addEventListener(type, schedule);
  // The next-message line follows the draft as it is typed.
  $('message-input')?.addEventListener('input', () => { if (on) schedule(); });
  // remoteAccess: the phone entry asks Flow first; true means the sheet opened, so Settings need not.
  // view() is normal, flow or plan; isOn() is true in Flow alone; isRouted() says whether Codeshi chooses the agent and model.
  // isLocked() says whether the Flow toggle, ⇧⌘F, would have to wait for work.
  window.relayFlow = { toggle: toggleFlow, enter: () => changeView('flow'), leave: () => changeView('normal'), plan: () => changeView('plan'), setView: changeView, view: () => view, isPlan: () => view === 'plan', isRouted: () => routed, isOn: () => on, isLocked: () => blocked(on ? 'normal' : 'flow'), peek: peekCard, cards: () => CARDS.map(card => ({ id: card.id, title: card.title, side: card.side, shown: cards.get(card.id).shown, quiet: cards.get(card.id).quiet, attention: cards.get(card.id).attention, label: cards.get(card.id).label })), remoteAccess: showPhone, lounge: () => window.relayFlowLounge };
  render();
})();

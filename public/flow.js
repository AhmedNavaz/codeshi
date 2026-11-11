(() => {
  'use strict';
  // Flow mode (#107, #128): just the chat, with plain-language cards in the space either side. Each card reads what
  // Codeshi has already recorded, with no extra model call: how routing and handoff are working, what's left on each plan, the plan and the queue, routing results, and the files changed with Undo.
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
  // The same three answers as the Agents panel, said in terms of what happens rather than which model does it. Flow
  // always routes, so there is no manual mode here; leaving Flow is how you choose the agent and model by hand.
  // Handoff follows the mode too, with no separate setting: the task moves to another agent at the mode's share of a limit.
  const modes = [
    { mode: 'saver', name: 'Saver', does: 'Codeshi uses local rules with light and standard models at low effort, spends allowance where it resets soonest, and hands off autonomously as capacity tightens.' },
    { mode: 'smart', name: 'Smart', does: 'Codeshi matches the model and effort to each message, spends allowance where it resets soonest, and hands off adaptively as limits approach.' },
    { mode: 'ultra', name: 'Ultra', does: 'Codeshi uses the strongest models and deepest reasoning first, stepping down one tier only when needed, and preserves task continuity before handing off.' },
  ];
  const canonicalMode = mode => window.relayRouting?.normalizeMode?.(mode) || mode || null;
  // The cards, always present: each has a job, so none can be closed.
  const CARDS = [
    { id: 'next', title: 'What’s next', side: left },
    { id: 'plans', title: 'What’s left on your plans', side: left },
    { id: 'results', title: 'Smart results', side: left },
    { id: 'working', title: 'How it’s working now', side: right },
    { id: 'happened', title: 'What happened', side: right },
    { id: 'files', title: 'Files changed', side: right },
    { id: 'preview', title: 'Run and review your project', side: right },
  ];
  let on = false, saved = null, testingPending = false, peeking = null, scheduled = false, ticker = null;
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
  // Routing belongs to Flow (#12, #107, #128): entering turns it on, with the mode this workspace last used in Flow or
  // Smart, and leaving turns it off, so the normal view chooses the agent and model by hand. The choice is kept per browser.
  const ROUTING_KEY = id => `throughline:flow-routing:${id}`;
  let routingPending = false, routingReleasing = false;
  function rememberRouting() { const current = routing(), id = api.getState().projectId; if (current && id) write(ROUTING_KEY(id), JSON.stringify({ mode: canonicalMode(current.mode), allowApi: current.allowApi === true, check: current.check === true })); }
  function savedRouting(id) { try { const saved = JSON.parse(read(ROUTING_KEY(id)) || 'null'), mode = canonicalMode(saved?.mode); return saved && modes.some(option => option.mode === mode) ? { ...saved, mode } : null; } catch { return null; } }
  // Flow has no manual mode: entering turns routing on with the mode this workspace last used in Flow, or Smart.
  async function ensureRouting() {
    if (!on || routing() || routingPending || !api.getState().projectId) return;
    const choice = savedRouting(api.getState().projectId) || { mode: 'smart', allowApi: false, check: false };
    routingPending = true; schedule();
    try { await api.setRouting({ mode: choice.mode, allowApi: choice.allowApi === true, check: choice.check === true }); }
    catch (error) { api.showNotice?.(`Flow could not turn routing on. ${error.message}`); }
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
    if (card.hidden) element.hidden = true; head.append(title); element.append(head, body, foot);
    return [card.id, { ...card, element, body, foot, signature: null }];
  }));
  // Quiet utility areas anchor the two rails, separate from the live task cards.
  const space = node('section', 'flow-utility flow-space'), connect = node('section', 'flow-utility flow-connect');
  space.id = 'flow-space'; connect.id = 'flow-connect';
  space.setAttribute('aria-label', 'Your space'); connect.setAttribute('aria-label', 'Stay connected');
  space.append(node('h2', undefined, 'Your space'), node('p', 'flow-utility-hint', 'Appearance, weather and preferences.'));
  // Each preference is one row: its name on the left, a small control on the right. The Lounge fills in the weather.
  const appearance = node('div', 'flow-pref flow-appearance'); appearance.append(node('span', 'flow-utility-label', 'Appearance'));
  const weather = node('div', 'flow-pref flow-weather'); weather.id = 'flow-weather';
  space.append(appearance, weather);
  connect.append(node('h2', undefined, 'Stay connected'), node('p', 'flow-utility-hint', 'Pick up the conversation on your phone, or share it live with a teammate.'));
  // Remote access, Share live and Keep awake sit side by side in one row.
  const connectRow = node('div', 'flow-connect-row'); connect.append(connectRow);
  const preferences = node('div', 'flow-preferences');
  // Move the actual controls so connection counts, update progress and theme state keep updating in Flow.
  const movedControls = [];
  function moveControls() {
    for (const id of ['flow-status', 'connect-phone', 'status-watch', 'status-watch-menu', 'relay-settings', 'appearance-options', 'keep-awake', 'update-status', 'update-more']) {
      const control = $(id); if (!control) continue;
      const marker = node('span'); marker.hidden = true;
      control.parentNode.insertBefore(marker, control); movedControls.push({ control, marker });
      if (id === 'flow-status') cards.get('working').element.insertBefore(control, cards.get('working').body);
      else if (id === 'appearance-options') appearance.append(control);
      else if (id === 'relay-settings') space.append(control);
      else if (['connect-phone', 'status-watch', 'keep-awake'].includes(id)) connectRow.append(control);
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
  // Each rail scrolls its cards in their own area, so the utility section under the divider stays put at the foot.
  const scrollers = new Map([left, right].map(side => { const scroller = node('div', 'flow-side-cards'); scroller.id = `${side.id}-cards`; return [side, scroller]; }));
  function place() {
    for (const side of [left, right]) {
      const scroller = scrollers.get(side);
      scroller.replaceChildren(...CARDS.filter(card => card.side === side && peeking !== card.id).map(card => cards.get(card.id).element));
      side.replaceChildren(scroller);
    }
    if (peeking !== 'space') { left.append(space); right.append(connect); }
  }

  // How it's working now: the routing mode first, with what it does and when it hands off in plain words, what the next
  // message would do, and an inline testing preference. Routing changes live in Agent settings.
  function modeSentence(current) {
    const mode = canonicalMode(current?.mode), option = modes.find(item => item.mode === mode), extras = [];
    if (!option) return routingPending ? 'Turning routing on…' : 'Routing is off. Flow turns it on when the workspace is idle.';
    if (current?.allowApi) extras.push('Agents billed by use can be chosen.');
    if (current?.check) extras.push(api.getState().status?.verificationCadence === 'review-first' ? 'Routine automatic tests wait while you review. A selected build/review workflow still checks.' : 'After a run changes files, your tests run; if they fail, it tries once more, one step up.');
    return [option.does, ...extras].join(' ');
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
  const draft = () => ({ text: $('message-input')?.value.trim() || '', files: window.relayFiles?.ids?.().length || 0 });
  const continuationPattern = /^Continue the unfinished task from this shared conversation\.[^.]*\.?\s*/i;
  function cleanRouteError(error) {
    if (!error) return '';
    let msg = String(error).trim();
    msg = msg.replace(/\bContinue the unfinished task from this shared conversation\.[^.]*\./gi, '').trim();
    msg = msg.replace(/^Auto found no connected agent within your rules/i, 'No connected agent is available within your rules');
    msg = msg.replace(/\s*API-billed agents need separate consent\.?$/i, '');
    return msg || 'No connected agent is available.';
  }
  function updateWorkingFacts(state, c, current) {
    workingFacts.replaceChildren();
    const run = c?.activeRun, running = api.isRunning();
    const runningLanes = (c?.parallelTasks || []).filter(task => task.status === "running");

    if (running && run) {
      const agent = agentName(run.provider, run.connection === "local");
      const model = run.model ? (window.relayModelPicker?.modelName?.(run.provider, run.model) || run.model) : "";
      // The status line above this list already says which step the agent is on and for how long; these rows add the
      // model, effort and phase, so nothing is said twice.

      if (run.purpose === "routing") {
        const row = node("div");
        row.append(node("dt", undefined, "Assessor"), node("dd", undefined, `${agent}${model ? ` (${model})` : ""}: ${run.phase === "probing" ? "checking account & plan usage" : "assessing task"}`));
        workingFacts.append(row);
      } else if (run.purpose === "review") {
        const row = node("div");
        row.append(node("dt", undefined, "Reviewer"), node("dd", undefined, `${agent}${model ? ` (${model})` : ""}: reviewing changes`));
        workingFacts.append(row);
      } else {
        const row = node("div");
        const phaseText = phaseWords[run.phase] || run.phase || "working";
        row.append(node("dt", undefined, "Running"), node("dd", undefined, `${agent}${model ? ` · ${model}` : ""}${run.effort ? ` (${run.effort} effort)` : ""}: ${phaseText}`));
        workingFacts.append(row);
      }
    } else if (c?.resume || c?.limitSwitching) {
      const row = node("div");
      const waitAgent = agentName(c?.resume?.providers?.[0] || "agent");
      const reset = c?.resume?.resetsAt ? resetWords(c.resume.resetsAt) : "";
      row.append(node("dt", undefined, "Waiting"), node("dd", undefined, `${waitAgent} usage limit to reset${reset ? ` (${reset})` : ""}`));
      workingFacts.append(row);
    } else if (c?.handoffOffer) {
      const row = node("div");
      row.append(node("dt", undefined, "Handoff"), node("dd", undefined, `Moving from ${agentName(c.handoffOffer.from.provider)} to ${agentName(c.handoffOffer.to.provider)}: ${c.handoffOffer.reason || "usage threshold reached"}`));
      workingFacts.append(row);
    } else {
      const row = node("div");
      const composerAgent = agentNames[state.provider] || state.provider;
      const composerModel = state.model ? (window.relayModelPicker?.modelName?.(state.provider, state.model) || state.model) : "";
      row.append(node("dt", undefined, "Composer"), node("dd", undefined, `${composerAgent}${composerModel ? ` · ${composerModel}` : ""}${routing() ? " (routed on Send)" : ""}`));
      workingFacts.append(row);
    }

    if (runningLanes.length) {
      const row = node("div");
      const laneNames = runningLanes.map(t => `“${t.title}” (${agentNames[t.runningProvider || t.provider] || "agent"})`).join(", ");
      row.append(node("dt", undefined, "Task lanes"), node("dd", undefined, laneNames));
      workingFacts.append(row);
    }

    const testRow = node("div"), testVal = node("dd");
    testVal.append(testingControl);
    testRow.append(node("dt", undefined, "Testing"), testVal);
    workingFacts.append(testRow);
  }
  async function setReviewFirst(enabled) {
    if (testingPending) return;
    testingPending = true; render();
    try {
      await api.post('/api/preferences', { verificationCadence: enabled ? 'review-first' : 'as-needed' });
      await api.refresh();
      api.announce?.(enabled ? 'Review first enabled for new turns.' : 'Checks as needed enabled for new turns.');
    } catch (error) { api.showNotice?.(`Testing preference could not be saved. ${error.message}`); }
    finally { testingPending = false; render(); }
  }
  // Keep the switch mounted as live routing and draft previews change, including while a save is pending.
  const testingControl = node('div', 'flow-testing'), testingLabel = node('div', 'flow-testing-label');
  const testingName = node('span', undefined, 'Review first'), testingDescription = node('p', 'flow-testing-description');
  testingDescription.id = 'flow-testing-description';
  const testingSwitch = button('flow-switch', '', () => setReviewFirst(api.getState().status?.verificationCadence !== 'review-first'));
  testingSwitch.id = 'flow-testing-toggle'; testingSwitch.setAttribute('role', 'switch'); testingSwitch.setAttribute('aria-label', 'Review first');
  testingSwitch.setAttribute('aria-describedby', testingDescription.id);
  const switchThumb = node('span'); switchThumb.setAttribute('aria-hidden', 'true'); testingSwitch.append(switchThumb);
  testingLabel.append(testingName, testingSwitch); testingControl.append(testingLabel, testingDescription);
  const workingMode = node('div', 'flow-mode'), workingModeHeader = node('div', 'flow-mode-header');
  const workingModeBadge = node('span', 'flow-mode-badge'); workingModeBadge.setAttribute('aria-hidden', 'true');
  const workingModeIcon = node('i', 'flow-mode-icon'); workingModeIcon.setAttribute('aria-hidden', 'true');
  workingModeBadge.append(workingModeIcon);
  const workingModeTitles = node('div', 'flow-mode-titles');
  const workingModeEyebrow = node('span', 'flow-mode-eyebrow', 'Routing');
  const workingModeName = node('strong', 'flow-mode-name');
  workingModeTitles.append(workingModeEyebrow, workingModeName);
  const workingModeTag = node('span', 'flow-mode-tag'); workingModeTag.setAttribute('aria-hidden', 'true');
  workingModeHeader.append(workingModeBadge, workingModeTitles, workingModeTag);
  const workingModeText = node('p', 'flow-mode-text');
  workingMode.append(workingModeHeader, workingModeText);
  const workingFacts = node('dl', 'flow-facts');
  for (const [term, detail] of [['Testing', testingControl]]) {
    const row = node('div'), value = detail.tagName === 'DD' ? detail : node('dd');
    if (value !== detail) value.append(detail);
    row.append(node('dt', undefined, term), value); workingFacts.append(row);
  }
  function renderWorking(card) {
    const state = api.getState(), c = state.conversation, current = routing(), currentMode = canonicalMode(current?.mode);
    const running = api.isRunning() ? (c?.activeRun?.connection === "local" ? "local" : c?.activeRun?.provider) : null;
    const runningLanes = (c?.parallelTasks || []).filter(task => task.status === "running").map(t => [t.id, t.runningProvider, t.status]);
    const signature = JSON.stringify([current, routingPending, state.provider, state.model, state.ready, testingPending, state.status?.verificationCadence, running, c?.activeRun?.phase, c?.activeRun?.purpose, c?.resume, c?.handoffOffer, runningLanes]);
    if (signature === card.signature) return;
    card.signature = signature;
    if (!card.body.childNodes.length) {
      card.body.append(workingMode, workingFacts);
      card.foot.append(button("flow-button", "Agent settings", () => window.relayAgents?.open?.()));
    }
    updateWorkingFacts(state, c, current);
    const option = modes.find(item => item.mode === currentMode);
    workingMode.dataset.mode = option ? option.mode : routingPending ? "pending" : "off";
    workingModeName.textContent = option ? option.name : routingPending ? "Turning on…" : "Off";
    workingModeText.textContent = modeSentence(current);
    const reviewFirst = state.status?.verificationCadence === "review-first";
    testingSwitch.setAttribute("aria-checked", String(reviewFirst));
    testingSwitch.disabled = testingPending || !state.ready || !state.status;
    testingSwitch.setAttribute("aria-busy", String(testingPending));
    testingDescription.textContent = reviewFirst ? "Small safeguards now; verify when you ask to finalize." : "Checks as needed, focused on what changed.";
    testingDescription.title = "Applies to new turns in every workspace. Running agents keep their starting setting. Required checks and selected build/review workflows still apply.";
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
  function renderPlans(card) {
    const state = api.getState(), rows = planRows();
    const working = activeWorkingProviders();
    const signature = JSON.stringify([rows, state.provider, [...working].sort()]);
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    if (!rows.length) {
      body.append(node('p', 'flow-empty', 'Connect an agent in Settings to see what’s left on its plan.'));
      card.foot.append(button('flow-button', 'Open Settings', () => window.relaySettings?.open?.('accounts')));
      return;
    }
    const list = node('ul', 'flow-plans');
    for (const row of rows) {
      const item = node('li', 'flow-plan'), head = node('div', 'flow-plan-head'), icon = node('i', `agent-icon ${row.provider}`);
      item.dataset.provider = row.provider; icon.setAttribute('aria-hidden', 'true');
      head.append(icon, node('strong', undefined, agentNames[row.provider]));
      const isWorking = working.has(row.provider);
      if (isWorking) {
        item.classList.add('flow-plan-active');
        const badge = node('span', 'flow-plan-working-badge');
        badge.setAttribute('aria-label', `${agentNames[row.provider]} is working`);
        const dot = node('span', 'flow-pulse-dot');
        dot.setAttribute('aria-hidden', 'true');
        badge.append(dot);
        head.append(badge);
      }
      if (!row.primary) {
        head.append(node('span', 'flow-plan-value', row.reported ? 'No reading yet' : 'Not reported'));
        item.append(head);
        if (window.relayUsage?.load) item.append(button('flow-button', 'Check now', () => window.relayUsage.load(row.provider)));
      } else {
        const percent = remaining(row.primary);
        item.dataset.level = level(percent);
        head.append(node('span', 'flow-plan-value', `${percent}% left`));
        const meter = node('div', 'flow-meter');
        meter.style.setProperty('--left', `${percent}%`);
        meter.setAttribute('role', 'img');
        meter.setAttribute('aria-label', `${percent}% of ${agentNames[row.provider]}’s ${row.primary.label} allowance left`);
        const reset = resetWords(row.primary.resetsAt);
        const bindingName = limitName(row.primary.label);
        item.append(head, meter, node('span', 'flow-plan-when', `${bindingName}${reset ? ` · ${reset}` : ''}`));
        if (row.secondary) {
          const otherReset = resetWords(row.secondary.resetsAt);
          const other = node('span', 'flow-plan-secondary', `${row.secondary.label} · ${remaining(row.secondary)}% left${otherReset ? ` · ${otherReset}` : ''}`);
          other.dataset.level = level(remaining(row.secondary));
          item.append(other);
        }
      }

      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `${agentNames[row.provider]} limits. Click to view all limits in overlay.`);
      item.title = `Click to view ${agentNames[row.provider]}’s full limits in an overlay window`;
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        window.relayUsage?.open?.(row.provider, item);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.target.closest('button')) return;
          e.preventDefault();
          window.relayUsage?.open?.(row.provider, item);
        }
      });
      list.append(item);
    }
    body.append(list);
    const runningProvider = [...working][0];
    const chosen = (runningProvider && rows.some(row => row.provider === runningProvider)) ? runningProvider : (rows.some(row => row.provider === state.provider) ? state.provider : rows[0].provider);
    const allLimitsBtn = button('flow-button', 'All limits', (e) => window.relayUsage?.open?.(chosen, e.currentTarget || allLimitsBtn));
    allLimitsBtn.title = 'View detailed limits in an overlay window';
    card.foot.append(allLimitsBtn);
  }

    // What's next: the agent's plan for the task, then what's queued. The plan stays while the task can still go on.
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
    if (plan.status === 'planning') return { chip: 'Planning', text: `${agentName(plan.planner?.provider)} is planning the steps. The Plan button shows the plan when it’s ready.` };
    if (plan.status === 'draft') return { chip: 'Plan waiting', text: count ? `A plan of ${plural(count, 'step')} is waiting. Nothing from it runs until you approve it.` : 'An empty plan is waiting. Open the plan to add its steps.' };
    return { chip: 'Plan not ready', text: 'The plan isn’t ready. Open the plan to plan again or write the steps yourself.' };
  }
  function renderNext(card) {
    const state = api.getState(), c = state.conversation, { steps, held, running, run } = planFor(), queue = c?.queue || [], tasks = c?.parallelTasks || [];
    const folders = state.projects?.find(project => project.id === state.projectId)?.folders || [], plan = waitingPlan();
    const lastUserMsg = c?.messages?.filter(m => m.role === 'user').at(-1);
    const signature = JSON.stringify([plan, steps, held, running, run?.provider, run?.phase, lastUserMsg?.id, lastUserMsg?.text, queue, c?.queuePaused, state.projectId, state.taskId, state.taskDraft, folders, tasks.map(task => [task.id, task.title, task.status, task.conversationId, task.folderName, task.runningStep, task.runningPhase])]);
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    const selectTask = id => window.relayTaskThreads.select(id).catch(error => api.showNotice?.(error.message));
    const others = tasks.filter(task => task.purpose !== 'project-review' && task.id !== state.taskId && !['integrated', 'kept', 'discarded', 'cancelled', 'lost', 'detached'].includes(task.status) && (task.conversationId || task.status === 'waiting'));
    if (plan) body.append(node('p', 'flow-lead flow-plan-waiting', plan.text));
    // The plan opens full window from here, while it's being made, waits or runs as tasks.
    if (window.relayOrchestration?.snapshot?.()) {
      const openChart = node('button', 'secondary-button flow-plan-open', 'Open plan'); openChart.type = 'button';
      openChart.addEventListener('click', () => window.relayPlanView?.open());
      body.append(openChart);
    }
    else if (running && !steps.length) {
      const activeItem = node('div', 'flow-current-work flow-task-running flow-plan-active');
      const head = node('div', 'flow-task-head');
      const titleWrapper = node('div', 'flow-current-work-title-wrap');
      const icon = node('i', `agent-icon ${run?.provider || state.provider}`);
      icon.setAttribute('aria-hidden', 'true');
      const agent = agentName(run?.provider, run?.connection === 'local');
      const prompt = lastUserMsg?.text;
      const title = state.taskId ? (tasks.find(t => t.id === state.taskId)?.title || 'Task thread') : (prompt ? clip(prompt, 95) : 'Current task');
      const titleEl = node('strong', 'flow-task-title', title);
      titleEl.title = prompt || title;
      titleWrapper.append(icon, titleEl);

      head.append(titleWrapper);

      const hint = node('p', 'flow-current-work-hint', 'The agent’s plan appears here as it makes one.');
      activeItem.append(head, hint);
      body.append(activeItem);
    } else if (!steps.length && !queue.length) {
      body.append(node('p', 'flow-empty', state.taskDraft ? 'Describe the new task in the message box. Nothing starts until you send it.' : 'Describe what you want in the chat to get started. This card tracks the agent’s steps and your queued follow-ups.'));
    }
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
      body.append(node('h3', 'flow-subhead', `Then · ${plural(queue.length, 'queued message')}${plan ? ' · waiting for the plan' : c.queuePaused ? ' · paused' : ''}`));
      const list = node('ol', 'flow-queue');
      for (const item of queue.slice(0, 5)) list.append(node('li', 'flow-queue-item', clip(item.text, 110)));
      if (queue.length > 5) list.append(node('li', 'flow-queue-more', `and ${queue.length - 5} more`));
      body.append(list);
    }
    // Tasks running beside this chat, started from the normal view or a folder choice, stay reachable here with their
    // own Stop and Cancel; a task thread can come back to the whole workspace.
    if (others.length || state.taskId) {
      body.append(node('h3', 'flow-subhead', state.taskId ? 'This task runs beside the workspace chat' : 'Running beside this chat'));
      const list = node('ul', 'flow-tasks'), taskWords = task => task.status === 'waiting' ? 'waiting to start' : task.status === 'running' ? 'Working as extra task' : task.status === 'complete' ? 'finished' : task.status;
      for (const task of others) {
        const item = node('li', 'flow-task');
        if (task.status === 'running') item.classList.add('flow-task-running');

        const titleRow = node('div', 'flow-task-head');
        const titleEl = node('strong', 'flow-task-title', task.title);
        titleEl.title = task.title;
        titleRow.append(titleEl);

        const meta = node('div', 'flow-task-meta');
        if (task.folderName) meta.append(node('span', 'flow-task-folder', `${task.folderName} · `));

        const taskProvider = task.runningProvider || task.provider;
        if (task.status === 'running') {
          const badge = node('span', 'flow-task-status flow-task-status-running');
          const dot = node('span', 'flow-pulse-dot');
          dot.setAttribute('aria-hidden', 'true');
          const activityText = taskProvider ? `${agentNames[taskProvider] || taskProvider}${task.runningStep ? ` · on “${clip(task.runningStep, 35)}”` : task.runningPhase ? ` · ${phaseWords[task.runningPhase] || task.runningPhase}` : ' · Working as extra task'}` : 'Working as extra task';
          badge.append(dot, node('span', 'flow-task-status-text', activityText));
          meta.append(badge);
        } else {
          meta.append(node('span', 'flow-task-status', taskWords(task)));
        }

        const actionBtn = button('flow-button flow-task-button flow-task-action', 'Open task', () => selectTask(task.id));
        actionBtn.title = `Switch to “${task.title}”`;
        actionBtn.setAttribute('aria-label', `Open task: ${task.title}`);

        item.append(titleRow, meta, actionBtn);
        list.append(item);
      }
      if (state.taskId) {
        const item = node('li', 'flow-task');
        const titleRow = node('div', 'flow-task-head');
        titleRow.append(node('strong', 'flow-task-title', 'Workspace chat'));
        const meta = node('div', 'flow-task-meta');
        meta.append(node('span', 'flow-task-status', 'the whole workspace'));
        const actionBtn = button('flow-button flow-task-button flow-task-action', 'Workspace chat', () => selectTask(null));
        actionBtn.title = 'Switch to workspace chat';
        actionBtn.setAttribute('aria-label', 'Open workspace chat');
        item.append(titleRow, meta, actionBtn);
        list.append(item);
      }
      body.append(list);
    }
  }

  // Files changed: each run that changed files, newest first, with the same Undo as the run's line in the chat.
  const when = value => { const at = new Date(value || ''); if (Number.isNaN(at.getTime())) return ''; return at.toLocaleString(undefined, at.toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit', hour12: true } : { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }); };
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
    card.foot.append(button('flow-button', 'Timeline', () => window.relayTimeline?.open?.()), button('flow-button', 'Review changes', () => window.relayGit?.open?.()));
    if (!rows.length) { body.append(node('p', 'flow-empty', 'No files changed in this conversation yet. Each run that changes files appears here, with Undo.')); return; }
    const total = rows.filter(row => !row.undone).reduce((sum, row) => sum + row.files, 0);
    body.append(node('p', 'flow-lead', `${plural(total, 'file')} changed, across ${plural(rows.length, 'run')}.`));
    const list = node('ul', 'flow-runs');
    for (const row of rows.slice(0, 3)) {
      const item = node('li', 'flow-run');
      item.append(node('span', 'flow-run-title', row.undone ? 'Changes undone' : `${plural(row.files, 'file')} changed`));
      item.append(node('span', 'flow-run-meta', [agentName(row.run?.provider, row.run?.local), when(row.run?.startedAt)].filter(Boolean).join(' · ')));
      const action = button('flow-button flow-run-action', row.undone ? 'Redo' : 'Undo', () => window.relayRewind?.open?.(row.undone ? { kind: 'rewind', id: row.undone } : { kind: 'run', id: row.runId }));
      action.disabled = running || !window.relayRewind; action.title = running ? 'Available when the current run finishes' : row.undone ? 'Put this run’s changes back' : 'Review this run’s changes, then undo them';
      item.append(action); list.append(item);
    }
    body.append(list);
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
  function happenings() {
    const runs = api.getState().conversation?.runs || [];
    return runs.filter(run => run.endedAt && run.relation !== 'assessment').slice(-3).reverse().map(run => ({ run, ...decision(run), outcome: outcome(run) }));
  }
  function renderHappened(card) {
    const rows = happenings();
    const signature = JSON.stringify(rows.map(row => [row.run.id, row.title, row.why, row.outcome.text]));
    if (signature === card.signature) return;
    card.signature = signature;
    const body = card.body; body.replaceChildren(); card.foot.replaceChildren();
    if (!rows.length) { body.append(node('p', 'flow-empty', 'Nothing yet. After each run, the agent Codeshi chose, any handoff or retry, and how it ended appear here.')); return; }
    const list = node('ul', 'flow-happened');
    for (const row of rows) {
      const item = node('li', 'flow-happened-item'); item.dataset.kind = row.kind;
      item.append(node('span', 'flow-happened-title', row.title));
      const meta = node('span', 'flow-happened-meta'), result = node('span', 'flow-happened-outcome', row.outcome.text);
      result.dataset.tone = row.outcome.tone; meta.append(result);
      const at = when(row.run.endedAt); if (at) meta.append(document.createTextNode(` · ${at}`));
      item.append(meta);
      if (row.why) { const why = node('span', 'flow-happened-why', clip(row.why, 140)); why.title = row.why; item.append(why); }
      list.append(item);
    }
    body.append(list);
  }
  const renderers = { working: renderWorking, plans: renderPlans, next: renderNext, files: renderFiles, happened: renderHappened, preview: card => window.relayProjectReview?.render(card), results: card => window.relaySmartResults?.renderCard(card) };

  // ---- Live status in the working card. Remote access and Settings sit below it; no footer is needed.
  const phaseWords = { starting: 'starting', probing: 'checking usage', reasoning: 'thinking', responding: 'writing', tool: 'running tools', compacting: 'organizing its context', approval: 'waiting for you' };
  const elapsedWords = since => { const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since || '')) / 1000)); if (!Number.isFinite(seconds)) return ''; const minutes = Math.floor(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; };
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
    const last = c.lastRun;
    if (last && (last.status === 'interrupted' || last.errorCategory === 'quota' || last.status === 'incomplete' || last.status === 'failed')) {
      return { text: last.status === 'interrupted' ? 'Stopped' : last.errorCategory === 'quota' ? 'Stopped at a usage limit' : 'The last run didn’t finish', live: false, attention: last.status !== 'interrupted' };
    }
    const runningLanes = (c.parallelTasks || []).filter(task => task.status === 'running');
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

  // ---- A narrow window: the cards leave the sides and become a row of chips under the header; one opens at a time.
  function chipText(id) {
    const state = api.getState();
    if (id === 'preview') return window.relayProjectReview?.label() || 'Run and review your project';
    if (id === 'results') { const data = window.relaySmartResults?.data?.(), mode = canonicalMode(routing()?.mode) || 'smart', name = modes.find(item => item.mode === mode)?.name || 'Smart', seen = data?.observed?.[mode]; return seen?.tasks ? `${name} · ${plural(seen.tasks, 'task')} · ${seen.verified} verified` : `${name} results`; }
    if (id === 'happened') { const latest = happenings()[0]; return latest ? clip(latest.title, 48) : 'What happened'; }
    if (id === 'working') return modes.find(item => item.mode === canonicalMode(routing()?.mode))?.name || 'Routing';
    if (id === 'plans') { const rows = planRows(), row = rows.find(item => item.provider === state.provider) || rows[0]; return row?.primary ? `${agentNames[row.provider]} · ${row.primary.label} · ${remaining(row.primary)}% left${row.warning ? ` · ${row.warning.label} · ${remaining(row.warning)}% left` : ''}` : 'Plans'; }
    if (id === 'next') { const { steps } = planFor(), queue = state.conversation?.queue || [], plan = waitingPlan(); if (plan) return plan.chip; return steps.length ? `${steps.filter(step => step.status === 'done').length} of ${steps.length} steps` : queue.length ? plural(queue.length, 'queued message') : 'What’s next'; }
    const total = changedRuns().filter(row => !row.undone).reduce((sum, row) => sum + row.files, 0);
    return total ? `${plural(total, 'file')} changed` : 'Files';
  }
  function renderStrip() {
    if (strip.hidden) return;
    strip.replaceChildren(...CARDS.filter(card => !card.hidden).map(card => {
      const chip = button('flow-chip', chipText(card.id), () => peekCard(card.id));
      chip.setAttribute('aria-pressed', String(peeking === card.id)); chip.setAttribute('aria-label', `${card.title}: ${chipText(card.id)}`);
      return chip;
    }));
    const options = button('flow-chip flow-space-chip', 'Your space', () => peekCard('space'));
    options.setAttribute('aria-pressed', String(peeking === 'space')); options.setAttribute('aria-label', 'Your space: appearance, weather, settings and phone access');
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
        on = false; closeDetail(); closePeek(); window.relayPanel?.hide?.(); releaseRouting();
        clearTimeout(ticker); ticker = null;
        const previous = saved; saved = null;
        shell.classList.remove('flow'); restoreControls(); dropHeader();
        if (previous?.panel) api.showSidePanel?.(previous.panel);
        if (previous?.bottom) window.relayPanel?.show?.(previous.bottom);
      }
      if (remember) write(KEY, on ? 'on' : 'off');
      render(); modeChanged();
      api.announce?.(on ? 'Flow on. Codeshi chooses the agent and model.' : 'Flow off. Manual control restored.');
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
    const loungeToggle = $('toggle-flow-lounge');
    if (loungeToggle) loungeToggle.hidden = !on;
    if (window.relayFlowLounge?.sync) window.relayFlowLounge.sync(on);
    left.hidden = right.hidden = !on || tight || Boolean(window.relayFlowLounge?.isActive?.());
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
  // The close event comes after the dialog has closed, so a sheet opened straight after another may already be showing.
  detail?.addEventListener('close', () => { if (detailPanel && !detail.open) closeDetail(); });
  detail?.addEventListener('click', event => {
    if (event.target !== detail) return;
    const rect = detail.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDetail();
  });
  window.addEventListener('relay-side-panel', scheduleDetail);
  window.addEventListener('relay-project-review', schedule);
  window.addEventListener('relay-results', schedule);
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
    else if (idle && !on && needsManualControl()) releaseRouting();
    schedule();
  });
  for (const type of ['relay-account', 'relay-billing']) window.addEventListener(type, schedule);
  // The next-message line follows the draft as it is typed.
  $('message-input')?.addEventListener('input', () => { if (on) schedule(); });
  // remoteAccess: the phone entry asks Flow first; true means the sheet opened, so Settings need not.
  window.relayFlow = { toggle: toggleFlow, enter: () => changeMode(true), leave: () => changeMode(false), isOn: () => on, isLocked: () => Boolean(lockReason() || checkingMode || transitioning), peek: peekCard, cards: () => CARDS.map(card => ({ id: card.id, title: card.title })), remoteAccess: showPhone, lounge: () => window.relayFlowLounge };
  render();
})();

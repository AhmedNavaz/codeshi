// The Plan view (#97): an Orchestrate plan as a flowchart, full window, opened by the Plan button in the top bar, from
// What's next in Flow and from the planner's message. Steps are cards laid out in columns, one per
// phase where the plan has phases, otherwise by what each step waits for; arrows show the waits. Selecting a card opens
// it in a drawer: its editor while the plan is a draft, its task's state while it runs. The Outline shows the same
// steps as a list, for the keyboard, screen readers and narrow windows. The plan's actions (cost, Save, Run as tasks,
// Stop…) are in the footer. With no plan yet, the view says how to start one.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('plan-view');
  if (!dialog) return;
  const orchestration = () => window.relayOrchestration;
  const VIEW_KEY = 'throughline:plan-view';
  const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth'];
  const DONE = ['complete', 'integrated', 'kept'], TROUBLE = ['failed', 'blocked', 'lost', 'detached', 'stopped'];
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const listed = items => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  const modes = () => [$('plan-view-chart-mode'), $('plan-view-outline-mode')].filter(Boolean);
  const modeOf = button => button.id === 'plan-view-outline-mode' ? 'outline' : 'chart';
  const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'outline' ? 'outline' : 'chart'; } catch { return 'chart'; } };

  const duration = ms => { const minutes = Math.round(ms / 60000); return ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; };
  const compact = value => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  // Fresh tokens from a usage total, as the Tasks panel counts them; null when no run reported any.
  const newTokens = usage => usage?.runsWithTokens ? (usage.input || 0) + (usage.output || 0) + (usage.cacheWrite || 0) : null;
  // What the whole plan has used so far (#84): planning and every step's task, with each step's retries and reviews.
  function usageText(total) {
    if (!total?.runs) return '';
    const parts = [[total.planned ? 'planning' : '', total.steps ? plural(total.steps, 'step') : ''].filter(Boolean).join(' and '), plural(total.runs, 'run'), `${duration(total.workingMs)} working`];
    const tokens = newTokens(total.usage), planning = newTokens(total.roles?.planning?.usage);
    if (tokens === null) parts.push('tokens not reported');
    else parts.push(`${total.usage.runsWithTokens < total.usage.runs || total.usage.partialRuns ? 'at least ' : ''}${compact(tokens)} new tokens${planning !== null && tokens ? ` (planning ${Math.round(planning / tokens * 100)}%)` : ''}`);
    if (total.steps) parts.push(total.tests.passed === total.steps ? 'tests passed on every step' : `tests passed on ${total.tests.passed} of ${plural(total.steps, 'step')}`);
    return `Used so far: ${parts.filter(Boolean).join(' · ')}.`;
  }
  // The plan's total comes from the task ledger, reread when the plan or a step's state changes, not on every repaint.
  let usage = null, usageKey = null;
  async function loadUsage(snap) {
    const key = JSON.stringify([snap.plan.id, snap.plan.status, snap.tasks?.map(row => [row.task?.status, row.task?.runningProvider])]);
    if (key === usageKey) return;
    usageKey = key;
    try {
      const ledger = await window.relayUI.api('/api/ledger');
      if (usageKey !== key) return;
      usage = (ledger.plans || []).find(total => total.id === snap.plan.id) || null;
    } catch { if (usageKey === key) usage = null; }
    showUsage(snap.plan.id);
  }
  function showUsage(planId) {
    const text = usage?.id === planId ? usageText(usage) : '';
    $('plan-view-usage').textContent = text; $('plan-view-usage').hidden = !text;
    $('plan-view-usage').title = text ? 'Planning and each step’s task, including their retries, follow-ups and reviews. Tokens only count what agents reported.' : '';
  }

  // selected: the step open in the drawer. drawn: what the chart last drew. drawer: the step object the drawer edits,
  // so typing in it never rebuilds it.
  // shown: whether this view has shown a plan since it opened, so it closes when that plan is discarded or closed.
  let view = readView(), selected = null, drawn = null, drawer = null, shown = false;

  // Columns: the plan's phases, in order, where it has them (a step without one stays in the phase before it).
  // Otherwise by depth: steps that wait for nothing come first, then each step one column after the latest it waits for.
  function columns(steps) {
    if (steps.some(step => step.phase)) {
      const groups = [];
      for (const step of steps) {
        const name = step.phase || groups.at(-1)?.name || 'Start';
        if (groups.at(-1)?.name !== name) groups.push({ name, steps: [] });
        groups.at(-1).steps.push(step);
      }
      return groups;
    }
    const depth = new Map(), groups = [];
    for (const step of steps) {
      const level = step.dependsOn.length ? 1 + Math.max(...step.dependsOn.map(id => depth.get(id) ?? 0)) : 0;
      depth.set(step.id, level);
      (groups[level] ||= { name: ORDINALS[level] || `Column ${level + 1}`, steps: [] }).steps.push(step);
    }
    return groups.filter(Boolean);
  }

  const numberOf = (steps, id) => steps.findIndex(step => step.id === id) + 1;
  const taskFor = (snap, step) => snap.tasks?.find(row => row.step.id === step.id)?.task || null;
  // A card's state: its task's while the plan runs, otherwise the agent it would run with.
  function stateOf(snap, step) {
    if (snap.running) {
      const task = taskFor(snap, step), status = task?.status || 'missing';
      return { status, text: orchestration().taskLabel(task), provider: task?.runningProvider || task?.provider || 'auto', reason: task?.reason || '' };
    }
    const routed = orchestration().routeText(step);
    return { status: snap.draft ? 'draft' : 'idle', text: routed.text, provider: routed.provider, reason: '' };
  }

  function card(snap, step) {
    const number = numberOf(snap.steps, step.id), state = stateOf(snap, step);
    const button = node('button', 'plan-node'); button.type = 'button';
    button.dataset.step = step.id; button.dataset.status = state.status;
    button.setAttribute('aria-pressed', String(selected === step.id));
    const top = node('span', 'plan-node-top'), role = node('span', 'orchestration-step-role', orchestration().roleName(step.role));
    role.dataset.role = step.role || 'builder';
    top.append(node('span', 'plan-node-number', String(number)), role);
    if (snap.running) top.append(node('span', 'plan-node-state', state.text));
    else if (snap.draft) top.append(node('span', 'plan-node-tier', orchestration().tierName(step.tier)));
    const title = node('span', 'plan-node-title', step.title.trim() || 'Untitled step');
    if (!step.title.trim()) title.classList.add('untitled');
    const meta = node('span', 'plan-node-meta'), icon = node('i', `agent-icon ${state.provider}`);
    icon.setAttribute('aria-hidden', 'true');
    // The card is narrow: the full line (with "effort") is in its tooltip and the drawer.
    const line = (snap.running ? state.reason || state.text : state.text).replace(/ effort$/, '');
    meta.append(icon, node('span', 'plan-node-route', line));
    button.append(top, title, meta);
    const waits = step.dependsOn.map(id => `step ${numberOf(snap.steps, id)}`);
    button.setAttribute('aria-label', `Step ${number}, ${orchestration().roleName(step.role)}: ${step.title.trim() || 'untitled'}. ${waits.length ? `After ${listed(waits)}.` : 'Starts first.'} ${state.text}.`);
    button.title = state.reason || step.title;
    button.addEventListener('click', () => select(step.id));
    return button;
  }

  function drawChart(snap) {
    const chart = $('plan-view-chart');
    chart.replaceChildren(...columns(snap.steps).map(group => {
      const column = node('section', 'plan-column'), head = node('header', 'plan-column-head');
      head.append(node('span', 'plan-column-name', group.name), node('span', 'plan-column-count', String(group.steps.length)));
      const list = node('div', 'plan-column-cards');
      list.append(...group.steps.map(step => card(snap, step)));
      column.append(head, list);
      return column;
    }));
    window.requestAnimationFrame?.(() => arrows(snap));
  }

  // Arrows from each step to the steps that wait for it, drawn over the chart once its cards have a place.
  function arrows(snap) {
    const chart = $('plan-view-chart');
    if (!dialog.open || view !== 'chart' || !document.createElementNS || !chart.getBoundingClientRect) return;
    chart.querySelector(':scope > svg.plan-arrows')?.remove();
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), base = chart.getBoundingClientRect();
    svg.setAttribute('class', 'plan-arrows'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', String(chart.scrollWidth)); svg.setAttribute('height', String(chart.scrollHeight));
    const box = id => { const element = chart.querySelector(`.plan-node[data-step="${window.CSS?.escape ? window.CSS.escape(id) : id}"]`); if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top, middle: (r.top + r.bottom) / 2 - base.top, center: (r.left + r.right) / 2 - base.left }; };
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', 'plan-arrow-head'); marker.setAttribute('viewBox', '0 0 8 8'); marker.setAttribute('refX', '7'); marker.setAttribute('refY', '4');
    marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7'); marker.setAttribute('orient', 'auto-start-reverse');
    const tip = document.createElementNS(NS, 'path'); tip.setAttribute('d', 'M0 0L8 4L0 8z'); marker.append(tip);
    const defs = document.createElementNS(NS, 'defs'); defs.append(marker); svg.append(defs);
    for (const step of snap.steps) for (const id of step.dependsOn) {
      const from = box(id), to = box(step.id); if (!from || !to) continue;
      let d;
      if (to.left > from.right) { const bend = Math.max(24, (to.left - from.right) / 2); d = `M${from.right} ${from.middle}C${from.right + bend} ${from.middle} ${to.left - bend} ${to.middle} ${to.left - 2} ${to.middle}`; }
      else d = `M${from.center} ${from.bottom}C${from.center} ${from.bottom + 18} ${to.center} ${to.top - 18} ${to.center} ${to.top - 2}`;
      const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); path.setAttribute('marker-end', 'url(#plan-arrow-head)');
      const upstream = snap.running ? taskFor(snap, snap.steps.find(item => item.id === id))?.status : null;
      path.setAttribute('class', `plan-arrow${DONE.includes(upstream) ? ' done' : ''}${selected && (selected === id || selected === step.id) ? ' related' : ''}`);
      svg.append(path);
    }
    chart.prepend(svg);
  }

  function drawOutline(snap) {
    $('plan-view-outline').replaceChildren(...columns(snap.steps).map(group => {
      const item = node('li', 'plan-outline-group'), list = node('ol', 'plan-outline-steps');
      item.append(node('h3', 'plan-outline-name', group.name), list);
      list.append(...group.steps.map(step => {
        const row = node('li'), number = numberOf(snap.steps, step.id), state = stateOf(snap, step), button = node('button', 'plan-outline-step'); button.type = 'button';
        button.dataset.step = step.id; button.dataset.status = state.status; button.setAttribute('aria-pressed', String(selected === step.id));
        const waits = step.dependsOn.map(id => `step ${numberOf(snap.steps, id)}`);
        button.append(node('span', 'plan-node-number', String(number)), node('span', 'plan-outline-title', step.title.trim() || 'Untitled step'),
          node('span', 'plan-outline-meta', [orchestration().roleName(step.role), waits.length ? `after ${listed(waits)}` : 'starts first', state.text].join(' · ')));
        button.addEventListener('click', () => select(step.id));
        row.append(button); return row;
      }));
      return item;
    }));
  }

  // The drawer: a draft's step opens in the same editor as the panel; a running step shows what it does and its task.
  function renderDrawer(snap) {
    const aside = $('plan-view-drawer'), body = $('plan-view-drawer-body'), index = snap.steps.findIndex(step => step.id === selected), step = snap.steps[index];
    if (!step) { aside.hidden = true; drawer = null; body.replaceChildren(); return; }
    aside.hidden = false;
    $('plan-view-drawer-title').textContent = `Step ${index + 1}${snap.running ? ` · ${orchestration().taskLabel(taskFor(snap, step))}` : ''}`;
    if (snap.draft) {
      const key = `${snap.structure}:${index}`;
      if (drawer?.step !== step || drawer.key !== key) {
        const detail = orchestration().stepDetail(step, index), tools = node('div', 'plan-drawer-tools');
        const tool = (text, handler, disabled) => { const b = node('button', 'secondary-button', text); b.type = 'button'; b.disabled = disabled; b.addEventListener('click', handler); return b; };
        tools.append(tool('Move earlier', () => orchestration().move(index, -1), index === 0 || snap.busy),
          tool('Move later', () => orchestration().move(index, 1), index === snap.steps.length - 1 || snap.busy),
          tool('Remove step', () => { selected = null; orchestration().remove(index); }, snap.busy));
        body.replaceChildren(detail, tools); drawer = { step, key };
      }
      orchestration().syncDetail(body.querySelector('.orchestration-step-detail'), step, index);
      return;
    }
    drawer = null;
    const task = taskFor(snap, step), state = stateOf(snap, step), facts = node('dl', 'plan-drawer-facts');
    const fact = (term, value) => { if (value) facts.append(node('dt', '', term), node('dd', '', value)); };
    fact('Role', orchestration().roleName(step.role));
    fact('Agent', snap.running ? state.text : orchestration().routeText(step).text);
    fact('Runs after', step.dependsOn.length ? listed(step.dependsOn.map(id => `step ${numberOf(snap.steps, id)}`)) : 'Starts first');
    fact('Files', step.files.join(', '));
    fact('Check', step.check || '');
    fact('Why it waits', state.reason);
    const parts = [node('h4', 'plan-drawer-step-title', step.title), node('p', 'plan-drawer-instructions', step.instructions), facts];
    if (task) {
      const open = node('button', 'primary-button', 'Open its task'); open.type = 'button';
      open.addEventListener('click', () => { dialog.close(); orchestration().openTask(task.id)?.catch?.(error => window.relayUI?.showNotice?.(error.message)); });
      parts.push(open);
    }
    body.replaceChildren(...parts);
  }

  function select(id) {
    selected = selected === id ? null : id;
    render();
    if (selected) ($('plan-view-drawer-body').querySelector('.orchestration-step-title') || $('plan-view-drawer-close'))?.focus();
  }

  function render() {
    if (!dialog.open) return;
    const snap = orchestration()?.snapshot();
    for (const id of ['plan-view-modes', 'plan-view-foot-slot']) $(id).hidden = !snap;
    if (!snap) {
      if (shown) { dialog.close(); return; }
      // No plan: the page says how to start one (orchestration.js shows it), or that the plan is in the Workspace chat.
      const main = orchestration()?.onMain() !== false, empty = $('plan-view-empty');
      $('plan-view-title').textContent = 'Plan';
      for (const id of ['plan-view-summary', 'plan-view-documents', 'plan-view-usage', 'plan-view-chart', 'plan-view-outline', 'plan-view-drawer', 'orchestration-add']) if ($(id)) $(id).hidden = true;
      empty.textContent = main ? '' : 'A plan belongs to the Workspace chat. Go back to it to see the plan.'; empty.hidden = main;
      selected = null; drawn = null; drawer = null; $('plan-view-drawer-body').replaceChildren();
      return;
    }
    shown = true;
    const { plan } = snap;
    $('plan-view-title').textContent = snap.title || 'Plan';
    const summary = plan.summary || plan.goal || '';
    $('plan-view-summary').textContent = summary; $('plan-view-summary').hidden = !summary;
    const documents = plan.documents || [];
    $('plan-view-documents').textContent = documents.length ? `Planned from ${listed(documents)}.` : '';
    $('plan-view-documents').hidden = !documents.length;
    showUsage(plan.id); loadUsage(snap);
    for (const button of modes()) button.setAttribute('aria-pressed', String(modeOf(button) === view));
    if (selected && !snap.steps.some(step => step.id === selected)) selected = null;
    const empty = $('plan-view-empty');
    empty.textContent = snap.draft && !snap.steps.length ? 'This plan has no steps yet. Add step adds one.' : '';
    empty.hidden = !empty.textContent;
    $('plan-view-chart').hidden = view !== 'chart' || !snap.steps.length;
    $('plan-view-outline').hidden = view !== 'outline' || !snap.steps.length;
    const signature = JSON.stringify([view, plan.id, plan.status, selected, snap.steps.map(step => [step.id, step.title, step.role, step.phase, step.tier, step.agent?.provider, step.dependsOn]), snap.tasks?.map(row => [row.task?.status, row.task?.reason, row.task?.runningProvider])]);
    if (signature !== drawn) {
      drawn = signature;
      const focused = document.activeElement?.closest?.('#plan-view-canvas') ? document.activeElement.dataset?.step : null;
      if (view === 'chart') drawChart(snap); else drawOutline(snap);
      if (focused) $('plan-view-canvas').querySelector(`[data-step="${focused}"]`)?.focus();
    }
    renderDrawer(snap);
  }

  function open() {
    if (dialog.open) return;
    drawn = null; drawer = null; shown = false; usage = null; usageKey = null;
    const goal = $('plan-empty-goal'), message = $('message-input')?.value?.trim() || '';
    if (goal) goal.value = message;
    dialog.showModal();
    orchestration()?.render();
    ($('plan-view-canvas').querySelector('.plan-node') || $('plan-view-canvas').querySelector('.plan-outline-step') || (orchestration()?.snapshot() ? null : goal))?.focus();
  }

  dialog.addEventListener('close', () => { selected = null; shown = false; drawn = null; drawer = null; $('plan-view-drawer-body').replaceChildren(); orchestration()?.render(); });
  $('plan-view-close').addEventListener('click', () => dialog.close());
  $('plan-view-drawer-close').addEventListener('click', () => { const was = selected; selected = null; render(); if (was) $('plan-view-canvas').querySelector(`[data-step="${was}"]`)?.focus(); });
  for (const button of modes()) button.addEventListener('click', () => {
    view = modeOf(button); drawn = null;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* A convenience only. */ }
    render();
  });
  // Add step adds the step to the draft; here it also opens it in the drawer.
  $('orchestration-add')?.addEventListener('click', () => {
    if (!dialog.open) return;
    const snap = orchestration()?.snapshot(); const last = snap?.steps.at(-1);
    if (last) select(last.id);
  });
  window.addEventListener('resize', () => { if (dialog.open && view === 'chart') { const snap = orchestration()?.snapshot(); if (snap) arrows(snap); } });

  window.relayPlanView = { open, render, close: () => { if (dialog.open) dialog.close(); }, isOpen: () => dialog.open, columns, usageText };
})();

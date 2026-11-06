// Orchestrate (#12, stage 3): with Routing on, a message can be planned as a few steps, each done by the agent that suits
// it. Turned on for one message, the message box says who will plan; the planner's reply then opens as a plan card above
// the message box, where every step's text, tier and agent can be changed, steps added, removed and reordered, and the
// plan saved. Nothing runs until the plan is approved. The server checks every saved plan again.
(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI;
  const LIMITS = { steps: 5, title: 120, instructions: 4000, files: 12 };
  const names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const tiers = [['light', 'Light'], ['standard', 'Standard'], ['deep', 'Deep']];
  const open = ['planning', 'draft', 'unstructured', 'failed', 'interrupted'];
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  // failure: what the server last refused, shown until the plan is changed again.
  let armedFor = null, edit = null, drawn = null, busy = false, failure = null;

  const state = () => api.getState();
  const conversation = () => state().conversation;
  // Orchestrate uses Routing's rules, so it's offered only with Routing on, from the main conversation.
  const available = () => { const s = state(); return Boolean(s.ready && s.conversation?.routing && !s.localSelections?.[s.projectId] && !s.taskId && !s.taskDraft); };
  const armed = () => armedFor !== null && armedFor === state().projectId && available();
  const visiblePlan = () => { const plan = conversation()?.orchestrations?.[0]; return plan && open.includes(plan.status) ? plan : null; };
  const copy = plan => ({ planId: plan.id, revision: plan.revision, review: plan.review !== false, steps: JSON.parse(JSON.stringify(plan.steps || [])), dirty: false, changed: false, structure: 0 });
  const choiceText = routed => [names[routed.provider] || routed.provider, routed.modelName || 'default model', routed.effort ? `${routed.effort[0].toUpperCase()}${routed.effort.slice(1)} effort` : ''].filter(Boolean).join(' · ');

  // The same checks the server makes, so a problem shows before saving.
  function problem(steps) {
    const ids = [];
    for (const [index, step] of steps.entries()) {
      const number = index + 1;
      if (!step.title.trim() || step.title.trim().length > LIMITS.title) return `Give step ${number} a title of at most ${LIMITS.title} characters.`;
      if (!step.instructions.trim() || step.instructions.trim().length > LIMITS.instructions) return `Give step ${number} instructions of at most ${LIMITS.instructions.toLocaleString('en-US')} characters.`;
      if (step.files.length > LIMITS.files) return `List at most ${LIMITS.files} files or folders for step ${number}, each as a path.`;
      if (step.dependsOn.some(id => !ids.includes(id))) return `Step ${number} can only depend on an earlier step.`;
      ids.push(step.id);
    }
    return null;
  }
  // The most this plan can cost in runs: each step, a retry after failed tests where Check with tests is on, and the review.
  function cost(plan, steps, review) {
    if (!steps.length) return plan.source === 'agent' ? 'Planning used 1 run. Add the steps this plan needs.' : 'Add the steps this plan needs.';
    const check = conversation()?.routing?.check === true, parts = [plural(steps.length, 'step')];
    if (check) parts.push(steps.length === 1 ? 'a retry if the tests fail' : 'a retry each if the tests fail');
    if (review) parts.push('1 review');
    const total = steps.length * (check ? 2 : 1) + (review ? 1 : 0);
    const list = parts.length < 3 ? parts.join(' and ') : `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
    return `Worst case ${plural(total, 'run')}: ${list}.${plan.source === 'agent' ? ' Planning used 1 run.' : ''}`;
  }

  async function action(input, success) {
    const c = conversation(); if (!c || busy) return false;
    busy = true; render();
    failure = null;
    try { await api.post(`/api/conversations/${encodeURIComponent(c.id)}/orchestration`, input); success?.(); return true; }
    catch (error) {
      // Without a card on screen (a plan written from the message box), the message box's notice says what went wrong.
      if ($('orchestration-card').hidden) api.showNotice(error.message); else failure = error.message;
      if (/another window/.test(error.message)) edit = null;
      return false;
    }
    finally { busy = false; await api.refresh(); render(); }
  }
  function showError(message) { $('orchestration-error').textContent = message || ''; $('orchestration-error').hidden = !message; }
  // A plan written by hand starts from the drafted message, without a model call.
  async function writeYourself(goal) {
    goal = (goal || '').trim();
    if (!goal) { api.showNotice('Describe what the plan is for first.'); return; }
    const fromDraft = goal === $('message-input').value.trim();
    if (await action({ action: 'create', goal })) {
      armedFor = null;
      if (fromDraft) { $('message-input').value = ''; $('message-input').dispatchEvent(new CustomEvent('input')); }
      api.announce('An empty plan is ready. Add its steps.');
    }
  }

  function routeLine(step) {
    const routed = api.routeFor(step.instructions || step.title || 'Plan step', 0, { tier: step.tier, only: step.agent?.provider || null });
    if (!routed) return 'Routing is off';
    if (routed.error) return routed.error;
    return `${step.agent ? '' : 'Auto: '}${choiceText(routed)}`;
  }
  // Moving a step keeps focus on the control that moved it.
  function move(index, by, control) {
    const to = index + by; if (to < 0 || to >= edit.steps.length) return;
    const [step] = edit.steps.splice(index, 1); edit.steps.splice(to, 0, step);
    changed(true);
    $('orchestration-steps').children[to]?.querySelector(`.orchestration-step-${control}`)?.focus();
  }
  function changed(structure = false) { edit.dirty = true; failure = null; if (structure) edit.structure++; render(); }
  function stepRow(step, index) {
    const number = index + 1, row = node('li', 'orchestration-step'), head = node('div', 'orchestration-step-head');
    const title = node('input', 'orchestration-step-title'); title.value = step.title; title.maxLength = LIMITS.title; title.setAttribute('aria-label', `Step ${number} title`); title.placeholder = 'What this step does';
    title.addEventListener('input', () => { step.title = title.value; changed(); });
    const tools = node('div', 'orchestration-step-move');
    const tool = (cls, text, label, handler, disabled) => { const button = node('button', `icon-button orchestration-step-${cls}`, text); button.type = 'button'; button.setAttribute('aria-label', label); button.title = label; button.disabled = disabled; button.addEventListener('click', handler); return button; };
    tools.append(tool('up', '↑', `Move step ${number} up`, () => move(index, -1, 'up'), index === 0), tool('down', '↓', `Move step ${number} down`, () => move(index, 1, 'down'), index === edit.steps.length - 1),
      tool('remove', '×', `Remove step ${number}`, () => { edit.steps.splice(index, 1); for (const other of edit.steps) other.dependsOn = other.dependsOn.filter(id => id !== step.id); changed(true); }, false));
    head.append(node('span', 'orchestration-step-number', String(number)), title, tools);
    const instructions = node('textarea', 'orchestration-step-instructions'); instructions.value = step.instructions; instructions.rows = 2; instructions.maxLength = LIMITS.instructions; instructions.placeholder = 'What to do, and how to know it is done';
    instructions.setAttribute('aria-label', `Step ${number} instructions`);
    instructions.addEventListener('input', () => { step.instructions = instructions.value; changed(); });
    const meta = node('div', 'orchestration-step-meta');
    const tier = node('select', 'orchestration-step-tier'); tier.setAttribute('aria-label', `Step ${number} tier`);
    for (const [value, text] of tiers) { const option = node('option', '', text); option.value = value; tier.append(option); }
    tier.value = step.tier; tier.addEventListener('change', () => { step.tier = tier.value; changed(); });
    const agent = node('select', 'orchestration-step-agent'); agent.setAttribute('aria-label', `Step ${number} agent`);
    for (const [value, text] of [['', 'Auto'], ['codex', 'Codex'], ['claude', 'Claude'], ['gemini', 'Gemini']]) { const option = node('option', '', text); option.value = value; agent.append(option); }
    agent.value = step.agent?.provider || ''; agent.addEventListener('change', () => { step.agent = agent.value ? { provider: agent.value, model: null, effort: null } : null; changed(); });
    const files = node('input', 'orchestration-step-files'); files.value = step.files.join(', '); files.placeholder = 'Files or folders it changes, separated by commas'; files.setAttribute('aria-label', `Files step ${number} expects to change`);
    files.addEventListener('input', () => { step.files = files.value.split(',').map(value => value.trim()).filter(Boolean); changed(); });
    meta.append(tier, agent, files);
    row.append(head, instructions, meta, node('p', 'orchestration-step-route'), node('p', 'orchestration-step-needs'));
    return row;
  }
  // What changes as the person types: routing, dependencies, cost and whether the plan can be saved.
  function refreshDerived(plan) {
    const rows = $('orchestration-steps').children, numbers = new Map(edit.steps.map((step, index) => [step.id, index + 1]));
    edit.steps.forEach((step, index) => {
      const row = rows[index]; if (!row) return;
      row.querySelector('.orchestration-step-route').textContent = routeLine(step);
      const needs = row.querySelector('.orchestration-step-needs'), after = step.dependsOn.map(id => numbers.get(id)).filter(Boolean);
      needs.textContent = after.length ? `After step ${after.join(', ')}` : ''; needs.hidden = !after.length;
    });
    $('orchestration-title').textContent = `Plan · ${edit.steps.length ? plural(edit.steps.length, 'step') : 'No steps yet'}`;
    $('orchestration-cost').textContent = cost(plan, edit.steps, edit.review);
    const issue = edit.dirty ? problem(edit.steps) : null;
    showError(issue || failure);
    $('orchestration-save').hidden = $('orchestration-revert').hidden = !edit.dirty;
    $('orchestration-save').disabled = busy || Boolean(issue);
    $('orchestration-revert').disabled = busy;
    $('orchestration-add').disabled = busy || edit.steps.length >= LIMITS.steps;
    $('orchestration-review').checked = edit.review;
    $('orchestration-review').disabled = busy;
  }

  function renderCard() {
    const plan = visiblePlan(), card = $('orchestration-card');
    card.hidden = !plan;
    if (!plan) { edit = null; drawn = null; failure = null; return; }
    const draft = plan.status === 'draft';
    card.dataset.status = plan.status;
    $('orchestration-discard').hidden = plan.status === 'planning'; $('orchestration-discard').disabled = busy;
    $('orchestration-summary').textContent = plan.summary && draft ? plan.summary : plan.goal;
    $('orchestration-summary').hidden = !$('orchestration-summary').textContent;
    $('orchestration-write').hidden = draft || plan.status === 'planning'; $('orchestration-write').disabled = busy;
    for (const id of ['orchestration-steps', 'orchestration-tools', 'orchestration-cost']) $(id).hidden = !draft;
    const status = $('orchestration-status');
    if (!draft) {
      edit = null; drawn = null; $('orchestration-steps').replaceChildren();
      $('orchestration-save').hidden = $('orchestration-revert').hidden = true; showError(failure);
      const planner = plan.planner ? [names[plan.planner.provider], plan.planner.model].filter(Boolean).join(' · ') : 'the planner';
      $('orchestration-title').textContent = plan.status === 'planning' ? 'Plan · Planning…' : 'Plan · Not ready';
      status.textContent = plan.status === 'planning' ? `${planner} is planning the steps, read-only. Nothing else runs until you approve the plan.` : plan.summary;
      status.hidden = false; return;
    }
    // Another window saved a newer version: show it, unless there are unsaved changes here, which the server then refuses.
    if (!edit || edit.planId !== plan.id || (!edit.dirty && edit.revision !== plan.revision)) edit = copy(plan);
    status.hidden = !(edit.dirty && edit.revision !== plan.revision);
    status.textContent = status.hidden ? '' : 'This plan changed in another window. Revert to see the latest version.';
    const signature = JSON.stringify([plan.id, edit.revision, edit.structure, edit.steps.map(step => step.id)]);
    if (signature !== drawn) { drawn = signature; $('orchestration-steps').replaceChildren(...edit.steps.map(stepRow)); }
    refreshDerived(plan);
  }
  function render() {
    const show = available() && !api.isRunning() && !conversation()?.resume;
    $('orchestrate-toggle').hidden = !show;
    $('orchestrate-toggle').setAttribute('aria-pressed', String(armed()));
    $('orchestrate-armed').hidden = !(show && armed());
    $('orchestrate-write').disabled = busy;
    renderCard();
  }

  $('orchestrate-toggle').addEventListener('click', () => {
    armedFor = armed() ? null : state().projectId;
    render(); api.renderControls();
    api.announce(armed() ? 'Orchestrate is on for this message. An agent plans the steps first.' : 'Orchestrate is off.');
  });
  $('orchestrate-off').addEventListener('click', () => { armedFor = null; render(); api.renderControls(); });
  $('orchestrate-write').addEventListener('click', () => writeYourself($('message-input').value));
  $('orchestration-write').addEventListener('click', () => writeYourself(visiblePlan()?.goal));
  $('orchestration-add').addEventListener('click', () => {
    if (!edit || edit.steps.length >= LIMITS.steps) return;
    const next = Math.max(0, ...edit.steps.map(step => Number(step.id.slice(1)))) + 1;
    edit.steps.push({ id: `s${next}`, title: '', instructions: '', files: [], tier: 'standard', dependsOn: [], agent: null });
    changed(true);
    const rows = $('orchestration-steps').children; rows[rows.length - 1]?.querySelector('.orchestration-step-title')?.focus();
  });
  $('orchestration-review').addEventListener('change', () => { if (edit) { edit.review = $('orchestration-review').checked; changed(); } });
  $('orchestration-revert').addEventListener('click', () => { const plan = visiblePlan(); if (plan) { edit = copy(plan); drawn = null; failure = null; render(); } });
  $('orchestration-save').addEventListener('click', () => {
    if (!edit || $('orchestration-save').disabled) return;
    action({ action: 'update', id: edit.planId, revision: edit.revision, review: edit.review, steps: edit.steps }, () => { edit = null; drawn = null; api.announce('Plan saved.'); });
  });
  $('orchestration-discard').addEventListener('click', () => { const plan = visiblePlan(); if (plan) action({ action: 'discard', id: plan.id }, () => { edit = null; api.announce('Plan discarded.'); }); });
  window.addEventListener('relay-state', render);
  window.addEventListener('relay-account', render);

  window.relayOrchestration = {
    armed, render,
    accepted(projectId) { if (armedFor === projectId) armedFor = null; render(); },
    // How the planner's reply reads in the thread.
    describe(plan) {
      if (!plan) return '';
      if (plan.status === 'planning') return 'Planning the steps…';
      if (plan.steps?.length) return `Proposed a plan of ${plural(plan.steps.length, 'step')}: ${plan.summary || plan.goal}`;
      return plan.summary || '';
    },
  };
  render();
})();

// Orchestrate (#12, stage 3): in Flow, a message can be planned as a few steps. Turned on for one message, one read-only
// run plans it with the deepest work the routing mode allows; the plan then opens as a card above the message box. Each
// step is one row (number, title, tier, and the agent and model routing chose) that opens to edit it, and the worst case
// and the actions stay pinned below the steps. Nothing from a plan runs until it is approved, and queued messages wait
// for it. The server checks every saved plan again.
(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI;
  const LIMITS = { steps: 5, title: 120, instructions: 4000, files: 12 };
  const names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const TIERS = [['light', 'Light'], ['standard', 'Standard'], ['deep', 'Deep']];
  const AGENTS = [['', 'Auto'], ['codex', 'Codex'], ['claude', 'Claude'], ['gemini', 'Gemini']];
  const OPEN = ['planning', 'draft', 'unstructured', 'failed', 'interrupted'];
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const clip = (text, size = 280) => text.length > size ? `${text.slice(0, size - 1).trimEnd()}…` : text;
  // failure: what the server last refused, shown until the plan is changed again. asking: the answer to "replace this
  // plan?", while the card asks it. opened: the rows open for editing, kept for the plan across refreshes and saves.
  let armedFor = null, edit = null, drawn = null, busy = false, failure = null, asking = null, opened = { planId: null, ids: new Set() };

  const state = () => api.getState();
  const conversation = () => state().conversation;
  const inFlow = () => window.relayFlow?.isOn?.() === true;
  // Orchestrate uses Routing's rules, and its steps are routed by Flow, so it's offered only in Flow, from the main conversation.
  // A plan belongs to the main conversation. A new task's draft starts from it, so it carries the plans too.
  const onMain = () => !state().taskId && !state().taskDraft;
  const available = () => { const s = state(); return Boolean(inFlow() && s.ready && s.conversation?.routing && !s.localSelections?.[s.projectId] && onMain()); };
  const armed = () => armedFor !== null && armedFor === state().projectId && available();
  const openPlan = () => { const plan = conversation()?.orchestrations?.[0]; return plan && OPEN.includes(plan.status) ? plan : null; };
  const modeName = () => window.relayRouting?.modeNames?.[conversation()?.routing?.mode] || 'the routing mode';
  const copy = plan => ({ planId: plan.id, revision: plan.revision, review: plan.review !== false, steps: JSON.parse(JSON.stringify(plan.steps || [])), dirty: false, structure: 0 });
  const effortText = effort => effort ? `${effort[0].toUpperCase()}${effort.slice(1)} effort` : '';
  const choiceText = routed => [names[routed.provider] || routed.provider, routed.modelName || 'default model', effortText(routed.effort)].filter(Boolean).join(' · ');

  // The same checks the server makes, so a problem shows before saving.
  function problem(steps) {
    const numbers = new Map(steps.map((step, index) => [step.id, index + 1]));
    for (const [index, step] of steps.entries()) {
      const number = index + 1;
      if (!step.title.trim() || step.title.trim().length > LIMITS.title) return `Give step ${number} a title of at most ${LIMITS.title} characters.`;
      if (!step.instructions.trim() || step.instructions.trim().length > LIMITS.instructions) return `Give step ${number} instructions of at most ${LIMITS.instructions.toLocaleString('en-US')} characters.`;
      if (step.files.length > LIMITS.files) return `List at most ${LIMITS.files} files or folders for step ${number}, each as a path.`;
      const later = step.dependsOn.find(id => !(numbers.get(id) < number));
      if (later) return `Step ${number} can only wait for an earlier step. Remove “After step ${numbers.get(later)}” from it, or move it back.`;
    }
    return null;
  }
  // The most this plan can cost in runs: each step, a retry after failed tests where Check with tests runs them after each
  // step (Review first leaves the tests to the review), and the review.
  function cost(plan, steps, review) {
    if (!steps.length) return plan.source === 'agent' ? 'Planning used 1 run. Add the steps this plan needs.' : 'Add the steps this plan needs.';
    const retries = conversation()?.routing?.check === true && state().status?.verificationCadence !== 'review-first', parts = [plural(steps.length, 'step')];
    if (retries) parts.push(steps.length === 1 ? 'a retry if the tests fail' : 'a retry each if the tests fail');
    if (review) parts.push('1 review');
    const total = steps.length * (retries ? 2 : 1) + (review ? 1 : 0);
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
  // A new plan replaces the open one. With unsaved edits, the card asks first; anything that replaces it waits for the answer.
  function mayReplace() {
    const plan = openPlan();
    if (!plan || !edit?.dirty || edit.planId !== plan.id || $('orchestration-card').hidden) return Promise.resolve(true);
    asking?.(false);
    return new Promise(resolve => {
      asking = answer => { asking = null; resolve(answer); render(); };
      render(); $('orchestration-confirm-no').focus();
    });
  }
  // A plan written by hand starts from the drafted message, without a model call.
  async function writeYourself(goal) {
    goal = (goal || '').trim();
    if (!goal) { api.showNotice('Describe what the plan is for first.'); return; }
    if (!(await mayReplace())) return;
    const fromDraft = goal === $('message-input').value.trim();
    if (await action({ action: 'create', goal })) {
      armedFor = null;
      if (fromDraft) { $('message-input').value = ''; $('message-input').dispatchEvent(new CustomEvent('input')); }
      api.announce('An empty plan is ready. Add its steps.');
    }
  }
  // Plan again sends the planned message once more, with the files it had, and leaves the message box as it is.
  function planAgain() {
    const plan = openPlan(); if (!plan || busy) return;
    const message = conversation()?.messages?.find(item => item.role === 'user' && item.orchestrationId === plan.id);
    api.planAgain({ text: plan.goal, attachments: (message?.attachments || []).map(file => file.id).filter(Boolean) });
  }

  function route(step) {
    const routed = api.routeFor(step.instructions || step.title || 'Plan step', 0, null, { tier: step.tier, only: step.agent?.provider || null });
    if (!routed) return { provider: 'auto', text: 'Routing is off' };
    if (routed.error) return { provider: 'auto', text: routed.error };
    return { provider: routed.provider, text: `${step.agent ? '' : 'Auto: '}${choiceText(routed)}` };
  }
  function changed(structure = false) { edit.dirty = true; failure = null; if (structure) edit.structure++; render(); }
  // Moving a step keeps focus on the control that moved it.
  function move(index, by, control) {
    const to = index + by; if (to < 0 || to >= edit.steps.length) return;
    const [step] = edit.steps.splice(index, 1); edit.steps.splice(to, 0, step);
    changed(true);
    const target = $('orchestration-steps').children[to]?.querySelector(`.orchestration-step-${control}`);
    (target?.disabled ? $('orchestration-steps').children[to]?.querySelector('.orchestration-step-toggle') : target)?.focus();
  }
  function remove(index) {
    const [step] = edit.steps.splice(index, 1);
    for (const other of edit.steps) other.dependsOn = other.dependsOn.filter(id => id !== step.id);
    opened.ids.delete(step.id); changed(true);
  }
  const iconButton = (cls, label, handler, disabled = false) => {
    const button = node('button', `icon-button orchestration-icon ${cls}`); button.type = 'button';
    button.setAttribute('aria-label', label); button.title = label; button.disabled = disabled; button.addEventListener('click', handler); return button;
  };
  // A row of buttons that works like the message box's choices: one pressed at a time, or several for the steps it waits for.
  function segment(label, cls) { const group = node('div', `orchestration-segment ${cls}`); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label); return group; }
  function choice(cls, text, key, value, handler, iconClass) {
    const button = node('button', `orchestration-choice ${cls}`); button.type = 'button'; button.dataset[key] = value;
    if (iconClass) { const icon = node('i', iconClass); icon.setAttribute('aria-hidden', 'true'); button.append(icon); }
    button.append(document.createTextNode(text)); button.setAttribute('aria-pressed', 'false'); button.addEventListener('click', handler); return button;
  }
  function field(tag, cls, value, label, placeholder, handler) {
    const input = node(tag, `orchestration-field ${cls}`); input.value = value; input.placeholder = placeholder; input.setAttribute('aria-label', label);
    input.addEventListener('input', () => handler(input.value)); return input;
  }
  function stepRow(step, index) {
    const number = index + 1, row = node('li', 'orchestration-step'), line = node('div', 'orchestration-step-line'), open = opened.ids.has(step.id);
    row.dataset.step = step.id;
    const toggle = node('button', 'orchestration-step-toggle'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(open));
    const detail = node('div', 'orchestration-step-detail'); detail.id = `orchestration-step-detail-${step.id}`; detail.hidden = !open; toggle.setAttribute('aria-controls', detail.id);
    toggle.append(node('span', 'orchestration-step-number', String(number)), node('span', 'orchestration-step-name'), node('span', 'effort-bars orchestration-step-tier'), node('span', 'orchestration-step-route'));
    toggle.addEventListener('click', () => {
      const show = !opened.ids.has(step.id); if (show) opened.ids.add(step.id); else opened.ids.delete(step.id);
      toggle.setAttribute('aria-expanded', String(show)); detail.hidden = !show;
    });
    const tools = node('div', 'orchestration-step-tools');
    tools.append(iconButton('orchestration-step-up', `Move step ${number} up`, () => move(index, -1, 'up'), index === 0),
      iconButton('orchestration-step-down', `Move step ${number} down`, () => move(index, 1, 'down'), index === edit.steps.length - 1),
      iconButton('orchestration-step-remove', `Remove step ${number}`, () => remove(index)));
    line.append(toggle, node('div', 'orchestration-step-afters'), tools);

    const title = field('input', 'orchestration-step-title', step.title, `Step ${number} title`, 'What this step does', value => { step.title = value; changed(); }); title.maxLength = LIMITS.title;
    const instructions = field('textarea', 'orchestration-step-instructions', step.instructions, `Step ${number} instructions`, 'What to do, and how to know it is done', value => { step.instructions = value; changed(); });
    instructions.rows = 3; instructions.maxLength = LIMITS.instructions;
    const files = field('input', 'orchestration-step-files', step.files.join(', '), `Files step ${number} expects to change`, 'Files or folders it changes, separated by commas', value => { step.files = value.split(',').map(item => item.trim()).filter(Boolean); changed(); });
    const tiers = segment(`Step ${number} tier`, 'orchestration-tiers');
    for (const [value, text] of TIERS) tiers.append(choice('orchestration-tier-option', text, 'tier', value, () => { step.tier = value; changed(); }));
    const agents = segment(`Step ${number} agent`, 'orchestration-agents');
    for (const [value, text] of AGENTS) agents.append(choice('orchestration-agent-option', text, 'provider', value, () => { step.agent = value ? { provider: value, model: null, effort: null } : null; changed(); }, `agent-icon ${value || 'auto'}`));
    const after = segment(`Steps that step ${number} waits for`, 'orchestration-afters-choice');
    const options = node('div', 'orchestration-step-options');
    options.append(labelled('Tier', tiers), labelled('Agent', agents), labelled('Runs after', after));
    detail.append(title, instructions, files, options);
    row.append(line, detail);
    return row;
  }
  function labelled(text, control) { const wrap = node('div', 'orchestration-option'); wrap.append(node('span', 'orchestration-option-label', text), control); return wrap; }
  // What changes as the person edits: names, tiers, routing, waits, cost and whether the plan can be saved.
  function refreshDerived(plan) {
    const rows = $('orchestration-steps').children, numbers = new Map(edit.steps.map((step, index) => [step.id, index + 1]));
    edit.steps.forEach((step, index) => {
      const row = rows[index]; if (!row) return;
      const name = row.querySelector('.orchestration-step-name'); name.textContent = step.title.trim() || 'Untitled step'; name.classList.toggle('untitled', !step.title.trim());
      const level = Math.max(0, TIERS.findIndex(([value]) => value === step.tier)), bars = row.querySelector('.orchestration-step-tier');
      bars.dataset.tier = TIERS[level][0]; bars.setAttribute('role', 'img'); bars.setAttribute('aria-label', `${TIERS[level][1]} step`); bars.title = `${TIERS[level][1]} step`;
      bars.replaceChildren(...TIERS.map((_, bar) => node('i', bar <= level ? 'on' : undefined)));
      const routed = route(step), line = row.querySelector('.orchestration-step-route'), icon = node('i', `agent-icon ${routed.provider}`); icon.setAttribute('aria-hidden', 'true');
      line.replaceChildren(icon, document.createTextNode(routed.text)); line.title = routed.text;
      const chips = row.querySelector('.orchestration-step-afters');
      chips.replaceChildren(...step.dependsOn.filter(id => numbers.has(id)).map(id => {
        const label = `After step ${numbers.get(id)}`, chip = node('button', 'orchestration-step-after', label); chip.type = 'button';
        chip.setAttribute('aria-label', `Remove “${label}” from step ${index + 1}`); chip.title = `Remove “${label}”`;
        chip.setAttribute('aria-invalid', String(!(numbers.get(id) < index + 1)));
        chip.addEventListener('click', () => { step.dependsOn = step.dependsOn.filter(other => other !== id); changed(); });
        return chip;
      }));
      for (const button of row.querySelectorAll('.orchestration-tier-option')) button.setAttribute('aria-pressed', String(button.dataset.tier === step.tier));
      for (const button of row.querySelectorAll('.orchestration-agent-option')) button.setAttribute('aria-pressed', String(button.dataset.provider === (step.agent?.provider || '')));
      row.querySelector('.orchestration-afters-choice').replaceChildren(...edit.steps.slice(0, index).map((earlier, position) => {
        const button = choice('orchestration-after-option', `Step ${position + 1}`, 'step', earlier.id, () => {
          step.dependsOn = step.dependsOn.includes(earlier.id) ? step.dependsOn.filter(id => id !== earlier.id) : [...step.dependsOn, earlier.id]; changed();
        });
        button.title = earlier.title.trim() || 'Untitled step'; button.setAttribute('aria-pressed', String(step.dependsOn.includes(earlier.id)));
        return button;
      }));
      if (!index) row.querySelector('.orchestration-afters-choice').append(node('span', 'orchestration-option-none', 'Starts first'));
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
    const plan = openPlan(), card = $('orchestration-card');
    // In a task the card waits, with any unsaved changes, for the person to come back to the main conversation.
    if (!onMain()) { card.hidden = true; asking?.(false); return; }
    if (!plan) { card.hidden = true; edit = null; drawn = null; failure = null; asking?.(false); return; }
    // Outside Flow the card waits, with any unsaved changes, for the person to come back.
    card.hidden = !inFlow();
    if (card.hidden) { asking?.(false); return; }
    const draft = plan.status === 'draft', planning = plan.status === 'planning', queued = conversation()?.queue?.length || 0;
    card.dataset.status = plan.status;
    $('orchestration-queue').textContent = queued ? `${plural(queued, 'queued message')} ${queued === 1 ? 'waits' : 'wait'} until you approve or discard this plan.` : '';
    $('orchestration-queue').hidden = !queued;
    $('orchestration-discard').hidden = planning; $('orchestration-discard').disabled = busy;
    $('orchestration-again').hidden = planning || plan.source === 'manual'; $('orchestration-again').disabled = busy || api.isRunning();
    $('orchestration-write').hidden = draft || planning; $('orchestration-write').disabled = busy;
    // While the card asks whether to replace the plan, its own actions wait for the answer.
    $('orchestration-confirm').hidden = !asking; $('orchestration-actions').hidden = Boolean(asking);
    $('orchestration-confirm-text').textContent = asking ? 'A new plan replaces this one and your unsaved changes.' : '';
    for (const id of ['orchestration-steps', 'orchestration-add', 'orchestration-review-option', 'orchestration-cost']) $(id).hidden = !draft;
    const status = $('orchestration-status'), summary = $('orchestration-summary');
    if (!draft) {
      edit = null; drawn = null; $('orchestration-steps').replaceChildren();
      $('orchestration-save').hidden = $('orchestration-revert').hidden = true; showError(failure);
      const planner = plan.planner ? [names[plan.planner.provider], plan.planner.model].filter(Boolean).join(' · ') : 'The planner';
      $('orchestration-title').textContent = planning ? 'Plan · Planning…' : 'Plan · Not ready';
      summary.textContent = clip(plan.goal || ''); summary.hidden = !summary.textContent;
      status.textContent = planning ? `${planner} is planning the steps, read-only. Nothing from this plan runs until you approve it.` : plan.summary;
      status.hidden = !status.textContent; return;
    }
    summary.textContent = clip(plan.summary || plan.goal || ''); summary.hidden = !summary.textContent;
    if (opened.planId !== plan.id) opened = { planId: plan.id, ids: new Set() };
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
    $('orchestrate-armed-text').textContent = `Orchestrate: one read-only run plans the steps first, with the deepest work ${modeName()} allows. Nothing from this plan runs until you approve it.`;
    $('orchestrate-write').disabled = busy;
    renderCard();
  }

  $('orchestrate-toggle').addEventListener('click', () => {
    armedFor = armed() ? null : state().projectId;
    render(); api.renderControls();
    api.announce(armed() ? 'Orchestrate is on for this message. One read-only run plans the steps first.' : 'Orchestrate is off.');
  });
  $('orchestrate-off').addEventListener('click', () => { armedFor = null; render(); api.renderControls(); });
  $('orchestrate-write').addEventListener('click', () => writeYourself($('message-input').value));
  $('orchestration-write').addEventListener('click', () => writeYourself(openPlan()?.goal));
  $('orchestration-again').addEventListener('click', planAgain);
  $('orchestration-confirm-yes').addEventListener('click', () => asking?.(true));
  $('orchestration-confirm-no').addEventListener('click', () => asking?.(false));
  $('orchestration-add').addEventListener('click', () => {
    if (!edit || edit.steps.length >= LIMITS.steps) return;
    const next = Math.max(0, ...edit.steps.map(step => Number(step.id.slice(1)) || 0)) + 1, id = `s${next}`;
    edit.steps.push({ id, title: '', instructions: '', files: [], tier: 'standard', dependsOn: [], agent: null });
    opened.ids.add(id); changed(true);
    const rows = $('orchestration-steps').children; rows[rows.length - 1]?.querySelector('.orchestration-step-title')?.focus();
  });
  $('orchestration-review').addEventListener('change', () => { if (edit) { edit.review = $('orchestration-review').checked; changed(); } });
  $('orchestration-revert').addEventListener('click', () => { const plan = openPlan(); if (plan) { edit = copy(plan); drawn = null; failure = null; render(); } });
  $('orchestration-save').addEventListener('click', () => {
    if (!edit || $('orchestration-save').disabled) return;
    action({ action: 'update', id: edit.planId, revision: edit.revision, review: edit.review, steps: edit.steps }, () => { edit = null; drawn = null; api.announce('Plan saved.'); });
  });
  $('orchestration-discard').addEventListener('click', () => { const plan = openPlan(); if (plan) action({ action: 'discard', id: plan.id }, () => { edit = null; api.announce('Plan discarded.'); }); });
  window.addEventListener('relay-state', render);
  window.addEventListener('relay-account', render);
  // Leaving Flow turns Orchestrate off for the drafted message; the card itself waits there.
  window.addEventListener('relay-flow', () => { if (!inFlow()) armedFor = null; render(); });

  window.relayOrchestration = {
    armed, render, mayReplace,
    // The plan that holds the queue, for Flow's What's next.
    waiting: () => onMain() ? openPlan() : null,
    accepted(projectId) { if (armedFor === projectId) armedFor = null; render(); },
    // How the planner's reply reads in the thread, and the label on the message it planned.
    describe(plan) {
      if (!plan) return '';
      if (plan.status === 'planning') return 'Planning the steps…';
      if (plan.steps?.length) return `Proposed a plan of ${plural(plan.steps.length, 'step')}: ${plan.summary || plan.goal}`;
      return plan.summary || '';
    },
    label(plan) {
      if (!plan) return 'Orchestrate';
      if (plan.status === 'planning') return 'Orchestrate · planning the steps';
      return plan.steps?.length ? 'Orchestrate · planned' : 'Orchestrate · not planned';
    },
  };
  render();
})();

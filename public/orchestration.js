// Orchestrate (#12, #89, #97): a message can be planned as steps. Turned on for one message, one read-only run plans it
// with the deepest work allowed. Since One Plan (#162) the steps arrive as draft cards on the Plan (board.js), which you
// accept or discard, and queued messages wait until you have. This module keeps Orchestrate's switch in the message box,
// and the card and chart (plan-view.js) for a plan made before then, which is still running or stopped.
(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI;
  const LIMITS = { steps: 5, title: 120, instructions: 4000, files: 12 };
  const names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const TIERS = [['light', 'Light'], ['standard', 'Standard'], ['deep', 'Deep']];
  const AGENTS = [['', 'Auto'], ['codex', 'Codex'], ['claude', 'Claude'], ['gemini', 'Gemini']];
  const ROLES = [['builder', 'Builder'], ['reviewer', 'Reviewer'], ['frontend', 'Frontend'], ['backend', 'Backend'], ['database', 'Database'], ['design', 'Design'], ['qa', 'QA']];
  const ARTIFACTS = [['', 'None'], ['contract', 'Contract'], ['schema', 'Schema'], ['diff', 'Diff'], ['test_evidence', 'QA evidence'], ['findings', 'Findings']];
  const roleNames = { builder: 'Builder', reviewer: 'Reviewer', frontend: 'Frontend', backend: 'Backend', database: 'Database', design: 'Design', qa: 'QA' };
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
  // A plan belongs to the main conversation. A new task's draft starts from it, so it carries the plans too.
  const onMain = () => !state().taskId && !state().taskDraft;
  const available = () => { const s = state(); return Boolean(s.ready && !s.localSelections?.[s.projectId] && onMain()); };
  const armed = () => armedFor !== null && armedFor === state().projectId && available();
  const openPlan = () => { const plan = conversation()?.orchestrations?.[0]; return plan && OPEN.includes(plan.status) ? plan : null; };
  const modeName = () => (conversation()?.routing ? (window.relayRouting?.modeNames?.[conversation()?.routing?.mode] || 'the routing mode') : (names[state().provider] || 'your selected agent'));
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
      window.relayPlanView?.open(); render(); $('orchestration-confirm-no').focus();
    });
  }
  // Writing it yourself (#162) opens the Plan with a new card written from the message, without a model call. The message
  // stays in the box until the card is added.
  function writeYourself(goal) {
    goal = (goal || '').trim();
    if (!goal) { api.showNotice('Describe what the plan is for first.'); return; }
    armedFor = null; render(); api.renderControls(); window.relayPlanView?.close();
    const first = goal.split('\n')[0].trim(), title = first.length > 200 ? `${first.slice(0, 199).trimEnd()}…` : first;
    window.relayBoard?.open({ title, notes: goal === first && first.length <= 200 ? '' : goal });
  }
  // Plan again sends the planned message once more, with the files it had, and leaves the message box as it is.
  function planAgain() {
    const plan = openPlan(); if (!plan || busy) return;
    const message = conversation()?.messages?.find(item => item.role === 'user' && item.orchestrationId === plan.id);
    api.planAgain({ text: plan.goal, attachments: (message?.attachments || []).map(file => file.id).filter(Boolean) });
  }

  function route(step) {
    const routed = api.routeFor(step.instructions || step.title || 'Plan step', 0, null, { tier: step.tier, only: step.agent?.provider || null });
    // assignment: what Run as tasks sends for this step. A step whose agent you chose runs with exactly that agent.
    if (!routed) {
      const p = step.agent?.provider || state().provider;
      const model = step.agent ? step.agent.model : state().model || null, effort = step.agent ? step.agent.effort : state().effort || null;
      return { provider: p, text: `${names[p] || p} · ${model || 'default model'}`, assignment: { provider: p, model: model || null, effort: effort || null } };
    }
    if (routed.error) return { provider: 'auto', text: routed.error, assignment: null };
    // A step left to Auto shows what Auto would pick now; in Flow it is chosen again when it starts (#12).
    return { provider: routed.provider, text: `${step.agent ? '' : 'Auto: '}${choiceText(routed)}`, assignment: { provider: routed.provider, model: routed.model || null, effort: routed.effort || null, ...(step.agent ? {} : { auto: true }) } };
  }
  // The plan the card shows: one still being made or edited, or one whose steps run as tasks until it is closed (#108).
  const RUN = ['running', 'stopped'];
  const runningPlan = () => { const plan = conversation()?.orchestrations?.[0]; return plan && RUN.includes(plan.status) ? plan : null; };
  const TASK_LABEL = { waiting: 'Waiting', running: 'Working', complete: 'Finished', stopped: 'Stopped', failed: 'Did not finish', integrated: 'Merged', kept: 'Kept as a branch', discarded: 'Discarded', cancelled: 'Cancelled', blocked: 'Blocked', lost: 'Copy gone', detached: 'Folder removed' };
  const LIVE = ['waiting', 'running'];
  const folders = () => state().projects?.find(project => project.id === state().projectId)?.folders || [];
  const planTasks = plan => (plan.steps || []).map((step, index) => ({ step, number: index + 1, task: (conversation()?.parallelTasks || []).find(task => task.id === plan.tasks?.[step.id]) || null }));
  // A finished step's tests (#89): a tone for colour, a short label, why, and whether it holds the steps after it.
  function checkOf(task) {
    const check = task?.stepCheck;
    if (!check || !['complete', 'integrated', 'kept'].includes(task.status)) return null;
    const open = task.status === 'complete';
    if (check.status === 'running' || task.testing) return { tone: 'running', text: 'Testing…', reason: 'Running the project’s tests on this step’s result.', held: open };
    if (check.status === 'interrupted') return { tone: check.accepted ? 'accepted' : 'failed', text: check.accepted ? 'Not tested · continued' : 'Tests interrupted', reason: check.reason || '', command: check.command || null, held: open && !check.accepted, retry: open };
    const [tone, text] = { passed: ['passed', 'Tests passed'], failed: check.accepted ? ['accepted', 'Tests failed · continued'] : ['failed', 'Tests failed'], no_change: ['quiet', 'No changes'] }[check.outcome] || ['quiet', 'Not tested'];
    return { tone, text, reason: check.reason || '', command: check.command || null, output: check.output || '', held: open && check.outcome === 'failed' && !check.accepted, retry: open };
  }
  // The earlier steps that finished again after this one started, so this one was built on an older version of them.
  function staleFrom(plan, task) {
    if (!task?.builtOn || task.status === 'waiting') return [];
    return Object.entries(task.builtOn).filter(([id, at]) => { const before = (conversation()?.parallelTasks || []).find(item => item.id === plan.tasks?.[id]); return before?.stepResult?.at && before.stepResult.at !== at; }).map(([id]) => id);
  }
  function runPlan() {
    const plan = openPlan(); if (!plan || !edit || edit.dirty || busy) return;
    const assignments = {};
    for (const [index, step] of plan.steps.entries()) {
      const routed = route(step);
      if (!routed.assignment) { failure = `Step ${index + 1}: ${routed.text}`; render(); return; }
      assignments[step.id] = routed.assignment;
    }
    const folderId = folders().length === 1 ? folders()[0].id : $('orchestration-folder').value;
    if (!folderId) { failure = 'Choose the folder these steps work in.'; render(); return; }
    action({ action: 'run', id: plan.id, revision: plan.revision, folderId, assignments, executionRevision: conversation()?.execution?.defaults?.revision ?? 0 }, () => { edit = null; drawn = null; api.announce(`The plan is running as ${plural(plan.steps.length, 'task')}.`); });
  }
  // A running plan: each step with its task's state, a way to open it, and Stop or Close for the whole plan.
  function renderRun(plan) {
    const rows = planTasks(plan), live = rows.some(row => row.task && LIVE.includes(row.task.status)), done = rows.filter(row => row.task && ['complete', 'integrated', 'kept'].includes(row.task.status)).length;
    $('orchestration-title').textContent = plan.status === 'stopped' ? 'Plan · Stopped' : live ? `Plan · Running · ${done} of ${rows.length} done` : `Plan · Finished · ${done} of ${rows.length} done`;
    $('orchestration-summary').textContent = clip(plan.summary || plan.goal || ''); $('orchestration-summary').hidden = !$('orchestration-summary').textContent;
    const status = $('orchestration-status'), waitingMerge = rows.filter(row => row.task?.hasWorktree && ['complete', 'stopped', 'failed'].includes(row.task.status)).length;
    status.textContent = waitingMerge ? `${plural(waitingMerge, 'step')} worked in ${waitingMerge === 1 ? 'its own copy and waits' : 'their own copies and wait'} for you to review and merge. Steps that depend on ${waitingMerge === 1 ? 'it start after it is' : 'them start after they are'} merged.` : '';
    status.hidden = !status.textContent;
    const list = $('orchestration-progress'); list.hidden = false;
    list.replaceChildren(...rows.map(({ step, number, task }) => {
      const item = node('li', 'orchestration-progress-step'), open = node('button', 'orchestration-progress-open'); open.type = 'button';
      item.dataset.status = task?.status || 'missing';
      const icon = node('i', `agent-icon ${task?.runningProvider || task?.provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true');
      const check = checkOf(task), stale = staleFrom(plan, task), label = task ? `${TASK_LABEL[task.status] || task.status}${check ? ` · ${check.text}` : ''}` : 'Closed';
      if (check) item.dataset.check = check.tone;
      open.append(node('span', 'orchestration-step-number', String(number)), node('span', 'orchestration-step-name', step.title), icon, node('span', 'orchestration-progress-state', label));
      open.title = task?.reason || `Open step ${number}’s task`; open.disabled = !task || busy;
      open.setAttribute('aria-label', `Step ${number}, ${step.title}: ${task ? label : 'closed'}. Open its task.`);
      open.addEventListener('click', () => { if (task) api.setTask(task.id).catch(error => api.showNotice(error.message)); });
      item.append(open);
      if (task?.reason && task.status === 'waiting') item.append(node('span', 'orchestration-progress-reason', task.reason));
      else if (check?.held && check.tone === 'failed') item.append(node('span', 'orchestration-progress-reason', `${check.reason} The steps after it wait. Open the Plan to check it again or continue anyway.`));
      if (stale.length) item.append(node('span', 'orchestration-progress-reason', `Step ${stale.map(id => plan.steps.findIndex(other => other.id === id) + 1).join(' and ')} changed after this step started.`));
      return item;
    }));
    $('orchestration-stop').hidden = !live || plan.status === 'stopped'; $('orchestration-stop').disabled = busy;
    $('orchestration-close').hidden = live; $('orchestration-close').disabled = busy;
    showError(failure);
  }
  function changed(structure = false) { edit.dirty = true; failure = null; if (structure) edit.structure++; render(); }
  // Moving a step keeps focus on the control that moved it.
  function move(index, by, control) {
    const to = index + by; if (to < 0 || to >= edit.steps.length) return;
    const [step] = edit.steps.splice(index, 1); edit.steps.splice(to, 0, step);
    changed(true);
    if (!control) return;
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
  // A step's editor: its text, files and choices. The Plan view's side drawer uses it, on
  // the same draft, and syncDetail keeps its pressed choices and waits current.
  function stepDetail(step, index) {
    const number = index + 1, detail = node('div', 'orchestration-step-detail');
    const title = field('input', 'orchestration-step-title', step.title, `Step ${number} title`, 'What this step does', value => { step.title = value; changed(); }); title.maxLength = LIMITS.title;
    const instructions = field('textarea', 'orchestration-step-instructions', step.instructions, `Step ${number} instructions`, 'What to do, and how to know it is done', value => { step.instructions = value; changed(); });
    instructions.rows = 3; instructions.maxLength = LIMITS.instructions;
    const files = field('input', 'orchestration-step-files', step.files.join(', '), `Files step ${number} expects to change`, 'Files or folders it changes, separated by commas', value => { step.files = value.split(',').map(item => item.trim()).filter(Boolean); changed(); });
    const roles = segment(`Step ${number} role`, 'orchestration-roles');
    for (const [value, text] of ROLES) roles.append(choice('orchestration-role-option', text, 'role', value, () => { step.role = value; changed(); }));
    const tiers = segment(`Step ${number} tier`, 'orchestration-tiers');
    for (const [value, text] of TIERS) tiers.append(choice('orchestration-tier-option', text, 'tier', value, () => { step.tier = value; changed(); }));
    const agents = segment(`Step ${number} agent`, 'orchestration-agents');
    for (const [value, text] of AGENTS) agents.append(choice('orchestration-agent-option', text, 'provider', value, () => { step.agent = value ? { provider: value, model: null, effort: null } : null; changed(); }, `agent-icon ${value || 'auto'}`));
    const artifacts = segment(`Step ${number} artifact`, 'orchestration-artifacts');
    for (const [value, text] of ARTIFACTS) artifacts.append(choice('orchestration-artifact-option', text, 'artifact', value, () => { step.artifact = value || null; changed(); }));
    const check = field('input', 'orchestration-step-check', step.check || '', `Step ${number} acceptance check`, 'Acceptance check command (e.g. npm test)', value => { step.check = value.trim() || null; changed(); }); check.maxLength = 300;
    const after = segment(`Steps that step ${number} waits for`, 'orchestration-afters-choice');
    const options = node('div', 'orchestration-step-options');
    options.append(labelled('Role', roles), labelled('Tier', tiers), labelled('Agent', agents), labelled('Artifact', artifacts), labelled('Check', check), labelled('Runs after', after));
    detail.append(title, instructions, files, options);
    return detail;
  }
  function syncDetail(detail, step, index) {
    for (const button of detail.querySelectorAll('.orchestration-role-option')) button.setAttribute('aria-pressed', String((button.dataset.role || 'builder') === (step.role || 'builder')));
    for (const button of detail.querySelectorAll('.orchestration-tier-option')) button.setAttribute('aria-pressed', String(button.dataset.tier === step.tier));
    for (const button of detail.querySelectorAll('.orchestration-agent-option')) button.setAttribute('aria-pressed', String(button.dataset.provider === (step.agent?.provider || '')));
    for (const button of detail.querySelectorAll('.orchestration-artifact-option')) button.setAttribute('aria-pressed', String((button.dataset.artifact || '') === (step.artifact || '')));
    const afters = detail.querySelector('.orchestration-afters-choice');
    afters.replaceChildren(...edit.steps.slice(0, index).map((earlier, position) => {
      const button = choice('orchestration-after-option', `Step ${position + 1}`, 'step', earlier.id, () => {
        step.dependsOn = step.dependsOn.includes(earlier.id) ? step.dependsOn.filter(id => id !== earlier.id) : [...step.dependsOn, earlier.id]; changed();
      });
      button.title = earlier.title.trim() || 'Untitled step'; button.setAttribute('aria-pressed', String(step.dependsOn.includes(earlier.id)));
      return button;
    }));
    if (!index) afters.append(node('span', 'orchestration-option-none', 'Starts first'));
  }
  function stepRow(step, index) {
    const number = index + 1, row = node('li', 'orchestration-step'), line = node('div', 'orchestration-step-line'), open = opened.ids.has(step.id);
    row.dataset.step = step.id;
    const toggle = node('button', 'orchestration-step-toggle'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(open));
    const detail = stepDetail(step, index); detail.id = `orchestration-step-detail-${step.id}`; detail.hidden = !open; toggle.setAttribute('aria-controls', detail.id);
    toggle.append(
      node('span', 'orchestration-step-number', String(number)),
      node('span', 'orchestration-step-role', roleNames[step.role] || 'Builder'),
      node('span', 'orchestration-step-name'),
      node('span', 'effort-bars orchestration-step-tier'),
      node('span', 'orchestration-step-route')
    );
    toggle.addEventListener('click', () => {
      const show = !opened.ids.has(step.id); if (show) opened.ids.add(step.id); else opened.ids.delete(step.id);
      toggle.setAttribute('aria-expanded', String(show)); detail.hidden = !show;
    });
    const tools = node('div', 'orchestration-step-tools');
    tools.append(iconButton('orchestration-step-up', `Move step ${number} up`, () => move(index, -1, 'up'), index === 0),
      iconButton('orchestration-step-down', `Move step ${number} down`, () => move(index, 1, 'down'), index === edit.steps.length - 1),
      iconButton('orchestration-step-remove', `Remove step ${number}`, () => remove(index)));
    line.append(toggle, node('div', 'orchestration-step-afters'), tools);
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
      const roleBadge = row.querySelector('.orchestration-step-role');
      if (roleBadge) { roleBadge.textContent = roleNames[step.role] || 'Builder'; roleBadge.dataset.role = step.role || 'builder'; }
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
      syncDetail(row.querySelector('.orchestration-step-detail'), step, index);
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
    // Run as tasks, once the plan is saved: the steps start as tasks with the agents shown, and the conversation's access.
    const many = folders().length > 1, ready = !edit.dirty && edit.steps.length > 0 && !problem(edit.steps);
    $('orchestration-run').hidden = !edit.steps.length || edit.dirty;
    $('orchestration-run').disabled = busy || !ready || (many && !$('orchestration-folder').value);
    $('orchestration-folder-option').hidden = !many || edit.dirty || !edit.steps.length;
    if (many) {
      const select = $('orchestration-folder'), current = select.value, key = JSON.stringify(folders().map(folder => folder.id));
      if (select.dataset.key !== key) {
        select.dataset.key = key;
        select.replaceChildren(node('option', '', 'Choose a folder'), ...folders().map(folder => { const option = node('option', '', folder.displayName || folder.name); option.value = folder.id; return option; }));
        select.firstChild.value = ''; select.value = folders().some(folder => folder.id === current) ? current : '';
      }
    }
    const note = $('orchestration-run-note');
    note.hidden = $('orchestration-run').hidden;
    note.textContent = note.hidden ? '' : 'Run as tasks starts each step as its own task, with the agent shown and this conversation’s access. A step waits for the steps it runs after. If other work is using the folder, a step runs in its own copy from the last commit, which you review and merge, or waits when the folder isn’t in Git.';
  }

  function renderCard() {
    const plan = openPlan() || runningPlan(), card = $('orchestration-card'), empty = $('plan-empty');
    // In a task the card waits, with any unsaved changes, for the person to come back to the main conversation.
    if (!onMain()) {
      if (card) card.hidden = true;
      if (empty) empty.hidden = true;
      asking?.(false);
      return;
    }
    if (!plan) {
      if (card) card.hidden = true;
      if (empty) empty.hidden = false;
      edit = null; drawn = null; failure = null; asking?.(false);
      return;
    }
    if (empty) empty.hidden = true;
    if (card) card.hidden = false;
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
    for (const id of ['orchestration-steps', 'orchestration-add', 'orchestration-review-option', 'orchestration-cost']) if ($(id)) $(id).hidden = !draft;
    const running = RUN.includes(plan.status);
    $('orchestration-progress').hidden = !running; $('orchestration-stop').hidden = $('orchestration-close').hidden = !running;
    $('orchestration-run').hidden = $('orchestration-run-note').hidden = $('orchestration-folder-option').hidden = true;
    if (running) {
      $('orchestration-discard').hidden = $('orchestration-again').hidden = $('orchestration-write').hidden = true;
      $('orchestration-save').hidden = $('orchestration-revert').hidden = true;
      edit = null; drawn = null; $('orchestration-steps').replaceChildren();
      renderRun(plan); return;
    }
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
    const signature = JSON.stringify([plan.id, edit.revision, edit.structure, edit.steps.map(step => [step.id, step.role, step.artifact, step.check])]);
    if (signature !== drawn) { drawn = signature; $('orchestration-steps').replaceChildren(...edit.steps.map(stepRow)); }
    refreshDerived(plan);
  }
  function render() {
    const show = available() && !api.isRunning() && !conversation()?.resume;
    $('orchestrate-toggle').hidden = !show;
    $('orchestrate-toggle').setAttribute('aria-pressed', String(armed()));
    $('orchestrate-armed').hidden = !(show && armed());
    const agentOrMode = conversation()?.routing ? `with the deepest work ${modeName()} allows` : `with ${names[state().provider] || state().provider}`;
    $('orchestrate-armed-text').textContent = `Orchestrate: one read-only run drafts cards on the Plan first, ${agentOrMode}. Nothing from them runs until you accept them.`;
    $('orchestrate-write').disabled = busy;
    renderCard();
    window.relayPlanView?.render();
  }
  // The Plan button belongs to the Plan (board.js) since #162.

  $('orchestrate-toggle').addEventListener('click', () => {
    armedFor = armed() ? null : state().projectId;
    render(); api.renderControls();
    api.announce(armed() ? 'Orchestrate is on for this message. One read-only run plans the steps first.' : 'Orchestrate is off.');
  });
  $('orchestrate-off').addEventListener('click', () => { armedFor = null; render(); api.renderControls(); });
  $('orchestrate-write').addEventListener('click', () => writeYourself($('message-input').value));
  // With no plan, the Plan view asks what the plan is for, starting from the message being written.
  $('plan-panel-write')?.addEventListener('click', () => {
    const goal = $('plan-empty-goal');
    if (goal && !goal.value.trim()) { goal.focus(); return; }
    writeYourself(goal ? goal.value : $('message-input')?.value || '');
  });
  $('orchestration-write').addEventListener('click', () => writeYourself(openPlan()?.goal));
  $('orchestration-again').addEventListener('click', planAgain);
  $('orchestration-confirm-yes').addEventListener('click', () => asking?.(true));
  $('orchestration-confirm-no').addEventListener('click', () => asking?.(false));
  $('orchestration-add').addEventListener('click', () => {
    if (!edit || edit.steps.length >= LIMITS.steps) return;
    const next = Math.max(0, ...edit.steps.map(step => Number(step.id.slice(1)) || 0)) + 1, id = `s${next}`;
    edit.steps.push({ id, title: '', instructions: '', files: [], tier: 'standard', dependsOn: [], agent: null, role: 'builder', artifact: null, check: null, skills: [] });
    opened.ids.add(id); changed(true);
    const rows = $('orchestration-steps').children; rows[rows.length - 1]?.querySelector('.orchestration-step-title')?.focus();
  });
  $('orchestration-review').addEventListener('change', () => { if (edit) { edit.review = $('orchestration-review').checked; changed(); } });
  $('orchestration-revert').addEventListener('click', () => { const plan = openPlan(); if (plan) { edit = copy(plan); drawn = null; failure = null; render(); } });
  $('orchestration-save').addEventListener('click', () => {
    if (!edit || $('orchestration-save').disabled) return;
    action({ action: 'update', id: edit.planId, revision: edit.revision, review: edit.review, steps: edit.steps }, () => { edit = null; drawn = null; api.announce('Plan saved.'); });
  });
  $('orchestration-run').addEventListener('click', runPlan);
  $('orchestration-folder').addEventListener('change', () => render());
  $('orchestration-stop').addEventListener('click', () => { const plan = runningPlan(); if (plan) action({ action: 'stop', id: plan.id }, () => api.announce('Plan stopped.')); });
  $('orchestration-close').addEventListener('click', () => { const plan = runningPlan(); if (plan) action({ action: 'close', id: plan.id }, () => api.announce('Plan closed.')); });
  $('orchestration-discard').addEventListener('click', () => { const plan = openPlan(); if (plan) action({ action: 'discard', id: plan.id }, () => { edit = null; api.announce('Plan discarded.'); }); });
  window.addEventListener('relay-state', render);
  window.addEventListener('relay-account', render);
  window.addEventListener('relay-flow', render);

  window.relayOrchestration = {
    armed, render, mayReplace,
    // The plan that holds the queue, for Flow's What's next: one being made or not ready, or one whose drafted cards still
    // wait on the Plan for you (#162).
    waiting: () => {
      if (!onMain()) return null;
      const plan = conversation()?.orchestrations?.[0], drafts = (window.relayBoard?.drafts?.() || []).filter(card => card.draft?.batch?.id === plan?.id).length;
      if (plan?.status === 'moved') return drafts ? { ...plan, drafts } : null;
      return openPlan();
    },
    accepted(projectId) { if (armedFor === projectId) armedFor = null; render(); },
    // How the planner's reply reads in the thread, and the label on the message it planned.
    describe(plan) {
      if (!plan) return '';
      if (plan.status === 'planning') return 'Planning the steps…';
      if (plan.status === 'moved') return `Drafted ${plural(plan.cards?.length || plan.steps?.length || 0, 'card')} on the Plan: ${plan.summary || plan.goal}${plan.questions?.length ? ` It asks: ${plan.questions.join(' ')}` : ''}`;
      if (plan.steps?.length) return `Proposed a plan of ${plural(plan.steps.length, 'step')}: ${plan.summary || plan.goal}`;
      return plan.summary || '';
    },
    label(plan) {
      if (!plan) return 'Orchestrate';
      if (plan.status === 'planning') return 'Orchestrate · planning the steps';
      return plan.steps?.length || plan.status === 'moved' ? 'Orchestrate · planned' : 'Orchestrate · not planned';
    },
    // For the Plan view (plan-view.js): the plan the card shows, drawn from the same draft, and the same edits.
    snapshot() {
      const plan = onMain() ? openPlan() || runningPlan() : null;
      if (!plan) return null;
      const draft = plan.status === 'draft', running = RUN.includes(plan.status), editing = draft && edit?.planId === plan.id;
      return { plan, draft, running, steps: editing ? edit.steps : plan.steps || [], structure: editing ? edit.structure : 0, dirty: Boolean(editing && edit.dirty), busy, tasks: running ? planTasks(plan) : null, title: $('orchestration-title').textContent, status: $('orchestration-status').hidden ? '' : $('orchestration-status').textContent };
    },
    routeText: step => route(step),
    taskLabel: task => task ? TASK_LABEL[task.status] || task.status : 'Closed',
    checkOf, staleFrom: task => { const plan = runningPlan(); return plan ? staleFrom(plan, task) : []; },
    // Check a finished step's tests again, or build on it anyway (#89).
    stepAction(kind, stepId) {
      const plan = runningPlan(); if (!plan) return;
      action({ action: kind, id: plan.id, stepId }, () => api.announce(kind === 'recheck' ? 'Checking the step again.' : 'The steps after it can start.'));
    },
    roleName: role => roleNames[role] || 'Builder',
    tierName: tier => (TIERS.find(([value]) => value === tier) || TIERS[1])[1],
    stepDetail, syncDetail,
    move: (index, by) => { if (edit) move(index, by, null); },
    remove: index => { if (edit) remove(index); },
    openTask: id => api.setTask(id),
    onMain,
    // Whether this is the plan the Plan button opens, for the thread's View plan.
    isCurrent: plan => Boolean(plan && onMain() && (openPlan() || runningPlan())?.id === plan.id),
  };
  render();
})();

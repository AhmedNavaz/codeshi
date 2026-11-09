(() => {
  'use strict';
  const api = window.relayUI;
  if (!api) return;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'flow-button') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const active = run => run && (['starting', 'stopping'].includes(run.status) || run.steps.some(step => ['starting', 'running', 'stopping'].includes(step.session?.status)));
  const states = new Map(), choices = new Map();
  let projectId = null, request = null, pending = false, error = '', timer = null, focusBefore = null;
  const current = () => states.get(projectId) || {};
  const profile = () => current().plan?.profiles.find(profile => profile.id === (choices.get(projectId) || current().run?.profileId)) || current().plan?.profiles[0];
  const changed = () => window.dispatchEvent(new CustomEvent('relay-project-review'));
  const dialog = node('dialog', 'project-review-dialog'); dialog.id = 'project-review-dialog';
  dialog.setAttribute('aria-labelledby', 'project-review-title');
  const head = node('div', 'project-review-head'), title = node('h2', null, 'Run and review your project'); title.id = 'project-review-title';
  const closeButton = button('Close', close); head.append(title, closeButton);
  const intro = node('p', 'project-review-intro', 'Your agent maps how to run your project, whether it is a website, backend, tool or a set of services. Choose a profile to run it and review the result.');
  const content = node('div', 'project-review-content');
  const edit = node('div', 'project-review-edit'), label = node('label', null, 'What should change in this launch flow?');
  label.setAttribute('for', 'project-review-request');
  const input = node('textarea'); input.id = 'project-review-request'; input.rows = 2; input.placeholder = 'For example: use the staging API, or MongoDB is already running locally'; input.maxLength = 2000;
  const ask = button('Ask agent to update', () => configure(input.value));
  edit.append(label, input, ask, node('p', 'project-review-hint', 'Your agent prepares the changes in the background. You can keep working in chat.'));
  dialog.append(head, intro, content, edit); document.body.append(dialog);
  let dialogSignature = '';

  function close() { dialog.close(); if (focusBefore?.isConnected) focusBefore.focus(); }
  function open() { focusBefore = document.activeElement; dialogSignature = ''; renderDialog(); if (!dialog.open) dialog.showModal(); closeButton.focus(); refresh(); }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });

  async function refresh() {
    const scope = projectId;
    if (!scope || request) return;
    request = scope;
    try {
      const value = await api.api('/api/commands/review', {}, scope);
      if (scope !== projectId) return;
      states.set(scope, value); error = '';
    } catch (failure) { if (scope === projectId) error = failure.message; }
    finally { request = null; changed(); if (dialog.open) renderDialog(); if (scope !== projectId) refresh(); }
  }
  async function perform(action) {
    const scope = projectId, value = current(), chosen = profile();
    if (pending || !scope) return;
    pending = true; error = ''; changed(); renderDialog();
    try {
      const run = action === 'start'
        ? await api.post('/api/commands/review/start', { revision: value.plan?.revision, profileId: chosen?.id }, scope)
        : await api.post('/api/commands/review/stop', { runId: value.run?.id }, scope);
      if (scope === projectId) states.set(scope, { ...current(), run });
    } catch (failure) { if (scope === projectId) error = failure.message; }
    finally { pending = false; changed(); if (dialog.open) renderDialog(); refresh(); }
  }
  async function attach(services) {
    const scope = projectId, value = current(), chosen = profile();
    if (pending || !scope || !chosen || !services.length) return;
    pending = true; error = ''; changed(); renderDialog();
    try {
      // Stop whatever partially launched, then relaunch attaching to the services already running on their ports.
      if (active(value.run)) await api.post('/api/commands/review/stop', { runId: value.run?.id }, scope);
      const run = await api.post('/api/commands/review/start', { revision: value.plan?.revision, profileId: chosen.id, adopt: services }, scope);
      if (scope === projectId) states.set(scope, { ...current(), run });
    } catch (failure) { if (scope === projectId) error = failure.message; }
    finally { pending = false; changed(); if (dialog.open) renderDialog(); refresh(); }
  }
  const reassignPrompt = 'One or more services could not start because their ports are already in use on this computer. Update the launch map so each affected service uses an available port, or, if a service is already running locally (for example a database or daemon), list it under prerequisites instead of starting it.';
  const preparing = () => preparationRequests.has(projectId) || ['waiting', 'running'].includes(current().preparation?.status);
  const preparationRequests = new Set(), preparationErrors = new Map();
  async function configure(change = '') {
    const scope = projectId, state = api.getState();
    if (!scope || preparing()) return;
    preparationRequests.add(scope); preparationErrors.delete(scope); changed(); renderDialog();
    try {
      const value = await api.post('/api/commands/review/prepare', {
        change: change.trim(), requestId: crypto.randomUUID(),
        executionRevision: (state.taskId || state.taskDraft ? current().executionRevision : state.conversation?.execution?.defaults?.revision) ?? current().executionRevision ?? 0,
        billingConfirmed: window.relayBillingConfirmed === true,
      }, scope);
      states.set(scope, value);
      if (scope === projectId) { input.value = ''; if (dialog.open) close(); }
    } catch (failure) { preparationErrors.set(scope, failure.message); }
    finally { preparationRequests.delete(scope); changed(); if (dialog.open) renderDialog(); refresh(); }
  }
  async function stopPreparation() {
    const scope = projectId, taskId = current().preparation?.id;
    if (!taskId) return;
    try { const value = await api.post('/api/commands/review/prepare-stop', { taskId }, scope); states.set(scope, value); }
    catch (failure) { if (scope === projectId) error = failure.message; }
    finally { changed(); if (dialog.open) renderDialog(); refresh(); }
  }
  function preparationStatus(host) {
    const value = current().preparation;
    if (preparationErrors.get(projectId)) host.append(node('p', 'project-review-error', preparationErrors.get(projectId)));
    if (preparing()) {
      const indicator = node('p', 'project-review-preparing', value?.status === 'waiting' ? 'Waiting to prepare your project review…' : 'Preparing your project review…');
      indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-live', 'polite'); host.append(indicator);
      if (value?.id) host.append(button('Stop preparing', stopPreparation));
    } else if (value && ['failed', 'stopped', 'blocked', 'detached', 'lost'].includes(value.status)) {
      host.append(node('p', 'project-review-error', value.error || 'Preparation stopped. Try preparing again.'));
    }
    if (value?.approvals) host.append(button('Preparation needs your approval', async () => { if (dialog.open) close(); await api.setTask(value.id); }));
  }
  const words = { waiting: 'Waiting', starting: 'Starting', ready: 'Ready', adopted: 'Attached', done: 'Completed', stopped: 'Stopped', blocked: 'Blocked', failed: 'Failed', stopping: 'Stopping' };
  function serviceMap(chosen, run, detailed = false) {
    const list = node('ol', 'project-review-map');
    for (const id of chosen.order) {
      const service = chosen.services.find(service => service.id === id), step = run?.profileId === chosen.id ? run.steps.find(step => step.id === id) : null;
      const item = node('li', 'project-review-step'); item.dataset.status = step?.status || 'waiting';
      const heading = node('div', 'project-review-step-head');
      heading.append(node('strong', null, service.name), node('span', 'project-review-state', step ? words[step.status] || step.status : service.kind === 'task' ? 'Setup step' : 'Service'));
      item.append(heading, node('span', 'project-review-folder', `${service.folderName}${service.directory ? ' / ' + service.directory : ''}`));
      if (detailed) {
        item.append(node('p', null, service.description));
        if (service.dependsOn.length) item.append(node('p', 'project-review-hint', 'After ' + service.dependsOn.map(id => chosen.services.find(service => service.id === id)?.name || id).join(', ')));
        item.append(node('code', 'project-review-command', service.command));
        if (service.ready) item.append(node('p', 'project-review-hint', `Ready when ${service.ready.url || 'local port ' + service.ready.port} responds`));
        if (step?.session) {
          const log = node('details', 'project-review-log'); log.dataset.service = id;
          log.append(node('summary', null, `Output${step.session.exitCode !== null ? ' · exit ' + step.session.exitCode : ''}`));
          log.append(node('pre', null, (step.session.truncated ? '[Earlier output omitted]\n' : '') + (step.session.output || step.session.error || 'Waiting for output…'))); item.append(log);
        }
      }
      list.append(item);
    }
    return list;
  }
  async function preview(url = current().run?.preview?.url) {
    if (!url) return;
    if (window.relayPreview?.available) await window.relayPreview.open(url);
    else if (window.relayDesktop?.openExternal) window.relayDesktop.openExternal(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }
  function actions(host, detailed = false) {
    const value = current(), run = value.run, chosen = profile(), running = active(run);
    const start = button('Start review', () => perform('start'), 'flow-button flow-primary');
    start.disabled = pending || !chosen || Boolean(value.error || error) || Boolean(running);
    const destinations = run?.previews?.length ? run.previews : run?.preview ? [run.preview] : [];
    for (const destination of destinations) {
      const name = run.steps.find(step => step.id === destination.service)?.name || 'project';
      const text = destinations.length > 1 ? `Open ${name}` : window.relayPreview?.available ? 'Open preview & point' : 'Open preview';
      const launch = button(text, () => preview(destination.url), 'flow-button flow-primary');
      launch.title = window.relayPreview?.available ? `Review ${name} and point at changes` : destination.url;
      host.append(launch);
    }
    host.append(start);
    if (running) { const stop = button('Stop review', () => perform('stop')); stop.disabled = pending || run.status === 'stopping'; host.append(stop); }
    if (run?.conflicts?.length) {
      const box = node('div', 'project-review-conflict'), many = run.conflicts.length > 1;
      box.append(node('strong', null, many ? 'Ports already in use' : 'Port already in use'));
      box.append(node('span', null, `${run.conflicts.map(item => `${item.name} (port ${item.port})`).join(', ')} ${many ? 'are' : 'is'} already serving on this computer, so ${many ? 'those services were' : 'that service was'} not started. Attach to the running server, or choose another port.`));
      const row = node('div', 'project-review-conflict-actions');
      const adoptable = run.conflicts.filter(item => item.adoptable).map(item => item.service);
      if (adoptable.length) { const attachButton = button(adoptable.length > 1 ? 'Attach to running services' : 'Attach to the running service', () => attach(adoptable), 'flow-button flow-primary'); attachButton.disabled = pending; row.append(attachButton); }
      const reassign = button('Use another port', () => configure(reassignPrompt)); reassign.disabled = preparing(); row.append(reassign);
      box.append(row); host.append(box);
    }
    if (run?.error) host.append(button('Ask agent to fix startup', () => configure('Investigate the failed launch using the observations below and correct the map or explain missing prerequisites.')));
    if (!detailed) { const prepare = button(chosen ? 'Launch map' : preparing() ? 'Preparing…' : 'Prepare with agent', chosen ? open : () => configure()); prepare.disabled = !chosen && preparing(); host.append(prepare); }
  }
  function profileChooser() {
    const value = current(), chosen = profile();
    if (value.plan.profiles.length === 1) return node('p', 'project-review-name', chosen.name);
    const label = node('label', 'project-review-profile');
    label.append(node('span', null, 'Setup'));
    const select = node('select'); select.setAttribute('aria-label', 'Launch profile');
    for (const item of value.plan.profiles) { const option = node('option', null, item.name); option.value = item.id; select.append(option); }
    select.value = chosen.id; select.disabled = pending || Boolean(active(value.run));
    select.addEventListener('change', () => { choices.set(projectId, select.value); changed(); renderDialog(); });
    label.append(select); return label;
  }
  function render(card) {
    const value = current(), chosen = profile();
    const signature = JSON.stringify([projectId, chosen, value.run && { ...value.run, steps: value.run.steps.map(({ session, ...step }) => ({ ...step, session: session && { status: session.status, exitCode: session.exitCode } })) }, value.error, error, pending, value.preparation, preparing(), preparationErrors.get(projectId)]);
    if (card.signature === signature) return; card.signature = signature;
    card.body.replaceChildren(); card.foot.replaceChildren();
    const runError = (value.run && value.plan && value.run.revision === value.plan.revision) ? value.run.error : null;
    if (error || value.error || runError) card.body.append(node('p', 'project-review-error', error || value.error || runError));
    if (!chosen) {
      card.body.append(node('p', 'flow-empty', projectId ? 'Let your agent map how to run your website, backend, tool or services. Then run your project and review the result here.' : 'Open a workspace to run and review its project.'));
    } else {
      card.body.append(profileChooser());
      const run = value.run, matches = run?.profileId === chosen.id && run.revision === value.plan.revision;
      const status = matches ? words[run.status] || run.status : 'Ready to start';
      const summary = node('div', 'project-review-summary'); summary.dataset.status = matches ? run.status : 'idle';
      summary.append(node('strong', 'project-review-summary-status', status));
      const count = chosen.services.filter(service => service.kind === 'service').length;
      summary.append(node('span', 'project-review-hint', `${count} service${count === 1 ? '' : 's'} · starts together`));
      card.body.append(summary);

      const serviceList = node('ul', 'project-review-services');
      for (const service of chosen.services) {
        const step = matches ? run.steps.find(s => s.id === service.id) : null;
        const item = node('li', 'project-review-service');
        item.dataset.status = step ? step.status : 'waiting';
        const dot = node('span', 'project-review-service-dot'); dot.setAttribute('aria-hidden', 'true');
        const name = node('span', 'project-review-service-name', service.name);
        const endpoint = service.ready?.url || (service.ready?.port ? ':' + service.ready.port : null);
        if (endpoint) {
          const endpointSpan = node('span', 'project-review-service-endpoint', endpoint.replace(/^http:\/\/(?:127\.0\.0\.1|localhost)/, ''));
          name.append(' ', endpointSpan);
        }
        const isPreview = (chosen.previews || []).some(p => p.service === service.id) || chosen.preview?.service === service.id;
        const tag = node('span', 'project-review-service-tag', step ? (words[step.status] || step.status) : isPreview ? 'Interface' : service.kind === 'task' ? 'Setup' : 'Service');
        item.append(dot, name, tag);
        serviceList.append(item);
      }
      card.body.append(serviceList);

      if (chosen.prerequisites?.length) {
        const prereqs = node('div', 'project-review-prereqs');
        prereqs.append(node('strong', null, 'DB / Prerequisites: '), node('span', null, chosen.prerequisites.join(' · ')));
        card.body.append(prereqs);
      }

      if (matches && run.status === 'starting') {
        const step = run.steps.find(step => step.status === 'starting');
        card.body.append(node('p', 'project-review-hint', step ? `Starting ${step.name}…` : 'Preparing your services…'));
      }
      if (value.run && value.run.revision !== value.plan.revision) card.body.append(node('p', 'project-review-hint', 'Launch map updated. Stop this review to use the new setup.'));
      else card.body.append(node('p', 'project-review-hint', matches && run.status === 'ready' ? 'Choose what to open below. Point at anything you want changed.' : 'Run your project, then open it here to review.'));
    }
    preparationStatus(card.body);
    actions(card.foot);
  }
  function renderDialog() {
    if (!dialog.open && dialogSignature) return;
    const value = current(), chosen = profile(), state = api.getState();
    const last = state.conversation?.messages?.filter(message => message.role === 'assistant' && message.text?.trim()).at(-1);
    const signature = JSON.stringify([projectId, value, error, pending, preparing(), preparationErrors.get(projectId), chosen?.id, api.isRunning(), last?.id]);
    if (dialogSignature === signature) return; dialogSignature = signature;
    const focused = document.activeElement, hadFocus = focused?.closest?.('.project-review-content') === content;
    const focusText = hadFocus && focused.tagName === 'BUTTON' ? focused.textContent : null;
    const focusSelect = hadFocus && focused.tagName === 'SELECT';
    const expanded = new Set([...content.querySelectorAll('details')].filter(detail => detail.open).map(detail => detail.dataset.service));
    const scroll = content.scrollTop;
    content.replaceChildren();
    const runError = (value.run && value.plan && value.run.revision === value.plan.revision) ? value.run.error : null;
    if (error || value.error || runError) content.append(node('p', 'project-review-error', error || value.error || runError));
    if (api.isRunning()) content.append(node('p', 'project-review-hint', 'The agent is still working. This review shows the current project; further edits may appear as it runs.'));
    if (last) { const update = node('div', 'project-review-update'); update.append(node('strong', null, 'Latest agent update'), node('p', null, last.text.slice(0, 500)), button('Read in chat', () => { close(); api.jumpToMessage?.(last.id); })); content.append(update); }
    if (value.run && (!chosen || value.run.revision !== value.plan?.revision)) {
      const snapshot = { id: value.run.profileId, services: value.run.steps, order: value.run.steps.map(step => step.id) };
      content.append(node('h3', null, `Current review · ${value.run.profileName || value.run.profileId}`), serviceMap(snapshot, value.run, true));
    }
    if (!chosen) content.append(node('p', null, 'No saved launch map yet. Ask your agent to prepare one from this project’s files.'));
    else {
      content.append(profileChooser());
      if (chosen.prerequisites?.length) { const requirements = node('ul', 'project-review-hint'); requirements.append(...chosen.prerequisites.map(item => node('li', null, item))); content.append(node('strong', null, 'Prerequisites'), requirements); }
      content.append(serviceMap(chosen, value.run?.revision === value.plan.revision ? value.run : null, true));
      if (chosen.preview) content.append(node('p', 'project-review-hint', 'Review opens ' + chosen.preview.url));
      if (value.run && value.run.revision !== value.plan.revision) content.append(node('p', 'project-review-hint', 'The saved map changed. Stop the current review before starting the new map.'));
    }
    const controls = node('div', 'project-review-actions'); actions(controls, true); content.append(controls);
    content.append(node('p', 'project-review-hint', 'Start review runs the displayed commands on your computer. Opening the preview lets you select an element and attach it to chat. Running the project does not mark tests as passed.'));
    preparationStatus(content);
    ask.disabled = preparing();
    ask.textContent = preparing() ? 'Preparing…' : chosen ? 'Ask agent to update' : 'Ask agent to prepare';
    for (const detail of content.querySelectorAll('details')) if (expanded.has(detail.dataset.service)) detail.open = true;
    if (focusSelect) content.querySelector('select')?.focus({ preventScroll: true });
    else if (focusText) ([...content.querySelectorAll('button')].find(button => button.textContent === focusText && !button.disabled) || closeButton).focus({ preventScroll: true });
    content.scrollTop = scroll;
  }
  function sync() {
    const next = api.getState().projectId;
    if (next !== projectId) { if (dialog.open) close(); input.value = ''; projectId = next; error = ''; dialogSignature = ''; changed(); refresh(); }
    if (dialog.open) renderDialog();
  }
  window.addEventListener('relay-state', sync);
  window.addEventListener('relay-flow', () => { if (!window.relayFlow?.isOn() && dialog.open) close(); refresh(); });
  function poll() { clearTimeout(timer); if (!document.hidden && projectId && (window.relayFlow?.isOn() || dialog.open || active(current().run))) refresh(); timer = setTimeout(poll, 2000); }
  window.relayProjectReview = { render, open, refresh, label: () => preparing() ? 'Preparing project review…' : current().run?.status === 'ready' ? 'Project ready to review' : 'Run and review your project' };
  sync(); poll();
})();

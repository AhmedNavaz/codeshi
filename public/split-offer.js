// A message Flow found separate parts in (#107 stage 2, #108). Nothing has started: the card above the message box shows
// each part, the agent and model routing would pick for it now and what that agent is billed to. Run them as tasks side
// by side, do the message as one, or put it back in the message box. The parts become cards on the Plan when they run.
(() => {
  const $ = id => document.getElementById(id), api = window.relayUI, section = $('split-offer');
  if (!section || !api) return;
  const NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const EFFORT = value => value ? `${value[0].toUpperCase()}${value.slice(1)}` : '';
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  let busy = false, shown = null;

  const proposal = () => { const state = api.getState(); return state.taskId || state.taskDraft ? null : state.conversation?.splitProposal || null; };
  const folders = () => { const state = api.getState(), project = state.projects?.find(item => item.id === state.projectId); return Array.isArray(project?.folders) ? project.folders : []; };
  const pickText = pick => {
    if (!pick || pick.error) return pick?.error ? 'No agent available' : 'Chosen when it starts';
    const model = pick.model ? window.relayModelPicker?.modelName?.(pick.provider, pick.model) || pick.modelName || pick.model : 'default model';
    return [NAMES[pick.provider] || pick.provider, model, EFFORT(pick.effort)].filter(Boolean).join(' · ');
  };
  const billingText = pick => !pick || pick.error ? '' : pick.billing === 'subscription' ? 'Subscription' : pick.billing === 'api' ? 'Bills by use' : 'Billing not confirmed';

  function draw() {
    const offer = proposal();
    section.hidden = !offer;
    if (!offer) { shown = null; return; }
    const fresh = shown !== offer.id;
    shown = offer.id;
    const parts = offer.parts || [], charged = parts.filter(part => part.pick && !part.pick.error && part.pick.billing !== 'subscription').length;
    const allowApi = api.getState().conversation?.routing?.allowApi === true, missing = parts.findIndex(part => !part.pick || part.pick.error);
    $('split-title').textContent = `Flow suggests ${parts.length} tasks side by side`;
    $('split-message').textContent = offer.request?.text || '';
    const list = $('split-parts');
    list.replaceChildren(...parts.map((part, index) => {
      const row = node('li', 'split-part'), pick = part.pick || {};
      const head = node('div', 'split-part-head');
      head.append(node('span', 'split-part-number', String(index + 1)), node('span', 'split-part-title', part.title));
      if (part.dependsOn?.length) head.append(node('span', 'split-part-after', `after ${part.dependsOn.join(' and ')}`));
      const who = node('div', 'split-part-who');
      const icon = node('i', `agent-icon ${pick.provider && !pick.error ? pick.provider : 'auto'}`); icon.setAttribute('aria-hidden', 'true');
      who.append(icon, node('span', 'split-part-agent', pickText(pick)));
      const bill = billingText(pick);
      if (bill) who.append(node('span', `split-part-billing ${pick.billing === 'subscription' ? 'subscription' : 'charged'}`, bill));
      if (pick.error) who.append(node('span', 'split-part-error', pick.error));
      row.append(head, who);
      row.title = part.instructions;
      return row;
    }));
    // Charges are their own yes, unless API billing is already allowed for routing.
    $('split-billing').hidden = !charged || allowApi;
    if (!$('split-billing').hidden) $('split-billing-text').textContent = `Accept charges: ${charged === 1 ? 'one part uses an agent' : `${charged} parts use agents`} that ${charged === 1 ? 'bills' : 'bill'} by use, or whose billing couldn’t be confirmed.`;
    if (fresh) { $('split-billing-confirm').checked = false; $('split-auto').checked = api.getState().conversation?.splitPreference?.auto === true; }
    const list$ = folders(), pickFolder = $('split-folder');
    $('split-folder-row').hidden = list$.length < 2;
    if (list$.length > 1 && (fresh || pickFolder.options.length !== list$.length)) {
      pickFolder.replaceChildren(...list$.map(folder => { const option = node('option', '', folder.displayName || folder.name); option.value = folder.id; return option; }));
      pickFolder.value = api.selectedFolderId?.() || list$[0].id;
    }
    $('split-note').textContent = `Each part becomes a card on the Plan and runs as its own task, ${parts.some(part => part.dependsOn?.length) ? 'waiting for the parts it needs, ' : ''}with this chat’s access. They share this message’s task limits, and each waits for you to review it. Routing picks each agent again when it starts.`;
    const run = $('split-run');
    run.textContent = busy === 'tasks' ? 'Starting…' : `Run as ${parts.length} tasks`;
    run.disabled = Boolean(busy) || missing >= 0 || (charged > 0 && !allowApi && !$('split-billing-confirm').checked);
    $('split-one').textContent = busy === 'one' ? 'Starting…' : 'Do it as one';
    $('split-one').disabled = Boolean(busy) || api.isRunning?.();
    $('split-dismiss').disabled = Boolean(busy);
  }

  async function answer(action) {
    const offer = proposal(), state = api.getState(), id = state.conversation?.id, projectId = state.projectId;
    if (!offer || !id || busy) return;
    busy = action; draw();
    try {
      const body = { id: offer.id, action, ...(action === 'tasks' ? { billingConfirmed: $('split-billing-confirm').checked, folderId: folders().length > 1 ? $('split-folder').value : null } : {}) };
      const result = await api.post(`/api/conversations/${id}/split`, body, projectId);
      // Put away: the message goes back in the message box, as it was sent.
      if (action === 'dismiss' && result?.text) {
        const input = $('message-input');
        if (input) { input.value = input.value.trim() ? `${result.text}\n${input.value}` : result.text; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
      }
      if (action === 'tasks') api.announce?.(`Running ${offer.parts.length} tasks side by side. They’re on the Plan as “${result?.group || 'a new group'}”.`);
      if (action === 'one') api.announce?.('Running it as one message.');
    } catch (error) { api.showNotice?.(error.message); }
    finally { busy = false; await api.refresh?.(); draw(); }
  }

  async function prefer(auto) {
    const state = api.getState(), id = state.conversation?.id;
    if (!id) return;
    try { await api.post(`/api/conversations/${id}/split-preference`, { auto }, state.projectId); await api.refresh?.(); }
    catch (error) { $('split-auto').checked = !auto; api.showNotice?.(error.message); }
  }

  $('split-run').addEventListener('click', () => answer('tasks'));
  $('split-one').addEventListener('click', () => answer('one'));
  $('split-dismiss').addEventListener('click', () => answer('dismiss'));
  $('split-billing-confirm').addEventListener('change', draw);
  $('split-auto').addEventListener('change', event => prefer(event.target.checked));
  window.addEventListener('relay-state', draw);
  window.relaySplitOffer = { draw, open: () => Boolean(proposal()) };
  draw();
})();

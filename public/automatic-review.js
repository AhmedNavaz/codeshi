(() => {
  'use strict';
  const { t } = window.codeshiText;
  const $ = id => document.getElementById(id), api = window.relayUI, dialog = $('automatic-review-dialog');
  const name = provider => ({ codex: 'Codex', claude: 'Claude', gemini: 'Gemini' })[provider] || provider;
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  let armed = null, preview = null, scope = null, generation = 0, busy = false;
  const selected = new Set();
  const selection = () => {
    const state = api.getState(), text = $('message-input').value.trim(), attachments = window.relayFiles?.ids() || [];
    const routed = api.routeFor(text, attachments.length);
    if (routed?.error) throw Error(routed.error);
    return { text, attachments, provider: routed?.provider || state.provider, model: (routed ? routed.model : state.model) || null, mode: state.mode, approvalPolicy: state.approvalPolicy || 'ask' };
  };
  const key = value => {
    const state = api.getState(), folders = state.projects.find(project => project.id === state.projectId)?.folders || [];
    return JSON.stringify([state.projectId, value.text, value.attachments || [], value.provider, value.model || null, value.mode, value.approvalPolicy, folders.map(folder => [folder.id, folder.path]), state.conversation?.context || null, state.localSelections[state.projectId] || null]);
  };
  const error = message => { $('automatic-review-error').textContent = message; $('automatic-review-error').hidden = !message; };
  const account = () => api.getState().accounts?.[preview?.reviewer];
  const needsBilling = () => account()?.billingSource !== 'subscription';
  const unavailable = () => account()?.authenticated === false || account()?.installed === false || api.getState().status?.providers?.[preview?.reviewer]?.available === false;
  function valid() { try { return armed && armed.key === key(selection()); } catch { return false; } }
  function controls() {
    $('automatic-review-enable').disabled = busy || !preview || !selected.size || unavailable() || needsBilling() && !$('automatic-review-billing').checked;
    for (const input of $('automatic-review-folders').querySelectorAll('input')) input.disabled = busy || input.dataset.unavailable === 'true';
    $('automatic-review-billing').disabled = busy;
  }
  function render() {
    const state = api.getState();
    if (armed && armed.projectId !== state.projectId) armed = null;
    if (dialog.open && scope !== state.projectId) { generation++; dialog.close(); }
    const unsupported = !state.ready || !state.projectId || Boolean(state.taskDraft || state.taskId) || api.isRunning() || state.pending || state.projectSaving || state.settingsPending || state.mode !== 'edit' || state.conversation?.resume || Boolean(state.localSelections[state.projectId]);
    $('automatic-review-toggle').disabled = Boolean(unsupported);
    $('automatic-review-toggle').setAttribute('aria-pressed', String(Boolean(armed)));
    $('automatic-review-toggle').textContent = armed ? t('Review after · On') : t('Review after');
    $('automatic-review-armed').hidden = !armed;
    if (armed) {
      const current = valid();
      $('automatic-review-armed').dataset.stale = String(!current);
      $('automatic-review-armed-text').textContent = current
        ? `${name(armed.plan.builder)} builds → ${name(armed.plan.reviewer)} reviews · This prompt only`
        : 'Prompt or settings changed. Confirm the review again before sending.';
    }
    const latest = state.conversation?.runs?.findLast(run => run.automaticReview);
    $('automatic-review-status').hidden = !latest;
    if (latest) {
      const phase = latest.automaticReview, labels = { building: 'Build → review · Builder working', reviewing: 'Build → review · Reviewing saved changes', complete: 'Build → review · Review complete', 'needs-fixes': 'Build → review · Findings ready', blocked: 'Build → review · Needs attention', interrupted: 'Build → review · Stopped', skipped: 'Build → review · No changes to review' };
      $('automatic-review-status').dataset.status = phase.status;
      $('automatic-review-status-text').textContent = phase.summary || labels[phase.status] || 'Build → review';
      $('automatic-review-view').hidden = !phase.reviewId;
      $('automatic-review-view').dataset.reviewId = phase.reviewId || '';
    }
    if (dialog.open) controls();
  }
  async function refreshPreview() {
    const token = ++generation, value = selection(), projectId = scope;
    preview = null; busy = true; error(''); controls();
    try {
      const result = await api.post('/api/reviews/automatic/preview', { ...value, folderIds: [...selected] }, projectId);
      if (token !== generation || projectId !== api.getState().projectId || !dialog.open) return;
      preview = result;
      $('automatic-review-pair').textContent = `${name(result.builder)}${result.builderModel ? ` · ${result.builderModel}` : ''} → ${name(result.reviewer)}${result.model ? ` · ${result.model}` : ' · Provider default'}`;
      $('automatic-review-usage').textContent = unavailable() ? `Connect ${name(result.reviewer)} in Settings before enabling review.` : `One additional ${name(result.reviewer)} run uses your own account${needsBilling() ? '' : ' and plan allowance'}. The reviewer reads a saved copy; it cannot change your working files.`;
      $('automatic-review-billing-label').hidden = !needsBilling();
      $('automatic-review-billing-text').textContent = `I approve this ${name(result.reviewer)} review using ${account()?.billingSource === 'api' ? 'API billing' : 'an unverified billing source'}. Additional charges may apply.`;
      preview.uiKey = key(value);
    } catch (e) { if (token === generation && projectId === api.getState().projectId) error(e.message); }
    finally { if (token === generation) { busy = false; controls(); } }
  }
  async function open() {
    const state = api.getState();
    if ($('automatic-review-toggle').disabled || document.querySelector('dialog[open]')) return;
    let value;
    try { value = selection(); if (!value.text) throw Error('Write the task first, then choose who reviews it.'); }
    catch (e) { api.showNotice(e.message); return; }
    scope = state.projectId; const token = ++generation; preview = null; busy = true; selected.clear(); error('');
    $('automatic-review-pair').textContent = 'Preparing the builder and reviewer…';
    $('automatic-review-usage').textContent = '';
    $('automatic-review-folders').replaceChildren(); $('automatic-review-billing').checked = false; $('automatic-review-billing-label').hidden = true;
    dialog.showModal(); controls();
    try {
      const result = await api.api('/api/reviews', {}, scope);
      if (token !== generation || scope !== api.getState().projectId || !dialog.open) return;
      for (const repo of result.repositories || []) {
        const label = node('label', undefined, 'review-check'), input = node('input'); input.type = 'checkbox'; input.value = repo.folderId; input.dataset.unavailable = String(!repo.available);
        input.checked = repo.available && (!armed || armed.plan.folderIds.includes(repo.folderId));
        if (input.checked) selected.add(repo.folderId);
        input.addEventListener('change', () => { if (input.checked) selected.add(repo.folderId); else selected.delete(repo.folderId); $('automatic-review-billing').checked = false; refreshPreview(); });
        label.append(input, node('span', `${repo.name}${repo.available ? '' : ` · ${repo.error || 'Attach a Git repository root'}`}`));
        $('automatic-review-folders').append(label);
      }
      if (!selected.size) { busy = false; error('Choose an attached Git repository root to review.'); controls(); return; }
      await refreshPreview();
    } catch (e) { if (token === generation) { busy = false; error(e.message); controls(); } }
  }
  $('automatic-review-toggle').addEventListener('click', open);
  $('automatic-review-change').addEventListener('click', open);
  $('automatic-review-remove').addEventListener('click', () => { armed = null; render(); });
  for (const id of ['automatic-review-close', 'automatic-review-cancel']) $(id).addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { generation++; busy = false; preview = null; });
  $('automatic-review-billing').addEventListener('change', controls);
  $('automatic-review-enable').addEventListener('click', () => {
    if ($('automatic-review-enable').disabled || !preview) return;
    if (preview.uiKey !== key(selection())) { error('The prompt or settings changed. Close and confirm the review again.'); return; }
    const plan = { ...preview }; delete plan.uiKey;
    armed = { projectId: scope, key: preview.uiKey, plan, billingConfirmed: needsBilling() && $('automatic-review-billing').checked };
    dialog.close(); render(); api.announce('Review is enabled for this prompt only. Send when ready.');
  });
  $('automatic-review-view').addEventListener('click', () => window.relayReviews?.open($('automatic-review-view').dataset.reviewId));
  $('message-input').addEventListener('input', render);
  window.addEventListener('relay-state', render);
  window.addEventListener('relay-account', render);
  window.relayAutomaticReview = {
    open, render,
    submission(value, { continuing = false, queued = false } = {}) {
      if (!armed) return null;
      if (continuing || queued || api.getState().localSelections[api.getState().projectId]) throw Error('Automatic review is enabled for the drafted prompt only. Remove it before continuing, queueing or using a local model.');
      if (armed.key !== key(value)) throw Error('The prompt or settings changed. Confirm Review after again, or remove it before sending.');
      return { approvedDigest: armed.plan.approvedDigest, folderIds: armed.plan.folderIds, reviewer: armed.plan.reviewer, model: armed.plan.model || null, billingConfirmed: armed.billingConfirmed };
    },
    accepted(projectId, submitted) { if (armed?.projectId === projectId && submitted?.approvedDigest === armed.plan.approvedDigest) armed = null; render(); },
  };
  render();
})();

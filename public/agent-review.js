(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI, dialog = $('review-dialog');
  const name = provider => provider === 'gemini' ? 'Gemini' : provider === 'claude' ? 'Claude Code' : 'Codex';
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const button = (text, callback, cls = 'secondary-button') => { const value = node('button', text, cls); value.type = 'button'; value.addEventListener('click', callback); return value; };
  const resultHome = $('review-result').parentNode;
  let panelOpen = false;
  function closePanel() { panelOpen = false; $('review-panel').hidden = true; resultHome.append($('review-result')); }
  function showPanel() { panelOpen = true; window.relayTimeline?.close(); window.relayAgents?.close(); window.relayBrief?.close(); window.relayTasks?.close(); $('review-panel').hidden = false; $('git-panel').hidden = true; $('open-git').setAttribute('aria-expanded', 'false'); $('review-panel-body').append($('review-result')); $('review-result').hidden = false; if (dialog.open) dialog.close(); }
  $('close-review-panel')?.addEventListener('click', closePanel);
  const selected = new Map(), findings = new Set(), freshness = new Map();
  let scope = null, taskScope = null, generation = 0, busy = false, data = null, snapshot = null, report = null, mode = 'new', requestId = null, checking = false;
  // Opened in a task (#88), a review covers only that task's folder or copy, and is saved with the task.
  const current = () => scope === api.getState().projectId && taskScope === (api.getState().taskId || null);
  const scoped = (path, task = taskScope) => task ? `${path}${path.includes('?') ? '&' : '?'}task=${encodeURIComponent(task)}` : path;
  // A task that has started and still has its folder or copy can be reviewed; a blank task or one that ended can't.
  const ENDED = ['integrated', 'kept', 'discarded', 'cancelled', 'lost', 'detached'];
  const reviewableTask = state => !state.taskDraft && (!state.taskId || Boolean(state.conversation?.id && state.conversation.task && state.conversation.task.purpose !== 'project-review' && !ENDED.includes(state.conversation.task.status)));
  // A task in its own copy: its files aren't the ones the editor opens, so a finding names its place without a link.
  const inCopy = () => data?.task?.mode === 'worktree';
  const active = () => api.isRunning() || Boolean(api.getState().pending || api.getState().projectSaving);
  const reviewer = () => (current() && data?.reviewer) || ((api.getState().conversation?.lastBuilder || api.getState().provider) === 'claude' ? 'codex' : 'claude');
  const account = () => api.getState().accounts?.[reviewer()];
  const needsBilling = () => account()?.billingSource !== 'subscription';
  const unavailable = () => account()?.authenticated === false || account()?.installed === false || api.getState().status?.providers?.[reviewer()]?.available === false;
  function rememberFreshness(value) {
    freshness.set(value.id, { stale: value.stale, staleReason: value.staleReason });
    if (freshness.size > 50) freshness.delete(freshness.keys().next().value);
  }
  function error(message) { for (const id of ['review-error','review-panel-error']) { $(id).textContent = message; $(id).hidden = !message; } }
  function controls() {
    const provider = reviewer();
    $('review-selection-count').textContent = `${selected.size} / ${data?.limits?.files || 12} selected`;
    $('preview-review').disabled = busy || active() || !selected.size;
    $('review-goal').disabled = busy;
    $('review-billing').disabled = busy;
    $('review-billing-label').hidden = !needsBilling();
    $('review-billing-text').textContent = `I approve this ${name(provider)} review using ${account()?.billingSource === 'api' ? 'API billing' : 'an unverified billing source'}. Additional charges may apply.`;
    $('review-account').textContent = unavailable() ? `${name(provider)} needs to be connected in Settings before reviewing.` : `Read-only review using your ${name(provider)} account${account()?.billingSource === 'subscription' ? ' and plan allowance' : ''}. Model: ${data?.reviewerModel || 'Provider default'}. Starting a review consumes additional usage.`;
    $('start-review').textContent = busy ? 'Please wait…' : `Start read-only review with ${name(provider)}`;
    $('start-review').disabled = busy || active() || !snapshot || !$('review-goal').value.trim() || unavailable() || (needsBilling() && !$('review-billing').checked);
    $('review-new-tab').disabled = busy || active();
    $('review-result-tab').disabled = busy || !(report || data?.reviews?.length);
    const fix = $('prepare-review-fix');
    if (fix) fix.disabled = busy || active() || !findings.size || report?.stale || report?.status !== 'complete';
    for (const checkbox of $('review-files').querySelectorAll('input')) checkbox.disabled = busy || Boolean(checkbox.dataset.reason);
    for (const checkbox of $('review-result').querySelectorAll('input')) checkbox.disabled = busy || report?.stale || report?.status !== 'complete';
  }
  async function perform(action) {
    if (busy) return;
    const token = generation; busy = true; error(''); controls();
    try { await action(token); } catch (e) { if (token === generation && current()) error(e.message || 'The review could not be completed. Please try again.'); }
    finally { if (token === generation) { busy = false; controls(); } }
  }
  function tab(value) {
    mode = value; $('review-new').hidden = mode !== 'new'; $('review-result').hidden = mode !== 'result';
    $('review-new-tab').setAttribute('aria-pressed', String(mode === 'new')); $('review-result-tab').setAttribute('aria-pressed', String(mode === 'result')); error('');
  }
  function invalidate() { snapshot = null; requestId = null; $('review-preview').hidden = true; controls(); }
  function renderFiles() {
    const host = $('review-files'); host.replaceChildren();
    let offered = 0;
    for (const repo of data?.repositories || []) {
      host.append(node('div', repo.name, 'review-repository'));
      if (!repo.available) { host.append(node('p', repo.error || 'No Git repository in this folder.', 'review-empty')); continue; }
      if (!repo.totalChanges) host.append(node('p', 'No uncommitted changes.', 'review-empty'));
      for (const file of repo.changes) {
        const label = node('label', undefined, 'review-check'), check = node('input'); check.type = 'checkbox'; check.dataset.reason = file.reason || '';
        check.checked = selected.has(repo.folderId + ':' + file.path);
        check.disabled = Boolean(file.reason); check.setAttribute('aria-label', `${repo.name} / ${file.path}`);
        const key = repo.folderId + ':' + file.path;
        check.addEventListener('change', () => {
          if (check.checked && selected.size >= (data?.limits?.files || 12)) { check.checked = false; error('Select up to 12 files for each review.'); return; }
          if (check.checked) selected.set(key, { folderId: repo.folderId, path: file.path }); else selected.delete(key);
          invalidate();
        });
        label.append(check, node('span', `${file.path}  ·  ${file.reason || (file.code === '??' ? 'New' : file.code.trim())}`)); host.append(label); offered++;
      }
      if (repo.changesClipped) host.append(node('p', 'Showing the first 100 changes. Narrow the working changes before reviewing more files.', 'review-empty'));
    }
    if (!offered && !data?.repositories?.length) host.append(node('p', 'Attach a Git repository root to this workspace to review its current changes.', 'review-empty'));
  }
  function showSnapshot(value, host) {
    host.replaceChildren(node('p', `${value.files.length} file${value.files.length === 1 ? '' : 's'} · these exact changes will be reviewed`, 'review-hint'));
    for (const file of value.files) { const detail = node('details'); detail.append(node('summary', `${file.folderName} / ${file.path}`), node('pre', file.diff)); host.append(detail); }
    host.hidden = false;
  }
  function renderReport() {
    const host = $('review-result'); host.replaceChildren();
    if (!report) { host.append(node('p', 'No review yet. Choose changes to get a second opinion.', 'review-empty')); return; }
    $('review-panel-hint').textContent = report.status === 'running' ? 'Reviewing a saved snapshot. You can send your next prompt.' : report.stale ? 'The working files changed after this snapshot. Start a fresh review before preparing fixes.' : report.status === 'complete' ? 'Review complete. Select findings to draft the next fix.' : 'Review needs attention. Your project conversation is unchanged.';
    const titles = { running: 'Review in progress', complete: report.findings.length ? `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'} to consider` : 'No actionable findings reported', unstructured: 'Review response needs attention', failed: 'Review did not finish', interrupted: 'Review interrupted' };
    const heading = node('div', undefined, 'review-result-heading'); heading.append(node('h3', titles[report.status] || 'Code review'));
    if (report.status === 'running') heading.append(button('Stop review', () => perform(async () => { await api.post(report.background ? scoped(`/api/reviews/${report.id}/stop`) : `/api/conversations/${api.getState().conversation.id}/stop`, {}, scope); if (current()) await api.refresh(); })));
    host.append(heading, node('p', `${report.builderConnection === 'local' ? 'Local · ' + (report.builderModel || 'Ollama') : name(report.builder)} → ${name(report.provider)} · Read only · ${new Date(report.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`, 'review-result-meta'));
    host.append(node('p', `Goal: ${report.goal}`, 'review-result-summary'));
    if (report.stale) host.append(node('p', `Outdated review. ${report.staleReason} Run a new review before preparing fixes.`, 'review-stale'));
    if (report.summary) host.append(node('p', report.summary, 'review-result-summary'));
    if (report.status === 'running' && report.progress) host.append(node('p', `${({reasoning:'Checking the changes',tool:'Inspecting snapshot files',responding:'Writing findings'})[report.progress.phase] || 'Reviewing snapshot'} · ${report.progress.toolCount || 0} tool calls`, 'review-result-meta'));
    if (report.status === 'running') host.append(node('p', 'The reviewer is checking the approved file snapshot. You can send your next prompt; later edits may make these findings outdated.', 'review-hint'));
    for (const finding of report.findings) {
      const article = node('article', undefined, 'review-finding'), check = node('input'), body = node('div'), title = node('label', finding.title, 'review-finding-title');
      check.type = 'checkbox'; check.id = `review-finding-${finding.id}`; check.checked = findings.has(finding.id); check.disabled = report.stale || report.status !== 'complete'; title.setAttribute('for', check.id);
      check.setAttribute('aria-label', `Prepare fix: ${finding.title}`); check.addEventListener('change', () => { if (check.checked) findings.add(finding.id); else findings.delete(finding.id); controls(); });
      const severity = node('span', finding.severity, 'review-severity'); severity.dataset.severity = finding.severity;
      body.append(severity, title, node('p', finding.detail));
      const file = report.snapshot?.files?.find(file => file.folderId === finding.folderId && file.path === finding.path), location = `${file?.folderName || ''} / ${finding.path}${finding.line ? ':' + finding.line : ' (deleted)'}`;
      body.append(finding.line && window.relayFiles?.openAt && !inCopy() ? button(location, () => { dialog.close(); window.relayFiles.openAt(finding.folderId, finding.path, finding.line); }, 'text-link') : node('span', location, 'review-result-meta'));
      article.append(check, body); host.append(article);
    }
    if (report.findings.length) {
      host.append(node('p', 'Choose findings to draft a fix request. It’s added to the message box after anything already there, for you to edit and send; your current access mode is preserved.', 'review-hint'));
      const actions = node('div', undefined, 'review-actions'), fix = button(`Prepare fixes with ${name(report.builder)}`, () => perform(prepareFix), 'primary-button'); fix.id = 'prepare-review-fix'; actions.append(fix); host.append(actions);
    }
    if (report.snapshot) { const details = node('details', undefined, 'review-scope'), content = node('div'); details.append(node('summary', `Reviewed scope · ${report.snapshot.files.length} file${report.snapshot.files.length === 1 ? '' : 's'}`)); showSnapshot(report.snapshot, content); details.append(content); host.append(details); }
    const raw = report.rawResponse || api.getState().conversation?.messages.filter(message => message.role === 'assistant' && message.reviewId === report.id).at(-1)?.text;
    if (raw) { const details = node('details', undefined, 'review-raw'); details.append(node('summary', 'Agent response'), node('pre', raw)); host.append(details); }
    controls();
  }
  async function loadReport(id, token = generation) {
    const value = await api.api(scoped('/api/reviews/' + encodeURIComponent(id)), {}, scope);
    if (token !== generation || !current()) return;
    if (report?.id !== value.id) findings.clear();
    report = value; rememberFreshness(value); renderReport(); renderStrip();
  }
  async function prepareFix(token) {
    const state = api.getState(), projectId = scope, conversationId = state.conversation.id, input = $('message-input');
    const result = await api.post(scoped('/api/reviews/' + report.id + '/prepare-fix'), { findingIds: [...findings] }, projectId);
    if (token !== generation || !current()) return;
    await api.post(`/api/conversations/${conversationId}/provider`, { provider: result.provider, mode: state.mode }, projectId);
    if (token !== generation || !current()) return;
    await api.refresh();
    if (token !== generation || !current()) return;
    if (!current()) return;
    // Whatever is in the box by now stays, attachments too, with the fix request after it. Nothing is sent from here.
    const kept = input.value.trimEnd(), had = Boolean(kept);
    if (!kept.endsWith(result.text)) input.value = had ? `${kept}\n\n${result.text}` : result.text;
    input.dispatchEvent(new Event('input', { bubbles: true })); dialog.close(); input.focus(); input.setSelectionRange?.(input.value.length, input.value.length); api.renderControls(); api.announce(had ? 'The fix request was added after your message. Review it and press Send when ready.' : 'Review findings are ready in the message box. Review the request and press Send when ready.');
  }
  async function open(id, { suggested = false } = {}) {
    const state = api.getState();
    if (!state.projectId || (document.querySelector('dialog[open]') && !dialog.open)) return;
    const running = state.conversation?.reviews?.find(item => item.background && item.status === 'running');
    if (!id && running) { id = running.id; suggested = false; }
    if (!reviewableTask(state)) return;
    closePanel();
    scope = state.projectId; taskScope = state.taskId || null; generation++; busy = false; data = snapshot = report = null; selected.clear(); findings.clear(); requestId = null;
    $('review-goal').value = ''; $('review-billing').checked = false; $('review-preview').hidden = true; $('review-files').replaceChildren(node('p', 'Reading local changes…', 'review-empty')); $('review-pair').textContent = ''; $('review-result').replaceChildren(node('p', 'Loading review…', 'review-empty'));
    tab(id ? 'result' : 'new'); if (!dialog.open) dialog.showModal();
    await perform(async token => {
      const result = await api.api(scoped('/api/reviews'), {}, scope); if (token !== generation || !current()) return;
      data = result; $('review-goal').value = result.goal; $('review-pair').textContent = `${result.builderConnection === 'local' ? 'Local · ' + (result.builderModel || 'Ollama') : name(result.builder)} builds  →  ${name(result.reviewer)} reviews${result.task ? `  ·  “${result.task.title}”, ${result.task.mode === 'worktree' ? 'its own copy' : result.task.folderName}` : ''}`;
      if (suggested) for (const repo of result.repositories || []) for (const file of repo.changes || []) if (repo.available && !file.reason && selected.size < (result.limits?.files || 12)) selected.set(repo.folderId + ':' + file.path, { folderId: repo.folderId, path: file.path });
      renderFiles();
      if (suggested && selected.size) { const preview = await api.post(scoped('/api/reviews/preview'), { files: [...selected.values()] }, scope); if (token !== generation || !current()) return; snapshot = preview.snapshot; showSnapshot(snapshot, $('review-preview')); controls(); }
      if (id || result.reviews.length && active()) { tab('result'); await loadReport(id || result.reviews[0].id, token); } else renderReport();
    });
    if (id && report?.background && current()) showPanel();
  }
  function renderStrip() {
    const state = api.getState(), latest = state.conversation?.reviews?.[0], known = latest && freshness.get(latest.id);
    $('open-review').disabled = !state.ready || active() || !reviewableTask(state); $('open-review').title = state.taskId ? `Review this task’s changes with ${name(reviewer())}` : `Review changes with ${name(reviewer())}`;
    $('review-summary').hidden = !latest || !reviewableTask(state);
    if (latest) { $('review-summary').dataset.stale = String(Boolean(known?.stale)); $('review-summary-text').textContent = `${name(latest.provider)} review · ${known?.stale ? 'Outdated' : latest.status === 'running' ? 'In progress' : latest.status === 'complete' ? `${latest.findings.length} finding${latest.findings.length === 1 ? '' : 's'}` : 'Needs attention'}`; }
  }
  $('open-review').addEventListener('click', () => open());
  $('view-review').addEventListener('click', () => open(api.getState().conversation?.reviews?.[0]?.id));
  $('close-review').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { generation++; busy = false; });
  $('review-new-tab').addEventListener('click', () => { if (!active()) open(); });
  $('review-result-tab').addEventListener('click', () => { tab('result'); perform(token => loadReport(report?.id || data.reviews[0].id, token)); });
  $('review-goal').addEventListener('input', () => { requestId = null; controls(); }); $('review-billing').addEventListener('change', controls);
  $('preview-review').addEventListener('click', () => perform(async token => {
    const result = await api.post(scoped('/api/reviews/preview'), { files: [...selected.values()] }, scope); if (token !== generation || !current()) return;
    snapshot = result.snapshot; requestId = crypto.randomUUID(); showSnapshot(snapshot, $('review-preview'));
  }));
  $('start-review').addEventListener('click', () => perform(async token => {
    if (!snapshot || !$('review-goal').value.trim() || unavailable() || (needsBilling() && !$('review-billing').checked)) return;
    const result = await api.post(scoped('/api/reviews/start'), { files: [...selected.values()], goal: $('review-goal').value.trim(), approvedDigest: snapshot.digest, requestId: requestId ||= crypto.randomUUID(), billingConfirmed: needsBilling() && $('review-billing').checked, background: true }, scope);
    if (token !== generation || !current()) return;
    tab('result'); await api.refresh(); if (current()) await loadReport(result.reviewId, token);
    if (current() && result.background) showPanel();
  }));
  window.addEventListener('relay-state', () => {
    if (panelOpen && !current()) { closePanel(); generation++; busy = false; }
    if (dialog.open && !current()) { dialog.close(); generation++; busy = false; }
    renderStrip();
    const latest = api.getState().conversation?.reviews?.[0];
    if ((dialog.open || panelOpen) && mode === 'result' && report && latest?.id === report.id && (latest.status !== report.status || JSON.stringify(latest.progress) !== JSON.stringify(report.progress)) && !busy) perform(token => loadReport(report.id, token));
    if (dialog.open || panelOpen) controls();
  });
  async function checkFreshness() {
    const state = api.getState(), latest = state.conversation?.reviews?.[0]; if (document.hidden || !latest || checking || latest.status === 'running') return;
    const projectId = state.projectId, task = state.taskId || null; checking = true;
    try { const value = await api.api(scoped('/api/reviews/' + latest.id, task), {}, projectId); if (projectId !== api.getState().projectId || task !== (api.getState().taskId || null)) return; rememberFreshness(value); if ((dialog.open || panelOpen) && mode === 'result' && report?.id === value.id && !busy && report.stale !== value.stale) { report = value; renderReport(); } renderStrip(); }
    catch { /* Actions recheck scope on the server; unavailable files never authorize a fix. */ }
    finally { checking = false; }
  }
  window.addEventListener('focus', checkFreshness); setInterval(checkFreshness, 15000);
  window.relayReviews = { open, closePanel, suggest: () => open(null, { suggested: true }) }; renderStrip();
})();

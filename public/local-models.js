(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI, dialog = $('local-dialog');
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  const defaultTask = 'Continue the unfinished task from this shared conversation. Inspect current files and saved activity first, then finish what remains.';
  let scope = null, revision = 0, catalog = null, loading = false, busy = false, request = null, previousFocus = null;
  const drafts = new Map();
  function error(message = '') { $('local-error').textContent = message; $('local-error').hidden = !message; }
  function controls() {
    const state = api.getState(), unavailable = !state.ready || state.loading || state.pending || state.settingsPending || api.isRunning();
    $('open-local').disabled = Boolean(unavailable || !state.projectId); $('continue-locally').disabled = Boolean(unavailable);
    $('continue-locally').hidden = $('continuation').hidden;
    $('local-start').disabled = Boolean(loading || busy || unavailable || !catalog?.installed || !catalog.models?.some(item => item.id === $('local-model').value) || !$('local-task').value.trim());
    $('local-start').textContent = busy ? 'Starting…' : 'Continue locally';
    $('local-model').disabled = Boolean(loading || busy); $('local-refresh').disabled = Boolean(loading || busy); $('local-task').disabled = busy; $('local-close').disabled = busy;
    $('local-start').setAttribute('aria-busy', String(busy));
  }
  function modelDetails() {
    const model = catalog?.models?.find(item => item.id === $('local-model').value);
    $('local-model-detail').textContent = model ? [model.parameterSize, model.contextWindow ? `${Math.round(model.contextWindow / 1024)}K supported context` : 'Context size not reported', 'Downloaded · no cloud model charges'].filter(Boolean).join(' · ') : 'Only downloaded models with coding tools are listed. Cloud models are excluded.';
    request = null; controls();
  }
  async function refresh() {
    const current = ++revision, selected = $('local-model').value, projectId = scope;
    loading = true; error(); $('local-status').textContent = 'Checking Ollama and downloaded models…'; controls();
    try {
      const result = await api.api('/api/local-models', {}, projectId);
      if (current !== revision || projectId !== scope || projectId !== api.getState().projectId) return;
      catalog = result; request = null; $('local-model').replaceChildren();
      const placeholder = node('option', result.models.length ? 'Choose a local model' : 'No compatible local models'); placeholder.value = ''; $('local-model').append(placeholder);
      for (const model of result.models) { const option = node('option', model.id); option.value = model.id; $('local-model').append(option); }
      $('local-model').value = result.models.some(item => item.id === selected) ? selected : '';
      $('local-status').textContent = !result.installed ? 'Install Codex CLI to provide the workspace tools. A ChatGPT login is not needed for local runs.' : result.models.length ? `${result.models.length} local model${result.models.length === 1 ? '' : 's'} available. Inference runs through Ollama on this computer.` : 'Pull a tool-capable coding model in Ollama, then refresh. Models without verified local weights or tools are excluded.';
      $('local-context').textContent = `${result.context?.mode === 'read' ? 'Read only' : 'Can edit files'} · Current workspace folders, project brief and bounded recent conversation. Images are not sent in this text-only handoff.`;
      modelDetails();
    } catch (e) { if (current === revision && projectId === scope) { catalog = null; $('local-status').textContent = 'Local connection is not ready.'; error(e.message); } }
    finally { if (current === revision) { loading = false; controls(); } }
  }
  async function open() {
    const state = api.getState(); if (!state.projectId || !state.ready || api.isRunning() || state.pending || state.settingsPending || document.querySelector('dialog[open]')) return false;
    previousFocus = document.activeElement; scope = state.projectId; catalog = null; request = null;
    $('local-task').value = drafts.get(scope) || $('message-input').value.trim() || defaultTask;
    $('local-model').replaceChildren(); $('local-context').textContent = 'Loading workspace context…'; error(); dialog.showModal(); $('local-title').focus(); await refresh(); return true;
  }
  async function start() {
    if ($('local-start').disabled || busy || scope !== api.getState().projectId) return;
    const model = catalog.models.find(item => item.id === $('local-model').value), task = $('local-task').value.trim(), projectId = scope;
    const key = JSON.stringify([projectId, catalog.context, model.id, model.digest, task]);
    if (request?.key !== key) request = { key, id: crypto.randomUUID() };
    busy = true; error(); controls();
    try {
      await api.post('/api/local-models/start', { model: model.id, digest: model.digest, task, requestId: request.id, context: catalog.context }, projectId);
      drafts.set(projectId, task); request = null;
      if (projectId === api.getState().projectId) { await api.refresh(); dialog.close(); api.announce('The local model is working.'); }
      await api.refreshProjects();
    } catch (e) { if (projectId === scope) { error(e.message); await api.refresh(); } }
    finally { busy = false; controls(); }
  }
  $('open-local').addEventListener('click', open); $('continue-locally').addEventListener('click', open);
  $('local-refresh').addEventListener('click', refresh); $('local-model').addEventListener('change', modelDetails);
  $('local-task').addEventListener('input', () => { request = null; controls(); }); $('local-start').addEventListener('click', start);
  $('local-close').addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (scope) drafts.set(scope, $('local-task').value); ++revision; loading = false; previousFocus?.focus(); });
  $('local-setup-guide').addEventListener('click', () => {
    const url = 'https://github.com/AhmedNavaz/codeshi/blob/main/docs/guide.md#local-models';
    const opened = window.relayDesktop ? window.relayDesktop.openExternal(url) : Promise.resolve(window.open(url, '_blank', 'noopener,noreferrer'));
    opened.catch(e => error(e.message));
  });
  window.addEventListener('relay-state', () => { if (dialog.open && scope !== api.getState().projectId) dialog.close(); controls(); });
  window.relayLocal = { open }; controls();
})();

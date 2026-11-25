(() => {
  'use strict';
  // Task limits (#87) and task usage export without prompts (#84, #190). Limits live in Settings › Routing & handoffs
  // (and open from inline budget prompts), and exporting task usage lives in Settings › General.
  const $ = id => document.getElementById(id), api = window.relayUI, dialog = $('limits-dialog');
  if (!api || !dialog) return;
  const AGENTS = [['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini'], ['local', 'Local models']];
  const FIELDS = [['maxConcurrent', 'Tasks at once'], ['maxWorkingMinutes', 'Working minutes', 'No limit'], ['maxTokens', 'New tokens', 'No limit'], ['maxSpendUSD', 'API spend, USD', 'No limit'], ['maxHandoffs', 'Handoffs'], ['maxRetries', 'Retries'], ['maxReviews', 'Reviews'], ['maxRepeatedFailures', 'Same failure']];
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const conversation = () => api.getState().conversation;
  let budget = null, budgetScope = null;

  const scope = () => { const state = api.getState(), c = state.conversation; return c ? `${state.projectId}:${c.id}:${c.taskBudgetRevision || 0}` : null; };

  // Limits: one set for a whole task, in a dialog, since they are set rarely.
  function buildLimitsForm() {
    const fields = $('limits-fields');
    for (const [key, name, empty] of FIELDS) {
      const label = node('label', 'limit-field'), input = node('input');
      input.id = `limit-${key}`; input.type = 'number'; input.min = key === 'maxRepeatedFailures' ? '1' : '0'; input.step = key === 'maxSpendUSD' ? '0.5' : '1'; if (empty) input.placeholder = empty;
      label.append(node('span', '', name), input); fields.append(label);
    }
    const agentsHost = $('limits-agents');
    for (const [key, name] of AGENTS) {
      const label = node('label', 'limit-agent'), box = node('input');
      box.id = `limit-agent-${key}`; box.type = 'checkbox';
      label.append(box, node('span', '', name)); agentsHost.append(label);
    }
    const modelsHost = $('limits-models');
    for (const [key, name] of AGENTS) {
      const label = node('label', 'limit-field'), input = node('input');
      input.id = `limit-models-${key}`; input.type = 'text'; input.placeholder = 'All models';
      label.append(node('span', '', `${name} models`), input); modelsHost.append(label);
    }
  }
  function fillLimitsForm() {
    const policy = budget?.policy || {};
    for (const [key] of FIELDS) $(`limit-${key}`).value = policy[key] ?? '';
    for (const [key] of AGENTS) $(`limit-agent-${key}`).checked = !policy.allowedProviders || policy.allowedProviders.includes(key);
    for (const [key] of AGENTS) $(`limit-models-${key}`).value = (policy.allowedModels?.[key] || []).join(', ');
    $('limits-error').hidden = true;
  }
  async function openLimits() {
    const currentScope = scope();
    if (!budget || budgetScope !== currentScope) {
      try { budget = await api.api('/api/budget'); budgetScope = currentScope; }
      catch (error) { api.showNotice(error.message); return; }
    }
    fillLimitsForm();
    dialog.showModal();
  }
  $('limits-form').addEventListener('submit', async event => {
    event.preventDefault();
    const c = conversation(); if (!c) return;
    const policy = {};
    for (const [key, , empty] of FIELDS) { const raw = String($(`limit-${key}`).value).trim(); if (raw === '' && !empty) continue; policy[key] = raw === '' ? null : Number(raw); }
    const allowed = AGENTS.map(([key]) => key).filter(key => $(`limit-agent-${key}`).checked);
    policy.allowedProviders = allowed.length === AGENTS.length ? null : allowed;
    const models = {};
    for (const [key] of AGENTS) {
      const values = [...new Set(String($(`limit-models-${key}`).value || '').split(/[,\s]+/).filter(Boolean))];
      if (values.length) models[key] = values;
    }
    policy.allowedModels = Object.keys(models).length ? models : null;
    try { budget = await api.post(`/api/conversations/${c.id}/budget`, { action: 'policy', policy }); budgetScope = scope(); dialog.close(); await api.refresh(); }
    catch (error) { $('limits-error').textContent = error.message; $('limits-error').hidden = false; }
  });
  $('limits-cancel').addEventListener('click', () => dialog.close());

  async function extend(taskId, limit) {
    const c = conversation(); if (!c) return false;
    budget = await api.post(`/api/conversations/${c.id}/budget`, { action: 'extend', taskId, limit });
    budgetScope = scope();
    return true;
  }
  async function reset(taskId) {
    const c = conversation(); if (!c) return false;
    budget = await api.post(`/api/conversations/${c.id}/budget`, { action: 'reset', taskId });
    budgetScope = scope();
    return true;
  }
  async function exportUsage() {
    try {
      // Without prompts or commands, so it can be shared as it is.
      const data = await api.api('/api/ledger'), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), link = document.createElement('a');
      link.href = url; link.download = 'codeshi-task-usage.json'; document.body?.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { api.showNotice(error.message); }
  }

  window.addEventListener('relay-state', () => {
    const next = scope();
    if (next !== budgetScope) { budget = null; budgetScope = null; }
  });
  buildLimitsForm();
  window.relayLimits = { open: openLimits, extend, reset, exportUsage };
})();

(() => {
  'use strict';
  // Suggestions (#106): at a pause after a run, one line above the message box pointing to a feature that fits what just
  // happened. The server works it out from this conversation with local rules. The line shares its place with the usage
  // notice and never shows over a run, an approval, a question or a task draft. Trying one opens the step that shows what
  // will change; nothing is changed from the line itself.
  const $ = id => document.getElementById(id), api = window.relayUI, line = $('tip-line');
  if (!api || !line) return;
  let on = true, tip = null, scope = null, request = 0, confirming = false, usageShown = false, marked = null;

  const paused = () => {
    const state = api.getState(), c = state.conversation;
    return Boolean(c) && !state.taskDraft && !api.isRunning() && !c.resume && !c.handoffOffer && !c.pendingApprovals?.length && c.lastRun?.status === 'complete';
  };
  const scopeOf = () => { const state = api.getState(), c = state.conversation; return c ? `${state.projectId}:${c.id}:${c.lastRun?.id || ''}:${c.status}` : null; };

  async function load(force = false) {
    const next = scopeOf();
    if (!next || (!force && next === scope)) { render(); return; }
    scope = next; confirming = false;
    const mine = ++request;
    try { const result = await api.api('/api/suggestion'); if (mine !== request) return; on = result.on !== false; tip = result.tip || null; }
    catch { if (mine === request) tip = null; }
    render(); api.renderControls?.();
  }
  async function post(input) {
    const mine = ++request;
    const result = await api.post('/api/suggestion', input);
    if (mine === request) { on = result.on !== false; tip = result.tip || null; }
  }

  function render() {
    const flowTip = tip?.kind === 'flow';
    const visible = on && Boolean(tip) && paused() && !usageShown && !(flowTip && window.relayFlow?.isOn?.());
    line.hidden = !visible;
    if (!visible) { confirming = false; return; }
    // Counted once it is actually on screen, for the daily limit.
    const id = `${tip.key}:${tip.runId}`;
    if (marked !== id) { marked = id; api.post('/api/suggestion', { action: 'shown', key: tip.key, runId: tip.runId }).catch(() => {}); }
    const action = $('tip-action'), cancel = $('tip-cancel');
    if (confirming) {
      $('tip-text').textContent = 'Flow turns on for this workspace. Codeshi then chooses the agent, model and effort for each message, in Smart mode unless you chose another mode before. Leave Flow in the header brings your own choices back.';
      action.textContent = 'Turn on Flow'; action.dataset.confirm = ''; cancel.hidden = false;
    } else {
      $('tip-text').textContent = tip.text;
      action.textContent = tip.action; delete action.dataset.confirm; cancel.hidden = true;
    }
    action.disabled = !api.getState().ready || Boolean(api.getState().pending) || (flowTip && window.relayFlow?.isLocked?.());
  }

  // Each way of trying one opens a step that shows what will change: the memory or skill dialog, or Flow's confirmation.
  const afterDialog = dialog => dialog?.addEventListener('close', () => load(true), { once: true });
  $('tip-action').addEventListener('click', () => {
    if (!tip) return;
    if (tip.kind === 'memory' && window.relayMemory) { window.relayMemory.open(null, { text: tip.memory.text, kind: tip.memory.kind, messageId: tip.memory.messageId }); afterDialog($('memory-dialog')); return; }
    if (tip.kind === 'skill' && window.relaySkills) { window.relaySkills.fromSteps(tip.skill); afterDialog($('skill-dialog')); return; }
    if (tip.kind === 'flow') {
      if (!confirming) { confirming = true; render(); return; }
      confirming = false;
      if (window.relayFlow?.enter?.() !== false) { tip = null; render(); }
    }
  });
  $('tip-cancel').addEventListener('click', () => { confirming = false; render(); });
  $('tip-dismiss').addEventListener('click', async () => {
    if (!tip) return;
    const key = tip.key;
    tip = null; render();
    try { await post({ action: 'dismiss', key }); render(); api.announce?.('Codeshi won’t suggest that again.'); }
    catch (error) { api.showNotice(error.message); }
  });

  window.addEventListener('relay-state', () => load());
  window.addEventListener('relay-flow', render);
  window.relaySuggestions = {
    enabled: () => on,
    // The usage notice goes first: while it shows, the suggestion waits.
    usage(shown) { if (usageShown === shown) return; usageShown = shown; render(); },
    async setEnabled(value) { const result = await api.post('/api/preferences', { suggestions: value }); on = result.suggestions !== false; await load(true); api.renderControls?.(); return on; },
  };
})();

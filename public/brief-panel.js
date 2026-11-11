(() => {
  'use strict';
  // The Brief panel: what every agent is told when it starts on a task (#85), and the two things you add to it,
  // memory (#21) and skills (#86). The top shows what the next agent would get right now, worked out on this computer
  // with no model, and See the full brief opens it in full. Memory and skills have their own modules under this panel.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('brief-panel');
  if (!api || !panel) return;
  const PANEL_KEY = 'throughline:side-panel';
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
  const read = () => { try { return localStorage.getItem(PANEL_KEY) || 'agents'; } catch { return 'agents'; } };
  const remember = value => { try { localStorage.setItem(PANEL_KEY, value); } catch { /* A convenience only. */ } };
  let preview = null, shown = null, loading = 0;

  // One row per part of the brief, always the same rows, so it is clear what a brief can hold even when a part is empty.
  function renderComposition() {
    const brief = preview?.brief || {}, metadata = preview?.metadata || {}, host = $('brief-composition');
    const instructions = [...new Set((brief.repositoryInstructions || []).map(item => item.path))], remembered = window.relayMemory?.activeCount?.() ?? null;
    const skills = brief.skills || {}, active = skills.active?.length || 0, available = skills.available?.length || 0, used = brief.memory?.length || 0;
    const rows = [
      ['history', 'Memory', remembered === null ? (used ? plural(used, 'entry').replace('entrys', 'entries') : 'None yet') : remembered === 0 ? 'None yet' : used === remembered ? `All ${plural(remembered, 'entry').replace('entrys', 'entries')}` : `${used} of ${remembered} apply`],
      ['auto', 'Skills', active + available ? `${active + available} enabled${active ? `, ${active} in use` : ''}` : 'None enabled'],
      ['file', 'Instructions', instructions.length ? instructions.join(', ') : 'None found'],
      ['pencil', 'Changed files', brief.changedFiles?.length ? String(brief.changedFiles.length) : 'None'],
      ['alert', 'Went wrong', brief.failedAttempts?.length ? plural(brief.failedAttempts.length, 'attempt') : 'Nothing'],
      ['check', 'Steps left', brief.unfinishedPlan?.length ? String(brief.unfinishedPlan.filter(step => step.status !== 'done').length) : 'No plan'],
      ['clock', 'Earlier chat', brief.earlier ? `${plural(brief.earlier.requests.length, 'request')}${brief.earlier.decisions?.length ? `, ${plural(brief.earlier.decisions.length, 'decision')}` : ''} folded` : 'Sent word for word'],
    ];
    if (brief.scope?.otherFolders?.length) rows.unshift(['folder', 'Folders', `${brief.scope.folders.join(', ')} (not ${brief.scope.otherFolders.join(', ')})`]);
    host.replaceChildren(...rows.flatMap(([icon, name, value]) => { const mark = node('span', 'brief-item-icon'); mark.dataset.icon = icon; mark.setAttribute('aria-hidden', 'true'); return [mark, node('span', 'brief-item-name', name), node('span', 'brief-item-value', value)]; }));
    $('brief-size').textContent = metadata.size ? `≈${Math.round(metadata.size.estimatedTokens / 100) / 10}k tokens (estimate)` : '';
    $('brief-view').hidden = !preview?.brief;
  }
  const scope = () => { const state = api.getState(), c = state.conversation; return c ? `${state.projectId}:${c.id}:${c.lastRun?.id || ''}:${c.status}` : null; };
  async function load(force = false) {
    const key = scope();
    if (panel.hidden || !key || (!force && key === shown)) return;
    shown = key;
    const request = ++loading;
    try { const next = await api.api('/api/conversation/brief'); if (request === loading) { preview = next; renderComposition(); } }
    catch (error) { if (request === loading) { shown = null; $('brief-composition').replaceChildren(node('p', 'panel-empty', error.message)); } }
    const note = $('brief-note');
    if (document.activeElement !== note) note.value = api.getState().conversation?.context?.summary || '';
  }

  // The full brief, readable: each part as a list, in the order the agent gets it.
  function viewBrief() {
    const brief = preview?.brief || {}, body = $('brief-dialog-body'), folders = brief.scope?.folders || [];
    const section = (title, items, empty = 'Nothing', stacked = false) => {
      const block = node('section', 'brief-block');
      block.append(node('h3', 'brief-block-title', title));
      if (!items.length) { block.append(node('p', 'panel-empty', empty)); return block; }
      const list = node('ul', 'brief-block-list');
      for (const item of items) { const row = node('li', `brief-block-row${stacked ? ' stacked' : ''}`); if (typeof item === 'string') row.textContent = item; else { row.append(node('span', 'brief-block-main', item.main)); if (item.aside) row.append(node('span', 'brief-block-aside', item.aside)); } list.append(row); }
      block.append(list);
      return block;
    };
    // The rolling brief: older requests folded to a line each, with what came of them, and where the fold came from.
    const earlierSection = earlier => {
      const block = section('Earlier in this conversation', (earlier?.requests || []).slice().reverse().map(item => ({ main: item.text, aside: [item.inContext ? 'also sent in full' : '', item.repeated ? `sent ${item.repeated} times` : '', item.outcome ? `${item.outcome.status === 'error' ? 'stopped' : 'reply'}: ${item.outcome.text}` : 'no reply recorded'].filter(Boolean).join(' · ') })), 'Sent word for word; nothing folded', true);
      if (!earlier) return block;
      const day = value => value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null, span = [day(earlier.folded.fromAt), day(earlier.folded.toAt)].filter(Boolean);
      const why = earlier.trigger.reason === 'context-refresh' ? 'the context refresh keeps only the latest exchanges' : `the earlier conversation is ${Math.round(earlier.trigger.historyBytes / 1000).toLocaleString()} KB, over the ${Math.round(earlier.trigger.allowanceBytes / 1000)} KB it can take`;
      block.append(node('p', 'panel-muted', `${plural(earlier.folded.messages, 'message')}${span.length ? ` from ${[...new Set(span)].join(' to ')}` : ''} folded without a model, because ${why}.${earlier.requestsLeftOut ? ` ${plural(earlier.requestsLeftOut, 'older request')} left out.` : ''} The originals stay in the conversation's journal.`));
      return block;
    };
    const KINDS = { convention: 'Convention', decision: 'Decision', solution: 'Working fix', 'failed-approach': 'Failed approach' };
    const WAITING = { question: 'question', command: 'command approval', files: 'file change approval', access: 'access approval', connector: 'connector approval', tool: 'approval' };
    body.replaceChildren(
      section('Folders in scope', folders.map(name => ({ main: name })).concat((brief.scope?.otherFolders || []).map(name => ({ main: name, aside: 'left out, still available' }))), 'The whole workspace'),
      section('Repository instructions', (brief.repositoryInstructions || []).map(item => ({ main: `${item.folder}/${item.path}`, aside: item.truncated ? 'excerpt; full file remains available' : item.text ? 'sent in full' : item.loadedByAgent ? 'the agent loads it itself' : item.delivered ? 'already has it' : item.sameAsAbove ? 'same as above' : 'named' })), 'No AGENTS.md, CLAUDE.md or GEMINI.md in these folders'),
      section('Current file evidence', (brief.relevantFiles || []).map(item => ({ main: `${item.folder}/${item.path}${item.lines ? ':' + item.lines.join('–') : ''}`, aside: `${item.reason} · re-read from disk${item.sha256 ? ' · ' + item.sha256.slice(0, 12) : ''}` })), 'No additional files retrieved'),
      section('Changed since the last run', [...(brief.changedSinceLastRun || []).map(item => ({ main: `${item.folder}/${item.path}`, aside: item.missing ? 'missing; earlier evidence needs recheck' : 'changed; earlier evidence needs recheck' })), ...(brief.repositoryChanged || []).map(item => ({ main: item.folder, aside: 'Git base or branch changed' }))], 'No changes detected in previously referenced files'),
      section('Memory', (brief.memory || []).map(item => ({ main: item.text, aside: `${KINDS[item.kind] || item.kind}${item.needsRecheck ? ' · needs recheck' : ''}` })), 'Nothing remembered applies to this task'),
      section('Skills', [...(brief.skills?.active || []).map(item => ({ main: item.name, aside: `in use: ${item.reason}` })), ...(brief.skills?.available || []).map(item => ({ main: item.name, aside: 'available' }))], 'No skills enabled'),
      section('Changed so far', (brief.changedFiles || []).map(item => ({ main: `${item.folder}/${item.path}`, aside: item.missing ? 'missing' : item.status || '' })), 'No files changed in this task'),
      section('Went wrong before', (brief.failedAttempts || []).map(item => ({ main: item.what, aside: `${item.how}${item.times ? ` · ${item.times}×` : ''}` })), 'Nothing recorded', true),
      section('The plan so far', (brief.unfinishedPlan || []).map(item => ({ main: item.text, aside: { done: 'Done', active: 'In progress', pending: 'To do' }[item.status] || item.status })), 'No plan carried over'),
      earlierSection(brief.earlier),
      ...(brief.earlier?.decisions?.length ? [section('Decisions made earlier', brief.earlier.decisions.map(item => ({ main: item.text, aside: item.source === 'user-answer' ? 'your answer to a question' : 'your words' })), 'None', true)] : []),
      ...(brief.unansweredQuestions?.length ? [section('Questions nobody answered', brief.unansweredQuestions.map(item => ({ main: item.question, aside: item.agent ? `asked by ${item.agent}` : '' })), 'None', true)] : []),
      ...(brief.stoppedWhileWaiting?.requests?.length ? [section('Waiting when the last run ended', brief.stoppedWhileWaiting.requests.map(item => ({ main: item.kind === 'question' ? item.questions.join(' · ') : item.what, aside: `${WAITING[item.kind] || 'approval'}${brief.stoppedWhileWaiting.agent ? ` · ${brief.stoppedWhileWaiting.agent}` : ''} · never answered` })), 'None', true)] : []),
      ...(preview?.milestone ? [section('Memory for the fresh session', preview.milestone.observations.map(item => ({ main: item.text, aside: `${item.type} · ${item.source}${item.messageId ? ' · message ' + item.messageId : ''}` })), 'Current goals, user requests and project memory will be carried into the fresh session', true)] : []),
    );
    const note = node('p', 'panel-muted brief-dialog-note', `${$('brief-size').textContent ? $('brief-size').textContent + '. ' : ''}${brief.note ? 'Everything here is marked as evidence for the agent to check; your requests take priority over all of it.' : ''}`.trim());
    body.append(note);
    $('brief-dialog').showModal();
  }
  $('brief-view').addEventListener('click', viewBrief);
  $('brief-dialog-close').addEventListener('click', () => $('brief-dialog').close());
  $('brief-copy').addEventListener('click', () => { navigator.clipboard?.writeText?.(JSON.stringify(preview?.brief || {}, null, 2)); $('brief-copy').textContent = 'Copied'; setTimeout(() => { $('brief-copy').textContent = 'Copy as JSON'; }, 1500); });
  $('brief-save').addEventListener('click', async () => {
    const c = api.getState().conversation;
    if (!c) return;
    try { await api.post(`/api/conversations/${c.id}/context`, { summary: $('brief-note').value }); await api.refresh(); load(true); $('brief-saved').hidden = false; setTimeout(() => { $('brief-saved').hidden = true; }, 2000); }
    catch (error) { api.showNotice(error.message); }
  });

  // One side panel shows at a time; which one is remembered, so a workspace reopens on it.
  function setOpen(open, section = null, keep = true) {
    panel.hidden = !open;
    if (keep) remember(open ? 'brief' : 'none');
    if (open) {
      window.relayAgents?.close(); window.relayGit?.close(); window.relayReviews?.closePanel?.(); window.relayTimeline?.close(); window.relayTasks?.close();
      load();
      if (section) { const target = $(`brief-${section}`); target?.scrollIntoView?.({ block: 'start' }); target?.classList.add('flash'); setTimeout(() => target?.classList.remove('flash'), 1200); }
    }
    window.dispatchEvent(new CustomEvent('relay-side-panel'));
  }
  let lastProject = null;
  window.addEventListener('relay-state', () => {
    const projectId = api.getState().projectId;
    if (projectId !== lastProject) {
      lastProject = projectId;
      if (!projectId) setOpen(false, null, false);
      else if (panel.hidden && read() === 'brief' && window.matchMedia?.('(min-width: 1101px)').matches) setOpen(true, null, false);
    }
    load();
  });
  window.relayBrief = { open: section => setOpen(true, section), close: () => { if (!panel.hidden) setOpen(false, null, false); }, toggle: () => setOpen(panel.hidden), isOpen: () => !panel.hidden, reload: () => load(true), rerender: () => { if (preview) renderComposition(); } };
})();

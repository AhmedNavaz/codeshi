(() => {
  'use strict';
  const { t } = window.codeshiText;
  // "While you were away" (#22). Coming back to Codeshi after two minutes or more, a short recap shows what ran,
  // what changed and what is waiting in every workspace, if anything happened. It is put together from what
  // Codeshi recorded, with no agent call. Read aloud speaks it with voice mode's speech (#11); it can also be read
  // on its own when you come back. The search bar's "While you were away" shows it at any time.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('recap');
  if (!api || !panel) return;
  const KEY = 'throughline:recap', AWAY = 2 * 60 * 1000;
  const defaults = { show: true, speak: false };
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const load = () => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...defaults }; } };
  let prefs = load(), awaySince = null, lastAway = null, current = null, settingsHost = null, settingsKit = null;
  const openedAt = Date.now();
  const save = patch => { prefs = { ...prefs, ...patch }; try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* A preference for this device only. */ } };

  const agents = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const agent = run => run.local ? 'The local model' : agents[run.provider] || 'An agent';
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const join = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  const base = file => String(file).split('/').pop();
  function span(ms) {
    const minutes = Math.round(ms / 60000);
    if (!Number.isFinite(minutes) || minutes < 1) return 'under a minute';
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
  }
  const time = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });

  // One line per run: who, how it ended, what it was asked, then what it did.
  function runLine(run) {
    const verb = run.status === 'running' ? 'is working on' : run.status === 'complete' ? 'finished' : run.errorCategory === 'quota' ? 'stopped at a usage limit on' : 'stopped on';
    const did = [];
    if (run.endedAt && run.status !== 'running') did.push(span(Date.parse(run.endedAt) - Date.parse(run.startedAt)));
    if (run.fileCount) did.push(run.fileCount <= 3 ? `changed ${join(run.files.map(base))}` : `changed ${plural(run.fileCount, 'file')}`);
    if (run.tests) did.push('ran the tests'); else if (run.commands) did.push(`ran ${plural(run.commands, 'command')}`);
    return { kind: run.status === 'running' ? 'working' : run.status === 'complete' ? 'done' : 'stopped', text: `${agent(run)} ${verb} “${run.prompt || 'a task'}”`, detail: did.join(' · ') };
  }
  const changed = item => item.fileCount ? (item.fileCount <= 3 ? `changed ${join(item.files.map(base))}` : `changed ${plural(item.fileCount, 'file')}`) : '';
  // A task beside the main conversation (#88): who, how it stands, and what's left for you.
  function taskLine(task) {
    const who = agents[task.provider] || 'An agent';
    const verb = task.status === 'running' ? 'is working on' : task.status === 'complete' ? 'finished' : task.status === 'failed' ? 'didn’t finish' : task.status === 'waiting' ? 'is waiting to start' : 'stopped on';
    const did = [changed(task), task.check === 'failed' ? 'tests failed' : task.check === 'passed' ? 'tests passed' : '', task.unmerged ? 'ready for you to merge' : '', task.approvals ? `${plural(task.approvals, 'approval')} waiting` : ''].filter(Boolean);
    return { kind: task.approvals ? 'approval' : task.status === 'running' ? 'working' : task.status === 'complete' ? 'done' : task.status === 'waiting' ? 'waiting' : 'stopped', text: `${who} ${verb} the task “${task.title}” in ${task.folder}`, detail: did.join(' · ') };
  }
  // A plan's steps fold into one line: how far it got, then what's working and what needs you.
  function planLine(plan) {
    const working = plan.steps.filter(step => step.status === 'running'), failed = plan.steps.filter(step => step.check === 'failed');
    const unmerged = plan.steps.filter(step => step.unmerged).length, approvals = plan.steps.reduce((sum, step) => sum + step.approvals, 0);
    const stopped = plan.steps.filter(step => ['stopped', 'failed'].includes(step.status));
    const steps = list => join(list.map(step => String(step.number)));
    const did = [
      working.length ? `step${working.length === 1 ? '' : 's'} ${steps(working)} working` : '',
      failed.length ? `tests failed on step${failed.length === 1 ? '' : 's'} ${steps(failed)}, so the steps after ${failed.length === 1 ? 'it' : 'them'} wait` : '',
      stopped.length ? `step${stopped.length === 1 ? '' : 's'} ${steps(stopped)} stopped` : '',
      unmerged ? `${plural(unmerged, 'step')} ready for you to merge` : '',
      approvals ? `${plural(approvals, 'approval')} waiting` : '',
    ].filter(Boolean);
    const kind = approvals || failed.length ? 'approval' : working.length ? 'working' : plan.done === plan.total ? 'done' : stopped.length ? 'stopped' : 'waiting';
    return { kind, text: `The plan “${plan.goal}” has ${plan.done} of ${plural(plan.total, 'step')} done`, detail: did.join(' · ') };
  }
  function lines(workspace) {
    const rows = [...workspace.runs.map(runLine), ...(workspace.plans || []).map(planLine), ...(workspace.tasks || []).map(taskLine)];
    if (workspace.approvals) rows.push({ kind: 'approval', text: `${plural(workspace.approvals, 'approval')} waiting for you` });
    if (workspace.handoff) rows.push({ kind: 'approval', text: `A handoff to ${agents[workspace.handoff.to] || 'another agent'} is offered` });
    if (workspace.waiting) rows.push({ kind: 'waiting', text: `Waiting for a usage limit to reset${workspace.waiting.resetsAt ? `, about ${time(workspace.waiting.resetsAt)}` : ''}; it continues with ${join(workspace.waiting.providers.map(name => agents[name] || name)) || 'the next agent with room'}` });
    if (workspace.queue) rows.push({ kind: 'waiting', text: `${plural(workspace.queue.count, 'queued prompt')}${workspace.queue.paused ? ', paused' : ''}` });
    // A scheduled run that didn't start waits for Run now on the board (#132).
    for (const item of workspace.missed || []) rows.push({ kind: 'approval', text: `The run of “${item.title}” scheduled for ${time(item.dueAt)} didn’t start`, detail: `${item.reason} Run it now from the board` });
    if (workspace.uncommitted) rows.push({ kind: 'git', text: `${plural(workspace.uncommitted, 'uncommitted change')} in Git` });
    return rows;
  }
  // The same recap, as it would be said.
  // One part per row, so the row being read can be shown. Each part knows where its row sits in the recap.
  function spoken(recap) {
    if (!recap.workspaces.length) return [{ text: 'Nothing ran while you were away.' }];
    const parts = [{ text: 'While you were away.' }];
    recap.workspaces.forEach((workspace, section) => {
      let first = true;
      lines(workspace).forEach((row, index) => {
        if (row.kind === 'git') return;
        parts.push({ text: `${first ? `In ${workspace.name}: ` : ''}${row.text}${row.detail ? `, ${row.detail.replaceAll(' · ', ', ')}` : ''}.`, section, index });
        first = false;
      });
    });
    return parts;
  }
  // Reads the recap, moving the highlight to each row as it goes; finishing or stopping clears it.
  function readAloud(recap) {
    const parts = spoken(recap), highlight = part => {
      for (const row of panel.querySelectorAll('.reading')) row.classList.remove('reading');
      if (part?.section === undefined) return;
      const row = panel.querySelectorAll('.recap-workspace')[part.section]?.querySelectorAll('li')[part.index];
      row?.classList.add('reading'); row?.scrollIntoView?.({ block: 'nearest' });
    };
    window.relayVoice.speak(parts.map(part => part.text), 'Reading the recap aloud', { onPart: index => highlight(index === null ? null : parts[index]) });
  }

  function render(recap) {
    current = recap;
    const header = node('header', undefined, 'recap-heading'), title = node('h2', 'While you were away');
    title.id = 'recap-title';
    header.append(title, node('span', span(Date.parse(recap.until) - Date.parse(recap.since)), 'recap-span'));
    if (window.relayVoice?.speak) { const read = node('button', 'Read aloud', 'text-link'); read.type = 'button'; read.addEventListener('click', () => readAloud(recap)); header.append(read); }
    const close = node('button', undefined, 'icon-button recap-close'); close.type = 'button'; close.setAttribute('aria-label', 'Close the recap'); close.addEventListener('click', hide);
    header.append(close);
    const body = node('div', undefined, 'recap-body');
    if (!recap.workspaces.length) body.append(node('p', 'Nothing ran while you were away, and nothing is waiting for you.', 'recap-empty'));
    for (const workspace of recap.workspaces) {
      const section = node('section', undefined, 'recap-workspace'), open = node('button', workspace.name, 'recap-name');
      open.type = 'button'; open.title = 'Open this workspace';
      open.addEventListener('click', () => { hide(); api.selectProject?.(workspace.projectId); });
      const list = node('ul');
      for (const row of lines(workspace)) { const item = node('li'); item.dataset.kind = row.kind; item.append(node('span', row.text, 'recap-text')); if (row.detail) item.append(node('span', row.detail, 'recap-detail')); list.append(item); }
      section.append(open, list); body.append(section);
    }
    panel.replaceChildren(header, body);
  }
  function hide() { panel.hidden = true; }
  async function show(since, automatic) {
    let recap;
    try { recap = await api.api(`/api/recap?since=${encodeURIComponent(new Date(since).toISOString())}`, {}, null); }
    catch (error) { if (!automatic) api.showNotice?.(error.message); return; }
    if (automatic && !recap.workspaces.length) return;
    render(recap); panel.hidden = false;
    if (automatic && prefs.speak && window.relayVoice?.speak) readAloud(recap);
  }

  // Away: the window is in the background or hidden. Back after two minutes or more: the recap, if anything happened.
  const away = () => { if (awaySince === null) awaySince = Date.now(); };
  const back = () => {
    if (awaySince === null || document.hidden) return;
    const since = awaySince; awaySince = null;
    if (Date.now() - since < AWAY) return;
    lastAway = since;
    if (prefs.show) show(since, true);
  };
  window.addEventListener('blur', away);
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', () => { if (document.hidden) away(); else back(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); hide(); } });

  // The recap's part of Settings.
  // "When you come back" on the Alerts page of Settings, drawn with the kit Settings lends (settings.js).
  function renderSettings(host, kit = settingsKit) {
    settingsHost = host; settingsKit = kit;
    if (!kit) return;
    host.replaceChildren();
    const rows = kit.group(host, t('When you come back'));
    kit.toggle(rows, { label: t('Show a recap when I come back'), description: t('After two minutes or more away: what ran, what changed and what is waiting in each workspace, from what Codeshi recorded.'), keywords: 'while you were away summary return', checked: prefs.show, onChange: value => save({ show: value }) });
    if (window.relayVoice?.speak) kit.toggle(rows, { label: t('Read it aloud'), description: t('Speak the recap in the voice chosen under Voice.'), keywords: 'recap speech speak', checked: prefs.speak, onChange: value => save({ speak: value }) });
  }
  window.relayRecap = {
    open: () => show(lastAway ?? openedAt, false),
    close: hide,
    settings: (host, kit) => renderSettings(host, kit),
    spoken,
    isOpen: () => !panel.hidden,
  };
})();

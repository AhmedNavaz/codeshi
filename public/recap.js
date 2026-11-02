(() => {
  'use strict';
  // "While you were away" (#22). Coming back to Throughline after two minutes or more, a short recap shows what ran,
  // what changed and what is waiting in every workspace, if anything happened. It is put together from what
  // Throughline recorded, with no agent call. Read aloud speaks it with voice mode's speech (#11); it can also be read
  // on its own when you come back. The search bar's "While you were away" shows it at any time.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('recap');
  if (!api || !panel) return;
  const KEY = 'throughline:recap', AWAY = 2 * 60 * 1000;
  const defaults = { show: true, speak: false };
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const load = () => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...defaults }; } };
  let prefs = load(), awaySince = null, lastAway = null, current = null, settingsHost = null;
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
  const time = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  // One line per run: who, how it ended, what it was asked, then what it did.
  function runLine(run) {
    const verb = run.status === 'running' ? 'is working on' : run.status === 'complete' ? 'finished' : run.errorCategory === 'quota' ? 'stopped at a usage limit on' : 'stopped on';
    const did = [];
    if (run.endedAt && run.status !== 'running') did.push(span(Date.parse(run.endedAt) - Date.parse(run.startedAt)));
    if (run.fileCount) did.push(run.fileCount <= 3 ? `changed ${join(run.files.map(base))}` : `changed ${plural(run.fileCount, 'file')}`);
    if (run.tests) did.push('ran the tests'); else if (run.commands) did.push(`ran ${plural(run.commands, 'command')}`);
    return { kind: run.status === 'running' ? 'working' : run.status === 'complete' ? 'done' : 'stopped', text: `${agent(run)} ${verb} “${run.prompt || 'a task'}”`, detail: did.join(' · ') };
  }
  function lines(workspace) {
    const rows = workspace.runs.map(runLine);
    if (workspace.approvals) rows.push({ kind: 'approval', text: `${plural(workspace.approvals, 'approval')} waiting for you` });
    if (workspace.handoff) rows.push({ kind: 'approval', text: `A handoff to ${agents[workspace.handoff.to] || 'another agent'} is offered` });
    if (workspace.waiting) rows.push({ kind: 'waiting', text: `Waiting for a usage limit to reset${workspace.waiting.resetsAt ? `, about ${time(workspace.waiting.resetsAt)}` : ''}; it continues with ${join(workspace.waiting.providers.map(name => agents[name] || name)) || 'the next agent with room'}` });
    if (workspace.queue) rows.push({ kind: 'waiting', text: `${plural(workspace.queue.count, 'queued prompt')}${workspace.queue.paused ? ', paused' : ''}` });
    if (workspace.uncommitted) rows.push({ kind: 'git', text: `${plural(workspace.uncommitted, 'uncommitted change')} in Git` });
    return rows;
  }
  // The same recap, as it would be said.
  function spoken(recap) {
    if (!recap.workspaces.length) return 'Nothing ran while you were away.';
    return 'While you were away. ' + recap.workspaces.map(workspace => `In ${workspace.name}: ${lines(workspace).filter(row => row.kind !== 'git').map(row => `${row.text}${row.detail ? `, ${row.detail.replaceAll(' · ', ', ')}` : ''}.`).join(' ')}`).join(' ');
  }

  function render(recap) {
    current = recap;
    const header = node('header', undefined, 'recap-heading'), title = node('h2', 'While you were away');
    title.id = 'recap-title';
    header.append(title, node('span', span(Date.parse(recap.until) - Date.parse(recap.since)), 'recap-span'));
    if (window.relayVoice?.speak) { const read = node('button', 'Read aloud', 'text-link'); read.type = 'button'; read.addEventListener('click', () => window.relayVoice.speak(spoken(recap), 'Reading the recap aloud')); header.append(read); }
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
    if (automatic && prefs.speak) window.relayVoice?.speak?.(spoken(recap), 'Reading the recap aloud');
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
  function renderSettings(host) {
    settingsHost = host;
    host.replaceChildren(node('h3', 'While you were away'), node('p', 'Coming back after two minutes or more, a short recap shows what ran, what changed and what is waiting in each workspace. It is put together from what Throughline recorded, with no agent call.', 'section-description'));
    const check = (text, key) => { const label = node('label', undefined, 'review-check'), box = node('input'); box.type = 'checkbox'; box.checked = prefs[key]; box.addEventListener('change', () => save({ [key]: box.checked })); label.append(box, document.createTextNode(text)); host.append(label); };
    check('Show a recap when I come back', 'show');
    if (window.relayVoice?.speak) check('Read it aloud', 'speak');
  }
  window.relayRecap = {
    open: () => show(lastAway ?? openedAt, false),
    close: hide,
    settings: host => renderSettings(host),
    spoken,
    isOpen: () => !panel.hidden,
  };
})();

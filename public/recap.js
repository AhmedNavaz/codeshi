(() => {
  'use strict';
  const { t } = window.codeshiText;
  // "While you were away" (#22, #202). Coming back to Codeshi, a short briefing: what needs you first (the same list the
  // phone's Needs you shows), then what the agents came to, in their own words, from what Codeshi recorded and with no
  // agent call. Durations, files and commands are folded under each line.
  // It opens by itself only after a longer break (15 minutes unless changed in Settings) and only when something needs
  // you or work finished away from the conversation on screen. Otherwise a small pill in the search bar offers it, and
  // when only the conversation on screen moved on, nothing shows: you can see it there. Read aloud speaks it with voice
  // mode's speech (#11). The search bar's "While you were away" shows it at any time.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('recap');
  if (!api || !panel) return;
  const KEY = 'throughline:recap', BRIEF = 2 * 60 * 1000, AFTER = [5, 15, 30, 60], SHOWN = 3;
  const defaults = { show: true, speak: false, after: 15 };
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const load = () => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...defaults }; } };
  let prefs = load(), awaySince = null, lastAway = null, settingsKit = null, pillRecap = null;
  const openedAt = Date.now();
  const save = patch => { prefs = { ...prefs, ...patch }; try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* A preference for this device only. */ } };
  const after = () => (AFTER.includes(Number(prefs.after)) ? Number(prefs.after) : defaults.after) * 60 * 1000;

  const agents = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', antigravity: 'Antigravity' };
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
  const end = text => /[.!?…]$/.test(text) ? text : `${text}.`;
  const changed = item => item.fileCount ? (item.fileCount <= 3 ? `changed ${join(item.files.map(base))}` : `changed ${plural(item.fileCount, 'file')}`) : '';

  // What needs you, most pressing first. Each line says what to do, then where.
  const ACT = { approval: 'Review', question: 'Answer', handoff: 'Review', retry: 'Review', plan: 'Review', review: 'Review', card: 'Review' };
  // Shown as two lines: what it is about (the command, the task, the question), then what kind of wait it is and where.
  const STATUS = { approval: 'Approval', question: 'Question', handoff: 'Handoff offer', retry: 'Tests failed', plan: 'Plan to approve', check: 'Tests failed', review: 'Ready to merge', card: 'Plan card to review', held: 'Paused', limit: 'Usage limit', schedule: 'Missed schedule' };
  const TONE = { approval: 'warn', question: 'warn', handoff: 'warn', plan: 'warn', retry: 'bad', check: 'bad', review: 'good', card: 'good' };
  function needLine(item) {
    const where = [item.workspace, item.taskId ? item.title : ''].filter(Boolean).join(' · ');
    const plain = item.kind === 'check' || item.kind === 'retry' ? 'Tests failed' : item.detail;
    const text = item.kind === 'plan' || item.kind === 'schedule' ? `${item.title}: ${item.detail}` : plain;
    const reset = item.kind === 'limit' && item.at ? `, about ${time(item.at)}` : '';
    // On screen, a task's own wait leads with the task; a wait in a chat leads with what it is about.
    const byTask = ['check', 'review', 'card', 'held'].includes(item.kind) && item.taskId;
    const title = byTask || ['plan', 'schedule'].includes(item.kind) ? item.title : item.kind === 'check' ? 'Tests failed, so queued messages wait' : `${item.detail}${reset}`;
    const status = item.kind === 'schedule' ? String(item.detail || STATUS.schedule).replace(/^Didn’t start: /, 'Didn’t start · ') : item.kind === 'review' && !/^Finished/.test(item.detail || '') ? 'Changes to review' : STATUS[item.kind] || 'Needs you';
    const place = [item.workspace, item.taskId && !byTask ? item.title : ''].filter(Boolean).join(' · ');
    return { kind: item.kind, act: ACT[item.kind] || 'Open', text: `${text}${reset}`, where, title, status, place, tone: TONE[item.kind] || 'quiet', provider: item.provider || '' };
  }

  // What a run came to. A finished run says it in the agent's words; what it was asked, how long it took and what it
  // touched fold beneath.
  function runLine(run) {
    const asked = `“${run.prompt || 'a task'}”`;
    const did = [run.outcome ? `Asked ${asked}` : '', run.endedAt && run.status !== 'running' ? span(Date.parse(run.endedAt) - Date.parse(run.startedAt)) : '', changed(run), run.tests ? 'ran the tests' : run.commands ? `ran ${plural(run.commands, 'command')}` : ''].filter(Boolean);
    const kind = run.status === 'running' ? 'working' : run.status === 'complete' ? 'done' : 'stopped';
    const text = run.status === 'running' ? `Working on ${asked}` : run.status === 'complete' ? run.outcome || `Finished ${asked}` : run.errorCategory === 'quota' ? `Stopped at a usage limit on ${asked}` : `Stopped on ${asked}`;
    return { kind, who: agent(run), provider: run.local ? 'local' : run.provider || '', text, detail: did.join(' · ') };
  }
  // A task beside the main conversation (#88). Approvals, failed tests and merging are in Needs you.
  function taskLine(task) {
    const asked = `the task “${task.title}”`;
    const kind = task.status === 'running' ? 'working' : task.status === 'complete' ? 'done' : task.status === 'waiting' ? 'waiting' : 'stopped';
    const text = task.status === 'running' ? `Working on ${asked}` : task.status === 'complete' ? task.outcome || `Finished ${asked}` : task.status === 'failed' ? `Didn’t finish ${asked}` : task.status === 'waiting' ? `Waiting to start ${asked}` : `Stopped on ${asked}`;
    const did = [task.outcome ? `Task “${task.title}”` : '', task.folder ? `in ${task.folder}` : '', changed(task), task.check === 'failed' ? 'tests failed' : task.check === 'passed' ? 'tests passed' : ''].filter(Boolean);
    return { kind, who: agents[task.provider] || 'An agent', provider: task.provider || '', text, detail: did.join(' · '), task: task.title };
  }
  // A plan's steps fold into one line: how far it got.
  function planLine(plan) {
    const working = plan.steps.filter(step => step.status === 'running'), stopped = plan.steps.filter(step => ['stopped', 'failed'].includes(step.status));
    const failed = plan.steps.some(step => step.check === 'failed');
    const steps = list => join(list.map(step => String(step.number)));
    const did = [working.length ? `step${working.length === 1 ? '' : 's'} ${steps(working)} working` : '', stopped.length ? `step${stopped.length === 1 ? '' : 's'} ${steps(stopped)} stopped` : ''].filter(Boolean);
    const kind = failed ? 'stopped' : working.length ? 'working' : plan.done === plan.total ? 'done' : stopped.length ? 'stopped' : 'waiting';
    return { kind, who: '', text: `The plan “${plan.goal}” has ${plan.done} of ${plural(plan.total, 'step')} done`, detail: did.join(' · '), lead: true, plan: { goal: plan.goal, done: plan.done, total: plan.total, now: did.join(' · ') } };
  }
  // Newest first within a workspace; plans lead because they sum up several tasks.
  function lines(workspace) {
    const runs = [...workspace.runs].reverse().map(runLine);
    return [...(workspace.plans || []).map(planLine), ...(workspace.tasks || []).map(taskLine), ...runs];
  }
  // A workspace in a few words: how many finished, are working, or stopped.
  function tally(rows) {
    const count = kind => rows.filter(row => row.kind === kind && !row.lead).length;
    return [count('done') ? `${count('done')} finished` : '', count('working') ? `${count('working')} working` : '', count('stopped') ? `${count('stopped')} stopped` : ''].filter(Boolean).join(' · ');
  }

  // The recap as it is shown and said: Needs you, then each workspace's lines. Each row has a key, so the row being read
  // can be shown.
  function model(recap) {
    const needs = (recap.needsYou || []).map((item, index) => ({ ...needLine(item), key: `n${index}`, item }));
    const workspaces = recap.workspaces.map((workspace, section) => {
      const rows = lines(workspace).map((row, index) => ({ ...row, key: `w${section}-${index}` }));
      return { workspace, rows, tally: tally(rows) };
    }).filter(entry => entry.rows.length);
    return { needs, workspaces };
  }
  function spoken(recap) {
    const { needs, workspaces } = model(recap);
    if (!needs.length && !workspaces.length) return [{ text: 'Nothing ran while you were away, and nothing is waiting for you.' }];
    const parts = [{ text: 'While you were away.' }];
    if (needs.length) parts.push({ text: `${plural(needs.length, 'thing')} need${needs.length === 1 ? 's' : ''} you.` });
    for (const row of needs.slice(0, SHOWN)) parts.push({ text: end(`${row.where}: ${row.text}`), key: row.key });
    if (needs.length > SHOWN) parts.push({ text: `And ${needs.length - SHOWN} more.` });
    for (const { workspace, rows } of workspaces) {
      rows.slice(0, SHOWN).forEach((row, index) => parts.push({ text: end(`${index ? '' : `In ${workspace.name}: `}${row.who ? `${row.who}: ` : ''}${row.text}`), key: row.key }));
      if (rows.length > SHOWN) parts.push({ text: `And ${plural(rows.length - SHOWN, 'more line')} in ${workspace.name}.` });
    }
    return parts;
  }
  // Reads the recap, moving the highlight to each row as it goes; finishing or stopping clears it.
  function readAloud(recap) {
    const parts = spoken(recap), highlight = part => {
      for (const row of panel.querySelectorAll('.reading')) row.classList.remove('reading');
      if (!part?.key) return;
      const row = [...panel.querySelectorAll('.recap-row')].find(item => item.dataset.row === part.key);
      for (let fold = row?.closest('details:not([open])'); fold; fold = fold.parentElement?.closest('details:not([open])')) fold.setAttribute('open', '');
      row?.classList.add('reading'); row?.scrollIntoView?.({ block: 'nearest' });
    };
    window.relayVoice.speak(parts.map(part => part.text), 'Reading the recap aloud', { onPart: index => highlight(index === null ? null : parts[index]) });
  }

  // Opens where an item can be acted on: its workspace, then its task.
  async function go(projectId, taskId) {
    hide();
    if (projectId && api.getState?.().projectId !== projectId) await api.selectProject?.(projectId);
    if (taskId) await window.relayTaskThreads?.select?.(taskId);
  }
  function more(label, rows, cls = 'recap-more') {
    const fold = node('details', undefined, cls), summary = node('summary', label);
    const list = node('ul'); list.append(...rows); fold.append(summary, list);
    return fold;
  }
  // A command reads as code, the way the conversation shows it.
  function needTitle(row) {
    const text = node('span', undefined, 'recap-text'), command = /^(.*?\bRun )(.+)$/.exec(row.title);
    if (command && row.kind === 'approval') text.append(node('span', command[1]), node('code', command[2]));
    else text.textContent = row.title;
    return text;
  }
  function needRow(row) {
    const item = node('li', undefined, 'recap-row recap-need'), open = node('button', undefined, 'recap-need-open');
    item.dataset.kind = row.kind; item.dataset.tone = row.tone; item.dataset.row = row.key; open.type = 'button'; open.title = 'Open it';
    const words = node('span', undefined, 'recap-need-words'), sub = node('span', undefined, 'recap-sub');
    sub.append(node('span', row.status, 'recap-status'));
    if (row.place) sub.append(node('span', row.place, 'recap-where'));
    words.append(needTitle(row), sub);
    open.append(node('span', undefined, 'recap-icon'), words, node('span', row.act, 'recap-act'));
    open.addEventListener('click', () => go(row.item.projectId, row.item.taskId));
    item.append(open);
    // Another workspace can be pinned beside this one as a companion lane (#203), to steer it from there.
    const lanes = window.relayLanes, id = row.item.projectId;
    if (lanes && id && (lanes.canPin(id) || lanes.has(id))) {
      const pin = node('button', undefined, 'recap-need-pin'), pinned = lanes.has(id);
      pin.type = 'button'; pin.disabled = pinned;
      pin.title = pinned ? `${row.item.workspace || 'This workspace'} is pinned beside this one` : `Pin ${row.item.workspace || 'this workspace'} beside this one`;
      pin.setAttribute('aria-label', pin.title);
      pin.addEventListener('click', () => { if (lanes.pin(id)) { pin.disabled = true; pin.title = `${row.item.workspace || 'This workspace'} is pinned beside this one`; pin.setAttribute('aria-label', pin.title); } });
      item.append(pin);
    }
    return item;
  }
  // One thing an agent came to: its mark, then what it said. How it got there (time, files, tests) folds beneath.
  function outcomeRow(row) {
    const item = node('li', undefined, 'recap-row recap-outcome'), mark = node('span', undefined, 'recap-mark');
    item.dataset.kind = row.kind; item.dataset.row = row.key;
    if (row.plan) mark.dataset.mark = 'plan';
    else if (row.kind === 'working') mark.dataset.mark = 'working';
    else mark.dataset.mark = row.provider || 'agent';
    mark.title = row.plan ? 'Plan' : row.who || '';
    const head = [mark];
    if (row.plan) {
      const words = node('span', undefined, 'recap-plan'), bar = node('span', undefined, 'recap-progress');
      bar.setAttribute('aria-hidden', 'true');
      for (let step = 0; step < Math.min(row.plan.total, 12); step++) bar.append(node('i', undefined, step < row.plan.done ? 'done' : ''));
      words.append(node('span', row.plan.goal, 'recap-text'), bar, node('span', [`${row.plan.done} of ${row.plan.total}`, row.plan.now].filter(Boolean).join(' · '), 'recap-step'));
      head.push(words);
    } else {
      const words = node('span', undefined, 'recap-words'), text = node('span', undefined, 'recap-text');
      // A run that didn't finish says so first, in its colour; the agent's words need no label.
      const state = row.kind === 'done' ? null : /^(Stopped|Working|Waiting to start|Didn’t finish)(.*)$/.exec(row.text);
      if (state) text.append(node('span', state[1], 'recap-state'), node('span', state[2]));
      else text.textContent = row.text;
      words.append(text);
      head.push(words);
    }
    if (!row.detail || row.plan) { const line = node('div', undefined, 'recap-line'); line.append(...head); item.append(line); return item; }
    const fold = node('details', undefined, 'recap-fold'), summary = node('summary', undefined, 'recap-line');
    summary.append(...head); fold.append(summary, node('p', row.detail, 'recap-detail')); item.append(fold);
    return item;
  }
  function workspaceBlock({ workspace, rows, tally: counts }) {
    const block = node('section', undefined, 'recap-ws'), head = node('div', undefined, 'recap-ws-head');
    const meta = [counts, workspace.uncommitted ? plural(workspace.uncommitted, 'uncommitted change') : ''].filter(Boolean).join(' · ');
    const open = node('button', 'Open', 'recap-open'); open.type = 'button'; open.title = `Open ${workspace.name}`;
    open.addEventListener('click', () => go(workspace.projectId, null));
    head.append(node('span', undefined, 'recap-folder'), node('span', workspace.name, 'recap-name'), node('span', meta, 'recap-meta'), open);
    const list = node('ul'); list.append(...rows.slice(0, SHOWN).map(outcomeRow));
    block.append(head, list);
    if (rows.length > SHOWN) block.append(more(`${rows.length - SHOWN} more`, rows.slice(SHOWN).map(outcomeRow)));
    return block;
  }
  function render(recap) {
    const { needs, workspaces } = model(recap);
    const header = node('header', undefined, 'recap-heading'), title = node('h2', 'While you were away');
    title.id = 'recap-title';
    header.append(title, node('span', span(Date.parse(recap.until) - Date.parse(recap.since)), 'recap-span'));
    if (window.relayVoice?.speak) { const read = node('button', 'Read aloud', 'recap-read'); read.type = 'button'; read.addEventListener('click', () => readAloud(recap)); header.append(read); }
    const close = node('button', undefined, 'icon-button recap-close'); close.type = 'button'; close.setAttribute('aria-label', 'Close the recap'); close.addEventListener('click', hide);
    header.append(close);
    const body = node('div', undefined, 'recap-body');
    if (!needs.length && !workspaces.length) body.append(node('p', 'Nothing ran while you were away, and nothing is waiting for you.', 'recap-empty'));
    if (needs.length) {
      const section = node('section', undefined, 'recap-section recap-needs'), label = node('h3', 'Waiting on you'), list = node('ul', undefined, 'recap-needlist');
      label.append(node('span', String(needs.length), 'recap-count'));
      list.append(...needs.slice(0, SHOWN).map(needRow));
      section.append(label, list);
      if (needs.length > SHOWN) section.append(more(`${needs.length - SHOWN} more waiting`, needs.slice(SHOWN).map(needRow), 'recap-more recap-more-needs'));
      body.append(section);
    }
    if (workspaces.length) {
      const section = node('section', undefined, 'recap-section recap-done');
      section.append(node('h3', needs.length ? 'What happened' : 'Nothing needs you. Here’s what happened'));
      // Three workspaces at most are open to read; the rest wait behind one line.
      section.append(...workspaces.slice(0, SHOWN).map(workspaceBlock));
      if (workspaces.length > SHOWN) section.append(more(`${plural(workspaces.length - SHOWN, 'more workspace')}`, workspaces.slice(SHOWN).map(entry => { const li = node('li'); li.append(workspaceBlock(entry)); return li; })));
      body.append(section);
    }
    panel.replaceChildren(header, body);
  }

  // The pill in the search bar: the recap is there when you want it, without opening over your work.
  const bar = $('workspace-search')?.parentNode || null, pill = node('button', undefined, 'recap-pill');
  pill.type = 'button'; pill.id = 'recap-pill'; pill.hidden = true;
  pill.addEventListener('click', () => { const recap = pillRecap; clearPill(); if (recap) { render(recap); panel.hidden = false; } });
  bar?.append(pill);
  function showPill(recap, needs) {
    pillRecap = recap;
    pill.replaceChildren(node('span', undefined, 'recap-pill-icon'), node('span', 'Recap', 'recap-pill-label'));
    if (needs) pill.append(node('span', String(needs), 'recap-pill-count'));
    pill.setAttribute('aria-label', needs ? `While you were away: ${plural(needs, 'thing')} need${needs === 1 ? 's' : ''} you` : 'While you were away');
    pill.title = 'Show what happened while you were away';
    pill.hidden = false; bar?.classList.add('has-recap-pill');
  }
  function clearPill() { pillRecap = null; pill.hidden = true; bar?.classList.remove('has-recap-pill'); }

  function hide() { panel.hidden = true; }
  async function fetchRecap(since) { return api.api(`/api/recap?since=${encodeURIComponent(new Date(since).toISOString())}`, {}, null); }
  async function show(since) {
    let recap;
    try { recap = await fetchRecap(since); } catch (error) { api.showNotice?.(error.message); return; }
    clearPill(); render(recap); panel.hidden = false;
  }
  // What came back to: whether anything happened away from the conversation on screen, and how much needs you.
  function weigh(recap) {
    const here = api.getState?.().projectId, onScreen = item => item.projectId === here && !item.taskId;
    const needs = recap.needsYou || [];
    const elsewhere = recap.workspaces.some(workspace => workspace.projectId !== here || workspace.tasks?.length || workspace.plans?.length || workspace.missed?.length);
    return { needs: needs.length, pressing: needs.some(item => !onScreen(item)), elsewhere, anything: needs.length > 0 || recap.workspaces.length > 0 };
  }
  async function cameBack(since) {
    let recap;
    try { recap = await fetchRecap(since); } catch { return; }
    const away = Date.now() - since, long = away >= after(), { needs, pressing, elsewhere, anything } = weigh(recap);
    if (!anything) return;
    if (long && (pressing || elsewhere)) {
      clearPill(); render(recap); panel.hidden = false;
      if (prefs.speak && window.relayVoice?.speak) readAloud(recap);
      return;
    }
    // Only the conversation on screen moved on during a short break: it shows there already.
    if (!long && !pressing && !elsewhere) return;
    showPill(recap, needs);
  }

  // Away: the window is in the background or hidden. A break of a minute or two shows nothing.
  // Time spent in another Codeshi window or tab (#203) isn't time away, so each one notes when it was last in front, and
  // the away time counts from the later of the two.
  const self = Math.random().toString(36).slice(2), FRONT = 'codeshi:window-front';
  const noteFront = () => { try { localStorage.setItem(FRONT, JSON.stringify({ id: self, at: Date.now() })); } catch { /* Storage is a convenience. */ } };
  const otherFront = () => { try { const seen = JSON.parse(localStorage.getItem(FRONT) || 'null'); return seen && seen.id !== self && Number.isFinite(seen.at) ? seen.at : 0; } catch { return 0; } };
  const away = () => { noteFront(); if (awaySince === null) awaySince = Date.now(); };
  const back = () => {
    if (awaySince === null || document.hidden) return;
    const since = Math.max(awaySince, Math.min(otherFront(), Date.now())); awaySince = null;
    noteFront();
    if (Date.now() - since < BRIEF) return;
    lastAway = since;
    if (prefs.show) cameBack(since);
  };
  window.addEventListener('blur', away);
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', () => { if (document.hidden) away(); else back(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); hide(); } });

  // "When you come back" on the Alerts page of Settings, drawn with the kit Settings lends (settings.js).
  function renderSettings(host, kit = settingsKit) {
    settingsKit = kit;
    if (!kit) return;
    host.replaceChildren();
    const rows = kit.group(host, t('When you come back'));
    kit.toggle(rows, { label: t('Show a recap when I come back'), description: t('What needs you first, then what the agents did, in their own words. After a short break it waits as a pill in the search bar.'), keywords: 'while you were away summary return briefing', checked: prefs.show, onChange: value => { save({ show: value }); renderSettings(host, kit); } });
    kit.select(rows, { label: t('Open it by itself after'), description: t('Only when something needs you or work finished outside the conversation on screen.'), keywords: 'recap away minutes threshold', options: AFTER.map(minutes => [String(minutes), t('{count} minutes', { count: minutes })]), value: String(after() / 60000), disabled: !prefs.show, onChange: value => save({ after: Number(value) }) });
    if (window.relayVoice?.speak) kit.toggle(rows, { label: t('Read it aloud'), description: t('Speak the recap in the voice chosen under Voice when it opens by itself.'), keywords: 'recap speech speak', checked: prefs.speak, onChange: value => save({ speak: value }) });
  }
  window.relayRecap = {
    open: () => show(lastAway ?? openedAt),
    close: hide,
    settings: (host, kit) => renderSettings(host, kit),
    spoken,
    isOpen: () => !panel.hidden,
  };
})();

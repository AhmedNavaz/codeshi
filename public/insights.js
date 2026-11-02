(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const name = provider => provider === 'gemini' ? 'Gemini' : provider === 'claude' ? 'Claude' : 'Codex';
  const title = value => value === 'xhigh' ? 'X-High' : value ? value[0].toUpperCase() + value.slice(1) : 'Provider default';
  const duration = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; };
  const date = value => !value || Number.isNaN(new Date(value).getTime()) ? 'Date unavailable' : new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const action = (text, fn, cls) => { const button = el('button', text, cls); button.type = 'button'; button.addEventListener('click', fn); return button; };
  const external = async url => { if (window.relayDesktop) await window.relayDesktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer'); };
  const catalog = {}, loadingModels = {}, attemptedModels = {};
  let modelSignature = '', lastProject = null, inspectedRun = null;
  const dismissedSteps = new Set();
  const nextStepsKey = () => { const state = api.getState(); return state.projectId + ':' + state.conversation?.lastRun?.id; };
  function nextSteps() {
    const state = api.getState(), run = state.conversation?.lastRun;
    const count = gitScope === state.projectId ? gitData?.totalChanges || 0 : 0;
    const blocked = ['incomplete','interrupted'].includes(run?.status);
    $('next-actions').hidden = !state.projectId || api.isRunning() || (!blocked && (run?.status !== 'complete' || !count)) || run?.purpose === 'review' || !run || dismissedSteps.has(nextStepsKey());
    $('next-actions-text').textContent = blocked ? 'The run stopped' : `${count} changed file${count === 1 ? '' : 's'}`;
    $('next-review').hidden = !count;
  }
  $('next-review').addEventListener('click', () => window.relayReviews?.suggest());
  $('next-friend').addEventListener('click', () => $('ask-friend').click());
  $('dismiss-next-actions').addEventListener('click', () => { dismissedSteps.add(nextStepsKey()); nextSteps(); });

  function modelControls() {
    const state = api.getState(), provider = state.provider, rows = catalog[provider] || [];
    const signature = JSON.stringify([provider, state.model, state.effort, rows]);
    const selected = rows.find(row => [row.id, row.model, row.value, row.resolvedModel].includes(state.model)) || (!state.model && rows.find(row => row.isDefault || row.value === 'default'));
    if (signature !== modelSignature) {
      modelSignature = signature;
      $('model-select').replaceChildren();
      const base = el('option', 'Provider default'); base.value = ''; $('model-select').append(base);
      for (const row of rows.filter(row => row.value !== 'default')) { const option = el('option', row.displayName || row.name || row.id || row.value); option.value = row.id || row.model || row.value; $('model-select').append(option); }
      if (state.model && !rows.some(row => (row.id || row.model || row.value) === state.model)) { const option = el('option', state.model); option.value = state.model; $('model-select').append(option); }
      const custom = el('option', 'Enter a model ID…'); custom.value = '__custom__'; $('model-select').append(custom);
      $('model-select').value = state.model || '';
      const effortDefault = el('option', selected?.defaultReasoningEffort ? `Default (${selected.defaultReasoningEffort})` : 'Provider default'); effortDefault.value = '';
      $('effort-select').replaceChildren(effortDefault);
      const efforts = selected?.supportedEffortLevels || selected?.supportedReasoningEfforts?.map(row => row.reasoningEffort) || [];
      for (const effort of efforts) { const option = el('option', title(effort)); option.value = effort; $('effort-select').append(option); }
      if (state.effort && !efforts.includes(state.effort)) { const option = el('option', `${title(state.effort)} (saved)`); option.value = state.effort; $('effort-select').append(option); }
      $('effort-select').value = state.effort || '';
      $('effort-select').dataset.supported = String(efforts.length > 0);
    }
    const locked = !state.ready || state.pending || state.settingsPending || state.conversation?.status === 'running';
    $('model-select').disabled = Boolean(locked || loadingModels[provider]);
    $('save-custom-model').disabled = Boolean(locked);
    $('custom-model-input').disabled = Boolean(locked);
    $('refresh-models').disabled = Boolean(locked || loadingModels[provider]);
    $('refresh-models').setAttribute('aria-busy', String(Boolean(loadingModels[provider])));
    $('effort-select').disabled = Boolean(locked || $('effort-select').dataset.supported !== 'true');
    $('model-description').textContent = loadingModels[provider] ? `Loading ${name(provider)} models…` : `${name(provider)} · ${selected?.displayName || state.model || 'Provider default'} · ${state.effort ? title(state.effort) + ' reasoning effort' : 'Default reasoning effort'}${!rows.length ? ' — refresh to load available models' : ''}`;
  }
  async function loadModels(force = false) {
    const state = api.getState(), provider = state.provider;
    if (loadingModels[provider] || (!force && catalog[provider]?.length) || !state.ready) return;
    loadingModels[provider] = true; attemptedModels[provider] = true; modelControls();
    try { const result = await api.api(`/api/providers/${provider}/models`, {}, state.projectId); catalog[provider] = result.models || []; }
    catch (error) { api.showNotice(`Could not load ${name(provider)} models. ${error.message}`); }
    finally { loadingModels[provider] = false; modelControls(); }
  }
  // After a failed save the pickers show the saved choice again, which is what the next run uses.
  const showSaved = () => { const state = api.getState(); $('model-select').value = state.model || ''; $('effort-select').value = state.effort || ''; };
  $('model-select').addEventListener('focus', () => loadModels());
  $('refresh-models').addEventListener('click', () => loadModels(true));
  $('model-select').addEventListener('change', async () => {
    const state = api.getState(), model = $('model-select').value;
    if (model === '__custom__') { $('custom-model-editor').hidden = false; $('custom-model-input').value = state.model || ''; $('custom-model-input').focus(); return; }
    $('custom-model-editor').hidden = true;
    const effort = state.conversation?.efforts?.[state.provider]?.[model || 'default'] ?? null;
    try { await api.setConfiguration({ model, effort }); } catch (error) { showSaved(); api.showNotice(error.message); } finally { modelControls(); }
  });
  $('cancel-custom-model').addEventListener('click', () => { $('custom-model-editor').hidden = true; $('model-select').value = api.getState().model || ''; });
  $('save-custom-model').addEventListener('click', async () => {
    const model = $('custom-model-input').value.trim();
    if (!model || model.length > 200) { api.showNotice('Enter a supported model ID of at most 200 characters.'); return; }
    try { await api.setConfiguration({ model, effort: null }); $('custom-model-editor').hidden = true; }
    catch (error) { api.showNotice(error.message); } finally { modelControls(); }
  });
  // The field is inside the composer form, where Enter would send the draft with the previous model.
  $('custom-model-input').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (!$('save-custom-model').disabled) $('save-custom-model').click();
  });
  $('effort-select').addEventListener('change', async () => { try { await api.setConfiguration({ effort: $('effort-select').value || null }); } catch (error) { showSaved(); api.showNotice(error.message); } finally { modelControls(); } });

  function progress() {
    const state = api.getState(), c = state.conversation, running = c?.status === 'running', run = running ? c.activeRun : c?.lastRun;
    $('run-progress').hidden = !run;
    if (!run) return;
    const elapsed = running ? Date.now() - Date.parse(run.startedAt) : run.elapsedMs || Date.parse(run.endedAt) - Date.parse(run.startedAt);
    const silence = Date.now() - Date.parse(run.lastEventAt || run.startedAt);
    const phase = c.pendingApprovals?.length ? 'approval' : run.phase || 'starting';
    const quiet = running && !c.pendingApprovals?.length && silence > 30000;
    const phaseLabel = { starting: 'Starting agent', working: 'Working', reasoning: 'Reasoning', responding: 'Writing response', tool: 'Running tools', compacting: 'Organizing context', approval: 'Waiting for approval' }[phase] || 'Working';
    $('run-phase').textContent = running ? state.streamConnected === false ? 'Reconnecting to app' : quiet ? 'Waiting for provider' : phaseLabel : run.status === 'complete' ? 'Completed' : run.errorCategory === 'quota' ? 'Usage limit reached' : 'Run stopped';
    $('run-phase').className = `run-phase sr-only ${running ? quiet ? 'quiet' : phase === 'approval' ? 'approval' : 'active' : run.status === 'complete' ? 'complete' : 'quiet'}`;
    // A finished run states its duration in the action text.
    $('run-elapsed').textContent = running && Number.isFinite(elapsed) ? duration(elapsed) : '';
    $('run-progress').dataset.state = running ? state.streamConnected === false ? 'quiet' : phase === 'approval' ? 'approval' : quiet ? 'quiet' : 'active' : run.status === 'complete' ? 'complete' : 'quiet';
    const agent = run.connection === 'local' ? 'Local · Ollama' : name(run.provider);

    // One live line, the last step of the run's thread: what the agent is doing in a word, and for how long. The steps
    // above it say what it did, and the agent, model and effort head the thread, so this line repeats none of them.
    let actionText;
    if (running) {
      if (state.streamConnected === false) actionText = 'Reconnecting to the app';
      else if (c.pendingApprovals?.length) actionText = 'Waiting for your approval';
      else if (quiet) actionText = `Waiting for ${agent}`;
      else actionText = { starting: `Starting ${agent}`, reasoning: 'Thinking', responding: 'Writing', compacting: 'Organizing context' }[phase] || 'Working';
    } else if (run.status === 'complete') actionText = `Completed in ${Number.isFinite(elapsed) ? duration(elapsed) : 'recorded duration'}`;
    else actionText = run.errorCategory === 'quota' ? 'Usage limit reached' : 'Run stopped';
    $('run-action').textContent = actionText;
    // Opening the line explains a pause; otherwise it holds the token and context counts.
    $('run-detail').textContent = !running ? '' : state.streamConnected === false ? 'The app connection was interrupted. The agent may still be running; reconnecting to restore its live status.' : phase === 'approval' ? 'Review the permission request below to let the agent continue.' : quiet ? `No activity from ${agent} for ${duration(silence)}. This can happen during a long request; you can wait or stop the run.` : '';
    const metrics = [];
    if (run.connection === 'local') metrics.push('No cloud model charges');
    // Codex's inputTokens include its cached input; Claude reports the input it read from and wrote to its cache apart from input_tokens.
    const usage = run.usage?.total || run.usage, output = usage?.outputTokens ?? usage?.output_tokens;
    const input = usage?.inputTokens ?? (typeof usage?.input_tokens === 'number' ? usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : undefined);
    if (typeof input === 'number') metrics.push(`${input.toLocaleString()} input tokens`);
    if (typeof output === 'number') metrics.push(`${output.toLocaleString()} output tokens`);
    if (typeof usage?.used === 'number') metrics.push(`${usage.used.toLocaleString()}${typeof usage.size === 'number' ? ' / ' + usage.size.toLocaleString() : ''} context tokens`);
    const handed = run.context;
    if (handed?.sessionMode) {
      metrics.push(handed.sessionMode === 'fresh' ? 'Fresh session · shared history' : 'Resumed native session');
      if (handed.sessionReason === 'cross-agent-handoff') metrics.push('Cross-agent handoff');
      if (Number.isSafeInteger(handed.includedMessages)) metrics.push(`${handed.includedMessages} history messages included · ${handed.omittedMessages || 0} omitted`);
      if (handed.shortenedMessages) metrics.push(`${handed.shortenedMessages} history excerpts`);
      if (handed.compactedActivityMessages) metrics.push(`${handed.compactedActivityMessages} tool logs compacted`);
    }
    $('run-metrics').replaceChildren(...metrics.map(value => el('span', value, 'run-metric-item')));
    if (run.purpose === 'review') {
      const report = c.reviews?.find(review => review.id === run.reviewId);
      $('run-phase').textContent = running ? 'Review · ' + $('run-phase').textContent : report?.status === 'complete' ? 'Review complete' : 'Review needs attention';
      if (!running && report?.status !== 'complete') $('run-phase').className = 'run-phase sr-only quiet';
      $('run-detail').textContent = `${name(run.provider)} · Read-only review${report?.summary ? ' · ' + report.summary : ''}`;
    }
    // With nothing to open, the line is only a status.
    const empty = !$('run-detail').textContent && !metrics.length;
    $('run-details-disclosure').classList.toggle('empty', empty);
    if (empty) $('run-details-disclosure').open = false;
  }

  let gitData = null, gitScope = null, gitBusy = false, gitView = 'changes', gitRequest = 0;
  function renderGit() {
    const repositories = gitData?.repositories || [], select = $('git-repository');
    const selectedId = select.value;
    select.replaceChildren(...repositories.map(row => { const option = el('option', row.name); option.value = row.folderId; return option; }));
    const folderId = api.selectedFolderId?.();
    if (repositories.some(row => row.folderId === folderId)) select.value = folderId; else if (repositories.some(row => row.folderId === selectedId)) select.value = selectedId;
    const repo = repositories.find(row => row.folderId === select.value) || repositories[0];
    $('git-summary').replaceChildren(); $('git-content').replaceChildren();
    $('git-changes-tab').setAttribute('aria-pressed', String(gitView === 'changes')); $('git-commits-tab').setAttribute('aria-pressed', String(gitView === 'commits'));
    $('git-commit').hidden = true;
    if (!repo) { $('git-content').append(el('p', 'Add a workspace folder to view Git activity.', 'inspector-empty')); return; }
    if (!repo.available) { $('git-content').append(el('p', repo.error || 'Git is not available for this folder.', 'inspector-empty')); return; }
    $('git-summary').dataset.clean = String(repo.totalChanges === 0);
    $('git-summary').append(el('span', repo.branch, 'git-branch'), el('span', `${repo.totalChanges} changed`, 'git-change-count'));
    if (repo.githubURL) $('git-summary').append(action('Open on GitHub ↗', () => external(repo.githubURL), 'text-link'));
    if (repo.error) $('git-content').append(el('p', repo.error, 'import-error'));
    $('git-commit').hidden = gitView !== 'changes';
    if (gitView === 'changes') {
      renderCommit(repo);
      if (!repo.totalChanges) $('git-content').append(el('div', '✓ Working tree is clean', 'inspector-empty'));
      // Staged changes are exactly what the next commit holds; a file changed again after staging shows in both lists.
      const staged = repo.changes.filter(file => !' ?'.includes(file.code[0])), unstaged = repo.changes.filter(file => file.code[1] !== ' ');
      if (staged.length) gitSection(repo, 'Staged changes', staged, 'unstage');
      if (unstaged.length) gitSection(repo, 'Changes', unstaged, 'stage');
      if (repo.changesClipped) $('git-content').append(el('p', 'Showing the first 100 changed files.', 'muted'));
    } else {
      if (!repo.commits.length) $('git-content').append(el('p', 'No commits yet. Your commits will appear here.', 'inspector-empty'));
      for (const commit of repo.commits) {
        const row = el('article', undefined, 'commit-card'); row.append(el('h3', commit.subject), el('p', `${commit.author} · ${date(commit.date)}`));
        row.append(commit.url ? action(commit.shortHash + ' ↗', () => external(commit.url), 'commit-hash') : el('code', commit.shortHash, 'commit-hash')); $('git-content').append(row);
      }
    }
    $('git-updated').textContent = (gitView === 'commits' ? 'Latest 15 local commits · refreshed ' : 'Local Git · refreshed ') + date(gitData.checkedAt);
  }
  const codeNames = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflict', '?': 'New' };
  const statusOf = code => code === 'D' ? 'deleted' : code === '?' || code === 'A' ? 'added' : code === 'R' ? 'renamed' : 'modified';
  // One list of changes with a stage or unstage button on each file and for the whole list.
  function gitSection(repo, title, files, act) {
    const section = el('section', undefined, 'git-section'), head = el('div', undefined, 'git-section-head');
    head.append(el('h3', title), el('span', String(files.length), 'git-section-count'));
    const all = action('', () => gitWrite(act, repo, { all: true }), `icon-button git-stage-button ${act}`); all.title = act === 'stage' ? 'Stage all changes' : 'Unstage all changes'; all.setAttribute('aria-label', all.title); all.disabled = gitWriting;
    head.append(all); section.append(head);
    for (const file of files) {
      const code = act === 'stage' ? file.code[1] : file.code[0], status = statusOf(code), row = el('div', undefined, 'git-file-row');
      const open = action('', () => openDiff(repo, file, file.code === '??' ? 'untracked' : statusOf(file.code.trim()[0] || 'M')), 'git-file'); open.dataset.status = status; open.title = 'Show changes';
      open.append(el('span', code === '?' ? 'U' : code, 'git-file-code'), el('span', file.path, 'git-file-name'), el('span', codeNames[code] || 'Changed', 'git-file-status'));
      const toggle = action('', () => gitWrite(act, repo, { paths: [file.path] }), `icon-button git-stage-button ${act}`); toggle.title = act === 'stage' ? 'Stage' : 'Unstage'; toggle.setAttribute('aria-label', `${toggle.title} ${file.path}`); toggle.disabled = gitWriting;
      row.append(open, toggle); section.append(row);
    }
    $('git-content').append(section);
  }
  // The commit box: a message, and a button naming what the commit holds. With files staged it commits those; with
  // nothing staged it commits every change listed, as the button says. Drafts are kept per folder.
  const commitDrafts = new Map();
  let gitWriting = false, commitOutcome = null;
  const stagedFiles = repo => repo.changes.filter(file => !' ?'.includes(file.code[0])), changedFiles = repo => repo.changes.filter(file => file.code[1] !== ' ');
  function renderCommit(repo) {
    const box = $('git-commit'), message = $('git-commit-message'), staged = stagedFiles(repo).length, all = !staged, count = staged || changedFiles(repo).length, more = repo.changesClipped ? '+' : '';
    if (box.dataset.folder !== repo.folderId) { box.dataset.folder = repo.folderId; message.value = commitDrafts.get(repo.folderId) || ''; if (commitOutcome?.folderId !== repo.folderId) commitOutcome = null; }
    message.placeholder = `Message (${window.relayDesktop?.platform === 'darwin' || /Mac/.test(globalThis.navigator?.platform || '') ? '⌘' : 'Ctrl+'}↵ to commit${repo.branch && repo.branch !== 'Detached HEAD' ? ` on ${repo.branch}` : ''})`;
    message.disabled = Boolean(gitWriting);
    const button = $('git-commit-button');
    button.textContent = gitWriting === 'commit' || gitWriting === 'commit-all' ? 'Committing…' : count ? `Commit ${all ? 'all ' : ''}${count}${more} file${count === 1 && !more ? '' : 's'}` : 'Commit';
    button.disabled = Boolean(gitWriting) || !count || !message.value.trim();
    button.title = !count ? 'There are no changes to commit' : !message.value.trim() ? 'Write a commit message' : all ? 'Stages every change listed below, then commits them' : 'Commits the staged files';
    const who = repo.committer;
    $('git-committer').textContent = who?.name && who?.email ? `as ${who.name}` : 'Set your Git name and email to commit';
    $('git-committer').title = who?.email ? `${who.name} <${who.email}>` : 'git config --global user.name and user.email';
    $('git-committer').classList.toggle('warning', !(who?.name && who?.email));
    const result = $('git-commit-result');
    result.hidden = !commitOutcome; result.replaceChildren();
    if (!commitOutcome) return;
    result.dataset.kind = commitOutcome.kind;
    if (commitOutcome.kind === 'done') { const { commit } = commitOutcome; result.append(el('span', `Committed ${commit.shortHash}${commit.branch ? ` on ${commit.branch}` : ''} · not pushed`)); return; }
    result.append(el('span', commitOutcome.message));
    if (commitOutcome.output) result.append(el('pre', commitOutcome.output, 'git-commit-output'));
    if (commitOutcome.hooks) { const skip = action('Commit without hooks', () => commit(true), 'secondary-button'); skip.title = 'Runs git commit --no-verify'; skip.disabled = gitWriting; result.append(skip); }
  }
  // One Git action at a time. A commit of everything listed stages first and stays busy until its commit finishes.
  async function gitWrite(act, repo, input, { continuing = false, keepBusy = false } = {}) {
    const projectId = api.getState().projectId;
    if (!projectId || (gitWriting && !continuing)) return false;
    gitWriting ||= act; renderGit();
    let done = false;
    try {
      const result = await api.post(`/api/git/${act}`, { folderId: repo.folderId, ...input }, projectId);
      if (api.getState().projectId === projectId) gitData = result.git;
      if (act === 'commit') { commitDrafts.delete(repo.folderId); $('git-commit-message').value = ''; commitOutcome = { kind: 'done', folderId: repo.folderId, commit: result.commit }; }
      else if (commitOutcome?.kind === 'done') commitOutcome = null;
      done = true;
    } catch (error) {
      if (act === 'commit') commitOutcome = { kind: 'error', folderId: repo.folderId, message: error.message, output: error.details?.output || '', hooks: Boolean(error.details?.hooks) };
      else api.showNotice(error.message);
      if (error.status === 409) loadGit();
    } finally {
      if (!(keepBusy && done)) { gitWriting = false; if (api.getState().projectId === projectId) renderGit(); }
    }
    return done;
  }
  const currentRepo = () => (gitData?.repositories || []).find(row => row.folderId === $('git-repository').value);
  async function commit(skipHooks = false) {
    let repo = currentRepo();
    const message = $('git-commit-message').value;
    if (!repo || !message.trim() || gitWriting) return;
    // Nothing staged: stage exactly the changes listed, then commit them, as the button says.
    if (!stagedFiles(repo).length) {
      const paths = changedFiles(repo).map(file => file.path);
      if (!paths.length) return;
      gitWriting = 'commit-all';
      if (!await gitWrite('stage', repo, repo.changesClipped ? { all: true } : { paths }, { continuing: true, keepBusy: true })) return;
      repo = currentRepo();
      if (!repo) { gitWriting = false; renderGit(); return; }
    }
    await gitWrite('commit', repo, { message, expected: repo.stagedPaths || [], skipHooks }, { continuing: true });
  }
  $('git-commit').addEventListener('submit', event => { event.preventDefault(); commit(); });
  $('git-commit-message').addEventListener('input', () => {
    const folderId = $('git-commit').dataset.folder; if (folderId) commitDrafts.set(folderId, $('git-commit-message').value);
    const repo = (gitData?.repositories || []).find(row => row.folderId === folderId); if (repo) renderCommit(repo);
  });
  $('git-commit-message').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); if (!$('git-commit-button').disabled) commit(); } });
  async function loadGit() {
    const projectId = api.getState().projectId; if (!projectId || gitBusy) return;
    const request = ++gitRequest; gitBusy = true; gitScope = projectId; $('refresh-git').disabled = true; $('refresh-git').setAttribute('aria-busy', 'true');
    if (!gitData) $('git-content').replaceChildren(el('p', 'Reading local Git activity…', 'inspector-empty'));
    try { const result = await api.api('/api/git', {}, projectId); if (request === gitRequest && api.getState().projectId === projectId) { gitData = result; renderGit(); nextSteps(); } }
    catch (error) { if (request === gitRequest) $('git-content').replaceChildren(el('p', error.message, 'inspector-empty')); }
    finally { if (request === gitRequest) { gitBusy = false; $('refresh-git').disabled = false; $('refresh-git').setAttribute('aria-busy', 'false'); } }
  }
  function setGitPanel(open, remember = true) {
    $('git-panel').hidden = !open; $('open-git').setAttribute('aria-expanded', String(open));
    if (remember) try { localStorage.setItem('throughline:side-panel', open ? 'git' : 'none'); } catch { /* Panel state is a convenience. */ }
    if (open) { window.relayReviews?.closePanel(); window.relayAgents?.close(); loadGit(); }
  }
  $('open-git').addEventListener('click', () => setGitPanel($('git-panel').hidden));
  // One side panel shows at a time, and docked layouts reopen the one last chosen (Agents at first). Narrow layouts
  // overlay it, so it starts closed there.
  function wantsGitPanel() { let preference = null; try { preference = localStorage.getItem('throughline:side-panel'); } catch { /* Defaults apply. */ } return preference === 'git' && Boolean(window.matchMedia?.('(min-width: 1101px)').matches); }
  window.relayGit = { close: () => { if (!$('git-panel').hidden) setGitPanel(false, false); } };

  const diffDialog = $('diff-dialog'), statusNames = { added: 'Added', untracked: 'New file', deleted: 'Deleted', renamed: 'Renamed', modified: 'Modified' };
  let diffRequest = 0;
  async function openDiff(repo, file, status) {
    const projectId = api.getState().projectId, request = ++diffRequest;
    $('diff-title').textContent = file.path; $('diff-meta').replaceChildren(`${repo.name} · ${statusNames[status]}${file.staged ? ' · staged' : ''}`);
    $('diff-content').replaceChildren(el('p', 'Loading changes…', 'inspector-empty'));
    if (!diffDialog.open) diffDialog.showModal();
    try { const result = await api.api(`/api/git/diff?folderId=${encodeURIComponent(repo.folderId)}&path=${encodeURIComponent(file.path)}`, {}, projectId); if (request === diffRequest) renderDiff(result); }
    catch (error) { if (request === diffRequest) $('diff-content').replaceChildren(el('p', error.message, 'inspector-empty')); }
  }
  // A changed image shows as pictures: before and after side by side, or the one side an added or deleted image has.
  function renderImages(images) {
    const view = el('div', undefined, 'diff-images'), size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    for (const [key, label] of [['before', images.after ? 'Before' : 'Deleted'], ['after', images.before ? 'After' : 'Added']]) {
      const side = images[key];
      if (!side) continue;
      const figure = el('figure', undefined, 'diff-image'), frame = el('div', undefined, 'diff-image-frame'), caption = el('figcaption'), facts = el('span', size(side.bytes), 'diff-image-facts');
      if (side.src) {
        const image = el('img'); image.alt = `${label} version`; image.src = side.src;
        image.addEventListener('load', () => { facts.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${size(side.bytes)}`; });
        frame.append(image);
      } else frame.append(el('p', side.tooLarge ? 'Too large to preview.' : 'This file is not a readable image.', 'inspector-empty'));
      caption.append(el('span', label, 'diff-image-label'), facts); figure.append(frame, caption); view.append(figure);
    }
    $('diff-content').replaceChildren(view);
  }
  function renderDiff(result) {
    if (result.images) { renderImages(result.images); return; }
    const lines = el('div', undefined, 'diff-lines'), maxRows = 5000;
    let oldLine = 0, newLine = 0, added = 0, removed = 0, rows = 0, inHunk = false;
    const row = (kind, before, after, text) => { const line = el('div', undefined, 'diff-line ' + kind); line.append(el('span', String(before), 'diff-number'), el('span', String(after), 'diff-number'), el('span', kind === 'add' ? '+' : kind === 'del' ? '-' : '', 'diff-sign'), el('span', text, 'diff-text')); lines.append(line); rows++; };
    for (const line of result.diff.split('\n')) {
      if (line.startsWith('diff --git')) { inHunk = false; continue; }
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { inHunk = true; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); if (rows < maxRows) row('hunk', '', '', line); continue; }
      if (!inHunk) { if (line.startsWith('Binary files')) row('note', '', '', 'Binary file changed. Its contents are not shown.'); continue; }
      if (line.startsWith('+')) { added++; if (rows < maxRows) row('add', '', newLine, line.slice(1)); newLine++; }
      else if (line.startsWith('-')) { removed++; if (rows < maxRows) row('del', oldLine, '', line.slice(1)); oldLine++; }
      else if (line.startsWith(' ')) { if (rows < maxRows) row('context', oldLine, newLine, line.slice(1)); oldLine++; newLine++; }
      else if (line.startsWith('\\') && rows < maxRows) row('note', '', '', line.slice(2));
    }
    if (added || removed) $('diff-meta').append(el('span', ` +${added}`, 'diff-added'), el('span', ` -${removed}`, 'diff-removed'));
    if (!rows) $('diff-content').replaceChildren(el('p', result.directory ? 'This is a new folder. Add its files to Git to review them individually.' : 'No line changes to show. Only file metadata changed.', 'inspector-empty'));
    else { $('diff-content').replaceChildren(lines); if (result.truncated || rows >= maxRows) $('diff-content').append(el('p', 'This change is large. Only the first part is shown.', 'diff-truncated')); }
  }
  $('close-diff').addEventListener('click', () => diffDialog.close());

  // Plan usage for both agents: status bar meters, plus a composer chip for the selected agent and model.
  const usage = {}, usageLoading = {}, usageAttempted = {}, usageErrors = {}, usageRequests = {};
  let usageProvider = null, usageAnchor = null;
  const usagePopover = $('usage-dialog');
  const usageIsOpen = () => usagePopover.matches(':popover-open');
  const remaining = row => Math.max(0, Math.min(100, Math.round(100 - row.usedPercent)));
  const usageLevel = percent => percent <= 10 ? 'critical' : percent <= 25 ? 'low' : 'ok';
  // Limits in plain words. A provider names a limit by its period, and by what it is for when it covers only some
  // models: "5-hour", "Weekly · Opus", "Weekly · Gemini Argon". The composer chip keeps what it is for, or the period.
  const limitParts = label => { const [period, ...scope] = String(label || '').split(' · '); return { period, scope: scope.join(' · ') }; };
  const shortLabel = label => { const { period, scope } = limitParts(label); return scope || period; };
  function limitName(label) {
    const { period, scope } = limitParts(label), name = /^(?:\d+-hour|Weekly|Daily|Current)$/.test(period) ? `${period} limit` : period;
    return scope ? `${name} for ${scope}` : name;
  }
  function resetLabel(value) {
    const at = new Date(value || ''); if (Number.isNaN(at.getTime())) return '';
    return 'resets ' + at.toLocaleString(undefined, at.toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  const describeWindow = row => `${row.label}: ${remaining(row)}% left${resetLabel(row.resetsAt) ? ', ' + resetLabel(row.resetsAt) : ''}`;
  function usageWindows(provider) {
    const state = api.getState(), result = usage[provider]; if (!result?.available || state.accounts?.[provider]?.authenticated !== true) return [];
    let model = String((provider === state.provider ? state.model : state.conversation?.models?.[provider]) || '').toLowerCase();
    if (provider === 'gemini' && (!model || model === 'default')) model = String(result.defaultModel || '').toLowerCase();
    return (result.windows || []).filter(row => Number.isFinite(row.usedPercent) && !row.disabled && (Array.isArray(row.scopes) ? row.scopes.some(scope => model.includes(scope)) : !row.scope || (model && model.includes(row.scope))));
  }
  function renderUsage() {
    const state = api.getState();
    for (const provider of ['codex', 'claude', 'gemini']) {
      const meter = $(`${provider}-usage`), rows = usageWindows(provider);
      meter.closest('.provider-status')?.classList.toggle('selected', state.provider === provider);
      const tightest = rows.reduce((low, row) => !low || remaining(row) < remaining(low) ? row : low, null);
      meter.hidden = !tightest; meter.replaceChildren();
      if (tightest) {
        // The tightest limit: what is left, as a bar, and which limit it is and when it resets.
        const bar = el('i', undefined, 'usage-bar'); bar.style.setProperty('--left', `${remaining(tightest)}%`);
        const reset = resetLabel(tightest.resetsAt);
        meter.dataset.level = usageLevel(remaining(tightest)); meter.append(el('span', `${remaining(tightest)}% left`, 'usage-value'), bar, el('span', `${limitName(tightest.label)}${reset ? ` · ${reset}` : ''}`, 'usage-caption'));
      }
      const row = $(`${provider}-status`), connected = api.getState().accounts?.[provider]?.authenticated === true;
      row.title = rows.length ? `${name(provider)}: ${rows.map(describeWindow).join('. ')}. Select for all its limits.` : connected ? `${name(provider)}: select for its plan usage` : `Set up ${name(provider)} in Settings`;
    }
    const chip = $('usage-chip'), rows = usageWindows(state.provider), tightest = rows.reduce((low, row) => !low || remaining(row) < remaining(low) ? row : low, null);
    chip.hidden = !tightest;
    if (tightest) { chip.className = 'usage-chip ' + usageLevel(remaining(tightest)); chip.replaceChildren(el('span', `${shortLabel(tightest.label)} · `, 'usage-chip-label'), el('span', `${remaining(tightest)}% left`)); chip.title = `${name(state.provider)} plan usage. ${rows.map(describeWindow).join('. ')}.`; }
  }
  async function loadUsage(provider, refresh = false) {
    if (usageLoading[provider] || api.getState().accounts?.[provider]?.authenticated !== true) return;
    const request = usageRequests[provider] = (usageRequests[provider] || 0) + 1;
    usageLoading[provider] = usageAttempted[provider] = true; usageErrors[provider] = null; renderUsageDetails();
    try { const result = await api.api(`/api/providers/${provider}/usage${refresh ? '?refresh=1' : ''}`, {}, null); if (request === usageRequests[provider] && api.getState().accounts?.[provider]?.authenticated === true) { usage[provider] = { ...result, fetchedAt: Date.now() }; api.getState().usage = { ...usage }; } }
    catch (error) { if (request === usageRequests[provider]) usageErrors[provider] = error.message; }
    finally { if (request === usageRequests[provider]) { usageLoading[provider] = false; renderUsage(); renderUsageDetails(); } }
  }
  $('usage-chip').addEventListener('click', () => openUsage(api.getState().provider, $('usage-chip')));
  function resetCountdown(value) {
    const at = new Date(value || ''); if (Number.isNaN(at.getTime())) return 'Reset time not reported';
    const minutes = Math.ceil((at.getTime() - Date.now()) / 60000);
    if (minutes <= 0) return 'Reset time passed · refresh for the current allowance';
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
    return 'Resets in ' + [days ? days + 'd' : '', hours ? hours + 'h' : '', mins ? mins + 'm' : ''].filter(Boolean).join(' ');
  }
  // The card shows only the agent whose meter or chip opened it.
  function renderUsageDetails() {
    if (!usageProvider || !usageIsOpen()) return;
    const state = api.getState(), provider = usageProvider, account = state.accounts?.[provider], result = usage[provider], plan = result?.plan || account?.planType || account?.subscriptionType;
    $('usage-title').textContent = 'Plan usage'; $('usage-plan').textContent = provider === 'gemini' ? 'Reported by Google Antigravity' : `From your own ${name(provider)} account`;
    const section = el('section', undefined, 'usage-provider'), heading = el('div', undefined, 'usage-provider-heading'), icon = el('i', undefined, 'agent-icon ' + provider);
    section.dataset.provider = provider; icon.setAttribute('aria-hidden', 'true');
    heading.append(icon, el('h3', name(provider))); if (plan) heading.append(el('span', String(plan).replace(/[_-]/g, ' '), 'usage-plan-badge'));
    section.append(heading);
    const rows = result?.available && account?.authenticated === true ? (result.windows || []).filter(row => Number.isFinite(row.usedPercent) || Number.isFinite(row.remainingAmount) || row.disabled || row.status) : [];
    for (const row of rows) {
      const percent = Number.isFinite(row.usedPercent) && !row.disabled, left = percent ? remaining(row) : null, item = el('div', undefined, 'usage-window-row'), top = el('div', undefined, 'usage-window-top'), bottom = el('div', undefined, 'usage-window-bottom');
      item.dataset.level = percent ? usageLevel(left) : 'unknown';
      const value = row.disabled ? 'Disabled' : percent ? `${left}% left` : Number.isFinite(row.remainingAmount) ? `${row.remainingAmount.toLocaleString()} units left` : row.status;
      top.append(el('span', row.label, 'usage-window-label'), el('strong', value)); bottom.append(el('span', row.disabled ? row.statusDescription || 'Quota limit disabled by the provider' : resetCountdown(row.resetsAt)));
      const at = new Date(row.resetsAt || '');
      if (!Number.isNaN(at.getTime())) { const time = el('time', at.toLocaleString(undefined, at.toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' })); time.setAttribute('datetime', at.toISOString()); time.title = at.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }); bottom.append(time); }
      item.append(top);
      if (percent) { const track = el('div', undefined, 'usage-track'), fill = el('i'); fill.style.width = left + '%'; track.append(fill); track.setAttribute('role', 'img'); track.setAttribute('aria-label', `${left}% of the ${row.label} allowance left`); item.append(track); }
      item.append(bottom); section.append(item);
    }
    if (!rows.length) section.append(el('p', usageLoading[provider] ? 'Reading the current allowance…' : account?.authenticated === false ? 'Not signed in' : result?.reason || 'Not reported for this account.', 'usage-empty'));
    if (usageErrors[provider]) section.append(el('p', 'Could not refresh. ' + usageErrors[provider] + (result?.fetchedAt ? ' The last successful reading is shown.' : ''), 'usage-error'));
    $('usage-details').replaceChildren(section);
    const checked = result?.fetchedAt || 0, busy = Boolean(usageLoading[provider]);
    $('usage-updated').textContent = checked ? 'Checked ' + new Date(checked).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ' · reset times in your time zone' : 'Reported by each provider';
    $('refresh-usage').disabled = busy; $('refresh-usage').textContent = busy ? 'Refreshing…' : 'Refresh';
    positionUsage();
  }
  function positionUsage() {
    if (!usageIsOpen() || !usageAnchor) return;
    const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight, gap = 10, edge = 12;
    const width = Math.min(340, viewportWidth - edge * 2);
    usagePopover.style.width = width + 'px'; usagePopover.style.maxHeight = (viewportHeight - edge * 2) + 'px';
    const anchor = usageAnchor.getBoundingClientRect(), height = usagePopover.getBoundingClientRect().height;
    const above = anchor.top - gap - height, below = anchor.bottom + gap;
    const top = above >= edge ? above : below + height <= viewportHeight - edge ? below : Math.max(edge, viewportHeight - edge - height);
    usagePopover.style.left = Math.max(edge, Math.min(anchor.left, viewportWidth - width - edge)) + 'px';
    usagePopover.style.top = top + 'px';
  }
  function closeUsage(restoreFocus = false) {
    if (usageIsOpen()) usagePopover.hidePopover();
    usageAnchor?.setAttribute('aria-expanded','false');
    if (restoreFocus) usageAnchor?.focus();
  }
  function openUsage(provider, anchor) {
    const row = $(`${provider}-status`), nextAnchor = anchor || (row && !row.closest?.('[hidden]') ? row : $('usage-chip') && !$('usage-chip').hidden ? $('usage-chip') : $('relay-settings'));
    if (usageIsOpen() && provider === usageProvider && nextAnchor === usageAnchor) { closeUsage(); return; }
    usageAnchor?.setAttribute('aria-expanded','false'); usageProvider = provider; usageAnchor = nextAnchor;
    usageAnchor.setAttribute('aria-expanded','true');
    if (!usageIsOpen()) usagePopover.showPopover();
    renderUsageDetails(); positionUsage(); loadUsage(provider,true);
  }
  // The highest share of a plan limit used, for Auto (#12); null when the agent reports no usage.
  const usedPercent = provider => {
    const result = usage[provider]; if (!result?.available || api.getState().accounts?.[provider]?.authenticated !== true) return null;
    const rows = (result.windows || []).filter(row => Number.isFinite(row.usedPercent) && !row.disabled && !row.scope && !row.scopes);
    return rows.length ? Math.max(...rows.map(row => row.usedPercent)) : null;
  };
  window.relayUsage = { open: openUsage, usedPercent };
  for (const trigger of [$('codex-status'), $('claude-status'), $('gemini-status'), $('usage-chip')]) { trigger.setAttribute('aria-controls','usage-dialog'); trigger.setAttribute('aria-haspopup','dialog'); trigger.setAttribute('aria-expanded','false'); }
  usagePopover.addEventListener('toggle',() => { if (!usageIsOpen()) usageAnchor?.setAttribute('aria-expanded','false'); });
  $('close-usage').addEventListener('click',()=>closeUsage(true));
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && usageIsOpen()){event.preventDefault();closeUsage(true);}});
  document.addEventListener('scroll',positionUsage,true); window.addEventListener('resize',positionUsage);
  $('refresh-usage').addEventListener('click',()=>{ if (usageProvider) loadUsage(usageProvider,true); });
  setInterval(renderUsageDetails,60000);
  $('refresh-git').addEventListener('click', loadGit); $('git-repository').addEventListener('change', () => { api.selectFolder?.($('git-repository').value); renderGit(); });
  $('git-changes-tab').addEventListener('click', () => { gitView = 'changes'; renderGit(); }); $('git-commits-tab').addEventListener('click', () => { gitView = 'commits'; renderGit(); });

  let runningProject = null, lastFolder = null;
  function render() {
    if (lastFolder !== api.selectedFolderId?.()) { lastFolder = api.selectedFolderId?.(); if (gitData) renderGit(); }
    const state = api.getState(); modelControls(); progress();
    for (const provider of ['codex', 'claude', 'gemini']) {
      if (state.accounts?.[provider]?.authenticated === false && (usage[provider] || usageAttempted[provider] || usageLoading[provider])) { usageRequests[provider] = (usageRequests[provider] || 0) + 1; delete usage[provider]; delete usageAttempted[provider]; delete usageErrors[provider]; usageLoading[provider] = false; state.usage = { ...usage }; }
      if (state.accounts?.[provider]?.authenticated === true && !usageAttempted[provider]) loadUsage(provider);
    }
    // A finished run changes files and consumes usage.
    const running = state.conversation?.status === 'running' ? state.projectId : null;
    if (runningProject && runningProject === state.projectId && !running) { if (!$('git-panel').hidden) loadGit(); for (const provider of ['codex', 'claude', 'gemini']) loadUsage(provider, true); }
    runningProject = running;
    renderUsage(); renderUsageDetails();
    if (state.ready && (state.status?.providers?.[state.provider]?.available || state.accounts?.[state.provider]?.available || state.accounts?.[state.provider]?.installed) && state.accounts?.[state.provider]?.authenticated === true && !catalog[state.provider] && !attemptedModels[state.provider] && !loadingModels[state.provider]) loadModels();
    $('open-git').disabled = !state.projectId;
    if (lastProject !== state.projectId) {
      lastProject = state.projectId; $('custom-model-editor').hidden = true; gitData = null; gitRequest++; gitBusy = false; $('git-repository').replaceChildren(); $('git-summary').replaceChildren(); $('git-updated').textContent = '';
      // There is nothing to inspect without a workspace.
      if (!state.projectId) { $('git-panel').hidden = true; $('open-git').setAttribute('aria-expanded', 'false'); }
      else if (!$('git-panel').hidden) loadGit();
      else if (wantsGitPanel()) setGitPanel(true, false);
      if (diffDialog.open) { diffRequest++; diffDialog.close(); }
    }
    const completed = state.conversation?.lastRun;
    const key = completed?.status === 'complete' && completed.purpose !== 'review' ? nextStepsKey() : null;
    if (key && key !== inspectedRun) { inspectedRun = key; loadGit(); }
    nextSteps();
  }
  window.addEventListener('relay-state', render);
  window.addEventListener('relay-account', event => { const provider = event.detail?.provider || api.getState().provider; delete catalog[provider]; delete attemptedModels[provider]; modelSignature = ''; modelControls(); });
  setInterval(() => { if (!document.hidden) progress(); }, 1000);
  setInterval(() => { if (!document.hidden && !$('git-panel').hidden && !gitBusy && !gitWriting && gitScope === api.getState().projectId) loadGit(); }, 15000);
  setInterval(() => { if (!document.hidden) for (const provider of ['codex', 'claude', 'gemini']) if (Date.now() - (usage[provider]?.fetchedAt || 0) > 300000) loadUsage(provider); }, 60000);
  render();
})();

(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = () => window.relayUI;
  const modal = $('workbench'), content = $('workbench-content'), error = $('workbench-error');
  let renderRevision = 0;
  // Ask a friend: asking another person for help, reviewing what they send back, and helping someone else. Settings
  // has a dialog of its own (settings.js); this module also draws the approval cards above the message box.
  let tab = 'request', busy = false, projectScope = null;
  const page = {
    request: ['Ask a friend', 'Ask another person for help. They work in their own workspace and send back changes for you to review.'],
    solutions: ['Ask a friend', 'Your shared requests, and the changes your friends send back for you to review.'],
    friend: ['Ask a friend', 'Open someone’s request in your workspace and send back your proposed changes.'],
  };
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const field = (label, type = 'input', value = '') => { const l = node('label', label), i = node(type); i.value = value; l.append(i); return { l, i }; };
  const button = (text, fn, cls) => { const b = node('button', text, cls); b.type = 'button'; b.addEventListener('click', () => perform(fn)); return b; };
  const lines = input => input.split('\n').map(s => s.trim()).filter(Boolean);
  const describe = value => JSON.stringify(value, null, 2);
  const post = (path, value = {}, projectId) => api().post('/api/collaboration' + path, value, projectId ?? projectScope);
  const get = (path, projectId) => api().api('/api/collaboration' + path, {}, projectId ?? projectScope);
  const providerName = provider => provider === 'gemini' ? 'Gemini' : provider === 'codex' ? 'Codex' : 'Claude';
  const bytes = count => count < 1024 ? `${count} B` : `${(count / 1024).toFixed(count < 10240 ? 1 : 0)} KB`;
  const date = value => { if (!value) return ''; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const download = (name, value) => { const a = node('a'), url = URL.createObjectURL(new Blob([describe(value)], { type: 'application/json' })); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  async function perform(fn) {
    if (busy) return; busy = true; error.hidden = true; modal.setAttribute('aria-busy', 'true');
    try { await fn(); } catch (e) { error.textContent = e.message || 'This action could not be completed. Please try again.'; error.hidden = false; }
    finally { busy = false; modal.removeAttribute('aria-busy'); }
  }
  function section(title, text, parent = content) { const s = node('section', undefined, 'workbench-section'); s.append(node('h3', title)); if (text) s.append(node('p', text, 'section-description')); parent.append(s); return s; }
  function details(parent, title, text) { const d = node('details', undefined, 'workbench-details'); d.append(node('summary', title)); if (text) d.append(node('p', text, 'muted')); parent.append(d); return d; }
  function check(text) { const l = node('label', undefined, 'review-check'), i = node('input'); i.type = 'checkbox'; l.append(i, document.createTextNode(text)); return { l, i }; }
  function output(parent, value) { const pre = node('pre', typeof value === 'string' ? value : describe(value), 'review-output'); parent.append(pre); return pre; }
  function diagnostics(parent, value, label = 'Technical details') { const d = details(parent, label); output(d, value); return d; }
  function actions(parent, ...buttons) { const group = node('div', undefined, 'workbench-actions'); group.append(...buttons); parent.append(group); return group; }
  function notice(parent, text, kind = 'success') { parent.querySelector('.workbench-feedback')?.remove(); const message = node('p', text, 'workbench-feedback ' + kind); message.setAttribute('role', 'status'); parent.append(message); return message; }
  function badge(text, kind = '') { return node('span', text, 'workbench-badge ' + kind); }
  function empty(parent, title, text) { const box = node('div', undefined, 'workbench-empty'); box.append(node('h4', title), node('p', text)); parent.append(box); return box; }
  function list(parent, items, fallback) { if (!items?.length) { parent.append(node('p', fallback || 'None provided.', 'muted')); return; } const ul = node('ul', undefined, 'workbench-list'); for (const item of items) ul.append(node('li', item)); parent.append(ul); }
  async function open(next = 'request') { if (busy) return; tab = next; error.hidden = true; if (!modal.open) modal.showModal(); await perform(render); }
  async function render() {
    ++renderRevision; projectScope = api().getState().projectId; content.replaceChildren();
    const [title, description] = page[tab] || page.request; $('workbench-title').textContent = title;
    if ($('workbench-description')) $('workbench-description').textContent = description;
    document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
    if (!projectScope) { empty(content, 'Choose a workspace first', 'Add a workspace from the sidebar to use this feature.'); return; }
    if (tab === 'request') return request(); if (tab === 'solutions') return solutions(); if (tab === 'friend') return friend();
  }

  async function request() {
    const token = renderRevision, projectId = projectScope, state = api().getState(), c = await api().ensureConversation();
    if (token !== renderRevision || projectId !== api().getState().projectId) return;
    const project = state.projects.find(item => item.id === projectId);
    const recent = (c.messages || []).filter(message => ['user', 'assistant'].includes(message.role) && !message.reviewId).slice(-8);
    const latestTask = recent.filter(message => message.role === 'user').at(-1)?.text;
    const latestError = (c.messages || []).filter(message => message.role === 'error').at(-1)?.text;
    let prepared = null, approved = null, sourceFiles = [], previewVersion = 0, config = {}, privacyWarnings = false;
    const current = () => token === renderRevision && projectId === api().getState().projectId;
    const card = section('Help request', 'Includes your task and the recent conversation. Review this preview, then export it or share a private link.'); card.classList.add('friend-ready-card');
    const message = field('What you need help with', 'textarea', (c.context?.goal || latestTask || `Help with ${project?.name || 'this project'}`).slice(0, 2000)); message.i.rows = 2; card.append(message.l);
    const context = node('p', `${recent.length} recent messages · ${project?.name || 'Current workspace'} · No source files included yet`, 'friend-context'); card.append(context);
    const files = check('Include changed source files'); files.i.disabled = true; card.append(files.l);
    const included = node('div', undefined, 'friend-source-list'); included.hidden = true; card.append(included);
    const preview = node('div', undefined, 'friend-ready-preview'), feedback = node('div');
    const privacy = node('p', undefined, 'scan-warning'), privacyAck = check('I reviewed the privacy warnings in this preview.'); privacy.hidden = privacyAck.l.hidden = true; card.append(privacy, privacyAck.l);
    const exactPreview = details(card, 'Preview shared content'); exactPreview.append(preview); card.append(feedback);
    const share = button('Create private link', () => deliver(true), 'primary'), exportFile = button('Export request file', () => deliver(false), 'secondary');
    share.disabled = exportFile.disabled = true;
    const refresh = button('Refresh preview', build, 'secondary'); refresh.hidden = true;
    actions(card, refresh, exportFile, share);
    const disclosure = node('p', 'Only the previewed content is shared when you choose an action. Check the preview for private information; automatic scanning can miss it.', 'muted'); card.append(disclosure);
    privacyAck.i.addEventListener('change', () => { exportFile.disabled = !prepared || privacyWarnings && !privacyAck.i.checked; share.disabled = exportFile.disabled || !config.baseUrl; });
    function invalidate() { prepared = approved = null; ++previewVersion; share.disabled = exportFile.disabled = true; refresh.hidden = false; }
    message.i.addEventListener('input', invalidate);
    files.i.addEventListener('change', () => { invalidate(); included.hidden = !files.i.checked; perform(build); });
    async function build() {
      if (!current()) return;
      const revision = ++previewVersion; prepared = approved = null; share.disabled = exportFile.disabled = true;
      message.i.disabled = files.i.disabled = true; preview.replaceChildren(node('p', 'Preparing your help request…', 'muted'));
      try {
        const result = await post('/handoffs/prepare', { conversationId:c.id, mode:files.i.checked ? 'source' : 'context', goal:message.i.value.trim(), problem:(latestError || 'Please review the current task and help with the next steps.').slice(0, 2000), expectedOutcome:'Explain the issue and propose changes I can review.', decisions:c.context?.decisions || [], tasks:c.context?.tasks || [], messageIds:recent.map(item => item.id), files:files.i.checked ? sourceFiles : [], newPaths:[] }, projectId);
        if (!current() || revision !== previewVersion) return;
        prepared = result; preview.replaceChildren(); packagePreview(preview, result.package);
        const warnings = (result.warnings || []).filter(item => item.code !== 'review');
        privacyWarnings = warnings.length > 0; privacy.hidden = privacyAck.l.hidden = !privacyWarnings; privacyAck.i.checked = false; privacy.textContent = privacyWarnings ? `${warnings.length} privacy warning${warnings.length === 1 ? '' : 's'} to inspect before sharing.` : ''; if (privacyWarnings) exactPreview.open = true;
        for (const warning of warnings) preview.append(node('p', typeof warning === 'string' ? warning : warning.message || 'Review possible private information.', 'scan-warning'));
        context.textContent = `${result.package.messages.length} recent messages · ${result.package.files.length} source file${result.package.files.length === 1 ? '' : 's'} · Ready for your review`;
        exportFile.disabled = privacyWarnings; share.disabled = privacyWarnings || !config.baseUrl; refresh.hidden = true;
      } finally { if (current()) { message.i.disabled = false; files.i.disabled = !sourceFiles.length; } }
    }
    async function deliver(publish) {
      if (!current() || !prepared) throw Error('Refresh and review this preview before sharing.');
      if (privacyWarnings && !privacyAck.i.checked) throw Error('Inspect the privacy warnings before sharing this preview.');
      const exact = prepared;
      if (!approved) approved = await post('/handoffs/approve', { conversationId:c.id, package:exact.package, approvedIntegrity:exact.package.integrity }, projectId);
      if (!current() || prepared !== exact) return;
      feedback.replaceChildren();
      if (publish) {
        const delivery = await post(`/handoffs/${approved.id}/publish`, {}, projectId);
        if (current()) { deliverySummary(feedback, delivery); notice(feedback, 'Private link created. Use Copy link to send it to your friend.', 'info'); }
      } else { download(`request-${approved.id}.json`, approved.package); notice(feedback, 'Request exported. Send the file to your friend.'); }
    }
    try {
      const results = await Promise.allSettled([api().api('/api/git', {}, projectId), api().api('/api/sharing/config', {}, null)]);
      if (!current()) return;
      const git = results[0].status === 'fulfilled' ? results[0].value : null; config = results[1].status === 'fulfilled' ? results[1].value : {};
      for (const repo of git?.repositories || []) for (const file of repo.changes || []) {
        if (sourceFiles.length >= 8 || file.reason || file.code?.includes('D') || /(?:^|\/)(?:\.git|node_modules|\.env(?:\.[^/]*)?)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i.test(file.path)) continue;
        const folder = project?.folders?.find(item => item.id === repo.folderId); if (!folder) continue;
        const name = project.folders.length > 1 ? folder.name + '/' + file.path : file.path;
        sourceFiles.push(name); included.append(node('p', name));
      }
      files.l.lastChild.textContent = sourceFiles.length ? `Include ${sourceFiles.length} changed source file${sourceFiles.length === 1 ? '' : 's'}` : 'No changed source files to include';
      if (!config.baseUrl) { share.title = 'Configure a private-link service under Returned solutions.'; card.append(node('p', 'Export works immediately. Private links need a sharing service.', 'muted')); }
      await build();
    } catch (error) { if (current()) { preview.replaceChildren(node('p', error.message, 'scan-warning')); refresh.hidden = false; } }
    if (!current()) return;
    const advanced = details(content, 'Advanced request editor', 'Choose exact messages and file paths, or edit the outgoing package.');
    const editor = node('div'); advanced.append(editor); await advancedRequest(editor);
  }

  async function advancedRequest(host) {
    const state = api().getState(), c = await api().ensureConversation(); let prepared = null;
    const overview = node('div', undefined, 'friend-workflow'); for (const text of ['1 · Prepare & review', '2 · Share with a person', '3 · Review returned changes']) overview.append(node('span', text)); host.append(overview);
    const s = section('1. Describe what you need', 'A useful request gives your friend a clear goal and a specific problem.', host);
    const goal = field('Goal', 'textarea', c.context?.goal || ''), problem = field('What is blocking you?', 'textarea'), expected = field('What should happen?', 'textarea');
    goal.i.placeholder = 'What are you trying to achieve?'; problem.i.placeholder = 'Include the relevant error or unexpected behavior.'; expected.i.placeholder = 'Describe the result you want.';
    s.append(goal.l, problem.l, expected.l);
    const extra = details(s, 'Add decisions and unfinished tasks');
    const decisions = field('Decisions — one per line', 'textarea', (c.context?.decisions || []).join('\n')), tasks = field('Unfinished tasks — one per line', 'textarea', (c.context?.tasks || []).join('\n')); extra.append(decisions.l, tasks.l);
    const sharing = section('2. Choose what to include', undefined, host);
    const mode = field('Sharing mode', 'select');
    for (const [value, label] of [['context', 'Description and selected messages'], ['source', 'Include selected source files']]) { const option = node('option', label); option.value = value; mode.i.append(option); }
    sharing.append(mode.l, node('p', 'Only the items you select are included. The rest of your workspace stays on your computer.', 'muted'));
    const messageDetails = details(sharing, `Choose messages and tool output (${(c.messages || []).length} available)`);
    const selections = [], messages = node('div', undefined, 'message-selections');
    for (const message of c.messages || []) { const item = check(`${message.role === 'user' ? 'You' : message.provider ? providerName(message.provider) : message.role}: ${message.text.slice(0, 240)}${message.text.length > 240 ? '…' : ''}`); selections.push({ id: message.id, input: item.i }); messages.append(item.l); }
    if (!selections.length) messages.append(node('p', 'There are no messages to include yet.', 'muted')); messageDetails.append(messages);
    const source = node('div', undefined, 'source-selection'); source.hidden = true;
    const roots = state.projects.find(project => project.id === state.projectId)?.folders || [];
    if (roots.length > 1) source.append(node('p', 'Start paths with the folder name: ' + roots.map(folder => folder.name + '/').join(', ') + '.', 'muted'));
    const files = field('Source paths — one text file per line', 'textarea'), newPaths = field('Permitted new file paths — one per line', 'textarea');
    files.i.placeholder = roots.length > 1 ? `${roots[0].name}/src/app.js` : 'src/app.js'; newPaths.i.placeholder = 'Optional: files your friend may propose creating.'; source.append(files.l, newPaths.l); sharing.append(source);
    const preview = section('3. Review the outgoing request', 'Read the content below before approving. Approval saves this request locally; sharing is a separate action.', host); preview.hidden = true;
    const human = node('div', undefined, 'package-preview'), warnings = node('div', undefined, 'package-warnings');
    const advanced = details(preview, 'Advanced: edit the exact package', 'The package below is the complete data that will be exported or shared. After editing it, refresh the preview to review the updated content.');
    const json = field('Editable package JSON', 'textarea'); json.i.className = 'package-editor'; json.i.spellcheck = false;
    const ack = check('I inspected the exact package, inventory and warnings. I approve sharing this content.');
    const approve = button('Approve exact package', async () => {
      if (!ack.i.checked) throw Error('Review the outgoing request and check the approval box first.');
      if (!prepared || json.i.value !== describe(prepared.package)) throw Error('Refresh the edited preview before approving.');
      const approved = await post('/handoffs/approve', { conversationId: c.id, package: prepared.package, approvedIntegrity: prepared.package.integrity });
      showApproved(preview, approved);
    }, 'primary'); approve.disabled = true;
    function showPrepared(result) {
      prepared = result; preview.hidden = false; json.i.value = describe(result.package); human.replaceChildren(); warnings.replaceChildren(); preview.querySelector('.approved-actions')?.remove();
      packagePreview(human, result.package);
      for (const warning of result.warnings || []) { if (warning.code === 'review') continue; const text = typeof warning === 'string' ? warning : warning.message || 'Review possible private information.'; warnings.append(node('p', text + (warning.location ? ` (${warning.location})` : ''), 'scan-warning')); }
      warnings.append(node('p', 'Check transcripts and source for credentials or private information. Automated scanning may miss them.', 'muted'));
      ack.i.checked = false; approve.disabled = false;
    }
    function invalidate() { if (prepared) { prepared = null; preview.hidden = true; approve.disabled = true; } }
    for (const input of [goal.i, problem.i, expected.i, decisions.i, tasks.i, files.i, newPaths.i, ...selections.map(item => item.input)]) input.addEventListener('input', invalidate);
    mode.i.addEventListener('change', () => { source.hidden = mode.i.value !== 'source'; invalidate(); });
    json.i.addEventListener('input', () => { ack.i.checked = false; approve.disabled = true; });
    advanced.append(json.l, button('Refresh edited preview', async () => { if (!prepared) throw Error('Prepare a preview first.'); showPrepared(await post('/handoffs/prepare', { conversationId: c.id, draft: JSON.parse(json.i.value) })); }));
    preview.replaceChildren(node('h3', '3. Review the outgoing request'), node('p', 'Read the content below before approving. Approval saves the request locally; sharing is a separate action.', 'section-description'), human, warnings, advanced, ack.l);
    actions(preview, approve);
    actions(sharing, button('Prepare offline preview', async () => showPrepared(await post('/handoffs/prepare', { conversationId: c.id, mode: mode.i.value, goal: goal.i.value, problem: problem.i.value, expectedOutcome: expected.i.value, decisions: lines(decisions.i.value), tasks: lines(tasks.i.value), messageIds: selections.filter(item => item.input.checked).map(item => item.id), files: mode.i.value === 'source' ? lines(files.i.value) : [], newPaths: mode.i.value === 'source' ? lines(newPaths.i.value) : [] })), 'primary'));
  }
  function packagePreview(parent, value) {
    const fileCount = value.files.length, messageCount = value.messages.length, newCount = value.baseline.filter(file => file.sha256 === null).length;
    const inventory = node('div', undefined, 'package-inventory');
    for (const text of [`${messageCount} message${messageCount === 1 ? '' : 's'}`, `${fileCount} source file${fileCount === 1 ? '' : 's'}`, `${newCount} proposed new file${newCount === 1 ? '' : 's'}`, bytes(new Blob([describe(value)]).size)]) inventory.append(badge(text)); parent.append(inventory);
    for (const [key, label] of [['goal', 'Goal'], ['problem', 'Problem'], ['expectedOutcome', 'Expected outcome']]) if (value[key]) { const block = node('div', undefined, 'preview-text'); block.append(node('h4', label), node('p', value[key])); parent.append(block); }
    for (const [key, label] of [['decisions', 'Decisions'], ['tasks', 'Unfinished tasks']]) if (value[key]?.length) { parent.append(node('h4', label)); list(parent, value[key]); }
    if (messageCount) { const included = details(parent, `Read ${messageCount} selected message${messageCount === 1 ? '' : 's'}`); for (const message of value.messages) { const entry = node('article', undefined, 'preview-message'); entry.append(node('h4', message.provider ? providerName(message.provider) : message.role), node('p', message.text)); included.append(entry); } }
    if (fileCount) { parent.append(node('h4', 'Included source')); for (const file of value.files) { const entry = details(parent, `${file.path} · ${bytes(new Blob([file.content]).size)}`); output(entry, file.content); } }
    const absent = value.baseline.filter(file => file.sha256 === null); if (absent.length) { parent.append(node('h4', 'Permitted new files')); list(parent, absent.map(file => file.path)); }
  }
  function showApproved(parent, handoff) {
    parent.querySelector('.approved-actions')?.remove(); const area = node('div', undefined, 'approved-actions'); area.append(badge('Ready to share', 'positive'), node('p', 'Export the request and send the file to your friend. They choose Help someone in Codeshi, import it, and return a solution file. Review it in Returned solutions before applying any changes.'));
    const delivery = node('div');
    const link = button('Checking link service…', async () => { const result = await post(`/handoffs/${handoff.id}/publish`); delivery.replaceChildren(); deliverySummary(delivery, result); }, 'primary'); link.disabled = true;
    const hint = node('p', 'Request and solution files work without a sharing service.', 'muted');
    actions(area, button('Export approved request', () => download(`request-${handoff.id}.json`, handoff.package), 'primary'), link, button('View shared requests', async () => { tab = 'solutions'; await render(); }));
    api().api('/api/sharing/config', {}, null).then(config => { link.textContent = config.baseUrl ? 'Create private link' : 'Link service not configured'; link.disabled = !config.baseUrl; if (!config.baseUrl) hint.textContent = 'Private links need a sharing service. Export a file now, or configure the service under Returned solutions.'; }).catch(()=>{link.textContent='Link service unavailable';});
    area.append(hint,delivery); parent.append(area);
  }
  const deliveryLabel = delivery => !delivery ? 'Ready to share' : ({ pending: 'Link creation pending', published: 'Link active', active: 'Link active', revoked: 'Link revoked', expired: 'Link expired', failed: 'Sharing needs attention' }[delivery.status] || (delivery.viewURL ? 'Link active' : 'Ready to share'));
  function addLink(parent, delivery) {
    if (!delivery?.viewURL || ['revoked', 'expired'].includes(delivery.status)) return;
    const link = field(delivery.localOnly ? 'Local test link · this computer only' : 'Private link', 'input', delivery.viewURL); link.i.readOnly = true; link.l.className = 'share-link';
    parent.append(link.l); actions(parent, button('Copy link', async () => { await navigator.clipboard.writeText(delivery.viewURL); notice(parent, 'Link copied. Anyone with this link can view the request and submit a solution.'); }));
  }
  function deliverySummary(parent, delivery) { parent.append(badge(deliveryLabel(delivery), delivery?.status === 'pending' ? 'warning' : 'positive')); if (delivery?.expiresAt) parent.append(node('p', 'Expires ' + date(delivery.expiresAt), 'muted')); if (delivery?.lastError) parent.append(node('p', delivery.lastError, 'scan-warning')); addLink(parent, delivery); }

  async function solutions() {
    const [config, handoffs, received] = await Promise.all([api().api('/api/sharing/config'), get('/handoffs'), get('/solutions')]);
    const inbox = section('Solutions to review');
    if (!received.length) empty(inbox, 'No returned solutions yet', 'Retrieve responses from a shared request below, or import a solution file your friend sent you.');
    for (const record of received) {
      const row = node('article', undefined, 'handoff-card'); const status = { received: 'Ready for review', applied: 'Applied', failed: 'Needs recovery', recovered: 'Recovered', 'recovery-conflict': 'Recovery needs attention' }[record.status] || record.status;
      row.append(badge(status, record.status === 'applied' ? 'positive' : ''), node('h4', record.solution.explanation.slice(0, 160) || 'Returned solution'), node('p', `${record.solution.patch.files.length} proposed file change${record.solution.patch.files.length === 1 ? '' : 's'} · ${date(record.receivedAt || record.createdAt)}`, 'muted'));
      actions(row, button('Review changes', () => reviewSolution(record), 'primary')); inbox.append(row);
    }
    const imported = details(inbox, 'Import a solution file'); imported.append(node('p', 'Use the solution JSON exported by your friend. Explanations without a patch can also be saved for review.', 'muted'));
    const input = field('Solution JSON', 'textarea'); input.i.className = 'package-editor'; imported.append(input.l, fileInput(input.i)); actions(imported, button('Receive solution', async () => { await post('/solutions/receive', { solution: JSON.parse(input.i.value) }); await render(); }, 'primary'));
    const requests = section('Your shared requests'); const outgoing = handoffs.filter(handoff => handoff.direction === 'outgoing');
    if (!outgoing.length) { const blank = empty(requests, 'Share a focused request', 'Prepare a request when you want another person to help with this workspace.'); actions(blank, button('Prepare a request', async () => { tab = 'request'; await render(); }, 'primary')); }
    for (const handoff of outgoing) {
      const row = node('article', undefined, 'handoff-card'); row.append(node('h4', handoff.package.goal || 'Help request')); deliverySummary(row, handoff.delivery);
      const controls = [button('Export request', () => download(`request-${handoff.id}.json`, handoff.package))];
      const delivery = handoff.delivery, revoked = ['revoked', 'expired'].includes(delivery?.status);
      if (!delivery || delivery.status === 'pending' || delivery.status === 'failed') { const publish = button(config.baseUrl ? delivery?.status === 'pending' ? 'Retry link creation' : 'Create private link' : 'Link service not configured', async () => { await post(`/handoffs/${handoff.id}/publish`); await render(); }, 'primary'); publish.disabled = !config.baseUrl; controls.unshift(publish); }
      if (delivery?.viewURL && !revoked) {
        controls.unshift(button('Retrieve solutions', async () => { const result = await post(`/handoffs/${handoff.id}/retrieve`); await render(); if (result.rejected?.length) { error.textContent = 'Some submissions could not be accepted: ' + result.rejected.map(item => item.error).join('; '); error.hidden = false; } else notice(content, result.solutions?.length ? `Retrieved ${result.solutions.length} solution${result.solutions.length === 1 ? '' : 's'}.` : 'No new solutions have been submitted.'); }, 'primary'));
        controls.push(button('Revoke link', async () => { await post(`/handoffs/${handoff.id}/revoke`); await render(); }, 'quiet-danger'));
      }
      actions(row, ...controls); diagnostics(row, { requestId: handoff.id, createdAt: handoff.createdAt, delivery: handoff.delivery }, 'Request details'); requests.append(row);
    }
    const service = details(content, 'Sharing service settings', 'Private links require a separate HTTPS sharing service. You can exchange request and solution files without one.');
    const url = field('Service URL', 'input', config.baseUrl || ''); url.i.placeholder = 'https://your-sharing-service.example'; service.append(url.l); actions(service, button('Save service URL', async () => { await api().post('/api/sharing/config', { baseUrl: url.i.value }); notice(service, 'Sharing service saved.'); }));
    if (!config.baseUrl && outgoing.length) notice(requests, 'To create a link, add your sharing service in the settings below. Exporting a request file works without a service.', 'info');
  }
  function fileInput(target) { const label = node('label', 'Or choose a JSON file'), input = node('input'); input.type = 'file'; input.accept = '.json,application/json'; input.addEventListener('change', () => perform(async () => { const file = input.files[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) throw Error('Choose a file smaller than 2 MB.'); target.value = await file.text(); target.dispatchEvent(new Event('input')); })); label.append(input); return label; }
  async function reviewSolution(record) {
    content.replaceChildren(); const preview = await get(`/solutions/${record.id}/preview`);
    actions(content, button('← Back to solutions', render));
    const overview = section('Proposed solution'); overview.append(node('p', record.solution.explanation, 'solution-explanation'));
    const background = details(overview, 'Assumptions and contributor checks'); background.append(node('h4', 'Assumptions')); list(background, record.solution.assumptions, 'No assumptions provided.'); background.append(node('h4', 'Reported by your friend')); list(background, record.solution.verification, 'No contributor checks reported.'); background.append(node('p', 'These results were supplied by the contributor. Local checks are recorded separately below.', 'muted'));
    const changes = section('Review file changes');
    const status = { applicable: 'Ready to apply', stale: 'Files changed since this request', applied: 'Already applied', 'recovery-required': 'Recovery required', instructions: 'Explanation only' }[preview.status] || preview.status; changes.append(badge(status, preview.status === 'stale' ? 'warning' : preview.status === 'applied' ? 'positive' : ''));
    for (const conflict of preview.conflicts || []) { const box = node('p', undefined, 'scan-warning'); box.append(node('strong', conflict.path + ': '), document.createTextNode(conflict.reason || 'The local file no longer matches the approved baseline.')); changes.append(box); }
    for (const file of preview.files) { const detail = details(changes, `${{ create: 'Add', replace: 'Update', delete: 'Delete' }[file.operation] || file.operation} ${file.path}`); detail.open = true; output(detail, file.diff || `BEFORE\n${file.before ?? '(absent)'}\nAFTER\n${file.after ?? '(deleted)'}`); }
    if (!preview.files.length) changes.append(node('p', 'This solution contains an explanation and no file changes.'));
    if (preview.status === 'applicable' && preview.files.length) { const ack = check('I reviewed these changes and want to apply this exact solution.'); changes.append(ack.l); actions(changes, button('Apply reviewed patch', async () => { if (!ack.i.checked) throw Error('Check the approval box after reviewing the diff.'); await post(`/solutions/${record.id}/apply`, { approvedIntegrity: record.solution.integrity }); await api().refresh(); const latest = await get(`/solutions/${record.id}`); await reviewSolution(latest); notice(content, 'The reviewed changes were applied. A recovery checkpoint has been saved.'); }, 'primary')); }
    if (preview.application) { const recovery = details(changes, 'Recover the affected files', 'Restore the files changed by this solution. Newer local edits are preserved when a safe restore is not possible.'); actions(recovery, button('Recover affected files', async () => { const result = await post(`/solutions/${record.id}/recover`); await api().refresh(); await reviewSolution(result); notice(content, result.status === 'recovery-conflict' ? 'Some files contain newer changes and were preserved. Review the recovery details.' : 'The affected files were recovered.', result.status === 'recovery-conflict' ? 'info' : 'success'); })); diagnostics(recovery, preview.application, 'Recovery checkpoint details'); }
    const verify = section('Local checks', 'Run a reviewed syntax or whitespace check against your local files.');
    const target = field('Workspace-relative JavaScript file'); target.i.placeholder = 'src/app.js'; verify.append(target.l);
    async function verifyWith(argv) { const result = await post(`/solutions/${record.id}/verify`, { argv, reviewed: true }); verificationResult(verify, result); }
    actions(verify, button('Check JavaScript syntax', () => { if (!target.i.value.trim()) throw Error('Enter a JavaScript file path to check.'); return verifyWith(['node', '--check', target.i.value.trim()]); }), button('Check Git whitespace', () => verifyWith(['git', 'diff', '--check'])));
    for (const result of record.verification || []) verificationResult(verify, result);
    diagnostics(overview, { solutionId: record.id, requestId: record.handoffId, integrity: record.solution.integrity }, 'Solution details');
  }
  function verificationResult(parent, result) { const box = node('article', undefined, 'verification-result'); box.append(badge(result.passed ? 'Passed' : 'Failed', result.passed ? 'positive' : 'warning'), node('p', (result.argv || []).join(' '), 'verification-command')); if (result.stdout?.trim()) output(box, result.stdout); if (result.stderr?.trim()) output(box, result.stderr); if (!result.stdout?.trim() && !result.stderr?.trim()) box.append(node('p', result.passed ? 'No issues reported.' : 'The check did not complete successfully.', 'muted')); parent.append(box); }

  async function friend() {
    const state = api().getState(), s = section('Open a request', 'Choose where the request belongs. Importing it adds context to your workspace without changing source files.');
    const project = field('Local destination workspace', 'select'); for (const item of state.projects) { const option = node('option', item.name); option.value = item.id; project.i.append(option); } project.i.value = state.projectId;
    const input = field('Approved request JSON', 'textarea'); input.i.className = 'package-editor'; const mappings = node('div'); let mappingInputs = [];
    function showMappings() {
      mappings.replaceChildren(); mappingInputs = []; let pkg; try { pkg = JSON.parse(input.i.value); } catch { return; }
      const destination = state.projects.find(item => item.id === project.i.value), folders = destination?.folders || [], aliases = pkg.folderLayout?.folders || ['root'];
      if (!Array.isArray(aliases)) return; mappings.append(node('h4', 'Match source folders to your workspace'));
      for (const alias of aliases) { const choice = field(alias === 'root' ? 'Source folder' : alias, 'select'), blank = node('option', 'Choose a local folder…'); blank.value = ''; choice.i.append(blank); for (const folder of folders) { const option = node('option', (folder.displayName || folder.name) + ' — ' + folder.path); option.value = folder.id; choice.i.append(option); } choice.i.value = folders.find(folder => folder.name === alias)?.id || (aliases.length === 1 ? folders[0]?.id : '') || ''; mappingInputs.push({ alias, input: choice.i }); mappings.append(choice.l); }
    }
    input.i.addEventListener('input', showMappings); project.i.addEventListener('change', showMappings);
    const ack = check('I selected the correct local workspace and source folders.'); s.append(project.l, fileInput(input.i)); const raw = details(s, 'Or paste request JSON'); raw.append(input.l); s.append(mappings, ack.l);
    actions(s, button('Import request into selected workspace', async () => { if (!ack.i.checked) throw Error('Confirm the destination workspace and source folders.'); if (mappingInputs.some(item => !item.input.value)) throw Error('Choose a local folder for each source folder.'); const destination = project.i.value; await post('/handoffs/import', { package: JSON.parse(input.i.value), folderMapping: Object.fromEntries(mappingInputs.map(item => [item.alias, item.input.value])) }, destination); if (api().selectProject) await api().selectProject(destination); else await api().refresh(); await render(); notice(content, 'Request imported. Continue in the workspace chat when you are ready to work on it.'); }, 'primary'));
    const incoming = (await get('/handoffs')).filter(handoff => handoff.direction === 'incoming'), build = section('Return your solution');
    if (!incoming.length) { empty(build, 'Import a request to get started', 'After making changes locally, return only the files covered by the original request.'); return; }
    const choice = field('Imported request', 'select'); for (const handoff of incoming) { const option = node('option', handoff.package.goal || 'Help request'); option.value = handoff.id; choice.i.append(option); }
    const files = field('Changed or created file paths — one per line', 'textarea'), deletes = field('Deleted file paths — one per line', 'textarea'), explanation = field('Explain your solution', 'textarea'), assumptions = field('Assumptions — one per line', 'textarea'), verification = field('Checks you ran — one per line', 'textarea'); build.append(choice.l, explanation.l, files.l);
    const optional = details(build, 'Deletions, assumptions and verification'); optional.append(deletes.l, assumptions.l, verification.l);
    actions(build, button('Build and export solution', async () => { if (!choice.i.value) throw Error('Choose an imported request first.'); const solution = await post(`/handoffs/${choice.i.value}/build`, { files: lines(files.i.value), deletedPaths: lines(deletes.i.value), explanation: explanation.i.value, assumptions: lines(assumptions.i.value), verification: lines(verification.i.value) }); notice(build, `Solution exported with ${solution.patch.files.length} proposed file change${solution.patch.files.length === 1 ? '' : 's'}. Send the file back to the person who requested help.`); diagnostics(build, solution, 'Exported solution details'); download(`solution-${solution.id}.json`, solution); }, 'primary'));
  }

  function approvals() {
    let host = $('pending-approvals'); if (!host) { host = node('section', undefined, 'pending-approvals'); host.id = 'pending-approvals'; $('transcript-footer').prepend(host); }
    const state = api().getState(), pending = state.conversation?.pendingApprovals || [], signature = describe(pending); if (host.dataset.signature === signature) return; host.dataset.signature = signature; host.replaceChildren();
    for (const item of pending) {
      // An agent's questions with options get their own card, with the choices and Submit or Skip.
      if (item.kind === 'question' && window.relayQuestions) { host.append(window.relayQuestions.card(item, state.conversation.id)); continue; }
      // The heading says what the agent wants to do; the exact command or file follows, and the full request stays one click away.
      const command = item.command || item.input?.command, target = item.input?.file_path || item.input?.path, files = item.kind?.includes('fileChange') || target;
      const card = node('article', undefined, 'approval-card'), head = node('header'), mark = node('span', undefined, 'approval-icon'); mark.setAttribute('aria-hidden', 'true');
      card.dataset.approvalId = item.id; card.tabIndex = -1;
      const access = item.kind === 'item/permissions/requestApproval', specific = item.connector || access;
      head.append(mark, node('h3', `${providerName(item.provider)} ${command ? 'wants to run a command' : item.connector ? `wants to use ${item.connector}` : access ? 'wants more access' : files ? 'wants to change files' : 'needs your permission'}`)); card.append(head);
      if (item.title && item.title !== command) card.append(node('p', item.title, 'approval-title'));
      // A tool's own parameters say what it will do, so they're shown before you decide.
      if (specific) { if (item.details) output(card, item.details).classList.add('approval-details'); }
      else if (command) output(card, command).classList.add('approval-command'); else if (target) card.append(node('p', target, 'approval-target')); else card.append(node('p', files ? 'Review the requested file changes before continuing.' : `Requested action: ${item.kind || 'tool use'}`, 'approval-title'));
      const choices = [['Approve', true, 'primary'], ['Deny', false]].map(([text, allow, cls]) => { const choice = node('button', text, cls); choice.type = 'button'; choice.addEventListener('click', () => answer(choices, state.conversation.id, item, allow)); return choice; });
      const footer = node('div', undefined, 'approval-footer'); card.append(footer);
      // An action with an exact scope can also be allowed for the rest of the run or remembered for the workspace.
      const scoped = [];
      if (item.scope) {
        const more = node('button', undefined, 'primary approval-more'); more.type = 'button'; more.setAttribute('aria-label', 'More ways to allow'); more.setAttribute('aria-expanded', 'false'); more.title = 'Allow for this run or always in this workspace';
        const menu = node('div', undefined, 'approval-scope-menu'); menu.hidden = true; menu.setAttribute('role', 'menu');
        for (const [remember, title, detail] of [['run', 'Allow for this run', 'Until this run ends'], ['workspace', 'Always allow in this workspace', 'You can revoke it in Workspace settings']]) {
          const option = node('button', undefined, 'approval-scope-option'); option.type = 'button'; option.setAttribute('role', 'menuitem');
          option.append(node('strong', title), node('span', `${item.scope.label} · ${detail}`));
          option.addEventListener('click', () => { menu.hidden = true; answer([...choices, ...scoped], state.conversation.id, item, true, remember); });
          menu.append(option); scoped.push(option);
        }
        more.addEventListener('click', () => { menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button')?.focus?.(); });
        menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); more.focus(); } });
        scoped.push(more);
        const split = node('span', undefined, 'approval-split'); split.append(choices[0], more, menu);
        diagnostics(footer, item, 'Full request'); actions(footer, choices[1], split);
      } else { diagnostics(footer, item, 'Full request'); actions(footer, choices[1], choices[0]); }
      host.append(card);
    }
  }
  // Approval cards sit outside the dialog, so a failed answer is shown in the page notice. The refresh afterwards removes a request that is no longer pending.
  async function answer(choices, conversationId, item, allow, remember = null) {
    choices.forEach(choice => { choice.disabled = true; });
    try { await api().post(`/api/conversations/${conversationId}/approval`, { runId: item.runId, approvalId: item.id, allow, ...(remember ? { remember } : {}) }); }
    catch (e) { api().showNotice(e.message || 'This action could not be completed. Please try again.'); }
    finally { choices.forEach(choice => { choice.disabled = false; }); await api().refresh(); }
  }
  modal.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('ask-friend').addEventListener('click', () => open('request')); $('workbench-close').addEventListener('click', () => modal.close());
  // Other parts of the app open Ask a friend on one of its tabs.
  window.relayFriend = { open: (next = 'request') => open(page[next] ? next : 'request') };
  $('workbench-tabs').addEventListener('click', event => { const target = event.target.closest('[data-tab]'); if (target?.dataset.tab) perform(async () => { tab = target.dataset.tab; await render(); }); });
  // A request belongs to the workspace it was made in, so switching workspace closes the dialog.
  window.addEventListener('relay-state', () => { if (modal.open && projectScope !== api().getState().projectId) { ++renderRevision; modal.close(); } approvals(); $('ask-friend').disabled = !api().getState().projectId; }); approvals();
})();

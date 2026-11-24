// Watch-along (#24). Share live: a teammate watches this workspace's conversation in their own Codeshi, read-only,
// after you match their code and allow them. Watch a teammate: paste their invite link to watch theirs.
// While someone watches, a strip above the message box says so, and their suggestions wait there until you add one to
// your message or dismiss it. You choose, per person, whether they may also send messages to your agent (held for you or
// straight to your queue, always on your account with Ask for permission) or run turns on their own computer and account
// in their own copy of the code, with their reply joining the conversation and any file changes held for your review.
(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI, md = window.relayPhoneLogic;
  const shareDialog = $('share-live-dialog'), watchDialog = $('watch-dialog'), strip = $('watch-strip');
  if (!api || !shareDialog || !watchDialog || !strip) return;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'secondary-button') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const listed = items => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  const time = ms => { try { return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }); } catch { return ''; } };
  const spaced = code => String(code || '').replace(/^(\d{3})(\d{3})$/, '$1 $2');
  const AGENT = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', antigravity: 'Antigravity' };
  const agentName = id => AGENT[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'The agent');
  // What a person may do, as the host sets it in Share live and as the watcher is told.
  const LEVELS = [
    ['suggest', 'Suggestions only'],
    ['ask', 'Messages, you send each'],
    ['auto', 'Messages, straight to your queue'],
    ['run', 'Run on their own account'],
  ];

  let status = null, failure = '', busy = false, loading = 0, current = null, adding = false;
  const draft = { link: '', name: '', suggestion: '', runProjectId: '', runProvider: '' };
  const patchReviews = new Map();
  const path = () => { const projectId = api.getState().projectId; return projectId ? `/api/watch?projectId=${encodeURIComponent(projectId)}` : '/api/watch'; };
  const host = () => status?.host || null;
  const sessions = () => status?.watching || [];
  const session = () => sessions().find(item => item.id === current) || null;

  async function load() {
    const request = ++loading;
    try { const result = await api.api(path()); if (request === loading) { status = result; render(); } }
    catch (error) { if (request === loading) { failure = error.message; render(); } }
  }
  async function act(input, done) {
    if (busy) return; busy = true; failure = ''; render();
    try { const result = await api.post(path(), input); status = result; done?.(result); }
    catch (error) { failure = error.message; if (!shareDialog.open && !watchDialog.open) api.showNotice?.(error.message); }
    finally { busy = false; render(); }
  }
  // ---- The footer entry, beside Remote access: it says when someone can watch, is watching, or asks to.
  function renderEntry() {
    const entry = $('status-watch'); if (!entry) return;
    const watchers = host()?.watchers || [], waiting = watchers.filter(item => item.state === 'pending').length, allowed = watchers.filter(item => item.state === 'active');
    const now = allowed.filter(item => item.watchingNow).length, mine = sessions().filter(item => item.state === 'active').length;
    $('status-watch-label').textContent = allowed.length ? 'Sharing live' : mine ? 'Watching' : 'Share live';
    entry.dataset.live = String(Boolean(now || host()?.teammateRun));
    const count = $('status-watch-count'); count.hidden = !waiting; count.textContent = waiting ? String(waiting) : '';
    entry.title = waiting ? `${waiting === 1 ? '1 teammate asks' : `${waiting} teammates ask`} to watch` : now ? `${now === 1 ? '1 teammate is' : `${now} teammates are`} watching now` : allowed.length ? `${allowed.length === 1 ? '1 teammate' : `${allowed.length} teammates`} can watch this conversation` : 'Share this conversation live with a teammate, or watch theirs';
  }
  function render() { renderEntry(); renderStrip(); if (shareDialog.open) renderShare(); if (watchDialog.open) renderWatch(); }

  // ---- The strip above the message box: who is watching, who is running on their own account, and their items.
  function renderStrip() {
    const state = host(), watchers = state?.watchers || [], waiting = watchers.filter(item => item.state === 'pending'), allowed = watchers.filter(item => item.state === 'active');
    const suggestions = state?.suggestions || [], activeRun = state?.teammateRun || null;
    strip.hidden = !(watchers.length || suggestions.length || activeRun);
    if (strip.hidden) { strip.replaceChildren(); return; }
    const line = node('div', 'watch-strip-line');
    const now = allowed.filter(item => item.watchingNow), away = allowed.filter(item => !item.watchingNow);
    const parts = [];
    if (now.length) parts.push(`${listed(now.map(item => item.name))} ${now.length === 1 ? 'is' : 'are'} watching`);
    const runners = allowed.filter(item => item.level === 'run');
    if (runners.length) parts.push(`${listed(runners.map(item => item.name))} can run on their own account`);
    const senders = allowed.filter(item => item.level === 'ask' || item.level === 'auto');
    if (senders.length) parts.push(`${listed(senders.map(item => item.name))} can send messages`);
    if (away.length) parts.push(`${listed(away.map(item => item.name))} can watch`);
    if (waiting.length) parts.push(`${listed(waiting.map(item => item.name))} ${waiting.length === 1 ? 'asks' : 'ask'} to watch`);
    const dot = node('span', `watch-dot${now.length || activeRun ? ' live' : ''}`); dot.setAttribute('aria-hidden', 'true');
    line.append(dot, node('span', 'watch-strip-text', parts.join(' · ') || 'From a teammate'));
    line.append(button(waiting.length ? 'Review' : 'Manage', openShare, 'text-link'));
    const children = [line];

    if (activeRun) {
      const card = node('div', 'watch-suggestion watch-running');
      const text = node('div', 'watch-suggestion-text');
      text.append(
        node('strong', '', `${activeRun.from} is running ${agentName(activeRun.provider)} on their account`),
        node('span', '', activeRun.step ? `${activeRun.step} · ${activeRun.prompt}` : activeRun.prompt),
      );
      text.title = activeRun.prompt;
      const actions = node('div', 'watch-suggestion-actions');
      actions.append(button('Stop their run', () => act({ action: 'cancel-run', id: activeRun.roomId }, () => api.announce?.(`Stopped ${activeRun.from}’s run.`)), 'secondary-button'));
      card.append(text, actions);
      children.push(card);
    }

    for (const item of suggestions) {
      if (item.kind === 'patch') {
        children.push(renderPatchCard(item));
        continue;
      }
      const message = item.kind === 'message';
      const card = node('div', `watch-suggestion${message ? ' watch-held' : ''}`);
      const text = node('div', 'watch-suggestion-text');
      text.append(node('strong', '', message ? `${item.from} wants to send` : `${item.from} suggests`), node('span', '', item.text));
      text.title = item.text;
      const actions = node('div', 'watch-suggestion-actions');
      if (message) {
        // Send queues it with your conversation's agent and Ask for permission; it starts now if nothing is running.
        const go = button('Send', () => act({ action: 'send', id: item.id, billingConfirmed: window.relayBillingConfirmed === true }, () => api.announce?.(`${item.from}’s message is in your queue.`)), 'primary-button');
        go.title = 'Runs on your computer and account, with Ask for permission. It waits its turn in your queue.';
        actions.append(go, button('Edit', () => addToMessage(item), 'secondary-button'));
      } else actions.append(button('Add to message', () => addToMessage(item), 'secondary-button'));
      actions.append(button('Dismiss', () => act({ action: 'dismiss', id: item.id }), 'text-link'));
      card.append(text, actions);
      if (message && item.reason) { const why = node('p', 'watch-held-reason', `It couldn’t join your queue by itself: ${item.reason}`); card.append(why); }
      children.push(card);
    }
    strip.replaceChildren(...children);
  }
  function renderPatchCard(item) {
    const card = node('div', 'watch-suggestion watch-held watch-patch');
    const text = node('div', 'watch-suggestion-text');
    const count = item.files?.length || 0;
    const applied = item.status === 'applied';
    text.append(
      node('strong', '', `${item.from} ran ${agentName(item.provider)} on their account · ${count} ${count === 1 ? 'file' : 'files'} changed${applied ? ' (applied)' : ''}`),
      node('span', '', `${item.text} (${(item.files || []).map(file => file.path).join(', ')})`),
    );
    text.title = item.text;
    const actions = node('div', 'watch-suggestion-actions');
    const preview = patchReviews.get(item.id);
    const toggleReview = () => {
      if (patchReviews.has(item.id)) { patchReviews.delete(item.id); renderStrip(); return; }
      act({ action: 'preview-patch', id: item.id }, result => {
        if (result?.patchPreview) patchReviews.set(item.id, result.patchPreview);
      });
    };
    actions.append(button(preview ? 'Hide review' : 'Review changes', toggleReview, applied || preview ? 'secondary-button' : 'primary-button'));
    if (applied) {
      actions.append(button('Undo', () => act({ action: 'undo-patch', id: item.id }, () => { patchReviews.delete(item.id); api.announce?.(`Undid ${item.from}’s changes.`); }), 'secondary-button'));
    }
    actions.append(button('Dismiss', () => act({ action: 'dismiss', id: item.id }, () => patchReviews.delete(item.id)), 'text-link'));
    card.append(text, actions);
    if (preview) {
      const box = node('div', 'watch-patch-review');
      if (preview.conflicts?.length) {
        const warn = node('p', 'watch-patch-conflict', `Cannot apply automatically: ${preview.conflicts.map(c => `${c.path} (${c.reason})`).join('; ')}`);
        box.append(warn);
      }
      if (preview.warnings?.length) {
        const warn = node('p', 'watch-patch-conflict', `Check carefully before applying: ${preview.warnings.map(w => w.message || w.code).join('; ')}`);
        box.append(warn);
      }
      for (const file of preview.files || []) {
        const entry = node('div', 'watch-patch-file');
        const head = node('div', 'watch-patch-file-head');
        head.append(node('strong', '', file.path), node('span', 'panel-muted', file.operation));
        if (file.conflict) head.append(node('span', 'watch-error', file.conflict.reason));
        entry.append(head);
        if (file.binary) {
          const desc = [file.binary.before ? `Before: ${file.binary.before.kind} (${file.binary.before.bytes} B)` : 'New binary file', file.binary.after ? `After: ${file.binary.after.kind} (${file.binary.after.bytes} B)` : 'Deleted'].join(' → ');
          entry.append(node('p', 'panel-muted', desc));
        } else if (file.diff) {
          const pre = node('pre', 'watch-patch-diff');
          pre.textContent = file.diff;
          entry.append(pre);
        }
        box.append(entry);
      }
      const row = node('div', 'watch-actions');
      if (!applied && !(preview.conflicts?.length)) {
        const apply = button('Apply changes', () => act({ action: 'apply-patch', id: item.id, digest: preview.digest }, () => { patchReviews.delete(item.id); api.announce?.(`Applied ${item.from}’s changes.`); }), 'primary-button');
        apply.title = 'Writes these reviewed changes to your workspace and saves a recovery checkpoint so you can undo them.';
        row.append(apply);
      }
      row.append(button('Close review', () => { patchReviews.delete(item.id); renderStrip(); }, 'secondary-button'));
      box.append(row);
      card.append(box);
    }
    return card;
  }
  function addToMessage(item) {
    const input = $('message-input'); if (!input) return;
    input.value = [input.value.trim(), item.text].filter(Boolean).join('\n\n');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    act({ action: 'dismiss', id: item.id });
  }

  // ---- Share live
  function openShare() {
    if (!api.getState().projectId) { api.showNotice?.('Choose a workspace first.'); return; }
    failure = ''; renderShare(); if (!shareDialog.open) shareDialog.showModal(); load();
  }
  function renderShare() {
    const body = $('share-live-body'), state = host(), children = [];
    if (status && !status.configured) children.push(node('p', 'watch-note', status.error || 'Watch-along needs the remote relay, which isn’t set up in this build.'));
    else if (state) {
      for (const item of state.watchers.filter(entry => entry.state === 'pending')) {
        const ask = node('section', 'watch-ask');
        ask.append(node('h3', '', `${item.name} asks to watch`));
        const code = node('p', 'watch-code-line', 'Allow only if their Codeshi shows ');
        code.append(node('strong', 'watch-code', spaced(item.code)), document.createTextNode('.'));
        const row = node('div', 'watch-actions');
        row.append(button('Deny', () => act({ action: 'deny', id: item.id })), button('Allow', () => act({ action: 'allow', id: item.id }), 'primary-button'));
        ask.append(code, row); children.push(ask);
      }
      const allowed = state.watchers.filter(entry => entry.state === 'active');
      if (allowed.length) {
        const list = node('ul', 'watch-people');
        for (const item of allowed) {
          const row = node('li', 'watch-person');
          const dot = node('span', `watch-dot${item.watchingNow ? ' live' : ''}`); dot.setAttribute('aria-hidden', 'true');
          const who = node('div', 'watch-person-text');
          who.append(node('strong', '', item.name), node('span', 'panel-muted', `${item.watchingNow ? 'Watching now' : 'Not looking right now'} · until ${time(item.expiresAt)}`));
          const level = node('select', 'watch-level'); level.setAttribute('aria-label', `What ${item.name} can do`);
          level.title = 'Choose whether they can send suggestions, send messages to your agent, or run turns on their own computer and account.';
          for (const [value, text] of LEVELS) { const option = node('option', '', text); option.value = value; level.append(option); }
          level.value = item.level || 'suggest';
          level.addEventListener('change', () => act({ action: 'level', id: item.id, level: level.value }, () => api.announce?.(`${item.name}: ${LEVELS.find(([value]) => value === level.value)?.[1]}.`)));
          row.append(dot, who, level, button('Stop sharing', () => act({ action: 'stop', id: item.id })));
          list.append(row);
        }
        children.push(list);
      }
      const invite = node('section', 'watch-invite');
      if (state.invite) {
        invite.append(node('h3', '', 'Invite link'));
        const field = node('div', 'watch-link');
        const input = node('input'); input.readOnly = true; input.value = state.invite.link; input.setAttribute('aria-label', 'Invite link'); input.addEventListener('focus', () => input.select());
        const copy = button('Copy', async () => { try { await navigator.clipboard.writeText(state.invite.link); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); } catch { input.select(); } }, 'primary-button');
        field.append(input, copy);
        invite.append(field, node('p', 'panel-muted', `Send it to one teammate. It works once, until ${time(state.invite.expiresAt)}. They choose Share live › Watch a teammate in their Codeshi and paste it, then you match their code here.`));
        invite.append(button('Cancel invite', () => act({ action: 'cancel-invite' }), 'text-link'));
      } else {
        invite.append(node('p', 'watch-note', 'They’ll see this conversation’s latest 60 messages and everything after: replies, what agents are doing, and any file contents or command output shown in it. Don’t share a conversation with secrets in it.'));
        invite.append(button(allowed.length ? 'Invite someone else' : 'Create invite link', () => act({ action: 'invite' }), 'primary-button'));
      }
      children.push(invite);
      if (allowed.length) children.push(node('p', 'panel-muted watch-fineprint', 'Messages run here on your account with Ask for permission. With “Run on their own account”, they run on their own computer and subscription in their own copy of the code; their reply joins the conversation and any file changes wait for you to review and apply.'));
      children.push(node('p', 'panel-muted watch-fineprint', 'Sent through Codeshi’s relay, encrypted end to end: the relay can’t read it.'));
    } else children.push(node('p', 'panel-muted', 'Loading…'));
    if (failure) children.push(node('p', 'watch-error', failure));
    if (busy) body.setAttribute('aria-busy', 'true'); else body.removeAttribute('aria-busy');
    for (const control of children.flatMap(child => child.querySelectorAll ? [...child.querySelectorAll('button, select')] : [])) control.disabled = busy;
    body.replaceChildren(...children);
  }

  // ---- Watch a teammate
  function openWatch(id = null) {
    failure = '';
    const live = sessions().filter(item => ['pending', 'active'].includes(item.state));
    current = id || current && sessions().some(item => item.id === current) && current || live[0]?.id || null;
    adding = !current;
    if (!draft.name) draft.name = status?.name || '';
    // With no saved name, offer the GitHub CLI login's name (#159). It is only a suggestion the person can change.
    if (!draft.name && !draft.suggestion) {
      draft.suggestion = 'asked';
      api.api('/api/github/identity').then(result => { if (result?.identity?.name && !draft.name) { draft.name = result.identity.name.slice(0, 60); draft.avatar = /^data:image\/(png|jpeg|gif|webp);base64,/.test(result.identity.avatar || '') ? result.identity.avatar : ''; renderWatch(); } }).catch(() => {});
    }
    if (!watchDialog.open) watchDialog.showModal();
    look(true); renderWatch(); load();
  }
  let looking = null;
  function look(on) {
    const id = on ? current : null;
    if (looking && looking !== id) api.post(path(), { action: 'look', id: looking, looking: false }).catch(() => {});
    if (id && looking !== id && session()?.state !== 'ended') api.post(path(), { action: 'look', id, looking: true }).then(result => { status = result; render(); }).catch(() => {});
    looking = id;
  }
  watchDialog.addEventListener('close', () => look(false));
  shareDialog.addEventListener('close', () => { failure = ''; });
  $('share-live-close').addEventListener('click', () => shareDialog.close());
  $('watch-close').addEventListener('click', () => watchDialog.close());

  function joinForm() {
    const form = node('form', 'watch-join');
    const link = node('label', 'watch-field'); const linkInput = node('textarea'); linkInput.rows = 2; linkInput.required = true; linkInput.spellcheck = false; linkInput.placeholder = 'codeshi://watch/…'; linkInput.value = draft.link;
    linkInput.addEventListener('input', () => { draft.link = linkInput.value; });
    link.append(node('span', '', 'Invite link'), linkInput);
    const name = node('label', 'watch-field'); const nameInput = node('input'); nameInput.maxLength = 60; nameInput.required = true; nameInput.value = draft.name; nameInput.autocomplete = 'name';
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; });
    name.append(node('span', '', 'Your name, shown to them'));
    if (draft.avatar && draft.name) { const picture = node('img', 'watch-avatar'); picture.src = draft.avatar; picture.alt = ''; picture.width = 24; picture.height = 24; name.append(picture); }
    name.append(nameInput);
    const row = node('div', 'watch-actions');
    if (sessions().length) row.append(button('Cancel', () => { adding = false; failure = ''; renderWatch(); }));
    const submit = node('button', 'primary-button', busy ? 'Joining…' : 'Join'); submit.type = 'submit'; submit.disabled = busy; row.append(submit);
    form.append(node('p', 'panel-muted', 'Ask your teammate for an invite link. They make one with Share live, beside Remote access.'), link, name, row);
    form.addEventListener('submit', event => {
      event.preventDefault();
      act({ action: 'join', link: draft.link, name: draft.name }, result => { current = result.joined; adding = false; draft.link = ''; look(true); });
    });
    setTimeout(() => (draft.link ? nameInput : linkInput).focus());
    return form;
  }
  function transcript(view) {
    const feed = node('div', 'watch-feed'); feed.setAttribute('aria-label', 'Their conversation'); feed.tabIndex = 0;
    if (view.earlier) feed.append(node('p', 'watch-earlier', `${view.earlier} earlier message${view.earlier === 1 ? '' : 's'} not shown.`));
    if (!view.messages.length) feed.append(node('p', 'panel-muted', 'No messages yet.'));
    for (const message of view.messages) {
      const row = node('article', `watch-message ${message.role}${message.author ? ' from-teammate' : ''}`);
      // A message or turn a teammate sent or ran through Share live keeps their name: "You" for your own.
      if (message.role === 'user' && message.author) {
        const who = message.author.mine ? 'You' : message.author.name;
        row.append(node('div', 'watch-message-head', message.author.ranOn === 'peer' ? `${who} · ran on ${message.author.mine ? 'your' : 'their'} account` : who));
      }
      if (message.role !== 'user') {
        const head = message.role === 'assistant'
          ? (message.author?.ranOn === 'peer' ? `${agentName(message.provider)} · ${message.author.mine ? 'your account' : `${message.author.name}’s account`}` : agentName(message.provider))
          : message.role === 'error' ? 'Error' : 'Codeshi';
        row.append(node('div', 'watch-message-head', head));
      }
      const body = node('div', 'watch-message-text');
      if (message.role === 'assistant' && md) body.append(markdown(message.text)); else body.textContent = message.text;
      row.append(body);
      if (message.attachments?.length) row.append(node('p', 'watch-attachments', `Attached: ${message.attachments.map(file => file.name).join(', ')}`));
      feed.append(row);
    }
    return feed;
  }
  function spans(host, text) {
    for (const span of md.spans(text)) {
      if (span.type === 'text') host.append(span.text);
      else if (span.type === 'code') host.append(node('code', '', span.text));
      else if (span.type === 'bold') host.append(node('strong', '', span.text));
      else if (span.type === 'italic') host.append(node('em', '', span.text));
      else { const link = node('a', '', span.text); link.href = span.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; host.append(link); }
    }
    return host;
  }
  function markdown(text) {
    const host = node('div', 'markdown');
    for (const block of md.blocks(text)) {
      if (block.type === 'paragraph') host.append(spans(node('p'), block.text));
      else if (block.type === 'heading') host.append(spans(node(block.level === 1 ? 'h3' : 'h4'), block.text));
      else if (block.type === 'code') { const pre = node('pre'); pre.append(node('code', '', block.text)); host.append(pre); }
      else if (block.type === 'quote') host.append(spans(node('blockquote'), block.text));
      else if (block.type === 'rule') host.append(node('hr'));
      else if (block.type === 'list') { const list = node(block.ordered ? 'ol' : 'ul'); for (const item of block.items) list.append(spans(node('li'), item)); host.append(list); }
      else if (block.type === 'table') {
        const table = node('table'), head = node('tr'), rows = node('tbody'), thead = node('thead');
        for (const cell of block.head) head.append(spans(node('th'), cell));
        thead.append(head); table.append(thead);
        for (const row of block.rows) { const line = node('tr'); for (const cell of row) line.append(spans(node('td'), cell)); rows.append(line); }
        table.append(rows); const wrap = node('div', 'watch-table'); wrap.append(table); host.append(wrap);
      }
    }
    return host;
  }
  function liveLine(view) {
    const line = node('div', 'watch-live');
    const peerRun = view.teammateRun;
    const active = view.status === 'running' || Boolean(peerRun);
    const dot = node('span', `watch-dot${active ? ' live' : ''}`); dot.setAttribute('aria-hidden', 'true');
    const run = view.activeRun;
    const text = view.status === 'running'
      ? `${agentName(run?.provider || view.provider)} is working${view.step ? ` · ${view.step}` : ''}`
      : peerRun
      ? `${peerRun.author?.mine ? 'You are' : `${peerRun.author?.name || 'A teammate'} is`} running ${agentName(peerRun.provider)} on ${peerRun.author?.mine ? 'your' : 'their'} account${peerRun.step ? ` · ${peerRun.step}` : ''}`
      : 'Not running';
    line.append(dot, node('span', '', text));
    const block = [line];
    for (const item of view.waiting || []) block.push(node('p', 'watch-waiting', `${item.kind === 'question' ? `${agentName(item.provider)} asks` : `Waiting for their approval`}: ${item.label}`));
    // Your messages waiting in their queue, and where they stand.
    const mine = (view.upNext || []).filter(item => item.author?.mine);
    if (mine.length) {
      const list = node('ul', 'watch-upnext'); list.setAttribute('aria-label', 'Your messages in their queue');
      for (const item of mine) {
        const row = node('li');
        row.append(node('span', 'watch-upnext-place', item.place === 1 ? (view.paused ? 'Next, their queue is paused' : 'Next') : `${item.place} of ${view.queued} in their queue`), node('span', 'watch-upnext-text', item.text));
        list.append(row);
      }
      block.push(list);
    }
    return block;
  }

  let pinned = true;
  function renderWatch() {
    const body = $('watch-body'), foot = $('watch-foot'), title = $('watch-title'), subtitle = $('watch-subtitle');
    const item = adding ? null : session();
    const others = sessions().filter(entry => entry.id !== item?.id && ['pending', 'active'].includes(entry.state));
    const appState = api.getState() || {};
    const projectKeys = (appState.projects || []).map(p => p.id).join(',');
    const footKey = item ? `${item.id}:${item.state}:${item.level || 'suggest'}:${item.running?.id || ''}:${projectKeys}` : '';
    if (footKey !== foot.dataset.key) { foot.dataset.key = footKey; foot.hidden = true; foot.replaceChildren(); }
    const fresh = !foot.children.length;
    const previous = body.querySelector('.watch-feed');
    if (previous) pinned = previous.scrollHeight - previous.scrollTop - previous.clientHeight < 48;
    const children = [];
    if (status && !status.configured) { title.textContent = 'Watch a teammate'; children.push(node('p', 'watch-note', status.error || 'Watch-along needs the remote relay, which isn’t set up in this build.')); }
    else if (!item) { title.textContent = 'Watch a teammate'; subtitle.textContent = 'Read-only. You see their conversation live and can send them suggestions.'; children.push(joinForm()); }
    else {
      title.textContent = item.workspace ? `Watching ‘${item.workspace}’` : 'Watching a teammate';
      const can = item.level === 'run'
        ? 'You can run turns on your own computer and account. File changes go to them for review.'
        : item.level === 'auto'
        ? 'Your messages join their queue and run on their account.'
        : item.level === 'ask'
        ? 'Your messages run on their account once they send them.'
        : 'Read-only. Your suggestions go to them; nothing runs on your computer.';
      subtitle.textContent = item.view?.title && item.view.title !== item.workspace ? `${item.view.title} · ${can}` : can;
      if (item.state === 'pending') {
        const wait = node('section', 'watch-ask');
        wait.append(node('h3', '', 'Waiting for them to allow you'));
        const code = node('p', 'watch-code-line', 'They’ll see your request with the code ');
        code.append(node('strong', 'watch-code', spaced(item.code)), document.createTextNode('. Tell them it matches.'));
        wait.append(code); children.push(wait);
        foot.hidden = false;
        if (fresh) foot.append(button('Cancel request', () => act({ action: 'leave', id: item.id }, () => { current = null; adding = !sessions().length; })));
      } else if (item.state === 'ended' || item.state === 'left') {
        children.push(node('p', 'watch-note', 'They stopped sharing this conversation.'));
        foot.hidden = false; if (fresh) foot.append(button('Remove', () => act({ action: 'forget', id: item.id }, () => { current = null; adding = true; })));
      } else {
        if (item.view) { children.push(...liveLine(item.view), transcript(item.view)); }
        else children.push(node('p', 'panel-muted', item.error ? '' : 'Loading their conversation…'));
        if (item.error) children.push(node('p', 'watch-error', item.error));
        foot.hidden = false;
        foot.querySelectorAll('button, select').forEach(control => { control.disabled = busy; });
        const stepLabel = foot.querySelector('.watch-local-run-text');
        if (stepLabel && item.running) {
          stepLabel.textContent = `${agentName(item.running.provider)} is working on your computer${item.running.step ? ` · ${item.running.step}` : ''}`;
        }
      }
      if (item.state === 'active' && fresh) {
        if (item.running) {
          const runningBar = node('div', 'watch-local-run');
          const dot = node('span', 'watch-dot live'); dot.setAttribute('aria-hidden', 'true');
          const labelNode = node('span', 'watch-local-run-text', `${agentName(item.running.provider)} is working on your computer${item.running.step ? ` · ${item.running.step}` : ''}`);
          const stopBtn = button('Stop run', () => act({ action: 'stop-run', id: item.id }, () => api.announce?.('Stopped your run.')), 'secondary-button');
          runningBar.append(dot, labelNode, stopBtn);
          foot.append(button('Leave', () => act({ action: 'leave', id: item.id }, () => { current = null; adding = !sessions().length; look(false); })), runningBar);
        } else {
          const canRunOwn = item.level === 'run';
          const messages = item.level === 'ask' || item.level === 'auto';
          const stack = node('div', 'watch-compose-stack');
          if (canRunOwn) {
            const bar = node('div', 'watch-run-bar');
            const projects = Array.isArray(appState.projects) ? appState.projects : [];
            if (!draft.runProjectId || !projects.some(p => p.id === draft.runProjectId)) {
              draft.runProjectId = appState.projectId || projects[0]?.id || '';
            }
            if (!draft.runProvider) {
              draft.runProvider = appState.conversation?.provider || 'claude';
            }
            const wsLabel = node('label', 'watch-run-pick');
            wsLabel.append(node('span', 'panel-muted', 'Your copy'));
            const wsSelect = node('select', 'watch-level watch-run-project');
            wsSelect.setAttribute('aria-label', 'Your local workspace copy');
            for (const proj of projects) {
              const opt = node('option', '', proj.name || proj.id);
              opt.value = proj.id;
              wsSelect.append(opt);
            }
            wsSelect.value = draft.runProjectId;
            wsSelect.addEventListener('change', () => { draft.runProjectId = wsSelect.value; });
            wsLabel.append(wsSelect);

            const agLabel = node('label', 'watch-run-pick');
            agLabel.append(node('span', 'panel-muted', 'Your agent'));
            const agSelect = node('select', 'watch-level watch-run-provider');
            agSelect.setAttribute('aria-label', 'Agent on your account');
            for (const [id, text] of [['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini']]) {
              const opt = node('option', '', text);
              opt.value = id;
              agSelect.append(opt);
            }
            agSelect.value = draft.runProvider;
            agSelect.addEventListener('change', () => { draft.runProvider = agSelect.value; });
            agLabel.append(agSelect);
            bar.append(wsLabel, agLabel);
            stack.append(bar);
          }
          const form = node('form', 'watch-suggest');
          const box = node('textarea'); box.rows = 1; box.maxLength = (messages || canRunOwn) ? 8000 : 2000; box.value = draft.suggestion === 'asked' ? '' : draft.suggestion;
          box.placeholder = canRunOwn ? 'Run on your account and share the result…' : messages ? 'Message their agent…' : 'Suggest something to them…';
          box.setAttribute('aria-label', canRunOwn ? 'Prompt to run on your account' : messages ? 'Message' : 'Suggestion');
          box.addEventListener('input', () => { draft.suggestion = box.value; });
          box.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
          const sent = (placeholder, said) => { draft.suggestion = ''; box.value = ''; box.placeholder = placeholder; api.announce?.(said); };
          const suggest = () => {
            if (!draft.suggestion.trim() || draft.suggestion === 'asked') return;
            if (draft.suggestion.trim().length > 2000) { failure = 'Keep a suggestion under 2000 characters.'; renderWatch(); return; }
            act({ action: 'suggest', id: item.id, text: draft.suggestion }, () => sent(canRunOwn ? 'Suggestion sent. Run on your account…' : messages ? 'Suggestion sent. Message their agent…' : 'Sent. Suggest something else…', 'Suggestion sent.'));
          };
          const submit = node('button', 'primary-button', canRunOwn ? 'Run on your account' : 'Send'); submit.type = 'submit'; submit.disabled = busy;
          if (canRunOwn || messages) {
            submit.title = canRunOwn
              ? 'Runs in your local workspace copy using your own subscription, then shares the reply and a reviewed patch'
              : item.level === 'auto' ? 'Joins their queue and runs on their account' : 'Waits for them to send it';
            const asSuggestion = button('Suggest', suggest, 'secondary-button'); asSuggestion.title = 'Send it as a suggestion they can add to their own message';
            form.append(box, asSuggestion, submit);
          } else form.append(box, submit);
          form.addEventListener('submit', event => {
            event.preventDefault();
            if (!messages && !canRunOwn) { suggest(); return; }
            const text = draft.suggestion === 'asked' ? '' : draft.suggestion.trim();
            if (!text) return;
            if (canRunOwn) {
              act({
                action: 'run',
                id: item.id,
                text,
                targetProjectId: draft.runProjectId || appState.projectId || null,
                provider: draft.runProvider || appState.conversation?.provider || 'claude',
                wait: false,
              }, () => { draft.suggestion = ''; api.announce?.('Started on your computer.'); });
              return;
            }
            act({ action: 'message', id: item.id, text }, result => result.queued
              ? sent('In their queue. Message their agent…', 'Your message is in their queue.')
              : sent('Sent. It waits for them to send it…', 'Sent. It waits for them to send it.'));
          });
          stack.append(form);
          foot.append(button('Leave', () => act({ action: 'leave', id: item.id }, () => { current = null; adding = !sessions().length; look(false); })), stack);
        }
      }
    }
    if (item || others.length) {
      const switcher = node('div', 'watch-switch');
      for (const entry of others) switcher.append(button(entry.workspace || 'Teammate', () => { current = entry.id; adding = false; look(true); renderWatch(); }, 'text-link'));
      if (item) switcher.append(button('Join another…', () => { adding = true; look(false); current = null; renderWatch(); }, 'text-link'));
      if (switcher.children.length) children.unshift(switcher);
    }
    if (failure) children.push(node('p', 'watch-error', failure));
    // The join form isn't redrawn under someone typing in it; a busy change still updates its button.
    const focused = document.activeElement;
    if (!item && focused && body.contains(focused) && focused.closest('.watch-join')) { const submit = body.querySelector('.watch-join [type=submit]'); if (submit) { submit.disabled = busy; submit.textContent = busy ? 'Joining…' : 'Join'; } return; }
    body.replaceChildren(...children);
    const feed = body.querySelector('.watch-feed'); if (feed && pinned) feed.scrollTop = feed.scrollHeight;
  }

  $('share-live').addEventListener('click', openShare);
  $('watch-teammate').addEventListener('click', () => openWatch());
  $('status-share-live')?.addEventListener('click', () => { $('status-watch-menu').hidePopover?.(); openShare(); });
  $('status-watch-teammate')?.addEventListener('click', () => { $('status-watch-menu').hidePopover?.(); openWatch(); });
  window.addEventListener('relay-watch', load);
  let projectId = null;
  window.addEventListener('relay-state', () => { const next = api.getState().projectId; if (next !== projectId) { projectId = next; load(); } });
  load();
  window.relayWatch = { openShare, openWatch, refresh: load };
})();

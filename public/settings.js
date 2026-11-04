(() => {
  'use strict';
  // Settings (⌘,): how Codeshi looks and behaves, on four pages. General has the theme, what happens while agents
  // work and updates; Accounts each agent's account; Alerts how Codeshi tells you about work while you're in
  // another app; Voice speaking and reading aloud. Every setting is one row in a titled group: what it is and what it
  // does on the left, its control on the right. The search box finds a setting on any page. Other modules draw their
  // own groups with the kit below, so every page reads the same way. Ask a friend is a dialog of its own.
  const $ = id => document.getElementById(id), api = () => window.relayUI;
  const modal = $('settings'), content = $('settings-content'), nav = $('settings-nav'), search = $('settings-search'), error = $('settings-error'), title = $('settings-title');
  if (!modal || !content) return;
  const PAGES = [['general', 'General'], ['accounts', 'Accounts'], ['alerts', 'Alerts'], ['voice', 'Voice']];
  // Places in Settings by the names other parts of the app used before it had these pages.
  const ALIASES = { preferences: 'general', connections: 'accounts' }, HEADINGS = { Alerts: 'alerts', Voice: 'voice', Updates: 'general', Appearance: 'general' };
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const providerName = provider => ({ codex: 'Codex', claude: 'Claude', gemini: 'Gemini' })[provider];
  const openExternal = async url => { if (window.relayDesktop?.openExternal) await window.relayDesktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer'); };
  const date = value => { if (!value) return ''; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  let page = 'general', busy = false, sections = {}, accountSignature = '', keepAwake = null, handoff = null;

  async function perform(fn) {
    if (busy) return; busy = true; error.hidden = true; modal.setAttribute('aria-busy', 'true');
    try { await fn(); } catch (failure) { error.textContent = failure.message || 'This could not be done. Please try again.'; error.hidden = false; }
    finally { busy = false; modal.removeAttribute('aria-busy'); }
  }

  // The parts every page is built from. A group is a titled list of rows. A row says what a setting is and does, with
  // its control on the right; a switch or a list is part of the row's label, so clicking the words changes it too.
  const words = (label, description) => { const text = node('span', undefined, 'settings-row-text'); text.append(node('span', label, 'settings-row-label')); if (description) text.append(node('span', description, 'settings-row-description')); return text; };
  const kit = {
    group(parent, heading, description) {
      const group = node('section', undefined, 'settings-group');
      if (heading) group.append(node('h3', heading, 'settings-group-title'));
      if (description) group.append(node('p', description, 'settings-group-description'));
      const rows = node('div', undefined, 'settings-rows'); group.append(rows); parent.append(group);
      // Feature sections also redraw after asynchronous checks or a changed preference.
      Promise.resolve().then(show);
      return rows;
    },
    row(rows, { label, description, keywords, control } = {}) {
      const row = node('div', undefined, 'settings-row'); row.append(words(label, description));
      const controls = [control].flat().filter(Boolean);
      if (controls.length) { const slot = node('div', undefined, 'settings-control'); slot.append(...controls); row.append(slot); }
      if (keywords) row.dataset.keywords = keywords;
      rows.append(row); return row;
    },
    toggle(rows, { label, description, keywords, checked, disabled = false, onChange }) {
      const row = node('label', undefined, 'settings-row'), box = node('input', undefined, 'settings-switch');
      box.type = 'checkbox'; box.setAttribute('role', 'switch'); box.checked = Boolean(checked); box.disabled = Boolean(disabled);
      box.addEventListener('change', () => onChange(box.checked));
      row.append(words(label, description), box); if (keywords) row.dataset.keywords = keywords;
      rows.append(row); return box;
    },
    select(rows, { label, description, keywords, options, value, disabled = false, onChange }) {
      const row = node('label', undefined, 'settings-row'), select = node('select', undefined, 'settings-select');
      for (const [optionValue, text] of options) { const option = node('option', text); option.value = optionValue; select.append(option); }
      select.value = value; select.disabled = Boolean(disabled); select.addEventListener('change', () => onChange(select.value));
      row.append(words(label, description), select); if (keywords) row.dataset.keywords = keywords;
      rows.append(row); return select;
    },
    segmented(options, value, onChange, label) {
      const choices = node('div', undefined, 'segmented'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', label);
      for (const [optionValue, text] of options) { const choice = node('button', text); choice.type = 'button'; choice.setAttribute('aria-pressed', String(optionValue === value)); choice.addEventListener('click', () => onChange(optionValue)); choices.append(choice); }
      return choices;
    },
    button(text, onClick, kind = '') { const button = node('button', text, `settings-button${kind ? ' ' + kind : ''}`); button.type = 'button'; button.addEventListener('click', () => perform(onClick)); return button; },
    note(parent, text, kind = '') { const note = node('p', text, `settings-note${kind ? ' ' + kind : ''}`); parent.append(note); return note; },
    details(parent, summary) { const details = node('details', undefined, 'settings-details'); details.append(node('summary', summary)); parent.append(details); return details; },
  };

  // General: the theme, what happens while agents work, and updates.
  function general(host) {
    const look = kit.group(host, 'Appearance'), theme = node('div', undefined, 'segmented');
    theme.setAttribute('role', 'group'); theme.setAttribute('aria-label', 'Theme');
    for (const [value, text] of [['system', 'System'], ['graphite', 'Dark'], ['light', 'Light']]) {
      const choice = node('button', text); choice.type = 'button'; choice.setAttribute('data-appearance', value);
      choice.setAttribute('aria-pressed', String(window.relayTheme?.preference() === value)); choice.addEventListener('click', () => window.relayTheme?.choose(value)); theme.append(choice);
    }
    kit.row(look, { label: 'Theme', description: 'System follows your computer’s light or dark setting.', keywords: 'appearance dark light mode colour color', control: theme });
    const themeStatus = kit.note(host, ''); themeStatus.id = 'appearance-status'; themeStatus.setAttribute('role', 'status');
    const work = kit.group(host, 'While agents work'), bridge = window.relayDesktop;
    if (bridge?.getKeepAwake && bridge?.setKeepAwake) {
      const box = kit.toggle(work, { label: 'Keep awake', description: 'Keep the computer awake while an agent works or waits for a usage limit to reset, then let it sleep as usual.', keywords: 'sleep display power', checked: keepAwake?.enabled === true, disabled: !keepAwake, onChange: value => perform(async () => {
        box.disabled = true;
        try { keepAwake = await bridge.setKeepAwake(value); }
        finally { box.checked = keepAwake?.enabled === true; box.disabled = false; }
      }) });
      box.id = 'settings-keep-awake';
      if (!keepAwake) bridge.getKeepAwake().then(state => { keepAwake = state; box.checked = state.enabled === true; box.disabled = false; }).catch(() => { if (box.isConnected) { error.textContent = 'Keep awake could not be loaded. Close Settings and try again.'; error.hidden = false; } });
    }
    const offer = kit.select(work, { label: 'Offer a handoff near a usage limit', description: 'When an agent is close to its limit, offer to continue the task with another connected agent.', keywords: 'handoff hand off limit quota switch agent', options: [['0', 'Never'], ['80', 'At 80%'], ['90', 'At 90%'], ['95', 'At 95%']], value: String(handoff?.threshold ?? 90), disabled: !handoff, onChange: value => saveHandoff({ threshold: Number(value) }) });
    const automatic = kit.toggle(work, { label: 'Hand off automatically', description: 'Near a limit, or when a run reaches one, switch to an agent on a subscription without asking, and say so in the conversation. If every agent is out, the task waits for the first reset.', keywords: 'handoff hand off automatic', checked: handoff?.automatic === true, disabled: !handoff || handoff.threshold === 0, onChange: value => saveHandoff({ automatic: value }) });
    if (!handoff) api().api('/api/handoff-preferences').then(value => { handoff = value; offer.value = String(value.threshold); offer.disabled = false; automatic.checked = value.automatic === true; automatic.disabled = value.threshold === 0; }).catch(() => {});
    if (window.relayUpdater) { const updates = node('div', undefined, 'settings-section'); host.append(updates); window.relayUpdater.settings(updates, kit); }
  }
  // Turned on from the offer at a usage limit.
  window.addEventListener('relay-handoff-preferences', () => { handoff = null; });
  async function saveHandoff(patch) {
    await perform(async () => { handoff = await api().post('/api/handoff-preferences', patch); });
    if (sections.general) render('general');
  }

  // Accounts: one row for each agent, with its status, plan and usage, what to do next, and its details on request.
  const installGuides = {
    codex: { command: 'npm install -g @openai/codex', url: 'https://github.com/openai/codex', note: 'Install the Codex CLI, or the ChatGPT or Codex app for macOS, on this computer, then refresh.' },
    claude: { command: 'curl -fsSL https://claude.ai/install.sh | bash', url: 'https://code.claude.com/docs/en/overview', note: 'Install Claude Code and run claude in Terminal to sign in, then refresh.' },
    gemini: { command: '', url: 'https://antigravity.google/docs/install', note: 'Codeshi downloads Google’s official Antigravity connection and checks it, then you sign in with Google. Google’s terms and account limits apply.' },
  };
  function accountLabel(account) { return !account.installed ? 'Not installed' : account.authenticated === true ? 'Connected' : account.authenticated === false ? 'Sign-in required' : 'Connection not confirmed'; }
  function billingLabel(account) { return account.authMode === 'google-oauth' && account.billingSource === 'subscription' ? 'Google account allowance' : account.billingSource === 'subscription' ? 'Your subscription' : account.billingSource === 'api' ? 'API usage' : 'Billing not reported'; }
  function usageLabel(usage, plan) {
    if (plan?.available && plan.windows?.length) return plan.windows.map(row => `${row.label}: ${row.disabled ? 'Disabled' : Number.isFinite(row.usedPercent) ? Math.round(row.usedPercent) + '% used' : Number.isFinite(row.remainingAmount) ? row.remainingAmount.toLocaleString() + ' units left' : row.status || 'Not reported'}`).join(' · ');
    if (plan?.available === false) return plan.reason || 'Usage not reported for this connection';
    if (!usage || typeof usage !== 'object') return 'Usage not reported';
    const periods = [usage.primary, usage.secondary].filter(period => period && typeof period.usedPercent === 'number');
    if (periods.length) return periods.map(period => { const minutes = period.windowDurationMins, label = minutes >= 10080 ? 'Weekly' : minutes >= 1440 ? 'Daily' : minutes >= 60 ? `${Math.round(minutes / 60)}-hour` : 'Current'; return `${label}: ${Math.round(period.usedPercent)}% used`; }).join(' · ');
    if (typeof usage.utilization === 'number') return `${Math.round(usage.utilization * 100)}% used`;
    return 'Usage in the details';
  }
  function accountState() { const state = api().getState(); return JSON.stringify([state.accounts, state.accountChecks, state.accountsChecking, state.usage]); }
  // Checks run in the background; the row shows progress at once and redraws when the answer arrives.
  function recheck() { api().refreshAccounts({ force: true }).catch(() => {}); render('accounts'); }
  function accounts(host) {
    const state = api().getState(), rows = kit.group(host, 'Agent accounts', 'Codeshi uses the accounts already signed in on this computer. Models and reasoning effort are chosen in the message box.');
    accountSignature = accountState();
    for (const provider of ['codex', 'claude', 'gemini']) {
      const account = state.accounts?.[provider], check = state.accountChecks?.[provider] || {}, checking = Boolean(state.accountsChecking?.[provider]), guide = installGuides[provider];
      const refresh = kit.button('', recheck, 'settings-icon-button settings-refresh'); refresh.append(node('span', 'Refresh status', 'sr-only')); refresh.title = 'Refresh status'; refresh.disabled = checking;
      const status = checking ? 'Checking…' : !account ? check.failure === 'timeout' ? 'Check timed out' : 'Status unavailable' : accountLabel(account);
      const tone = checking ? '' : !account ? 'warning' : account.authenticated === true ? 'positive' : account.installed ? 'warning' : '';
      let summary = '', controls = [];
      if (!account) { summary = checking ? '' : check.failure === 'timeout' ? `${providerName(provider)} did not answer in time.` : check.error || 'This connection has not been checked yet.'; controls = checking ? [] : [kit.button('Try again', recheck)]; }
      else if (!account.installed) { summary = guide.note; controls = [provider === 'gemini' ? installButton() : kit.button(`How to install ${providerName(provider)} ↗`, () => openExternal(guide.url))]; }
      else {
        summary = [account.planType || account.subscriptionType ? `${String(account.planType || account.subscriptionType).replace(/[_-]/g, ' ')} plan` : '', billingLabel(account), usageLabel(account.usage, state.usage?.[provider])].filter(Boolean).join(' · ');
        if (account.authenticated !== true) controls.push(kit.button('Connect account', () => connect(provider, row), 'primary'));
        if (provider === 'gemini' && account.source !== 'antigravity-acp') controls.push(installButton());
        controls.push(kit.button('Usage & limits', () => { modal.close(); window.relayUsage?.open(provider); }));
      }
      const row = kit.row(rows, { label: providerName(provider), keywords: `${provider} account sign in connect usage plan billing`, control: [...controls, refresh] });
      row.classList.add('settings-account'); row.dataset.provider = provider;
      const text = row.querySelector('.settings-row-text'), line = node('span', undefined, 'settings-row-description');
      const dot = node('span', status, `settings-status ${tone}`); line.append(dot); if (summary) line.append(document.createTextNode(` · ${summary}`)); text.append(line);
      if (account && check.failure) text.append(node('span', `The last check ${check.failure === 'timeout' ? 'timed out' : 'failed'} at ${date(check.failedAt)}, so this shows the result from ${date(check.checkedAt)}.`, 'settings-row-description warning'));
      // The details: what Codeshi knows about the account, and the actions you need less often.
      const details = kit.details(row, 'Details'), facts = node('dl', undefined, 'settings-facts'), fact = (label, value) => { const item = node('div'); item.append(node('dt', label), node('dd', value)); facts.append(item); };
      if (account?.installed) {
        fact('Billing', billingLabel(account)); if (account.planType || account.subscriptionType) fact('Plan', String(account.planType || account.subscriptionType).replace(/[_-]/g, ' ')); fact('Usage', usageLabel(account.usage, state.usage?.[provider]));
        fact('Selected model', state.conversation?.models?.[provider] || (state.provider === provider ? state.model : '') || 'Provider default');
        if (state.conversation?.lastRun?.provider === provider && state.conversation.lastRun.effectiveModel) fact('Last used', state.conversation.lastRun.effectiveModel);
      }
      fact('Last checked', date(check.checkedAt) || 'Not yet'); details.append(facts);
      if (account && !account.installed && guide.command) details.append(node('pre', guide.command, 'settings-code'));
      if (provider === 'gemini' && account?.installed) details.append(node('p', account.message || 'Gemini connects through Google Antigravity. Models and usage limits come from your Google account.', 'settings-note'));
      const more = node('div', undefined, 'settings-actions');
      if (provider === 'gemini') more.append(kit.button('Antigravity setup guide ↗', () => openExternal(guide.url)), kit.button('Google terms ↗', () => openExternal('https://antigravity.google/terms')));
      if (account?.authenticated === true) more.append(kit.button('Disconnect account', async () => { await api().post(`/api/providers/${provider}/disconnect`); recheck(); }, 'danger'));
      if (more.childNodes.length) details.append(more);
      if (account) { const raw = kit.details(details, 'Technical details'); raw.append(node('pre', JSON.stringify(account, null, 2), 'settings-code')); }
    }
    const billing = kit.group(host, 'Billing');
    kit.toggle(billing, { label: 'Allow API and unconfirmed billing', description: 'For this session, let runs use an account billed by API usage, or one whose billing can’t be confirmed. Subscription accounts don’t need this.', keywords: 'api charges cost billing accept', checked: window.relayBillingConfirmed === true, onChange: value => { window.relayBillingConfirmed = value; window.dispatchEvent(new CustomEvent('relay-billing')); } });
    const about = kit.details(host, 'About account connections');
    kit.note(about, 'Sign-in uses each provider’s own flow, and credentials stay with the provider; Codeshi never switches you to API billing by itself. Codex read-only uses its own sandbox, and Claude and the Gemini CLI connection restrict their tools. Antigravity coding uses its own approvals and workspace trust, so choose Codex or Claude for read-only work. Managed runs turn off project hooks where supported; administrator policy may still apply.');
  }
  // Downloading Google's connection takes a moment, so its button says so until it is done.
  function installButton() {
    const button = kit.button('Install Google connection', async () => {
      button.textContent = 'Installing…'; button.disabled = true;
      try { await api().post('/api/providers/gemini/install', {}, null); } finally { button.textContent = 'Install Google connection'; button.disabled = false; }
      recheck();
    }, 'primary');
    return button;
  }
  async function connect(provider, row) {
    const result = await api().post(`/api/providers/${provider}/connect`), url = result.authUrl || result.url;
    row.querySelector('.settings-row-feedback')?.remove();
    const feedback = node('div', undefined, 'settings-row-feedback'); feedback.setAttribute('role', 'status');
    feedback.append(node('span', result.message || (url ? 'Open the provider’s sign-in page to finish, then refresh.' : 'Finish signing in in the provider’s window, then refresh.')));
    if (url) feedback.append(kit.button('Open sign-in page', () => openExternal(url), 'primary'));
    row.append(feedback);
  }

  // Alerts and Voice are drawn by their own modules, and the recap goes with alerts: it is how you hear what happened.
  function alerts(host) {
    if (window.relayAlerts) { const part = node('div', undefined, 'settings-section'); host.append(part); window.relayAlerts.settings(part, kit); }
    if (window.relayRecap) { const part = node('div', undefined, 'settings-section'); host.append(part); window.relayRecap.settings(part, kit); }
  }
  function voice(host) { if (window.relayVoice) { const part = node('div', undefined, 'settings-section'); host.append(part); window.relayVoice.settings(part, kit); } else kit.note(host, 'Voice is not available here.'); }
  const DRAW = { general, accounts, alerts, voice };

  // Every page is drawn when Settings opens, so search can look through all of them; one shows at a time.
  function render(name) {
    const section = node('section', undefined, 'settings-page'); section.dataset.page = name;
    section.append(node('h2', PAGES.find(([id]) => id === name)[1], 'settings-page-heading'));
    DRAW[name](section);
    if (sections[name]) sections[name].replaceWith(section); else content.append(section);
    sections[name] = section; show();
  }
  function renderAll() { content.replaceChildren(); sections = {}; for (const [name] of PAGES) render(name); }
  // What shows: the chosen page, or, while searching, every row that matches on any page.
  function show() {
    const query = search.value.trim().toLowerCase(), terms = query.split(/\s+/).filter(Boolean);
    modal.classList.toggle('searching', terms.length > 0);
    title.textContent = terms.length ? `Results for “${search.value.trim()}”` : PAGES.find(([id]) => id === page)[1];
    nav.querySelectorAll('[data-page]').forEach(button => button.setAttribute('aria-current', !terms.length && button.dataset.page === page ? 'page' : 'false'));
    let found = 0;
    for (const [name, section] of Object.entries(sections)) {
      if (!terms.length) { section.hidden = name !== page; for (const item of section.querySelectorAll('.settings-row')) item.hidden = false; for (const group of section.querySelectorAll('.settings-group')) group.hidden = false; for (const note of section.querySelectorAll('.settings-note')) note.hidden = false; continue; }
      let shown = 0;
      for (const item of section.querySelectorAll('.settings-row')) { const group = item.closest('.settings-group'), text = `${item.textContent} ${item.dataset.keywords || ''} ${group?.querySelector('h3')?.textContent || ''}`.toLowerCase(), match = terms.every(term => text.includes(term)); item.hidden = !match; if (match) shown++; }
      for (const group of section.querySelectorAll('.settings-group')) group.hidden = ![...group.querySelectorAll('.settings-row')].some(item => !item.hidden);
      for (const note of section.querySelectorAll('.settings-note')) if (!note.closest('.settings-row')) note.hidden = true;
      section.hidden = !shown; found += shown;
    }
    $('settings-empty').hidden = !terms.length || found > 0;
  }
  async function open(next = 'general', heading = null) {
    page = HEADINGS[heading] || ALIASES[next] || (PAGES.some(([id]) => id === next) ? next : 'general');
    search.value = ''; error.hidden = true;
    // Opening Settings checks again any account whose last check is old or failed, in the background.
    if (!modal.open) { modal.showModal(); keepAwake = null; handoff = null; api().refreshAccounts({ force: false }).catch(() => {}); renderAll(); } else show();
    if (heading) [...sections[page].querySelectorAll('h3')].find(item => item.textContent === heading)?.scrollIntoView?.({ block: 'start' });
  }

  nav.addEventListener('click', event => { const target = event.target.closest('[data-page]'); if (!target) return; page = target.dataset.page; search.value = ''; show(); content.scrollTop = 0; });
  search.addEventListener('input', show);
  search.addEventListener('keydown', event => { if (event.key === 'Escape' && search.value) { event.preventDefault(); event.stopPropagation?.(); search.value = ''; show(); } });
  $('settings-close').addEventListener('click', () => modal.close());
  modal.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('relay-settings')?.addEventListener('click', () => open('general'));
  // Keep awake can change from the status bar, the menus or the menu bar status while Settings is open.
  window.relayDesktop?.onKeepAwakeChanged?.(state => { keepAwake = state; const box = $('settings-keep-awake'); if (box) box.checked = state.enabled === true; });
  window.addEventListener('relay-state', () => { if (modal.open && !busy && sections.accounts && accountSignature !== accountState()) render('accounts'); });
  window.relaySettings = { open, close: () => modal.close(), isOpen: () => modal.open, kit };
})();

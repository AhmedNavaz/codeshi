(() => {
  'use strict';
  // Settings (⌘,): how Codeshi looks and behaves, one page per subject: General (the view and the computer while
  // agents work), Appearance, Agents & accounts, Routing & handoffs, Testing, Phone & remote, Voice, Alerts and Updates. Every setting is one row in a titled group: what it is and what it
  // does on the left, its control on the right. The search box finds a setting on any page. Other modules draw their
  // own groups with the kit below, so every page reads the same way. Ask a friend is a dialog of its own.
  const $ = id => document.getElementById(id), api = () => window.relayUI;
  // The interface language (#27): each text is the English, translated when the chosen language has it.
  const { t, tn } = window.codeshiText;
  const modal = $('settings'), content = $('settings-content'), nav = $('settings-nav'), search = $('settings-search'), error = $('settings-error'), title = $('settings-title');
  if (!modal || !content) return;
  const PAGES = [['general', t('General')], ['appearance', t('Appearance')], ['accounts', t('Agents & accounts')], ['routing', t('Routing & handoffs')], ['testing', t('Testing')], ['phone', t('Phone & remote')], ['voice', t('Voice')], ['alerts', t('Alerts')], ['updates', t('Updates')]];
  // Places in Settings by the names other parts of the app used before it had these pages.
  const ALIASES = { preferences: 'general', connections: 'accounts', remote: 'phone', handoff: 'routing', context: 'routing' };
  const HEADINGS = { Alerts: 'alerts', Voice: 'voice', Updates: 'updates', Appearance: 'appearance', Testing: 'testing', 'Remote access': 'phone', 'While agents work': 'general' };
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const providerName = provider => ({ codex: 'Codex', claude: 'Claude', gemini: 'Gemini' })[provider];
  const openExternal = async url => { if (window.relayDesktop?.openExternal) await window.relayDesktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer'); };
  const date = value => { if (!value) return ''; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); };
  let page = 'general', busy = false, sections = {}, accountSignature = '', keepAwake = null, handoff = null;

  async function perform(fn) {
    if (busy) return; busy = true; error.hidden = true; modal.setAttribute('aria-busy', 'true');
    try { await fn(); } catch (failure) { error.textContent = failure.message || t('This could not be done. Please try again.'); error.hidden = false; }
    finally { busy = false; modal.removeAttribute('aria-busy'); }
  }

  // The parts every page is built from. A group is a titled list of rows. A row says what a setting is and does, with
  // its control on the right; a switch or a list is part of the row's label, so clicking the words changes it too.
  const words = (label, description) => { const text = node('span', undefined, 'settings-row-text'); text.append(node('span', label, 'settings-row-label')); if (description) text.append(node('span', description, 'settings-row-description')); return text; };
  // A screen reader names a switch or list by its label alone and reads the description after it (#26), rather than
  // reading the whole row as its name.
  let described = 0;
  const name = (control, text, label) => {
    control.setAttribute('aria-label', label);
    const description = text.querySelector?.('.settings-row-description') || text.childNodes?.[1];
    if (description) { description.id ||= `settings-description-${++described}`; control.setAttribute('aria-describedby', description.id); }
  };
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
      const text = words(label, description); name(box, text, label);
      row.append(text, box); if (keywords) row.dataset.keywords = keywords;
      rows.append(row); return box;
    },
    select(rows, { label, description, keywords, options, value, disabled = false, onChange }) {
      const row = node('label', undefined, 'settings-row'), select = node('select', undefined, 'settings-select');
      for (const [optionValue, text] of options) { const option = node('option', text); option.value = optionValue; select.append(option); }
      select.value = value; select.disabled = Boolean(disabled); select.addEventListener('change', () => onChange(select.value));
      const text = words(label, description); name(select, text, label);
      row.append(text, select); if (keywords) row.dataset.keywords = keywords;
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

  // General: which view you work in, and what the computer does while agents work.
  function general(host) {
    const view = kit.group(host, t('View')), flow = window.relayFlow, current = flow?.isOn?.() ? 'flow' : 'normal';
    const choices = kit.segmented([['normal', t('Normal')], ['flow', t('Flow')]], current, value => {
      if ((value === 'flow') === Boolean(flow?.isOn?.())) return;
      const changed = value === 'flow' ? flow?.enter?.() : flow?.leave?.();
      if (changed !== false) { modal.close(); return; }
      render('general');
    }, t('View'));
    kit.row(view, { label: t('View'), description: t('Normal gives you every panel and lets you choose the agent, model and effort for each message. Flow is just the chat with plain-language cards either side, and Codeshi chooses for you. You can also switch with the Flow button in the header.'), keywords: 'flow normal mode view layout routing default start', control: choices });
    // Suggestions (#106) and usage notices: one switch for both, saved for every workspace.
    const tips = window.relaySuggestions;
    if (tips) {
      const box = kit.toggle(view, { label: t('Suggestions after a run'), description: t('When a run ends, one line above the message box can say a run used more than usual, or point to a feature that fits what just happened, such as remembering a rule you keep repeating. Each says why it appeared, and nothing changes until you choose it. Codeshi works them out on this computer with no model call, and points to at most two features a day.'), keywords: 'suggestions tips hints usage notices remember skill flow nudge', checked: tips.enabled(), onChange: value => perform(async () => {
        box.disabled = true;
        try { box.checked = await tips.setEnabled(value); } finally { box.disabled = false; }
      }) });
      box.id = 'settings-suggestions';
    }
    const bridge = window.relayDesktop;
    if (bridge?.getKeepAwake && bridge?.setKeepAwake) {
      const work = kit.group(host, t('While agents work'));
      const box = kit.toggle(work, { label: t('Keep awake'), description: t('Keep the computer awake while an agent works or waits for a usage limit to reset, then let it sleep as usual.'), keywords: 'sleep display power', checked: keepAwake?.enabled === true, disabled: !keepAwake, onChange: value => perform(async () => {
        box.disabled = true;
        try { keepAwake = await bridge.setKeepAwake(value); }
        finally { box.checked = keepAwake?.enabled === true; box.disabled = false; }
      }) });
      box.id = 'settings-keep-awake';
      if (!keepAwake) bridge.getKeepAwake().then(state => { keepAwake = state; box.checked = state.enabled === true; box.disabled = false; }).catch(() => { if (box.isConnected) { error.textContent = t('Keep awake could not be loaded. Close Settings and try again.'); error.hidden = false; } });
    }
    // The interface language (#27), once a catalog gives a language besides English. Each language is listed by its
    // own name. Choosing one reloads the window; the desktop menus follow.
    const slot = node('div'); host.append(slot);
    api().api('/api/preferences').then(value => {
      const listed = Array.isArray(value.languages) ? value.languages : [];
      if (listed.length < 2 || !slot.isConnected) return;
      // Following the computer, it says which language that gives.
      const current = (value.language || 'system') === 'system' && listed.find(item => item.id === value.activeLanguage)?.name;
      const rows = kit.group(slot, t('Language'));
      const select = kit.select(rows, { label: t('Language'), description: t('The language of menus, buttons and settings. Parts of Codeshi that aren’t translated yet stay in English, and agents still answer in the language you write in. Changing it reloads the window.'), keywords: 'language translation locale interface english',
        options: [['system', current ? t('Same as the computer ({language})', { language: current }) : t('Same as the computer')], ...listed.map(item => [item.id, item.name])], value: value.language || 'system',
        onChange: next => perform(async () => { select.disabled = true; await api().post('/api/preferences', { language: next }); window.location.reload(); }) });
      select.id = 'settings-language';
    }).catch(() => {});
  }
  // Appearance: the theme and the size of text around the conversation.
  function appearance(host) {
    const look = kit.group(host, t('Appearance')), theme = node('div', undefined, 'segmented');
    theme.setAttribute('role', 'group'); theme.setAttribute('aria-label', t('Theme'));
    for (const [value, text] of [['system', t('System')], ['light', t('Light')], ['dark', t('Dark')], ['graphite', t('Graphite')]]) {
      const choice = node('button', text); choice.type = 'button'; choice.setAttribute('data-appearance', value);
      choice.setAttribute('aria-pressed', String(window.relayTheme?.preference() === value)); choice.addEventListener('click', () => window.relayTheme?.choose(value)); theme.append(choice);
    }
    kit.row(look, { label: t('Theme'), description: t('Light is cream paper. Dark is near-black, for low light and OLED screens. Graphite is the warm dark. System switches between Light and Dark with your computer.'), keywords: 'appearance theme dark light graphite black oled mode colour color', control: theme });
    const themeStatus = kit.note(host, ''); themeStatus.id = 'appearance-status'; themeStatus.setAttribute('role', 'status');
    const size = kit.segmented([['default', t('Default')], ['large', t('Larger')]], window.relayTheme?.textSize?.() || 'default', value => { window.relayTheme?.setTextSize?.(value); render('appearance'); }, t('Text size'));
    kit.row(look, { label: t('Text size'), description: t('Larger raises the sidebar, panels, Settings and the status bar by about a point. Messages keep their size.'), keywords: 'font typography scale bigger smaller readable size zoom', control: size });
  }
  // Routing & handoffs: what happens near a usage limit, and when an agent's memory is refreshed.
  function routing(host) {
    const work = kit.group(host, t('Handoffs and context'));
    if (window.relayFlow?.isOn?.()) {
      const routing = window.relayRouting, mode = routing.normalizeMode?.(api().getState().conversation?.routing?.mode) || api().getState().conversation?.routing?.mode || 'smart';
      kit.row(work, { label: t('Flow handoff'), description: t('Follows {mode} routing: at {percent}% used, continue with another eligible subscription agent with confirmed room. Change the mode in Flow’s routing card.', { mode: routing.modeNames[mode], percent: routing.handoffThresholds[mode] }), keywords: 'handoff hand off automatic routing limit quota switch agent' });
    } else {
    const offer = kit.select(work, { label: t('Offer a handoff near a usage limit'), description: t('When an agent is close to its limit, offer to continue the task with another connected agent.'), keywords: 'handoff hand off limit quota switch agent', options: [['0', t('Never')], ['80', t('At 80%')], ['90', t('At 90%')], ['95', t('At 95%')]], value: String(handoff?.threshold ?? 90), disabled: !handoff, onChange: value => saveHandoff({ threshold: Number(value) }) });
    const automatic = kit.toggle(work, { label: t('Hand off automatically'), description: t('Near a limit, or when a run reaches one, switch to an agent on a subscription without asking, and say so in the conversation. If every agent is out, the task waits for the first reset.'), keywords: 'handoff hand off automatic', checked: handoff?.automatic === true, disabled: !handoff || handoff.threshold === 0, onChange: value => saveHandoff({ automatic: value }) });
    if (!handoff) api().api('/api/handoff-preferences').then(value => { handoff = value; offer.value = String(value.threshold); offer.disabled = false; automatic.checked = value.automatic === true; automatic.disabled = value.threshold === 0; }).catch(() => {});
    }
    if (window.relayFlow?.isOn?.()) {
      kit.row(work, { label: t('Context refresh'), description: t('Flow adapts the refresh target to the routing mode, recent provider activity and reported model window. Recent sessions keep more context to avoid unnecessary restarts. Refresh happens between turns and chat history stays complete.'), keywords: 'context compact compaction token memory limit' });
    } else {
      let savedLimit = 'auto';
      const custom = node('input', undefined, 'settings-select'); custom.type = 'number'; custom.min = '8000'; custom.max = '1000000'; custom.step = '1000'; custom.value = '75000'; custom.id = 'settings-context-custom'; custom.setAttribute('aria-label', t('Custom context token limit')); custom.hidden = true;
      const save = value => perform(async () => {
        limit.disabled = true;
        try { const result = await api().post('/api/preferences', { contextLimit: value }); savedLimit = result.contextLimit ?? 'auto'; await api().refresh(); }
        finally { limit.value = typeof savedLimit === 'number' && ![50000, 100000, 150000].includes(savedLimit) ? 'custom' : String(savedLimit); limit.disabled = false; custom.hidden = limit.value !== 'custom'; customRow.hidden = custom.hidden; }
      });
      const limit = kit.select(work, { label: t('Context limit'), description: t('Before another turn, refresh agent memory in a fresh native session when its reported context signal reaches this limit. Full chat history stays saved. Off leaves native compaction in charge.'), keywords: 'context tokens threshold compact compaction memory refresh', options: [['off', t('Off')], ['auto', t('Auto (by model)')], ['50000', t('50,000 tokens')], ['100000', t('100,000 tokens')], ['150000', t('150,000 tokens')], ['custom', t('Custom…')]], value: 'auto', disabled: true,
        onChange: value => { custom.hidden = value !== 'custom'; customRow.hidden = custom.hidden; if (value === 'custom') { custom.focus(); return; } save(['off', 'auto'].includes(value) ? value : Number(value)); } });
      limit.id = 'settings-context-limit';
      const customRow = kit.row(work, { label: t('Custom context limit'), description: t('8,000–1,000,000 tokens. Takes effect on the next turn.'), control: custom }); customRow.hidden = true;
      custom.addEventListener('change', () => save(Number(custom.value)));
      api().api('/api/preferences').then(value => { savedLimit = value.contextLimit ?? 'auto'; limit.value = typeof savedLimit === 'number' && ![50000, 100000, 150000].includes(savedLimit) ? 'custom' : String(savedLimit); custom.hidden = limit.value !== 'custom'; customRow.hidden = custom.hidden; if (typeof savedLimit === 'number') custom.value = String(savedLimit); limit.disabled = false; }).catch(() => {});
      kit.note(work.parentNode, t('Auto targets 120,000 tokens after recent provider activity and 75,000 after a longer pause, capped at 75% of the reported model window. Cache lifetime uses provider reports when available and otherwise a conservative five-minute estimate; cache hits are not guaranteed. Custom limits stay fixed. Older unmeasured sessions refresh once. Recorded activity supplies a labeled byte estimate when native readings are missing. Native agents manage compaction during a run. Compact context or /compact schedules a manual refresh without a model call.'));
    }
  }
  // Testing: when agents run broad checks.
  function testing(host) {
    const testing = kit.group(host, t('Testing'));
    let savedCadence = 'as-needed';
    const cadence = kit.select(testing, {
      label: t('Testing cadence'),
      description: t('Review first keeps checks small while you request changes. Ask to test, verify, finalize, commit, push or release when you want the agent to verify the current changes first.'),
      keywords: 'tests verification review iterations broad suite token time finalize commit push release',
      options: [['as-needed', t('As needed')], ['review-first', t('Review first')]], value: savedCadence, disabled: true,
      onChange: value => perform(async () => {
        cadence.disabled = true;
        try {
          const result = await api().post('/api/preferences', { verificationCadence: value });
          savedCadence = result.verificationCadence;
          await api().refresh();
        } finally { cadence.value = savedCadence; cadence.disabled = false; }
      }),
    });
    cadence.id = 'settings-testing-cadence';
    api().api('/api/preferences').then(value => { savedCadence = value.verificationCadence || 'as-needed'; cadence.value = savedCadence; cadence.disabled = false; }).catch(() => { if (cadence.isConnected) { error.textContent = t('Testing preferences could not be loaded. Close Settings and try again.'); error.hidden = false; } });
    kit.note(testing.parentNode, t('Applies to new turns in every workspace, in Normal and Flow. Running agents keep their starting setting. Review first defers Codeshi’s routine automatic test command and repair loop; explicitly selected build/review workflows and required repository checks still apply. Agents receive guidance, not a command block, and must report deferred verification honestly.'));
  }
  function phone(host) { if (window.relayPhone) window.relayPhone.settings(host, kit); else kit.note(host, t('Phone access is not available here.')); }
  function updates(host) {
    if (window.relayUpdater) { const part = node('div', undefined, 'settings-section'); host.append(part); window.relayUpdater.settings(part, kit); }
    else kit.note(host, t('Updates are handled where you installed Codeshi.'));
  }
  // Turned on from the offer at a usage limit.
  window.addEventListener('relay-handoff-preferences', () => { handoff = null; });
  async function saveHandoff(patch) {
    await perform(async () => { handoff = await api().post('/api/handoff-preferences', patch); });
    if (sections.routing) render('routing');
  }

  // Accounts: one row for each agent, with its status, plan and usage, what to do next, and its details on request.
  const installGuides = {
    codex: { command: 'npm install -g @openai/codex', url: 'https://github.com/openai/codex', note: () => t('Install the Codex CLI, or the ChatGPT or Codex app for macOS, on this computer, then refresh.') },
    claude: { command: 'curl -fsSL https://claude.ai/install.sh | bash', url: 'https://code.claude.com/docs/en/overview', note: () => t('Install Claude Code and run claude in Terminal to sign in, then refresh.') },
    gemini: { command: '', url: 'https://antigravity.google/docs/install', note: () => t('Codeshi downloads Google’s official Antigravity connection and checks it, then you sign in with Google. Google’s terms and account limits apply.') },
  };
  function accountLabel(account) { return !account.installed ? t('Not installed') : account.authenticated === true ? t('Connected') : account.authenticated === false ? t('Sign-in required') : t('Connection not confirmed'); }
  function billingLabel(account) { return account.authMode === 'google-oauth' && account.billingSource === 'subscription' ? t('Google account allowance') : account.billingSource === 'subscription' ? t('Your subscription') : account.billingSource === 'api' ? t('API usage') : t('Billing not reported'); }
  function usageLabel(usage, plan) {
    if (plan?.available && plan.windows?.length) return plan.windows.map(row => `${row.label}: ${row.disabled ? t('Disabled') : Number.isFinite(row.usedPercent) ? t('{percent}% used', { percent: Math.round(row.usedPercent) }) : Number.isFinite(row.remainingAmount) ? tn(row.remainingAmount, '1 unit left', '{count} units left') : row.status || t('Not reported')}`).join(' · ');
    if (plan?.available === false) return plan.reason || t('Usage not reported for this connection');
    if (!usage || typeof usage !== 'object') return t('Usage not reported');
    const periods = [usage.primary, usage.secondary].filter(period => period && typeof period.usedPercent === 'number');
    if (periods.length) return periods.map(period => { const minutes = period.windowDurationMins, percent = Math.round(period.usedPercent); return minutes >= 10080 ? t('Weekly: {percent}% used', { percent }) : minutes >= 1440 ? t('Daily: {percent}% used', { percent }) : minutes >= 60 ? t('{hours}-hour: {percent}% used', { hours: Math.round(minutes / 60), percent }) : t('Current: {percent}% used', { percent }); }).join(' · ');
    if (typeof usage.utilization === 'number') return t('{percent}% used', { percent: Math.round(usage.utilization * 100) });
    return t('Usage in the details');
  }
  function accountState() { const state = api().getState(); return JSON.stringify([state.accounts, state.accountChecks, state.accountsChecking, state.usage]); }
  // Checks run in the background; the row shows progress at once and redraws when the answer arrives.
  function recheck() { api().refreshAccounts({ force: true }).catch(() => {}); render('accounts'); }
  function accounts(host) {
    const state = api().getState(), rows = kit.group(host, t('Agent accounts'), t('Codeshi uses the accounts already signed in on this computer. Models and reasoning effort are chosen in the message box.'));
    accountSignature = accountState();
    for (const provider of ['codex', 'claude', 'gemini']) {
      const account = state.accounts?.[provider], check = state.accountChecks?.[provider] || {}, checking = Boolean(state.accountsChecking?.[provider]), guide = installGuides[provider];
      const refresh = kit.button('', recheck, 'settings-icon-button settings-refresh'); refresh.append(node('span', t('Refresh status'), 'sr-only')); refresh.title = t('Refresh status'); refresh.disabled = checking;
      const status = checking ? t('Checking…') : !account ? check.failure === 'timeout' ? t('Check timed out') : t('Status unavailable') : accountLabel(account);
      const tone = checking ? '' : !account ? 'warning' : account.authenticated === true ? 'positive' : account.installed ? 'warning' : '';
      let summary = '', controls = [];
      if (!account) { summary = checking ? '' : check.failure === 'timeout' ? t('{agent} did not answer in time.', { agent: providerName(provider) }) : check.error || t('This connection has not been checked yet.'); controls = checking ? [] : [kit.button(t('Try again'), recheck)]; }
      else if (!account.installed) { summary = guide.note(); controls = [provider === 'gemini' ? installButton() : kit.button(t('How to install {agent} ↗', { agent: providerName(provider) }), () => openExternal(guide.url))]; }
      else {
        summary = [account.planType || account.subscriptionType ? t('{plan} plan', { plan: String(account.planType || account.subscriptionType).replace(/[_-]/g, ' ') }) : '', billingLabel(account), usageLabel(account.usage, state.usage?.[provider])].filter(Boolean).join(' · ');
        if (account.authenticated !== true) controls.push(kit.button(t('Connect account'), () => connect(provider, row), 'primary'));
        if (provider === 'gemini' && account.source !== 'antigravity-acp') controls.push(installButton());
        controls.push(kit.button(t('Usage & limits'), () => { modal.close(); window.relayUsage?.open(provider); }));
      }
      const row = kit.row(rows, { label: providerName(provider), keywords: `${provider} account sign in connect usage plan billing`, control: [...controls, refresh] });
      row.classList.add('settings-account'); row.dataset.provider = provider;
      const text = row.querySelector('.settings-row-text'), line = node('span', undefined, 'settings-row-description');
      const dot = node('span', status, `settings-status ${tone}`); line.append(dot); if (summary) line.append(document.createTextNode(` · ${summary}`)); text.append(line);
      if (account && check.failure) text.append(node('span', check.failure === 'timeout' ? t('The last check timed out at {failed}, so this shows the result from {checked}.', { failed: date(check.failedAt), checked: date(check.checkedAt) }) : t('The last check failed at {failed}, so this shows the result from {checked}.', { failed: date(check.failedAt), checked: date(check.checkedAt) }), 'settings-row-description warning'));
      // The details: what Codeshi knows about the account, and the actions you need less often.
      const details = kit.details(row, t('Details')), facts = node('dl', undefined, 'settings-facts'), fact = (label, value) => { const item = node('div'); item.append(node('dt', label), node('dd', value)); facts.append(item); };
      if (account?.installed) {
        fact(t('Billing'), billingLabel(account)); if (account.planType || account.subscriptionType) fact(t('Plan'), String(account.planType || account.subscriptionType).replace(/[_-]/g, ' ')); fact(t('Usage'), usageLabel(account.usage, state.usage?.[provider]));
        fact(t('Selected model'), state.conversation?.models?.[provider] || (state.provider === provider ? state.model : '') || t('Provider default'));
        if (state.conversation?.lastRun?.provider === provider && state.conversation.lastRun.effectiveModel) fact(t('Last used'), state.conversation.lastRun.effectiveModel);
      }
      fact(t('Last checked'), date(check.checkedAt) || t('Not yet')); details.append(facts);
      if (account && !account.installed && guide.command) details.append(node('pre', guide.command, 'settings-code'));
      if (provider === 'gemini' && account?.installed) details.append(node('p', account.message || t('Gemini connects through Google Antigravity. Models and usage limits come from your Google account.'), 'settings-note'));
      const more = node('div', undefined, 'settings-actions');
      if (provider === 'gemini') more.append(kit.button(t('Antigravity setup guide ↗'), () => openExternal(guide.url)), kit.button(t('Google terms ↗'), () => openExternal('https://antigravity.google/terms')));
      if (account?.authenticated === true) more.append(kit.button(t('Disconnect account'), async () => { await api().post(`/api/providers/${provider}/disconnect`); recheck(); }, 'danger'));
      if (more.childNodes.length) details.append(more);
      if (account) { const raw = kit.details(details, t('Technical details')); raw.append(node('pre', JSON.stringify(account, null, 2), 'settings-code')); }
    }
    const billing = kit.group(host, t('Billing'));
    kit.toggle(billing, { label: t('Allow API and unconfirmed billing'), description: t('For this session, let runs use an account billed by API usage, or one whose billing can’t be confirmed. Subscription accounts don’t need this.'), keywords: 'api charges cost billing accept', checked: window.relayBillingConfirmed === true, onChange: value => { window.relayBillingConfirmed = value; window.dispatchEvent(new CustomEvent('relay-billing')); } });
    const about = kit.details(host, t('About account connections'));
    kit.note(about, t('Sign-in uses each provider’s own flow, and credentials stay with the provider; Codeshi never switches you to API billing by itself. Codex read-only uses its own sandbox, and Claude and the Gemini CLI connection restrict their tools. Antigravity coding uses its own approvals and workspace trust, so choose Codex or Claude for read-only work. Managed runs turn off project hooks where supported; administrator policy may still apply.'));
  }
  // Downloading Google's connection takes a moment, so its button says so until it is done.
  function installButton() {
    const button = kit.button(t('Install Google connection'), async () => {
      button.textContent = t('Installing…'); button.disabled = true;
      try { await api().post('/api/providers/gemini/install', {}, null); } finally { button.textContent = t('Install Google connection'); button.disabled = false; }
      recheck();
    }, 'primary');
    return button;
  }
  async function connect(provider, row) {
    const result = await api().post(`/api/providers/${provider}/connect`), url = result.authUrl || result.url;
    row.querySelector('.settings-row-feedback')?.remove();
    const feedback = node('div', undefined, 'settings-row-feedback'); feedback.setAttribute('role', 'status');
    feedback.append(node('span', result.message || (url ? t('Open the provider’s sign-in page to finish, then refresh.') : t('Finish signing in in the provider’s window, then refresh.'))));
    if (url) feedback.append(kit.button(t('Open sign-in page'), () => openExternal(url), 'primary'));
    row.append(feedback);
  }

  // Alerts and Voice are drawn by their own modules, and the recap goes with alerts: it is how you hear what happened.
  function alerts(host) {
    if (window.relayAlerts) { const part = node('div', undefined, 'settings-section'); host.append(part); window.relayAlerts.settings(part, kit); }
    if (window.relayRecap) { const part = node('div', undefined, 'settings-section'); host.append(part); window.relayRecap.settings(part, kit); }
  }
  function voice(host) { if (window.relayVoice) { const part = node('div', undefined, 'settings-section'); host.append(part); window.relayVoice.settings(part, kit); } else kit.note(host, t('Voice is not available here.')); }
  const DRAW = { general, appearance, accounts, routing, testing, phone, voice, alerts, updates };

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
    title.textContent = terms.length ? t('Results for “{query}”', { query: search.value.trim() }) : PAGES.find(([id]) => id === page)[1];
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
    if (heading) [...sections[page].querySelectorAll('h3')].find(item => item.textContent === t(heading))?.scrollIntoView?.({ block: 'start' }); // i18n-ignore: each heading is translated where it is drawn
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

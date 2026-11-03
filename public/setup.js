(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI, dialog = $('setup-dialog'), desktop = window.relayDesktop;
  // First run: a welcome, three short steps and a summary, then the app.
  // Existing profiles open normally after updates. The step number is saved so setup can resume.
  const steps = ['Agents', 'Preferences', 'Project'], titles = ['Connect your agents', 'Make it yours', 'Start your first project'], last = steps.length - 1;
  const installGuides = { claude: 'https://code.claude.com/docs/en/overview', codex: 'https://github.com/openai/codex', gemini: 'https://antigravity.google/docs/install' };
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  const button = (text, fn, cls = 'secondary-button') => { const el = node('button', text, cls); el.type = 'button'; el.addEventListener('click', () => perform(fn)); return el; };
  const field = (label, tag, value = '') => { const wrap = node('label',label), input = node(tag); input.value = value; wrap.append(input); return {wrap,input}; };
  const option = (select, text, value) => { const el = node('option',text); el.value = value; select.append(el); };
  const providerName = p => p === 'gemini' ? 'Gemini' : p === 'claude' ? 'Claude Code' : 'Codex';
  const titleCase = text => String(text).replace(/[_-]/g,' ').replace(/\b\w/g, letter => letter.toUpperCase());
  const computer = desktop?.platform === 'darwin' ? 'this Mac' : 'this computer';
  let connectionSignature = '';
  const connectionState = () => { const state = api.getState(); return JSON.stringify([state.accounts, state.accountsChecking, state.accountChecks]); };
  let preferences, screen = 'welcome', reviewing = false, shownStep = -1, advancedOpen = false;
  let step = 0, busy = false, revision = 0, catalog = {}, draft = {provider:'codex',model:null,effort:null,mode:'edit',billing:'subscription'}, projectName = '', projectPaths = '', created = '';
  function progress() {
    const completed = preferences?.onboarding?.completedAt;
    // The sidebar launcher is for unfinished setup only; Settings › Setup guide reopens it later.
    $('open-setup').hidden = Boolean(completed || preferences?.onboarding?.dismissed);
    $('setup-progress').textContent = completed ? 'Review' : `${step + 1} of ${steps.length}`;
    $('open-setup').setAttribute('aria-label', completed ? 'Review setup and app defaults' : `Getting started, step ${step + 1} of ${steps.length}`);
  }
  function error(message = '') { $('setup-error').textContent = message; $('setup-error').hidden = !message; }
  async function perform(fn) {
    if (busy) return; busy = true; error(); controls();
    try { await fn(); } catch (e) { error(e.message || 'Could not save setup. Try again.'); }
    finally { busy = false; controls(); }
  }
  function controls() { $('setup-next').disabled = busy; $('setup-back').disabled = busy || (reviewing && step === 0); $('close-setup').disabled = busy; dialog.setAttribute('aria-busy',String(busy)); }
  async function save({completed = false, dismissed = false} = {}) {
    preferences = await api.post('/api/preferences',{defaults:draft,onboarding:{step,completed,dismissed}},null);
    progress();
  }
  async function move(next) { const before=step; step = next; try { await save(); } catch(e) { step=before; throw e; } render(); }
  function hideLaunch() { const splash = $('launch-screen'); if (!splash || splash.classList.contains('done')) return; splash.classList.add('done'); setTimeout(() => { splash.hidden = true; }, 400); }
  function reveal() { const shell = document.querySelector('.app-shell'); shell?.classList.remove('app-reveal'); shell?.classList.add('app-reveal'); }
  function leave() { dialog.close(); reveal(); }
  async function dismiss() { await save({dismissed:true}); leave(); }
  async function complete() { await save({completed:true}); leave(); }
  async function openLink(url) { if (desktop) await desktop.openExternal(url); else window.open(url,'_blank','noopener,noreferrer'); }
  function show(name) {
    screen = name; dialog.dataset.screen = name; shownStep = -1;
    $('setup-hero').hidden = name === 'flow'; $('setup-flow').hidden = name !== 'flow';
    if (!dialog.open) dialog.showModal();
    render();
  }
  function render() { progress(); controls(); if (screen === 'flow') renderStep(); else renderHero(); }
  function renderHero() {
    const host = $('setup-hero-content'); host.replaceChildren();
    if (screen === 'welcome') {
      $('setup-title').textContent = 'Throughline';
      const points = node('ul',undefined,'onboarding-points');
      for (const text of ['Shared project context','Your own agent accounts','One conversation per project']) points.append(node('li',text));
      const start = button('Get started',()=>{ reviewing = false; show('flow'); },'primary-button onboarding-cta');
      host.append(node('p','Your workspace for AI coding agents. Work with Claude Code, Codex and Gemini using your own accounts.','onboarding-tagline'),points,start,node('p','Takes about a minute.','onboarding-note'));
      start.focus();
    }
    if (screen === 'done') {
      $('setup-title').textContent = 'You’re all set';
      const state = api.getState(), connected = state.accounts?.[draft.provider]?.authenticated === true, count = state.projects.length;
      const summary = node('ul',undefined,'onboarding-summary');
      const item = (done, title, text) => { const row = node('li',undefined,done ? 'done' : 'todo'); row.append(node('strong',title),node('span',text)); summary.append(row); };
      item(connected,`${providerName(draft.provider)} starts the conversation`,connected ? 'Connected with your own account.' : 'Connect it in Settings before your first message.');
      item(true,{light:'Light theme',graphite:'Dark theme'}[window.relayTheme?.preference()] || 'System theme',draft.mode === 'read' ? 'New workspaces start read only.' : 'Agents can edit files in your workspaces.');
      item(count > 0,count ? (created ? `${created} is ready` : `${count} workspace${count === 1 ? ' is' : 's are'} ready`) : 'No workspace yet',count ? 'Your conversation is waiting.' : 'Choose your project folders from the sidebar.');
      const open = button('Open Throughline',()=>complete(),'primary-button onboarding-cta');
      host.append(node('p','You can change any of this later in Settings.','onboarding-tagline'),summary,open); open.focus();
    }
  }
  function renderStep() {
    const version = ++revision, host = $('setup-content'), entering = shownStep !== step; shownStep = step;
    host.replaceChildren(); host.classList.toggle('entering',entering); host.dataset.step = String(step); $('setup-steps').replaceChildren();
    steps.forEach((title,index) => { const entry = button('',()=>move(index),'setup-step'); entry.append(node('span',undefined,'setup-step-bar'),node('span',title,'setup-step-label')); entry.setAttribute('aria-current',index === step ? 'step' : 'false'); entry.dataset.complete = String(index < step); $('setup-steps').append(entry); });
    $('setup-next').textContent = step < last ? 'Continue' : reviewing ? 'Done' : 'Finish';
    $('setup-step-status').textContent = `Step ${step + 1} of ${steps.length}`;
    $('close-setup').textContent = reviewing ? 'Close' : 'Skip for now';
    const heading = node('h2',titles[step],'onboarding-step-title'); heading.tabIndex = -1; host.append(heading);
    if (step === 0) agents(host);
    if (step === 1) preferencesStep(host,version);
    if (step === 2) project(host);
    if (entering) heading.focus();
  }
  function agents(host) {
    connectionSignature = connectionState();
    host.append(node('p',`Throughline works with Claude Code, Codex and Gemini on ${computer}, signed in with your own accounts. Choose which one starts the conversation; you can switch at any time without losing the thread.`,'setup-description'));
    const cards = node('div',undefined,'setup-agent-grid'); host.append(cards);
    for (const provider of ['claude','codex','gemini']) {
      const account = api.getState().accounts?.[provider], check = api.getState().accountChecks?.[provider], selected = draft.provider === provider, plan = account?.planType || account?.subscriptionType;
      const card = node('section',undefined,'setup-agent'); card.dataset.provider = provider; card.dataset.selected = String(selected);
      const select = button('',()=>{draft.provider=provider;draft.model=null;draft.effort=null;render();},'setup-agent-select'); select.setAttribute('aria-pressed',String(selected));
      select.append(node('i',undefined,'agent-icon '+provider),node('strong',providerName(provider)),node('span',selected ? 'Starts the conversation' : 'Start with this agent','setup-selection'));
      const [state,label] = api.getState().accountsChecking?.[provider] || !account && !check ? ['checking','Checking…'] : !account ? ['unknown',check.failure === 'timeout' ? 'Check timed out' : 'Not verified'] : !account.installed ? ['missing','Not installed'] : account.authenticated === true ? ['ready','Connected' + (plan ? ' · ' + titleCase(plan) : '')] : account.authenticated === false ? ['signin','Sign-in needed'] : ['unknown','Not verified'];
      const status = node('span',label,'setup-account-state'); status.dataset.state = state; status.dataset.connected = String(account?.authenticated === true);
      const billingNote = account?.installed === false
        ? (provider === 'gemini' ? `Connect Gemini through Google Antigravity` : `Install ${providerName(provider)} on ${computer}`)
        : account?.billingSource === 'subscription' ? (account.authMode === 'google-oauth' ? 'Uses your Google account allowance' : 'Uses your subscription') : account?.billingSource === 'api' ? 'Detected API billing' : 'Billing not reported yet';
      card.append(select,status,node('p',billingNote,'setup-billing'));
      if (account?.installed && account.authenticated !== true) card.append(button('Connect ' + providerName(provider),async()=>{
        const result = await api.post(`/api/providers/${provider}/connect`,{},null), url = result.authUrl || result.url;
        card.append(node('p',result.message || 'Finish signing in with the provider, then refresh.','setup-billing'));
        if (url) card.append(button('Open sign-in page',()=>openLink(url)));
      }));
      if (provider === 'gemini' && account?.source !== 'antigravity-acp') card.append(button('Install Google connection',async()=>{ card.append(node('p','Downloading the official Google connection…','setup-billing')); await api.post('/api/providers/gemini/install',{},null); await api.refreshAccounts({force:true}); render(); }));
      if (account?.installed === false) card.append(button(`How to install ${providerName(provider)}`,()=>openLink(installGuides[provider])));
      cards.append(card);
    }
    const tools = node('div',undefined,'setup-connection-tools'); host.append(tools);
    tools.append(button('Refresh',async()=>{const checking=api.refreshAccounts({force:true});render();await checking;render();}),node('span','You can also connect later in Settings.','setup-footnote'));
    const billing = field('Preferred billing connection','select',draft.billing); option(billing.input,'My existing subscription','subscription'); option(billing.input,'My existing API connection','api'); billing.input.value = draft.billing; billing.input.addEventListener('change',()=>{draft.billing=billing.input.value;});
    const advanced = node('details',undefined,'setup-advanced'); advanced.append(node('summary','Billing preference'),billing.wrap,node('p','Uses the accounts already on this computer. This does not purchase or change a plan. API billing requires review before a run.','setup-footnote')); host.append(advanced);
  }
  function preferencesStep(host,version) {
    host.append(node('p','Choose how Throughline looks and what agents can do by default. You can change both at any time.','setup-description'),node('h3','Appearance','setup-section-title'));
    const themes = node('div',undefined,'setup-theme-grid');
    // System shows both palettes, as it follows the computer.
    const sample = value => {
      if (value === 'system') { const pair = node('span',undefined,'theme-preview-pair'); pair.append(sample('graphite'),sample('light')); return pair; }
      const preview = node('span',undefined,value === 'light' ? 'theme-preview light' : 'theme-preview'), rail = node('i'), canvas = node('span',undefined,'theme-preview-canvas'); rail.append(node('b'),node('b'),node('b'));
      canvas.append(node('b','acme-shop'),node('em','✓ Tests pass'),node('i'),node('i'),node('small','Ask anything about your project…')); preview.append(rail,canvas); return preview;
    };
    // Choosing saves at once, as in the status bar and Settings, and all three show the same preference.
    for (const [value,label,text] of [['system','System','Follows your computer'],['graphite','Dark','Quiet graphite surfaces'],['light','Light','Bright, clear contrast']]) {
      const choice = button('',()=>window.relayTheme?.choose(value),'setup-theme'); choice.setAttribute('data-appearance',value); choice.setAttribute('aria-pressed',String(window.relayTheme?.preference() === value));
      choice.append(sample(value),node('strong',label),node('span',text,'muted')); themes.append(choice);
    }
    host.append(themes,node('h3','What agents can do','setup-section-title'));
    const access = node('div',undefined,'setup-access');
    for (const [value,label,text] of [['edit','Can edit files','Agents make changes in your workspace folders.'],['read','Read only','Agents read and answer without changing files.']]) {
      const choice = button('',()=>{draft.mode=value;render();},'setup-access-option'); choice.dataset.mode = value; choice.setAttribute('aria-pressed',String(draft.mode === value));
      choice.append(node('strong',label),node('span',text)); access.append(choice);
    }
    host.append(access);
    const advanced = node('details',undefined,'setup-advanced'); advanced.open = advancedOpen; advanced.addEventListener('toggle',()=>{advancedOpen=advanced.open;}); advanced.append(node('summary','Default model and effort'));
    const model = field('Default model','select'), effort = field('Reasoning effort','select'), note = node('p','Provider default follows the agent’s recommended model and reasoning effort.','setup-footnote');
    const pair = node('div',undefined,'setup-field-pair'); pair.append(model.wrap,effort.wrap); advanced.append(pair,note); host.append(advanced);
    function populate() {
      const rows=catalog[draft.provider] || [], selected=rows.find(row=>[row.id,row.model,row.value].includes(draft.model)) || (!draft.model && rows.find(row=>row.isDefault || row.value==='default'));
      model.input.replaceChildren(); option(model.input,'Provider default' + (selected && !draft.model ? ' · ' + (selected.displayName || selected.id || selected.value) : ''),'');
      for (const row of rows.filter(row=>row.value !== 'default')) option(model.input,row.displayName || row.name || row.id || row.value,row.id || row.model || row.value);
      if (draft.model && !rows.some(row=>[row.id,row.model,row.value].includes(draft.model))) option(model.input,draft.model + ' (saved)',draft.model);
      model.input.value=draft.model || ''; effort.input.replaceChildren(); option(effort.input,'Provider default','');
      const levels=selected?.supportedEffortLevels || selected?.supportedReasoningEfforts?.map(row=>row.reasoningEffort) || [];
      for(const value of levels) option(effort.input,value[0].toUpperCase()+value.slice(1),value);
      if(draft.effort && !levels.includes(draft.effort)) option(effort.input,draft.effort+' (saved)',draft.effort);
      effort.input.value=draft.effort || ''; effort.input.disabled=!levels.length;
    }
    model.input.addEventListener('change',()=>{draft.model=model.input.value || null;draft.effort=null;populate();}); effort.input.addEventListener('change',()=>{draft.effort=effort.input.value || null;}); populate();
    if(!catalog[draft.provider]) { const requested=draft.provider; model.input.disabled=true; note.textContent='Loading models reported by '+providerName(requested)+'…';
      api.api(`/api/providers/${requested}/models`,{},null).then(result=>{catalog[requested]=result.models || [];if(revision===version){populate();note.textContent='Provider default follows the agent’s recommended model. You can change models for each message.';}}).catch(()=>{if(revision===version) note.textContent='Models could not be loaded. Provider default remains available; refresh this step after connecting.';}).finally(()=>{if(revision===version)model.input.disabled=false;});
    }
  }
  async function createWorkspace(folders, name) {
    const project = await api.post('/api/projects',{folders,...(name ? {name} : {})},null);
    await api.refreshProjects(); await api.selectProject(project.id);
    created = project.name || 'Your workspace'; projectPaths = ''; projectName = ''; render();
  }
  function project(host) {
    const count = api.getState().projects.length;
    host.append(node('p','Choose the folders for your project. After setup, you can review earlier Claude Code and Codex conversations linked to those folders.','setup-description'));
    if (created) host.append(node('p',`${created} is ready. You can add more folders to it later in workspace settings.`,'setup-ready'));
    else if (count) host.append(node('p',`${count} workspace${count === 1 ? ' is' : 's are'} ready. Your saved chats stay as they are.`,'setup-ready'));
    const grid = node('div',undefined,'setup-start-grid');
    const card = (cls, title, text, fn) => { const el = button('',fn,'setup-start-card ' + cls); el.append(node('i',undefined,'setup-start-icon'),node('strong',title),node('span',text)); grid.append(el); return el; };
    if (desktop) card('setup-folder-card',created ? 'Open another folder' : 'Open a project folder',`Pick a folder on ${computer}. It becomes a workspace with its own conversation.`,async()=>{const picked=await desktop.pickFolder();if(picked)await createWorkspace(Array.isArray(picked)?picked:[picked]);});
    host.append(grid);
    const name = field('Workspace name (optional)','input',projectName), paths = field('Folder paths, one per line','textarea',projectPaths); paths.input.rows = 2; paths.input.placeholder = '~/projects/frontend\n~/projects/backend'; name.input.maxLength = 120;
    name.input.addEventListener('input',()=>{projectName=name.input.value;}); paths.input.addEventListener('input',()=>{projectPaths=paths.input.value;});
    const manual = node('details',undefined,'setup-advanced setup-paths'); manual.open = !desktop || Boolean(projectPaths);
    manual.append(node('summary','Enter folder paths instead'),name.wrap,paths.wrap,button('Create workspace',async()=>{const folders=[...new Set(projectPaths.split('\n').map(text=>text.trim()).filter(Boolean))];if(!folders.length)throw Error('Enter at least one project folder.');await save();await createWorkspace(folders,projectName.trim());}));
    host.append(manual);
  }
  async function open({review = false} = {}) {
    await ready; draft = {...preferences.defaults}; error();
    reviewing = review; step = review ? 0 : Math.min(preferences.onboarding?.step || 0, last); hideLaunch(); show('flow');
  }
  $('open-setup').addEventListener('click',()=>perform(()=>open()));
  $('open-setup-guide')?.addEventListener('click',()=>{$('settings')?.close();perform(()=>open({review:Boolean(preferences?.onboarding?.completedAt)}));});
  $('close-setup').addEventListener('click',()=>perform(dismiss));
  dialog.addEventListener('cancel',event=>{event.preventDefault();if(screen === 'flow')perform(dismiss);});
  // Enter continues, except where Enter already means something.
  dialog.addEventListener('keydown',event=>{
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || busy || screen !== 'flow') return;
    if (event.target?.closest?.('button, a, input, select, textarea, summary')) return;
    event.preventDefault(); $('setup-next').click();
  });
  $('setup-back').addEventListener('click',()=>perform(()=>step === 0 && !reviewing ? show('welcome') : move(Math.max(0,step-1))));
  $('setup-next').addEventListener('click',()=>perform(async()=>{if(step<last)return move(step+1);if(reviewing)return complete();await save();show('done');}));
  window.addEventListener('relay-state',()=>{if(dialog.open && screen === 'flow' && step===0 && !busy && connectionSignature!==connectionState())render();});
  window.addEventListener('relay-account',()=>{if(dialog.open && screen === 'flow' && step===0 && !busy)render();});
  const ready = api.api('/api/preferences',{},null).then(value=>{
    preferences = value; step = Math.min(value.onboarding?.step || 0, last); draft = {...value.defaults}; progress();
    if (value.firstRun) show('welcome');
    return value;
  }).catch(e=>{preferences={defaults:draft,onboarding:{step:0}};api.showNotice('Setup preferences could not be loaded. '+e.message);}).finally(()=>{hideLaunch();window.dispatchEvent(new CustomEvent('relay-setup-ready'));});
  window.relaySetup = {open,ready};
})();

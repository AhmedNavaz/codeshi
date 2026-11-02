(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ui = {
    workspaceList: $("workspace-list"), workspaceCount: $("workspace-count"), createWorkspace: $("create-workspace"), workspaceToggle: $("workspace-toggle"),
    title: $("conversation-title"), subtitle: $("conversation-subtitle"), state: $("conversation-state"),
    workspace: $("workspace-name"), breadcrumb: $("workspace-breadcrumb"),
    messages: $("messages"), scroll: $("messages-scroll"), empty: $("empty-state"),
    form: $("composer"), input: $("message-input"), send: $("send-button"), stop: $("stop-button"),
    agent: $("agent-select"), mode: $("mode-select"), approval: $("approval-select"), codex: $("select-codex"), claude: $("select-claude"), gemini: $("select-gemini"),
    continuation: $("continuation"), continueText: $("continuation-text"), continueButton: $("continue-button"),
    otherRunning: $("other-running"), viewRunning: $("view-running"),
    notice: $("notice"), noticeText: $("notice-text"), retry: $("notice-retry"), dismiss: $("notice-dismiss"),
    announcer: $("announcer"), hint: $("composer-hint"),
    projectSelect: $("project-select"), addProject: $("add-project"), projectPanel: $("project-panel"),
    projectForm: $("project-form"), projectName: $("project-name"), projectPaths: $("project-paths"),
    projectSave: $("save-project"), projectClose: $("close-project"), projectError: $("project-error"),
    projectEmpty: $("project-empty-state"), addFirstProject: $("add-first-project"), composerRegion: $("composer-region"),
    folderPanel: $("folder-panel"), folderForm: $("folder-form"), folderPath: $("folder-path"), folderSave: $("save-folder"), folderClose: $("close-folder"), folderError: $("folder-error"),
    removeDialog: $("remove-workspace-dialog"), removeName: $("remove-workspace-name"), removeConfirm: $("confirm-remove-workspace"), removeCancel: $("cancel-remove-workspace"), removeError: $("remove-workspace-error"),
  };
  const state = {
    localSelections: {}, accounts: {}, accountsChecking: {}, accountChecks: {}, accountCheck: 0, accountsCheckedAt: 0, accountRefresh: null, connectionAction: null, model: "", effort: null, workspaceFilter: "", streamConnected: null, retrySubmission: null, status: null, conversation: null, provider: "codex", mode: "edit", approvalPolicy: "ask",
    pending: null, loading: false, selectionVersion: 0, refreshPromise: null, refreshAgain: false,
    settingsRevision: 0, settingsPending: 0, settingsPromise: Promise.resolve(),
    noticeRetry: null, eventTimer: null, messagesSignature: "", listSignature: "", ready: false,
    projects: [], projectId: null, projectVersion: 0, projectsLoaded: false, projectSaving: false,
    projectListSignature: "", events: null, pollTimer: null,
    projectsRequestVersion: 0, projectsTimer: null, removingProjectId: null,
  };

  function storageKey(key) {
    const workspace = state.status?.workspace;
    const scope = state.projectId ? "project:" + state.projectId : typeof workspace === "string" ? workspace : workspace?.path || workspace?.name || "unconnected";
    return `ai-relay:${scope}:${key.replace(/^ai-relay:/, "")}`;
  }
  function storedRead(key) {
    try {
      const current = localStorage.getItem(storageKey(key));
      if (current !== null) return current;
      const workspace = state.status?.workspace;
      return typeof workspace === "string" ? localStorage.getItem(`ai-relay:${workspace}:${key.replace(/^ai-relay:/, "")}`) : null;
    } catch { return null; }
  }
  function storedWrite(key, value) {
    try { localStorage.setItem(storageKey(key), value); } catch { /* The app also works without browser storage. */ }
  }
  function activeProjectRead() { try { return localStorage.getItem("ai-relay:active-project"); } catch { return null; } }
  function activeProjectWrite(id) { try { localStorage.setItem("ai-relay:active-project", id); } catch { /* Browser storage is optional. */ } }
  function draftKey(id = state.conversation?.id) { return `ai-relay:draft:${id || "new"}`; }
  function saveDraft() { if (state.status && state.ready && !state.loading) storedWrite(draftKey(), ui.input.value); }
  function restoreDraft() { ui.input.value = storedRead(draftKey()) || ""; resizeInput(); }
  function label(provider) { return provider === "gemini" ? "Gemini" : provider === "claude" ? "Claude" : "Codex"; }
  function available(provider) { return Boolean(state.status?.providers?.[provider]?.available); }
  function isRunning() { return state.conversation?.status === "running" || Boolean(state.conversation?.id && state.status?.runningConversationId === state.conversation.id); }
  function isOtherRunning() { return Boolean(state.status?.runningConversationId && state.status.runningConversationId !== state.conversation?.id); }
  function endpoint(id, action = "") { return `/api/conversations/${encodeURIComponent(id)}${action ? `/${action}` : ""}`; }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function announce(text) { ui.announcer.textContent = text; }
  function closeWorkspaceMenu() {
    ui.workspaceToggle.setAttribute("aria-expanded", "false");
    ui.workspaceToggle.closest(".sidebar").classList.remove("workspaces-open");
  }
  function showNotice(message, retry = null, actionLabel = "Retry") {
    ui.noticeText.textContent = message;
    state.noticeRetry = retry;
    ui.retry.hidden = !retry;
    ui.retry.textContent = actionLabel;
    ui.notice.hidden = false;
  }
  function hideNotice() { ui.notice.hidden = true; state.noticeRetry = null; }
  function projectBusy() { return Boolean(state.pending || state.settingsPending || state.projectSaving); }
  function currentProject() { return state.projects.find((project) => project.id === state.projectId); }
  function sameProject(id, version) { return state.projectId === id && state.projectVersion === version; }
  function toggleProjectForm(open) {
    if (state.projectSaving) return;
    ui.projectPanel.hidden = !open;
    ui.addProject.setAttribute("aria-expanded", String(open));
    if (open) { closeWorkspaceMenu(); ui.folderPanel.hidden = true; ui.projectError.hidden = true; ui.projectPaths.focus(); }
    else ui.createWorkspace.focus();
  }
  async function api(path, options = {}, projectId = state.projectId) {
    const providerEndpoint = /^\/api\/providers(?:\/|$)/.test(path);
    if (/^\/api\/(?:status|conversation|conversations|collaboration|git|imports|files|attachments|reviews|local-models|commands|permissions|terminal|checkpoints)(?:\/|$|\?)/.test(path) || (providerEndpoint && projectId)) {
      if (!projectId) throw new Error("Choose a project first.");
      path += `${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`;
    }
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.method === "POST" ? { "X-AI-Relay": "1" } : {}), ...(window.relayDesktop?.token ? {"X-AI-Relay-Token":window.relayDesktop.token} : {}), ...options.headers },
      });
    } catch {
      throw new Error("Cannot reach Throughline. Make sure its local server is still running.");
    }
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) throw Object.assign(new Error(typeof data.error === "string" ? data.error : data.error?.message || data.message || `The request could not be completed (${response.status}).`), { status: response.status, ...(data.details ? { details: data.details } : {}) });
    return data;
  }
  function post(path, data = {}, projectId = state.projectId) { return api(path, { method: "POST", body: JSON.stringify(data) }, projectId); }

  function foldersFor(project) {
    if (Array.isArray(project?.folders)) return project.folders;
    return project?.path ? [{id:'primary',name:project.path.split(/[\\/]/).pop() || 'Project folder',path:project.path,available:project.available}] : [];
  }
  function renderProjects() {
    const signature = JSON.stringify([state.projects,state.projectId,state.projectsLoaded]);
    if (signature !== state.projectListSignature) {
      state.projectListSignature = signature;
      ui.projectSelect.replaceChildren();
      if (!state.projects.length) {
        const option = element('option','',state.projectsLoaded ? 'No workspaces added' : 'Loading workspaces…');
        option.value = ''; ui.projectSelect.append(option);
      }
      for (const project of state.projects) {
        const suffix = project.available === false ? ' · unavailable' : project.runningConversationId ? ' · running' : '';
        const option = element('option','',project.name + suffix); option.value = project.id; ui.projectSelect.append(option);
      }
      ui.projectSelect.value = state.projectId || '';
    }
    const busy = projectBusy();
    ui.projectSelect.disabled = !state.projects.length || busy;
    ui.addProject.disabled = busy; ui.createWorkspace.disabled = busy; ui.addFirstProject.disabled = busy;
    ui.projectSave.disabled = busy; ui.projectName.disabled = state.projectSaving; ui.projectPaths.disabled = state.projectSaving; ui.projectClose.disabled = state.projectSaving;
    ui.projectSave.firstChild.textContent = state.projectSaving ? 'Saving… ' : 'Create workspace ';
    ui.folderSave.disabled = busy || isRunning(); ui.folderPath.disabled = state.projectSaving; ui.folderClose.disabled = state.projectSaving;
    ui.folderSave.firstChild.textContent = state.projectSaving ? 'Saving… ' : 'Add folder ';
    ui.removeConfirm.disabled = busy; ui.removeCancel.disabled = state.projectSaving;
    ui.removeConfirm.textContent = state.projectSaving ? 'Removing…' : 'Remove workspace';
    ui.projectEmpty.hidden = !state.projectsLoaded || state.projects.length > 0; ui.composerRegion.hidden = !state.projectId;
  }

  function connection(provider) {
    const account=state.accounts[provider];
    const installed=state.status ? available(provider) : account?.installed === true;
    const checking=Boolean(state.accountsChecking[provider]);
    const needsSignIn=installed && account?.authenticated === false;
    const needsBilling=installed && !needsSignIn && Boolean(account) && account.billingSource !== 'subscription' && window.relayBillingConfirmed !== true;
    return {account,installed,checking,needsSignIn,needsBilling,blocked:!installed||needsSignIn||needsBilling};
  }
  async function refreshAccounts({force=false}={}) {
    // Routine checks share one probe and run at most once a minute; an explicit recheck always asks again.
    if(!force&&(state.accountRefresh||Date.now()-state.accountsCheckedAt<60000))return state.accountRefresh;
    const check=++state.accountCheck;
    const refresh=state.accountRefresh=Promise.all(['codex','claude','gemini'].map(async provider=>{
      if(state.status?.providers?.[provider]?.available===false){
        state.accounts[provider]={installed:false,authenticated:'unknown',billingSource:'unknown',usage:'unknown'};state.accountChecks[provider]={checkedAt:Date.now()};
        return;
      }
      // Progress replaces the status only for an explicit recheck or while nothing is known; a routine check keeps the last result on screen.
      if(force||!state.accounts[provider]){state.accountsChecking[provider]=check;renderStatus();renderControls();}
      let account=null,error=null;
      try {account=await api('/api/providers/'+provider+'/account',{},null);}
      catch(failure) {error=failure.message;/* A status-probe failure is advisory; native execution still validates its connection. */}
      if(state.accountsChecking[provider]===check)delete state.accountsChecking[provider];
      // A newer check owns the result. A timeout or failed check confirms nothing, so it keeps the last result and records why it may be out of date.
      if(check===state.accountCheck){
        if(!account||account.errorCategory==='timeout'||account.installed&&account.authenticated==='unknown'&&account.errorCategory)state.accountChecks[provider]={checkedAt:state.accountChecks[provider]?.checkedAt||null,failedAt:Date.now(),failure:account?.errorCategory==='timeout'?'timeout':'failed',error:error||account?.error||null};
        else {state.accounts[provider]=account;state.accountChecks[provider]={checkedAt:Date.now()};if(force)window.dispatchEvent(new CustomEvent('relay-account',{detail:{provider,account}}));}
      }
      renderStatus();renderControls();window.dispatchEvent(new CustomEvent('relay-state'));
    })).then(()=>{state.accountsCheckedAt=Date.now();});
    try {await refresh;} finally {if(state.accountRefresh===refresh)state.accountRefresh=null;render();}
  }
  const installGuides = {
    claude: "https://code.claude.com/docs/en/overview",
    codex: "https://github.com/openai/codex",
    gemini: "https://antigravity.google/docs/install",
  };
  const openExternal = (url) => window.relayDesktop ? window.relayDesktop.openExternal(url) : window.open(url, "_blank", "noopener,noreferrer");
  function renderStatus() {
    const workspace=state.status?.workspace || currentProject()?.path || '';
    ui.workspace.textContent=currentProject()?.name || 'No workspace selected';
    ui.workspace.title=workspace;ui.breadcrumb.textContent=workspace;
    for(const provider of ['codex','claude','gemini']) {
      const info=connection(provider);
      const text=info.checking?'Checking…':info.installed?(info.needsSignIn?'Sign in required':info.account?.authenticated===true?(info.account.billingSource==='api'?'API account':'Connected'):'Not verified'):state.status||info.account?'Not installed':'Not checked';
      $(`${provider}-status-text`).textContent=text;
      $(`${provider}-status-dot`).className='status-dot '+(info.installed&&!info.needsSignIn?'available':info.needsSignIn?'attention':'unavailable');
      const pill=$(`${provider}-status`);
      if(pill)pill.title=!info.installed&&(state.status||info.account)?`${label(provider)} is not installed — click for install instructions`:`${label(provider)} connection`;
    }
  }
  function renderConnectionNotice() {
    const notice=$('connection-notice'),install=$('connection-install');if(!notice)return;
    const info=connection(state.provider),other=['codex','claude','gemini'].find(provider=>provider!==state.provider&&available(provider)) || 'codex',name=label(state.provider);
    const fresh=!state.conversation?.messages?.length,none=!['codex','claude','gemini'].some(available);
    notice.hidden=true;state.connectionAction=null;state.installUrl=null;if(install)install.hidden=true;
    if(!state.ready||isRunning()||state.localSelections[state.projectId]||autoRouting()||(fresh&&none))return;
    let text='',action='';
    if(!info.installed){
      text=name+' is not installed.';
      state.installUrl=installGuides[state.provider]||null;
      if(install&&state.installUrl){install.hidden=false;install.textContent='How to install '+name+' ↗';}
      if(available(other)){action='Use '+label(other);state.connectionAction=()=>changeSettings(other,state.mode,state.approvalPolicy);}
      else {action='Open settings';state.connectionAction=()=>$('relay-settings').click();}
    } else if(info.needsSignIn){text=name+' is not signed in.';action='Connect account';state.connectionAction=()=>$('relay-settings').click();}
    else if(info.needsBilling){text=info.account.billingSource==='api'?'This connection uses API billing. Review it before sending.':'Billing could not be confirmed. Review this connection before sending.';action='Review connection';state.connectionAction=()=>$('relay-settings').click();}
    // Progress for a first check or an explicit recheck shows in the header and composer state, not as a notice.
    else if(!info.checking&&info.account?.authenticated!==true){text='Sign-in status has not been verified.';action='Check connection';state.connectionAction=()=>$('relay-settings').click();}
    if(text){notice.hidden=false;$('connection-notice-text').textContent=text;$('connection-action').textContent=action;$('connection-action').hidden=!action;}
  }

  function dateLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return "Today";
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  // Each workspace remembers which of its folders the Files view and Git panel show.
  function selectedFolderId(project = currentProject()) {
    const folders = foldersFor(project); if (!folders.length) return null;
    let id = state.selectedFolders?.[project.id];
    if (id === undefined) { try { id = localStorage.getItem('ai-relay:folder:' + project.id); } catch { id = null; } }
    return folders.some(folder => folder.id === id) ? id : folders[0].id;
  }
  function selectFolder(folderId, projectId = state.projectId) {
    const project = state.projects.find(item => item.id === projectId); if (!foldersFor(project).some(folder => folder.id === folderId)) return;
    state.selectedFolders = { ...state.selectedFolders, [projectId]: folderId };
    try { localStorage.setItem('ai-relay:folder:' + projectId, folderId); } catch { /* Folder choice is a convenience. */ }
    renderWorkspaceList(); window.dispatchEvent(new CustomEvent("relay-state"));
  }
  function filteredProjects() { return state.projects.filter(project => project.name.toLowerCase().includes(state.workspaceFilter.toLowerCase())); }
  function renderWorkspaceList() {
    const signature = JSON.stringify([state.projects,state.projectId,projectBusy(),state.loading,state.status?.runningConversationId,state.workspaceFilter,selectedFolderId(),state.conversation?.pendingApprovals?.length]);
    if (signature === state.listSignature) return;
    renderFolderSettings();
    state.listSignature = signature; ui.workspaceList.replaceChildren(); ui.workspaceCount.textContent = String(state.projects.length);
    if (!state.projects.length) { ui.workspaceList.append(element('p','empty-list','No workspaces')); return; }
    for (const project of filteredProjects()) {
      const active = project.id === state.projectId;
      const group = element('div','workspace-group' + (active ? ' active' : ''));
      const button = element('button','workspace-item' + (active ? ' active' : ''));
      button.type = 'button'; button.disabled = projectBusy(); button.dataset.projectId = project.id; button.title = project.name;
      if (active) button.setAttribute('aria-current','page');
      const heading = element('span','workspace-item-heading'), mark = element('span','workspace-project-icon',''); mark.setAttribute('aria-hidden','true'); heading.append(mark,element('span','workspace-item-title',project.name));
      // Pending approvals stay visible here while another workspace is open (#46).
      const waiting = active ? state.conversation?.pendingApprovals?.length || 0 : project.pendingApprovals || 0;
      const folders = foldersFor(project); const meta = folders.length + (folders.length === 1 ? ' folder' : ' folders') + (waiting ? ` · ${waiting} waiting for approval` : project.runningConversationId ? ' · running' : '');
      // Single-folder counts are noise; the text stays for screen readers and a running workspace shows a pulse.
      const metaNode = element('span','workspace-item-meta' + (folders.length === 1 ? ' single' : '') + (project.runningConversationId ? ' running' : ''),meta);
      button.append(heading,metaNode);
      if (waiting) { const badge = element('span','workspace-approval-badge',String(waiting)); badge.title = `${waiting} approval${waiting === 1 ? '' : 's'} waiting`; badge.setAttribute('aria-hidden','true'); heading.append(badge); }
      button.addEventListener('click',()=>selectProject(project.id)); const row = element('div','workspace-row');
      const options = element('button','workspace-options'); options.type = 'button'; options.disabled = projectBusy(); options.dataset.projectId = project.id;
      options.setAttribute('aria-label','Workspace options for ' + project.name); options.title = 'Workspace settings'; options.addEventListener('click',()=>openWorkspaceOptions(project.id));
      row.append(button,options); group.append(row);
      // A multi-folder workspace lists its folders; the selected one drives the Files view and Git panel.
      if (active && folders.length > 1) {
        const list = element('ul','workspace-folders'), current = selectedFolderId(project);
        for (const folder of folders) {
          const repeated = folders.filter(entry=>(entry.displayName||entry.name)===(folder.displayName||folder.name)).length>1;
          const item = element('li','workspace-folder' + (folder.id === current ? ' selected' : '') + (folder.available === false ? ' unavailable' : ''));
          const pick = element('button','workspace-folder-pick'); pick.type = 'button'; pick.title = folder.path + (folder.available === false ? ' · folder not found' : ''); pick.setAttribute('aria-pressed',String(folder.id === current));
          const icon = element('span','workspace-folder-icon'); icon.setAttribute('aria-hidden','true');
          pick.append(icon,element('span','workspace-folder-name',repeated?folder.name:folder.displayName||folder.name)); pick.addEventListener('click',()=>selectFolder(folder.id,project.id));
          item.append(pick); list.append(item);
        }
        group.append(list);
      }
      ui.workspaceList.append(group);
    }
  }

  function messageTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  // Assistant replies use a small Markdown subset, built as DOM nodes so provider text is never parsed as HTML.
  function renderInline(parent, text) {
    let last = 0;
    for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)) {
      if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
      parent.append(match[1] !== undefined ? element("code", "", match[1]) : element("strong", "", match[2]));
      last = match.index + match[0].length;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }
  // Lightweight syntax coloring for code blocks and file previews. Tokens become text nodes and spans, never HTML.
  const syntaxFamilies = {
    c: { comment: /\/\/[^\n]*|\/\*[\s\S]*?\*\//, string: /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/, keywords: 'abstract as async await break case catch class const continue debugger default defer delete do else enum export extends false final finally fn for from func function if impl implements import in instanceof interface let mut new nil null of package private protected pub public readonly return self static struct super switch this throw throws trait true try type typeof undefined var void while with yield' },
    hash: { comment: /#[^\n]*/, string: /"""[\s\S]*?"""|'''[\s\S]*?'''|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/, keywords: 'and as assert async await break case class def del do done elif else end esac except export false False fi finally for from function global if import in is lambda local None nonlocal not or pass raise return self then true True try until while with yield' },
    json: { string: /"(?:\\.|[^"\\\n])*"/, keywords: 'true false null' },
    css: { comment: /\/\*[\s\S]*?\*\//, string: /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/, keywords: 'important' },
    markup: { comment: /<!--[\s\S]*?-->/, string: /'[^'\n]*'|"[^"\n]*"/, tag: /<\/?[A-Za-z][\w:-]*|\/?>/ },
    sql: { comment: /--[^\n]*|\/\*[\s\S]*?\*\//, string: /'(?:''|[^'])*'/, keywords: 'select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as distinct null is in exists case when then else end primary key references unique default returning with union all' },
  };
  const syntaxLanguages = { js: 'c', jsx: 'c', ts: 'c', tsx: 'c', mjs: 'c', cjs: 'c', javascript: 'c', typescript: 'c', jsonc: 'c', java: 'c', c: 'c', h: 'c', cpp: 'c', cs: 'c', go: 'c', rs: 'c', rust: 'c', swift: 'c', kt: 'c', dart: 'c', php: 'c', css: 'css', scss: 'css', less: 'css', json: 'json', py: 'hash', python: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', shell: 'hash', yaml: 'hash', yml: 'hash', toml: 'hash', rb: 'hash', ruby: 'hash', dockerfile: 'hash', makefile: 'hash', html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', sql: 'sql' };
  const syntaxPatterns = {};
  function syntaxPattern(family) {
    if (syntaxPatterns[family]) return syntaxPatterns[family];
    const spec = syntaxFamilies[family], parts = [];
    for (const kind of ['comment', 'string', 'tag']) if (spec[kind]) parts.push(`(?<${kind}>${spec[kind].source})`);
    parts.push(String.raw`(?<number>\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b)`, String.raw`(?<word>[A-Za-z_$][\w$]*)`);
    return syntaxPatterns[family] = { pattern: new RegExp(parts.join('|'), 'g'), keywords: new Set((spec.keywords || '').split(' ')), caseless: family === 'sql' };
  }
  // Splits code into lines of [kind, text] tokens; kind is '' for plain text.
  function highlightLines(text, language) {
    // Own keys only, so a label such as "constructor" is not read from Object.prototype.
    const key = String(language || '').toLowerCase(), family = Object.hasOwn(syntaxLanguages, key) ? syntaxLanguages[key] : null, lines = [[]];
    const push = (kind, value) => value.split('\n').forEach((part, index) => { if (index) lines.push([]); if (part) lines.at(-1).push([kind, part]); });
    if (!family) { push('', text); return lines; }
    const { pattern, keywords, caseless } = syntaxPattern(family); let last = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[0], end = match.index + value.length, next = text.slice(end, end + 16), groups = match.groups;
      if (match.index > last) push('', text.slice(last, match.index));
      push(groups.comment ? 'comment' : groups.string ? (family === 'json' && /^\s*:/.test(next) ? 'property' : 'string') : groups.tag ? 'tag' : groups.number ? 'number' : keywords.has(caseless ? value.toLowerCase() : value) ? 'keyword' : /^\s*\(/.test(next) ? 'function' : '', value);
      last = end;
    }
    if (last < text.length) push('', text.slice(last));
    return lines;
  }
  function highlightedCode(text, language) {
    const code = element('code');
    highlightLines(text, language).forEach((line, index) => { if (index) code.append(document.createTextNode('\n')); for (const [kind, value] of line) code.append(kind ? element('span', 'tok-' + kind, value) : document.createTextNode(value)); });
    return code;
  }
  async function copyText(button, text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      // Fallback for renderers that deny the async clipboard permission.
      const buffer = element("textarea", "clipboard-buffer"); buffer.value = text; document.body.append(buffer); buffer.select();
      const copied = document.execCommand("copy"); buffer.remove(); if (!copied) { announce("Copy failed."); return; }
    }
    button.classList.add("copied"); announce("Copied to clipboard.");
    setTimeout(() => button.classList.remove("copied"), 1500);
  }
  function copyButton(className, label, text) {
    const button = element("button", className); button.type = "button"; button.title = label; button.setAttribute("aria-label", label);
    button.addEventListener("click", () => copyText(button, text));
    return button;
  }
  function tableCells(row) { return row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()); }
  function renderProse(parent, text) {
    const lines = text.split("\n"), tableRow = /^\s*\|.*\|\s*$/, tableRule = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
    let block = null, list = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) { block = list = null; continue; }
      if (tableRow.test(line) && tableRule.test(lines[index + 1] || "")) {
        block = list = null;
        const wrap = element("div", "md-table"), table = element("table"), head = element("thead"), body = element("tbody"), headRow = element("tr");
        for (const cell of tableCells(line)) { const th = element("th"); renderInline(th, cell); headRow.append(th); }
        head.append(headRow); index++;
        while (tableRow.test(lines[index + 1] || "")) { const row = element("tr"); for (const cell of tableCells(lines[++index])) { const td = element("td"); renderInline(td, cell); row.append(td); } body.append(row); }
        table.append(head, body); wrap.append(table); parent.append(wrap); continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { block = list = null; parent.append(element("hr")); continue; }
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) { block = list = null; const node = element(`h${Math.min(heading[1].length + 2, 6)}`); renderInline(node, heading[2]); parent.append(node); continue; }
      const item = line.match(/^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/);
      if (item) {
        block = null;
        const tag = item[2] === undefined ? "ul" : "ol";
        if (!list || list.tagName !== tag.toUpperCase()) { list = element(tag); if (item[2] && item[2] !== "1") list.setAttribute("start", item[2]); parent.append(list); }
        const entry = element("li", item[1].length >= 2 ? "nested" : ""); renderInline(entry, item[3]); list.append(entry); continue;
      }
      const quote = line.match(/^\s*>\s?(.*)$/);
      list = null;
      if (quote && block?.tagName !== "BLOCKQUOTE") { block = element("blockquote"); parent.append(block); }
      else if (block) block.append(document.createTextNode("\n"));
      else { block = element("p"); parent.append(block); }
      renderInline(block, quote ? quote[1] : line);
    }
  }
  // A path as the person knows it: relative to its workspace folder, with the folder named when there are several.
  function displayPath(value) {
    const text = String(value || ""), folders = currentProject()?.folders || [];
    for (const folder of folders) {
      if (folder.path && text === folder.path) return folders.length > 1 ? folder.name : "";
      if (folder.path && text.startsWith(folder.path + "/")) return (folders.length > 1 ? folder.name + "/" : "") + text.slice(folder.path.length + 1);
    }
    return text;
  }
  // One step of a run, shown as a timeline row: a short verb, what it acted on, and the full text behind a chevron.
  function parseActivity(raw) {
    const text = String(raw || "").trim(), first = text.split("\n")[0];
    if (text.startsWith("$ ")) {
      const newline = text.indexOf("\n"), cmd = (newline === -1 ? text.slice(2) : text.slice(2, newline)).trim();
      return { kind: "command", icon: "command", verb: "Run", detail: cmd, mono: true, cmd, output: text, raw: text };
    }
    // A check with the workspace's tests after a routed run (#12): running, then how it ended, with its output.
    const check = text.match(/^Tests (running|passed|failed|timed out|stopped|skipped|interrupted): ([^\n]*)(?:\n([\s\S]*))?$/);
    if (check) {
      const [, outcome, command, rest = ""] = check, failed = ["failed", "timed out"].includes(outcome);
      const verb = { running: "Running the tests", passed: "Tests passed", failed: "Tests failed", "timed out": "Tests didn’t finish", stopped: "Tests stopped", skipped: "Tests skipped", interrupted: "Tests interrupted" }[outcome];
      return { kind: "check", icon: outcome === "running" ? "tests-running" : outcome === "passed" ? "tests-passed" : failed ? "tests-failed" : "general", verb, detail: command, mono: true, output: rest.trim(), error: failed, raw: text };
    }
    if (text.startsWith("File changes:")) {
      let files = [];
      try { files = JSON.parse(text.slice("File changes:".length)); } catch {}
      const paths = files.map(file => file.path || file.file || "").filter(Boolean);
      const created = files.length > 0 && files.every(file => file.kind === "add");
      return { kind: "file", icon: "edit", verb: created ? "Create" : "Edit", detail: paths.map(displayPath).join(", ") || "files", files, paths, output: paths.length > 1 ? paths.map(displayPath).join("\n") : "", raw: text };
    }
    // A Claude tool: its name, its input as one line of JSON, then its result once it arrives.
    const tool = text.match(/^([A-Za-z_][\w-]*)\n(\{.*\})(?:\n([\s\S]*))?$/);
    if (tool) {
      const name = tool[1], result = (tool[3] || "").trim();
      let input = {};
      try { input = JSON.parse(tool[2]); } catch {}
      const file = displayPath(input.file_path || input.notebook_path || input.path || "");
      const step = (icon, verb, detail, output = result, mono = false) => ({ kind: "tool", icon, verb, detail, mono, output, toolName: name, input, raw: text });
      if (["Read", "read_file"].includes(name)) return step("read", "Read", file);
      if (["Edit", "MultiEdit", "edit_file", "NotebookEdit"].includes(name)) {
        const edits = Array.isArray(input.edits) ? input.edits : [input];
        const diff = edits.filter(edit => typeof edit.old_string === "string" || typeof edit.new_string === "string").map(edit => [...String(edit.old_string || "").split("\n").filter(Boolean).map(line => "- " + line), ...String(edit.new_string || "").split("\n").filter(Boolean).map(line => "+ " + line)].join("\n")).join("\n\n");
        return step("edit", "Edit", file, diff || result);
      }
      if (["Write", "write_file"].includes(name)) return step("edit", "Write", file, typeof input.content === "string" ? input.content : result);
      if (name === "Glob") return step("search", "Find", input.pattern || "", result, true);
      if (["Grep", "search_files"].includes(name)) return step("search", "Search", [input.pattern, input.path && displayPath(input.path) ? "in " + displayPath(input.path) : ""].filter(Boolean).join(" "), result, true);
      if (name === "Bash") return { ...step("command", "Run", input.description || input.command || "", [input.command ? "$ " + input.command : "", result].filter(Boolean).join("\n"), !input.description), cmd: input.command || "" };
      if (name === "WebFetch") return step("web", "Fetch", input.url || "");
      if (name === "WebSearch" || name === "search_web") return step("web", "Search the web", input.query || "");
      if (["Task", "Agent"].includes(name)) return step("agent", "Agent", input.description || "");
      if (name === "TodoWrite") return { kind: "tool", skip: true, raw: text };
      const summary = Object.values(input).find(value => typeof value === "string" && value.trim()) || "";
      return step("tool", name, summary.split("\n")[0].slice(0, 200), result || (Object.keys(input).length ? JSON.stringify(input, null, 2) : ""));
    }
    const remote = text.match(/^(mcp_tool_call|web_search): ?(.*)(?:\n([\s\S]*))?$/);
    if (remote) return { kind: "tool", icon: remote[1] === "web_search" ? "web" : "tool", verb: remote[1] === "web_search" ? "Search the web" : "Tool", detail: remote[2], output: (remote[3] || "").replace(/^""$/, "").trim(), raw: text };
    // Full auto-approval allows every request, so its notes add nothing to the timeline.
    if (/^Tool .* auto-approved by policy\.?$/.test(text)) return { kind: "approval", skip: true, raw: text };
    // Remembered approvals say which rule allowed the action.
    const rule = text.match(/^Allowed (by your rule for this workspace|by your rule for this run|for this run|and remembered for this workspace): ([\s\S]*)$/);
    if (rule) return { kind: "approval", icon: "approval", verb: rule[1].startsWith("by your rule") ? "Allowed by your rule" : rule[1] === "for this run" ? "Allowed for this run" : "Allowed and remembered", detail: rule[2].split("\n")[0], mono: true, output: "", raw: text };
    if (/^Approval allowed/.test(text)) return { kind: "approval", icon: "approval", verb: "You allowed the request", detail: "", output: "", raw: text };
    if (/^Approval denied/.test(text)) return { kind: "approval", icon: "denied", verb: "You denied the request", detail: "", output: "", error: true, raw: text };
    if (/diagnostic/i.test(first)) return { kind: "error", icon: "error", verb: "Error", detail: first.replace(/^\w+ diagnostic:\s*/i, "").slice(0, 200), output: text, error: true, raw: text };
    return { kind: "general", icon: "general", verb: first.slice(0, 200), detail: "", output: text.includes("\n") ? text : "", raw: text };
  }

  // A timeline row: its node on the run's line, the step's first line, and its full text behind the chevron.
  function renderStep(step, entryId, openOutputs) {
    const open = openOutputs.has(entryId), more = Boolean(step.output);
    const entry = element("div", `activity-entry activity-entry-${step.kind}${step.error ? " activity-entry-error" : ""}${open ? " open" : ""}`);
    entry.setAttribute("data-entry-id", entryId);
    entry.dataset.entryId = entryId;
    const node = element("span", "timeline-node");
    node.setAttribute("aria-hidden", "true");
    node.append(element("span", `activity-icon icon-${step.icon || step.kind}`));
    const head = element("div", "activity-entry-header");
    // A step with more to show is a button; one that is only its line stays text, which keeps it searchable.
    const toggle = element(more ? "button" : "div", "activity-output-toggle");
    toggle.append(element("span", "activity-entry-title", step.verb));
    if (step.detail) toggle.append(element(step.mono ? "code" : "span", "activity-entry-detail", step.detail));
    if (more) toggle.append(element("span", "disclosure-chevron"));
    head.append(toggle, copyButton("activity-copy", "Copy", step.output || step.raw));
    entry.append(node, head);
    if (!more) return entry;
    const output = element("pre", "activity-output", step.output), outputId = "activity-output-" + entryId;
    output.id = outputId;
    output.setAttribute("data-entry-id", entryId);
    output.dataset.entryId = entryId;
    output.hidden = !open;
    toggle.type = "button";
    toggle.title = open ? "Hide details" : "Show details";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-controls", outputId);
    toggle.addEventListener("click", () => {
      const opening = output.hidden;
      output.hidden = !opening;
      entry.classList.toggle("open", opening);
      toggle.title = opening ? "Hide details" : "Show details";
      toggle.setAttribute("aria-expanded", String(opening));
    });
    entry.append(output);
    return entry;
  }

  function renderMessage(message) {
    if (message.role === "error") {
      const error = element("div", "message-error");
      error.append(element("span", "message-error-text", message.text || "The assistant stopped before finishing."));
      error.setAttribute("role", "note");
      if (message.id) error.id = "message-" + message.id;
      return error;
    }
    if (message.role === "system") {
      const sys = element("div", "message-system", message.text || "");
      if (message.id) sys.id = "message-" + message.id;
      return sys;
    }
    const user = message.role === "user";
    const provider = message.provider || state.conversation?.provider || "codex";
    const streaming = !user && (message.status === "streaming" || message.status === "running");
    const row = element("article", `message ${user ? "message-user" : "message-assistant"}${user && message.steer ? " message-steer" : ""}${streaming ? " message-streaming" : ""}`);
    if (message.id) {
      row.id = "message-" + message.id;
      row.dataset.messageId = message.id;
    }
    if (message.runId) row.dataset.runId = message.runId;
    row.setAttribute("aria-label", user ? (message.steer ? "Your note, added while the agent worked" : "Your message") : `${label(provider)} response`);
    // A reply opens with one line naming the agent. Time and copy sit in a row beneath every message and appear on hover.
    const heading = element("div", "message-heading");
    if (!user) {
      const avatar = element("span", `message-avatar ${message.connection === 'local' ? 'local' : provider}`);
      avatar.setAttribute("aria-hidden", "true");
      heading.append(avatar, element("span", "message-author", message.connection === 'local' ? 'Local · Ollama' : label(provider)));
      const details = [message.model && message.model !== "unknown" ? message.model : "", message.effort ? message.effort + " effort" : ""].filter(Boolean).join(" · ");
      if (details) heading.append(element("span", "message-model", details));
      if (message.imported) heading.append(element("span", "message-label", "Imported"));
    }
    const actions = element("div", "message-actions");
    const time = element("time", "message-time", messageTime(message.createdAt));
    if (message.createdAt) time.dateTime = message.createdAt;
    actions.append(time);
    if (user && message.steer) heading.append(element("span", "message-steer-label", "Added while working"));
    if (user && message.runId && !message.steer) {
      const jumpRun = element("button", "message-action message-jump-run", "Activity");
      jumpRun.type = "button";
      jumpRun.title = "Jump to this run's activity";
      jumpRun.addEventListener("click", () => {
        const node = ui.messages.querySelector(`div[data-run-id="${message.runId}"]`);
        if (!node) return;
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("activity-highlight");
        setTimeout(() => node.classList.remove("activity-highlight"), 2000);
      });
      actions.append(jumpRun);
    }
    if (message.text) actions.append(copyButton("message-copy", "Copy message", message.text));
    const body=element('div',user?'message-text':'message-text markdown');
    if (!user && message.reviewId) {
      const review = state.conversation?.reviews?.find(item => item.id === message.reviewId);
      body.append(element('p', '', review?.summary || (streaming ? 'Read-only review in progress…' : 'Read-only review response.')));
      if (review) { const view = element('button', 'secondary-button', 'View review'); view.type = 'button'; view.addEventListener('click', () => window.relayReviews?.open(message.reviewId)); body.append(view); }
      const raw = element('details', 'review-raw'); raw.append(element('summary', '', 'Agent response'), element('pre', '', message.text || 'Waiting for the reviewer…')); body.append(raw);
      row.append(heading, body, actions); return row;
    }
    const text=message.text || (streaming ? '' : 'No text response.');
    const parts=text.split(/```([^\n`]*)\n([\s\S]*?)```/g);
    for(let i=0;i<parts.length;i+=3){if(parts[i]){if(user)body.append(document.createTextNode(parts[i]));else renderProse(body,parts[i]);}if(parts[i+2]!==undefined){const block=element('div','code-block'),head=element('div','code-head'),pre=element('pre');head.append(element('span','code-language',parts[i+1].trim()||'code'),copyButton('code-copy','Copy code',parts[i+2]));pre.append(highlightedCode(parts[i+2],parts[i+1].trim()));block.append(head,pre);body.append(block);}}
    if (!user || message.steer) row.append(heading);
    row.append(body);
    // A prompt stays at the top of its turn while the results scroll past (see .message-prompt). A long one shows its
    // first lines until opened, so it never fills the view; an opened one scrolls normally.
    if (user && message.retry) { row.classList.add("message-retry"); row.insertBefore(element("div", "message-retry-label", "Sent by Throughline after the tests failed"), body); }
    if (user && !message.steer) {
      row.classList.add("message-prompt");
      const text = message.text || "";
      if (message.retry || text.split("\n").length > 6 || text.length > 520) {
        const expanded = state.expandedPrompts?.has(message.id);
        row.classList.add("long"); row.classList.toggle("expanded", Boolean(expanded));
        const more = element("button", "prompt-more", expanded ? "Show less" : "Show more"); more.type = "button";
        more.setAttribute("aria-expanded", String(Boolean(expanded)));
        more.addEventListener("click", () => {
          state.expandedPrompts ||= new Set();
          if (state.expandedPrompts.has(message.id)) state.expandedPrompts.delete(message.id); else state.expandedPrompts.add(message.id);
          const open = state.expandedPrompts.has(message.id);
          row.classList.toggle("expanded", open); more.textContent = open ? "Show less" : "Show more"; more.setAttribute("aria-expanded", String(open));
        });
        row.append(more);
      }
    }
    window.relayFiles?.renderMessageAttachments(row, message.attachments);
    if (user && message.routing) {
      const choice = message.routing, model = choice.model ? window.relayModelPicker?.modelName?.(message.provider, choice.model) || choice.model : "default model";
      const note = element("div", "message-routing", `Auto · ${[label(message.provider), model, choice.effort ? `${choice.effort} effort` : ""].filter(Boolean).join(" · ")}`);
      note.title = `${window.relayRouting?.modeNames?.[choice.mode] || "Auto"}: ${choice.reason || ""}`;
      row.append(note);
    }
    row.append(actions);
    return row;
  }
  function updateJump() { $("jump-latest").hidden = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 240; }
  function renderMessages(forceScroll = false) {
    const messages = state.conversation?.messages || [];
    const signature = JSON.stringify([state.projectId, state.conversation?.id, messages, state.conversation?.reviews?.map(({ id, status, summary }) => [id, status, summary]), state.conversation?.status, state.conversation?.activeRun?.id, state.conversation?.lastRun?.id, state.projects.find(project => project.id === state.projectId)?.folders?.map(folder => folder.path), state.conversation?.pendingApprovals?.map(({ id, runId }) => [id, runId]), state.conversation?.checkpoints]);
    const noProvider=state.ready&&!messages.length&&!['codex','claude','gemini'].some(available);
    ui.empty.hidden = messages.length > 0 || !state.ready || noProvider;
    if($('provider-empty-state'))$('provider-empty-state').hidden=!noProvider;
    if (signature === state.messagesSignature) return;
    state.messagesSignature = signature;
    const nearBottom = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 110;
    const oldTop = ui.scroll.scrollTop;
    const openOutputs = new Set([...ui.messages.querySelectorAll(".activity-output")].filter(node => !node.hidden).map(node => node.getAttribute("data-entry-id") || node.dataset?.entryId));
    const openEarlier = new Set([...ui.messages.querySelectorAll("details")].filter(node => node.open && node.classList.contains("activity-earlier")).map(node => node.getAttribute("data-group") || node.dataset?.group));
    const fragment = document.createDocumentFragment();
    const c = state.conversation, liveRun = c?.status === "running" ? c.activeRun : null, shownRun = liveRun || c?.lastRun;
    // Each prompt starts a turn holding everything that answers it, so the prompt can stay at the top while its results scroll.
    // Inside a turn, each run is one thread under the agent's name: its replies and steps sit on one line, in order.
    let turn = null, thread = null;
    const threads = [];
    const place = node => (turn || fragment).append(node);
    const openThread = (key, provider, connection, source, forRun = null) => {
      const node = element("div", "run-thread"), body = element("div", "run-thread-body");
      if (key) { node.setAttribute("data-run-id", key); node.dataset.runId = key; }
      const run = forRun || (key && shownRun?.id === key ? shownRun : null);
      const heading = element("div", "message-heading run-thread-heading");
      const avatar = element("span", `message-avatar ${connection === "local" ? "local" : provider}`);
      avatar.setAttribute("aria-hidden", "true");
      heading.append(avatar, element("span", "message-author", connection === "local" ? "Local · Ollama" : label(provider)));
      const model = source?.model && source.model !== "unknown" ? source.model : run?.effectiveModel && run.effectiveModel !== "unknown" ? run.effectiveModel : run?.model || "";
      const effort = source?.effort || run?.effectiveEffort || run?.effort || "";
      const details = [model, effort ? effort + " effort" : ""].filter(Boolean).join(" · ");
      if (details) heading.append(element("span", "message-model", details));
      if (source?.imported) heading.append(element("span", "message-label", "Imported"));
      node.append(heading, body);
      thread = { key, provider, connection, node, body, turn };
      threads.push(thread);
      place(node);
      return thread;
    };
    // The thread for a message of this run, continuing the open one when it is the same run and agent.
    const threadFor = (message, index) => {
      const key = message.runId || "", provider = message.provider || c?.provider || "codex";
      if (thread && thread.turn === turn && thread.key === key && (key || thread.provider === provider)) return thread;
      const source = messages.slice(index).find(item => item.role === "assistant" && (item.runId || "") === key && (key || item === message));
      return openThread(key, source?.provider || provider, source?.connection || message.connection, source);
    };
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role === "user" && !message.steer) {
        turn = element("section", "turn"); fragment.append(turn); thread = null;
        turn.append(renderMessage(message));
        continue;
      }
      if (message.role !== "activity") {
        const row = renderMessage(message);
        // Replies, errors and notes added while the agent worked belong to their run's thread.
        const inRun = message.role === "assistant" || (message.runId && (message.role === "error" || message.steer || thread?.key === message.runId));
        if (inRun) threadFor(message, index).body.append(row); else { thread = null; place(row); }
        continue;
      }
      const activities = [message];
      while (messages[index + 1]?.role === "activity" && (messages[index + 1].runId || "") === (message.runId || "")) activities.push(messages[++index]);
      const steps = activities.map(act => ({ ...parseActivity(act.text), message: act })).filter(step => !step.skip);
      if (!steps.length) continue;
      const host = threadFor(message, index).body;
      const groupKey = String(message.id || `${message.runId || "run"}-${index}`);
      // Every step shows; only a very long stretch keeps its earlier steps behind one row.
      if (steps.length > 12) {
        const earlier = steps.slice(0, -6), disclosure = element("details", "activity-earlier");
        disclosure.setAttribute("data-group", `${groupKey}-earlier`);
        disclosure.dataset.group = `${groupKey}-earlier`;
        disclosure.open = openEarlier.has(`${groupKey}-earlier`);
        const summary = element("summary", "activity-earlier-toggle");
        const node = element("span", "timeline-node"); node.setAttribute("aria-hidden", "true"); node.append(element("span", "activity-icon icon-more"));
        summary.append(node, element("span", "", `${earlier.length} earlier steps`));
        disclosure.append(summary, ...earlier.map((step, idx) => renderStep(step, step.message.id || `${groupKey}-${idx}`, openOutputs)));
        host.append(disclosure);
        steps.slice(-6).forEach((step, idx) => host.append(renderStep(step, step.message.id || `${groupKey}-${idx + earlier.length}`, openOutputs)));
      } else steps.forEach((step, idx) => host.append(renderStep(step, step.message.id || `${groupKey}-${idx}`, openOutputs)));
    }
    // The run's status line is the last step of its thread, so the live run has one indicator, where its work is.
    if (shownRun) {
      let host = threads.findLast(item => item.turn === turn && shownRun.id && item.key === shownRun.id);
      if (!host && liveRun) host = thread && thread.turn === turn && !shownRun.id ? thread : openThread(shownRun.id || "", shownRun.provider || c?.provider || "codex", shownRun.connection, null, shownRun);
      if (host) host.body.append($("run-progress")); else $("transcript-footer").prepend($("run-progress"));
    } else $("transcript-footer").prepend($("run-progress"));
    // A run that changed files ends with its checkpoint line, after its status line (#20).
    for (const item of new Map(threads.filter(entry => entry.key).map(entry => [entry.key, entry])).values()) { const line = window.relayRewind?.row(item.key); if (line) item.body.append(line); }
    place($("transcript-footer"));
    ui.messages.replaceChildren(fragment);
    if (forceScroll || nearBottom) requestAnimationFrame(() => { ui.scroll.scrollTop = ui.scroll.scrollHeight; updateJump(); });
    else { ui.scroll.scrollTop = oldTop; updateJump(); }
  }

  // Agents a wait can continue with: the one that stopped and the one selected first, then any other connected agent.
  function resumeProviders() {
    const connected = ["codex", "claude", "gemini"].filter(provider => available(provider) && !connection(provider).blocked);
    return [...new Set([state.conversation?.lastRun?.provider, state.provider, ...connected])].filter(provider => connected.includes(provider));
  }
  function resumeText(resume) {
    const time = iso => { const date = new Date(iso), today = date.toDateString() === new Date().toDateString(); return date.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" }); };
    const agents = resume.providers.map(provider => {
      const status = resume.agents?.[provider];
      return label(provider) + (status?.limited === false ? " (ready)" : status?.resetsAt ? ` (resets ${time(status.resetsAt)})` : status ? " (checking every 10 min)" : "");
    });
    const list = agents.length > 1 ? `${agents.slice(0, -1).join(", ")} or ${agents.at(-1)}` : agents[0];
    const access = `${resume.mode === "read" ? "Read only" : "Can edit files"} · ${resume.approvalPolicy === "auto" ? "full auto-approval" : "asks before changes"}`;
    return `Waiting for a usage limit to reset. Continues with ${list}, whichever has room first. ${access}.`;
  }
  // Queued prompts run one after another with the settings shown on each; the list can be reordered, edited and paused.
  async function queueAction(body) {
    const id = state.conversation?.id, projectId = state.projectId;
    if (!id) return false;
    try { await post(endpoint(id, "queue"), body, projectId); await refresh(); return true; }
    catch (error) { showNotice(error.message); return false; }
  }
  async function queuePrompt() {
    const text = ui.input.value.trim(), attachments = window.relayFiles?.ids() || [], projectId = state.projectId, draft = ui.input.value;
    if (!text || state.pending || !state.conversation || $("queue-button").hidden) return;
    if (state.localSelections[projectId]) { showNotice("Queue a cloud agent. Local models start from Continue locally."); return; }
    const routed = routeFor(text, attachments.length);
    if (routed?.error) { showNotice(routed.error); return; }
    state.pending = "queue"; renderControls();
    const added = await queueAction({ action: "add", text, provider: routed?.provider || state.provider, model: (routed ? routed.model : state.model) || null, effort: (routed ? routed.effort : state.effort) || null, mode: state.mode, approvalPolicy: state.approvalPolicy || "ask", attachments, billingConfirmed: window.relayBillingConfirmed === true, ...(routed ? { routing: { mode: routed.mode, reason: routed.reason, tier: routed.tier, escalation: routed.escalation || null } } : {}) });
    if (added) {
      window.relayFiles?.accepted(projectId, attachments);
      if (ui.input.value === draft) { ui.input.value = ""; storedWrite(draftKey(), ""); storedWrite(draftKey(null), ""); resizeInput(); }
      announce("Added to the queue.");
    }
    state.pending = null; renderControls();
  }
  // Auto (#12): Throughline picks the agent, model and effort for each message, shown before it is sent.
  const autoRouting = () => !state.localSelections[state.projectId] && state.conversation?.routing ? state.conversation.routing : null;
  function routeFor(text, attachments = 0) {
    const routing = autoRouting(); if (!routing || !window.relayRouting) return null;
    const project = state.projects.find(item => item.id === state.projectId);
    const candidates = ["codex", "claude", "gemini"].map(provider => {
      const info = connection(provider);
      // Antigravity has no read-only access and works with one folder, as starting a run checks.
      const unsupported = provider === "gemini" && (state.mode === "read" || foldersFor(project).length > 1);
      return { provider, eligible: !info.blocked && info.account?.authenticated !== false && !unsupported, billingSource: info.account?.billingSource || "unknown", usedPercent: window.relayUsage?.usedPercent?.(provider) ?? null, models: window.relayModelPicker?.models?.(provider) || [] };
    });
    return window.relayRouting.route({ text, attachments, mode: routing.mode, allowApi: routing.allowApi === true, candidates, current: state.conversation?.lastRun?.provider || state.provider });
  }
  function renderRoute() {
    const node = $("route-preview"); if (!node) return;
    const text = ui.input.value.trim(), files = window.relayFiles?.ids().length || 0;
    const routed = !isRunning() && !state.conversation?.resume && (text || files) ? routeFor(text, files) : null;
    node.hidden = !routed; if (!routed) return;
    node.classList.toggle("error", Boolean(routed.error));
    if (routed.error) { $("route-choice").textContent = "Auto can’t choose"; $("route-reason").textContent = routed.error; return; }
    $("route-choice").textContent = [label(routed.provider), routed.modelName || "default model", routed.effort ? `${routed.effort[0].toUpperCase()}${routed.effort.slice(1)} effort` : ""].filter(Boolean).join(" · ");
    $("route-reason").textContent = routed.reason;
    node.setAttribute("aria-label", `Auto will use ${$("route-choice").textContent}: ${routed.reason}. Choose a model yourself instead.`);
  }
  async function setRouting(choice) {
    if (!state.conversation) await ensureCanonicalConversation();
    await post(endpoint(state.conversation.id, "routing"), choice, state.projectId);
    await refresh();
  }
  // A note added to the working run (#32): the agent takes it into the same task instead of after it.
  async function addToRun() {
    const text = ui.input.value.trim(), id = state.conversation?.id, projectId = state.projectId, draft = ui.input.value;
    if (!text || state.pending || !id || $("steer-button").hidden || $("steer-button").disabled) return;
    state.pending = "steer"; renderControls();
    try {
      const result = await post(endpoint(id, "steer"), { text }, projectId);
      if (ui.input.value === draft) { ui.input.value = ""; storedWrite(draftKey(), ""); storedWrite(draftKey(null), ""); resizeInput(); }
      if (result?.added) announce("Added to the current run.");
      else showNotice("The run finished before your note could be added, so it runs next from the queue.");
    } catch (error) { showNotice(error.message); }
    finally { state.pending = null; await refresh(); }
  }
  // The agent's own plan for the run, as a to-do list docked above the message box: one line that opens into the list.
  function renderPlan() {
    const run = isRunning() ? state.conversation?.activeRun : null, steps = run?.plan?.steps || [], section = $("run-plan");
    section.hidden = !steps.length;
    if (!steps.length) { state.planSignature = null; return; }
    const signature = JSON.stringify([run.id, steps]);
    if (signature === state.planSignature) return;
    const newRun = state.planSignature && JSON.parse(state.planSignature)[0] !== run.id;
    state.planSignature = signature;
    const done = steps.filter(step => step.status === "done").length, current = steps.find(step => step.status === "active") || steps.find(step => step.status === "pending");
    $("run-plan-ring").style.setProperty("--progress", String(done / steps.length));
    $("run-plan-count").textContent = `${done} of ${steps.length}`;
    $("run-plan-current").textContent = done === steps.length ? "All steps done" : current?.text || "";
    $("run-plan-list").replaceChildren(...steps.map(step => {
      const item = element("li", `run-plan-step ${step.status}`);
      item.append(element("span", "run-plan-mark"), element("span", "run-plan-text", step.text));
      item.setAttribute("aria-label", `${step.status === "done" ? "Done" : step.status === "active" ? "In progress" : "To do"}: ${step.text}`);
      return item;
    }));
    if (newRun) { $("run-plan-list").hidden = true; $("run-plan-toggle").setAttribute("aria-expanded", "false"); }
  }
  function renderQueue() {
    const c = state.conversation, queue = c?.queue || [], section = $("prompt-queue");
    section.hidden = !queue.length;
    const signature = JSON.stringify([c?.id, queue, c?.queuePaused, state.queueEditing, Boolean(state.pending)]);
    if (!queue.length || signature === state.queueSignature) return;
    state.queueSignature = signature;
    $("prompt-queue-title").textContent = `Up next · ${queue.length}`;
    $("prompt-queue-paused").hidden = !c.queuePaused;
    $("prompt-queue-paused").textContent = c.queuePaused ? `Paused: ${c.queuePaused.reason}` : "";
    $("prompt-queue-toggle").textContent = c.queuePaused ? "Resume queue" : "Pause";
    $("prompt-queue-toggle").disabled = Boolean(state.pending);
    const icon = (name, text, handler, disabled = false) => { const button = element("button", `icon-button queue-action queue-${name}`); button.type = "button"; button.title = text; button.setAttribute("aria-label", text); button.disabled = disabled || Boolean(state.pending); button.addEventListener("click", handler); return button; };
    $("prompt-queue-list").replaceChildren(...queue.map((item, index) => {
      const row = element("li", "prompt-queue-item"), body = element("div", "prompt-queue-body");
      const model = item.model ? window.relayModelPicker?.modelName?.(item.provider, item.model) || item.model : "";
      const meta = `${label(item.provider)}${model ? ` · ${model}` : ""} · ${item.mode === "read" ? "Read only" : "Can edit files"} · ${item.approvalPolicy === "auto" ? "full auto-approval" : "asks before changes"}${item.attachments?.length ? ` · ${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}` : ""}`;
      if (state.queueEditing === item.id) {
        const editor = element("textarea", "prompt-queue-editor"); editor.value = item.text; editor.rows = 3; editor.setAttribute("aria-label", "Edit queued message");
        const save = element("button", "pill-button", "Save"), cancel = element("button", "pill-button", "Cancel"); save.type = cancel.type = "button";
        save.addEventListener("click", async () => { if (await queueAction({ action: "update", id: item.id, text: editor.value })) { state.queueEditing = null; renderQueue(); } });
        cancel.addEventListener("click", () => { state.queueEditing = null; renderQueue(); });
        const buttons = element("div", "prompt-queue-edit-actions"); buttons.append(save, cancel);
        body.append(editor, buttons);
      } else body.append(element("p", "prompt-queue-text", item.text), element("span", "prompt-queue-meta", meta));
      const actions = element("div", "prompt-queue-actions");
      actions.append(
        icon("up", "Move up", () => queueAction({ action: "move", id: item.id, index: index - 1 }), index === 0),
        icon("down", "Move down", () => queueAction({ action: "move", id: item.id, index: index + 1 }), index === queue.length - 1),
        icon("edit", "Edit", () => { state.queueEditing = item.id; renderQueue(); }),
        icon("remove", "Remove from queue", () => queueAction({ action: "remove", id: item.id })));
      row.append(element("span", "prompt-queue-number", String(index + 1)), body, actions);
      return row;
    }));
  }
  // An offer to hand the task to another agent before a usage limit stops the run (#17).
  function renderHandoff() {
    const offer = state.conversation?.handoffOffer, section = $("handoff-offer");
    section.hidden = !offer || !isRunning();
    if (section.hidden) return;
    const model = offer.to.model ? window.relayModelPicker?.modelName?.(offer.to.provider, offer.to.model) || offer.to.model : "";
    const billing = { subscription: "subscription", api: "API billing" }[offer.to.billingSource] || "unknown billing";
    $("handoff-title").textContent = `${label(offer.from.provider)} has used ${Math.round(offer.from.usedPercent)}% of its ${offer.from.window ? offer.from.window + " " : ""}limit.`;
    $("handoff-detail").textContent = `Hand off to ${label(offer.to.provider)}${model ? ` · ${model}` : ""} (${billing}) to continue${offer.task ? ` “${offer.task.replace(/[.!?…]+$/, "")}”` : " this task"}. ${offer.to.mode === "read" ? "Read only" : "Can edit files"} · ${offer.to.approvalPolicy === "auto" ? "full auto-approval" : "asks before changes"}.`;
    const charges = offer.to.billingSource !== "subscription";
    $("handoff-billing").hidden = !charges;
    if (charges) $("handoff-billing-text").textContent = offer.to.billingSource === "api" ? `Accept charges: ${label(offer.to.provider)} bills your API account.` : `Accept possible charges: ${label(offer.to.provider)}'s billing could not be confirmed.`;
    if (section.dataset.offerId !== offer.id) { section.dataset.offerId = offer.id; $("handoff-billing-confirm").checked = false; }
    $("handoff-accept").disabled = Boolean(state.pending) || charges && !$("handoff-billing-confirm").checked;
    $("handoff-dismiss").disabled = Boolean(state.pending);
  }
  // A retry one step up after failed tests, when routing asks first (#12): Cost saving, or an agent near its limit.
  function renderRetry() {
    const offer = state.conversation?.retryOffer, section = $("retry-offer");
    if (!section) return;
    section.hidden = !offer || isRunning();
    if (section.hidden) return;
    const model = offer.model ? window.relayModelPicker?.modelName?.(offer.provider, offer.model) || offer.modelName || offer.model : "";
    const choice = [label(offer.provider), model, offer.effort ? `${offer.effort[0].toUpperCase()}${offer.effort.slice(1)} effort` : ""].filter(Boolean).join(" · ");
    $("retry-title").textContent = `The tests failed. Retry with ${choice}?`;
    $("retry-detail").textContent = `${offer.blocked ? `${offer.blocked}, so routing asked first. ` : ""}${label(offer.provider)} gets the end of the test output and tries once more, one step up. ${offer.command} runs again afterwards.`;
    $("retry-accept").disabled = $("retry-dismiss").disabled = Boolean(state.pending);
  }
  async function answerRetry(accept) {
    const offer = state.conversation?.retryOffer, id = state.conversation?.id, projectId = state.projectId;
    if (!offer || !id || state.pending) return;
    state.pending = accept ? "retry" : "dismiss"; renderControls();
    try { await post(endpoint(id, "retry"), { offerId: offer.id, accept }, projectId); }
    catch (error) { showNotice(error.message); }
    finally { state.pending = null; await refresh(); }
  }
  async function answerHandoff(accept) {
    const offer = state.conversation?.handoffOffer, id = state.conversation?.id, projectId = state.projectId;
    if (!offer || !id || state.pending) return;
    state.pending = accept ? "handoff" : "dismiss"; renderControls();
    try { await post(endpoint(id, "handoff"), { offerId: offer.id, accept, billingConfirmed: accept && $("handoff-billing-confirm").checked }, projectId); }
    catch (error) { showNotice(error.message); }
    finally { state.pending = null; await refresh(); }
  }
  async function scheduleResume(approvalPolicy) {
    const id = state.conversation?.id, projectId = state.projectId;
    if (!id || state.pending) return;
    state.resumeChoice = null; state.pending = "resume"; renderControls();
    try {
      await post(endpoint(id, "resume"), { providers: resumeProviders(), mode: state.mode, approvalPolicy, billingConfirmed: window.relayBillingConfirmed === true }, projectId);
      await refresh();
    } catch (error) { showNotice(error.message); }
    finally { state.pending = null; renderControls(); }
  }
  async function cancelResume() {
    const id = state.conversation?.id, projectId = state.projectId;
    if (!id || state.pending) return;
    state.pending = "resume"; renderControls();
    try { await post(endpoint(id, "resume"), { cancel: true }, projectId); await refresh(); }
    catch (error) { showNotice(error.message); }
    finally { state.pending = null; renderControls(); }
  }

  function renderControls() {
    const running = isRunning();
    const otherRunning = isOtherRunning();
    const busy = Boolean(state.pending) || state.loading || state.projectSaving;
    const name = state.conversation?.activeRun?.connection === 'local' ? 'Local model' : label(state.provider);
    const selectedConnection=autoRouting()?{installed:true,checking:false,needsSignIn:false,needsBilling:false,account:{authenticated:true},blocked:false}:connection(state.provider);
    ui.codex.classList.toggle("selected", state.provider === "codex");
    ui.claude.classList.toggle("selected", state.provider === "claude");
    for (const provider of ["codex", "claude", "gemini"]) {
      ui[provider].classList.toggle("selected", state.provider === provider);
      ui[provider].setAttribute("aria-pressed", String(state.provider === provider));
      ui[provider].disabled = !state.ready || busy || running || !available(provider);
      ui[provider].title = available(provider) ? `Use ${label(provider)} for your next message` : `${label(provider)} CLI is not installed`;
    }
    ui.agent.value = state.provider;
    ui.agent.disabled = !state.ready || busy || running;
    for (const option of ui.agent.querySelectorAll("option")) option.disabled = option.value !== "local" && !available(option.value);
    ui.mode.value = state.mode;
    ui.mode.disabled = !state.ready || busy || running;
    if (ui.approval) {
      ui.approval.value = state.approvalPolicy || "ask";
      ui.approval.disabled = !state.ready || busy || running || state.mode === "read";
    }
    ui.input.disabled = !state.ready || state.loading || state.pending === "new";
    // While work runs or waits for a reset, a message joins the queue instead of starting now (#32).
    const queueing = Boolean(state.conversation) && (running || Boolean(state.conversation?.resume));
    const canAdd = running && state.conversation?.canAddToRun === true, modKey = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘" : "Ctrl+";
    ui.input.placeholder = queueing ? (canAdd ? `Queue a follow-up, or ${modKey}↵ to add it to this run…` : "Add a message to the queue…") : "Describe the task or ask a question…";
    $("steer-button").hidden = !canAdd;
    $("steer-button").disabled = !state.ready || busy || !ui.input.value.trim() || Boolean(window.relayFiles?.ids().length);
    $("steer-button").title = window.relayFiles?.ids().length ? "Attachments go with a queued message" : `Add this to the current run (${modKey}↵)`;
    $("queue-button").hidden = !queueing;
    $("queue-button").disabled = !state.ready || busy || Boolean(state.localSelections[state.projectId]) || window.relayFiles?.uploading() || !ui.input.value.trim();
    ui.send.hidden = running;
    ui.send.disabled = !state.ready || busy || otherRunning || (!state.localSelections[state.projectId] && selectedConnection.blocked) || window.relayFiles?.uploading() || (!ui.input.value.trim() && !window.relayFiles?.ids().length);
    ui.send.firstElementChild.textContent = state.pending === "send" ? "Sending…" : "Send";
    ui.stop.hidden = !running;
    ui.stop.disabled = busy;
    ui.stop.lastChild.textContent = state.pending === "stop" ? " Stopping…" : " Stop";
    ui.otherRunning.hidden = !otherRunning;
    // A narrow composer shows these pickers as icons, so each names its current choice on hover.
    for (const select of [$("effort-select"), ui.mode, ui.approval]) {
      const picker = select?.closest(".picker"), choice = [...(select?.options || select?.querySelectorAll?.("option") || [])].find(option => option.value === select.value);
      if (picker && choice) picker.title = `${picker.dataset.name ||= picker.title}: ${choice.textContent}`;
    }
    const incomplete = ["incomplete", "interrupted"].includes(state.conversation?.status);
    const lastMessage = state.conversation?.messages?.at(-1);
    const canContinue = !running && state.conversation?.lastRun?.purpose !== 'review' && (incomplete || lastMessage?.role === "error");
    const resume = state.conversation?.resume;
    ui.continuation.hidden = !canContinue || Boolean(resume);
    const previous=state.conversation?.lastRun;
    const reason={quota:'Usage limit reached.',authentication:'Sign-in required.',permission:'A permission request was declined.',protocol:'The assistant connection stopped.',interrupted:'Run stopped.'}[previous?.errorCategory] || 'The previous run did not finish.';
    ui.continueText.textContent = reason;
    const alternative=['codex','claude','gemini'].find(provider=>provider!==state.provider&&!connection(provider).blocked) || state.provider;
    const continuationProvider=previous?.errorCategory==='quota' && previous.provider===state.provider && !connection(alternative).blocked ? alternative : state.provider;
    state.continuationProvider=continuationProvider;
    // The suggestion names its model too; the menu beside it continues with any agent and model.
    const continuationModel = continuationProvider === state.provider ? state.model : state.conversation?.models?.[continuationProvider];
    const modelLabel = continuationModel ? window.relayModelPicker?.modelName?.(continuationProvider, continuationModel) || continuationModel : "";
    ui.continueButton.replaceChildren(document.createTextNode(state.pending === "continue" ? "Continuing…" : `Continue with ${label(continuationProvider)}${modelLabel ? ` · ${modelLabel}` : ""} `), element("span", "", "→"));
    $("continue-choose").disabled = busy || otherRunning;
    ui.continueButton.disabled = busy || otherRunning || connection(continuationProvider).blocked;
    // After a usage limit, the task can wait for a reset and continue on whichever agent has room first.
    const quotaStop = canContinue && previous?.errorCategory === 'quota', choosing = quotaStop && state.resumeChoice === state.conversation?.id;
    $("resume-button").hidden = !quotaStop || choosing;
    $("resume-choice").hidden = !choosing;
    for (const id of ["resume-button", "resume-ask", "resume-auto"]) $(id).disabled = busy || otherRunning || !resumeProviders().length;
    $("resume-waiting").hidden = !resume;
    if (resume) $("resume-waiting-text").textContent = resumeText(resume);
    renderQueue(); renderHandoff(); renderRetry(); renderPlan(); renderRoute();
    const hasMessages = Boolean(state.conversation?.messages?.length);
    ui.title.textContent=state.loading&&state.projectId?'Opening workspace…':currentProject()?.name||'Throughline';
    // With the sidebar hidden, the top bar names the open workspace; clicking it shows the sidebar again.
    $("workspace-chip-name").textContent=currentProject()?.name||'No workspace';
    $("workspace-chip").setAttribute("aria-label",`${currentProject()?.name||'No workspace'}. Show the sidebar.`);
    const run=state.conversation?.activeRun || state.conversation?.lastRun;
    const effective=run?.provider===state.provider?run.effectiveModel:null;
    ui.subtitle.textContent=state.projectId?'Conversation':'Workspace';
    ui.state.classList.toggle('running',running);
    ui.state.hidden=!state.projectId||!state.ready;
    const approvals=state.conversation?.pendingApprovals?.length;
    let status=running?(approvals?'Approval required':'Running'):selectedConnection.needsSignIn||!selectedConnection.installed?'Connection required':selectedConnection.needsBilling?'Review billing':selectedConnection.checking?'Checking connection':selectedConnection.account?.authenticated!==true?'Not verified':'Ready';
    if (state.localSelections[state.projectId] && !running) status = 'Local selected';
    if (running && run?.purpose === 'review') status = 'Reviewing';
    if(incomplete && run?.provider===state.provider)status='Stopped';
    if(resume && !running)status='Waiting for reset';
    if(state.pending==='stop')status='Stopping…';else if(state.pending==='send'||state.pending==='continue')status='Sending…';
    ui.state.lastElementChild.textContent=status;
    ui.state.dataset.status=running?(approvals?'approval':'running'):resume?'waiting':incomplete?'stopped':!state.localSelections[state.projectId] && selectedConnection.blocked?'setup':'ready';
    renderConnectionNotice();
    document.title = currentProject() ? currentProject().name + " · Throughline" : "Throughline · Your project workspaces";
  }
  function render(forceScroll = false) { renderProjects(); renderStatus(); renderWorkspaceList(); renderMessages(forceScroll); renderControls(); window.dispatchEvent(new CustomEvent("relay-state")); }
  function resizeInput() {
    ui.input.style.height = "auto";
    ui.input.style.height = `${Math.min(Math.max(ui.input.scrollHeight, 64), 200)}px`;
  }

  function applyConversation(conversation, { adoptSettings = true } = {}) {
    const previousStatus = state.conversation?.status;
    state.conversation = conversation;
    if (adoptSettings && !state.settingsPending) {
      state.provider = ['codex','claude','gemini'].includes(conversation.provider) ? conversation.provider : 'codex';
      state.mode = conversation.mode === "read" ? "read" : "edit";
      state.approvalPolicy = conversation.approvalPolicy === "auto" ? "auto" : "ask";
      state.model = conversation.models?.[state.provider] || conversation.model || "";
      state.effort = conversation.effort ?? conversation.efforts?.[state.provider]?.[state.model || "default"] ?? null;
    }
    if (conversation.status === "running" && state.status) state.status.runningConversationId = conversation.id;
    if (previousStatus === "running" && conversation.status !== "running") announce(conversation.status === "complete" ? `${label(conversation.provider)} finished its response.` : "The assistant stopped. You can continue this conversation.");
  }
  async function ensureCanonicalConversation() {
    if (!state.projectId || !state.ready) throw new Error('Choose an available workspace first.');
    if (state.conversation) return state.conversation;
    const projectId = state.projectId, version = state.projectVersion;
    const conversation = await api('/api/conversation',{},projectId);
    if (!sameProject(projectId,version)) throw new Error('The workspace changed while opening its chat.');
    applyConversation(conversation); restoreDraft(); render(); return conversation;
  }

  async function refresh() {
    const projectId = state.projectId;
    const projectVersion = state.projectVersion;
    if (!projectId || !state.ready) return;
    if (state.refreshPromise?.projectId === projectId && state.refreshPromise.version === projectVersion) { state.refreshAgain = true; return state.refreshPromise.promise; }
    const settingsRevision = state.settingsRevision;
    const request = { projectId, version: projectVersion, promise: null };
    state.refreshPromise = request;
    request.promise = (async () => {
      try {
        const [status, conversation] = await Promise.all([api('/api/status',{},projectId),api('/api/conversation',{},projectId)]);
        if (!sameProject(projectId,projectVersion)) return;
        state.status = status;
        applyConversation(conversation,{adoptSettings:settingsRevision === state.settingsRevision});
        render();
      } catch (error) { if (sameProject(projectId, projectVersion)) showNotice(error.message, refresh); }
      finally {
        if (state.refreshPromise === request) {
          state.refreshPromise = null;
          if (state.refreshAgain) { state.refreshAgain = false; scheduleRefresh(); }
        }
      }
    })();
    return request.promise;
  }
  function scheduleRefresh() {
    if (state.eventTimer) return;
    state.eventTimer = setTimeout(() => { state.eventTimer = null; refresh(); }, 120);
  }

  function changeSettings(provider, mode, approvalPolicy = state.approvalPolicy || 'ask') {
    if (!state.ready || state.loading || state.projectSaving || isRunning() || state.pending) return;
    if (provider !== state.provider) { state.model = state.conversation?.models?.[provider] || ""; state.effort = state.conversation?.efforts?.[provider]?.[state.model || "default"] ?? null; }
    if (mode === "read") approvalPolicy = "ask";
    state.provider = provider;
    state.mode = mode;
    state.approvalPolicy = approvalPolicy;
    renderControls();
    window.dispatchEvent(new CustomEvent("relay-state"));
    if (!state.conversation) return;
    const id = state.conversation.id;
    const projectId = state.projectId;
    const projectVersion = state.projectVersion;
    const revision = ++state.settingsRevision;
    state.settingsPending++;
    renderProjects();
    renderWorkspaceList();
    state.settingsPromise = state.settingsPromise.catch(() => {}).then(async () => {
      try {
        const conversation = await post(endpoint(id, "provider"), { provider, mode, approvalPolicy }, projectId);
        if (sameProject(projectId, projectVersion) && state.conversation?.id === id && revision === state.settingsRevision) applyConversation(conversation, { adoptSettings: false });
      } catch (error) {
        if (sameProject(projectId, projectVersion)) showNotice(`Could not save the assistant selection. ${error.message}`, () => changeSettings(provider, mode, approvalPolicy));
      } finally { state.settingsPending--; renderProjects(); renderWorkspaceList(); scheduleRefresh(); }
    });
  }

  async function run(continuing = false) {
    const attachments = continuing ? [] : window.relayFiles?.ids() || [];
    const text = ui.input.value.trim() || (attachments.length ? "Please review the attached files." : "");
    if (window.relayFiles?.uploading()) return;
    if (state.pending || state.loading || state.projectSaving || isRunning() || isOtherRunning() || !state.ready || (!state.localSelections[state.projectId] && !(autoRouting() && !continuing) && connection(state.provider).blocked) || (!continuing && !text)) return;
    // Under Auto the message goes to the agent, model and effort shown before sending.
    const routed = continuing ? null : routeFor(text, attachments.length);
    if (routed?.error) { showNotice(routed.error); return; }
    const provider = routed?.provider || state.provider, model = routed ? routed.model : state.model, effort = routed ? routed.effort : state.effort;
    const routing = routed ? { mode: routed.mode, reason: routed.reason, tier: routed.tier, escalation: routed.escalation || null } : undefined;
    const mode = state.mode;
    const approvalPolicy = state.approvalPolicy || 'ask';
    const originalDraft = ui.input.value;
    const localChoice = state.localSelections[state.projectId] || null;
    const payloadKey = JSON.stringify([state.projectId,state.conversation?.id,continuing,text,provider,mode,approvalPolicy,model,effort,attachments,localChoice]);
    const requestId = state.retrySubmission?.key === payloadKey ? state.retrySubmission.id : crypto.randomUUID();
    state.retrySubmission = { ...(state.retrySubmission?.key === payloadKey ? state.retrySubmission : {}), key:payloadKey,id:requestId };
    const projectId = state.projectId;
    state.pending = continuing ? "continue" : "send";
    saveDraft();
    render();
    hideNotice();
    try {
      await state.settingsPromise;
      if (!state.conversation) await ensureCanonicalConversation();
      const id = state.conversation.id;
      state.retrySubmission.key = JSON.stringify([state.projectId,id,continuing,text,provider,mode,approvalPolicy,model,effort,attachments,localChoice]);
      if (localChoice) {
        if (!state.retrySubmission.localContext) {
          const catalog = await api('/api/local-models', {}, projectId);
          if (!catalog.installed) throw Error('Install Codex CLI for local workspace tools.');
          if (!catalog.models.some(row => row.id === localChoice.model && row.digest === localChoice.digest)) throw Error('This local model changed or was removed. Choose it again from the model picker.');
          state.retrySubmission.localContext = catalog.context;
        }
        await post('/api/local-models/start', { model:localChoice.model, digest:localChoice.digest, task:continuing ? 'Continue the unfinished task from the saved conversation. Inspect current files first.' : text, attachments, requestId, context:state.retrySubmission.localContext }, projectId);
      } else await post(endpoint(id, continuing ? "continue" : "messages"), continuing ? { provider, mode, approvalPolicy, requestId, model:model || undefined, effort:effort || null, billingConfirmed:window.relayBillingConfirmed === true } : { text, attachments, provider, mode, approvalPolicy, requestId, model:model || undefined, effort:effort || null, routing, billingConfirmed:window.relayBillingConfirmed === true }, projectId);
      state.retrySubmission = null;
      if (!continuing) window.relayFiles?.accepted(projectId, attachments);
      if (!continuing && ui.input.value === originalDraft) {
        ui.input.value = "";
        storedWrite(draftKey(), "");
        storedWrite(draftKey(null), "");
        resizeInput();
      }
      state.conversation.status = "running";
      if (!localChoice) state.conversation.provider = provider;
      state.conversation.mode = mode;
      state.conversation.approvalPolicy = approvalPolicy;
      if (state.status) state.status.runningConversationId = id;
      announce(`${localChoice ? "Local · Ollama" : label(provider)} is working.`);
      await refresh();
      render(true);
    } catch (error) {
      showNotice(error.message, () => run(continuing));
      await refresh();
    } finally { state.pending = null; render(); ui.input.focus(); }
  }

  async function stop() {
    if (!isRunning() || state.pending || state.projectSaving) return;
    state.pending = "stop";
    const projectId = state.projectId;
    render();
    try {
      await post(endpoint(state.conversation.id, "stop"), {}, projectId);
      announce("Stop requested. Waiting for the assistant to finish stopping.");
      await refresh();
    } catch (error) { showNotice(error.message, stop); }
    finally { state.pending = null; render(); }
  }

  async function selectProject(id) {
    if (projectBusy() || !id || !state.projects.some((project) => project.id === id)) {
      ui.projectSelect.value = state.projectId || "";
      return;
    }
    if (id === state.projectId && state.ready) return;
    saveDraft();
    closeWorkspaceMenu();
    hideNotice();
    const version = ++state.projectVersion;
    ++state.selectionVersion;
    state.projectId = id;
    state.status = null;
    state.conversation = null;
    state.ready = false;
    state.loading = true;
    state.refreshAgain = false;
    ui.input.value = "";
    activeProjectWrite(id);
    ui.projectPanel.hidden = true; ui.folderPanel.hidden = true;
    ui.addProject.setAttribute("aria-expanded", "false");
    render(true);
    try {
      const [status, conversation] = await Promise.all([api('/api/status',{},id),api('/api/conversation',{},id)]);
      if (!sameProject(id,version)) return;
      state.status = status; applyConversation(conversation);
      state.ready = true; state.loading = false; restoreDraft();
      if (sameProject(id, version)) { render(true); announce(`Opened project ${currentProject()?.name || "workspace"}.`); }
    } catch (error) {
      if (sameProject(id, version)) showNotice(error.message, () => selectProject(id));
    } finally {
      if (sameProject(id, version)) { state.loading = false; render(); }
    }
  }

  async function refreshProjects({ choose = false } = {}) {
    const version = ++state.projectsRequestVersion;
    const projects = await api("/api/projects");
    if (version !== state.projectsRequestVersion) return;
    state.projects = Array.isArray(projects) ? projects : projects.projects || [];
    state.projectsLoaded = true;
    render();
    await reconcileProjectSelection(choose);
  }
  async function reconcileProjectSelection(choose = true) {
    if (projectBusy()) return;
    if (state.projectId && !state.projects.some(project => project.id === state.projectId)) {
      saveDraft(); ++state.projectVersion; ++state.selectionVersion;
      state.projectId = null; state.status = null; state.conversation = null;
      state.ready = false; state.loading = false; state.refreshAgain = false;
      ui.input.value = ''; activeProjectWrite('');
      ui.projectPanel.hidden = true; ui.folderPanel.hidden = true;
      ui.addProject.setAttribute('aria-expanded','false');
      render(true);
    }
    if (choose && !state.projectId && state.projects.length) {
      const remembered = activeProjectRead();
      const selected = state.projects.find((project) => project.id === remembered) || state.projects[0];
      await selectProject(selected.id);
    }
  }
  function scheduleProjectsRefresh() {
    if (state.projectsTimer) return;
    state.projectsTimer = setTimeout(() => {
      state.projectsTimer = null;
      refreshProjects({ choose: true }).catch((error) => showNotice(error.message, initialize));
    }, 400);
  }
  function folderPaths(text) { return [...new Set(text.split('\n').map(value=>value.trim()).filter(Boolean))]; }
  function validFolderPath(value) { return value === '~' || value.startsWith('~/') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value); }
  function toggleFolderForm(open) {
    if (projectBusy() || open && (!state.projectId || isRunning())) return;
    ui.folderPanel.hidden = !open;
    if (open) { closeWorkspaceMenu(); ui.projectPanel.hidden = true; ui.addProject.setAttribute('aria-expanded','false'); ui.folderError.hidden = true; $('folder-panel-description').textContent = 'Add a folder to ' + currentProject().name + '. It joins the same existing chat; files stay where they are.'; ui.folderPath.focus(); }
  }
  async function addProject(event) {
    event.preventDefault(); if (projectBusy()) return;
    const folders = folderPaths(ui.projectPaths.value), name = ui.projectName.value.trim();
    if (!folders.length || folders.some(value=>!validFolderPath(value))) { ui.projectError.textContent = 'Enter one or more absolute or ~/ folder paths, one per line.'; ui.projectError.hidden = false; ui.projectPaths.focus(); return; }
    saveDraft(); state.projectSaving = true; ui.projectError.hidden = true; render();
    try {
      const project = await post('/api/projects',{folders,...(name ? {name} : {})});
      if (!state.projects.some(item=>item.id === project.id)) state.projects = [...state.projects,project]; else state.projects = state.projects.map(item=>item.id === project.id ? project : item);
      state.projectsLoaded = true; await refreshProjects().catch(()=>{}); state.projectSaving = false; ui.projectName.value = ''; ui.projectPaths.value = ''; await selectProject(project.id);
    } catch (error) { ui.projectError.textContent = error.message; ui.projectError.hidden = false; }
    finally { state.projectSaving = false; render(); }
  }
  async function addFolder(event) {
    event.preventDefault(); if (projectBusy() || isRunning() || !state.projectId) return;
    const folder = ui.folderPath.value.trim(), projectId = state.projectId;
    if (!validFolderPath(folder)) { ui.folderError.textContent = 'Enter an absolute folder path or a path beginning with ~/.'; ui.folderError.hidden = false; ui.folderPath.focus(); return; }
    saveDraft(); state.projectSaving = true; ui.folderError.hidden = true; render();
    try {
      const project = await post('/api/projects/' + encodeURIComponent(projectId) + '/folders',{path:folder});
      state.projects = state.projects.map(item=>item.id === project.id ? project : item); ui.folderPath.value = ''; ui.folderPanel.hidden = true; await refresh(); announce('Folder added to this workspace. The same conversation is open.');
    } catch (error) { ui.folderError.textContent = error.message; ui.folderError.hidden = false; }
    finally { state.projectSaving = false; render(); }
  }
  async function removeFolder(projectId,folderId) {
    if (projectBusy() || isRunning() || projectId !== state.projectId || foldersFor(currentProject()).length <= 1) return;
    saveDraft(); state.projectSaving = true; render();
    try {
      const project = await post('/api/projects/' + encodeURIComponent(projectId) + '/folders/' + encodeURIComponent(folderId) + '/remove');
      state.projects = state.projects.map(item=>item.id === project.id ? project : item); await refresh(); announce('Folder removed from this workspace. Files remain on disk and the conversation is unchanged.');
    } catch (error) { showNotice(error.message,()=>removeFolder(projectId,folderId)); }
    finally { state.projectSaving = false; render(); }
  }
  let optionsProjectId = null, optionsFolderId = null;
  // Workspace settings lists the folders of the workspace it is open for (the active one otherwise).
  function renderFolderSettings(id = $('workspace-options-dialog').open && optionsProjectId || state.projectId) {
    const host = $('workspace-folder-settings'), project = state.projects.find(item => item.id === id); host.replaceChildren(); if (!project) return;
    const folders = foldersFor(project), list = element('ul','settings-folder-list'), running = Boolean(project.runningConversationId || id === state.projectId && isRunning());
    for (const folder of folders) {
      const item = element('li','settings-folder' + (folder.available === false ? ' unavailable' : '')), info = element('div','settings-folder-info'), icon = element('span','workspace-folder-icon');
      icon.setAttribute('aria-hidden','true'); info.append(element('span','settings-folder-name',folder.displayName || folder.name),element('span','settings-folder-path',folder.path.replace(/^\/(?:Users|home)\/[^/]+/,'~'))); info.title = folder.path;
      const remove = element('button','folder-options'); remove.type = 'button'; remove.dataset.folderId = folder.id; remove.disabled = projectBusy();
      remove.setAttribute('aria-label','Remove ' + (folder.displayName || folder.name) + ' from workspace'); remove.title = folders.length <= 1 ? 'A workspace needs at least one folder' : 'Remove from workspace';
      remove.addEventListener('click',()=>openFolderOptions(id,folder.id)); item.append(icon,info,remove); list.append(item);
    }
    const add = element('button','workspace-add-folder','Add folder'); add.type = 'button'; add.disabled = projectBusy() || running;
    add.addEventListener('click',async()=>{ $('workspace-options-dialog').close(); if (id !== state.projectId) await selectProject(id); toggleFolderForm(true); });
    host.append(list,add);
  }
  function openWorkspaceOptions(id) {
    const project = state.projects.find(item => item.id === id); if (!project || projectBusy()) return;
    optionsProjectId = id; renderFolderSettings(id); renderPermissions(id); $('rename-workspace-name').value = project.name; $('workspace-options-error').hidden = true;
    $('workspace-remove').disabled = Boolean(project.runningConversationId || id === state.projectId && isRunning());
    $('workspace-remove').title = $('workspace-remove').disabled ? 'Stop the current run before removing this workspace.' : '';
    $('workspace-options-dialog').showModal(); $('rename-workspace-name').focus();
  }
  // Approvals remembered for this workspace, each revocable; a rule allows only the exact action it names.
  async function renderPermissions(id, change = null) {
    const list = $('workspace-permission-list'), empty = $('workspace-permissions-empty'), reset = $('workspace-permissions-reset');
    let rules;
    try { rules = (change ? await post('/api/permissions', change, id) : await api('/api/permissions', {}, id)).rules || []; }
    catch (error) { $('workspace-options-error').textContent = error.message; $('workspace-options-error').hidden = false; return; }
    if (optionsProjectId !== id) return;
    list.replaceChildren(...rules.map(rule => {
      const item = element('li', 'workspace-permission'), text = element('div', 'workspace-permission-text');
      const used = rule.uses ? `used ${rule.uses} time${rule.uses === 1 ? '' : 's'}` : 'not used yet';
      text.append(element('code', '', rule.label), element('span', '', `${label(rule.provider)} · ${rule.kind === 'command' ? 'command' : 'file edit'} · ${used}`));
      const revoke = element('button', 'secondary-button', 'Revoke'); revoke.type = 'button';
      revoke.setAttribute('aria-label', `Revoke ${rule.label}`);
      revoke.addEventListener('click', () => renderPermissions(id, { revoke: rule.id }));
      item.append(text, revoke); return item;
    }));
    empty.hidden = rules.length > 0; reset.hidden = rules.length < 2;
  }
  $('workspace-permissions-reset').addEventListener('click', () => { if (optionsProjectId) renderPermissions(optionsProjectId, { reset: true }); });
  $('close-workspace-options').addEventListener('click',()=>{ if (!state.projectSaving) $('workspace-options-dialog').close(); });
  $('workspace-options-dialog').addEventListener('cancel',event=>{if(state.projectSaving)event.preventDefault();});
  $('workspace-remove').addEventListener('click',()=>{ $('workspace-options-dialog').close(); confirmRemoveWorkspace(optionsProjectId); });
  $('rename-workspace-form').addEventListener('submit',async event=>{
    event.preventDefault(); if (projectBusy()) return;
    const id = optionsProjectId, name = $('rename-workspace-name').value.trim();
    if (!name || name.length > 120) { $('workspace-options-error').textContent = 'Enter a name between 1 and 120 characters.'; $('workspace-options-error').hidden = false; return; }
    state.projectSaving = true; $('save-workspace-name').disabled = true; render();
    try { const project = await post('/api/projects/' + encodeURIComponent(id),{name}); ++state.projectsRequestVersion;
      state.projects = state.projects.map(item=>item.id === id ? project : item); if (id === state.projectId && state.status) state.status.project = project;
      $('workspace-options-dialog').close(); announce('Workspace renamed to ' + project.name + '.');
    } catch(error) { $('workspace-options-error').textContent = error.message; $('workspace-options-error').hidden = false; }
    finally { state.projectSaving = false; $('save-workspace-name').disabled = false; render(); }
  });
  function openFolderOptions(projectId,folderId) {
    if (projectBusy()) return;
    const project = state.projects.find(item=>item.id === projectId), folder = foldersFor(project).find(item=>item.id === folderId); if (!folder) return;
    optionsProjectId = projectId; optionsFolderId = folderId; $('folder-options-path').textContent = folder.path;
    const last = foldersFor(project).length <= 1, running = Boolean(project.runningConversationId || projectId === state.projectId && isRunning());
    $('folder-options-description').textContent = last ? 'This is the last folder. Add another folder before removing it, or remove the whole workspace from Workspace settings.' : running ? 'Stop the current run before changing workspace folders.' : 'Removing this folder detaches it from this workspace. Files stay on disk and the shared chat is kept.';
    $('confirm-remove-folder').disabled = last || running; $('folder-options-dialog').showModal(); $('close-folder-options').focus();
  }
  $('close-folder-options').addEventListener('click',()=>$('folder-options-dialog').close());
  $('confirm-remove-folder').addEventListener('click',()=>{ $('folder-options-dialog').close(); removeFolder(optionsProjectId,optionsFolderId); });
  function confirmRemoveWorkspace(id) {
    const project = state.projects.find(project => project.id === id);
    if (!project || projectBusy() || project.runningConversationId || id === state.projectId && isRunning()) return;
    state.removingProjectId = id; ui.removeName.textContent = project.name; ui.removeError.hidden = true;
    ui.removeDialog.showModal(); ui.removeCancel.focus();
  }
  function closeRemoveWorkspace() {
    if (state.projectSaving) return;
    ui.removeDialog.close(); state.removingProjectId = null;
    ui.workspaceList.querySelector('.workspace-options')?.focus();
  }
  async function removeWorkspace() {
    const id = state.removingProjectId;
    if (projectBusy() || !id) return;
    // A list refresh may already hide an accepted removal whose response was lost.
    const name = ui.removeName.textContent;
    saveDraft(); state.projectSaving = true; ui.removeError.hidden = true; render();
    try {
      await post('/api/projects/' + encodeURIComponent(id) + '/remove');
      ++state.projectsRequestVersion;
      state.projects = state.projects.filter(project => project.id !== id);
      state.projectSaving = false; closeRemoveWorkspace();
      await reconcileProjectSelection();
      showNotice(name + ' removed. Project files and saved chat are kept.', () => restoreWorkspace(id), 'Undo');
      announce('Workspace removed. Undo is available.');
      if (!state.projectId) ui.addFirstProject.focus();
    } catch (error) { ui.removeError.textContent = error.message; ui.removeError.hidden = false; }
    finally { state.projectSaving = false; render(); }
  }
  async function restoreWorkspace(id) {
    if (projectBusy()) return;
    saveDraft(); state.projectSaving = true; render();
    try {
      const project = await post('/api/projects/' + encodeURIComponent(id) + '/restore');
      ++state.projectsRequestVersion;
      if (!state.projects.some(item => item.id === id)) state.projects.push(project);
      state.projectSaving = false; await selectProject(id);
      announce('Workspace restored with its saved chat.');
    } catch (error) { showNotice(error.message, () => restoreWorkspace(id), 'Retry Undo'); }
    finally { state.projectSaving = false; render(); }
  }
  ui.removeConfirm.addEventListener('click', removeWorkspace);
  ui.removeCancel.addEventListener('click', closeRemoveWorkspace);
  ui.removeDialog.addEventListener('cancel', event => { event.preventDefault(); closeRemoveWorkspace(); });
  function connectEvents() {
    if (state.events) return;
    state.events = new EventSource("/api/events" + (window.relayDesktop?.token ? "?token="+encodeURIComponent(window.relayDesktop.token) : ""));
    state.events.addEventListener("update", (event) => {
      let update;
      try { update = JSON.parse(event.data); } catch { return; }
      if (update.projectId === state.projectId) scheduleRefresh();
      else scheduleProjectsRefresh();
    });
    state.events.addEventListener("projects", scheduleProjectsRefresh);
    // An alert with a sound to play (sounds.js), for any workspace.
    state.events.addEventListener("alert", (event) => { try { window.dispatchEvent(new CustomEvent("relay-alert", { detail: JSON.parse(event.data) })); } catch { /* A malformed alert plays nothing. */ } });
    state.events.addEventListener("error", () => { state.streamConnected = false; window.dispatchEvent(new CustomEvent("relay-state")); });
    state.events.addEventListener("ready", () => { state.streamConnected = true; scheduleProjectsRefresh(); scheduleRefresh(); });
    state.events.addEventListener("open", () => { state.streamConnected = true; scheduleProjectsRefresh(); scheduleRefresh(); });
    // Recover from missed events and a sleeping browser tab.
    state.pollTimer = setInterval(() => { if (!document.hidden) { scheduleProjectsRefresh(); scheduleRefresh(); } }, 15000);
    window.addEventListener("focus", () => { scheduleProjectsRefresh(); scheduleRefresh(); refreshAccounts().catch(()=>{}); });
  }
  async function initialize() {
    try {
      await refreshProjects({ choose: true });
      render();
      connectEvents();
      refreshAccounts().catch(()=>{});
    } catch (error) { showNotice(error.message, initialize); }
  }

  // The search bar at the top (⌘K) finds workspaces, files in every workspace and actions; ">" first shows actions
  // only. It never filters the sidebar. Enter runs the highlighted result, the first match at first, and Escape clears it.
  const commandActions = [
    { label: "Review changes…", id: "open-review" }, { label: "Ask a friend…", id: "ask-friend" },
    { label: "Previous chats…", id: "open-import" }, { label: "Export conversation…", id: "open-export" },
    { label: "Agents: routing and handoff", run: () => window.relayAgents?.open() },
    { label: "Git activity", run: () => { if ($("git-panel").hidden) $("open-git").click(); } },
    { label: "Terminal", run: () => window.relayTerminal?.open() },
    { label: "Run: your dev servers, tests and scripts", run: () => window.relayPanel?.show("run") },
    ...(window.relayDesktop?.openPreview ? [{ label: "Preview your app and point at what to change", run: () => { const url = window.relayCommands?.localURL?.(); if (url) window.relayPreview?.open(url); else { window.relayPanel?.show("run"); showNotice("Start your dev server in Run first; its local address opens in the preview."); } } }] : []),
    { label: "While you were away", run: () => window.relayRecap?.open() },
    { label: "New workspace…", id: "create-workspace" }, { label: "Settings", id: "relay-settings" },
    { label: "Preferences: appearance, updates, voice and recaps", run: () => window.relaySettings?.open("preferences") },
    { label: "Voice settings", run: () => window.relaySettings?.open("preferences", "Voice") },
  ];
  let commandActive = 0, commandItems = [], commandFiles = { query: "", files: [] }, fileSearch = 0, fileTimer = null;
  const commandQuery = () => { const raw = $("workspace-search").value.trim(); return raw.startsWith(">") ? { actionsOnly: true, text: raw.slice(1).trim().toLowerCase() } : { actionsOnly: false, text: raw.toLowerCase() }; };
  // File matches come from the app, a moment after typing stops.
  function searchFiles() {
    const { actionsOnly, text } = commandQuery(), request = ++fileSearch;
    clearTimeout(fileTimer);
    if (actionsOnly || text.length < 2) { commandFiles = { query: text, files: [] }; return; }
    fileTimer = setTimeout(async () => {
      try { const result = await api(`/api/file-search?q=${encodeURIComponent(text)}`); if (request === fileSearch) { commandFiles = { query: text, files: result.files || [] }; if ($("workspace-search").value.trim()) renderCommandResults(true); } }
      catch { /* Workspaces and actions still show. */ }
    }, 120);
  }
  async function openFound(file) {
    if (file.projectId !== state.projectId) await selectProject(file.projectId);
    if (state.projectId === file.projectId) window.relayFiles?.openAt(file.folderId, file.path);
  }
  function commandResults() {
    const { actionsOnly, text } = commandQuery();
    const workspaces = actionsOnly ? [] : state.projects.filter(project => project.name.toLowerCase().includes(text)).slice(0, 6).map(project => ({ group: "Workspaces", label: project.name, detail: project.id === state.projectId ? "Open" : "", run: () => { selectProject(project.id); ui.input.focus(); } }));
    const files = actionsOnly || commandFiles.query !== text ? [] : commandFiles.files.slice(0, 10).map(file => ({ group: "Files", label: file.path.split("/").pop(), detail: [state.projects.length > 1 ? file.projectName : "", file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : file.folderName].filter(Boolean).join(" · "), run: () => openFound(file) }));
    const actions = commandActions.filter(action => !text || action.label.toLowerCase().includes(text)).filter(action => !action.id || ($(action.id) && !$(action.id).disabled))
      .map(action => ({ group: "Actions", label: action.label, detail: "", run: action.run || (() => $(action.id).click()) }));
    return [...workspaces, ...files, ...actions];
  }
  function renderCommandResults(open) {
    const host = $("command-results"), bar = host.parentNode;
    commandItems = open ? commandResults() : [];
    host.hidden = !commandItems.length; bar.setAttribute("aria-expanded", String(!host.hidden));
    if (host.hidden) return;
    commandActive = Math.min(Math.max(commandActive, 0), commandItems.length - 1);
    let group = null;
    host.replaceChildren(...commandItems.flatMap((item, index) => {
      const nodes = [];
      if (item.group !== group) { group = item.group; nodes.push(element("div", "command-group", group)); }
      const row = element("button", `command-result${index === commandActive ? " active" : ""}`);
      row.type = "button"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(index === commandActive));
      row.append(element("span", "command-label", item.label), element("span", "command-detail", item.detail));
      row.addEventListener("mousedown", event => event.preventDefault());
      row.addEventListener("click", () => runCommandResult(index));
      nodes.push(row); return nodes;
    }));
  }
  function runCommandResult(index) {
    const item = commandItems[index]; if (!item) return false;
    $("workspace-search").value = ""; commandFiles = { query: "", files: [] }; renderCommandResults(false);
    item.run(); return true;
  }
  $("workspace-search")?.addEventListener("input", () => { commandActive = 0; searchFiles(); renderCommandResults(true); });
  $("workspace-search")?.addEventListener("focus", () => { commandActive = 0; renderCommandResults(true); });
  // An open list follows changes, such as another workspace opening or an action becoming available.
  window.addEventListener("relay-state", () => { if (!$("command-results").hidden) renderCommandResults(true); });
  $("workspace-search")?.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== $("workspace-search")) renderCommandResults(false); }, 120));
  $("workspace-search")?.addEventListener("keydown", (event) => {
    // While an input method is composing, these keys finish or cancel the composition instead.
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!commandItems.length) renderCommandResults(true); commandActive = (commandActive + (event.key === "ArrowDown" ? 1 : -1) + commandItems.length) % Math.max(commandItems.length, 1); renderCommandResults(true); }
    if (event.key === "Enter") { const items = commandItems.length ? commandItems : commandResults(); if (items[commandActive] || items[0]) { event.preventDefault(); commandItems = items; runCommandResult(items[commandActive] ? commandActive : 0); } }
    if (event.key === "Escape") { if ($("workspace-search").value) { event.preventDefault(); $("workspace-search").value = ""; searchFiles(); renderCommandResults(true); } else { renderCommandResults(false); $("workspace-search").blur?.(); } }
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || ""), shortcut = (key, shift = false) => mac ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
  $("workspace-search").placeholder = `Search workspaces and actions   ${shortcut("K")}`;
  $("open-git").title = `Git activity (${shortcut("G", true)})`;
  $("toggle-sidebar").title = `Toggle sidebar (${shortcut("B")})`;
  ui.input.title = `Focus with ${shortcut("L")}`;
  // Shortcuts and the desktop menu bar run these commands. Each returns whether the page handled it, and a shortcut
  // is only claimed when it did, so a key the page leaves alone goes on to the menu, whose item makes the same check.
  // A command that stands in for a button waits while a dialog covers it.
  const covered = () => Boolean(document.querySelector("dialog[open]"));
  const press = id => () => { const control = $(id); if (covered() || !control || control.disabled || control.hidden) return false; control.click(); return true; };
  const commands = {
    "filter-workspaces": () => { $("workspace-search").focus(); $("workspace-search").select(); return true; },
    "focus-message": () => { if (!ui.input.disabled) ui.input.focus(); return true; },
    git: () => { $("open-git").click(); return true; },
    stop: () => { if (!isRunning()) return false; stop(); return true; },
    workspace: number => { const project = filteredProjects()[number - 1]; if (!project) return false; selectProject(project.id); return true; },
    settings: press("relay-settings"), "setup-guide": press("open-setup-guide"), "new-workspace": press("create-workspace"), review: press("open-review"),
    "whats-new": () => { if (covered() || !window.relayUpdates) return false; window.relayUpdates.open(); return true; },
    "check-updates": () => { if (!window.relayUpdater) return false; window.relayUpdater.checkNow(); return true; },
    terminal: () => { if (!state.projectId || !window.relayTerminal) return false; window.relayTerminal.toggle(); return true; },
    voice: () => Boolean(state.projectId && window.relayVoice?.toggle()),
    "local-models": () => window.relayLocal?.open(),
    "previous-chats": press("open-import"), export: press("open-export"), "ask-friend": press("ask-friend"), files: press("toggle-explorer"), "keep-awake": press("keep-awake"),
    "add-folder": () => { if (covered()) return false; toggleFolderForm(true); return true; },
    agent: provider => ["codex", "claude", "gemini"].includes(provider) && press("select-" + provider)(),
    continue: () => !ui.continuation.hidden && press("continue-button")(),
    "open-approval": async target => {
      if (!target || typeof target.projectId !== "string" || !state.projects.some(project => project.id === target.projectId)) return false;
      if (target.projectId !== state.projectId) await selectProject(target.projectId); else await refresh();
      const cards = [...($("pending-approvals")?.querySelectorAll("article") || [])], card = cards.find(item => item.dataset.approvalId === target.approvalId) || cards[0];
      if (card) { card.scrollIntoView?.({ behavior: "smooth", block: "center" }); card.focus?.(); card.classList.add("approval-highlight"); setTimeout(() => card.classList.remove("approval-highlight"), 2000); }
      return true;
    },
    "open-workspace": id => { if (typeof id !== "string" || !state.projects.some(project => project.id === id)) return false; if (id !== state.projectId) selectProject(id); return true; },
    appearance: value => { if (!["system", "graphite", "light"].includes(value)) return false; window.relayTheme?.choose(value); return true; },
    "workspace-settings": () => { if (covered() || !state.projectId) return false; openWorkspaceOptions(state.projectId); return true; },
    "toggle-sidebar": () => !covered() && Boolean(window.relayLayout?.toggleSidebar()),
    "remove-workspace": () => { if (covered() || !state.projectId) return false; confirmRemoveWorkspace(state.projectId); return true; },
  };
  document.addEventListener("keydown", (event) => {
    if (!(mac ? event.metaKey : event.ctrlKey) || event.altKey) return;
    // Ctrl keys typed in the terminal belong to the shell.
    if (!mac && event.target?.closest?.("#terminal-panel")) return;
    const key = event.key.toLowerCase(), run = (name, value) => { if (commands[name](value)) event.preventDefault(); };
    if (key === "k" && !event.shiftKey) run("filter-workspaces");
    else if (key === "l" && !event.shiftKey) run("focus-message");
    else if (key === "g" && event.shiftKey) run("git");
    else if (key === "b" && !event.shiftKey) run("toggle-sidebar");
    else if (key === ".") run("stop");
    else if (/^[1-9]$/.test(event.key) && !event.shiftKey) run("workspace", Number(event.key));
  });
  ui.scroll.addEventListener("scroll", updateJump, { passive: true });
  // Status, permission requests and Continue appear under the latest turn without a new message; a reader at the end keeps seeing them.
  let following = true;
  ui.scroll.addEventListener("scroll", () => { following = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 110; }, { passive: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (following) ui.scroll.scrollTop = ui.scroll.scrollHeight; }).observe($("transcript-footer"));
  $("jump-latest").addEventListener("click", () => { ui.scroll.scrollTo({ top: ui.scroll.scrollHeight, behavior: "smooth" }); ui.input.focus(); });
  ui.projectSelect.addEventListener("change", () => selectProject(ui.projectSelect.value));
  ui.addProject.addEventListener("click", () => toggleProjectForm(ui.projectPanel.hidden));
  ui.addFirstProject.addEventListener("click", () => toggleProjectForm(true));
  ui.projectClose.addEventListener("click", () => toggleProjectForm(false));
  ui.projectForm.addEventListener("submit", addProject);
  ui.createWorkspace.addEventListener("click",()=>toggleProjectForm(true));
  ui.folderForm.addEventListener("submit",addFolder);
  ui.folderClose.addEventListener("click",()=>toggleFolderForm(false));
  ui.workspaceToggle.addEventListener("click", () => {
    const open = ui.workspaceToggle.getAttribute("aria-expanded") !== "true";
    ui.workspaceToggle.setAttribute("aria-expanded", String(open));
    ui.workspaceToggle.closest(".sidebar").classList.toggle("workspaces-open", open);
  });
  document.addEventListener("click", (event) => { if (!event.target.closest(".sidebar")) closeWorkspaceMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.isComposing) { closeWorkspaceMenu(); if (!ui.projectPanel.hidden) toggleProjectForm(false); if (!ui.folderPanel.hidden) toggleFolderForm(false); } });
  ui.form.addEventListener("submit", (event) => { event.preventDefault(); if (!$("queue-button").hidden) queuePrompt(); else run(); });
  $("queue-button").addEventListener("click", queuePrompt);
  $("handoff-accept").addEventListener("click", () => answerHandoff(true));
  $("handoff-dismiss").addEventListener("click", () => answerHandoff(false));
  $("retry-accept").addEventListener("click", () => answerRetry(true));
  $("retry-dismiss").addEventListener("click", () => answerRetry(false));
  $("handoff-billing-confirm").addEventListener("change", renderHandoff);
  $("prompt-queue-toggle").addEventListener("click", () => queueAction({ action: state.conversation?.queuePaused ? "resume" : "pause" }));
  ui.input.addEventListener("input", () => { resizeInput(); saveDraft(); renderControls(); });
  $("steer-button").addEventListener("click", addToRun);
  $("workspace-chip").addEventListener("click", () => window.relayLayout?.toggleSidebar());
  // Choosing an action from the ⋯ menu closes it.
  $("header-menu").addEventListener("click", event => { if (event.target?.closest?.("button")) $("header-menu").hidePopover?.(); });
  // The tabs at the top of a side panel switch to the other panel.
  document.querySelectorAll(".panel-tab").forEach(tab => tab.addEventListener("click", () => { if (tab.getAttribute("aria-selected") !== "true") $(tab.dataset.panel === "git" ? "open-git" : "open-agents").click(); }));
  $("route-preview").addEventListener("click", () => window.relayModelPicker?.open());
  $("run-plan-toggle").addEventListener("click", () => {
    const list = $("run-plan-list"); list.hidden = !list.hidden;
    $("run-plan-toggle").setAttribute("aria-expanded", String(!list.hidden));
  });
  ui.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing && !$("steer-button").hidden) { event.preventDefault(); addToRun(); return; }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$("queue-button").hidden) { if (!$("queue-button").disabled) queuePrompt(); } else if (!ui.send.disabled && !ui.send.hidden) run(); }
  });
  ui.agent.addEventListener("change", () => {
    const selected = ui.agent.value;
    if (selected === "local") { ui.agent.value = state.provider; window.relayLocal?.open(); }
    else if (["codex", "claude", "gemini"].includes(selected) && available(selected)) changeSettings(selected, state.mode, state.approvalPolicy);
  });
  // Choosing an agent yourself, here or from the Agent menu, turns Auto off.
  const chooseAgent = provider => { delete state.localSelections[state.projectId]; if (autoRouting()) setRouting({ mode: null }).catch(error => showNotice(error.message)); changeSettings(provider, state.mode, state.approvalPolicy); };
  ui.codex.addEventListener("click", () => chooseAgent("codex"));
  ui.claude.addEventListener("click", () => chooseAgent("claude"));
  ui.gemini.addEventListener("click", () => chooseAgent("gemini"));
  ui.mode.addEventListener("change", () => changeSettings(state.provider, ui.mode.value, state.approvalPolicy));
  ui.approval?.addEventListener("change", () => changeSettings(state.provider, state.mode, ui.approval.value));
  ui.stop.addEventListener("click", stop);
  ui.continueButton.addEventListener("click", () => {const target=state.continuationProvider||state.provider;if(target!==state.provider)changeSettings(target,state.mode,state.approvalPolicy);run(true);});
  // Any agent and model can continue: choosing one in this menu selects it and continues at once.
  $("continue-choose").addEventListener("click", () => window.relayModelPicker?.openFor($("continue-choose"), { title: "Continue with…", excludeLocal: true, first: state.continuationProvider, onChoose: () => run(true) }));
  // Waiting never raises access: with full auto-approval on, the person chooses whether it applies while they are away.
  $("resume-button").addEventListener("click", () => {
    if (state.mode === "edit" && state.approvalPolicy === "auto") { state.resumeChoice = state.conversation?.id; renderControls(); return; }
    scheduleResume(state.approvalPolicy || "ask");
  });
  $("resume-ask").addEventListener("click", () => scheduleResume("ask"));
  $("resume-auto").addEventListener("click", () => scheduleResume("auto"));
  $("resume-cancel").addEventListener("click", cancelResume);
  ui.viewRunning.addEventListener("click",refresh);
  ui.dismiss.addEventListener("click", hideNotice);
  ui.retry.addEventListener("click", () => { const retry = state.noticeRetry; hideNotice(); if (retry) retry(); });
  document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
    if (ui.input.disabled) return;
    ui.input.value = button.dataset.prompt;
    resizeInput(); saveDraft(); renderControls(); ui.input.focus();
  }));
  $('connect-assistant')?.addEventListener('click',()=>$('relay-settings').click());
  $('connection-install')?.addEventListener('click',()=>{if(state.installUrl)openExternal(state.installUrl);});
  $('connection-action')?.addEventListener('click',()=>state.connectionAction?.());
  // Each agent in Plan usage does one thing: a connected agent shows its limits, any other opens its setup in Settings.
  for(const provider of ['codex','claude','gemini'])$(`${provider}-status`)?.addEventListener('click',event=>{
    if(state.accounts?.[provider]?.authenticated===true&&window.relayUsage)window.relayUsage.open(provider,event.currentTarget||$(`${provider}-status`));
    else if(window.relaySettings)window.relaySettings.open('accounts');else $('relay-settings')?.click();
  });
  window.addEventListener('relay-account',()=>{renderStatus();renderControls();});
  window.addEventListener('relay-billing',()=>{renderStatus();renderControls();});
  window.addEventListener("beforeunload", saveDraft);
  window.relayUI = {
    getState: () => state, describeActivity: parseActivity, api, post, refresh, renderControls, showNotice, selectProject, refreshAccounts, refreshProjects, announce, selectedFolderId: () => selectedFolderId(), selectFolder, highlightLines,
    commands, isRunning, filteredProjects, setRouting, routeFor,
    ensureConversation: ensureCanonicalConversation,
    selectLocalModel(model) {
      if (!state.projectId || !state.ready || state.pending || state.settingsPending || isRunning()) throw Error('Finish the current run before changing the model.');
      if (model && (typeof model.model !== 'string' || !/^[a-f0-9]{64}$/i.test(model.digest))) throw Error('Refresh local models and choose a downloaded model.');
      if (model) state.localSelections[state.projectId] = { model:model.model, digest:model.digest }; else delete state.localSelections[state.projectId];
      state.retrySubmission = null; render();
    },
    async selectAgentModel(provider, model) {
      if (!available(provider)) throw Error('Connect this agent in Settings first.');
      const projectId = state.projectId, version = state.projectVersion;
      changeSettings(provider, state.mode, state.approvalPolicy); await state.settingsPromise;
      if (!sameProject(projectId,version)) return false;
      await window.relayUI.setConfiguration({model,effort:state.conversation?.efforts?.[provider]?.[model || 'default'] ?? null});
      if (!sameProject(projectId,version)) return false;
      delete state.localSelections[projectId]; render(); return true;
    },
    async setModel(model) { return window.relayUI.setConfiguration({ model, effort: null }); },
    async setConfiguration({model = state.model, effort = null}) {
      if (!state.ready || state.pending || state.settingsPending || isRunning()) throw new Error('Finish the current run before changing the model or effort.');
      model = model?.trim() || null;
      const projectId = state.projectId, version = state.projectVersion, conversationId = state.conversation?.id, provider = state.provider;
      const revision = ++state.settingsRevision;
      state.settingsPending++; render();
      const operation = state.settingsPromise.catch(() => {}).then(() => post(endpoint(conversationId,'provider'), {provider,mode:state.mode,approvalPolicy:state.approvalPolicy,model,effort},projectId));
      state.settingsPromise = operation;
      try {
        const conversation = await operation;
        if (sameProject(projectId,version) && revision === state.settingsRevision) {
          state.conversation = conversation; state.model = model || ''; state.effort = effort;
        }
      } finally { state.settingsPending--; if (sameProject(projectId,version)) render(); }
    },
  };
  if (window.relayDesktop) {
    $('pick-folder').hidden = false; $('pick-add-folder').hidden = false;
    $('pick-folder').addEventListener('click',async()=>{try { const picked = await window.relayDesktop.pickFolder(); const folders = Array.isArray(picked) ? picked : picked ? [picked] : []; if (folders.length) ui.projectPaths.value = [...new Set([...folderPaths(ui.projectPaths.value),...folders])].join('\n'); } catch (error) { showNotice(error.message); }});
    $('pick-add-folder').addEventListener('click',async()=>{try { const picked = await window.relayDesktop.pickFolder(); if (picked) ui.folderPath.value = Array.isArray(picked) ? picked[0] || '' : picked; } catch (error) { showNotice(error.message); }});
  }
  render();
  initialize();
})();

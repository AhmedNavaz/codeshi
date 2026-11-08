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
  function draftKey(id = state.conversation?.id) { return state.taskDraft && id !== null ? `ai-relay:draft:task:${state.taskDraft.folderId}` : `ai-relay:draft:${id || "new"}`; }
  function saveDraft() { if (state.status && state.ready && !state.loading) storedWrite(draftKey(), ui.input.value); }
  function restoreDraft() { ui.input.value = storedRead(draftKey()) || ""; resizeInput(); }
  function label(provider) { return provider === "gemini" ? "Gemini" : provider === "claude" ? "Claude" : "Codex"; }
  function available(provider) { return Boolean(state.status?.providers?.[provider]?.available); }
  // A task beside the main conversation (#88) answers only for itself; the main run doesn't hold it up.
  function isRunning() { if (state.taskDraft) return false; return state.conversation?.status === "running" || Boolean(!state.taskId && state.conversation?.id && state.status?.runningConversationId === state.conversation.id); }
  function isOtherRunning() { return Boolean(!state.taskDraft && !state.taskId && state.status?.runningConversationId && state.status.runningConversationId !== state.conversation?.id); }
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
  function showNotice(message, retry = null, actionLabel = "Retry", actions = []) {
    if (state.stopping) return;
    ui.noticeText.textContent = message;
    state.noticeRetry = retry;
    ui.retry.hidden = !retry;
    ui.retry.textContent = actionLabel;
    ui.notice.querySelectorAll(".notice-action-btn").forEach(el => el.remove());
    if (Array.isArray(actions) && actions.length) {
      for (const act of actions) {
        const btn = element("button", "notice-action-btn", act.label);
        btn.type = "button";
        btn.addEventListener("click", () => { hideNotice(); act.run(); });
        ui.notice.insertBefore(btn, ui.retry);
      }
    }
    ui.notice.hidden = false;
  }
  function hideNotice() {
    ui.notice.hidden = true;
    state.noticeRetry = null;
    ui.notice.querySelectorAll(".notice-action-btn").forEach(el => el.remove());
  }
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
    if (/^\/api\/(?:tasks|ledger|memory|budget|skills|status|conversation|conversations|collaboration|git|imports|files|attachments|reviews|local-models|commands|permissions|terminal|checkpoints)(?:\/|$|\?)/.test(path) || (providerEndpoint && projectId)) {
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
      throw new Error("Cannot reach Codeshi. Make sure its local server is still running.");
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
      else {action='Open settings';state.connectionAction=openAccounts;}
    } else if(info.needsSignIn){text=name+' is not signed in.';action='Connect account';state.connectionAction=openAccounts;}
    else if(info.needsBilling){text=info.account.billingSource==='api'?'This connection uses API billing. Review it before sending.':'Billing could not be confirmed. Review this connection before sending.';action='Review connection';state.connectionAction=openAccounts;}
    // Progress for a first check or an explicit recheck shows in the header and composer state, not as a notice.
    else if(!info.checking&&info.account?.authenticated!==true){text='Sign-in status has not been verified.';action='Check connection';state.connectionAction=openAccounts;}
    if(text){notice.hidden=false;$('connection-notice-text').textContent=text;$('connection-action').textContent=action;$('connection-action').hidden=!action;}
  }

  // Setting up or fixing an agent's account happens on the Accounts page of Settings.
  function openAccounts() { if (window.relaySettings) window.relaySettings.open("accounts"); else $("relay-settings")?.click(); }

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
  // What the sidebar is showing in a workspace with several folders: the whole workspace, with all its tasks and no files,
  // or one folder, with that folder's tasks and files. A workspace with one folder is both, so its files are always there.
  function sidebarLevelFor(project = currentProject()) {
    if (!project) return 'folder';
    if (foldersFor(project).length < 2) return 'single';
    state.sidebarLevels ||= {};
    if (!state.sidebarLevels[project.id]) { let saved = null; try { saved = localStorage.getItem('ai-relay:sidebar-level:' + project.id); } catch { /* A convenience only. */ } state.sidebarLevels[project.id] = saved === 'folder' ? 'folder' : 'workspace'; }
    return state.sidebarLevels[project.id];
  }
  function setSidebarLevel(projectId, level) {
    state.sidebarLevels = { ...state.sidebarLevels, [projectId]: level };
    try { localStorage.setItem('ai-relay:sidebar-level:' + projectId, level); } catch { /* A convenience only. */ }
  }
  function selectFolder(folderId, projectId = state.projectId) {
    const project = state.projects.find(item => item.id === projectId); if (!foldersFor(project).some(folder => folder.id === folderId)) return;
    state.selectedFolders = { ...state.selectedFolders, [projectId]: folderId };
    try { localStorage.setItem('ai-relay:folder:' + projectId, folderId); } catch { /* Folder choice is a convenience. */ }
    renderWorkspaceList(); window.dispatchEvent(new CustomEvent("relay-state"));
  }
  function filteredProjects() { return state.projects.filter(project => project.name.toLowerCase().includes(state.workspaceFilter.toLowerCase())); }
  function renderWorkspaceList() {
    const level = sidebarLevelFor();
    const signature = JSON.stringify([state.projects,state.projectId,projectBusy(),state.loading,state.status?.runningConversationId,state.workspaceFilter,selectedFolderId(),state.conversation?.pendingApprovals?.length,level]);
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
      button.addEventListener('click',()=>{ setSidebarLevel(project.id,'workspace'); selectProject(project.id); renderWorkspaceList(); window.dispatchEvent(new CustomEvent('relay-state')); }); const row = element('div','workspace-row');
      const options = element('button','workspace-options'); options.type = 'button'; options.disabled = projectBusy(); options.dataset.projectId = project.id;
      options.setAttribute('aria-label','Workspace options for ' + project.name); options.title = 'Workspace settings'; options.addEventListener('click',()=>openWorkspaceOptions(project.id));
      row.append(button,options); group.append(row);
      // A multi-folder workspace lists its folders; the selected one drives the Files view and Git panel.
      if (active && folders.length > 1) {
        // At the workspace level no one folder is selected.
        const list = element('ul','workspace-folders'), current = level === 'folder' ? selectedFolderId(project) : null;
        for (const folder of folders) {
          const repeated = folders.filter(entry=>(entry.displayName||entry.name)===(folder.displayName||folder.name)).length>1;
          const item = element('li','workspace-folder' + (folder.id === current ? ' selected' : '') + (folder.available === false ? ' unavailable' : ''));
          const pick = element('button','workspace-folder-pick'); pick.type = 'button'; pick.title = folder.path + (folder.available === false ? ' · folder not found' : ''); pick.setAttribute('aria-pressed',String(folder.id === current));
          const icon = element('span','workspace-folder-icon'); icon.setAttribute('aria-hidden','true');
          pick.append(icon,element('span','workspace-folder-name',repeated?folder.name:folder.displayName||folder.name)); pick.addEventListener('click',()=>{ setSidebarLevel(project.id,'folder'); selectFolder(folder.id,project.id); });
          item.append(pick); list.append(item);
        }
        group.append(list);
      }
      ui.workspaceList.append(group);
    }
  }

  let timeFormat = null; // Creating a formatter for each message took longer than drawing it.
  function messageTime(value) {
    const date = new Date(value);
    timeFormat ||= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date);
  }
  // Assistant replies use a small Markdown subset, built as DOM nodes so provider text is never parsed as HTML.
  // A web address opens in the browser; a file reference opens in the preview, and changed files in a step open their diff (#109).
  const FILE_EXTENSIONS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "jsonc", "md", "mdx", "txt", "css", "scss", "less", "html", "htm", "xml", "svg", "vue", "svelte", "py", "rb", "go", "rs", "java", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "kt", "dart", "php", "sh", "bash", "zsh", "yml", "yaml", "toml", "ini", "cfg", "conf", "sql", "graphql", "prisma", "proto", "lock", "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif", "pdf", "wasm"]);
  const FILE_NAMES = new Set(["dockerfile", "makefile", ".gitignore", ".env"]);
  function activate(node, fn) {
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.addEventListener("click", event => { event.preventDefault(); event.stopPropagation?.(); fn(); });
    node.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation?.(); fn(); } });
  }
  function splitLineSuffix(input) {
    let path = String(input || "").trim(), line = null, endLine = null;
    const hash = path.match(/^(.*?)#L?(\d+)(?:-(?:L)?(\d+))?(?:C\d+)?$/i);
    if (hash && hash[1]) { path = hash[1]; line = Number(hash[2]); endLine = Number(hash[3] || hash[2]); }
    else {
      const colon = path.match(/^(.*?):(\d+)(?::\d+|-(\d+))?$/);
      if (colon && colon[1] && !/^[A-Za-z]$/.test(colon[1])) { path = colon[1]; line = Number(colon[2]); endLine = Number(colon[3] || colon[2]); }
    }
    return path ? { kind: "file", path, line, endLine } : null;
  }
  function parseReferenceTarget(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) {
      try { const url = new URL(text); if (["http:", "https:"].includes(url.protocol)) return { kind: "web", url: text }; } catch { return { kind: "invalid", raw: text }; }
    }
    if (/^file:/i.test(text)) {
      try {
        const url = new URL(text);
        let path = decodeURIComponent(url.pathname || "");
        if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
        const hash = (url.hash || "").match(/^#L?(\d+)(?:-(?:L)?(\d+))?(?:C\d+)?$/i);
        if (hash) return { kind: "file", path, line: Number(hash[1]), endLine: Number(hash[2] || hash[1]) };
        return splitLineSuffix(path) || { kind: "invalid", raw: text };
      } catch { return { kind: "invalid", raw: text }; }
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(text) && !/^[A-Za-z]:[\\/]/.test(text) && !/^[^:/\\]+:\d+(?::\d+|-\d+)?$/.test(text)) return { kind: "unsupported", raw: text };
    return splitLineSuffix(text);
  }
  function isFileReference(value) {
    const parsed = parseReferenceTarget(value);
    if (!parsed || parsed.kind !== "file" || !parsed.path) return false;
    const path = parsed.path;
    if (/[<>"'`|?*;$&()[\]{}=]/.test(path) || path.startsWith("-") || path.includes("..") || path.includes("//") || (/\s/.test(path) && !path.includes("/") && !/^file:/i.test(String(value || "")))) return false;
    const base = (path.split(/[\\/]/).pop() || "").toLowerCase();
    if (!base) return false;
    if (FILE_NAMES.has(base)) return true;
    const dot = base.lastIndexOf(".");
    return dot > 0 && FILE_EXTENSIONS.has(base.slice(dot + 1));
  }
  function resolveWorkspaceCandidates(filePath) {
    const project = (state.status?.project?.id === state.projectId ? state.status.project : null) || currentProject(), folders = foldersFor(project), raw = String(filePath || "").trim();
    if (!project || !folders.length) return { kind: "no-project" };
    if (!raw) return { kind: "directory", path: raw };
    if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
      const norm = raw.replace(/\\/g, "/").replace(/\/+$/, "");
      const matches = folders.map(folder => ({ folder, root: String(folder.path || "").replace(/\\/g, "/").replace(/\/+$/, "") }))
        .filter(item => item.root && (norm === item.root || norm.startsWith(item.root + "/")))
        .sort((a, b) => b.root.length - a.root.length);
      if (!matches.length) return { kind: "outside", path: raw };
      const { folder, root } = matches[0];
      if (norm === root) return { kind: "directory", path: raw };
      const relative = norm.slice(root.length + 1);
      if (!relative || relative.split("/").some(part => !part || part === "." || part === "..")) return { kind: "outside", path: raw };
      if (folder.available === false) return { kind: "unavailable", folder };
      return { kind: "exact", folder, relative };
    }
    let rel = raw.replace(/\\/g, "/");
    while (rel.startsWith("./")) rel = rel.slice(2);
    if (!rel || rel.endsWith("/")) return { kind: "directory", path: raw };
    const parts = rel.split("/");
    if (parts.some(part => !part || part === "." || part === "..")) return { kind: "outside", path: raw };
    if (parts.length === 1 && folders.some(folder => [folder.displayName, folder.name, folder.id].some(name => name && name.toLowerCase() === rel.toLowerCase()))) {
      return { kind: "directory", path: raw };
    }
    let named = [];
    if (parts.length > 1) {
      const prefix = parts[0], exact = folders.filter(folder => folder.displayName === prefix || folder.name === prefix || folder.id === prefix);
      named = exact.length ? exact : folders.filter(folder => [folder.displayName, folder.name, folder.id].some(name => name && name.toLowerCase() === prefix.toLowerCase()));
      if (named.length === 1) {
        const folder = named[0], rest = parts.slice(1).join("/");
        if (folder.available === false) return { kind: "unavailable", folder };
        return { kind: "exact", folder, relative: rest, ...(folders.length === 1 && rel !== rest ? { fallbackRelative: rel } : {}) };
      }
    }
    const targetFolders = named.length > 1 ? named : folders, targetRelative = named.length > 1 ? parts.slice(1).join("/") : rel;
    const availableFolders = targetFolders.filter(folder => folder.available !== false);
    if (!availableFolders.length) return { kind: "unavailable", folder: targetFolders[0] };
    if (availableFolders.length === 1 && targetFolders.length === 1) return { kind: "exact", folder: availableFolders[0], relative: targetRelative };
    return { kind: "probe", folders: availableFolders, relative: targetRelative };
  }
  function reportResolutionProblem(resolved) {
    if (resolved.kind === "no-project") showNotice("Choose a workspace first.");
    else if (resolved.kind === "outside") showNotice(`Only files inside this workspace can be opened (${resolved.path}).`);
    else if (resolved.kind === "directory") showNotice("That link points to a folder, not a file.");
    else if (resolved.kind === "unavailable") showNotice(`${resolved.folder.displayName || resolved.folder.name} is not available on this computer.`);
  }
  function isFolderReference(raw) {
    const text = String(raw || "").trim();
    if (!text) return true;
    try { if (["http:", "https:"].includes(new URL(text).protocol)) return false; } catch { /* Relative path. */ }
    const parsed = parseReferenceTarget(text);
    if (!parsed) return true;
    if (parsed.kind === "unsupported") return false;
    if (parsed.kind !== "file") return true;
    const cleanPath = (parsed.path || "").replace(/\\/g, "/");
    if (!cleanPath || cleanPath.endsWith("/")) return true;
    const resolved = resolveWorkspaceCandidates(cleanPath);
    if (resolved.kind === "directory") return true;
    const project = (state.status?.project?.id === state.projectId ? state.status.project : null) || currentProject();
    const folders = foldersFor(project);
    const norm = cleanPath.replace(/\/+$/, "");
    if (folders.some(folder => {
      const root = String(folder.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
      return root && (norm === root || norm.toLowerCase() === root.toLowerCase());
    })) return true;
    if (folders.some(folder => [folder.displayName, folder.name, folder.id].some(name => name && (norm === name || norm.toLowerCase() === name.toLowerCase())))) return true;
    return !isFileReference(text);
  }
  function showPreviewFallback(folder, relative, file, line, endLine = line) {
    if (window.relayFiles?.showPreviewAt) { window.relayFiles.showPreviewAt(folder, relative, file, line, endLine); return; }
    $("file-preview-name").textContent = file.name || relative.split("/").pop();
    $("file-preview-path").textContent = (folder.displayName || folder.name) + " / " + relative;
    const content = $("file-preview-content"), source = element("pre", "file-source"), lines = String(file.text || "").split("\n");
    lines.forEach((text, index) => { const row = element("span", "source-line"); row.append(element("span", "line-number", String(index + 1)), element("code", "", text || " ")); source.append(row); });
    content.replaceChildren(source);
    $("file-preview").hidden = false; document.body.classList.add("file-preview-open");
    if (Number.isSafeInteger(line) && line >= 1) {
      const rows = content.querySelectorAll(".source-line"), finish = Number.isSafeInteger(endLine) && endLine >= line ? endLine : line;
      for (let index = line; index <= finish; index++) rows[index - 1]?.classList.add("review-line");
      rows[line - 1]?.scrollIntoView({ block: "center" });
    }
  }
  async function openWorkspaceFile(folder, relative, line, endLine, fallbackRelative = null) {
    const projectId = state.projectId;
    try {
      const file = await api(`/api/files/preview?folderId=${encodeURIComponent(folder.id)}&path=${encodeURIComponent(relative)}`, {}, projectId);
      if (projectId === state.projectId) showPreviewFallback(folder, relative, file, line, endLine);
      return true;
    } catch (error) {
      if (fallbackRelative && fallbackRelative !== relative) return openWorkspaceFile(folder, fallbackRelative, line, endLine, null);
      if (projectId === state.projectId) showNotice(error.message);
      return false;
    }
  }
  async function probeWorkspaceFiles(folders, relative, line, endLine) {
    const projectId = state.projectId;
    const results = await Promise.all(folders.map(async folder => {
      try { return { folder, file: await api(`/api/files/preview?folderId=${encodeURIComponent(folder.id)}&path=${encodeURIComponent(relative)}`, {}, projectId) }; }
      catch (error) { return { folder, error }; }
    }));
    if (projectId !== state.projectId) return false;
    const found = results.filter(item => item.file);
    if (found.length > 1) {
      // The same path is in several folders; the folder buttons on the notice open the one meant, instead of guessing.
      const actions = found.map(item => ({
        label: item.folder.displayName || item.folder.name,
        run: () => showPreviewFallback(item.folder, relative, item.file, line, endLine)
      }));
      showNotice(`${relative} is in ${found.length} workspace folders. Open it from:`, null, "Retry", actions);
      return false;
    }
    if (found.length === 1) {
      showPreviewFallback(found[0].folder, relative, found[0].file, line, endLine);
      return true;
    }
    showNotice(results[0]?.error?.message || `Could not find ${relative} in this workspace.`);
    return false;
  }
  async function openReference(raw) {
    if (isFolderReference(raw)) return;
    const parsed = parseReferenceTarget(raw);
    if (!parsed || parsed.kind === "invalid") { showNotice("That link could not be opened."); return; }
    if (parsed.kind === "web") { openExternal(parsed.url); return; }
    if (parsed.kind === "unsupported") { showNotice("Only web addresses and files in this workspace can be opened from a reply."); return; }
    const resolved = resolveWorkspaceCandidates(parsed.path);
    if (resolved.kind === "exact") { await openWorkspaceFile(resolved.folder, resolved.relative, parsed.line, parsed.endLine, resolved.fallbackRelative); return; }
    if (resolved.kind === "probe") { await probeWorkspaceFiles(resolved.folders, resolved.relative, parsed.line, parsed.endLine); return; }
    reportResolutionProblem(resolved);
  }
  function showDiffFallback(folder, result) {
    if (window.relayGit?.showDiff) { window.relayGit.showDiff(folder, result); return; }
    $("diff-title").textContent = result.path;
    $("diff-meta").replaceChildren(`${folder.displayName || folder.name} · Changed`);
    $("diff-content").replaceChildren(element("pre", "diff-lines", result.diff || ""));
    if (!$("diff-dialog").open) $("diff-dialog").showModal();
  }
  async function openActivityFile(file) {
    const resolved = resolveWorkspaceCandidates(file.path);
    if (resolved.kind !== "exact" && resolved.kind !== "probe") { reportResolutionProblem(resolved); return; }
    const projectId = state.projectId, folders = resolved.kind === "exact" ? [resolved.folder] : resolved.folders, relative = resolved.relative;
    const diffs = await Promise.all(folders.map(async folder => {
      try { return { folder, result: await api(`/api/git/diff?folderId=${encodeURIComponent(folder.id)}&path=${encodeURIComponent(relative)}`, {}, projectId) }; }
      catch (error) { return { folder, error }; }
    }));
    if (projectId !== state.projectId) return;
    const found = diffs.filter(item => item.result);
    if (found.length > 1) {
      const actions = found.map(item => ({
        label: item.folder.displayName || item.folder.name,
        run: () => showDiffFallback(item.folder, item.result)
      }));
      showNotice(`${relative} has uncommitted changes in ${found.length} workspace folders. Show the changes from:`, null, "Retry", actions);
      return;
    }
    if (found.length === 1) { showDiffFallback(found[0].folder, found[0].result); return; }
    if (file.change === "delete") { showNotice(`${relative} was deleted and has no current uncommitted changes.`); return; }
    if (resolved.kind === "exact") await openWorkspaceFile(resolved.folder, relative, null, null, resolved.fallbackRelative);
    else await probeWorkspaceFiles(folders, relative, null, null);
  }
  function splitPlainUrl(raw) {
    let url = raw, trailing = "";
    while (url.length) {
      const last = url.at(-1);
      if (/[.,;:!?'"`]/.test(last)) { trailing = last + trailing; url = url.slice(0, -1); continue; }
      if (last === ")" && (url.match(/\(/g)?.length || 0) < (url.match(/\)/g)?.length || 0)) { trailing = last + trailing; url = url.slice(0, -1); continue; }
      if (last === "]" && (url.match(/\[/g)?.length || 0) < (url.match(/\]/g)?.length || 0)) { trailing = last + trailing; url = url.slice(0, -1); continue; }
      break;
    }
    return { url, trailing };
  }
  function renderLink(parent, label, target) {
    const clean = String(target || "").trim();
    let web = false;
    try { web = ["http:", "https:"].includes(new URL(clean).protocol); } catch { /* A relative path. */ }
    if (!web && isFolderReference(clean)) {
      const host = element("span");
      host.title = clean;
      renderInline(host, label, true);
      parent.append(host);
      return;
    }
    const host = web ? element("a", "message-link") : element("span", "message-link message-file-link");
    host.title = clean;
    if (web) { host.href = clean; host.rel = "noopener noreferrer"; host.addEventListener("click", event => { event.preventDefault(); openExternal(clean); }); }
    else activate(host, () => openReference(clean));
    renderInline(host, label, true);
    parent.append(host);
  }
  function renderInline(parent, text, inLink = false) {
    let last = 0;
    for (const match of text.matchAll(/\[([^\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w/])(https?:\/\/[^\s<>"]+)/g)) {
      if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
      if (match[1] !== undefined) renderLink(parent, match[1], match[2]);
      else if (match[3] !== undefined) {
        const code = element("code", "", match[3]);
        if (!inLink && isFileReference(match[3]) && !isFolderReference(match[3])) { code.classList.add("message-file-link"); code.title = match[3]; activate(code, () => openReference(match[3])); }
        parent.append(code);
      } else if (match[4] !== undefined) { const strong = element("strong"); renderInline(strong, match[4], inLink); parent.append(strong); }
      else if (match[5] !== undefined) {
        if (inLink) parent.append(document.createTextNode(match[5]));
        else {
          const { url, trailing } = splitPlainUrl(match[5]);
          if (url) renderLink(parent, url, url);
          if (trailing) parent.append(document.createTextNode(trailing));
        }
      }
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
  // A long path outside the workspace, such as an agent's own temporary files, keeps only its last folder and its
  // name after "…/", so the name is never cut off; steps show the full path when you point at it.
  function displayPath(value) {
    const text = String(value || ""), folders = currentProject()?.folders || [];
    for (const folder of folders) {
      if (folder.path && text === folder.path) return folders.length > 1 ? folder.name : "";
      if (folder.path && text.startsWith(folder.path + "/")) return (folders.length > 1 ? folder.name + "/" : "") + text.slice(folder.path.length + 1);
    }
    const separator = text.includes("\\") ? "\\" : "/", parts = text.split(separator);
    if (!(text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text)) || parts.length <= 4) return text;
    const tail = parts.slice(-2).join(separator);
    return "…" + separator + (tail.length <= 48 ? tail : parts.at(-1));
  }
  // Lines in a text, and lines removed and added between two texts after the lines they share at either end.
  function lineTotal(text) { const value = String(text ?? ""); return value ? value.split("\n").length - (value.endsWith("\n") ? 1 : 0) : 0; }
  function lineCounts(before = "", after = "") {
    const split = text => (text = String(text ?? "")) ? text.split("\n") : [], a = split(before), b = split(after);
    let start = 0, end = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const x = a.slice(start, a.length - end), y = b.slice(start, b.length - end);
    // The lines both keep in the middle, in order, when comparing them line by line stays quick.
    let common = 0;
    if (x.length && y.length && x.length * y.length <= 1000000) {
      let previous = new Uint32Array(y.length + 1);
      for (let i = 1; i <= x.length; i++) { const row = new Uint32Array(y.length + 1); for (let j = 1; j <= y.length; j++) row[j] = x[i - 1] === y[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1]); previous = row; }
      common = previous[y.length];
    }
    return { added: y.length - common, removed: x.length - common };
  }
  // An edit as kept, removed and added lines. Long stretches of kept lines fold to a count; a very large edit is
  // shown as its old lines then its new ones.
  function lineDiff(before = "", after = "") {
    const split = text => (text = String(text ?? "")) ? text.split("\n") : [], a = split(before), b = split(after);
    if (a.length * b.length > 1000000) return [...a.map(text => "- " + text), ...b.map(text => "+ " + text)];
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1)), rows = [];
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) { if (a[i] === b[j]) { rows.push("  " + a[i]); i++; j++; } else if (table[i + 1][j] >= table[i][j + 1]) rows.push("- " + a[i++]); else rows.push("+ " + b[j++]); }
    while (i < a.length) rows.push("- " + a[i++]);
    while (j < b.length) rows.push("+ " + b[j++]);
    const shown = [];
    for (let start = 0; start < rows.length;) {
      let end = start; while (end < rows.length && rows[end].startsWith("  ")) end++;
      if (end - start > 5) shown.push(...rows.slice(start, start + 2), `⋯ ${end - start - 4} unchanged lines`, ...rows.slice(end - 2, end));
      else shown.push(...rows.slice(start, end));
      if (end === start) shown.push(rows[end++]);
      start = end;
    }
    return shown;
  }
  // Added and removed lines in a diff; a new or deleted file may come as its plain contents.
  function diffCounts(diff, change) {
    const rows = String(diff ?? "").split("\n");
    if (!diff) return null;
    if (!rows.some(row => row.startsWith("@@"))) return change === "add" ? { added: lineTotal(diff), removed: 0 } : change === "delete" ? { added: 0, removed: lineTotal(diff) } : null;
    return { added: rows.filter(row => row.startsWith("+") && !row.startsWith("+++")).length, removed: rows.filter(row => row.startsWith("-") && !row.startsWith("---")).length };
  }
  function changeOf(file) {
    const kind = String(typeof file?.kind === "string" ? file.kind : file?.kind?.type || "").toLowerCase();
    return ["add", "added", "create", "created"].includes(kind) ? "add" : ["delete", "deleted", "remove", "removed"].includes(kind) ? "delete" : "update";
  }
  // One step of a run, shown as a timeline row: a short verb, what it acted on, and the full text behind a chevron.
  // A shell wrapper adds little to the summary. Only remove its outer presentation; the exact command remains in
  // the saved entry, expanded output and Copy. No shell text is evaluated or unescaped here.
  const displayCommand = command => command.match(/^(?:\/[\w./-]+\/)?(?:bash|zsh|sh)\s+(?:-(?:lc|cl|c)|-l\s+-c)\s+(['"])(.*)\1$/)?.[2] || command;
  function parseActivity(raw) {
    const text = String(raw || "").trim(), first = text.split("\n")[0];
    if (text.startsWith("$ ")) {
      const newline = text.indexOf("\n"), cmd = (newline === -1 ? text.slice(2) : text.slice(2, newline)).trim();
      return { kind: "command", icon: "command", verb: "Run", detail: displayCommand(cmd), mono: true, cmd, output: text, raw: text };
    }
    // A check with the workspace's tests after a routed run (#12): running, then how it ended, with its output.
    const check = text.match(/^Tests (running|passed|failed|timed out|stopped|skipped|interrupted|deferred): ([^\n]*)(?:\n([\s\S]*))?$/);
    if (check) {
      const [, outcome, command, rest = ""] = check, failed = ["failed", "timed out"].includes(outcome);
      const verb = { running: "Running the tests", passed: "Tests passed", failed: "Tests failed", "timed out": "Tests didn’t finish", stopped: "Tests stopped", skipped: "Tests skipped", interrupted: "Tests interrupted", deferred: "Automatic tests deferred" }[outcome];
      return { kind: "check", icon: outcome === "running" ? "tests-running" : outcome === "passed" ? "tests-passed" : failed ? "tests-failed" : "general", verb, detail: command, mono: true, output: rest.trim(), error: failed, raw: text };
    }
    if (text.startsWith("File changes:")) {
      let changes = [];
      try { changes = JSON.parse(text.slice("File changes:".length)); } catch {}
      // Codex says a file was added, deleted or updated, as a word or as { type }; older records may carry its diff.
      const files = (Array.isArray(changes) ? changes : []).map(file => {
        const change = changeOf(file), counts = Number.isInteger(file?.added) || Number.isInteger(file?.removed) ? { added: file.added || 0, removed: file.removed || 0 } : typeof file?.diff === "string" ? diffCounts(file.diff, change) : null;
        return { path: String(file?.path || file?.file || ""), change, ...(counts || {}) };
      }).filter(file => file.path);
      const paths = files.map(file => file.path), kinds = new Set(files.map(file => file.change)), tone = kinds.size === 1 ? [...kinds][0] : "update";
      const [verb, icon] = { add: ["Create", "create"], delete: ["Delete", "delete"], update: ["Edit", "edit"] }[tone];
      // The row lists up to six files; its details hold the full list only when some are left out.
      const list = paths.map(displayPath).join("\n");
      return { kind: "file", icon, verb, detail: paths.map(displayPath).join(", ") || "files", files, paths, output: paths.length > 6 ? list : "", copy: list, raw: text };
    }
    // A Claude tool: its name, its input as one line of JSON, then its result once it arrives. A line an earlier
    // version cut short still says which tool it was and what it acted on.
    const tool = text.match(/^([A-Za-z_][\w-]*)\n(\{.*\})(?:\n([\s\S]*))?$/), partial = !tool && text.match(/^([A-Za-z_][\w-]*)\n(\{"[^\n]*)/);
    if (tool || partial) {
      const name = (tool || partial)[1], result = tool ? (tool[3] || "").trim() : "";
      let input = {};
      if (tool) { try { input = JSON.parse(tool[2]); } catch {} }
      else for (const key of ["file_path", "notebook_path", "path", "command", "description", "pattern", "url", "query"]) {
        const found = partial[2].match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
        if (found) try { input[key] = JSON.parse(`"${found[1]}"`); } catch { /* Left out. */ }
      }
      const path = input.file_path || input.notebook_path || input.path || "", file = displayPath(path);
      const step = (icon, verb, detail, output = result, mono = false) => ({ kind: "tool", icon, verb, detail, mono, output, toolName: name, input, raw: text });
      if (["Read", "read_file"].includes(name)) return { ...step("read", "Read", file), title: path };
      if (["Edit", "MultiEdit", "edit_file", "NotebookEdit"].includes(name)) {
        const edits = (Array.isArray(input.edits) ? input.edits : [input]).filter(edit => typeof edit.old_string === "string" || typeof edit.new_string === "string");
        const diff = edits.map(edit => lineDiff(edit.old_string, edit.new_string).join("\n")).join("\n\n");
        const counts = input.lineCounts || (edits.length ? edits.reduce((sum, edit) => { const count = lineCounts(edit.old_string, edit.new_string); return { added: sum.added + count.added, removed: sum.removed + count.removed }; }, { added: 0, removed: 0 }) : null);
        return { ...step("edit", "Edit", file, diff || result), diff: Boolean(diff), files: path ? [{ path, change: "update", ...(counts || {}) }] : [] };
      }
      if (["Write", "write_file"].includes(name)) {
        // The tool's result says whether the file was new or written over.
        const created = /\bcreated\b/i.test(result), counts = input.lineCounts || (typeof input.content === "string" && !partial ? { added: lineTotal(input.content) } : null);
        return { ...step(created ? "create" : "edit", created ? "Create" : "Write", file, typeof input.content === "string" ? input.content : result), files: path ? [{ path, change: created ? "add" : "update", ...(counts || {}) }] : [] };
      }
      if (name === "Glob") return step("search", "Find", input.pattern || "", result, true);
      if (["Grep", "search_files"].includes(name)) return step("search", "Search", [input.pattern, input.path && displayPath(input.path) ? "in " + displayPath(input.path) : ""].filter(Boolean).join(" "), result, true);
      if (name === "Bash") return { ...step("command", "Run", input.description || displayCommand(input.command || ""), [input.command ? "$ " + input.command : "", result].filter(Boolean).join("\n"), !input.description), cmd: input.command || "" };
      if (name === "WebFetch") return step("web", "Fetch", input.url || "");
      if (name === "WebSearch" || name === "search_web") return step("web", "Search the web", input.query || "");
      if (["Task", "Agent"].includes(name)) return step("agent", "Agent", input.description || "");
      if (name === "TodoWrite") return { kind: "tool", skip: true, raw: text };
      // Claude asking you to choose: its questions, which you answer in the card where approvals wait.
      if (name === "AskUserQuestion") {
        const questions = Array.isArray(input.questions) ? input.questions : [], asked = questions.map(question => String(question?.question || "").trim()).filter(Boolean);
        return step("question", asked.length > 1 ? `Asked ${asked.length} questions` : "Asked", asked.length === 1 ? asked[0] : questions.map(question => question?.header).filter(Boolean).join(" · "), asked.join("\n"));
      }
      const summary = Object.values(input).find(value => typeof value === "string" && value.trim()) || "";
      return step("tool", name, summary.split("\n")[0].slice(0, 200), result || (Object.keys(input).length ? JSON.stringify(input, null, 2) : ""));
    }
    const remote = text.match(/^(mcp_tool_call|web_search): ?(.*)(?:\n([\s\S]*))?$/);
    if (remote) return { kind: "tool", icon: remote[1] === "web_search" ? "web" : "tool", verb: remote[1] === "web_search" ? "Search the web" : "Tool", detail: remote[2], output: (remote[3] || "").replace(/^(?:""|\[\])$/, "").trim(), raw: text };
    // Full auto-approval allows every request, so its notes add nothing to the timeline.
    if (/^Tool .* auto-approved by policy\.?$/.test(text)) return { kind: "approval", skip: true, raw: text };
    // Codex asks only for what its sandbox blocks, so what Full auto-approval allowed for it stays in the timeline.
    const automatic = text.match(/^Auto-approved: ([\s\S]*)$/);
    if (automatic) return { kind: "approval", icon: "approval", verb: "Auto-approved", detail: automatic[1].split("\n")[0], mono: true, output: "", raw: text };
    const usedSkill = text.match(/^Using skill ([\w-]+): ([\s\S]*)$/);
    if (usedSkill) return { kind: "tool", icon: "tool", verb: "Using skill", detail: `${usedSkill[1]} (${usedSkill[2].split("\n")[0]})`, output: "", raw: text };
    const blocked = text.match(/^Blocked by Read only: ([\s\S]*)$/);
    if (blocked) return { kind: "approval", icon: "denied", verb: "Blocked by Read only", detail: blocked[1].charAt(0).toUpperCase() + blocked[1].slice(1), output: "", raw: text };
    // Remembered approvals say which rule allowed the action.
    const rule = text.match(/^Allowed (by your rule for this workspace|by your rule for this run|for this run|and remembered for this workspace): ([\s\S]*)$/);
    if (rule) return { kind: "approval", icon: "approval", verb: rule[1].startsWith("by your rule") ? "Allowed by your rule" : rule[1] === "for this run" ? "Allowed for this run" : "Allowed and remembered", detail: rule[2].split("\n")[0], mono: true, output: "", raw: text };
    if (/^Approval allowed/.test(text)) return { kind: "approval", icon: "approval", verb: "You allowed the request", detail: "", output: "", raw: text };
    if (/^Approval denied/.test(text)) return { kind: "approval", icon: "denied", verb: "You denied the request", detail: "", output: "", error: true, raw: text };
    // Your answers to an agent's questions, one line each as "question → answer", or that you skipped them.
    const answered = text.match(/^Answered:\n([\s\S]+)$/);
    if (answered) { const lines = answered[1].split("\n"); return { kind: "question", icon: "question", verb: "You answered", detail: lines.map(line => line.slice(line.lastIndexOf(" → ") + 3)).join(" · "), output: lines.length > 1 || lines[0].length > 120 ? lines.join("\n") : "", raw: text }; }
    const skipped = text.match(/^Skipped (the question|\d+ questions);/);
    if (skipped) return { kind: "question", icon: "question", verb: `You skipped ${skipped[1]}`, detail: "The agent decides", output: "", raw: text };
    if (/diagnostic/i.test(first)) return { kind: "error", icon: "error", verb: "Error", detail: first.replace(/^\w+ diagnostic:\s*/i, "").slice(0, 200), output: text, error: true, raw: text };
    return { kind: "general", icon: "general", verb: first.slice(0, 200), detail: "", output: text.includes("\n") ? text : "", raw: text };
  }

  // Each kind of step has its colour: reading and searching, running, changing, adding and removing files, the web,
  // and other agents. Approvals, errors and tests keep their own.
  // The moment an agent reaches its usage limit reads as one (#96): what happened, large and struck through under the seal,
  // then what happens next. It only plays once; a redraw or a restart shows it settled.
  const stampedLimits = new Set();
  function limitMoment(message) {
    if (!["error", "system"].includes(message.role)) return null;
    const system = message.role === "system" ? message.text?.match(/^(Codex|Claude|Gemini) reached its usage limit(.*)$/s) : null;
    const run = message.role === "error" && message.runId ? state.conversation?.runs?.find(item => item.id === message.runId) : null;
    if (!system && run?.errorCategory !== "quota") return null;
    // An agent can say it more than once in a run; the moment is the first, and the rest read as ordinary errors.
    if (!system && state.conversation.messages.find(item => item.role === "error" && item.runId === message.runId)?.id !== message.id) return null;
    const who = system ? system[1] : label(run.provider), rest = system ? system[2].replace(/^,\s*/, "").replace(/^which resets/, "resets").replace(/^(?:so|and)\s+/, "").replace(/^(.)/, first => first.toUpperCase()) : message.text || "";
    const node = element("div", "limit-moment"), line = element("p", "limit-moment-line");
    line.append(element("span", "limit-moment-text", `${who} reached its usage limit`));
    const seal = element("span", "limit-moment-seal"); seal.setAttribute("aria-hidden", "true"); line.append(seal);
    node.append(line); if (rest) node.append(element("p", "limit-moment-next", rest));
    node.setAttribute("role", "note");
    if (message.id) node.id = "message-" + message.id;
    const fresh = Date.now() - Date.parse(message.createdAt || 0) < 8000;
    if (fresh && !stampedLimits.has(message.id)) node.classList.add("stamping");
    stampedLimits.add(message.id);
    return node;
  }

  const STEP_TONES = { read: "read", search: "read", command: "run", edit: "edit", create: "add", delete: "delete", web: "web", agent: "agent" };
  const CHANGES = { add: "Added", delete: "Deleted", update: "Changed" };
  // The files a step changed, one per line: the folder, the file's name, then its added and removed lines when known.
  // Whether a file is new or deleted shows in its colour, and is said in words for screen readers.
  function fileList(files) {
    const list = element("span", "activity-entry-detail activity-files");
    files.slice(0, 6).forEach(file => {
      const row = element("span", "activity-file-row"), path = displayPath(file.path) || file.path, split = path.lastIndexOf("/");
      const name = element("span", "activity-file");
      if (split >= 0) name.append(element("span", "activity-file-directory", path.slice(0, split + 1)));
      name.append(element("span", "activity-file-name", path.slice(split + 1)));
      name.dataset.change = file.change; name.title = `${CHANGES[file.change] || "Changed"}: ${file.path}`;
      if (!isFolderReference(file.path)) activate(name, () => openActivityFile(file));
      row.append(name);
      if (file.change !== "update") row.append(element("span", "sr-only", `(${(CHANGES[file.change] || "Changed").toLowerCase()})`));
      if (file.added > 0 || file.removed > 0) {
        const counts = element("span", "activity-file-counts");
        if (file.added > 0) counts.append(element("span", "line-count added", `+${file.added}`));
        if (file.removed > 0) counts.append(element("span", "line-count removed", `−${file.removed}`));
        row.append(counts);
      }
      list.append(row);
    });
    if (files.length > 6) list.append(element("span", "activity-file-row activity-files-more", `and ${files.length - 6} more`));
    return list;
  }
  // A timeline row: its node on the run's line, the step's first line, and its full text behind the chevron.
  function renderStep(step, entryId, openOutputs) {
    const open = openOutputs.has(entryId), more = Boolean(step.output);
    const entry = element("div", `activity-entry activity-entry-${step.kind}${step.error ? " activity-entry-error" : ""}${open ? " open" : ""}`);
    if (step.files?.length > 1) entry.classList.add("activity-entry-files");
    entry.setAttribute("data-entry-id", entryId);
    entry.dataset.entryId = entryId;
    if (STEP_TONES[step.icon]) entry.dataset.tone = STEP_TONES[step.icon];
    const node = element("span", "timeline-node");
    node.setAttribute("aria-hidden", "true");
    node.append(element("span", `activity-icon icon-${step.icon || step.kind}`));
    const head = element("div", "activity-entry-header");
    // A step with more to show is a button; one that is only its line stays text, which keeps it searchable.
    const toggle = element(more ? "button" : "div", "activity-output-toggle");
    toggle.append(element("span", "activity-entry-title", step.verb));
    if (step.files?.length) toggle.append(fileList(step.files));
    else if (step.detail) { const detail = element(step.mono ? "code" : "span", "activity-entry-detail", step.detail); detail.title = step.cmd || step.title || step.detail; toggle.append(detail); }
    if (more) toggle.append(element("span", "disclosure-chevron"));
    head.append(toggle, copyButton("activity-copy", "Copy", step.output || step.copy || step.raw));
    if (step.message?.id && step.kind !== "approval") {
      const remember = element("button", "activity-remember", "Remember"); remember.type = "button"; remember.title = "Keep this for every agent in this workspace";
      remember.addEventListener("click", () => window.relayMemory?.remember({ text: step.detail || step.verb || step.raw || "", messageId: step.message.id, runId: step.message.runId || null, host: entry }));
      head.append(remember);
    }
    entry.append(node, head);
    if (!more) return entry;
    const output = element("pre", "activity-output", step.diff ? undefined : step.output), outputId = "activity-output-" + entryId;
    // An edit shows the lines it removed and added in their colours.
    if (step.diff) step.output.split("\n").forEach((line, index, lines) => output.append(element("span", line.startsWith("+ ") ? "activity-diff added" : line.startsWith("- ") ? "activity-diff removed" : line.startsWith("⋯ ") ? "activity-diff folded" : "activity-diff", index < lines.length - 1 ? line + "\n" : line)));
    output.id = outputId;
    output.setAttribute("data-entry-id", entryId);
    output.dataset.entryId = entryId;
    output.hidden = !open;
    toggle.type = "button";
    toggle.title = open ? "Hide details" : "Show details";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-controls", outputId);
    toggle.addEventListener("click", event => {
      if (event?.target?.closest?.(".activity-file")) return;
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
    const moment = limitMoment(message);
    if (moment) return moment;
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
    if (!user) row.dataset.provider = message.connection === "local" ? "local" : provider;
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
      jumpRun.addEventListener("click", async () => {
        let node = ui.messages.querySelector(`div[data-run-id="${message.runId}"]`);
        if (!node && state.conversation?.earlier > 0) {
          await loadToRun(message.runId);
          node = ui.messages.querySelector(`div[data-run-id="${message.runId}"]`);
        }
        if (!node) return;
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("activity-highlight");
        setTimeout(() => node.classList.remove("activity-highlight"), 2000);
      });
      actions.append(jumpRun);
    }
    if (message.text) actions.append(copyButton("message-copy", "Copy message", message.text));
    if (message.text && message.id) {
      const remember = element("button", "message-action message-remember", "Remember"); remember.type = "button"; remember.title = "Keep this for every agent in this workspace";
      remember.addEventListener("click", () => window.relayMemory?.remember({ text: message.text, messageId: message.id, runId: message.runId || null, host: row }));
      actions.append(remember);
    }
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
    if (user && message.retry) { row.classList.add("message-retry"); row.insertBefore(element("div", "message-retry-label", "Sent by Codeshi after the tests failed"), body); }
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
      const rated = { agent: `Rated by an agent${choice.ratedMs ? ` in ${(choice.ratedMs / 1000).toFixed(1)} s` : ""}`, local: "Continued from the last rating, with no agent call", fallback: "Estimated locally because no agent could rate it in time" }[choice.ratedBy];
      note.title = `${window.relayRouting?.modeNames?.[choice.mode] || "Auto"}: ${choice.reason || ""}${rated ? ` · ${rated}` : ""}`;
      row.append(note);
    }
    row.append(actions);
    return row;
  }
  // The way back to the end also says when a handoff offer is waiting there, out of view.
  function updateJump() { $("jump-latest").hidden = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 240; $("jump-latest-text").textContent = state.conversation?.handoffOffer && isRunning() ? "Handoff offer below" : "Jump to latest"; }
  // Turns out of view have only an estimated height, so the end can move once the last ones are drawn; this stays with it for a few frames.
  let scrollingToLatest = false;
  function scrollToLatest(frames = 8) {
    scrollingToLatest = frames > 0;
    ui.scroll.scrollTop = ui.scroll.scrollHeight; updateJump();
    if (frames > 0) requestAnimationFrame(() => scrollToLatest(frames - 1));
  }
  // Makes parent's children exactly these nodes, touching only what differs, so what stayed keeps its layout and scroll position.
  function syncChildren(parent, nodes) {
    let at = 0;
    while (at < nodes.length && parent.childNodes[at] === nodes[at]) at++;
    if (at === nodes.length && parent.childNodes.length === at) return;
    const wanted = new Set(nodes);
    for (const node of [...parent.childNodes].slice(at)) if (!wanted.has(node)) node.remove();
    for (; at < nodes.length; at++) if (parent.childNodes[at] !== nodes[at]) parent.insertBefore(nodes[at], parent.childNodes[at] || null);
  }
  // What the transcript last drew. A long conversation holds tens of thousands of elements, and rebuilding them for one
  // new line froze the window for half a second, so a turn whose messages kept their objects (see keepMessageObjects)
  // is left alone, and a changed turn replaces only the messages and steps that changed.
  const drawn = { scope: null, base: null, messages: [], turns: new Map(), steps: new WeakMap(), version: 0 };
  const noOpenOutputs = new Set();
  function renderMessages(forceScroll = false) {
    const c = state.conversation, messages = c?.messages || [];
    const folders = state.projects.find(project => project.id === state.projectId)?.folders?.map(folder => folder.path);
    const base = JSON.stringify([c?.reviews?.map(({ id, status, summary }) => [id, status, summary]), c?.status, c?.activeRun?.id, c?.lastRun?.id, c?.pendingApprovals?.map(({ id, runId }) => [id, runId]), c?.checkpoints]);
    const scope = JSON.stringify([state.projectId, c?.id, folders]);
    const noProvider=state.ready&&!messages.length&&!['codex','claude','gemini'].some(available);
    ui.empty.hidden = messages.length > 0 || !state.ready || noProvider || Boolean(state.taskDraft);
    if($('provider-empty-state'))$('provider-empty-state').hidden=!noProvider;
    if (scope === drawn.scope && base === drawn.base && messages.length === drawn.messages.length && messages.every((message, index) => message === drawn.messages[index])) return;
    if (scope !== drawn.scope) { drawn.turns = new Map(); drawn.steps = new WeakMap(); }
    drawn.scope = scope; drawn.base = base; drawn.messages = messages;
    state.messagesSignature = String(++drawn.version);
    const nearBottom = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 110;
    const oldTop = ui.scroll.scrollTop;
    const liveRun = c?.status === "running" ? c.activeRun : null, shownRun = liveRun || c?.lastRun;
    const running = c?.status === "running";
    // Each prompt starts a turn holding everything that answers it, so the prompt can stay at the top while its results scroll.
    // Inside a turn, each run is one thread under the agent's name: its replies and steps sit on one line, in order.
    const starts = [];
    messages.forEach((message, index) => { if (message.role === "user" && !message.steer) starts.push(index); });
    const segments = starts[0] > 0 || (!starts.length && messages.length) ? [{ from: 0, to: starts[0] ?? messages.length, loose: true }] : [];
    starts.forEach((from, index) => segments.push({ from, to: starts[index + 1] ?? messages.length }));
    const lastSegmentOfRun = new Map();
    segments.forEach((segment, index) => { for (let at = segment.from; at < segment.to; at++) if (messages[at].runId) lastSegmentOfRun.set(messages[at].runId, index); });
    // What a message's drawing reads besides the message itself.
    const messageExtra = message => {
      let extra = "";
      if (message.reviewId) { const review = c?.reviews?.find(item => item.id === message.reviewId); extra += JSON.stringify([Boolean(review), review?.summary]); }
      if (message.routing) extra += (window.relayModelPicker?.modelName?.(message.provider, message.routing.model) || "") + (window.relayRouting?.modeNames?.[message.routing.mode] || "");
      if (message.attachments?.length && window.relayFiles) extra += "attachments";
      if (!message.provider) extra += c?.provider || "";
      return extra;
    };
    const rootKids = [], turns = new Map(), footer = $("transcript-footer"), progress = $("run-progress");
    let footerHost = rootKids;
    if (c?.earlier > 0) {
      const banner = element("div", "messages-earlier");
      const button = element("button", "text-link messages-load-earlier", `Load earlier messages (${c.earlier} older)`);
      button.type = "button";
      button.addEventListener("click", () => loadEarlierMessages());
      banner.append(button);
      rootKids.push(banner);
    }
    segments.forEach((segment, segmentIndex) => {
      const last = segmentIndex === segments.length - 1, first = messages[segment.from];
      const turnKey = segment.loose ? "loose" : String(first.id || segment.from), saved = drawn.turns.get(turnKey);
      const runIds = new Set(), extras = [];
      for (let at = segment.from; at < segment.to; at++) { const message = messages[at]; if (message.runId) runIds.add(message.runId); const extra = messageExtra(message); if (extra) extras.push(extra); }
      const rows = [...runIds].filter(id => lastSegmentOfRun.get(id) === segmentIndex && c?.checkpoints?.[id]?.files).map(id => [id, c.checkpoints[id].files, c.checkpoints[id].undone || null]);
      const extra = JSON.stringify([last, extras, rows, rows.length ? [running, c?.activeRun?.id, Boolean(window.relayRewind)] : null, shownRun && runIds.has(shownRun.id) ? [shownRun.id, shownRun.provider, shownRun.effectiveModel, shownRun.model, shownRun.effectiveEffort, shownRun.effort, liveRun?.id] : null]);
      const count = segment.to - segment.from;
      if (saved && !last && !segment.loose && saved.extra === extra && saved.messages.length === count && saved.messages.every((message, index) => message === messages[segment.from + index])) {
        turns.set(turnKey, saved); rootKids.push(saved.node);
        return;
      }
      const oldNodes = saved?.nodes || new Map(), nodes = new Map(), kids = segment.loose ? rootKids : [], threads = [];
      const turnNode = segment.loose ? null : saved?.node || element("section", "turn");
      if (turnNode) rootKids.push(turnNode);
      let thread = null, ordinal = 0;
      const place = node => kids.push(node);
      const messageNode = (message, index) => {
        const key = "message:" + (message.id || index), extra = messageExtra(message), kept = oldNodes.get(key);
        if (kept?.message === message && kept.extra === extra) { nodes.set(key, kept); return kept.node; }
        const node = renderMessage(message);
        nodes.set(key, { message, extra, node });
        return node;
      };
      const stepOf = activity => {
        let step = drawn.steps.get(activity);
        if (!step) { step = { ...parseActivity(activity.text), message: activity }; drawn.steps.set(activity, step); }
        return step;
      };
      const stepNode = (step, entryId) => {
        const key = "step:" + entryId, kept = oldNodes.get(key);
        if (kept?.message === step.message) { nodes.set(key, kept); return kept.node; }
        const node = renderStep(step, entryId, kept?.node.classList.contains("open") ? new Set([entryId]) : noOpenOutputs);
        nodes.set(key, { message: step.message, node });
        return node;
      };
      const openThread = (key, provider, connection, source, forRun = null) => {
        const run = forRun || (key && shownRun?.id === key ? shownRun : null);
        const model = source?.model && source.model !== "unknown" ? source.model : run?.effectiveModel && run.effectiveModel !== "unknown" ? run.effectiveModel : run?.model || "";
        const effort = source?.effort || run?.effectiveEffort || run?.effort || "";
        const details = [model, effort ? effort + " effort" : ""].filter(Boolean).join(" · ");
        const nodeKey = "thread:" + (ordinal++) + ":" + key, headKey = JSON.stringify([provider, connection, details, Boolean(source?.imported)]);
        let parts = oldNodes.get(nodeKey);
        if (!parts) {
          parts = { node: element("div", "run-thread"), body: element("div", "run-thread-body") };
          if (key) { parts.node.setAttribute("data-run-id", key); parts.node.dataset.runId = key; }
        }
        if (parts.headKey !== headKey) {
          const heading = element("div", "message-heading run-thread-heading");
          const avatar = element("span", `message-avatar ${connection === "local" ? "local" : provider}`);
          avatar.setAttribute("aria-hidden", "true");
          heading.append(avatar, element("span", "message-author", connection === "local" ? "Local · Ollama" : label(provider)));
          if (details) heading.append(element("span", "message-model", details));
          if (source?.imported) heading.append(element("span", "message-label", "Imported"));
          parts.heading = heading; parts.headKey = headKey;
        }
        nodes.set(nodeKey, parts);
        thread = { key, provider, connection, node: parts.node, body: parts.body, heading: parts.heading, kids: [] };
        threads.push(thread);
        place(thread.node);
        return thread;
      };
      // The thread for a message of this run, continuing the open one when it is the same run and agent.
      const threadFor = (message, index) => {
        const key = message.runId || "", provider = message.provider || c?.provider || "codex";
        if (thread && thread.key === key && (key || thread.provider === provider)) return thread;
        let source = null;
        for (let at = index; at < messages.length && !source; at++) { const item = messages[at]; if (item.role === "assistant" && (item.runId || "") === key && (key || item === message)) source = item; }
        return openThread(key, source?.provider || provider, source?.connection || message.connection, source);
      };
      for (let index = segment.from; index < segment.to; index++) {
        const message = messages[index];
        if (message.role === "user" && !message.steer) {
          thread = null;
          place(messageNode(message, index));
          continue;
        }
        if (message.role !== "activity") {
          const row = messageNode(message, index);
          // Replies, errors and notes added while the agent worked belong to their run's thread.
          const inRun = message.role === "assistant" || (message.runId && (message.role === "error" || message.steer || thread?.key === message.runId));
          if (inRun) threadFor(message, index).kids.push(row); else { thread = null; place(row); }
          continue;
        }
        const activities = [message];
        while (messages[index + 1]?.role === "activity" && (messages[index + 1].runId || "") === (message.runId || "")) activities.push(messages[++index]);
        const steps = activities.map(stepOf).filter(step => !step.skip);
        if (!steps.length) continue;
        const host = threadFor(message, index - activities.length + 1);
        const groupKey = String(message.id || `${message.runId || "run"}-${index - activities.length + 1}`);
        // Every step shows; only a very long stretch keeps its earlier steps behind one row.
        if (steps.length > 12) {
          const earlier = steps.slice(0, -6), key = "earlier:" + groupKey;
          let group = oldNodes.get(key);
          if (!group) {
            const disclosure = element("details", "activity-earlier"), summary = element("summary", "activity-earlier-toggle"), node = element("span", "timeline-node"), text = element("span", "");
            disclosure.setAttribute("data-group", `${groupKey}-earlier`);
            disclosure.dataset.group = `${groupKey}-earlier`;
            node.setAttribute("aria-hidden", "true"); node.append(element("span", "activity-icon icon-more"));
            summary.append(node, text);
            group = { disclosure, summary, text };
          }
          nodes.set(key, group);
          group.text.textContent = `${earlier.length} earlier steps`;
          syncChildren(group.disclosure, [group.summary, ...earlier.map((step, idx) => stepNode(step, step.message.id || `${groupKey}-${idx}`))]);
          host.kids.push(group.disclosure);
          steps.slice(-6).forEach((step, idx) => host.kids.push(stepNode(step, step.message.id || `${groupKey}-${idx + earlier.length}`)));
        } else steps.forEach((step, idx) => host.kids.push(stepNode(step, step.message.id || `${groupKey}-${idx}`)));
      }
      if (last) {
        // The run's status line is the last step of its thread, so the live run has one indicator, where its work is.
        let host = null;
        if (shownRun) {
          host = threads.findLast(item => shownRun.id && item.key === shownRun.id) || null;
          if (!host && liveRun) host = thread && !shownRun.id ? thread : openThread(shownRun.id || "", shownRun.provider || c?.provider || "codex", shownRun.connection, null, shownRun);
        }
        if (host) host.kids.push(progress); else if (footer.firstElementChild !== progress) footer.prepend(progress);
      }
      // A run that changed files ends with its checkpoint line, after its status line (#20).
      for (const item of new Map(threads.filter(entry => entry.key && lastSegmentOfRun.get(entry.key) === segmentIndex).map(entry => [entry.key, entry])).values()) {
        const key = "rewind:" + item.key, checkpoint = c?.checkpoints?.[item.key], inputs = JSON.stringify([checkpoint?.files, checkpoint?.undone, running, c?.activeRun?.id, Boolean(window.relayRewind)]), kept = oldNodes.get(key);
        const line = kept?.inputs === inputs ? kept.line : window.relayRewind?.row(item.key);
        nodes.set(key, { inputs, line });
        if (line) item.kids.push(line);
      }
      for (const item of threads) { syncChildren(item.body, item.kids); syncChildren(item.node, [item.heading, item.body]); }
      if (last) footerHost = kids;
      turns.set(turnKey, { node: turnNode, extra, nodes, messages: messages.slice(segment.from, segment.to), kids });
    });
    // With no turns, as in a blank task, nothing else brings the run line back, and it would leave the page with the last turn.
    if (!segments.length && footer.firstElementChild !== progress) footer.prepend(progress);
    footerHost.push(footer);
    for (const entry of turns.values()) if (entry.node) syncChildren(entry.node, entry.kids);
    drawn.turns = turns;
    syncChildren(ui.messages, rootKids);
    if (forceScroll) scrollToLatest();
    else if (nearBottom) { ui.scroll.scrollTop = ui.scroll.scrollHeight; updateJump(); requestAnimationFrame(() => { ui.scroll.scrollTop = ui.scroll.scrollHeight; updateJump(); }); }
    else { ui.scroll.scrollTop = oldTop; updateJump(); }
  }

  // Agents a wait can continue with: the one that stopped and the one selected first, then any other connected agent.
  function resumeProviders() {
    const connected = ["codex", "claude", "gemini"].filter(provider => available(provider) && !connection(provider).blocked);
    const policy = state.conversation?.execution?.active;
    if (policy && !policy.automation?.wait) return connected.filter(provider => provider === state.conversation?.lastRun?.provider);
    return [...new Set([state.conversation?.lastRun?.provider, state.provider, ...connected])].filter(provider => connected.includes(provider));
  }
  function resumeText(resume) {
    const time = iso => { const date = new Date(iso), today = date.toDateString() === new Date().toDateString(); return date.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" }); };
    const agents = resume.providers.map(provider => {
      const status = resume.agents?.[provider];
      return label(provider) + (status?.quota === 'unknown' || status?.quota === 'stale' ? " (waiting for fresh usage)" : status?.limited === false ? " (ready)" : status?.resetsAt ? ` (resets ${time(status.resetsAt)})` : status ? " (checking every 10 min)" : "");
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
  // Only runtimes that report no additional-folder support need the one-folder task fallback (#116).
  function oneFolderOnly(provider) { const account = state.accounts[provider]; return provider === "gemini" && (account?.authMode === "google-oauth" || account?.source === "antigravity-acp") && account?.capabilities?.additionalDirectories === false; }
  function askFolder(submission) { state.folderAsk = { ...submission, projectId: state.projectId }; renderFolderAsk(); $("folder-ask-choices").querySelector?.("button")?.focus?.(); }
  function clearFolderAsk() { if (!state.folderAsk) return; state.folderAsk = null; renderFolderAsk(); }
  function renderFolderAsk() {
    const host = $("folder-ask"), choices = $("folder-ask-choices"); if (!host || !choices) return;
    const ask = state.folderAsk && state.folderAsk.projectId === state.projectId && !state.taskId && !state.taskDraft ? state.folderAsk : null;
    if (!ask) { host.hidden = true; choices.replaceChildren(); return; }
    $("folder-ask-text").textContent = `${label(ask.provider)} works in one folder at a time on this connection. Run this as a task in:`;
    choices.replaceChildren(...foldersFor(currentProject()).filter(folder => folder.available !== false).map(folder => {
      const choice = element("button", "pill-button", folder.displayName || folder.name); choice.type = "button"; choice.dataset.folder = folder.id;
      choice.addEventListener("click", () => startFolderTask(folder.id)); return choice;
    }));
    const cancel = element("button", "pill-button", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", () => { clearFolderAsk(); ui.input.focus(); });
    choices.append(cancel);
    host.hidden = false;
  }
  async function startFolderTask(folderId) {
    const ask = state.folderAsk; if (!ask || state.pending) return;
    clearFolderAsk();
    const projectId = state.projectId;
    state.pending = "send"; render(); hideNotice();
    try {
      const task = await post("/api/tasks", { text: ask.text, attachments: ask.attachments, provider: ask.provider, model: ask.model || null, effort: ask.effort || null, mode: ask.mode, approvalPolicy: ask.approvalPolicy, requestId: ask.requestId, billingConfirmed: window.relayBillingConfirmed === true, folderId }, projectId);
      state.retrySubmission = null;
      window.relayFiles?.accepted(projectId, ask.attachments);
      if (ui.input.value === ask.originalDraft) { ui.input.value = ""; storedWrite(draftKey(), ""); storedWrite(draftKey(null), ""); resizeInput(); }
      if (window.relayTaskThreads?.started) await window.relayTaskThreads.started(task); else await refresh();
      announce(`The task in ${task.folderName} has started.`);
    } catch (error) { showNotice(error.message); await refresh(); }
    finally { state.pending = null; render(); ui.input.focus(); }
  }
  // A queued prompt can start now as a task beside this conversation (#108): it leaves the queue and runs in a folder of its own,
  // with the settings it was queued with. The folder is the one selected; with several and none selected, the row asks.
  async function queueAsTask(item, folderId) {
    if (!folderId) { state.queueTasking = item.id; renderQueue(); return; }
    state.queueTasking = null;
    try {
      const task = await post("/api/tasks/from-queue", { id: item.id, folderId });
      await refresh();
      announce(`“${task.title}” is now a task in ${task.folderName}.`);
    } catch (error) { showNotice(error.message); await refresh(); }
  }
  async function queuePrompt() {
    if (ui.input.value.trim() === '/compact') { showNotice('Finish or stop the current run or reset wait before compacting context.'); return; }
    const text = ui.input.value.trim(), attachments = window.relayFiles?.ids() || [], projectId = state.projectId, draft = ui.input.value;
    if (!text || state.pending || !state.conversation || $("queue-button").hidden) return;
    try { window.relayAutomaticReview?.submission({}, { queued: true }); }
    catch (error) { showNotice(error.message); return; }
    if (state.localSelections[projectId]) { showNotice("Queue a cloud agent. Local models start from Continue locally."); return; }
    const routed = routeFor(text, attachments.length);
    if (routed?.error) { showNotice(routed.error); return; }
    state.pending = "queue"; renderControls();
    const added = await queueAction({ executionRevision: state.conversation?.execution?.defaults?.revision ?? 0, action: "add", text, provider: routed?.provider || state.provider, model: (routed ? routed.model : state.model) || null, effort: (routed ? routed.effort : state.effort) || null, mode: state.mode, approvalPolicy: state.approvalPolicy || "ask", attachments, billingConfirmed: window.relayBillingConfirmed === true, ...(routed ? { routing: { mode: routed.mode, reason: routed.reason, tier: routed.tier, escalation: routed.escalation || null } } : {}) });
    if (added) {
      window.relayFiles?.accepted(projectId, attachments);
      if (ui.input.value === draft) { ui.input.value = ""; storedWrite(draftKey(), ""); storedWrite(draftKey(null), ""); resizeInput(); }
      announce("Added to the queue.");
    }
    state.pending = null; renderControls();
  }
  // Auto (#12): Codeshi picks the agent, model and effort for each message when it is sent.
  const autoRouting = () => !state.localSelections[state.projectId] && state.conversation?.routing ? state.conversation.routing : null;
  // With a mode given, says what that mode would do with the text before it is chosen (Flow mode, #107).
  function routeFor(text, attachments = 0, mode = null) {
    const routing = autoRouting(); if ((!routing && !mode) || !window.relayRouting) return null;
    const project = state.projects.find(item => item.id === state.projectId);
    const candidates = ["codex", "claude", "gemini"].map(provider => {
      const info = connection(provider);
      const antigravity = info.account?.authMode === "google-oauth" || info.account?.source === "antigravity-acp";
      const folderCount = state.taskId || state.taskDraft ? 1 : foldersFor(project).length;
      const unsupportedRead = state.mode === "read" && (antigravity || info.account?.capabilities?.readOnly === "unavailable");
      const unsupportedFolders = antigravity ? folderCount > 1 && info.account?.capabilities?.additionalDirectories !== true : folderCount > 6;
      const unsupported = provider === "gemini" && (unsupportedRead || unsupportedFolders);
      return { provider, eligible: !info.blocked && info.account?.authenticated !== false && !unsupported && (!state.conversation?.taskPolicy?.allowedProviders || state.conversation.taskPolicy.allowedProviders.includes(provider)), billingSource: info.account?.billingSource || "unknown", usage: window.relayUsage?.snapshot?.(provider), allowedModels: state.conversation?.taskPolicy?.allowedModels?.[provider] || null, models: window.relayModelPicker?.models?.(provider) || [] };
    });
    const previousRequest = state.conversation?.messages?.findLast(message => message.role === 'user' && !message.reviewId && !message.steer)?.text || state.conversation?.context?.goal || '';
    return window.relayRouting.route({ text, attachments, context: previousRequest, mode: mode || routing.mode, allowApi: routing?.allowApi === true, candidates, current: state.conversation?.lastRun?.provider || state.provider });
  }
  async function setRouting(choice) {
    if (!state.conversation) await ensureCanonicalConversation();
    await post(endpoint(state.conversation.id, "routing"), { ...choice, executionRevision: state.conversation?.execution?.defaults?.revision ?? 0 }, state.projectId);
    await refresh();
  }
  // A note added to the working run (#32): the agent takes it into the same task instead of after it.
  async function addToRun() {
    if (ui.input.value.trim() === '/compact') { showNotice('Finish or stop the current run before compacting context.'); return; }
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
  // The agent's plan above the message box: one line with how many steps are done and the current one, which opens
  // into the checklist. The list stays as the reader left it while the run goes on, and starts closed for a new run.
  function renderPlan() {
    // The plan belongs to the task, so it stays while the task can still go on: through a handoff, a wait for a reset, or a stop.
    const c = state.conversation, last = c?.lastRun, running = isRunning(), held = !running && last && last.status !== "complete" && last.plan?.steps?.some(step => step.status !== "done");
    const run = running ? c?.activeRun : held ? last : null, steps = run?.plan?.steps || [], section = $("run-plan");
    section.hidden = !steps.length;
    if (!steps.length) { state.planSignature = state.planScope = null; return; }
    const scope = JSON.stringify([state.projectId, state.conversation.id, run.id]);
    const signature = JSON.stringify([scope, steps, Boolean(held), run.plan.carriedFrom]);
    if (signature === state.planSignature) return;
    const newRun = scope !== state.planScope && !run.plan.carriedFrom;
    state.planSignature = signature; state.planScope = scope;
    const done = steps.filter(step => step.status === "done").length, current = steps.find(step => step.status === "active") || steps.find(step => step.status === "pending");
    const complete = done === steps.length, status = complete ? "Complete" : held ? "Stopped at" : current?.status === "active" ? "In progress" : "Up next";
    section.dataset.complete = String(complete); section.dataset.held = String(Boolean(held));
    const from = run.plan.carriedFrom;
    $("run-plan-from").hidden = !from; $("run-plan-from").textContent = from ? `From ${from.local ? "the local model" : label(from.provider)}` : "";
    $("run-plan-ring").style.setProperty("--progress", String(done / steps.length));
    $("run-plan-count").textContent = `${done} of ${steps.length} done`;
    $("run-plan-current").textContent = complete ? "All steps done" : current?.text || "";
    $("run-plan-current").title = current?.text || "All steps done";
    $("run-plan-toggle").setAttribute("aria-label", `Task plan: ${done} of ${steps.length} done. ${status}: ${complete ? "All steps done" : current?.text || ""}. Toggle steps.`);
    $("run-plan-list").replaceChildren(...steps.map(step => {
      const item = element("li", `run-plan-step ${step.status}`), mark = element("span", "run-plan-mark");
      mark.setAttribute("aria-hidden", "true");
      item.append(mark, element("span", "run-plan-text", step.text));
      if (step.status === "active") item.setAttribute("aria-current", "step");
      item.setAttribute("aria-label", `${step.status === "done" ? "Done" : step.status === "active" ? "In progress" : "To do"}: ${step.text}`);
      return item;
    }));
    if (newRun) { $("run-plan-list").hidden = true; $("run-plan-toggle").setAttribute("aria-expanded", "false"); }
  }
  function renderQueue() {
    const c = state.conversation, queue = c?.queue || [], section = $("prompt-queue");
    section.hidden = !queue.length;
    const signature = JSON.stringify([c?.id, queue, c?.queuePaused, state.queueEditing, state.queueTasking, Boolean(state.pending), state.taskId, Boolean(state.taskDraft), selectedFolderId(), sidebarLevelFor()]);
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
      const effort = item.effort ? `${item.effort} effort` : "";
      const reason = item.routing?.reason ? ` · ${item.routing.reason}` : "";
      const meta = `${label(item.provider)}${model ? ` · ${model}` : ""}${effort ? ` · ${effort}` : ""}${reason} · ${item.mode === "read" ? "Read only" : "Can edit files"} · ${item.approvalPolicy === "auto" ? "full auto-approval" : "asks before changes"}${item.attachments?.length ? ` · ${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}` : ""}${item.movedFrom ? ` · Moved from ${label(item.movedFrom)}` : ""}`;
      if (state.queueEditing === item.id) {
        const editor = element("textarea", "prompt-queue-editor"); editor.value = item.text; editor.rows = 3; editor.setAttribute("aria-label", "Edit queued message");
        const controls = element("div", "prompt-queue-edit-controls");
        const modelSelect = element("select", "prompt-queue-select prompt-queue-model"); modelSelect.setAttribute("aria-label", "Model");
        const effortSelect = element("select", "prompt-queue-select prompt-queue-effort"); effortSelect.setAttribute("aria-label", "Reasoning effort");
        const models = window.relayModelPicker?.models?.(item.provider) || []; if (!models.length) window.relayModelPicker?.preload?.()?.then?.(() => { state.queueSignature = null; renderQueue(); });
        const baseOpt = element("option", "", `Let ${label(item.provider)} choose`); baseOpt.value = ""; modelSelect.append(baseOpt);
        for (const row of models.filter(row => row.value !== "default")) {
          const opt = element("option", "", row.displayName || row.name || row.id || row.value);
          opt.value = row.id || row.model || row.value;
          modelSelect.append(opt);
        }
        if (item.model && !models.some(row => (row.id || row.model || row.value) === item.model)) {
          const opt = element("option", "", item.model); opt.value = item.model; modelSelect.append(opt);
        }
        modelSelect.value = item.model || "";
        const updateEffortOptions = () => {
          const chosen = modelSelect.value;
          const selected = models.find(row => (row.id || row.model || row.value) === chosen) || (!chosen && models.find(row => row.isDefault || row.value === "default"));
          const supported = (selected?.supportedEffortLevels || selected?.supportedReasoningEfforts?.map(r => r.reasoningEffort) || []).filter(Boolean);
          effortSelect.replaceChildren();
          const defOpt = element("option", "", selected?.defaultReasoningEffort ? `Default (${selected.defaultReasoningEffort})` : "Provider default"); defOpt.value = "";
          effortSelect.append(defOpt);
          for (const eff of supported) {
            const opt = element("option", "", eff === "xhigh" ? "X-High" : eff[0].toUpperCase() + eff.slice(1));
            opt.value = eff;
            effortSelect.append(opt);
          }
          if (item.effort && !supported.includes(item.effort) && chosen === (item.model || "")) {
            const opt = element("option", "", (item.effort === "xhigh" ? "X-High" : item.effort[0].toUpperCase() + item.effort.slice(1)) + " (saved)");
            opt.value = item.effort;
            effortSelect.append(opt);
          }
          effortSelect.disabled = !supported.length;
          effortSelect.value = supported.includes(item.effort) && chosen === (item.model || "") ? item.effort : (chosen === (item.model || "") && item.effort ? item.effort : "");
        };
        updateEffortOptions();
        modelSelect.addEventListener("change", updateEffortOptions);
        controls.append(modelSelect, effortSelect);
        const save = element("button", "pill-button", "Save"), cancel = element("button", "pill-button", "Cancel"); save.type = cancel.type = "button";
        save.addEventListener("click", async () => {
          const payload = { action: "update", id: item.id, text: editor.value };
          const newModel = modelSelect.value || null;
          const newEffort = effortSelect.value || null;
          if (newModel !== (item.model || null)) payload.model = newModel;
          if (newEffort !== (item.effort || null)) payload.effort = newEffort;
          if (await queueAction(payload)) { state.queueEditing = null; renderQueue(); }
        });
        cancel.addEventListener("click", () => { state.queueEditing = null; renderQueue(); });
        const buttons = element("div", "prompt-queue-edit-actions"); buttons.append(save, cancel);
        body.append(editor, controls, buttons);
      } else body.append(element("p", "prompt-queue-text", item.text), element("span", "prompt-queue-meta", meta));
      // A task's own queue stays a queue: tasks start from the main conversation.
      const folders = state.taskId || state.taskDraft ? [] : foldersFor(currentProject()), folderName = folder => folder.displayName || folder.name;
      const chosen = sidebarLevelFor() === "folder" ? folders.find(folder => folder.id === selectedFolderId()) : folders.length === 1 ? folders[0] : null;
      if (state.queueTasking === item.id && !chosen) {
        const where = element("div", "prompt-queue-edit-actions");
        where.append(element("span", "prompt-queue-meta", "Run as a task in"), ...folders.map(folder => { const choice = element("button", "pill-button", folderName(folder)); choice.type = "button"; choice.addEventListener("click", () => queueAsTask(item, folder.id)); return choice; }));
        const cancel = element("button", "pill-button", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", () => { state.queueTasking = null; renderQueue(); });
        where.append(cancel); body.append(where);
      }
      const actions = element("div", "prompt-queue-actions");
      actions.append(
        icon("up", "Move up", () => queueAction({ action: "move", id: item.id, index: index - 1 }), index === 0),
        icon("down", "Move down", () => queueAction({ action: "move", id: item.id, index: index + 1 }), index === queue.length - 1),
        icon("edit", "Edit", () => { state.queueEditing = item.id; renderQueue(); }),
        ...(folders.length ? [icon("task", chosen ? `Run as a task in ${folderName(chosen)}` : "Run as a task", () => queueAsTask(item, chosen?.id))] : []),
        icon("remove", "Remove from queue", () => queueAction({ action: "remove", id: item.id })));
      row.append(element("span", "prompt-queue-number", String(index + 1)), body, actions);
      return row;
    }));
  }
  // The first run stopped by a usage limit offers to handle the next ones without asking (#91). It's asked once: the
  // offer stays for this stop, and Settings has the switch after that. It only shows where it would apply: automatic
  // handoff goes to subscription-billed agents, and is off along with offers.
  let limitChoice = { run: null, preferences: null, offered: false };
  function renderLimitChoice(quotaStop, previous, target, disabled) {
    const button = $("limit-always");
    if (!quotaStop || !previous?.id) { button.hidden = true; return; }
    if (limitChoice.run !== previous.id) {
      const asking = limitChoice = { run: previous.id, preferences: null, offered: false };
      api("/api/handoff-preferences").then(value => { if (limitChoice === asking) { asking.preferences = value; renderControls(); } }).catch(() => {});
    }
    const { preferences } = limitChoice, destination = connection(target);
    const applies = Boolean(preferences) && preferences.threshold > 0 && !preferences.automatic && target !== previous.provider && !destination.blocked && destination.account?.billingSource === "subscription";
    if (applies && !preferences.limitAsked && !limitChoice.offered) { limitChoice.offered = true; post("/api/handoff-preferences", { limitAsked: true }).catch(() => {}); }
    button.hidden = !applies || !limitChoice.offered;
    button.disabled = disabled;
  }
  // An offer to hand the task to another agent before a usage limit stops the run (#17).
  function renderHandoff() {
    const offer = state.conversation?.handoffOffer, section = $("handoff-offer");
    section.hidden = !offer || !isRunning();
    updateJump();
    if (section.hidden) return;
    const model = offer.to.model ? window.relayModelPicker?.modelName?.(offer.to.provider, offer.to.model) || offer.to.model : "";
    const billing = { subscription: "subscription", api: "API billing" }[offer.to.billingSource] || "unknown billing";
    $("handoff-title").textContent = `${label(offer.from.provider)} has used ${Math.round(offer.from.usedPercent)}% of its ${offer.from.window ? offer.from.window + " " : ""}limit.`;
    $("handoff-detail").textContent = `Hand off to ${label(offer.to.provider)}${model ? ` · ${model}` : ""} (${billing}) to continue${offer.task ? ` “${offer.task.replace(/[.!?]+$/, "")}”` : " this task"}. ${offer.to.mode === "read" ? "Read only" : "Can edit files"} · ${offer.to.approvalPolicy === "auto" ? "full auto-approval" : "asks before changes"}.${offer.to.quota === "unknown" ? " It doesn’t report its usage, so it may be near a limit." : offer.to.quota === "stale" ? " Its usage reading is out of date." : ""}`;
    const charges = offer.to.billingSource !== "subscription";
    $("handoff-billing").hidden = !charges;
    if (charges) $("handoff-billing-text").textContent = offer.to.billingSource === "api" ? `Accept charges: ${label(offer.to.provider)} bills your API account.` : `Accept possible charges: ${label(offer.to.provider)}'s billing could not be confirmed.`;
    // Queued prompts for this agent go along, and the offer says so (#93). Charges for them are their own yes.
    const queued = offer.queue, moving = queued?.count || 0, plural = count => `${count} queued prompt${count === 1 ? "" : "s"}`;
    if (moving) $("handoff-detail").textContent += ` ${plural(moving)} ${moving === 1 ? "moves" : "move"} with it, with the same access.`;
    if (queued?.stays) $("handoff-detail").textContent += ` ${plural(queued.stays)} ${queued.stays === 1 ? "stays" : "stay"} with ${label(offer.from.provider)}, as ${label(offer.to.provider)} can't run ${queued.stays === 1 ? "it" : "them"} with the same access.`;
    $("handoff-queue-billing").hidden = !queued?.billingRequired;
    if (queued?.billingRequired) $("handoff-queue-text").textContent = `Also accept charges for ${plural(moving)}. Without this, ${moving === 1 ? "it stays" : "they stay"} with ${label(offer.from.provider)}.`;
    if (section.dataset.offerId !== offer.id) { section.dataset.offerId = offer.id; $("handoff-billing-confirm").checked = false; $("handoff-queue-confirm").checked = false; }
    $("handoff-accept").disabled = Boolean(state.pending) || charges && !$("handoff-billing-confirm").checked;
    $("handoff-accept").textContent = state.pending === "handoff" ? "Handing off…" : "Hand off";
    $("handoff-dismiss").disabled = Boolean(state.pending);
  }
  // A retry one step up after failed tests, when routing asks first (#12): Saver, or an agent near its limit.
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
    try { await post(endpoint(id, "handoff"), { offerId: offer.id, accept, billingConfirmed: accept && $("handoff-billing-confirm").checked, queueBillingConfirmed: accept && $("handoff-queue-confirm").checked, queueDigest: offer.queue?.digest ?? null }, projectId); }
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

  function compactContextState() {
    const c = state.conversation, context = c?.contextControl;
    const provider = c?.activeRun?.provider || state.provider;
    const target = context?.thresholdTokens, used = context?.used;
    const local = c?.activeRun?.connection === 'local' || !isRunning() && state.localSelections[state.projectId];
    const measured = Number.isFinite(used) && used >= 0;
    const visible = Boolean(c && !state.taskDraft && !local && provider !== 'gemini' && (context?.hasSession || context?.pending || context?.legacy || context?.hasSession !== false && measured));
    const native = isRunning() && c?.activeRun?.phase === 'compacting';
    const due = Boolean(context?.rollover || context?.legacy);
    const near = measured && Number.isFinite(target) && target > 0 && used >= target * .85;
    const kind = native ? 'native' : state.pending === 'compact' ? 'preparing' : context?.pending ? 'ready' : due ? 'due' : near ? 'near' : context && target === null ? 'off' : measured ? 'known' : 'unknown';
    const status = { native: 'Organizing context', preparing: 'Scheduling refresh…', ready: 'Refresh scheduled', due: 'Refresh on next send', near: 'Refresh soon' }[kind] || '';
    const readingLabel = context?.source === 'claude-last-request-input' ? 'Last request input' : context?.source === 'last-request-input-lower-bound' ? 'Last request input (lower bound)' : context?.estimated ? 'Estimated context' : 'Reported context';
    const percent = measured && target > 0 && !['native', 'preparing', 'ready'].includes(kind) ? Math.min(100, Math.floor(100 * used / target)) : null;
    const busy = !state.ready || state.pending || state.loading || state.projectSaving || state.settingsPending || isRunning() || isOtherRunning() || c?.resume || c?.limitSwitching;
    return { context, provider, target, used, visible, kind, status, measured, readingLabel, percent, canRefresh: visible && !busy && !due && !context?.pending };
  }

  function renderContextMeter() {
    const view = compactContextState(), button = $('compact-context'), meter = $('context-meter');
    const { context, provider, target, used, visible, kind, measured, readingLabel, percent } = view;
    button.hidden = !visible;
    button.disabled = !visible || !state.ready || state.loading || state.projectSaving;
    button.dataset.meterState = kind;
    button.dataset.refreshDue = String(['ready', 'due'].includes(kind));
    button.dataset.nearLimit = String(kind === 'near');
    button.setAttribute('aria-busy', String(['preparing', 'native'].includes(kind)));
    const description = view.status || (kind === 'off' ? 'Automatic refresh is off' : kind === 'known' ? 'Current context' : 'Context size unavailable');
    button.title = `Compact context · ${label(provider)} · ${description}. View context and refresh options.`;
    button.setAttribute('aria-label', button.title);
    const dialog = $('compact-confirmation');
    if (!dialog.open) return;
    if (!compactScopeMatches(compactIntent)) {
      $('compact-confirm-description').textContent = 'The chat or agent changed. Close this panel and open context again.';
      $('compact-confirm').disabled = true; return;
    }
    $('compact-confirm-agent').textContent = `${label(provider)} · Agent context`;
    $('compact-confirm-title').textContent = { native: 'Organizing context', preparing: 'Scheduling refresh…', ready: 'Refresh scheduled', due: 'Refresh on next send', near: 'Context is getting longer', off: 'Automatic refresh is off', known: 'Current context', unknown: 'Context size unavailable' }[kind];
    $('compact-context-reading').hidden = !measured || ['native', 'preparing', 'ready'].includes(kind);
    $('compact-reading-label').textContent = readingLabel;
    $('compact-reading-value').textContent = measured ? `${used.toLocaleString()} tokens` : '';
    $('compact-target-line').hidden = !(target > 0);
    $('compact-target-value').textContent = target > 0 ? `${target.toLocaleString()} tokens` : '';
    meter.hidden = percent === null;
    meter.style.setProperty('--context-progress', String(percent ?? 0));
    for (const name of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) meter.removeAttribute(name);
    if (percent !== null) {
      meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100'); meter.setAttribute('aria-valuenow', String(percent));
      meter.setAttribute('aria-valuetext', `${percent}% of the automatic refresh target. ${readingLabel}: ${used.toLocaleString()} tokens. This is not the model’s context capacity.`);
    }
    const next = `Codeshi will refresh ${label(provider)}’s working context with your next message.`;
    const manual = `You can prepare a refresh for your next message to ${label(provider)}.`;
    $('compact-confirm-description').textContent = kind === 'native' ? `${label(provider)} is organizing its working context.`
      : ['ready', 'preparing'].includes(kind) ? next
      : kind === 'due' ? `Codeshi will refresh automatically with your next message to ${label(provider)}.`
      : kind === 'near' ? 'Codeshi handles refresh automatically. You can keep working.'
      : kind === 'known' ? `You can keep working with the current context. ${manual}`
      : kind === 'off' ? `You control when to refresh. ${manual}`
      : `You can keep working. ${manual}`;
    const note = ['ready', 'due', 'preparing'].includes(kind) ? 'No action needed. The refresh takes effect when this agent next receives a message.'
      : isRunning() || isOtherRunning() ? 'Your current run keeps its context. Manual refresh is available when agents finish.'
      : state.conversation?.resume || state.conversation?.limitSwitching ? 'Finish or cancel the reset wait before scheduling a manual refresh.'
      : 'Scheduling a refresh makes no model call. It takes effect on your next send to this agent.';
    $('compact-confirm-note').textContent = note + (autoRouting() ? ` Flow may choose another agent; this refresh applies only to ${label(provider)}.` : '')
      + (context?.cacheWarm && context?.adaptive && !['ready', 'due', 'native'].includes(kind) ? ' Recent activity allows a higher refresh target to keep useful context longer.' : '')
      + (!window.relayFlow?.isOn?.() ? ' Change the refresh limit in Settings → General → Context limit.' : '');
    $('compact-confirm').hidden = ['ready', 'due', 'preparing', 'native'].includes(kind);
    $('compact-confirm').disabled = !view.canRefresh;
    $('compact-cancel').textContent = view.canRefresh ? 'Not now' : 'Close';
  }

  // After a prompt, one short line when that run used a lot or more than usual, and the one thing worth doing about it, if any.
  const tokenCount = value => value >= 1e6 ? `${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(value / 1000)}K`;
  const usageNoticeKey = id => `ai-relay:usage-notice:${id}`;
  function usageNoticeText({ provider, tokens, usual, partial, notice }) {
    const agent = label(provider), size = `${partial ? 'at least ' : ''}${tokenCount(tokens)} tokens`, parts = [];
    const move = notice.moves.find(item => item.near) || notice.moves.toSorted((a, b) => b.points - a.points)[0];
    const limit = move && `${move.label.toLowerCase()} allowance ${move.near ? `reached ${Math.round(move.to)}%` : `went from ${Math.round(move.from)}% to ${Math.round(move.to)}%`}`;
    if (notice.heavy) parts.push(`This run used ${size}, ${usual ? `about ${Math.round(tokens / usual)}× your usual for ${agent}` : 'a lot for one run'}.${limit ? ` ${usual ? 'Its' : `${agent}’s`} ${limit}.` : ''}`);
    else if (limit) parts.push(`${agent}’s ${limit}${move.near ? '' : ' while this ran'}.`);
    const { used, state: context } = notice.context;
    if (context === 'due') parts.push(`${used === null ? 'Context' : `Context reached ${tokenCount(used)} and`} refreshes on your next message to ${agent}.`);
    else if (context === 'scheduled') parts.push(`A context refresh is set for your next message to ${agent}.`);
    else if (context === 'large') parts.push(`Context is ${tokenCount(used)}, and each step re-reads it.`);
    return parts.join(' ');
  }
  function renderUsageNotice() {
    const c = state.conversation, watch = c?.usageWatch, notice = watch?.notice, box = $('usage-notice');
    box.hidden = !notice || Boolean(state.taskDraft) || isRunning() || storedRead(usageNoticeKey(c.id)) === watch.runId;
    if (box.hidden) return;
    $('usage-notice-text').textContent = usageNoticeText(watch);
    box.title = notice.moves.length ? 'Limits count all use of this account, including other apps.' : '';
    // Compact acts on the selected agent, so it is only offered while that is the agent this is about.
    const action = notice.action === 'compact' && watch.provider === state.provider ? 'compact' : ['saver', 'saving'].includes(notice.action) && autoRouting() ? 'saver' : null, button = $('usage-notice-action');
    button.hidden = !action; button.dataset.action = action || '';
    button.textContent = action === 'compact' ? 'Compact' : 'Use Saver';
    button.title = action === 'compact' ? 'Review what compacting does. It makes no model call.' : 'From your next message, Flow favors lighter models and agents with allowance left.';
    button.disabled = !state.ready || Boolean(state.pending) || state.loading;
  }
  async function usageNoticeAction() {
    if ($('usage-notice-action').dataset.action === 'compact') { compactCurrentContext(); return; }
    const routing = autoRouting();
    if (!routing) return;
    try { await setRouting({ mode: 'saver', allowApi: routing.allowApi === true, check: routing.check === true }); announce('Flow now uses Saver.'); }
    catch (error) { showNotice(error.message); }
  }

  const executionStrip = document.createElement('div'); executionStrip.className = 'execution-policy-strip';
  const executionLabel = document.createElement('span'), executionTakeover = document.createElement('button');
  executionTakeover.type = 'button'; executionTakeover.textContent = 'Take manual control';
  executionTakeover.addEventListener('click', async () => {
    const policy = state.conversation?.execution?.active;
    if (!policy) return;
    executionTakeover.disabled = true;
    try { await post(endpoint(state.conversation.id, 'execution-policy'), { taskId: policy.taskId, revision: policy.revision, action: 'takeover' }, state.projectId); await refresh(); }
    catch (error) { showNotice(error.message); }
    finally { executionTakeover.disabled = false; }
  });
  executionStrip.append(executionLabel, executionTakeover); ui.form.parentNode?.insertBefore(executionStrip, ui.form);
  function renderExecutionPolicy() {
    const execution = state.conversation?.execution, policy = execution?.active;
    executionStrip.hidden = !execution;
    executionLabel.textContent = execution ? `Task: ${policy?.mode === 'flow' ? 'Flow' : 'Normal'} · New work: ${execution.defaults.mode === 'flow' ? 'Flow' : 'Normal'}` : '';
    executionTakeover.hidden = !policy || policy.mode !== 'flow';
    executionTakeover.title = 'Revoke pending automatic work. The current native turn may finish; Stop ends it immediately.';
  }
  function renderControls() {
    renderExecutionPolicy();
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
    ui.input.placeholder = queueing ? (canAdd ? `Queue a follow-up, or ${modKey}↵ to add it to this run…` : "Add a message to the queue…") : state.taskDraft ? "What should this task do?" : "Describe the task or ask a question…";
    $("steer-button").hidden = !canAdd;
    $("steer-button").disabled = !state.ready || busy || !ui.input.value.trim() || Boolean(window.relayFiles?.ids().length);
    $("steer-button").title = window.relayFiles?.ids().length ? "Attachments go with a queued message" : `Add this to the current run (${modKey}↵)`;
    $("queue-button").hidden = !queueing;
    $("queue-button").disabled = !state.ready || busy || Boolean(state.localSelections[state.projectId]) || window.relayFiles?.uploading() || !ui.input.value.trim();
    ui.send.hidden = running;
    ui.send.disabled = !state.ready || busy || otherRunning || (ui.input.value.trim() !== '/compact' && !state.localSelections[state.projectId] && selectedConnection.blocked) || window.relayFiles?.uploading() || (!ui.input.value.trim() && !window.relayFiles?.ids().length);
    renderContextMeter();
    renderUsageNotice();
    ui.send.firstElementChild.textContent = state.pending === "send" ? "Sending…" : "Send";
    ui.stop.hidden = !running;
    ui.stop.disabled = Boolean(state.routingStopPending) || busy && state.conversation?.activeRun?.purpose !== 'routing';
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
    // While Codeshi works out where a task goes after a limit (#91), that's what shows, not the choices it may not need.
    const switching = state.conversation?.limitSwitching;
    ui.continuation.hidden = !canContinue || Boolean(resume) || Boolean(switching);
    const previous=state.conversation?.lastRun;
    const reason={quota:'Usage limit reached.',authentication:'Sign-in required.',permission:'A permission request was declined.',protocol:'The assistant connection stopped.',interrupted:'Run stopped.'}[previous?.errorCategory] || 'The previous run did not finish.';
    ui.continueText.textContent = reason;
    const alternative=['codex','claude','gemini'].find(provider=>provider!==state.provider&&!connection(provider).blocked) || state.provider;
    const continuationProvider=previous?.errorCategory==='quota' && previous.provider===state.provider && !connection(alternative).blocked ? alternative : state.provider;
    state.continuationProvider=continuationProvider;
    // The suggestion names its model too; the menu beside it continues with any agent and model.
    const continuationModel = continuationProvider === state.provider ? state.model : state.conversation?.models?.[continuationProvider];
    const modelLabel = continuationModel ? window.relayModelPicker?.modelName?.(continuationProvider, continuationModel) || continuationModel : "";
    // Continuing on another agent after a limit is a handoff, so queued prompts for the limited agent go along if they can (#93).
    const followers = previous?.errorCategory === "quota" && continuationProvider !== previous.provider ? (state.conversation?.queue || []).filter(item => item.provider === previous.provider).length : 0;
    if (followers) ui.continueText.textContent = `${reason} ${followers} queued prompt${followers === 1 ? "" : "s"} ${connection(continuationProvider).account?.billingSource === "subscription" ? `${followers === 1 ? "moves" : "move"} too` : `${followers === 1 ? "stays" : "stay"} with ${label(previous.provider)}`}.`;
    ui.continueButton.replaceChildren(document.createTextNode(state.pending === "continue" ? "Continuing…" : `Continue with ${label(continuationProvider)}${modelLabel ? ` · ${modelLabel}` : ""} `), element("span", "", "→"));
    $("continue-choose").disabled = busy || otherRunning;
    ui.continueButton.disabled = busy || otherRunning || connection(continuationProvider).blocked;
    // After a usage limit, the task can wait for a reset and continue on whichever agent has room first.
    const quotaStop = canContinue && previous?.errorCategory === 'quota', choosing = quotaStop && state.resumeChoice === state.conversation?.id;
    $("resume-button").hidden = !quotaStop || choosing;
    $("resume-choice").hidden = !choosing;
    for (const id of ["resume-button", "resume-ask", "resume-auto"]) $(id).disabled = busy || otherRunning || !resumeProviders().length;
    renderLimitChoice(quotaStop && !switching, previous, continuationProvider, busy || otherRunning);
    $("resume-waiting").hidden = !resume && !switching;
    $("resume-cancel").hidden = Boolean(switching) && !resume;
    if (resume) $("resume-waiting-text").textContent = resumeText(resume);
    else if (switching) $("resume-waiting-text").textContent = `${label(switching.provider)} reached its usage limit. Finding an agent with room…`;
    renderQueue(); renderHandoff(); renderRetry(); renderPlan();
    const hasMessages = Boolean(state.conversation?.messages?.length);
    ui.title.textContent=state.loading&&state.projectId?'Opening workspace…':currentProject()?.name||'Codeshi';
    // With the sidebar hidden, the top bar names the open workspace; clicking it shows the sidebar again.
    $("workspace-chip-name").textContent=currentProject()?.name||'No workspace';
    $("workspace-chip").setAttribute("aria-label",`${currentProject()?.name||'No workspace'}. Show the sidebar.`);
    const run=state.conversation?.activeRun || state.conversation?.lastRun;
    const effective=run?.provider===state.provider?run.effectiveModel:null;
    ui.subtitle.textContent=state.projectId?'Conversation':'Workspace';
    ui.state.classList.toggle('running',running);
    ui.state.hidden=!state.projectId||!state.ready;
    const approvals=state.conversation?.pendingApprovals?.length,questions=approvals&&state.conversation.pendingApprovals.every(item=>item.kind==='question');
    let status=running?(approvals?(questions?'Question for you':'Approval required'):'Running'):selectedConnection.needsSignIn||!selectedConnection.installed?'Connection required':selectedConnection.needsBilling?'Review billing':selectedConnection.checking?'Checking connection':selectedConnection.account?.authenticated!==true?'Not verified':'Ready';
    if (state.localSelections[state.projectId] && !running) status = 'Local selected';
    if (running && run?.purpose === 'review') status = 'Reviewing';
    if(incomplete && run?.provider===state.provider)status='Stopped';
    if(resume && !running)status='Waiting for reset';
    if(switching && !running)status='Handing off…';
    if(state.pending==='stop')status='Stopping…';else if(state.pending==='send'||state.pending==='continue')status='Sending…';
    if (run?.purpose === 'routing') status = state.routingStopPending ? 'Stopping…' : 'Assessing task…';
    ui.state.lastElementChild.textContent=status;
    ui.state.dataset.status=running?(approvals?'approval':'running'):resume||switching?'waiting':incomplete?'stopped':!state.localSelections[state.projectId] && selectedConnection.blocked?'setup':'ready';
    renderConnectionNotice();
    window.relayAutomaticReview?.render();
    document.title = currentProject() ? currentProject().name + " · Codeshi" : "Codeshi · Your project workspaces";
  }
  function render(forceScroll = false) { renderProjects(); renderStatus(); renderWorkspaceList(); renderMessages(forceScroll); renderControls(); renderFolderAsk(); window.dispatchEvent(new CustomEvent("relay-state")); }
  // The message box grows with its text up to 200px. Lines can be a fraction of a pixel tall while scrollHeight is a
  // whole number, so the box gets one pixel more, and it only scrolls once it has stopped growing; otherwise a message
  // of three lines showed a scroll bar.
  function resizeInput() {
    ui.input.style.height = "auto";
    const needed = ui.input.scrollHeight + 1;
    ui.input.style.height = `${Math.min(Math.max(needed, 64), 200)}px`;
    ui.input.style.overflowY = needed > 200 ? "auto" : "hidden";
  }

  let loadingEarlier = false;
  async function loadEarlierMessages() {
    const c = state.conversation;
    if (!c || !c.earlier || loadingEarlier) return false;
    const firstMsg = c.messages?.[0];
    if (!firstMsg) return false;
    loadingEarlier = true;
    const projectId = state.projectId, task = state.taskId;
    const base = '/api/conversation' + (task ? `?task=${encodeURIComponent(task)}&` : '?');
    try {
      const older = await api(`${base}before=${encodeURIComponent(firstMsg.id)}&limit=80`, {}, projectId);
      if (state.projectId !== projectId || (state.taskId || null) !== (task || null)) return false;
      if (older.messages?.length) {
        const oldScrollHeight = ui.scroll.scrollHeight;
        const oldScrollTop = ui.scroll.scrollTop;
        const newIds = new Set(older.messages.map(m => m.id));
        const kept = c.messages.filter(m => !newIds.has(m.id));
        c.messages = [...older.messages, ...kept];
        c.earlier = older.earlier !== undefined ? older.earlier : Math.max(0, (c.earlier || 0) - older.messages.length);
        renderMessages();
        const heightDiff = ui.scroll.scrollHeight - oldScrollHeight;
        ui.scroll.scrollTop = oldScrollTop + heightDiff;
        window.dispatchEvent(new CustomEvent('relay-state'));
        return true;
      } else {
        c.earlier = 0;
        renderMessages();
      }
    } catch {
      // Preserve scroll position on error
    } finally {
      loadingEarlier = false;
    }
    return false;
  }

  async function loadToRun(runId) {
    const c = state.conversation;
    if (!c || !runId) return false;
    if (ui.messages.querySelector(`div[data-run-id="${runId}"]`)) return true;
    const projectId = state.projectId, task = state.taskId;
    const base = '/api/conversation' + (task ? `?task=${encodeURIComponent(task)}&` : '?');
    try {
      const older = await api(`${base}toRun=${encodeURIComponent(runId)}`, {}, projectId);
      if (state.projectId !== projectId || (state.taskId || null) !== (task || null)) return false;
      if (older.messages?.length) {
        const oldScrollHeight = ui.scroll.scrollHeight;
        const oldScrollTop = ui.scroll.scrollTop;
        const newIds = new Set(older.messages.map(m => m.id));
        const kept = c.messages.filter(m => !newIds.has(m.id));
        c.messages = [...older.messages, ...kept];
        c.earlier = older.earlier !== undefined ? older.earlier : 0;
        renderMessages();
        const heightDiff = ui.scroll.scrollHeight - oldScrollHeight;
        ui.scroll.scrollTop = oldScrollTop + heightDiff;
        window.dispatchEvent(new CustomEvent('relay-state'));
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async function loadToMessage(messageId) {
    const c = state.conversation;
    if (!c || !messageId) return false;
    if (c.messages.some(m => m.id === messageId)) return true;
    const projectId = state.projectId, task = state.taskId;
    const base = '/api/conversation' + (task ? `?task=${encodeURIComponent(task)}&` : '?');
    try {
      const older = await api(`${base}toMessage=${encodeURIComponent(messageId)}`, {}, projectId);
      if (state.projectId !== projectId || (state.taskId || null) !== (task || null)) return false;
      if (older.messages?.length) {
        const oldScrollHeight = ui.scroll.scrollHeight;
        const oldScrollTop = ui.scroll.scrollTop;
        const newIds = new Set(older.messages.map(m => m.id));
        const kept = c.messages.filter(m => !newIds.has(m.id));
        c.messages = [...older.messages, ...kept];
        c.earlier = older.earlier !== undefined ? older.earlier : 0;
        renderMessages();
        const heightDiff = ui.scroll.scrollHeight - oldScrollHeight;
        ui.scroll.scrollTop = oldScrollTop + heightDiff;
        window.dispatchEvent(new CustomEvent('relay-state'));
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async function jumpToRun(runId) {
    if (!runId) return false;
    let node = ui.messages.querySelector(`div[data-run-id="${runId}"]`);
    if (!node && state.conversation?.earlier > 0) {
      await loadToRun(runId);
      node = ui.messages.querySelector(`div[data-run-id="${runId}"]`);
    }
    if (!node) return false;
    node.scrollIntoView?.({ behavior: "smooth", block: "center" });
    node.classList.add("activity-highlight");
    setTimeout(() => node.classList.remove("activity-highlight"), 2000);
    return true;
  }

  async function jumpToMessage(messageId) {
    if (!messageId) return false;
    let node = ui.messages.querySelector(`#message-${messageId}`) || ui.messages.querySelector(`[data-message-id="${messageId}"]`);
    if (!node && state.conversation?.earlier > 0) {
      await loadToMessage(messageId);
      node = ui.messages.querySelector(`#message-${messageId}`) || ui.messages.querySelector(`[data-message-id="${messageId}"]`);
    }
    if (!node) return false;
    node.scrollIntoView?.({ behavior: "smooth", block: "center" });
    node.classList.add("message-highlight");
    setTimeout(() => node.classList.remove("message-highlight"), 2000);
    return true;
  }

  // A message that did not change keeps its object, which is how drawing tells what changed (see renderMessages).
  function keepMessageObjects(previous, conversation) {
    if (!previous || previous.id !== conversation.id) return conversation;
    if (conversation.earlier === undefined && previous.earlier > 0 && conversation.messages.length >= previous.earlier) {
      conversation.messageCount ??= conversation.messages.length;
      conversation.messages = conversation.messages.slice(previous.earlier);
      conversation.earlier = previous.earlier;
    }
    const known = new Map(previous.messages.map(message => [message.id, message]));
    conversation.messages = conversation.messages.map(message => { const old = known.get(message.id); return old && old !== message && JSON.stringify(old) === JSON.stringify(message) ? old : message; });
    if (conversation.earlier === undefined && previous.earlier !== undefined) conversation.earlier = previous.earlier;
    return conversation;
  }
  // A long conversation is many megabytes, so an update asks only for the messages changed since the copy it has.
  async function fetchConversation(projectId) {
    // A blank task only needs the workspace's settings and its task list, not the main conversation's messages.
    if (state.taskDraft) { const update = await api('/api/conversation' + (Number.isSafeInteger(state.draftCursor) ? `?since=${state.draftCursor}` : ''), {}, projectId); state.draftCursor = update.cursor; return update; }
    const known = state.conversation;
    const task = state.taskId, base = '/api/conversation' + (task ? `?task=${encodeURIComponent(task)}` : '');
    const hasCursor = Number.isSafeInteger(known?.cursor);
    const update = await api(base + (hasCursor ? `${task ? '&' : '?'}since=${known.cursor}` : `${task ? '&' : '?'}limit=80`), {}, projectId);
    if (!hasCursor || update.messageCount === undefined) return update;
    let messages = null;
    if (known?.id === update.id) {
      const at = new Map(known.messages.map((message, index) => [message.id, index]));
      messages = [...known.messages];
      for (const message of update.messages) { const index = at.get(message.id); if (index === undefined) messages.push(message); else messages[index] = message; }
    }
    const earlier = known?.id === update.id ? (known.earlier || 0) : (update.earlier || 0);
    return (earlier + (messages?.length || 0)) === update.messageCount ? { ...update, messages, earlier } : api(base + (task ? '&' : '?') + 'limit=80', {}, projectId);
  }
  // A task about to start: nothing in the middle but the composer, so it has the same agents, models and access as anywhere.
  // Nothing is saved until it's sent, and choices made here stay here, so the main conversation's settings don't change.
  const blankTaskView = conversation => ({ ...conversation, messages: [], messageCount: 0, status: 'idle', activeRun: null, lastRun: null, queue: [], queuePaused: null, runs: [], reviews: [], pendingApprovals: [], handoffOffer: null, retryOffer: null, resume: null, limitSwitching: null, checkpoints: {}, taskResult: null, canAddToRun: false, task: null });
  async function openTaskDraft(folderId) {
    saveDraft();
    state.taskDraft = { folderId }; state.taskId = null; state.draftCursor = null;
    const projectId = state.projectId, conversation = await fetchConversation(projectId);
    if (projectId !== state.projectId || state.taskDraft?.folderId !== folderId) return;
    state.conversation = null;
    applyConversation(conversation, { adoptSettings: false });
    restoreDraft(); hideNotice(); render(); ui.input.focus?.();
  }
  // Shows a task's own conversation, or the main one, in the same place (#88).
  async function setTask(id) {
    if (!state.taskDraft && (id || null) === (state.taskId || null)) return;
    saveDraft();
    state.taskDraft = null; state.draftCursor = null;
    state.taskId = id || null;
    const projectId = state.projectId;
    if (state.conversation) state.conversation = { ...state.conversation, cursor: undefined };
    const conversation = await fetchConversation(projectId);
    if (projectId !== state.projectId || (id || null) !== (state.taskId || null)) return;
    state.conversation = null;
    applyConversation(conversation);
    restoreDraft();
    render();
  }
  function applyConversation(conversation, { adoptSettings = true } = {}) {
    if (state.taskDraft) { conversation = blankTaskView(conversation); adoptSettings = false; }
    const previousStatus = state.conversation?.status;
    state.conversation = keepMessageObjects(state.conversation, conversation);
    if (adoptSettings && !state.settingsPending) {
      state.provider = ['codex','claude','gemini'].includes(conversation.provider) ? conversation.provider : 'codex';
      state.mode = conversation.mode === "read" ? "read" : "edit";
      state.approvalPolicy = conversation.approvalPolicy === "auto" ? "auto" : "ask";
      state.model = conversation.models?.[state.provider] || conversation.model || "";
      state.effort = conversation.effort ?? conversation.efforts?.[state.provider]?.[state.model || "default"] ?? null;
    }
    if (conversation.status === "running" && state.status && !state.taskId) state.status.runningConversationId = conversation.id;
    if (previousStatus === "running" && conversation.status !== "running") announce(conversation.status === "complete" ? `${label(conversation.provider)} finished its response.` : "The assistant stopped. You can continue this conversation.");
  }
  async function ensureCanonicalConversation() {
    if (!state.projectId || !state.ready) throw new Error('Choose an available workspace first.');
    if (state.conversation) return state.conversation;
    const projectId = state.projectId, version = state.projectVersion;
    const conversation = await api('/api/conversation?limit=80',{},projectId);
    if (!sameProject(projectId,version)) throw new Error('The workspace changed while opening its chat.');
    applyConversation(conversation); restoreDraft(); render(); return conversation;
  }

  async function refresh() {
    if (state.stopping) return;
    const projectId = state.projectId;
    const projectVersion = state.projectVersion;
    if (!projectId || !state.ready) return;
    if (state.refreshPromise?.projectId === projectId && state.refreshPromise.version === projectVersion) { state.refreshAgain = true; return state.refreshPromise.promise; }
    const settingsRevision = state.settingsRevision;
    const request = { projectId, version: projectVersion, promise: null };
    state.refreshPromise = request;
    request.promise = (async () => {
      try {
        const [status, conversation] = await Promise.all([api('/api/status',{},projectId),fetchConversation(projectId)]);
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
    if (!state.conversation || state.taskDraft) return;
    const id = state.conversation.id;
    const projectId = state.projectId;
    const projectVersion = state.projectVersion;
    const revision = ++state.settingsRevision;
    state.settingsPending++;
    renderProjects();
    renderWorkspaceList();
    state.settingsPromise = state.settingsPromise.catch(() => {}).then(async () => {
      try {
        const limit = state.conversation?.earlier > 0 ? `?limit=${Math.max(80, state.conversation.messages?.length || 80)}` : "";
        const conversation = await post(endpoint(id, "provider") + limit, { provider, mode, approvalPolicy }, projectId);
        if (sameProject(projectId, projectVersion) && state.conversation?.id === id && revision === state.settingsRevision) applyConversation(conversation, { adoptSettings: false });
      } catch (error) {
        if (sameProject(projectId, projectVersion)) showNotice(`Could not save the assistant selection. ${error.message}`, () => changeSettings(provider, mode, approvalPolicy));
      } finally { state.settingsPending--; renderProjects(); renderWorkspaceList(); scheduleRefresh(); }
    });
  }

  let compactIntent = null;
  function canCompactContext() {
    if (!state.conversation || !state.ready || state.pending || state.loading || state.projectSaving || state.settingsPending || state.taskDraft) return false;
    if (isRunning() || isOtherRunning() || state.conversation.resume || state.conversation.limitSwitching) {
      showNotice('Finish or stop the current run or reset wait before compacting context.'); return false;
    }
    return true;
  }
  const compactScopeMatches = intent => intent && sameProject(intent.projectId, intent.version) && state.conversation?.id === intent.id && state.provider === intent.provider && !state.taskDraft;
  function compactCurrentContext({ command = false } = {}) {
    if (!state.ready || state.loading || state.projectSaving) return false;
    if (!compactContextState().visible) { showNotice('This agent has no session to compact. Your next message already starts with fresh context.'); return false; }
    const dialog = $('compact-confirmation');
    if (dialog.open) return false;
    compactIntent = { projectId: state.projectId, version: state.projectVersion, id: state.conversation.id, provider: state.provider, command, draft: ui.input.value };
    dialog.showModal(); renderContextMeter(); $('compact-cancel').focus();
    return true;
  }
  async function confirmCompactContext() {
    const intent = compactIntent;
    if (!compactScopeMatches(intent)) {
      $('compact-confirmation').close(); showNotice('The chat or agent changed. Review compact context again before confirming.'); return;
    }
    if (!canCompactContext()) { $('compact-confirmation').close(); return; }
    if (!compactContextState().canRefresh) { renderContextMeter(); return; }
    $('compact-confirmation').close();
    state.pending = 'compact'; render();
    try {
      const limit = state.conversation?.earlier > 0 ? `?limit=${Math.max(80, (state.conversation.messages?.length || 80) + 1)}` : "";
      const result = await post(endpoint(intent.id, 'compact') + limit, { provider: intent.provider }, intent.projectId);
      if (compactScopeMatches(intent)) {
        applyConversation(result, { adoptSettings: false });
        if (intent.command && ui.input.value === intent.draft) { ui.input.value = ''; storedWrite(draftKey(), ''); resizeInput(); }
        announce('Context refresh scheduled for your next send.');
      }
    } catch (error) { showNotice(error.message); }
    finally { state.pending = null; render(); }
  }

  async function run(continuing = false) {
    const attachments = continuing ? [] : window.relayFiles?.ids() || [];
    const text = ui.input.value.trim() || (attachments.length ? "Please review the attached files." : "");
    if (!continuing && text === '/compact') {
      if (attachments.length) { showNotice('Remove attachments before compacting context. Your draft stays saved.'); return; }
      compactCurrentContext({ command: true });
      return;
    }
    if (window.relayFiles?.uploading()) return;
    if (state.pending || state.loading || state.projectSaving || isRunning() || isOtherRunning() || !state.ready || (!state.localSelections[state.projectId] && !(autoRouting() && !continuing) && connection(state.provider).blocked) || (!continuing && !text)) return;
    // A local estimate, so a message nothing could take stops here. The server rates the task and makes the final choice.
    const routed = continuing ? null : routeFor(text, attachments.length);
    if (routed?.error) { showNotice(routed.error); return; }
    const provider = routed?.provider || state.provider, model = routed ? routed.model : state.model, effort = routed ? routed.effort : state.effort;
    const routing = routed ? { mode: routed.mode, reason: routed.reason, tier: routed.tier, escalation: routed.escalation || null } : undefined;
    const mode = state.mode;
    const approvalPolicy = state.approvalPolicy || 'ask';
    const originalDraft = ui.input.value;
    const localChoice = state.localSelections[state.projectId] || null;
    if ((state.taskId || state.taskDraft) && localChoice) { showNotice("A task runs on your connected agents for now. Choose one, or send this from Main to use a local model."); return; }
    let automaticReview;
    try { automaticReview = window.relayAutomaticReview?.submission({ text, attachments, provider, model, mode, approvalPolicy }, { continuing }) || null; }
    catch (error) { showNotice(error.message); return; }
    // An agent that works in one folder, in a workspace with several: the message waits for a choice of folder, then runs as a task there.
    if (!continuing && !state.taskId && !state.taskDraft && !localChoice && !automaticReview && oneFolderOnly(provider) && foldersFor(currentProject()).length > 1) { askFolder({ text, attachments, provider, model, effort, mode, approvalPolicy, requestId: crypto.randomUUID(), originalDraft }); return; }
    const payloadKey = JSON.stringify([state.projectId,state.conversation?.id,continuing,text,provider,mode,approvalPolicy,model,effort,attachments,localChoice,automaticReview]);
    const requestId = state.retrySubmission?.key === payloadKey ? state.retrySubmission.id : crypto.randomUUID();
    state.retrySubmission = { ...(state.retrySubmission?.key === payloadKey ? state.retrySubmission : {}), key:payloadKey,id:requestId };
    const projectId = state.projectId;
    state.pending = continuing ? "continue" : "send";
    saveDraft();
    render();
    hideNotice();
    try {
      await state.settingsPromise;
      // A blank task: sending starts it, and the conversation moves to it.
      if (state.taskDraft) {
        if (automaticReview) throw Error('Build then review runs from the main conversation for now.');
        const task = await window.relayTaskThreads.start({ executionRevision: state.conversation?.execution?.defaults?.revision ?? 0, text, attachments, provider, model: model || null, effort: effort || null, mode, approvalPolicy, routing, requestId, billingConfirmed: window.relayBillingConfirmed === true });
        state.retrySubmission = null;
        window.relayFiles?.accepted(projectId, attachments);
        if (ui.input.value === originalDraft) { ui.input.value = ""; storedWrite(draftKey(), ""); resizeInput(); }
        await window.relayTaskThreads.started(task);
        announce(`The task in ${task.folderName} has started.`);
        return;
      }
      if (!state.conversation) await ensureCanonicalConversation();
      const id = state.conversation.id;
      state.retrySubmission.key = JSON.stringify([state.projectId,id,continuing,text,provider,mode,approvalPolicy,model,effort,attachments,localChoice,automaticReview]);
      let accepted;
      if (localChoice) {
        if (!state.retrySubmission.localContext) {
          const catalog = await api('/api/local-models', {}, projectId);
          if (!catalog.installed) throw Error('Install Codex CLI for local workspace tools.');
          if (!catalog.models.some(row => row.id === localChoice.model && row.digest === localChoice.digest)) throw Error('This local model changed or was removed. Choose it again from the model picker.');
          state.retrySubmission.localContext = catalog.context;
        }
        await post('/api/local-models/start', { model:localChoice.model, digest:localChoice.digest, task:continuing ? 'Continue the unfinished task from the saved conversation. Inspect current files first.' : text, ...(continuing ? { continuing:true } : {}), attachments, requestId, context:state.retrySubmission.localContext }, projectId);
      } else accepted = await post(endpoint(id, continuing ? "continue" : "messages"), continuing ? { provider, mode, approvalPolicy, requestId, model:model || undefined, effort:effort || null, billingConfirmed:window.relayBillingConfirmed === true } : { executionRevision: state.conversation?.execution?.defaults?.revision ?? 0, text, attachments, provider, mode, approvalPolicy, requestId, model:model || undefined, effort:effort || null, routing, ...(automaticReview ? { automaticReview } : {}), billingConfirmed:window.relayBillingConfirmed === true }, projectId);
      state.retrySubmission = null;
      window.relayAutomaticReview?.accepted(projectId, automaticReview);
      if (!continuing) window.relayFiles?.accepted(projectId, attachments);
      if (!continuing && ui.input.value === originalDraft) {
        ui.input.value = "";
        storedWrite(draftKey(), "");
        storedWrite(draftKey(null), "");
        resizeInput();
      }
      state.conversation.status = "running";
      if (!localChoice) state.conversation.provider = accepted?.provider || provider;
      state.conversation.mode = mode;
      state.conversation.approvalPolicy = approvalPolicy;
      if (state.status) state.status.runningConversationId = id;
      announce(`${localChoice ? "Local · Ollama" : label(accepted?.provider || provider)} is working.`);
      await refresh();
      render(true);
    } catch (error) {
      // A task limit can be raised for this task, by the person, right here.
      const budget = error.details?.budget;
      if (budget?.canExtend && window.relayLimits) showNotice(error.message, async () => { try { await window.relayLimits.extend(budget.taskId, budget.limit); run(continuing); } catch (failure) { showNotice(failure.message); } }, "Allow more");
      else if (budget) showNotice(error.message);
      // The server knew the agent works in one folder before the page did: offer the folders rather than a retry that would fail again.
      else if (error.details?.folderChoice && !continuing && !state.taskId && !state.taskDraft) askFolder({ text, attachments, provider, model, effort, mode, approvalPolicy, requestId, originalDraft });
      else showNotice(error.message, () => run(continuing));
      await refresh();
    } finally { state.pending = null; render(); ui.input.focus(); }
  }

  async function stop() {
    if (state.conversation?.activeRun?.purpose === 'routing') {
      if (state.routingStopPending) return;
      state.routingStopPending = true; render();
      try { await post(endpoint(state.conversation.id, 'stop')); announce('Stopping the routing assessment. Your draft stays saved.'); }
      catch (error) { showNotice(error.message); }
      finally { state.routingStopPending = false; render(); }
      return;
    }
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
    state.taskId = null; state.taskDraft = null; state.draftCursor = null;
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
    let loaded = false;
    try {
      const [status, conversation] = await Promise.all([api('/api/status',{},id),api('/api/conversation?limit=80',{},id)]);
      if (!sameProject(id,version)) return;
      state.status = status; applyConversation(conversation);
      state.ready = true; state.loading = false; restoreDraft(); loaded = true;
      if (sameProject(id, version)) { render(true); announce(`Opened project ${currentProject()?.name || "workspace"}.`); }
    } catch (error) {
      if (sameProject(id, version)) showNotice(error.message, () => selectProject(id));
    } finally {
      if (sameProject(id, version) && !loaded) { state.loading = false; render(); }
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
      state.taskId = null; state.taskDraft = null; state.draftCursor = null;
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
    if (open) { closeWorkspaceMenu(); ui.projectPanel.hidden = true; ui.addProject.setAttribute('aria-expanded','false'); ui.folderError.hidden = true; $('folder-panel-description').textContent = 'Add one or more folders to ' + currentProject().name + '. They join the same existing chat; files stay where they are.'; folderCount(); ui.folderPath.focus(); }
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
  // The Add button says how many folders it adds.
  function folderCount() { const count = folderPaths(ui.folderPath.value).length; $('save-folder-label').textContent = count > 1 ? `Add ${count} folders` : 'Add folder'; }
  // One folder or several, one path per line: all of them are added in one change, or none if one can't be.
  async function addFolder(event) {
    event.preventDefault(); if (projectBusy() || isRunning() || !state.projectId) return;
    const folders = folderPaths(ui.folderPath.value), projectId = state.projectId;
    if (!folders.length || folders.some(value=>!validFolderPath(value))) { ui.folderError.textContent = folders.length > 1 ? 'Enter absolute folder paths or paths beginning with ~/, one per line.' : 'Enter an absolute folder path or a path beginning with ~/.'; ui.folderError.hidden = false; ui.folderPath.focus(); return; }
    saveDraft(); state.projectSaving = true; ui.folderError.hidden = true; render();
    try {
      const project = await post('/api/projects/' + encodeURIComponent(projectId) + '/folders',folders.length === 1 ? {path:folders[0]} : {folders});
      state.projects = state.projects.map(item=>item.id === project.id ? project : item); ui.folderPath.value = ''; folderCount(); ui.folderPanel.hidden = true; await refresh(); announce(folders.length === 1 ? 'Folder added to this workspace. The same conversation is open.' : `${folders.length} folders added to this workspace. The same conversation is open.`);
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
    // Focus returns to the options of the workspace that was kept, or the first one if the list no longer shows it.
    const id = state.removingProjectId, options = [...ui.workspaceList.querySelectorAll('.workspace-options')];
    ui.removeDialog.close(); state.removingProjectId = null;
    (options.find(button => button.dataset.projectId === id) || options[0])?.focus();
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
  // The window is closing or restarting into an update, so what stops answering now is not an error to show.
  window.relayDesktop?.onQuitting?.(() => { state.stopping = true; ui.notice.hidden = true; });
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
    { label: "Previous chats…", id: "open-import" }, { label: "Export conversation…", id: "open-export" }, { label: 'Compact context', id: 'compact-context' },
    { label: "Flow mode: just the chat, with plain-language cards", run: () => window.relayFlow?.toggle() },
    { label: "Agents: plan usage and handoff", run: () => window.relayAgents?.open() },
    { label: "Brief: memory and skills every agent gets", run: () => window.relayBrief?.open() },
    { label: "Tasks: what each task used, and its limits", run: () => window.relayTasks?.open() },
    { label: "New task beside this one", run: () => window.relayTaskThreads?.open() },
    { label: "Timeline: review and restore checkpoints", run: () => window.relayTimeline?.open() },
    { label: "Git activity", run: () => { if ($("git-panel").hidden) $("open-git").click(); } },
    { label: "Terminal", workbench: true, run: () => window.relayTerminal?.open() },
    { label: "Run: your dev servers, tests and scripts", workbench: true, run: () => window.relayPanel?.show("run") },
    ...(window.relayDesktop?.openPreview ? [{ label: "Preview your app and point at what to change", run: () => { const url = window.relayCommands?.localURL?.(); if (url) window.relayPreview?.open(url); else { window.relayPanel?.show("run"); showNotice("Start your dev server in Run first; its local address opens in the preview."); } } }] : []),
    { label: "While you were away", run: () => window.relayRecap?.open() },
    { label: "New workspace…", id: "create-workspace" }, { label: "Settings", id: "relay-settings" },
    { label: "General: appearance, keep awake, handoff and updates", run: () => window.relaySettings?.open("general") },
    { label: "Alert settings: banners, sounds, the Dock and the menu bar", run: () => window.relaySettings?.open("preferences", "Alerts") },
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
    const actions = commandActions.filter(action => !action.workbench || !window.relayFlow?.isOn?.()).filter(action => !text || action.label.toLowerCase().includes(text)).filter(action => !action.id || ($(action.id) && !$(action.id).disabled && (action.id !== 'compact-context' || !$(action.id).hidden)))
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
  $("toggle-flow").title = `Flow mode: just the chat, with plain-language cards (${shortcut("F", true)})`;
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
    // Settings may already be open on another tab; any other dialog waits.
    "alert-settings": () => { if ([...document.querySelectorAll("dialog")].some(dialog => dialog.open && dialog.id !== "settings") || !window.relaySettings) return false; window.relaySettings.open("alerts"); return true; },
    "whats-new": () => { if (covered() || !window.relayUpdates) return false; window.relayUpdates.open(); return true; },
    "check-updates": () => { if (!window.relayUpdater) return false; window.relayUpdater.checkNow(); return true; },
    terminal: () => { if (!state.projectId || !window.relayTerminal || window.relayFlow?.isOn?.()) return false; window.relayTerminal.toggle(); return true; },
    voice: () => Boolean(state.projectId && window.relayVoice?.toggle()),
    "local-models": () => window.relayLocal?.open(),
    "previous-chats": press("open-import"), export: press("open-export"), "ask-friend": press("ask-friend"), files: () => { if ($('files-dialog')?.open) { $('close-files').click(); return true; } return press('toggle-explorer')(); }, "keep-awake": press("keep-awake"),
    "add-folder": () => { if (covered()) return false; toggleFolderForm(true); return true; },
    agent: provider => ["codex", "claude", "gemini"].includes(provider) && press("select-" + provider)(),
    continue: () => !ui.continuation.hidden && press("continue-button")(),
    'compact-context': press('compact-context'),
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
    flow: () => !covered() && Boolean(window.relayFlow?.toggle()),
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
    else if (key === "f" && event.shiftKey) run("flow");
    else if (key === ".") run("stop");
    else if (/^[1-9]$/.test(event.key) && !event.shiftKey) run("workspace", Number(event.key));
  });
  ui.scroll.addEventListener("scroll", updateJump, { passive: true });
  ui.scroll.addEventListener("scroll", () => {
    if (!scrollingToLatest && ui.scroll.scrollTop < 120 && state.conversation?.earlier > 0) loadEarlierMessages();
  }, { passive: true });
  // Status, permission requests and Continue appear under the latest turn without a new message; a reader at the end keeps seeing them.
  let following = true;
  ui.scroll.addEventListener("scroll", () => { following = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 110; }, { passive: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (following) ui.scroll.scrollTop = ui.scroll.scrollHeight; }).observe($("transcript-footer"));
  // From far away it goes straight there: scrolling past every turn would draw them all, and that moves the end further away.
  $("jump-latest").addEventListener("click", () => {
    const distance = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight;
    if (distance > ui.scroll.clientHeight * 2) scrollToLatest();
    else {
      ui.scroll.scrollTo({ top: ui.scroll.scrollHeight, behavior: "smooth" });
      ui.scroll.addEventListener("scrollend", () => { if (ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 240) scrollToLatest(); }, { once: true });
    }
    ui.input.focus();
  });
  ui.projectSelect.addEventListener("change", () => selectProject(ui.projectSelect.value));
  ui.addProject.addEventListener("click", () => toggleProjectForm(ui.projectPanel.hidden));
  ui.addFirstProject.addEventListener("click", () => toggleProjectForm(true));
  ui.projectClose.addEventListener("click", () => toggleProjectForm(false));
  ui.projectForm.addEventListener("submit", addProject);
  ui.createWorkspace.addEventListener("click",()=>toggleProjectForm(true));
  ui.folderForm.addEventListener("submit",addFolder);
  ui.folderPath.addEventListener("input",folderCount);
  ui.folderClose.addEventListener("click",()=>toggleFolderForm(false));
  ui.workspaceToggle.addEventListener("click", () => {
    const open = ui.workspaceToggle.getAttribute("aria-expanded") !== "true";
    ui.workspaceToggle.setAttribute("aria-expanded", String(open));
    ui.workspaceToggle.closest(".sidebar").classList.toggle("workspaces-open", open);
  });
  document.addEventListener("click", (event) => { if (!event.target.closest(".sidebar")) closeWorkspaceMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.isComposing) { closeWorkspaceMenu(); if (!ui.projectPanel.hidden) toggleProjectForm(false); if (!ui.folderPanel.hidden) toggleFolderForm(false); } });
  ui.form.addEventListener("submit", (event) => { event.preventDefault(); if (!$("queue-button").hidden) queuePrompt(); else run(); });
  $('compact-context').addEventListener('click', () => compactCurrentContext());
  $('usage-notice-action').addEventListener('click', usageNoticeAction);
  $('usage-notice-dismiss').addEventListener('click', () => { const c = state.conversation; if (c?.usageWatch) storedWrite(usageNoticeKey(c.id), c.usageWatch.runId); renderUsageNotice(); ui.input.focus(); });
  $('compact-cancel').addEventListener('click', () => $('compact-confirmation').close());
  $('compact-confirm').addEventListener('click', confirmCompactContext);
  $('compact-confirmation').addEventListener('close', () => {
    if ($('compact-confirmation').open) return;
    const command = compactIntent?.command; compactIntent = null;
    if (command || $('compact-context').hidden) ui.input.focus(); else $('compact-context').focus();
  });
  $("queue-button").addEventListener("click", queuePrompt);
  $("handoff-accept").addEventListener("click", () => answerHandoff(true));
  $("handoff-dismiss").addEventListener("click", () => answerHandoff(false));
  $("retry-accept").addEventListener("click", () => answerRetry(true));
  $("retry-dismiss").addEventListener("click", () => answerRetry(false));
  $("handoff-billing-confirm").addEventListener("change", renderHandoff);
  $("prompt-queue-toggle").addEventListener("click", () => queueAction({ action: state.conversation?.queuePaused ? "resume" : "pause" }));
  // A folder choice waits for the message as written; editing it withdraws the choice until it is sent again.
  ui.input.addEventListener("input", () => { resizeInput(); saveDraft(); renderControls(); if (state.folderAsk && ui.input.value !== state.folderAsk.originalDraft) clearFolderAsk(); });
  $("steer-button").addEventListener("click", addToRun);
  $("workspace-chip").addEventListener("click", () => window.relayLayout?.toggleSidebar());
  // Choosing an action from the ⋯ menu closes it.
  $("header-menu").addEventListener("click", event => { if (event.target?.closest?.("button")) $("header-menu").hidePopover?.(); });
  // The tabs at the top of a side panel switch to the other panel.
  // The side panel's tabs: Agents, Brief, Tasks, Git and Timeline, each opened by its own module.
  const sidePanelOpeners = { agents: () => $("open-agents").click(), git: () => $("open-git").click(), brief: () => window.relayBrief?.open(), tasks: () => window.relayTasks?.open(), timeline: () => window.relayTimeline?.open() };
  const showSidePanel = name => { const panel = $(`${name}-panel`); if (panel?.hidden !== false) sidePanelOpeners[name]?.(); };
  document.querySelectorAll(".panel-tab").forEach(tab => tab.addEventListener("click", () => showSidePanel(tab.dataset.panel)));
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
  // Choosing an agent yourself, here or from the Agent menu, turns Auto off. In Flow the choice is routing's (#107).
  const chooseAgent = provider => {
    if (window.relayFlow?.isOn?.()) { showNotice("Flow chooses the agent and model for each message. Leave Flow to pick one yourself."); return; }
    delete state.localSelections[state.projectId]; if (autoRouting()) setRouting({ mode: null }).catch(error => showNotice(error.message)); changeSettings(provider, state.mode, state.approvalPolicy);
  };
  ui.codex.addEventListener("click", () => chooseAgent("codex"));
  ui.claude.addEventListener("click", () => chooseAgent("claude"));
  ui.gemini.addEventListener("click", () => chooseAgent("gemini"));
  ui.mode.addEventListener("change", () => changeSettings(state.provider, ui.mode.value, state.approvalPolicy));
  ui.approval?.addEventListener("change", () => changeSettings(state.provider, state.mode, ui.approval.value));
  ui.stop.addEventListener("click", stop);
  $("limit-always").addEventListener("click", async () => {
    try { limitChoice.preferences = await post("/api/handoff-preferences", { automatic: true, limitAsked: true }); }
    catch (error) { showNotice(error.message); return; }
    window.dispatchEvent(new CustomEvent("relay-handoff-preferences"));
    renderControls();
    ui.continueButton.click();
  });
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
  $('connect-assistant')?.addEventListener('click',openAccounts);
  $('connection-install')?.addEventListener('click',()=>{if(state.installUrl)openExternal(state.installUrl);});
  $('connection-action')?.addEventListener('click',()=>state.connectionAction?.());
  // Each agent in Plan usage does one thing: a connected agent shows its limits, any other opens its setup in Settings.
  for(const provider of ['codex','claude','gemini'])$(`${provider}-status`)?.addEventListener('click',event=>{
    if(state.accounts?.[provider]?.authenticated===true&&window.relayUsage)window.relayUsage.open(provider,event.currentTarget||$(`${provider}-status`));
    else openAccounts();
  });
  window.addEventListener('relay-account',()=>{renderStatus();renderControls();});
  window.addEventListener('relay-billing',()=>{renderStatus();renderControls();});
  window.addEventListener("beforeunload", saveDraft);
  window.relayUI = {
    jumpToRun, jumpToMessage, loadEarlierMessages, loadToRun, loadToMessage,
    getState: () => state, describeActivity: parseActivity, api, post, refresh, renderControls, showNotice, selectProject, refreshAccounts, refreshProjects, announce, selectedFolderId: () => selectedFolderId(), selectFolder, highlightLines,
    commands, isRunning, filteredProjects, setRouting, routeFor, showSidePanel, setTask, openTaskDraft, sidebarLevel: () => sidebarLevelFor(), showFolderLevel: () => { setSidebarLevel(state.projectId, 'folder'); renderWorkspaceList(); window.dispatchEvent(new CustomEvent('relay-state')); },
    ensureConversation: ensureCanonicalConversation,
    prepareQuestionAnswer(conversationId, text, projectId = state.projectId) {
      const current = state.projectId === projectId && state.conversation?.id === conversationId && !state.taskDraft;
      const key = projectId ? `ai-relay:project:${projectId}:draft:${conversationId}` : storageKey(`ai-relay:draft:${conversationId}`);
      let previous = current ? ui.input.value : '';
      if (!current) { try { previous = localStorage.getItem(key) || ''; } catch { /* Storage is optional. */ } }
      const draft = [previous.trim(), text].filter(Boolean).join('\n\n');
      try { localStorage.setItem(key, draft); } catch { /* The open composer's draft still works. */ }
      if (current) { ui.input.value = draft; resizeInput(); renderControls(); }
      showNotice('Answer added to your draft. Send it to continue.');
    },
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
      if (!state.ready || state.pending || state.settingsPending) throw new Error('Finish the current settings update before changing the model or effort.');
      model = model?.trim() || null;
      if (state.taskDraft) { state.model = model || ''; state.effort = effort; render(); window.dispatchEvent(new CustomEvent('relay-state')); return; }
      const projectId = state.projectId, version = state.projectVersion, conversationId = state.conversation?.id, provider = state.provider;
      const revision = ++state.settingsRevision;
      state.settingsPending++; render();
      const limit = state.conversation?.earlier > 0 ? `?limit=${Math.max(80, state.conversation.messages?.length || 80)}` : "";
      const operation = state.settingsPromise.catch(() => {}).then(() => post(endpoint(conversationId,'provider') + limit, {provider,mode:state.mode,approvalPolicy:state.approvalPolicy,model,effort},projectId));
      state.settingsPromise = operation;
      try {
        const conversation = await operation;
        if (sameProject(projectId,version) && revision === state.settingsRevision) {
          state.conversation = keepMessageObjects(state.conversation, conversation); state.model = model || ''; state.effort = effort;
        }
      } finally { state.settingsPending--; if (sameProject(projectId,version)) render(); }
    },
  };
  if (window.relayDesktop) {
    $('pick-folder').hidden = false; $('pick-add-folder').hidden = false;
    $('pick-folder').addEventListener('click',async()=>{try { const picked = await window.relayDesktop.pickFolder(); const folders = Array.isArray(picked) ? picked : picked ? [picked] : []; if (folders.length) ui.projectPaths.value = [...new Set([...folderPaths(ui.projectPaths.value),...folders])].join('\n'); } catch (error) { showNotice(error.message); }});
    $('pick-add-folder').addEventListener('click',async()=>{try { const picked = await window.relayDesktop.pickFolder(); const folders = Array.isArray(picked) ? picked : picked ? [picked] : []; if (folders.length) { ui.folderPath.value = [...new Set([...folderPaths(ui.folderPath.value),...folders])].join('\n'); folderCount(); } } catch (error) { showNotice(error.message); }});
  }
  render();
  initialize();
})();

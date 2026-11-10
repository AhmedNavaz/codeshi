import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectRegistry } from './projects.mjs';
import { CollaborationService } from './collaboration.mjs';
import { SharingClient, validateSharingURL } from './sharing-client.mjs';
import { collaborationRoute } from './collaboration-routes.mjs';
import { closeAccountConnections } from './providers.mjs';
import { createCommandRoutes } from './project-commands.mjs';
import { createProjectReviewRoutes } from './project-review.mjs';
import { createTerminalRoutes } from './terminal.mjs';
import { createVoiceRoutes } from './voice.mjs';
import { buildRecap } from './recap.mjs';
import { createWorkspaceRoutes } from './workspace-routes.mjs';
import { randomBytes } from 'node:crypto';
import { createConversationRoutes } from './conversation-routes.mjs';
import { createReviewRoutes } from './agent-review-routes.mjs';
import { createCheckpointRoutes } from './checkpoint-routes.mjs';
import { alertPreferences, alertSound, mergeAlertPreferences } from './alerts.mjs';
import { createLocalRoutes } from './local-models.mjs';
import { createTaskRoutes } from './task-routes.mjs';
import { atomicJSON } from './patches.mjs';
import { appearance, appearances, preferencePatch, publicPreferences } from './preferences.mjs';
import { verificationCadence } from './verification.mjs';
import { contextLimit } from './context-rollover.mjs';
import { createPhoneAccess } from './phone-access.mjs';
import { createRemotePhoneAccess } from './phone-remote.mjs';
import { phoneConversation } from './phone-conversation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = { '/project-commands.js': ['project-commands.js', 'text/javascript; charset=utf-8'], '/project-commands.css': ['project-commands.css', 'text/css; charset=utf-8'], '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/desktop-controls.js': ['desktop-controls.js', 'text/javascript; charset=utf-8'], '/setup.js': ['setup.js', 'text/javascript; charset=utf-8'], '/polish.css': ['polish.css', 'text/css; charset=utf-8'], '/files.js': ['files.js', 'text/javascript; charset=utf-8'], '/files.css': ['files.css', 'text/css; charset=utf-8'], '/onboarding.css': ['onboarding.css', 'text/css; charset=utf-8'],
  '/brief-panel.js': ['brief-panel.js', 'text/javascript; charset=utf-8'], '/tasks-panel.js': ['tasks-panel.js', 'text/javascript; charset=utf-8'], '/smart-results.js': ['smart-results.js', 'text/javascript; charset=utf-8'], '/skills.js': ['skills.js', 'text/javascript; charset=utf-8'], '/memory.js': ['memory.js', 'text/javascript; charset=utf-8'], '/model-picker.js': ['model-picker.js', 'text/javascript; charset=utf-8'], '/routing.js': ['routing.js', 'text/javascript; charset=utf-8'], '/layout.js': ['layout.js', 'text/javascript; charset=utf-8'], '/agents-panel.js': ['agents-panel.js', 'text/javascript; charset=utf-8'], '/model-picker.css': ['model-picker.css', 'text/css; charset=utf-8'],
  '/bottom-panel.js': ['bottom-panel.js', 'text/javascript; charset=utf-8'], '/preview.js': ['preview.js', 'text/javascript; charset=utf-8'], '/terminal.js': ['terminal.js', 'text/javascript; charset=utf-8'], '/terminal.css': ['terminal.css', 'text/css; charset=utf-8'],
  '/voice.js': ['voice.js', 'text/javascript; charset=utf-8'], '/voice.css': ['voice.css', 'text/css; charset=utf-8'],
  '/parallel-tasks.js': ['parallel-tasks.js', 'text/javascript; charset=utf-8'], '/parallel-tasks.css': ['parallel-tasks.css', 'text/css; charset=utf-8'], '/recap.js': ['recap.js', 'text/javascript; charset=utf-8'], '/recap.css': ['recap.css', 'text/css; charset=utf-8'],
  // The terminal renderer, served from the installed package so packaged builds work offline.
  '/vendor/xterm.js': ['../node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'], '/vendor/xterm.css': ['../node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'], '/vendor/addon-fit.js': ['../node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'], '/vendor/addon-web-links.js': ['../node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'text/javascript; charset=utf-8'],
  '/updates.js': ['updates.js', 'text/javascript; charset=utf-8'], '/updater.js': ['updater.js', 'text/javascript; charset=utf-8'], '/updates.css': ['updates.css', 'text/css; charset=utf-8'],
  '/local-models.js': ['local-models.js', 'text/javascript; charset=utf-8'], '/local-models.css': ['local-models.css', 'text/css; charset=utf-8'],
  '/agent-review.js': ['agent-review.js', 'text/javascript; charset=utf-8'], '/agent-review.css': ['agent-review.css', 'text/css; charset=utf-8'],
  '/github-context.js': ['github-context.js', 'text/javascript; charset=utf-8'], '/automatic-review.js': ['automatic-review.js', 'text/javascript; charset=utf-8'], '/automatic-review.css': ['automatic-review.css', 'text/css; charset=utf-8'],
  '/orchestration.js': ['orchestration.js', 'text/javascript; charset=utf-8'], '/orchestration.css': ['orchestration.css', 'text/css; charset=utf-8'],
  '/run-plan.css': ['run-plan.css', 'text/css; charset=utf-8'],
  '/rewind.js': ['rewind.js', 'text/javascript; charset=utf-8'], '/rewind.css': ['rewind.css', 'text/css; charset=utf-8'],
  '/flow.js': ['flow.js', 'text/javascript; charset=utf-8'], '/flow-lounge.js': ['flow-lounge.js', 'text/javascript; charset=utf-8'], '/flow.css': ['flow.css', 'text/css; charset=utf-8'],
  '/project-review.js': ['project-review.js', 'text/javascript; charset=utf-8'], '/project-review.css': ['project-review.css', 'text/css; charset=utf-8'],
  '/alerts.js': ['alerts.js', 'text/javascript; charset=utf-8'], '/alerts.css': ['alerts.css', 'text/css; charset=utf-8'],
  '/questions.js': ['questions.js', 'text/javascript; charset=utf-8'], '/questions.css': ['questions.css', 'text/css; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'], '/editor-theme.css': ['editor-theme.css', 'text/css; charset=utf-8'], '/insights.js': ['insights.js', 'text/javascript; charset=utf-8'], '/conversation-history.js': ['conversation-history.js', 'text/javascript; charset=utf-8'], '/conversation-search.js': ['conversation-search.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/workbench.js': ['workbench.js', 'text/javascript; charset=utf-8'], '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'], '/settings.css': ['settings.css', 'text/css; charset=utf-8'], '/workbench.css': ['workbench.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/logo.svg': ['logo.svg', 'image/svg+xml'], '/mark.svg': ['mark.svg', 'image/svg+xml'],
  '/sounds/rain.m4a': ['sounds/rain.m4a', 'audio/mp4'], '/sounds/snow.m4a': ['sounds/snow.m4a', 'audio/mp4'],
  '/icon-16.png': ['icon-16.png', 'image/png'], '/icon-32.png': ['icon-32.png', 'image/png'], '/icon-180.png': ['icon-180.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'] };
for (const [name, type] of [['phone-access.js', 'text/javascript'], ['phone-access.css', 'text/css'], ['phone.js', 'text/javascript'], ['phone-logic.js', 'text/javascript'], ['phone-theme.js', 'text/javascript'], ['phone.css', 'text/css']]) assets[`/${name}`] = [name, `${type}; charset=utf-8`];
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function body(req, limit = 3 * 1024 * 1024) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw Object.assign(new Error('Send JSON content.'), { status: 415 });
  }
  // Decode once at the end: a multi-byte character can be split across chunks.
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf8');
  try {
    const value = JSON.parse(input || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Invalid JSON request.'), { status: 400 }); }
}

export function createRelayServer({ workspace, workspaces = [], dataRoot, dataDir, bins, lock = true, sharingURL = process.env.AI_RELAY_SHARING_URL, accessToken, importer, onAppearance = () => {}, onNotify = () => {}, onHandoff = () => {}, onNotifications = () => {}, voice, phoneOptions } = {}) {
  const registry = new ProjectRegistry({ dataRoot: dataRoot || dataDir || path.join(root, '.data'), bins, lock });
  for (const folder of [...(workspace ? [workspace] : []), ...workspaces]) registry.add({ path: folder });
  const collaboration = new CollaborationService({ registry, dataRoot: registry.dataRoot });
  const settingsFile=path.join(registry.dataRoot,'settings.json');
  // Settings are saved whole, so a file that can't be read was changed outside Codeshi. It is named instead of
  // replaced with defaults, which would quietly turn a saved Read only default back into Can edit files.
  const readSettings=()=>{
    if(!fs.existsSync(settingsFile))return null;
    let saved;try{saved=JSON.parse(fs.readFileSync(settingsFile,'utf8'));}catch{}
    if(!saved||typeof saved!=='object'||Array.isArray(saved))throw new Error(`Cannot read the settings file: ${settingsFile}. Fix it, or remove it to start with the default settings.`);
    return saved;
  };
  let config=readSettings()||{};
  registry.conversationDefaults = () => config.defaults;
  registry.verificationCadence = () => verificationCadence(config);
  registry.contextLimit = () => contextLimit(config);
  // The desktop app hears each saved appearance, so its window follows whichever request saved it.
  const saveSettings = patch => { config = { ...(readSettings() || config), ...patch }; atomicJSON(settingsFile, config); if (patch.appearance !== undefined) onAppearance(appearance(config)); };
  let sharing=(sharingURL||config.sharingURL)?new SharingClient({baseUrl:sharingURL||config.sharingURL,storePath:path.join(registry.dataRoot,'sharing-client.json'),createKey:process.env.AI_RELAY_SHARING_CREATE_KEY}):null;
  const configureSharing=input=>{const baseUrl=validateSharingURL(input.baseUrl);sharing=new SharingClient({baseUrl,storePath:path.join(registry.dataRoot,'sharing-client.json'),createKey:process.env.AI_RELAY_SHARING_CREATE_KEY});saveSettings({sharingURL:baseUrl});return {baseUrl};};
  const workspaceRoutes = createWorkspaceRoutes({ registry, body, json });
  const conversationRoutes = createConversationRoutes({ registry, body, json, importer });
  const reviewRoutes = createReviewRoutes({ registry, body, json });
  const checkpointRoutes = createCheckpointRoutes({ registry, body, json });
  const localRoutes = createLocalRoutes({ registry, body, json });
  const taskRoutes = createTaskRoutes({ registry, body, json });
  const commandRoutes = createCommandRoutes({ registry, body, json });
  const projectReviewRoutes = createProjectReviewRoutes({ registry, commands: commandRoutes.commands, body, json });
  const terminalRoutes = createTerminalRoutes({ registry, body, json });
  const voiceRoutes = createVoiceRoutes({ body, json, ...(voice ? { sessions: voice } : {}) });
  const listeners = new Set();
  let closing = false;
  registry.on('update', update => {
    for (const res of listeners) res.write(`event: update\ndata: ${JSON.stringify(update)}\n\n`);
  });
  registry.on('projects', () => {
    for (const res of listeners) res.write('event: projects\ndata: {}\n\n');
  });
  const notificationPreferences = () => alertPreferences(config.notifications);
  // Alert settings change from the desktop menus or from Settings; each change is saved whole and tells the others.
  const setNotificationPreferences = patch => {
    const next = mergeAlertPreferences(notificationPreferences(), patch);
    saveSettings({ notifications: next }); onNotifications(next);
    return next;
  };
  // limitAsked: the first usage limit has offered to turn automatic handoff on, so it isn't offered again.
  const handoffPreferences = () => ({ threshold: [0, 80, 90, 95].includes(config.handoff?.threshold) ? config.handoff.threshold : 90, automatic: config.handoff?.automatic === true, limitAsked: config.handoff?.limitAsked === true });
  registry.handoffPreferences = handoffPreferences;
  // Changed from the Agents panel or the desktop Agent menu; each tells the other.
  const setHandoffPreferences = patch => {
    const next = { ...handoffPreferences(), ...patch };
    if (![0, 80, 90, 95].includes(next.threshold) || typeof next.automatic !== 'boolean' || typeof next.limitAsked !== 'boolean') throw Object.assign(new Error('Offer a handoff at 80, 90 or 95 percent or never, and turn automatic handoff on or off.'), { status: 400 });
    saveSettings({ handoff: next }); onHandoff(next);
    return next;
  };
  registry.on('notify', notice => {
    try { onNotify(notice); } catch (error) { console.error('Codeshi could not show a notification:', error.message); }
    // The page plays the alert's sound, when sounds are on for its kind.
    const sound = alertSound(notice, notificationPreferences());
    if (sound) for (const res of listeners) res.write(`event: alert\ndata: ${JSON.stringify(sound)}\n\n`);
  });
  // Workspaces waiting for a usage limit to reset reopen at startup, so the wait continues after a restart.
  for (const project of registry.list()) {
    if (!fs.existsSync(path.join(registry.dataRoot, project.id, 'resume-pending'))) continue;
    try { registry.broker(project.id); } catch (error) { console.error(`Codeshi could not resume waiting work in ${project.name}:`, error.message); }
  }
  function selectedProjectId(url) {
    const id=url.searchParams.get('projectId');
    if(id){registry.get(id);return id;}
    const projects=registry.list();
    if(projects.length===1)return projects[0].id;
    throw Object.assign(new Error('Select a project workspace first.'),{status:400});
  }
  function selectedBroker(url) {return registry.broker(selectedProjectId(url));}
  const heartbeat = setInterval(() => { for (const res of listeners) res.write(': keepalive\n\n'); }, 15000);
  heartbeat.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (closing) return json(res, 503, { error: 'Codeshi is stopping.' });
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Only localhost is allowed.' });
      if (req.headers.origin && !allowedHosts.map(host => `http://${host}`).includes(req.headers.origin)) {
        return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      // A paired phone gets its own page, not the desktop one.
      if (req.method === 'GET' && url.pathname === '/' && req.phoneClient) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(root, 'public', 'phone.html')));
      }
      if (req.method === 'GET' && assets[url.pathname]) {
        const [filename, type] = assets[url.pathname];
        let contents = fs.readFileSync(path.join(root, 'public', filename));
        // The terminal's renderer adds its own <style> elements. Each page load gets a nonce that allows exactly those,
        // instead of allowing inline styles in general.
        if (url.pathname === '/') {
          const nonce = randomBytes(16).toString('base64');
          res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
          contents = String(contents).replace('<meta name="relay-style-nonce" content="" />', `<meta name="relay-style-nonce" content="${nonce}" />`);
        }
        res.writeHead(200, { 'Content-Type': type });
        return res.end(contents);
      }
      if (accessToken && req.headers['x-ai-relay-token'] !== accessToken && !(['/api/events', '/api/terminal/stream', '/api/voice/stream'].includes(url.pathname) && url.searchParams.get('token') === accessToken)) return json(res, 403, { error: 'Desktop session required.' });
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, registry.list());
      // What ran, changed and is waiting since a given time, across workspaces (#22).
      if (req.method === 'GET' && url.pathname === '/api/recap') return json(res, 200, buildRecap({ registry, since: url.searchParams.get('since') }));
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('event: ready\ndata: {}\n\n');
        listeners.add(res);
        req.on('close', () => listeners.delete(res));
        return;
      }
      if (req.method === 'POST') {
        if (req.headers['x-ai-relay'] !== '1') return json(res, 403, { error: 'Missing local application header.' });
        if (url.pathname === '/api/projects') {
          const input = await body(req);
          if (closing) return json(res, 503, { error: 'Codeshi is stopping.' });
          return json(res, 201, registry.add(input));
        }
      }
      if (url.pathname === '/api/phone') {
        if (req.phoneClient) return json(res, 403, { error: 'Manage remote access on the computer.' });
        if (req.method === 'GET') return json(res, 200, phoneAccess.status());
        if (req.method === 'POST') return json(res, 200, await phoneAccess.manage(await body(req, 4096)));
        return json(res, 405, { error: 'Use GET or POST for remote access.' });
      }
      if (url.pathname === '/api/preferences') {
        if (req.method === 'POST') saveSettings(preferencePatch(await body(req), config));
        else if (req.method !== 'GET') return json(res, 405, { error: 'Use GET or POST for preferences.' });
        return json(res, 200, publicPreferences(config, registry.list().length > 0));
      }
      if (url.pathname === '/api/notifications') {
        if (req.method === 'POST') return json(res, 200, setNotificationPreferences(await body(req, 4096)));
        if (req.method !== 'GET') return json(res, 405, { error: 'Use GET or POST for notifications.' });
        return json(res, 200, notificationPreferences());
      }
      if (url.pathname === '/api/appearance') {
        if (req.method === 'GET') return json(res, 200, { theme: appearance(config) });
        if (req.method !== 'POST') return json(res, 405, { error: 'Use GET or POST for appearance.' });
        const input = await body(req);
        if (!appearances.includes(input.theme)) return json(res, 400, { error: 'Choose System, Light, Dark or Graphite appearance.' });
        saveSettings({ appearance: input.theme });
        return json(res, 200, { theme: input.theme });
      }
      const workspaceAction = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/(remove|restore)$/);
      if (req.method === 'POST' && workspaceAction) {
        await body(req);
        return json(res, 200, registry[workspaceAction[2]](workspaceAction[1]));
      }
      const folderRoute=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/folders(?:\/([a-zA-Z0-9-]+)\/remove)?$/);
      if(req.method==='POST'&&folderRoute){
        const input=await body(req);
        const project=folderRoute[2]?await registry.removeFolder(folderRoute[1],folderRoute[2]):await registry.addFolder(folderRoute[1],input);
        return json(res,200,project);
      }
      const projectRoute=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)$/);
      if(req.method==='POST'&&projectRoute)return json(res,200,await registry.update(projectRoute[1],await body(req)));
      // Smart results (#139): worked out from this workspace's saved tasks on request, with no model call.
      if(req.method==='GET'&&url.pathname==='/api/results'){
        const broker=registry.broker(selectedProjectId(url)),days=url.searchParams.get('days'),raw=url.searchParams.get('baseline');
        let baseline=null;
        if(raw){try{baseline=JSON.parse(raw);}catch{baseline=null;}if(!baseline||typeof baseline.provider!=='string')throw Object.assign(new Error('Choose a manual baseline agent.'),{status:400});baseline={provider:baseline.provider,model:typeof baseline.model==='string'?baseline.model:null,effort:typeof baseline.effort==='string'?baseline.effort:null};}
        return json(res,200,await broker.results({days:days==='all'?null:Math.min(3650,Math.max(1,Number(days)||30)),baseline,exclude:(url.searchParams.get('exclude')||'').split(',').filter(Boolean).slice(0,1000),prompts:url.searchParams.get('prompts')==='1'}));
      }
      if(req.method==='GET'&&(url.pathname==='/api/ledger'||url.pathname==='/api/memory'||url.pathname==='/api/budget'||url.pathname==='/api/skills'||url.pathname==='/api/conversation/brief')){
        const projectId=selectedProjectId(url),broker=registry.broker(projectId),c=broker.get(registry.mainConversationId(projectId));
        return json(res,200,url.pathname==='/api/ledger'?await broker.ledger(c,{prompts:url.searchParams.get('prompts')==='1'}):url.pathname==='/api/memory'?broker.memory(c):url.pathname==='/api/budget'?broker.budget.view(c):url.pathname==='/api/skills'?broker.skills.view(c):broker.briefPreview(c));
      }
      if(req.method==='GET'&&url.pathname==='/api/conversation'){
        // ?tail=N is the short form for a phone: the latest messages and only what its page reads.
        const shape=view=>url.searchParams.has('tail')?phoneConversation(view,Number(url.searchParams.get('tail'))):view;
        const since=url.searchParams.has('since')?Number(url.searchParams.get('since')):null;
        const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):null;
        const before=url.searchParams.get('before')||null;
        const toRun=url.searchParams.get('toRun')||null;
        const toMessage=url.searchParams.get('toMessage')||null;
        const options={since,limit,before,toRun,toMessage};
        if(url.searchParams.get('task')){const projectId=selectedProjectId(url),broker=registry.broker(projectId),c=broker.get(registry.mainConversationId(projectId));return json(res,200,shape(broker.tasks.view(c,url.searchParams.get('task'),options)));}
        return json(res,200,shape(registry.mainConversation(selectedProjectId(url),options)));
      }
      if(req.method==='GET'&&url.pathname==='/api/conversation/search'){
        const projectId=selectedProjectId(url),broker=registry.broker(projectId);
        const task=url.searchParams.get('task');
        const mainConv=broker.get(registry.mainConversationId(projectId));
        const c=task?broker.tasks.find(mainConv,task):mainConv;
        const target=task?broker.tasks.lane(c,task)?.c||c:c;
        const q=(url.searchParams.get('q')||'').toLowerCase().trim();
        if(!q)return json(res,200,{query:q,matches:[]});
        const matches=[];
        for(let i=0;i<target.messages.length;i++){
          const m=target.messages[i];
          if(m.text&&m.text.toLowerCase().includes(q)){
            matches.push({index:i,id:m.id,role:m.role,runId:m.runId||null,text:m.text.slice(0,120)});
          }
        }
        return json(res,200,{query:q,total:target.messages.length,matches});
      }
      if (await projectReviewRoutes.route({ req, res, url })) return;
      if (await commandRoutes.route({ req, res, url })) return;
      if (await terminalRoutes.route({ req, res, url })) return;
      if (await voiceRoutes.route({ req, res, url })) return;
      if (await workspaceRoutes({ req, res, url })) return;
      if (await conversationRoutes({ req, res, url })) return;
      if (await reviewRoutes({ req, res, url })) return;
      if (await checkpointRoutes({ req, res, url })) return;
      if (await localRoutes({ req, res, url })) return;
      if (await taskRoutes({ req, res, url })) return;
      if (await collaborationRoute({req,res,url,registry,collaboration,sharing,configureSharing,body,json})) return;
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const broker = selectedBroker(url);
        const projectId = selectedProjectId(url);
        return json(res, 200, { ...await broker.status(), projectId, project: registry.get(projectId) });
      }
      if (req.method === 'GET' && url.pathname === '/api/conversations') return json(res, 200, selectedBroker(url).list());
      // Remembered approvals for the selected workspace: list, revoke one, or reset all.
      if (url.pathname === '/api/handoff-preferences') {
        if (req.method === 'GET') return json(res, 200, handoffPreferences());
        if (req.method === 'POST') { const input = await body(req); return json(res, 200, setHandoffPreferences({ ...(input.threshold !== undefined ? { threshold: input.threshold } : {}), ...(input.automatic !== undefined ? { automatic: input.automatic } : {}), ...(input.limitAsked !== undefined ? { limitAsked: input.limitAsked } : {}) })); }
      }
      if (url.pathname === '/api/permissions') {
        const broker = selectedBroker(url);
        if (req.method === 'GET') return json(res, 200, { rules: broker.permissions.list() });
        if (req.method === 'POST') {
          const input = await body(req);
          if (input.reset === true) broker.permissions.reset(); else broker.permissions.revoke(String(input.revoke || ''));
          return json(res, 200, { rules: broker.permissions.list() });
        }
      }
      if (req.method === 'POST') {
        if (url.pathname === '/api/conversations') {
          await body(req);
          if (closing) return json(res, 503, { error: 'Codeshi is stopping.' });
          const projectId=selectedProjectId(url),existed=Boolean(registry.get(projectId).conversationId);
          return json(res,existed?200:201,registry.mainConversation(projectId));
        }
      }
      const match = url.pathname.match(/^\/api\/conversations\/([\da-f-]{36})(?:\/(messages|continue|stop|provider|context|memory|budget|skills|approval|answer|resume|queue|handoff|steer|routing|retry|compact|execution-policy|orchestration))?$/);
      if (match) {
        const workspaceBroker = selectedBroker(url);
        // A conversation can belong to a task's lane (#88), which answers for its own run. Memory, skills, limits and the project
        // brief belong to the workspace, whichever conversation is open.
        const owner = workspaceBroker.conversations.has(match[1]) ? null : workspaceBroker.tasks?.owner(match[1]);
        const shared = owner && ['context', 'memory', 'skills', 'budget'].includes(match[2]);
        const broker = owner && !shared ? owner.broker : workspaceBroker;
        const c = shared ? owner.home : owner ? owner.c : broker.get(match[1]);
        if (req.method === 'GET' && !match[2]) return json(res, 200, broker.view(c));
        if (req.method === 'POST') {
          if(!owner&&registry.mainConversationId(selectedProjectId(url))!==c.id)return json(res,409,{error:'This project has one active chat. Open its project conversation to continue.'});
          const input = await body(req);
          if (closing) return json(res, 503, { error: 'Codeshi is stopping.' });
          const viewOptions = url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {};
          if (match[2] === 'execution-policy') return json(res, 200, broker.execution.change(c, input));
          if (match[2] === 'compact') return json(res, 200, broker.compactContext(c, input, viewOptions));
          if (match[2] === 'context') return json(res, 200, await broker.updateContext(c, input));
          if (match[2] === 'memory') return json(res, 200, broker.changeMemory(c, input));
          if (match[2] === 'skills') return json(res, 200, broker.skills.change(c, input));
          if (match[2] === 'budget') return json(res, 200, input.action === 'extend' ? broker.budget.extend(c, input) : input.action === 'reset' ? broker.budget.reset(c, input) : broker.budget.setPolicy(c, input.policy || {}));
          if (match[2] === 'approval') return json(res, 200, await broker.approve(input.runId, input.approvalId, input.allow === true, input.remember ?? null));
          if (match[2] === 'answer') return json(res, 200, await broker.answer(input.runId, input.questionId, input.skip === true ? null : input.answers, c));
          if (match[2] === 'provider') return json(res, 200, await broker.settings(c, input, viewOptions));
          if (match[2] === 'stop') return json(res, 200, broker.stop(c.id));
          if (match[2] === 'resume') return json(res, 200, input.cancel === true ? broker.cancelResume(c) : broker.scheduleResume(c, input));
          if (match[2] === 'queue') return json(res, 200, broker.queueAction(c, input));
          if (match[2] === 'steer') return json(res, 200, await broker.addToRun(c, input));
          if (match[2] === 'routing' && !Number.isSafeInteger(input.executionRevision)) return json(res, 409, { error: 'Refresh execution settings before changing routing.' });
          if (['messages', 'queue'].includes(match[2]) && input.routing && !Number.isSafeInteger(input.executionRevision)) return json(res, 409, { error: 'Refresh execution settings before delegating new work.' });
          if (match[2] === 'routing') return json(res, 200, broker.setRouting(c, input, viewOptions));
          if (match[2] === 'orchestration') return json(res, 200, broker.orchestrationAction(c, input));
          if (match[2] === 'retry') return json(res, input.accept === false ? 200 : 202, input.accept === false ? broker.dismissRetry(c, input.offerId) : broker.acceptRetry(c, input));
          if (match[2] === 'handoff') return json(res, input.accept === false ? 200 : 202, input.accept === false ? broker.dismissHandoff(c, input.offerId) : await broker.acceptHandoff(c, input));
          if (match[2] === 'messages') return json(res, 202, await broker.dispatch(c, input));
          if (match[2] === 'continue') return json(res, 202, await broker.continueTask(c, input));
        }
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!error.status) console.error('Codeshi request failed:', error.message);
      // A stale or unconfirmed handoff answers with the current offer, so the person can review it.
      return json(res, error.status || 500, { error: error.status ? error.message : 'Local server error. Check the terminal for details.', ...(error.status && 'offer' in error ? { offer: error.offer, billingRequired: error.billingRequired === true } : {}), ...(error.status && error.details ? { details: error.details } : {}) });
    }
  });

  const phoneBridge = { handle: (req, res) => server.emit('request', req, res), local: () => ({ port: server.address()?.port, accessToken }) };
  let remotePhoneConfig = phoneOptions?.remoteConfig;
  if (!remotePhoneConfig) { try { remotePhoneConfig = JSON.parse(fs.readFileSync(path.join(root, 'remote', 'firebase-public.json'), 'utf8')); } catch { /* Local Wi-Fi pairing works without a remote service. */ } }
  const remotePhone = createRemotePhoneAccess({ config: remotePhoneConfig, storeFile: path.join(registry.dataRoot, 'phone-firebase-auth.json'), ...phoneBridge, ...(phoneOptions?.remoteClientFactory ? { clientFactory: phoneOptions.remoteClientFactory } : {}) });
  registry.on('update', () => remotePhone.notify()); registry.on('projects', () => remotePhone.notify('projects'));
  const phoneAccess = createPhoneAccess({ ...phoneOptions, ...phoneBridge, remote: remotePhone });
  let closePromise;
  // force drops requests still in flight, such as account checks, for a desktop quit or restart, where the page goes away anyway.
  // Each step gets its turn even if an earlier one fails, and reports its time through onStep, so a slow shutdown can be traced.
  const close = ({ force = false, onStep = () => {} } = {}) => closePromise ||= (async () => {
    closing = true;
    let failure = null;
    const step = async (name, work) => {
      const started = Date.now();
      try { await work(); onStep({ name, ms: Date.now() - started }); }
      catch (error) { failure ||= error; onStep({ name, ms: Date.now() - started, error: error.message }); }
    };
    closeAccountConnections();
    await step('remote access', () => phoneAccess.close());
    await step('reviews', () => reviewRoutes.close());
    await step('project review', () => projectReviewRoutes.close());
    await step('commands', () => commandRoutes.close());
    await step('terminals', () => terminalRoutes.close());
    await step('voice', () => voiceRoutes.close());
    await step('workspaces', () => registry.close());
    clearInterval(heartbeat);
    for (const res of listeners) res.end();
    await step('connections', () => new Promise(resolve => { server.close(resolve); if (force) server.closeAllConnections(); }));
    if (failure) throw failure;
  })();
  return { server, registry, collaboration, sharing, commands: commandRoutes.commands, projectReview: projectReviewRoutes.review, terminals: terminalRoutes.sessions, close,
    getAppearancePreference: () => appearance(config),
    getKeepAwakePreference: () => config.keepAwake === true,
    // Handoff near a usage limit (#17): offered at 90% by default, automatic only when allowed, 0 turns offers off.
    getHandoffPreferences: () => handoffPreferences(),
    setHandoffPreferences,
    // Alerts outside the window (#46): on unless turned off, with sound only when asked for. On macOS, the status in
    // the menu bar shows unless hidden, and alerts near the top of the screen only when asked for (#13).
    getNotificationPreferences: () => notificationPreferences(),
    setNotificationPreferences,
    setKeepAwakePreference: enabled => { if (typeof enabled !== 'boolean') throw new Error('Keep awake must be enabled or disabled.'); saveSettings({ keepAwake: enabled }); },
    get broker() { const projects = registry.list(); return projects.length === 1 ? registry.broker(projects[0].id) : null; } };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Codeshi — shared Codex/Claude chats for your projects\n\nnpm run web -- [--workspace /absolute/project/path] [--port 4318]\n\nAdd projects in the browser, or repeat --workspace to register folders. Uses your installed CLIs and their existing logins.');
    return;
  }
  const options = { workspaces: [] };
  for (let i = 0; i < args.length; i += 2) {
    if (!['--workspace', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('Use --workspace PATH or --port NUMBER.');
    if (args[i] === '--workspace') options.workspaces.push(args[i + 1]);
    else options.port = args[i + 1];
  }
  const port = Number(options.port || process.env.AI_RELAY_PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  const app = createRelayServer({ workspaces: options.workspaces, dataRoot: process.env.AI_RELAY_DATA_DIR });
  app.server.once('error', async error => {
    console.error(`Could not start Codeshi: ${error.message}`);
    await app.close();
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Codeshi: http://127.0.0.1:${port}\n${app.registry.list().length} saved project(s). Add or switch projects in the browser.\nPress Ctrl+C to stop.`);
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

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
import { createTerminalRoutes } from './terminal.mjs';
import { createVoiceRoutes } from './voice.mjs';
import { buildRecap } from './recap.mjs';
import { createWorkspaceRoutes } from './workspace-routes.mjs';
import { randomBytes } from 'node:crypto';
import { createConversationRoutes } from './conversation-routes.mjs';
import { createReviewRoutes } from './agent-review-routes.mjs';
import { createLocalRoutes } from './local-models.mjs';
import { atomicJSON } from './patches.mjs';
import { continuationRequest } from './context.mjs';
import { appearance, appearances, preferencePatch, publicPreferences } from './preferences.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = { '/project-commands.js': ['project-commands.js', 'text/javascript; charset=utf-8'], '/project-commands.css': ['project-commands.css', 'text/css; charset=utf-8'], '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/desktop-controls.js': ['desktop-controls.js', 'text/javascript; charset=utf-8'], '/setup.js': ['setup.js', 'text/javascript; charset=utf-8'], '/polish.css': ['polish.css', 'text/css; charset=utf-8'], '/files.js': ['files.js', 'text/javascript; charset=utf-8'], '/files.css': ['files.css', 'text/css; charset=utf-8'], '/onboarding.css': ['onboarding.css', 'text/css; charset=utf-8'],
  '/model-picker.js': ['model-picker.js', 'text/javascript; charset=utf-8'], '/routing.js': ['routing.js', 'text/javascript; charset=utf-8'], '/layout.js': ['layout.js', 'text/javascript; charset=utf-8'], '/agents-panel.js': ['agents-panel.js', 'text/javascript; charset=utf-8'], '/model-picker.css': ['model-picker.css', 'text/css; charset=utf-8'],
  '/bottom-panel.js': ['bottom-panel.js', 'text/javascript; charset=utf-8'], '/preview.js': ['preview.js', 'text/javascript; charset=utf-8'], '/terminal.js': ['terminal.js', 'text/javascript; charset=utf-8'], '/terminal.css': ['terminal.css', 'text/css; charset=utf-8'],
  '/voice.js': ['voice.js', 'text/javascript; charset=utf-8'], '/voice.css': ['voice.css', 'text/css; charset=utf-8'],
  '/recap.js': ['recap.js', 'text/javascript; charset=utf-8'], '/recap.css': ['recap.css', 'text/css; charset=utf-8'],
  // The terminal renderer, served from the installed package so packaged builds work offline.
  '/vendor/xterm.js': ['../node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'], '/vendor/xterm.css': ['../node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'], '/vendor/addon-fit.js': ['../node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
  '/updates.js': ['updates.js', 'text/javascript; charset=utf-8'], '/updater.js': ['updater.js', 'text/javascript; charset=utf-8'], '/updates.css': ['updates.css', 'text/css; charset=utf-8'],
  '/local-models.js': ['local-models.js', 'text/javascript; charset=utf-8'], '/local-models.css': ['local-models.css', 'text/css; charset=utf-8'],
  '/agent-review.js': ['agent-review.js', 'text/javascript; charset=utf-8'], '/agent-review.css': ['agent-review.css', 'text/css; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'], '/editor-theme.css': ['editor-theme.css', 'text/css; charset=utf-8'], '/insights.js': ['insights.js', 'text/javascript; charset=utf-8'], '/conversation-history.js': ['conversation-history.js', 'text/javascript; charset=utf-8'], '/conversation-search.js': ['conversation-search.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/workbench.js': ['workbench.js', 'text/javascript; charset=utf-8'], '/workbench.css': ['workbench.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
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

export function createRelayServer({ workspace, workspaces = [], dataRoot, dataDir, bins, lock = true, sharingURL = process.env.AI_RELAY_SHARING_URL, accessToken, importer, onAppearance = () => {}, onNotify = () => {}, onHandoff = () => {}, voice } = {}) {
  const registry = new ProjectRegistry({ dataRoot: dataRoot || dataDir || path.join(root, '.data'), bins, lock });
  for (const folder of [...(workspace ? [workspace] : []), ...workspaces]) registry.add({ path: folder });
  const collaboration = new CollaborationService({ registry, dataRoot: registry.dataRoot });
  const settingsFile=path.join(registry.dataRoot,'settings.json');
  // Settings are saved whole, so a file that can't be read was changed outside Throughline. It is named instead of
  // replaced with defaults, which would quietly turn a saved Read only default back into Can edit files.
  const readSettings=()=>{
    if(!fs.existsSync(settingsFile))return null;
    let saved;try{saved=JSON.parse(fs.readFileSync(settingsFile,'utf8'));}catch{}
    if(!saved||typeof saved!=='object'||Array.isArray(saved))throw new Error(`Cannot read the settings file: ${settingsFile}. Fix it, or remove it to start with the default settings.`);
    return saved;
  };
  let config=readSettings()||{};
  registry.conversationDefaults = () => config.defaults;
  // The desktop app hears each saved appearance, so its window follows whichever request saved it.
  const saveSettings = patch => { config = { ...(readSettings() || config), ...patch }; atomicJSON(settingsFile, config); if (patch.appearance !== undefined) onAppearance(appearance(config)); };
  let sharing=(sharingURL||config.sharingURL)?new SharingClient({baseUrl:sharingURL||config.sharingURL,storePath:path.join(registry.dataRoot,'sharing-client.json'),createKey:process.env.AI_RELAY_SHARING_CREATE_KEY}):null;
  const configureSharing=input=>{const baseUrl=validateSharingURL(input.baseUrl);sharing=new SharingClient({baseUrl,storePath:path.join(registry.dataRoot,'sharing-client.json'),createKey:process.env.AI_RELAY_SHARING_CREATE_KEY});saveSettings({sharingURL:baseUrl});return {baseUrl};};
  const workspaceRoutes = createWorkspaceRoutes({ registry, body, json });
  const conversationRoutes = createConversationRoutes({ registry, body, json, importer });
  const reviewRoutes = createReviewRoutes({ registry, body, json });
  const localRoutes = createLocalRoutes({ registry, body, json });
  const commandRoutes = createCommandRoutes({ registry, body, json });
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
  const notificationPreferences = () => ({ enabled: config.notifications?.enabled !== false, sound: config.notifications?.sound === true, statusItem: config.notifications?.statusItem !== false, overlay: config.notifications?.overlay === true });
  const handoffPreferences = () => ({ threshold: [0, 80, 90, 95].includes(config.handoff?.threshold) ? config.handoff.threshold : 90, automatic: config.handoff?.automatic === true });
  registry.handoffPreferences = handoffPreferences;
  // Changed from the Agents panel or the desktop Agent menu; each tells the other.
  const setHandoffPreferences = patch => {
    const next = { ...handoffPreferences(), ...patch };
    if (![0, 80, 90, 95].includes(next.threshold) || typeof next.automatic !== 'boolean') throw Object.assign(new Error('Offer a handoff at 80, 90 or 95 percent or never, and turn automatic handoff on or off.'), { status: 400 });
    saveSettings({ handoff: next }); onHandoff(next);
    return next;
  };
  registry.on('notify', notice => { try { onNotify(notice); } catch (error) { console.error('Throughline could not show a notification:', error.message); } });
  // Workspaces waiting for a usage limit to reset reopen at startup, so the wait continues after a restart.
  for (const project of registry.list()) {
    if (!fs.existsSync(path.join(registry.dataRoot, project.id, 'resume-pending'))) continue;
    try { registry.broker(project.id); } catch (error) { console.error(`Throughline could not resume waiting work in ${project.name}:`, error.message); }
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
      if (closing) return json(res, 503, { error: 'Throughline is stopping.' });
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Only localhost is allowed.' });
      if (req.headers.origin && !allowedHosts.map(host => `http://${host}`).includes(req.headers.origin)) {
        return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
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
          if (closing) return json(res, 503, { error: 'Throughline is stopping.' });
          return json(res, 201, registry.add(input));
        }
      }
      if (url.pathname === '/api/preferences') {
        if (req.method === 'POST') saveSettings(preferencePatch(await body(req), config));
        else if (req.method !== 'GET') return json(res, 405, { error: 'Use GET or POST for preferences.' });
        return json(res, 200, publicPreferences(config, registry.list().length > 0));
      }
      if (url.pathname === '/api/appearance') {
        if (req.method === 'GET') return json(res, 200, { theme: appearance(config) });
        if (req.method !== 'POST') return json(res, 405, { error: 'Use GET or POST for appearance.' });
        const input = await body(req);
        if (!appearances.includes(input.theme)) return json(res, 400, { error: 'Choose System, Light or Dark appearance.' });
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
      if(req.method==='GET'&&url.pathname==='/api/conversation')return json(res,200,registry.mainConversation(selectedProjectId(url)));
      if (await commandRoutes.route({ req, res, url })) return;
      if (await terminalRoutes.route({ req, res, url })) return;
      if (await voiceRoutes.route({ req, res, url })) return;
      if (await workspaceRoutes({ req, res, url })) return;
      if (await conversationRoutes({ req, res, url })) return;
      if (await reviewRoutes({ req, res, url })) return;
      if (await localRoutes({ req, res, url })) return;
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
        if (req.method === 'POST') { const input = await body(req); return json(res, 200, setHandoffPreferences({ ...(input.threshold !== undefined ? { threshold: input.threshold } : {}), ...(input.automatic !== undefined ? { automatic: input.automatic } : {}) })); }
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
          if (closing) return json(res, 503, { error: 'Throughline is stopping.' });
          const projectId=selectedProjectId(url),existed=Boolean(registry.get(projectId).conversationId);
          return json(res,existed?200:201,registry.mainConversation(projectId));
        }
      }
      const match = url.pathname.match(/^\/api\/conversations\/([\da-f-]{36})(?:\/(messages|continue|stop|provider|context|approval|resume|queue|handoff|steer|routing|retry))?$/);
      if (match) {
        const broker = selectedBroker(url);
        const c = broker.get(match[1]);
        if (req.method === 'GET' && !match[2]) return json(res, 200, broker.view(c));
        if (req.method === 'POST') {
          if(registry.mainConversation(selectedProjectId(url)).id!==c.id)return json(res,409,{error:'This project has one active chat. Open its project conversation to continue.'});
          const input = await body(req);
          if (closing) return json(res, 503, { error: 'Throughline is stopping.' });
          if (match[2] === 'context') return json(res, 200, await broker.updateContext(c, input));
          if (match[2] === 'approval') return json(res, 200, await broker.approve(input.runId, input.approvalId, input.allow === true, input.remember ?? null));
          if (match[2] === 'provider') return json(res, 200, await broker.settings(c, input));
          if (match[2] === 'stop') return json(res, 200, broker.stop(c.id));
          if (match[2] === 'resume') return json(res, 200, input.cancel === true ? broker.cancelResume(c) : broker.scheduleResume(c, input));
          if (match[2] === 'queue') return json(res, 200, broker.queueAction(c, input));
          if (match[2] === 'steer') return json(res, 200, await broker.addToRun(c, input));
          if (match[2] === 'routing') return json(res, 200, broker.setRouting(c, input));
          if (match[2] === 'retry') return json(res, input.accept === false ? 200 : 202, input.accept === false ? broker.dismissRetry(c, input.offerId) : broker.acceptRetry(c, input));
          if (match[2] === 'handoff') return json(res, input.accept === false ? 200 : 202, input.accept === false ? broker.dismissHandoff(c, input.offerId) : await broker.acceptHandoff(c, input));
          if (match[2] === 'messages') return json(res, 202, await broker.start(c, input));
          if (match[2] === 'continue') return json(res, 202, await broker.start(c, { ...input,
            fresh: true,
            text: continuationRequest }));
        }
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!error.status) console.error('Throughline request failed:', error.message);
      // A stale or unconfirmed handoff answers with the current offer, so the person can review it.
      return json(res, error.status || 500, { error: error.status ? error.message : 'Local server error. Check the terminal for details.', ...(error.status && 'offer' in error ? { offer: error.offer, billingRequired: error.billingRequired === true } : {}), ...(error.status && error.details ? { details: error.details } : {}) });
    }
  });

  let closePromise;
  // force drops requests still in flight, such as launch-time account checks, for a restart where the page reloads anyway.
  const close = ({ force = false } = {}) => closePromise ||= (async () => {
    closing = true;
    closeAccountConnections();
    await reviewRoutes.close();
    await commandRoutes.close();
    await terminalRoutes.close();
    await voiceRoutes.close();
    await registry.close();
    clearInterval(heartbeat);
    for (const res of listeners) res.end();
    await new Promise(resolve => { server.close(resolve); if (force) server.closeAllConnections(); });
  })();
  return { server, registry, collaboration, sharing, commands: commandRoutes.commands, terminals: terminalRoutes.sessions, close,
    getAppearancePreference: () => appearance(config),
    getKeepAwakePreference: () => config.keepAwake === true,
    // Handoff near a usage limit (#17): offered at 90% by default, automatic only when allowed, 0 turns offers off.
    getHandoffPreferences: () => handoffPreferences(),
    setHandoffPreferences,
    // Alerts outside the window (#46): on unless turned off, with sound only when asked for. On macOS, the status in
    // the menu bar shows unless hidden, and alerts near the top of the screen only when asked for (#13).
    getNotificationPreferences: () => notificationPreferences(),
    setNotificationPreferences: patch => {
      const next = { ...notificationPreferences(), ...patch };
      if (Object.keys(next).length !== 4 || !Object.values(next).every(value => typeof value === 'boolean')) throw new Error('Notifications must be turned on or off.');
      saveSettings({ notifications: next });
    },
    setKeepAwakePreference: enabled => { if (typeof enabled !== 'boolean') throw new Error('Keep awake must be enabled or disabled.'); saveSettings({ keepAwake: enabled }); },
    get broker() { const projects = registry.list(); return projects.length === 1 ? registry.broker(projects[0].id) : null; } };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Throughline — shared Codex/Claude chats for your projects\n\nnpm run web -- [--workspace /absolute/project/path] [--port 4318]\n\nAdd projects in the browser, or repeat --workspace to register folders. Uses your installed CLIs and their existing logins.');
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
    console.error(`Could not start Throughline: ${error.message}`);
    await app.close();
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Throughline: http://127.0.0.1:${port}\n${app.registry.list().length} saved project(s). Add or switch projects in the browser.\nPress Ctrl+C to stop.`);
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

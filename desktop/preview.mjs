import path from 'node:path';

// Point and tell (#19): the workspace's app in a preview window, where clicking an element puts what it is into the
// message box, with a screenshot of it, for the person to say or type what should change.
//
// The preview is its own window: a toolbar the app trusts above the page, each in its own view. The page only ever
// shows local addresses, keeps its cookies and storage apart from Codeshi's, and cannot open windows, download
// files or be given permissions. The element picker runs in the page's isolated world, so the page's scripts cannot
// see or change it, and it never gives the page anything. What the picker reports is data: cleaned, bounded and
// described in a sentence the person reads before sending. The helpers are pure, for tests; createPreview needs
// Electron's classes.
export const PREVIEW_PARTITION = 'persist:throughline-preview';
// The Stack and API inspector (#143) sits to the right of the page, under the toolbar's bar, so the page keeps its
// full height. It is 380 px, 440 px in a window at least 1280 px wide, and always leaves the page 240 px. The toolbar's
// CSS draws it by the same rule, so keep the two in step.
export const INSPECTOR_WIDTH = Object.freeze({ narrow: 380, wide: 440, wideFrom: 1280, pageMin: 240 });
export function inspectorWidth(width) {
  const { narrow, wide, wideFrom, pageMin } = INSPECTOR_WIDTH;
  return Math.max(0, Math.min(width >= wideFrom ? wide : narrow, width - pageMin));
}
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const clip = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };

export function previewURL(input) {
  let url;
  try { url = new URL(String(input ?? '').trim()); } catch { throw new Error('Enter a local address, such as http://localhost:5173.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.includes(url.hostname) || url.username || url.password) throw new Error('The preview opens local addresses only, such as http://localhost:5173.');
  return url.href;
}
export const isPreviewURL = value => { try { previewURL(value); return true; } catch { return false; } };

// What the picker reports, kept to plain, bounded values.
export function cleanElement(input = {}) {
  const text = (value, max) => typeof value === 'string' ? clip(value, max) : '';
  const tag = typeof input.tag === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(input.tag) ? input.tag : 'element';
  const attribute = input.attributeSource && typeof input.attributeSource.file === 'string' ? { file: text(input.attributeSource.file, 300), ...(Number.isSafeInteger(input.attributeSource.line) && input.attributeSource.line > 0 ? { line: input.attributeSource.line } : {}) } : null;
  return { tag, text: text(input.text, 120), label: text(input.label, 120), selector: text(input.selector, 300), ...(attribute ? { attributeSource: attribute } : {}) };
}

// A file the app reported, in the workspace's own terms: relative to its folder (named first when there are
// several). Absolute paths outside the workspace are left out.
function workspaceFile(value, folders) {
  let file = String(value || '');
  if (/^https?:\/\//i.test(file)) {
    try { file = decodeURIComponent(new URL(file).pathname); } catch { return null; }
    // Vite serves files outside its root under /@fs/ followed by their absolute path, which on Windows starts with
    // its drive: /@fs/D:/work/app.
    file = file.startsWith('/@fs/') ? file.slice(4).replace(/^\/(?=[A-Za-z]:\/)/, '') : file.replace(/^\/+/, '');
  }
  if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) {
    for (const folder of folders) {
      const relative = path.relative(folder.path, file);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return (folders.length > 1 ? `${folder.name}/` : '') + relative.split(path.sep).join('/');
    }
    return null;
  }
  return clip(file.replace(/\\/g, '/'), 300) || null;
}

// Where a picked element is written, as far as the app's development build says: React 18 and earlier record the
// file and line of each element, React 19 only the stack where it was created, Vue the component's file and Svelte the
// element's own line. Inspector plugins write it on the element instead. A line found from a stack is approximate.
export function sourceLocation(hint, { folders = [] } = {}) {
  if (!hint || typeof hint !== 'object') return null;
  const component = typeof hint.component === 'string' && /^[\w$.-]{1,80}$/.test(hint.component) ? hint.component : null;
  let file = null, line = null, approximate = false;
  if (hint.source && typeof hint.source.file === 'string') { file = hint.source.file; line = hint.source.line; }
  else if (typeof hint.file === 'string') { file = hint.file; line = hint.line; }
  else if (typeof hint.stack === 'string') {
    for (const match of hint.stack.slice(0, 4000).matchAll(/(https?:\/\/[^\s)]+?):(\d+):\d+/g)) {
      if (/\/node_modules\/|\/@vite\/|\/@react-refresh|\/\.vite\/deps\/|react-dom|jsx-(?:dev-)?runtime/.test(match[1])) continue;
      file = match[1]; line = Number(match[2]); approximate = true; break;
    }
  }
  const relative = file ? workspaceFile(file, folders) : null;
  if (!relative) return component ? { component } : null;
  return { file: relative, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}), ...(component ? { component } : {}), ...(approximate ? { approximate } : {}) };
}

// The sentence put into the message box: where the element is, what it is and where its code is.
const KINDS = { a: 'link', button: 'button', input: 'field', textarea: 'text box', select: 'menu', img: 'image', svg: 'icon', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation', form: 'form', label: 'label', li: 'list item', ul: 'list', ol: 'list', table: 'table', p: 'paragraph', header: 'header', footer: 'footer', section: 'section', dialog: 'dialog' };
export function pickText({ element, url, source }) {
  let where = 'the preview';
  try { const parsed = new URL(url); where = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname); } catch { /* The page's address is unknown. */ }
  const kind = KINDS[element.tag] || `<${element.tag}> element`, name = element.text || element.label;
  const code = source?.file ? `${source.file}${source.line ? `:${source.line}` : ''}${source.component ? ` in ${source.component}` : ''}` : source?.component ? `in ${source.component}` : '';
  const details = [element.selector, code].filter(Boolean).join('; ');
  return `In the preview of ${where}, the ${name ? `“${clip(name, 60)}” ` : ''}${kind}${details ? ` (${details})` : ''}: `;
}

// The area to capture: the element and a little around it, kept inside the visible page.
export function captureRect(rect, viewport, padding = 8) {
  const numbers = [rect?.x, rect?.y, rect?.width, rect?.height, viewport?.width, viewport?.height];
  if (!numbers.every(Number.isFinite)) return null;
  const left = Math.max(0, Math.floor(rect.x - padding)), top = Math.max(0, Math.floor(rect.y - padding));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + padding)), bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + padding));
  return right - left >= 1 && bottom - top >= 1 ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

// Run in the page's own world, once, to read what its framework knows about the picked element, which the isolated
// world cannot see. It finds the element by a one-time mark the picker set, removes the mark and returns plain data.
export function sourceScript(nonce) {
  return `(() => {
    const element = document.querySelector('[data-codeshi-pick=${JSON.stringify(nonce)}]');
    if (!element) return null;
    element.removeAttribute('data-codeshi-pick');
    const text = value => typeof value === 'string' ? value.slice(0, 2000) : null;
    const reactKey = Object.keys(element).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
    if (reactKey) {
      let component = null, source = null, stack = null;
      for (let fiber = element[reactKey], depth = 0; fiber && depth < 60; fiber = fiber.return, depth++) {
        if (!component && fiber.type && typeof fiber.type !== 'string') component = fiber.type.displayName || fiber.type.name || null;
        if (!source && fiber._debugSource) source = { file: text(fiber._debugSource.fileName), line: fiber._debugSource.lineNumber };
        if (!stack && fiber._debugStack && fiber._debugStack.stack) stack = text(String(fiber._debugStack.stack));
        if (component && (source || stack)) break;
      }
      return { component: text(component), source, stack };
    }
    const vue = element.__vueParentComponent;
    if (vue && vue.type) return { component: text(vue.type.name || vue.type.__name || null), source: vue.type.__file ? { file: text(vue.type.__file) } : null };
    const svelte = element.__svelte_meta;
    if (svelte && svelte.loc) return { source: { file: text(svelte.loc.file), line: svelte.loc.line + 1 } };
    return null;
  })()`;
}

export function apiInterceptorScript() {
  return `(() => {
    if (window.__codeshi_api_installed__) return;
    window.__codeshi_api_installed__ = true;
    let lastClick = null;
    window.addEventListener("click", event => {
      const el = event.target;
      if (!el || el.nodeType !== 1) return;
      const text = (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 50);
      lastClick = { tag: el.tagName.toLowerCase(), text, time: Date.now() };
    }, true);
    function clip(val, max = 32768) {
      if (typeof val !== "string") return null;
      return val.length > max ? val.slice(0, max) + "… [truncated]" : val;
    }
    function report(call) {
      window.postMessage({ type: "codeshi:api-call", call }, "*");
    }
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = async function(...args) {
        const start = Date.now(), id = Math.random().toString(36).slice(2, 10);
        let url = "", method = "GET", reqHeaders = {}, reqBody = null;
        try {
          const input = args[0], init = args[1] || {};
          if (typeof input === "string") url = input;
          else if (input instanceof URL) url = input.href;
          else if (input && typeof input === "object") { url = input.url || ""; method = input.method || "GET"; }
          if (init.method) method = init.method;
          if (init.headers) {
            if (init.headers instanceof Headers) init.headers.forEach((v, k) => { reqHeaders[k] = v; });
            else if (typeof init.headers === "object") reqHeaders = { ...init.headers };
          }
          if (init.body) {
            if (typeof init.body === "string") reqBody = init.body;
            else if (init.body instanceof URLSearchParams) reqBody = init.body.toString();
            else if (init.body instanceof FormData) {
              const entries = [];
              init.body.forEach((v, k) => entries.push(k + "=" + (typeof v === "string" ? v : "[File]")));
              reqBody = entries.join("&");
            } else {
              try { reqBody = JSON.stringify(init.body); } catch { reqBody = "[Object]"; }
            }
          }
          try { url = new URL(url, location.href).href; } catch {}
        } catch {}
        const trigger = (lastClick && (start - lastClick.time < 2000)) ? { ...lastClick } : null;
        try {
          const response = await origFetch.apply(this, args);
          const duration = Date.now() - start;
          let resBody = "";
          try { resBody = await response.clone().text(); } catch {}
          const resHeaders = {};
          try { response.headers.forEach((v, k) => { resHeaders[k] = v; }); } catch {}
          report({ id, type: "fetch", url, method: method.toUpperCase(), status: response.status, statusText: response.statusText, duration, request: { headers: reqHeaders, body: clip(reqBody) }, response: { headers: resHeaders, body: clip(resBody) }, trigger, time: new Date().toISOString() });
          return response;
        } catch (err) {
          const duration = Date.now() - start;
          report({ id, type: "fetch", url, method: method.toUpperCase(), status: 0, statusText: "Network Error", duration, request: { headers: reqHeaders, body: clip(reqBody) }, response: { headers: {}, body: String(err?.message || err) }, error: String(err?.message || err), trigger, time: new Date().toISOString() });
          throw err;
        }
      };
    }
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      function WrappedXHR() {
        const xhr = new OrigXHR();
        let method = "GET", url = "", reqHeaders = {}, reqBody = null, start = 0;
        const id = Math.random().toString(36).slice(2, 10);
        const origOpen = xhr.open;
        xhr.open = function(m, u, ...rest) {
          method = m || "GET"; url = u || "";
          try { url = new URL(url, location.href).href; } catch {}
          return origOpen.call(xhr, m, u, ...rest);
        };
        const origSetHeader = xhr.setRequestHeader;
        xhr.setRequestHeader = function(k, v) { reqHeaders[k] = v; return origSetHeader.call(xhr, k, v); };
        const origSend = xhr.send;
        xhr.send = function(body) {
          start = Date.now();
          const trigger = (lastClick && (start - lastClick.time < 2000)) ? { ...lastClick } : null;
          if (typeof body === "string") reqBody = body;
          else if (body instanceof URLSearchParams) reqBody = body.toString();
          else if (body) reqBody = "[Payload]";
          xhr.addEventListener("loadend", () => {
            const duration = Date.now() - start, resHeaders = {};
            try {
              (xhr.getAllResponseHeaders() || "").split(/\\r?\\n/).forEach(line => {
                const colon = line.indexOf(":");
                if (colon > 0) resHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
              });
            } catch {}
            report({ id, type: "xhr", url, method: method.toUpperCase(), status: xhr.status, statusText: xhr.statusText, duration, request: { headers: reqHeaders, body: clip(reqBody) }, response: { headers: resHeaders, body: clip(xhr.responseText) }, trigger, time: new Date().toISOString() });
          });
          return origSend.call(xhr, body);
        };
        return xhr;
      }
      WrappedXHR.prototype = OrigXHR.prototype;
      window.XMLHttpRequest = WrappedXHR;
    }
  })()`;
}

export function createPreview({ BaseWindow, WebContentsView, session, ipcMain, shell, root, folders = () => [], onPick = () => {}, toolbarHeight = 44, background = () => '#1c1a18', captureWait = 1500, platform = process.platform }) {
  let win = null, toolbar = null, page = null, projectId = null, workspace = '', picking = false, pickCount = 0, capture = 'none', inspector = false, lastStack = null;
  const apiCalls = [];
  const previewSession = session.fromPartition(PREVIEW_PARTITION);
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.on('will-download', event => event.preventDefault());
  const alive = view => Boolean(view && !view.webContents.isDestroyed());
  const own = (event, view) => alive(view) && event.sender === view.webContents;
  const toToolbar = (channel, value) => { if (alive(toolbar)) toolbar.webContents.send(channel, value); };

  function state() {
    const contents = alive(page) ? page.webContents : null, history = contents?.navigationHistory;
    return { url: contents?.getURL() || '', title: contents?.getTitle() || '', loading: Boolean(contents?.isLoading()), back: Boolean(history?.canGoBack()), forward: Boolean(history?.canGoForward()), picking, workspace };
  }
  function sync() {
    const value = state();
    toToolbar('preview:state', value);
    if (lastStack) toToolbar('preview:stack', lastStack);
    if (win && !win.isDestroyed()) { let host = ''; try { host = new URL(value.url).host; } catch { /* Not loaded yet. */ } win.setTitle(host ? `Preview · ${host}` : 'Preview'); }
  }
  // With the inspector open, the toolbar's view fills the window behind the page, and the page gives up width on the
  // right for it, never height.
  function layout() {
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds(), side = inspector ? inspectorWidth(width) : 0;
    toolbar.setBounds({ x: 0, y: 0, width, height: side ? height : toolbarHeight });
    page.setBounds({ x: 0, y: toolbarHeight, width: width - side, height: Math.max(0, height - toolbarHeight) });
  }
  // ⇧⌘I, or Ctrl+Shift+I, shows or hides the inspector from either view. The page never sees those keys.
  const mac = platform === 'darwin';
  const toggleKey = input => input?.type === 'keyDown' && !input.isAutoRepeat && input.code === 'KeyI' && input.shift && !input.alt && (mac ? input.meta && !input.control : input.control && !input.meta);
  const onKey = (event, input) => { if (!toggleKey(input)) return; event.preventDefault(); toToolbar('preview:toggle-inspector'); };
  function create() {
    win = new BaseWindow({ width: 1180, height: 820, minWidth: 480, minHeight: 320, title: 'Preview', backgroundColor: background() });
    toolbar = new WebContentsView({ webPreferences: { preload: path.join(root, 'desktop', 'preview-toolbar-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    page = new WebContentsView({ webPreferences: { partition: PREVIEW_PARTITION, preload: path.join(root, 'desktop', 'preview-page-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
    inspector = false;
    // The page goes above the toolbar's view, which fills the window behind it while the inspector is open.
    win.contentView.addChildView(toolbar); win.contentView.addChildView(page);
    toolbar.webContents.on('before-input-event', onKey);
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    toolbar.webContents.on('will-navigate', event => event.preventDefault());
    toolbar.webContents.loadFile(path.join(root, 'desktop', 'preview-toolbar.html'));
    toolbar.webContents.once('did-finish-load', sync);
    const contents = page.webContents;
    contents.on('before-input-event', onKey);
    const injectInterceptor = () => { if (alive(page)) page.webContents.executeJavaScript(apiInterceptorScript()).catch(() => {}); };
    contents.on('did-start-navigation', injectInterceptor);
    contents.on('did-finish-load', injectInterceptor);
    // Local addresses stay in the preview; https links open in the browser; nothing opens a window.
    contents.setWindowOpenHandler(({ url }) => { if (isPreviewURL(url)) contents.loadURL(url); else if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    const guard = (event, url) => { if (isPreviewURL(url)) return; event.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); };
    contents.on('will-navigate', guard); contents.on('will-redirect', guard);
    for (const name of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) contents.on(name, sync);
    contents.on('did-navigate', () => { picking = false; });
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => { if (mainFrame && code !== -3) toToolbar('preview:error', `${url} could not load (${description}). Is the dev server running?`); });
    win.on('resize', layout); layout();
    win.on('closed', () => { win = toolbar = page = null; picking = false; lastEdit = null; });
  }
  async function open({ projectId: id = null, url, workspace: name = '' }) {
    const href = previewURL(url);
    projectId = id; workspace = String(name || '').slice(0, 120); picking = false;
    if (!win || win.isDestroyed()) create();
    win.show(); win.focus();
    await page.webContents.loadURL(href).catch(() => {});
    sync();
    return true;
  }
  function setPicking(on) {
    if (!alive(page)) return;
    picking = Boolean(on);
    page.webContents.send('preview:picking', picking);
    sync();
    if (picking) page.webContents.focus();
  }

  async function finish(pick) {
    const contents = page.webContents, element = cleanElement(pick?.element), url = contents.getURL();
    let hint = null;
    if (typeof pick?.nonce === 'string' && /^[a-z0-9]{8,40}$/.test(pick.nonce)) { try { hint = await contents.executeJavaScript(sourceScript(pick.nonce)); } catch { hint = null; } }
    const source = sourceLocation(hint, { folders: folders(projectId) }) || sourceLocation(element.attributeSource, { folders: folders(projectId) });
    const rect = captureRect(pick?.rect, pick?.viewport);
    let image = null;
    // The screenshot helps but never holds up the pick. A blank one (from a view that has not painted yet) is taken
    // once more; a capture that hangs, as it can on a covered window, is left out. How it went is kept for checks.
    capture = rect ? 'blank' : 'none';
    for (let attempt = 0; rect && !image && attempt < 2; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
      let shot = await Promise.race([contents.capturePage(rect).catch(() => null), new Promise(resolve => setTimeout(resolve, captureWait, 'hung'))]);
      if (shot === 'hung') { capture = 'hung'; break; }
      if (shot && !shot.isEmpty()) { if (shot.getSize().width > 1600) shot = shot.resize({ width: 1600 }); image = { name: `preview-${element.tag}.png`, data: shot.toPNG().toString('base64') }; capture = 'captured'; }
    }
    const value = { projectId, url, element, source, image, text: pickText({ element, url, source }) };
    pickCount++;
    onPick(value);
    toToolbar('preview:picked', { text: value.text, count: pickCount });
    return value;
  }

  const onToolbar = (event, action, value) => {
    if (!own(event, toolbar) || !alive(page)) return;
    const contents = page.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'pick') setPicking(!picking);
    else if (action === 'open-external' && isPreviewURL(contents.getURL())) shell.openExternal(contents.getURL());
    else if (action === 'navigate') { try { contents.loadURL(previewURL(value)).catch(() => {}); } catch (error) { toToolbar('preview:error', error.message); } }
    else if (action === 'focus-app') onPick({ projectId, focus: true });
    else if (action === 'show-inspector' || action === 'hide-inspector') { inspector = action === 'show-inspector'; layout(); }
    else if (action === 'navigate-preview') { try { contents.loadURL(previewURL(value)).catch(() => {}); } catch {} }
  };
  const onPicked = (event, pick) => { if (!own(event, page) || !picking) return; picking = false; sync(); finish(pick).catch(error => toToolbar('preview:error', `The element could not be picked: ${error.message}`)); };
  const onCancelled = event => { if (own(event, page)) { picking = false; sync(); } };
  ipcMain.on('preview:toolbar', onToolbar); ipcMain.on('preview:picked', onPicked); ipcMain.on('preview:pick-cancelled', onCancelled);
  const onApiCall = (event, call) => {
    if (!own(event, page) || !call) return;
    const item = {
      id: String(call.id || Math.random().toString(36).slice(2, 10)),
      type: call.type === 'xhr' ? 'XHR' : 'Fetch',
      url: String(call.url || '').slice(0, 2000),
      method: String(call.method || 'GET').slice(0, 10).toUpperCase(),
      status: Number.isInteger(call.status) ? call.status : 0,
      statusText: String(call.statusText || '').slice(0, 50),
      duration: Math.max(0, Number(call.duration) || 0),
      request: {
        headers: call.request?.headers && typeof call.request.headers === 'object' ? call.request.headers : {},
        body: typeof call.request?.body === 'string' ? call.request.body.slice(0, 65536) : null,
      },
      response: {
        headers: call.response?.headers && typeof call.response.headers === 'object' ? call.response.headers : {},
        body: typeof call.response?.body === 'string' ? call.response.body.slice(0, 65536) : null,
      },
      error: call.error ? String(call.error).slice(0, 500) : null,
      trigger: call.trigger ? { kind: 'click', text: String(call.trigger.text || '').slice(0, 60), tag: String(call.trigger.tag || '').slice(0, 30) } : null,
      time: call.time || new Date().toISOString(),
    };
    if (apiCalls.length >= 100) apiCalls.shift();
    apiCalls.push(item);
    toToolbar('preview:api-call', item);
  };
  ipcMain.on('preview:api-call', onApiCall);


  // Shows the latest edit in the previewed workspace in the trusted toolbar, never in the page: a file name and line counts only.
  let lastEdit = null;
  function showStack(value) {
    lastStack = value;
    toToolbar('preview:stack', value);
  }

  function showEdit(value) {
    const clean = value?.path ? { path: String(value.path).slice(-200), added: Math.max(0, Number(value.added) || 0), removed: Math.max(0, Number(value.removed) || 0) } : null;
    if (JSON.stringify(clean) === JSON.stringify(lastEdit)) return;
    lastEdit = clean; toToolbar('preview:edit', clean);
  }

  return {
    showEdit, showStack, get projectId() { return alive(toolbar) ? projectId : null; },
    open, setPicking, close: () => { if (win && !win.isDestroyed()) win.close(); },
    dispose() { ipcMain.off('preview:toolbar', onToolbar); ipcMain.off('preview:picked', onPicked); ipcMain.off('preview:pick-cancelled', onCancelled); ipcMain.off('preview:api-call', onApiCall); if (win && !win.isDestroyed()) win.destroy(); win = null; },
    get page() { return page; }, get picking() { return picking; },
    // How the last pick's screenshot went: captured, blank, hung, or none when the pick had no area.
    get lastCapture() { return capture; },
  };
}

import path from 'node:path';

// Point and tell (#19): the workspace's app in a preview window, where clicking an element puts what it is into the
// message box, with a screenshot of it, for the person to say or type what should change.
//
// Each preview is its own window: a toolbar the app trusts above the page, each in its own view. Every interface the
// person opens, such as a website and its admin panel, gets a window of its own, so they can be reviewed side by side
// (#142). The page only ever shows local addresses, keeps its cookies and storage apart from Codeshi's, and cannot open
// windows, download files or be given permissions. The element picker runs in the page's isolated world, so the page's
// scripts cannot see or change it, and it never gives the page anything. What the picker reports is data: cleaned,
// bounded and described in a sentence the person reads before sending. The helpers are pure, for tests; createPreview
// needs Electron's classes.
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

// The local server an address reaches: its scheme and port. localhost, 127.0.0.1 and [::1] are this computer under
// three names, so an interface finds its window under any of them.
export function previewEndpoint(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.includes(url.hostname)) return null;
  return `${url.protocol}//${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

// The name the review's launch map gives the interface at an address, such as "Admin dashboard"; empty when the
// address is none of the review's services.
export function interfaceName(stack, url) {
  const here = previewEndpoint(url), services = Array.isArray(stack?.services) ? stack.services : [];
  if (!here || !services.length) return '';
  const target = (Array.isArray(stack.previews) ? stack.previews : []).find(item => previewEndpoint(item?.url) === here);
  const service = (target && services.find(item => item?.id === target.service)) || services.find(item => previewEndpoint(item?.url) === here);
  return typeof service?.name === 'string' ? clip(service.name, 60) : '';
}

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

// The sentence put into the message box: where the element is, what it is and where its code is. Where the launch
// map names the interface, the place starts with that name, so picks from a website and its admin panel differ.
const KINDS = { a: 'link', button: 'button', input: 'field', textarea: 'text box', select: 'menu', img: 'image', svg: 'icon', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation', form: 'form', label: 'label', li: 'list item', ul: 'list', ol: 'list', table: 'table', p: 'paragraph', header: 'header', footer: 'footer', section: 'section', dialog: 'dialog' };
function placeOf(url, label) {
  let where = 'the preview';
  try { const parsed = new URL(url); where = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname); } catch { /* The page's address is unknown. */ }
  const place = clip(label, 60);
  return place ? (where === 'the preview' ? place : `${place} (${where})`) : where;
}
const elementName = element => { const kind = KINDS[element.tag] || `<${element.tag}> element`, name = element.text || element.label; return `${name ? `“${clip(name, 60)}” ` : ''}${kind}`; };
const codeOf = source => source?.file ? `${source.file}${source.line ? `:${source.line}` : ''}${source.component ? ` in ${source.component}` : ''}` : source?.component ? `in ${source.component}` : '';
const detailsOf = (element, source) => { const details = [element.selector, codeOf(source)].filter(Boolean).join('; '); return details ? ` (${details})` : ''; };
export function pickText({ element, url, source, label = '' }) {
  return `In the preview of ${placeOf(url, label)}, the ${elementName(element)}${detailsOf(element, source)}: `;
}

// Design notes (#125): several sections of a page, each marked on it by a click (an element) or a dragged box (an
// area inside the element that holds it), each with the person's note. They go into the message box as one message,
// numbered as in the screenshots, for the person to read before sending. At most DESIGN_LIMIT sections, and at most
// DESIGN_SHOTS screenshots: the page as shown, then the sections it doesn't show, each captured when it was marked.
export const DESIGN_LIMIT = 12, DESIGN_SHOTS = 4;
const pathOf = url => { try { const parsed = new URL(url); return parsed.pathname + parsed.search; } catch { return ''; } };
// An area as the page reported it: where it sits inside its element, in CSS pixels.
export function cleanOffset(input) {
  if (!input || typeof input !== 'object') return null;
  const values = ['x', 'y', 'width', 'height'].map(key => Number(input[key]));
  if (!values.every(Number.isFinite) || values[2] < 1 || values[3] < 1) return null;
  const [x, y, width, height] = values.map(value => Math.round(Math.max(-100000, Math.min(100000, value))));
  return { x, y, width, height };
}
// How a section is named, in the panel and in the message.
export function sectionName(section) {
  const name = elementName(section.element);
  return section.offset ? `an area of ${section.offset.width}×${section.offset.height} in the ${name}` : `the ${name}`;
}
export function designText({ sections = [], notes = {}, overall = '', url = '', label = '', shots = 1 }) {
  const here = pathOf(url), list = sections.map((section, index) => {
    const note = clip(notes[section.id], 2000), page = section.url && pathOf(section.url) !== here ? `on ${pathOf(section.url) || section.url}, ` : '';
    const name = page + sectionName(section);
    return `${index + 1}. ${name[0].toUpperCase()}${name.slice(1)}${detailsOf(section.element, section.source)}: ${note}`.trimEnd();
  });
  const whole = clip(overall, 4000), count = sections.length;
  const lead = `Design notes for the preview of ${placeOf(url, label)}${count ? `, ${count} ${count === 1 ? 'section' : 'sections'}` : ''}.${count && shots ? ` The numbers match the boxes in the ${shots === 1 ? 'screenshot' : 'screenshots'}.` : ''}`;
  return [lead, ...list, ...(whole ? [`Whole page: ${whole}`] : [])].join('\n');
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

// One window per interface (#142). A window is found again by its workspace and the local server its page shows, so
// opening an interface that already has a window brings that window forward with its page, history and inspector as
// they were; only a page that failed to load is loaded again. Each window has its own picker, inspector and API calls.
// Opening one never closes or replaces another: the person closes a window, Stop review closes the windows of the
// review's own services, and quitting closes the rest.
export function createPreview({ BaseWindow, WebContentsView, session, ipcMain, shell, root, screen = null, folders = () => [], onPick = () => {}, toolbarHeight = 44, background = () => '#1c1a18', captureWait = 1500, paintWait = 120, platform = process.platform }) {
  // Design notes not yet in a message, kept when their window closes and given back to the next window that shows the
  // same workspace's interface, for as long as Codeshi runs (#125).
  const previews = new Set(), projects = new Map(), drafts = new Map();
  const draftKey = (projectId, end) => `${projectId ?? ''}\n${end || ''}`;
  let capture = 'none', clock = 0;
  const previewSession = session.fromPartition(PREVIEW_PARTITION);
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.on('will-download', event => event.preventDefault());
  const alive = view => Boolean(view && !view.webContents.isDestroyed());
  const live = preview => Boolean(preview?.win && !preview.win.isDestroyed());
  const toToolbar = (preview, channel, value) => { if (alive(preview.toolbar)) preview.toolbar.webContents.send(channel, value); };
  // Where a window is: its page's address, or the local address it last went to while that loads or after it failed.
  const address = preview => { const url = alive(preview.page) ? preview.page.webContents.getURL() : ''; return previewEndpoint(url) ? url : preview.requested; };
  const endpoint = preview => previewEndpoint(address(preview));
  const windowsOf = projectId => [...previews].filter(preview => live(preview) && preview.projectId === projectId);
  const newest = list => list.reduce((best, preview) => !best || preview.used > best.used ? preview : best, null);
  const latest = () => newest([...previews].filter(live));
  const fromToolbar = event => [...previews].find(preview => alive(preview.toolbar) && event.sender === preview.toolbar.webContents);
  const fromPage = event => [...previews].find(preview => alive(preview.page) && event.sender === preview.page.webContents);
  // What each workspace's windows show besides their page: the review's stack and the agent's latest edit.
  const known = projectId => { if (!projects.has(projectId)) projects.set(projectId, { stack: null, stackText: 'null', edit: null }); return projects.get(projectId); };
  const label = preview => interfaceName(projects.get(preview.projectId)?.stack, address(preview));

  function state(preview) {
    const contents = alive(preview.page) ? preview.page.webContents : null, history = contents?.navigationHistory;
    return { url: contents?.getURL() || '', title: contents?.getTitle() || '', loading: Boolean(contents?.isLoading()), back: Boolean(history?.canGoBack()), forward: Boolean(history?.canGoForward()), picking: preview.picking, workspace: preview.workspace, label: label(preview) };
  }
  // The review's stack as one window sees it: which interface it shows, and which have a window already.
  function stack(preview) {
    const value = projects.get(preview.projectId)?.stack;
    if (!value) return null;
    const here = endpoint(preview), shown = new Set(windowsOf(preview.projectId).map(endpoint));
    return { ...value, previews: (Array.isArray(value.previews) ? value.previews : []).map(item => { const at = previewEndpoint(item?.url); return { ...item, current: Boolean(at) && at === here, open: Boolean(at) && shown.has(at) }; }) };
  }
  // The title tells the windows apart, in the window list and in macOS tabs: the interface, then its address.
  function sync(preview) {
    if (!live(preview)) return;
    const value = state(preview), review = stack(preview);
    toToolbar(preview, 'preview:state', value);
    if (review) toToolbar(preview, 'preview:stack', review);
    if (preview.design.open) designToolbar(preview);
    let host = ''; try { host = new URL(address(preview)).host; } catch { /* Not loaded yet. */ }
    preview.win.setTitle(value.label ? `${value.label} · ${host || 'Preview'}` : host ? `Preview · ${host}` : 'Preview');
  }
  const syncProject = projectId => { for (const preview of windowsOf(projectId)) sync(preview); };
  // With the inspector open, the toolbar's view fills the window behind the page, and the page gives up width on the
  // right for it, never height.
  function layout(preview) {
    if (!live(preview)) return;
    const { width, height } = preview.win.getContentBounds(), side = preview.inspector ? inspectorWidth(width) : 0;
    preview.toolbar.setBounds({ x: 0, y: 0, width, height: side ? height : toolbarHeight });
    preview.page.setBounds({ x: 0, y: toolbarHeight, width: width - side, height: Math.max(0, height - toolbarHeight) });
  }
  // ⇧⌘I, or Ctrl+Shift+I, shows or hides the inspector from either view. The page never sees those keys.
  const mac = platform === 'darwin';
  const toggleKey = input => input?.type === 'keyDown' && !input.isAutoRepeat && input.code === 'KeyI' && input.shift && !input.alt && (mac ? input.meta && !input.control : input.control && !input.meta);
  const onKey = preview => (event, input) => { if (!toggleKey(input)) return; event.preventDefault(); toToolbar(preview, 'preview:toggle-inspector'); };
  // Another window opens a step below and to the right of the last one, at its size, on the same display, so the one
  // behind stays in reach.
  function placement() {
    const last = latest();
    if (!last) return { width: 1180, height: 820 };
    const bounds = last.win.getBounds(), area = screen?.getDisplayMatching(bounds)?.workArea;
    let x = bounds.x + 28, y = bounds.y + 28;
    if (area && x + bounds.width > area.x + area.width) x = area.x + Math.max(0, Math.min(28, area.width - bounds.width));
    if (area && y + bounds.height > area.y + area.height) y = area.y + Math.max(0, Math.min(28, area.height - bounds.height));
    return { x, y, width: bounds.width, height: bounds.height };
  }
  function create({ projectId, workspace, href }) {
    const preview = { projectId, workspace, requested: href, picking: false, pickCount: 0, inspector: false, failed: false, used: ++clock, design: freshDesign() };
    const draft = drafts.get(draftKey(projectId, previewEndpoint(href)));
    if (draft) { drafts.delete(draftKey(projectId, previewEndpoint(href))); Object.assign(preview.design, draft); }
    // On macOS the windows can also be merged into tabs, from the Window menu.
    const win = new BaseWindow({ ...placement(), minWidth: 480, minHeight: 320, title: 'Preview', backgroundColor: background(), ...(mac ? { tabbingIdentifier: 'codeshi-preview' } : {}) });
    const toolbar = new WebContentsView({ webPreferences: { preload: path.join(root, 'desktop', 'preview-toolbar-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const page = new WebContentsView({ webPreferences: { partition: PREVIEW_PARTITION, preload: path.join(root, 'desktop', 'preview-page-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
    Object.assign(preview, { win, toolbar, page });
    previews.add(preview);
    // The page goes above the toolbar's view, which fills the window behind it while the inspector is open.
    win.contentView.addChildView(toolbar); win.contentView.addChildView(page);
    toolbar.webContents.on('before-input-event', onKey(preview));
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    toolbar.webContents.on('will-navigate', event => event.preventDefault());
    toolbar.webContents.loadFile(path.join(root, 'desktop', 'preview-toolbar.html'));
    // A new toolbar starts with its window's state, the review's stack and the agent's latest edit in the workspace.
    toolbar.webContents.once('did-finish-load', () => {
      sync(preview); const edit = projects.get(projectId)?.edit; if (edit) toToolbar(preview, 'preview:edit', edit);
      // Unsent design notes from this interface's last window come back with their sections, and the panel opens.
      const { sections, notes, overall } = preview.design;
      if (sections.length || overall) toToolbar(preview, 'preview:design-restore', { notes, overall, count: sections.length });
    });
    const contents = page.webContents;
    contents.on('before-input-event', onKey(preview));
    const injectInterceptor = () => { if (alive(page)) contents.executeJavaScript(apiInterceptorScript()).catch(() => {}); };
    contents.on('did-start-navigation', injectInterceptor);
    contents.on('did-finish-load', injectInterceptor);
    // A page that loads again draws the design boxes again, found by their elements.
    contents.on('did-finish-load', () => { if (preview.design.open) designPage(preview); });
    // Local addresses stay in this window's page; https links open in the browser; nothing opens a window.
    contents.setWindowOpenHandler(({ url }) => { if (isPreviewURL(url)) contents.loadURL(url); else if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    const guard = (event, url) => { if (isPreviewURL(url)) return; event.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); };
    contents.on('will-navigate', guard); contents.on('will-redirect', guard);
    // A page that loads is no longer failed, and one that moves to another server changes what the workspace's other
    // windows show as open. A page that fails to load is loaded again when its interface is opened.
    contents.on('did-navigate', () => { preview.picking = false; preview.failed = false; syncProject(projectId); });
    for (const name of ['did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) contents.on(name, () => sync(preview));
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      preview.failed = true; if (isPreviewURL(url)) preview.requested = url;
      toToolbar(preview, 'preview:error', `${url} could not load (${description}). Is the dev server running?`);
    });
    win.on('focus', () => { preview.used = ++clock; });
    win.on('resize', () => layout(preview)); layout(preview);
    // Electron leaves a view's page running after its window closes, so both views close with it.
    win.on('closed', () => {
      previews.delete(preview);
      keepDraft(preview);
      for (const view of [toolbar, page]) if (!view.webContents.isDestroyed()) view.webContents.close();
      preview.win = preview.toolbar = preview.page = null; preview.picking = false;
      if (windowsOf(projectId).length) syncProject(projectId); else projects.delete(projectId);
    });
    return preview;
  }
  async function open({ projectId = null, url, workspace = '' }) {
    const href = previewURL(url), name = String(workspace || '').slice(0, 120);
    const existing = newest(windowsOf(projectId).filter(preview => endpoint(preview) === previewEndpoint(href)));
    const preview = existing || create({ projectId, workspace: name, href });
    if (existing) { preview.used = ++clock; if (name) preview.workspace = name; if (preview.win.isMinimized()) preview.win.restore(); }
    preview.win.show(); preview.win.focus();
    if (!existing || preview.failed || !preview.page.webContents.getURL()) { preview.requested = href; await preview.page.webContents.loadURL(href).catch(() => {}); }
    syncProject(projectId);
    return true;
  }
  function setPicking(preview, on) {
    if (!live(preview) || !alive(preview.page)) return;
    preview.picking = Boolean(on);
    if (preview.picking && preview.design.marking) { preview.design.marking = false; syncDesign(preview); }
    preview.page.webContents.send('preview:picking', preview.picking);
    sync(preview);
    if (preview.picking) preview.page.webContents.focus();
  }

  // Design notes (#125). The page gets only what it needs to draw the numbered boxes: each section's number, the
  // selector that finds its element and, for an area, where the area sits inside it. The notes stay in the toolbar
  // until they are added to the message, and the names, code locations and screenshots stay here.
  const wait = (ms, value) => new Promise(resolve => setTimeout(resolve, ms, value));
  function freshDesign() { return { open: false, marking: false, sections: [], clock: 0, missing: [], offscreen: [], busy: false, notes: {}, overall: '' }; }
  // What the toolbar has typed so far, kept here too so it outlives the window. Only notes for sections that exist.
  function setNotes(preview, value) {
    const design = preview.design, notes = value?.notes && typeof value.notes === 'object' ? value.notes : {};
    design.notes = Object.fromEntries(design.sections.filter(section => typeof notes[section.id] === 'string').map(section => [section.id, notes[section.id].slice(0, 2000)]));
    design.overall = typeof value?.overall === 'string' ? value.overall.slice(0, 4000) : '';
  }
  function keepDraft(preview) {
    const { sections, notes, overall, clock: count } = preview.design, end = previewEndpoint(address(preview));
    if (!end || (!sections.length && !overall.trim())) return;
    drafts.set(draftKey(preview.projectId, end), { sections, notes, overall, clock: count, missing: [], offscreen: [] });
  }
  function designPage(preview) {
    if (!alive(preview.page)) return;
    const { open, marking, sections } = preview.design;
    preview.page.webContents.send('preview:design', { marking: open && marking, sections: open ? sections.map((section, index) => ({ id: section.id, n: index + 1, selector: section.element.selector, offset: section.offset })) : [] });
  }
  function designToolbar(preview) {
    const { open, marking, sections, missing, offscreen, busy } = preview.design, here = pathOf(address(preview));
    toToolbar(preview, 'preview:design', { open, marking, busy, limit: DESIGN_LIMIT, sections: sections.map((section, index) => {
      const page = section.url && pathOf(section.url) !== here ? pathOf(section.url) || section.url : '';
      return { id: section.id, n: index + 1, name: sectionName(section), code: codeOf(section.source) || section.element.selector, page, missing: !page && missing.includes(section.id), offscreen: !page && offscreen.includes(section.id) };
    }) });
  }
  const syncDesign = preview => { designPage(preview); designToolbar(preview); };
  function setDesign(preview, value) {
    if (!live(preview) || !alive(preview.page)) return;
    const design = preview.design;
    design.open = Boolean(value?.open); design.marking = design.open && Boolean(value?.marking);
    if (design.marking && preview.picking) { preview.picking = false; preview.page.webContents.send('preview:picking', false); sync(preview); }
    syncDesign(preview);
    if (design.marking) preview.page.webContents.focus();
  }
  // A screenshot of the page, or of part of it, as base64 PNG. Like a pick's, it never holds the notes up: a blank one
  // is taken once more, and one that hangs is left out.
  async function shoot(contents, rect = null) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await wait(250);
      let shot = await Promise.race([(rect ? contents.capturePage(rect) : contents.capturePage()).catch(() => null), wait(captureWait, 'hung')]);
      if (shot === 'hung') return null;
      if (shot && !shot.isEmpty()) { if (shot.getSize().width > 1600) shot = shot.resize({ width: 1600 }); return shot.toPNG().toString('base64'); }
    }
    return null;
  }
  // A marked section: what it is and where its code is, asked of the page's framework once as for a pick, and a
  // screenshot of it with its numbered box, for when the page no longer shows it.
  async function addSection(preview, mark) {
    const design = preview.design, contents = preview.page.webContents;
    if (design.sections.length >= DESIGN_LIMIT) { toToolbar(preview, 'preview:error', `Design notes hold up to ${DESIGN_LIMIT} sections. Add these to your message first, or remove one.`); return null; }
    const element = cleanElement(mark?.element);
    if (!element.selector) { toToolbar(preview, 'preview:error', 'That part of the page can’t be found again, so it can’t be marked. Try the element around it.'); return null; }
    // The section counts at once, so quick clicks can't pass the limit; its code location follows.
    const section = { id: `s${++design.clock}`, element, source: sourceLocation(element.attributeSource, { folders: folders(preview.projectId) }), offset: cleanOffset(mark?.offset), url: contents.getURL(), image: null };
    design.sections.push(section);
    syncDesign(preview);
    const rect = captureRect(mark?.rect, mark?.viewport, 16);
    const [hint, image] = await Promise.all([
      typeof mark?.nonce === 'string' && /^[a-z0-9]{8,40}$/.test(mark.nonce) ? contents.executeJavaScript(sourceScript(mark.nonce)).catch(() => null) : null,
      rect ? wait(paintWait).then(() => alive(preview.page) ? shoot(contents, rect) : null) : null,
    ]);
    section.image = image;
    section.source = sourceLocation(hint, { folders: folders(preview.projectId) }) || section.source;
    if (design.sections.includes(section)) designToolbar(preview);
    return section;
  }
  function removeSection(preview, id) {
    const design = preview.design, before = design.sections.length;
    design.sections = design.sections.filter(section => section.id !== id);
    delete design.notes[id];
    if (design.sections.length !== before) syncDesign(preview);
  }
  // Adds the notes to the message box as one message: the page as shown with its numbered boxes, then the sections it
  // doesn't show. Marking stops first, so the outline under the pointer isn't in the screenshot.
  async function sendDesign(preview, value) {
    const design = preview.design, contents = preview.page.webContents, { projectId } = preview;
    if (!design.sections.length || design.busy) return null;
    design.busy = true; design.marking = false; syncDesign(preview);
    try {
      await wait(paintWait);
      if (!alive(preview.page)) return null;
      const images = [], page = await shoot(contents), away = new Set([...design.missing, ...design.offscreen]), here = pathOf(contents.getURL());
      if (page) images.push({ name: 'design-page.png', data: page });
      design.sections.forEach((section, index) => {
        const elsewhere = pathOf(section.url) !== here || away.has(section.id);
        if (images.length < DESIGN_SHOTS && section.image && (!page || elsewhere)) images.push({ name: `design-section-${index + 1}.png`, data: section.image });
      });
      if (!alive(preview.page)) return null;
      const notes = value?.notes && typeof value.notes === 'object' ? value.notes : {}, url = contents.getURL(), name = label(preview);
      const text = designText({ sections: design.sections, notes: Object.fromEntries(design.sections.map(section => [section.id, typeof notes[section.id] === 'string' ? notes[section.id] : ''])), overall: typeof value?.overall === 'string' ? value.overall : '', url, label: name, shots: images.length });
      const count = design.sections.length;
      Object.assign(design, { sections: [], missing: [], offscreen: [], notes: {}, overall: '' });
      const result = { projectId, url, label: name, design: true, image: null, images, text };
      onPick(result);
      toToolbar(preview, 'preview:design-added', { count });
      return result;
    } finally { design.busy = false; syncDesign(preview); }
  }

  // A pick says which window's interface it came from, and goes to that window's workspace.
  async function finish(preview, pick) {
    const contents = preview.page.webContents, element = cleanElement(pick?.element), url = contents.getURL(), name = label(preview), { projectId } = preview;
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
    const value = { projectId, url, label: name, element, source, image, text: pickText({ element, url, source, label: name }) };
    preview.pickCount++;
    onPick(value);
    toToolbar(preview, 'preview:picked', { text: value.text, count: preview.pickCount });
    return value;
  }

  // Each toolbar moves only its own window's page.
  const onToolbar = (event, action, value) => {
    const preview = fromToolbar(event);
    if (!preview || !alive(preview.page)) return;
    const contents = preview.page.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'pick') setPicking(preview, !preview.picking);
    else if (action === 'design') setDesign(preview, value);
    else if (action === 'design-remove' && typeof value === 'string') removeSection(preview, value);
    else if (action === 'design-clear') { Object.assign(preview.design, { sections: [], missing: [], offscreen: [], notes: {}, overall: '' }); syncDesign(preview); }
    else if (action === 'design-notes') setNotes(preview, value);
    else if (action === 'design-send') sendDesign(preview, value).catch(error => toToolbar(preview, 'preview:error', `The design notes could not be added: ${error.message}`));
    else if (action === 'open-external' && isPreviewURL(contents.getURL())) shell.openExternal(contents.getURL());
    else if (action === 'navigate') { try { contents.loadURL(previewURL(value)).catch(() => {}); } catch (error) { toToolbar(preview, 'preview:error', error.message); } }
    else if (action === 'focus-app') onPick({ projectId: preview.projectId, focus: true });
    else if (action === 'show-inspector' || action === 'hide-inspector') { preview.inspector = action === 'show-inspector'; layout(preview); }
    // Another of the review's interfaces opens in a window of its own, or brings its window forward; this page stays.
    else if (action === 'open-interface') open({ projectId: preview.projectId, url: value, workspace: preview.workspace }).catch(error => toToolbar(preview, 'preview:error', error.message));
  };
  const onPicked = (event, pick) => { const preview = fromPage(event); if (!preview?.picking) return; preview.picking = false; sync(preview); finish(preview, pick).catch(error => toToolbar(preview, 'preview:error', `The element could not be picked: ${error.message}`)); };
  const onCancelled = event => { const preview = fromPage(event); if (preview) { preview.picking = false; sync(preview); } };
  ipcMain.on('preview:toolbar', onToolbar); ipcMain.on('preview:picked', onPicked); ipcMain.on('preview:pick-cancelled', onCancelled);
  // The page marks a section only while marking is on, says which boxes it can't find or doesn't show, and stops
  // marking on Escape.
  const onDesignMark = (event, mark) => { const preview = fromPage(event); if (!preview?.design.open || !preview.design.marking) return; addSection(preview, mark).catch(error => toToolbar(preview, 'preview:error', `The section could not be marked: ${error.message}`)); };
  const onDesignLayout = (event, value) => {
    const preview = fromPage(event);
    if (!preview?.design.open) return;
    const ids = new Set(preview.design.sections.map(section => section.id)), list = key => Array.isArray(value?.[key]) ? value[key].filter(id => ids.has(id)).sort() : [];
    const missing = list('missing'), offscreen = list('offscreen');
    if (JSON.stringify([missing, offscreen]) === JSON.stringify([preview.design.missing, preview.design.offscreen])) return;
    Object.assign(preview.design, { missing, offscreen });
    designToolbar(preview);
  };
  // Escape ends marking and takes the keyboard to the notes, to write them.
  const onDesignStop = event => {
    const preview = fromPage(event);
    if (!preview?.design.marking) return;
    preview.design.marking = false; syncDesign(preview);
    if (alive(preview.toolbar) && preview.design.sections.length) { preview.toolbar.webContents.focus(); toToolbar(preview, 'preview:design-write'); }
  };
  // The element the keyboard has outlined, named as its section would be, for the toolbar to say.
  const onDesignCursor = (event, value) => {
    const preview = fromPage(event);
    if (preview?.design.open && preview.design.marking) toToolbar(preview, 'preview:design-cursor', { name: sectionName({ element: cleanElement(value), offset: null }) });
  };
  ipcMain.on('preview:design-mark', onDesignMark); ipcMain.on('preview:design-layout', onDesignLayout); ipcMain.on('preview:design-stop', onDesignStop); ipcMain.on('preview:design-cursor', onDesignCursor);
  // A page's API calls go to its own window's inspector.
  const onApiCall = (event, call) => {
    const preview = fromPage(event);
    if (!preview || !call) return;
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
    toToolbar(preview, 'preview:api-call', item);
  };
  ipcMain.on('preview:api-call', onApiCall);

  // The latest edit in a workspace shows in the trusted toolbars of its windows, never in a page: a file name and line
  // counts only.
  function showEdit(projectId, value) {
    const clean = value?.path ? { path: String(value.path).slice(-200), added: Math.max(0, Number(value.added) || 0), removed: Math.max(0, Number(value.removed) || 0) } : null, saved = known(projectId);
    if (JSON.stringify(clean) === JSON.stringify(saved.edit)) return;
    saved.edit = clean;
    for (const preview of windowsOf(projectId)) toToolbar(preview, 'preview:edit', clean);
  }
  // The review's services and interfaces, for the inspector's Stack and to name each window's interface.
  function showStack(projectId, value) {
    const saved = known(projectId), text = JSON.stringify(value ?? null);
    if (text === saved.stackText) return;
    Object.assign(saved, { stack: value ?? null, stackText: text });
    syncProject(projectId);
  }
  // Closes every window, or a workspace's windows showing any of the given addresses, as Stop review does for the
  // review's own services. Says how many it closed.
  function close({ projectId, urls } = {}) {
    const ends = Array.isArray(urls) ? new Set(urls.map(previewEndpoint).filter(Boolean)) : null;
    const closing = [...previews].filter(preview => live(preview) && (!ends || preview.projectId === projectId && ends.has(endpoint(preview))));
    for (const preview of closing) preview.win.close();
    return closing.length;
  }

  return {
    open, close, showEdit, showStack,
    // Whether any window shows this workspace.
    shows: projectId => windowsOf(projectId).length > 0,
    // The smoke test picks in the window used last.
    setPicking: on => setPicking(latest(), on),
    dispose() { ipcMain.off('preview:toolbar', onToolbar); ipcMain.off('preview:picked', onPicked); ipcMain.off('preview:pick-cancelled', onCancelled); ipcMain.off('preview:api-call', onApiCall); ipcMain.off('preview:design-mark', onDesignMark); ipcMain.off('preview:design-layout', onDesignLayout); ipcMain.off('preview:design-stop', onDesignStop); ipcMain.off('preview:design-cursor', onDesignCursor); for (const preview of [...previews]) if (live(preview)) preview.win.destroy(); previews.clear(); projects.clear(); drafts.clear(); },
    get page() { return latest()?.page ?? null; }, get picking() { return Boolean(latest()?.picking); },
    get count() { return [...previews].filter(live).length; },
    // How the last pick's screenshot went: captured, blank, hung, or none when the pick had no area.
    get lastCapture() { return capture; },
  };
}

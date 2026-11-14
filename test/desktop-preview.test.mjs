import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DESIGN_LIMIT, INSPECTOR_WIDTH, apiInterceptorScript, captureRect, cleanElement, cleanOffset, createPreview, designText, interfaceName, isPreviewURL, pickText, previewEndpoint, previewURL, sectionName, sourceLocation, sourceScript } from '../desktop/preview.mjs';

test('the preview opens only local addresses, without credentials', () => {
  assert.equal(previewURL(' http://localhost:5173/checkout '), 'http://localhost:5173/checkout');
  assert.equal(previewURL('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(previewURL('https://[::1]:8443/app'), 'https://[::1]:8443/app');
  for (const value of ['http://example.com', 'https://localhost.evil.com', 'http://user:pass@localhost:3000', 'file:///etc/passwd', 'javascript:alert(1)', 'localhost:3000', '', null]) assert.equal(isPreviewURL(value), false, String(value));
  assert.throws(() => previewURL('http://example.com'), /local addresses only/);
});

test('a picked element is kept to plain, bounded values', () => {
  const element = cleanElement({ tag: 'button', text: '  Apply\n  now  ', label: 'x'.repeat(500), selector: 'form#promo > button.apply', attributeSource: { file: 'src/App.tsx', line: 12 }, extra: 'ignored' });
  assert.deepEqual(element, { tag: 'button', text: 'Apply now', label: `${'x'.repeat(119)}…`, selector: 'form#promo > button.apply', attributeSource: { file: 'src/App.tsx', line: 12 } });
  assert.equal(cleanElement({ tag: '<script>' }).tag, 'element');
  assert.deepEqual(cleanElement(), { tag: 'element', text: '', label: '', selector: '' });
});

test('where the element is written is found from React, Vue, Svelte and inspector plugins, in the workspace’s own terms', () => {
  const web = path.resolve('/work/acme-shop'), api = path.resolve('/work/payments-api'), one = [{ name: 'acme-shop', path: web }], two = [...one, { name: 'payments-api', path: api }];
  // React 18 and earlier record the file and line.
  assert.deepEqual(sourceLocation({ component: 'PromoForm', source: { file: path.join(web, 'src/PromoForm.tsx'), line: 42 } }, { folders: one }), { file: 'src/PromoForm.tsx', line: 42, component: 'PromoForm' });
  assert.deepEqual(sourceLocation({ source: { file: path.join(api, 'routes/promo.js'), line: 7 } }, { folders: two }), { file: 'payments-api/routes/promo.js', line: 7 }, 'With several folders the folder is named.');
  assert.deepEqual(sourceLocation({ component: 'PromoForm', source: { file: path.resolve('/elsewhere/lib.js'), line: 1 } }, { folders: one }), { component: 'PromoForm' }, 'A file outside the workspace is left out.');
  // React 19 keeps only the stack where the element was created; the first frame in the app's own code is used.
  const stack = 'Error: react-stack-top-frame\n    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)\n    at PromoForm (http://localhost:5173/src/components/PromoForm.tsx?t=1730000000:42:11)\n    at App (http://localhost:5173/src/App.tsx:9:3)';
  assert.deepEqual(sourceLocation({ component: 'PromoForm', stack }, { folders: one }), { file: 'src/components/PromoForm.tsx', line: 42, component: 'PromoForm', approximate: true });
  // Vite serves files outside its root under /@fs/.
  assert.deepEqual(sourceLocation({ stack: `at x (http://localhost:5173/@fs/${path.join(web, 'src/Card.vue').split(path.sep).join('/').replace(/^\//, '')}:3:1)` }, { folders: one }).file, 'src/Card.vue');
  assert.deepEqual(sourceLocation({ stack: 'at x (http://localhost:5173/@fs/D:/work/acme-shop/src/Card.vue:3:1)' }, { folders: [{ name: 'acme-shop', path: 'D:\\work\\acme-shop' }] })?.file ?? null, process.platform === 'win32' ? 'src/Card.vue' : null, 'On Windows, Vite names the drive after /@fs/.');
  assert.deepEqual(sourceLocation({ file: 'src/App.svelte', line: 4 }), { file: 'src/App.svelte', line: 4 }, 'An inspector plugin’s path is used as written.');
  assert.equal(sourceLocation({ component: '<img onerror=x>' }), null, 'Only a plain component name is kept.');
  assert.equal(sourceLocation(null), null);
});

test('a pick reads as a sentence: where, what and where its code is', () => {
  const element = { tag: 'button', text: 'Apply', label: '', selector: 'form#promo > button.apply' };
  assert.equal(pickText({ element, url: 'http://localhost:5173/checkout', source: { file: 'src/PromoForm.tsx', line: 42, component: 'PromoForm' } }), 'In the preview of localhost:5173/checkout, the “Apply” button (form#promo > button.apply; src/PromoForm.tsx:42 in PromoForm): ');
  assert.equal(pickText({ element: { tag: 'img', text: '', label: 'Trail runner', selector: 'img.hero' }, url: 'http://localhost:3000/', source: null }), 'In the preview of localhost:3000, the “Trail runner” image (img.hero): ');
  assert.equal(pickText({ element: { tag: 'section', text: '', label: '', selector: '' }, url: 'bad' }), 'In the preview of the preview, the section: ');
  assert.equal(pickText({ element: { tag: 'my-widget', text: '', label: '', selector: 'my-widget' }, url: 'http://localhost:4000/', source: { component: 'Widget' } }), 'In the preview of localhost:4000, the <my-widget> element (my-widget; in Widget): ');
  // With several interfaces, the launch map's name for the one picked in comes first (#142).
  assert.equal(pickText({ element: { tag: 'button', text: 'Save', label: '', selector: '#save' }, url: 'http://localhost:4201/users', source: null, label: 'Admin dashboard' }), 'In the preview of Admin dashboard (localhost:4201/users), the “Save” button (#save): ');
  assert.equal(pickText({ element: { tag: 'button', text: 'Save', label: '', selector: '' }, url: 'bad', label: 'Admin dashboard' }), 'In the preview of Admin dashboard, the “Save” button: ');
});

test('an interface is found by the local server it reaches, under any of this computer’s names, and named as the launch map names it', () => {
  assert.equal(previewEndpoint('http://localhost:4200/cart'), 'http://4200');
  assert.equal(previewEndpoint('http://127.0.0.1:4200/'), 'http://4200', 'localhost and 127.0.0.1 are the same server.');
  assert.equal(previewEndpoint('http://[::1]:4200'), 'http://4200');
  assert.deepEqual([previewEndpoint('https://localhost/'), previewEndpoint('http://localhost/')], ['https://443', 'http://80']);
  assert.notEqual(previewEndpoint('http://localhost:4201/'), previewEndpoint('http://localhost:4200/'));
  for (const value of ['http://example.com:4200/', 'file:///tmp/a', 'nonsense', null]) assert.equal(previewEndpoint(value), null, String(value));
  const stack = { services: [{ id: 'site', name: 'Website', url: 'http://localhost:4200/' }, { id: 'admin', name: 'Admin dashboard', url: 'http://localhost:4201/' }, { id: 'api', name: 'API', url: 'http://127.0.0.1:8000/health' }], previews: [{ service: 'admin', url: 'http://127.0.0.1:4201/' }] };
  assert.equal(interfaceName(stack, 'http://localhost:4201/users/7'), 'Admin dashboard');
  assert.equal(interfaceName(stack, 'http://localhost:4200/'), 'Website', 'A service the map does not list as a preview is still named by its address.');
  assert.equal(interfaceName(stack, 'http://localhost:8000/docs'), 'API');
  assert.deepEqual([interfaceName(stack, 'http://localhost:5173/'), interfaceName(null, 'http://localhost:4200/'), interfaceName(stack, 'bad')], ['', '', '']);
});

test('the screenshot is the element with a margin, kept inside the visible page', () => {
  assert.deepEqual(captureRect({ x: 100, y: 50, width: 80, height: 30 }, { width: 1000, height: 700 }), { x: 92, y: 42, width: 96, height: 46 });
  assert.deepEqual(captureRect({ x: -20, y: 650, width: 2000, height: 200 }, { width: 1000, height: 700 }), { x: 0, y: 642, width: 1000, height: 58 }, 'A larger element is cut to what shows.');
  assert.equal(captureRect({ x: 2000, y: 0, width: 10, height: 10 }, { width: 1000, height: 700 }), null, 'Nothing to capture off screen.');
  assert.equal(captureRect({ x: 'a' }, { width: 1000, height: 700 }), null);
});

test('the page’s framework is asked once, about the marked element only, and the toolbar runs only its own script', () => {
  const script = sourceScript('abc123def4');
  assert.match(script, /\[data-codeshi-pick="abc123def4"\]/);
  assert.match(script, /removeAttribute\('data-codeshi-pick'\)/);
  assert.doesNotThrow(() => new Function(`return ${script}`), 'The question is valid JavaScript.');
  const page = fs.readFileSync(new URL('../desktop/preview-toolbar.html', import.meta.url), 'utf8');
  const inline = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert(page.includes(`script-src 'sha256-${createHash('sha256').update(inline).digest('base64')}'`), 'Update the toolbar’s script hash when its script changes.');
  assert.match(page, /default-src 'none'/);
  const picker = fs.readFileSync(new URL('../desktop/preview-page-preload.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(picker, /contextBridge|exposeInMainWorld/, 'The picker gives the page nothing.');
});

test('the toolbar shows the agent’s edit from its own trusted script, and nothing reaches the page', async () => {
  const sent = [], pageSent = [];
  const contents = log => ({ url: '', isDestroyed: () => false, setWindowOpenHandler() {}, on() {}, once() {}, loadFile() {}, send: (channel, value) => log.push([channel, value]), focus() {}, isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false }, async loadURL(url) { this.url = url; }, getURL() { return this.url; }, getTitle: () => '', executeJavaScript: async () => { throw new Error('Nothing may run in the page.'); } });
  let views = 0;
  class View { constructor() { this.webContents = contents(views++ === 0 ? sent : pageSent); } setBounds() {} }
  class Window { constructor() { this.contentView = { addChildView() {} }; } getContentBounds() { return { width: 1000, height: 700 }; } on() {} show() {} focus() {} setTitle() {} close() {} destroy() {} isDestroyed() { return false; } }
  const session = { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }) };
  const preview = createPreview({ BaseWindow: Window, WebContentsView: View, session, ipcMain: { on() {}, off() {} }, shell: { openExternal() {} }, root: '/app' });
  assert.equal(preview.shows('p'), false, 'Before it opens it shows no workspace.');
  await preview.open({ projectId: 'p', url: 'http://localhost:5173/' });
  assert.equal(preview.shows('p'), true);
  sent.length = 0;
  preview.showEdit('p', { path: 'src/BuyBox.tsx', added: 4, removed: 2, contents: 'SECRET' });
  preview.showEdit('p', { path: 'src/BuyBox.tsx', added: 4, removed: 2 });
  preview.showEdit('other', { path: 'src/Elsewhere.tsx', added: 1, removed: 0 });
  preview.showEdit('p', null);
  assert.deepEqual(sent.filter(([channel]) => channel === 'preview:edit'), [['preview:edit', { path: 'src/BuyBox.tsx', added: 4, removed: 2 }], ['preview:edit', null]], 'Only a file and counts, only when it changes, and only from the workspace it shows.');
  assert.deepEqual(pageSent.filter(([channel]) => channel === 'preview:edit'), [], 'Nothing goes to the page.');
  preview.dispose();
  const page = fs.readFileSync(new URL('../desktop/preview-toolbar.html', import.meta.url), 'utf8'), script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(script, /bridge\.onEdit/); assert.match(page, /id="edit"/);
  assert.doesNotMatch(script, /innerHTML/, 'Built as text, so a file name can’t become markup.');
  // The toolbar's own script against a stand-in, as the page would run it.
  const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, { id, children: [], dataset: {}, classList: { add() {} }, value: '', textContent: '', setAttribute() {}, addEventListener() {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, select() {}, blur() {} }); return nodes.get(id); };
  const text = value => [value.textContent, ...(value.children || []).map(text)].join('');
  let onEdit; const timers = [];
  const run = new Function('document', 'window', 'setTimeout', 'clearTimeout', script);
  run({ getElementById: node, createElement: () => ({ children: [], append(...items) { this.children.push(...items); }, textContent: '', className: '' }), createTextNode: value => ({ textContent: value }) }, { relayPreview: { act() {}, onState() {}, onPicked() {}, onError() {}, onEdit: callback => { onEdit = callback; } } }, callback => { timers.push(callback); return timers.length; }, () => {});
  onEdit({ path: 'src/BuyBox.tsx', added: 4, removed: 2 });
  assert.equal(text(node('edit')), 'Edit src/BuyBox.tsx +4 −2');
  onEdit(null); assert.equal(text(node('edit')), 'Edit src/BuyBox.tsx +4 −2', 'It stays a moment after the run ends.');
  timers.at(-1)(); assert.equal(text(node('edit')), '');
});

test('a pick always arrives: a blank screenshot is taken once more, and a capture that hangs is left out', async () => {
  // Electron stand-ins: a window holding the toolbar and the page, each with its own web contents.
  async function pickWith(captures) {
    const handlers = {}, picks = [], calls = [];
    const contents = () => ({ url: '', isDestroyed: () => false, setWindowOpenHandler() {}, on() {}, once() {}, loadFile() {}, send() {}, focus() {}, isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      async loadURL(url) { this.url = url; }, getURL() { return this.url; }, getTitle: () => 'Shop', executeJavaScript: async () => null, capturePage: rect => { calls.push(rect); return captures.shift()(); } });
    class View { constructor() { this.webContents = contents(); } setBounds() {} }
    class Window { constructor() { this.contentView = { addChildView() {} }; } getContentBounds() { return { width: 1000, height: 700 }; } on() {} show() {} focus() {} setTitle() {} close() {} destroy() {} isDestroyed() { return false; } }
    const session = { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }) };
    const preview = createPreview({ BaseWindow: Window, WebContentsView: View, session, ipcMain: { on: (channel, handler) => { handlers[channel] = handler; }, off() {} }, shell: { openExternal() {} }, root: '/app', onPick: value => picks.push(value), captureWait: 30 });
    await preview.open({ url: 'http://localhost:5173/' });
    preview.setPicking(true);
    handlers['preview:picked']({ sender: preview.page.webContents }, { nonce: 'abcdef1234', element: { tag: 'button', text: 'Apply', selector: '#apply' }, rect: { x: 10, y: 10, width: 50, height: 20 }, viewport: { width: 1000, height: 656 } });
    for (const until = Date.now() + 2000; !picks.length && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 10));
    preview.dispose();
    return { pick: picks[0], captures: calls.length, capture: preview.lastCapture };
  }
  const blank = { isEmpty: () => true }, shot = { isEmpty: () => false, getSize: () => ({ width: 66, height: 36 }), toPNG: () => Buffer.from('png') };
  const retried = await pickWith([async () => blank, async () => shot]);
  assert.deepEqual([retried.pick.image, retried.captures, retried.capture], [{ name: 'preview-button.png', data: Buffer.from('png').toString('base64') }, 2, 'captured']);
  const hung = await pickWith([() => new Promise(() => {})]);
  assert.deepEqual([hung.pick.text, hung.pick.image, hung.captures], ['In the preview of localhost:5173, the “Apply” button (#apply): ', null, 1], 'Without the screenshot, the pick still comes, and a hang is not waited on twice.');
  // How the screenshot went is kept, so a check can say why a pick came without one.
  const unpainted = await pickWith([async () => blank, async () => blank]);
  assert.deepEqual([hung.capture, unpainted.capture, unpainted.pick.image, unpainted.captures], ['hung', 'blank', null, 2]);
});

test('the toolbar receives backend and DB configuration stack and displays running services', async () => {
  const sent = [];
  const contents = () => ({ url: '', isDestroyed: () => false, setWindowOpenHandler() {}, on() {}, once() {}, loadFile() {}, send: (ch, val) => sent.push([ch, val]), focus() {}, isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false }, async loadURL(url) { this.url = url; }, getURL() { return this.url; }, getTitle: () => '', executeJavaScript: async () => {} });
  class View { constructor() { this.webContents = contents(); } setBounds() {} }
  class Window { constructor() { this.contentView = { addChildView() {} }; } getContentBounds() { return { width: 1000, height: 700 }; } on() {} show() {} focus() {} setTitle() {} close() {} destroy() {} isDestroyed() { return false; } }
  const session = { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }) };
  const preview = createPreview({ BaseWindow: Window, WebContentsView: View, session, ipcMain: { on() {}, off() {} }, shell: { openExternal() {} }, root: '/app' });
  await preview.open({ projectId: 'p1', url: 'http://localhost:3000/' });
  const stack = {
    profile: 'Development',
    prerequisites: ['MongoDB running on port 27017'],
    services: [
      { name: 'Backend API', kind: 'service', status: 'ready', url: 'http://127.0.0.1:8000', folder: 'backend' },
      { name: 'Web', kind: 'service', status: 'ready', url: 'http://127.0.0.1:3000', folder: 'frontend' },
    ],
  };
  preview.showStack('p1', stack);
  preview.showStack('p1', structuredClone(stack));
  preview.showStack('p2', { ...stack, profile: 'Another workspace' });
  assert.deepEqual(sent.filter(([ch]) => ch === 'preview:stack'), [['preview:stack', { ...stack, previews: [] }]], 'Sent once, and only to the windows of its workspace.');
  preview.dispose();
});

test('apiInterceptorScript is valid javascript and intercepts fetch and xhr calls', () => {
  const script = apiInterceptorScript();
  assert.match(script, /codeshi:api-call/);
  assert.match(script, /origFetch/);
  assert.doesNotThrow(() => new Function(`return ${script}`), 'The interceptor script is valid JavaScript.');
});

test('api calls captured in preview page reach the toolbar with method, url, request and response', async () => {
  const sent = [];
  const handlers = {};
  const contents = () => ({ url: 'http://localhost:3000/app', isDestroyed: () => false, setWindowOpenHandler() {}, on() {}, once() {}, loadFile() {}, send: (ch, val) => sent.push([ch, val]), focus() {}, isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false }, async loadURL(url) { this.url = url; }, getURL() { return this.url; }, getTitle: () => '', executeJavaScript: async () => {} });
  class View { constructor() { this.webContents = contents(); } setBounds() {} }
  class Window { constructor() { this.contentView = { addChildView() {} }; } getContentBounds() { return { width: 1000, height: 700 }; } on() {} show() {} focus() {} setTitle() {} close() {} destroy() {} isDestroyed() { return false; } }
  const session = { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }) };
  const preview = createPreview({ BaseWindow: Window, WebContentsView: View, session, ipcMain: { on: (ch, fn) => { handlers[ch] = fn; }, off() {} }, shell: { openExternal() {} }, root: '/app' });
  await preview.open({ projectId: 'p1', url: 'http://localhost:3000/' });

  const apiCall = {
    id: 'req123',
    type: 'fetch',
    url: 'http://127.0.0.1:8000/api/users',
    method: 'POST',
    status: 200,
    statusText: 'OK',
    duration: 15,
    request: { headers: { 'content-type': 'application/json' }, body: '{"name":"test"}' },
    response: { headers: { 'content-type': 'application/json' }, body: '{"id":1,"name":"test"}' },
    trigger: { kind: 'click', text: 'Create User', tag: 'button' },
  };

  handlers['preview:api-call']({ sender: preview.page.webContents }, apiCall);
  const forwarded = sent.find(([ch]) => ch === 'preview:api-call');
  assert(forwarded, 'API call forwarded to toolbar');
  assert.equal(forwarded[1].method, 'POST');
  assert.equal(forwarded[1].url, 'http://127.0.0.1:8000/api/users');
  assert.equal(forwarded[1].request.body, '{"name":"test"}');
  assert.equal(forwarded[1].response.body, '{"id":1,"name":"test"}');
  assert.equal(forwarded[1].trigger.text, 'Create User');
  preview.dispose();
});

// Electron stand-ins for the inspector tests: each view keeps its bounds and its web contents' handlers.
function inspectorWindow({ platform } = {}) {
  const handlers = {}, events = {}, views = [], added = [], sent = [];
  const size = { width: 1180, height: 820 };
  const contents = () => ({ url: '', handlers: {}, isDestroyed: () => false, close() {}, setWindowOpenHandler() {}, on(name, handler) { this.handlers[name] = handler; }, once() {}, loadFile() {}, send: (channel, value) => sent.push([channel, value]), focus() {}, isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false }, async loadURL(url) { this.url = url; }, getURL() { return this.url; }, getTitle: () => '', executeJavaScript: async () => {} });
  class View { constructor() { this.webContents = contents(); this.bounds = null; views.push(this); } setBounds(value) { this.bounds = value; } }
  class Window { constructor() { this.contentView = { addChildView: view => added.push(view) }; } getContentBounds() { return { ...size }; } on(name, handler) { events[name] = handler; } show() {} focus() {} isMinimized() { return false; } restore() {} setTitle() {} close() {} destroy() {} isDestroyed() { return false; } }
  const session = { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }) };
  const preview = createPreview({ BaseWindow: Window, WebContentsView: View, session, ipcMain: { on: (channel, handler) => { handlers[channel] = handler; }, off() {} }, shell: { openExternal() {} }, root: '/app', ...platform ? { platform } : {} });
  const act = (view, action) => handlers['preview:toolbar']({ sender: view.webContents }, action);
  return { preview, views, added, sent, events, size, act };
}

test('the Stack and API inspector opens on the right of the page, which keeps its full height', async () => {
  const w = inspectorWindow();
  await w.preview.open({ projectId: 'p1', url: 'http://localhost:3000/' });
  const [toolbar, page] = w.views, shown = () => [toolbar.bounds, page.bounds];
  assert.deepEqual(shown(), [{ x: 0, y: 0, width: 1180, height: 44 }, { x: 0, y: 44, width: 1180, height: 776 }]);
  assert.deepEqual(w.added, [toolbar, page], 'The page sits above the toolbar’s view, so the inspector behind it never covers the page.');
  w.act(toolbar, 'show-inspector');
  assert.deepEqual(shown(), [{ x: 0, y: 0, width: 1180, height: 820 }, { x: 0, y: 44, width: 800, height: 776 }], 'The page gives up width, never height.');
  w.act(page, 'hide-inspector');
  assert.equal(page.bounds.width, 800, 'Only the toolbar opens and closes it.');
  Object.assign(w.size, { width: 1440, height: 900 }); w.events.resize();
  assert.deepEqual(shown(), [{ x: 0, y: 0, width: 1440, height: 900 }, { x: 0, y: 44, width: 1000, height: 856 }], 'A wide window gives it more room.');
  Object.assign(w.size, { width: 480, height: 320 }); w.events.resize();
  assert.deepEqual(page.bounds, { x: 0, y: 44, width: 240, height: 276 }, 'In the narrowest window the page keeps 240 px.');
  w.act(toolbar, 'hide-inspector');
  assert.deepEqual(shown(), [{ x: 0, y: 0, width: 480, height: 44 }, { x: 0, y: 44, width: 480, height: 276 }]);
  w.act(toolbar, 'show-inspector');
  await w.preview.open({ projectId: 'p1', url: 'http://localhost:3000/orders' });
  assert.deepEqual([w.views.length, page.bounds.width, page.webContents.getURL()], [2, 240, 'http://localhost:3000/'], 'Opening the same interface again brings its window forward as it was, inspector and page.');
  w.events.closed();
  await w.preview.open({ projectId: 'p1', url: 'http://localhost:3000/' });
  assert.deepEqual([w.views[2].bounds.height, w.views[3].bounds.width], [44, 480], 'A new window starts with it closed, as its new toolbar does.');
  w.preview.dispose();
  // The toolbar draws the inspector at the width the window leaves it: its CSS follows the same rule.
  const html = fs.readFileSync(new URL('../desktop/preview-toolbar.html', import.meta.url), 'utf8'), { narrow, wide, wideFrom, pageMin } = INSPECTOR_WIDTH;
  assert.deepEqual([narrow, wide, wideFrom, pageMin], [380, 440, 1280, 240]);
  assert(html.includes(`width: min(${narrow}px, calc(100vw - ${pageMin}px));`), 'The inspector’s width in the toolbar’s CSS matches the page’s bounds.');
  assert(html.includes(`@media (min-width: ${wideFrom}px) { #drawer { width: ${wide}px; } }`));
});

test('⇧⌘I, or Ctrl+Shift+I, shows or hides the inspector from the page or the toolbar, and the page never sees it', async () => {
  const key = { type: 'keyDown', code: 'KeyI', key: 'I', shift: true, alt: false, control: false, meta: false, isAutoRepeat: false };
  for (const [platform, own, other] of [['darwin', { meta: true }, { control: true }], ['win32', { control: true }, { meta: true }], ['linux', { control: true }, { meta: true }]]) {
    const w = inspectorWindow({ platform });
    await w.preview.open({ url: 'http://localhost:3000/' });
    const press = (view, input) => { let prevented = false; w.sent.length = 0; view.webContents.handlers['before-input-event']({ preventDefault: () => { prevented = true; } }, { ...key, ...input }); return [prevented, w.sent.filter(([channel]) => channel === 'preview:toggle-inspector').length]; };
    const [toolbar, page] = w.views;
    assert.deepEqual(press(page, own), [true, 1], `${platform}: from the page, which never gets the keys.`);
    assert.deepEqual(press(toolbar, own), [true, 1], `${platform}: from the toolbar.`);
    for (const input of [other, { ...own, alt: true }, { ...own, shift: false }, { ...own, isAutoRepeat: true }, { ...own, type: 'keyUp' }, { ...own, code: 'KeyJ' }]) assert.deepEqual(press(page, input), [false, 0], `${platform}: ${JSON.stringify(input)} reaches the page.`);
    w.preview.dispose();
  }
});

test('the toolbar switches between Stack and APIs in one inspector, and the shortcut brings back the last one', () => {
  const html = fs.readFileSync(new URL('../desktop/preview-toolbar.html', import.meta.url), 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map(), listeners = new Map(), acts = [], windowListeners = {};
  const element = (id = '') => ({ id, hidden: false, attributes: {}, children: [], dataset: {}, style: {}, value: '', textContent: '', className: '', title: '', setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(type, handler) { if (id) listeners.set(`${id}:${type}`, handler); }, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, select() {}, blur() {} });
  const node = id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  let toggle = null, apiCall = null;
  const bridge = { act: action => acts.push(action), onState() {}, onPicked() {}, onError() {}, onEdit() {}, onStack() {}, onApiCall: callback => { apiCall = callback; }, onToggleInspector: callback => { toggle = callback; } };
  new Function('document', 'window', 'setTimeout', 'clearTimeout', script)({ getElementById: node, createElement: () => element(), createTextNode: value => ({ textContent: value }) }, { relayPreview: bridge, navigator: { platform: 'MacIntel' }, addEventListener: (type, handler) => { windowListeners[type] = handler; } }, () => 0, () => {});
  const click = id => listeners.get(`${id}:click`)();
  const showing = () => node('drawer').hidden ? null : [node('stack-panel').hidden ? 'apis' : 'stack', node('stack-btn').attributes['aria-pressed'], node('apis-btn').attributes['aria-pressed']];
  click('stack-btn'); assert.deepEqual(showing(), ['stack', 'true', 'false']);
  click('apis-btn'); assert.deepEqual(showing(), ['apis', 'false', 'true'], 'The other button switches the panel in place.');
  click('apis-btn'); assert.equal(showing(), null, 'Its own button closes it.');
  assert.deepEqual(acts.splice(0), ['show-inspector', 'show-inspector', 'hide-inspector']);
  assert.equal(typeof toggle, 'function', 'The toolbar hears the shortcut.');
  toggle(); assert.deepEqual(showing(), ['apis', 'false', 'true'], 'The shortcut brings back the last panel.');
  toggle(); assert.equal(showing(), null);
  click('stack-btn'); windowListeners.keydown({ key: 'Escape' }); assert.equal(showing(), null, 'Esc closes it.');
  assert.deepEqual(acts, ['show-inspector', 'hide-inspector', 'show-inspector', 'hide-inspector']);
  assert.match(node('stack-btn').title, /⇧⌘I/); assert.match(node('apis-btn').title, /⇧⌘I/);
  // The API status line in the bar opens the call; it never closes an inspector already showing APIs.
  apiCall({ id: 'c1', method: 'GET', url: 'http://localhost:3000/api/orders', status: 200, statusText: 'OK', duration: 4, request: {}, response: {} });
  node('status').onclick(); assert.deepEqual(showing(), ['apis', 'false', 'true']);
  node('status').onclick(); assert.deepEqual(showing(), ['apis', 'false', 'true'], 'A second click keeps it open.');
});

test('Stack lists the review’s interfaces first: this window’s is marked, and the others open or come forward in windows of their own (#142)', () => {
  const html = fs.readFileSync(new URL('../desktop/preview-toolbar.html', import.meta.url), 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map(), acts = [];
  const element = (id = '', tag = 'div') => ({ id, tag, hidden: false, attributes: {}, children: [], listeners: {}, dataset: {}, style: {}, value: '', textContent: '', className: '', title: '', setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(type, handler) { this.listeners[type] = handler; }, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, select() {}, blur() {} });
  const node = id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  let showStack = null;
  const bridge = { act: (action, value) => acts.push([action, value]), onState() {}, onPicked() {}, onError() {}, onEdit() {}, onStack: callback => { showStack = callback; }, onApiCall() {}, onToggleInspector() {} };
  new Function('document', 'window', 'setTimeout', 'clearTimeout', script)({ getElementById: node, createElement: tag => element('', tag), createTextNode: value => ({ textContent: value }) }, { relayPreview: bridge, navigator: { platform: 'MacIntel' }, addEventListener() {} }, () => 0, () => {});
  showStack({ profile: 'Development', services: [{ id: 'site', name: 'Website' }, { id: 'admin', name: 'Admin dashboard' }, { id: 'api', name: 'API' }], previews: [{ service: 'site', url: 'http://localhost:4200/', current: true, open: true }, { service: 'admin', url: 'http://localhost:4201/', current: false, open: true }, { service: 'api', url: 'http://127.0.0.1:8000/', current: false, open: false }] });
  node('stack-btn').listeners.click();
  const [heading, list] = node('stack-content').children[0].children;
  assert.equal(heading.textContent, 'Interfaces');
  const rows = list.children.map(card => { const [about, action] = card.children; return [about.children[0].textContent, about.children[1].textContent, action.tag, action.textContent, action.attributes['aria-label'] ?? null]; });
  assert.deepEqual(rows, [['Website', 'localhost:4200', 'span', 'This window', null], ['Admin dashboard', 'localhost:4201', 'button', 'Show', 'Show Admin dashboard'], ['API', '127.0.0.1:8000', 'button', 'Open', 'Open API']]);
  acts.length = 0;
  list.children[1].children[1].listeners.click(); list.children[2].children[1].listeners.click();
  assert.deepEqual(acts, [['open-interface', 'http://localhost:4201/'], ['open-interface', 'http://127.0.0.1:8000/']], 'Neither moves this window’s page.');
  assert.doesNotMatch(script, /navigate-preview/);
});

// Electron stand-ins for several preview windows (#142): each window keeps its options, title and events, and each
// view's web contents what it was sent and loaded. Closing a window reports it closed, as Electron does.
function previewWindows({ workArea = { x: 0, y: 25, width: 1440, height: 875 }, platform = 'darwin' } = {}) {
  const handlers = {}, windows = [], picks = [];
  const contents = () => ({ url: '', handlers: {}, sent: [], loads: [], destroyed: false, isDestroyed() { return this.destroyed; }, close() { this.destroyed = true; },
    setWindowOpenHandler() {}, on(name, handler) { (this.handlers[name] ||= []).push(handler); }, once(name, handler) { this.on(name, handler); },
    emit(name, ...args) { for (const handler of this.handlers[name] || []) handler({ preventDefault() {} }, ...args); },
    loadFile() {}, send(channel, value) { this.sent.push([channel, value]); }, focus() {}, isLoading: () => false, reload() {},
    navigationHistory: { canGoBack: () => false, canGoForward: () => false }, async loadURL(url) { this.loads.push(url); this.url = url; }, getURL() { return this.url; }, getTitle: () => '',
    executeJavaScript: async () => null, capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 66, height: 36 }), toPNG: () => Buffer.from('png') }) });
  class View { constructor() { this.webContents = contents(); } setBounds(value) { this.bounds = value; } }
  class Window {
    constructor(options) { this.options = options; this.bounds = { x: options.x ?? 130, y: options.y ?? 40, width: options.width, height: options.height }; this.events = {}; this.views = []; this.title = ''; this.closed = false; this.contentView = { addChildView: view => this.views.push(view) }; windows.push(this); }
    getContentBounds() { return { width: this.bounds.width, height: this.bounds.height }; } getBounds() { return { ...this.bounds }; }
    on(name, handler) { (this.events[name] ||= []).push(handler); } emit(name) { for (const handler of this.events[name] || []) handler(); }
    show() {} focus() { this.emit('focus'); } isMinimized() { return false; } restore() {} setTitle(value) { this.title = value; }
    close() { if (this.closed) return; this.closed = true; this.emit('closed'); } destroy() { this.close(); } isDestroyed() { return this.closed; }
  }
  const session = { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }) };
  const preview = createPreview({ BaseWindow: Window, WebContentsView: View, session, screen: { getDisplayMatching: () => ({ workArea }) }, ipcMain: { on: (channel, handler) => { handlers[channel] = handler; }, off() {} }, shell: { openExternal() {} }, root: '/app', platform, onPick: value => picks.push(value), captureWait: 30 });
  const toolbar = win => win.views[0].webContents, page = win => win.views[1].webContents;
  const act = (win, action, value) => handlers['preview:toolbar']({ sender: toolbar(win) }, action, value);
  const lastStack = win => toolbar(win).sent.filter(([channel]) => channel === 'preview:stack').at(-1)?.[1];
  const marks = win => lastStack(win).previews.map(item => `${item.service}:${item.current ? 'here' : item.open ? 'open' : 'closed'}`);
  return { preview, handlers, windows, picks, toolbar, page, act, marks, settle: () => new Promise(resolve => setTimeout(resolve, 0)) };
}

test('each interface opens in a window of its own beside the others, and opening it again brings that window forward as it was (#142)', async () => {
  const w = previewWindows(), { preview, windows, toolbar, page } = w;
  preview.showStack('p1', { profile: 'Development', services: [{ id: 'site', name: 'Website', url: 'http://localhost:4200' }, { id: 'admin', name: 'Admin dashboard', url: 'http://localhost:4201' }, { id: 'api', name: 'API', url: 'http://127.0.0.1:8000/health' }], previews: [{ service: 'site', url: 'http://localhost:4200/' }, { service: 'admin', url: 'http://localhost:4201/' }] });
  await preview.open({ projectId: 'p1', url: 'http://localhost:4200/', workspace: 'Bizbay' });
  await preview.open({ projectId: 'p1', url: 'http://localhost:4201/', workspace: 'Bizbay' });
  const [site, admin] = windows;
  assert.equal(preview.count, 2, 'The admin panel opens beside the website instead of replacing it.');
  assert.deepEqual([page(site).getURL(), page(admin).getURL()], ['http://localhost:4200/', 'http://localhost:4201/']);
  assert.deepEqual([site.title, admin.title], ['Website · localhost:4200', 'Admin dashboard · localhost:4201'], 'The titles tell the windows apart.');
  assert.deepEqual([site.options.width, site.options.height, site.options.x], [1180, 820, undefined], 'The first window opens where the system puts it.');
  assert.deepEqual([admin.options.x, admin.options.y, admin.options.width, admin.options.height], [158, 68, 1180, 820], 'The next opens a step down and to the right, at the same size.');
  assert.equal(site.options.tabbingIdentifier, 'codeshi-preview', 'On macOS the windows can be merged into tabs.');
  const windows32 = previewWindows({ platform: 'win32' });
  await windows32.preview.open({ url: 'http://localhost:4200/' });
  assert.equal(windows32.windows[0].options.tabbingIdentifier, undefined, 'Elsewhere there are no window tabs.');
  windows32.preview.dispose();
  assert.deepEqual(w.marks(site), ['site:here', 'admin:open']);
  assert.deepEqual(w.marks(admin), ['site:open', 'admin:here']);

  // The website moves on; opening it again, even under another name for this computer, brings it forward as it is.
  page(site).url = 'http://localhost:4200/cart'; page(site).emit('did-navigate');
  await preview.open({ projectId: 'p1', url: 'http://127.0.0.1:4200/', workspace: 'Bizbay' });
  assert.equal(preview.count, 2);
  assert.deepEqual([page(site).loads, page(site).getURL()], [['http://localhost:4200/'], 'http://localhost:4200/cart'], 'Its page keeps its place and history.');
  assert.equal(preview.page.webContents, page(site), 'It is the window in use.');

  // Each window has its own picker, and a pick says which interface it came from.
  w.act(admin, 'pick');
  assert.deepEqual(page(admin).sent.at(-1), ['preview:picking', true]);
  assert.equal(page(site).sent.some(([channel]) => channel === 'preview:picking'), false, 'Picking in one window leaves the other alone.');
  const pick = { nonce: 'abcdef1234', element: { tag: 'button', text: 'Save', selector: '#save' }, rect: { x: 10, y: 10, width: 50, height: 20 }, viewport: { width: 1000, height: 700 } };
  w.handlers['preview:picked']({ sender: page(site) }, pick);
  assert.equal(w.picks.length, 0, 'A window that is not picking reports nothing.');
  page(admin).url = 'http://localhost:4201/users';
  w.handlers['preview:picked']({ sender: page(admin) }, pick);
  for (const until = Date.now() + 2000; !w.picks.length && Date.now() < until;) await w.settle();
  assert.deepEqual([w.picks[0].projectId, w.picks[0].label, w.picks[0].text], ['p1', 'Admin dashboard', 'In the preview of Admin dashboard (localhost:4201/users), the “Save” button (#save): ']);
  assert.ok(w.picks[0].image, 'With its screenshot.');
  assert.deepEqual([toolbar(admin).sent.some(([channel]) => channel === 'preview:picked'), toolbar(site).sent.some(([channel]) => channel === 'preview:picked')], [true, false]);

  // A page's API calls go to its own window's inspector, and an edit to every window of the workspace.
  w.handlers['preview:api-call']({ sender: page(site) }, { id: 'c1', type: 'fetch', url: 'http://localhost:4200/api/cart', method: 'GET', status: 200 });
  assert.deepEqual([toolbar(site).sent.some(([channel]) => channel === 'preview:api-call'), toolbar(admin).sent.some(([channel]) => channel === 'preview:api-call')], [true, false]);
  preview.showEdit('p1', { path: 'src/cart.ts', added: 2, removed: 1 });
  assert.deepEqual([site, admin].map(win => toolbar(win).sent.filter(([channel]) => channel === 'preview:edit').length), [1, 1]);

  // From a toolbar, an interface with a window comes forward and one without opens beside it; this page stays.
  w.act(site, 'open-interface', 'http://localhost:4201/'); await w.settle();
  assert.deepEqual([preview.count, preview.page.webContents === page(admin), page(site).getURL()], [2, true, 'http://localhost:4200/cart']);
  w.act(site, 'open-interface', 'http://127.0.0.1:8000/health'); await w.settle();
  const api = windows[2];
  assert.deepEqual([preview.count, api.title], [3, 'API · 127.0.0.1:8000']);
  assert.deepEqual([api.options.x, api.options.y], [186, 53], 'A window that would run off the display stays on it.');
  w.act(site, 'open-interface', 'https://example.com/'); await w.settle();
  assert.match(toolbar(site).sent.at(-1)[1], /local addresses only/);
  assert.equal(preview.count, 3);

  // A page that failed to load loads again when its interface is opened, also while it shows the browser's error page.
  page(admin).url = 'chrome-error://chromewebdata/';
  page(admin).emit('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:4201/users', true);
  admin.title = ''; page(admin).emit('did-stop-loading');
  assert.equal(admin.title, 'Admin dashboard · localhost:4201', 'It is still the admin window.');
  await preview.open({ projectId: 'p1', url: 'http://localhost:4201/' });
  assert.deepEqual([preview.count, page(admin).loads], [3, ['http://localhost:4201/', 'http://localhost:4201/']]);

  // Another workspace's preview of the same port is a window of its own, so its picks go to that workspace.
  await preview.open({ projectId: 'p2', url: 'http://localhost:4200/' });
  assert.deepEqual([preview.count, preview.shows('p2'), preview.shows('p3')], [4, true, false]);

  // Stop review closes the workspace's windows for the review's services, and their pages stop; the rest stay.
  assert.equal(preview.close({ projectId: 'p1', urls: ['http://localhost:4201/', 'http://127.0.0.1:8000/'] }), 2);
  assert.deepEqual(windows.map(win => win.closed), [false, true, true, false]);
  assert.deepEqual([page(admin).isDestroyed(), toolbar(admin).isDestroyed()], [true, true], 'A closed window’s page stops running.');
  assert.deepEqual(w.marks(site), ['site:here', 'admin:closed'], 'The website’s window sees the admin window go.');
  assert.equal(preview.close({ projectId: 'p1', urls: [] }), 0);
  preview.dispose();
  assert.deepEqual([preview.count, windows.every(win => win.closed)], [0, true]);
});

test('design notes read as one numbered message: each section, where its code is, its note, and the page as a whole (#125)', () => {
  const sections = [
    { id: 's1', element: { tag: 'section', text: 'Pricing', label: '', selector: 'section.pricing' }, source: { file: 'src/Pricing.tsx', line: 12, component: 'Pricing' }, offset: null, url: 'http://localhost:5173/' },
    { id: 's2', element: { tag: 'ul', text: '', label: 'Plans', selector: 'ul.plans' }, source: null, offset: { x: 0, y: 40, width: 640, height: 220 }, url: 'http://localhost:5173/' },
    { id: 's3', element: { tag: 'h2', text: 'Our team', label: '', selector: 'h2#team' }, source: null, offset: null, url: 'http://localhost:5173/about' },
  ];
  assert.equal(sectionName(sections[1]), 'an area of 640×220 in the “Plans” list');
  assert.equal(designText({ sections, notes: { s1: 'Three plans side by side on desktop.', s2: ' Tighter   spacing. ' }, overall: 'Calmer, more white space.', url: 'http://localhost:5173/', label: 'Web', shots: 2 }), [
    'Design notes for the preview of Web (localhost:5173), 3 sections. The numbers match the boxes in the screenshots.',
    '1. The “Pricing” section (section.pricing; src/Pricing.tsx:12 in Pricing): Three plans side by side on desktop.',
    '2. An area of 640×220 in the “Plans” list (ul.plans): Tighter spacing.',
    '3. On /about, the “Our team” heading (h2#team):',
    'Whole page: Calmer, more white space.',
  ].join('\n'));
  assert.match(designText({ sections: sections.slice(0, 1), url: 'http://localhost:5173/', shots: 0 }), /^Design notes for the preview of localhost:5173, 1 section\.\n1\. /, 'Without a screenshot it doesn’t point to one.');
  assert.deepEqual([cleanOffset({ x: 1.4, y: -3.6, width: 20, height: 10 }), cleanOffset({ x: 0, y: 0, width: 0, height: 5 }), cleanOffset({ x: 'a' }), cleanOffset(null)], [{ x: 1, y: -4, width: 20, height: 10 }, null, null, null]);
});

test('design notes: the page draws numbered boxes from selectors only, the notes stay in the toolbar, and one message carries them with its screenshots (#125)', async () => {
  const handlers = {}, picks = [], toolbar = [], page = [], captures = [], made = [];
  const shot = name => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.from(name) });
  const contents = log => ({ url: '', isDestroyed: () => false, setWindowOpenHandler() {}, on() {}, once() {}, loadFile() {}, send: (channel, value) => log.push([channel, structuredClone(value)]), focus() {}, isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    async loadURL(url) { this.url = url; }, getURL() { return this.url; }, getTitle: () => 'Shop',
    executeJavaScript: async script => script.includes('"aaaaaaaa11"') ? { component: 'Pricing', source: { file: '/work/shop/src/Pricing.tsx', line: 12 } } : null,
    capturePage: async rect => { captures.push(rect || 'page'); return shot(rect ? `crop-${captures.length}` : 'page'); } });
  class View { constructor() { this.webContents = contents(made.length % 2 === 0 ? toolbar : page); made.push(this); } setBounds() {} }
  class Window { constructor() { this.contentView = { addChildView() {} }; } getContentBounds() { return { width: 1000, height: 700 }; } on() {} show() {} focus() {} setTitle() {} close() {} destroy() {} isDestroyed() { return false; } }
  const session = { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }) };
  const preview = createPreview({ BaseWindow: Window, WebContentsView: View, session, ipcMain: { on: (channel, handler) => { handlers[channel] = handler; }, off() {} }, shell: { openExternal() {} }, root: '/app', folders: () => [{ name: 'shop', path: '/work/shop' }], onPick: value => picks.push(value), paintWait: 0, captureWait: 50 });
  await preview.open({ projectId: 'p1', url: 'http://localhost:5173/' });
  const fromToolbar = { sender: made[0].webContents }, fromPage = { sender: made[1].webContents };
  const act = (action, value) => handlers['preview:toolbar'](fromToolbar, action, value);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1)); };
  const last = (log, name) => log.filter(([channel]) => channel === name).at(-1)?.[1];
  const mark = (nonce, element, rect, offset = null) => handlers['preview:design-mark'](fromPage, { nonce, element, rect, offset, viewport: { width: 1000, height: 656 } });

  // A mark before Design notes opens is ignored.
  mark('zzzzzzzz00', { tag: 'div', selector: '#x' }, { x: 0, y: 0, width: 10, height: 10 }); await settle();
  assert.equal(last(page, 'preview:design'), undefined);

  // Opening it starts marking, and stops a pick in progress.
  preview.setPicking(true);
  act('design', { open: true, marking: true });
  assert.deepEqual(last(page, 'preview:design'), { marking: true, sections: [] });
  assert.deepEqual(last(page, 'preview:picking'), false);
  mark('aaaaaaaa11', { tag: 'section', text: 'Pricing', selector: 'section.pricing' }, { x: 20, y: 30, width: 400, height: 200 });
  mark('bbbbbbbb22', { tag: 'ul', label: 'Plans', selector: 'ul.plans' }, { x: 40, y: 500, width: 300, height: 90 }, { x: 0, y: 12.2, width: 300, height: 90 });
  await settle();
  // The page gets numbers, selectors and areas, never names, code or notes.
  assert.deepEqual(last(page, 'preview:design'), { marking: true, sections: [{ id: 's1', n: 1, selector: 'section.pricing', offset: null }, { id: 's2', n: 2, selector: 'ul.plans', offset: { x: 0, y: 12, width: 300, height: 90 } }] });
  assert.deepEqual(captures, [{ x: 4, y: 14, width: 432, height: 232 }, { x: 24, y: 484, width: 332, height: 122 }], 'Each section is captured when it is marked, with its box and a margin.');
  // The toolbar gets what the panel shows.
  assert.deepEqual(last(toolbar, 'preview:design').sections, [
    { id: 's1', n: 1, name: 'the “Pricing” section', code: 'src/Pricing.tsx:12 in Pricing', page: '', missing: false, offscreen: false },
    { id: 's2', n: 2, name: 'an area of 300×90 in the “Plans” list', code: 'ul.plans', page: '', missing: false, offscreen: false },
  ]);
  // The page says which boxes it can't find or doesn't show, as after a scroll; unknown ids are dropped.
  handlers['preview:design-layout'](fromPage, { missing: [], offscreen: ['s2', 'nope'] });
  assert.equal(last(toolbar, 'preview:design').sections[1].offscreen, true);
  // Escape on the page stops marking; the boxes stay.
  handlers['preview:design-stop'](fromPage);
  assert.deepEqual(last(page, 'preview:design').marking, false);
  assert.equal(last(page, 'preview:design').sections.length, 2);
  mark('cccccccc33', { tag: 'p', selector: 'p' }, { x: 0, y: 0, width: 5, height: 5 }); await settle();
  assert.equal(last(toolbar, 'preview:design').sections.length, 2, 'Nothing is marked while marking is off.');

  // Adding to the message: one pick with the numbered text, the page as shown, then the section out of view.
  captures.length = 0;
  act('design-send', { notes: { s1: 'Three plans side by side.', s2: 'Less space between rows.', other: 'ignored' }, overall: 'Calmer.' });
  await settle();
  assert.equal(picks.length, 1);
  const pick = picks[0];
  assert.equal(pick.design, true);
  assert.equal(pick.text, 'Design notes for the preview of localhost:5173, 2 sections. The numbers match the boxes in the screenshots.\n1. The “Pricing” section (section.pricing; src/Pricing.tsx:12 in Pricing): Three plans side by side.\n2. An area of 300×90 in the “Plans” list (ul.plans): Less space between rows.\nWhole page: Calmer.');
  assert.deepEqual(pick.images.map(image => image.name), ['design-page.png', 'design-section-2.png']);
  assert.deepEqual(captures, ['page']);
  assert.deepEqual([last(toolbar, 'preview:design-added'), last(toolbar, 'preview:design').sections, last(page, 'preview:design').sections], [{ count: 2 }, [], []], 'The notes leave Design notes once they are in the message.');

  // At most DESIGN_LIMIT sections.
  act('design', { open: true, marking: true });
  for (let i = 0; i <= DESIGN_LIMIT; i++) mark(`dddddddd${String(i).padStart(2, '0')}`, { tag: 'li', selector: `li:nth-of-type(${i + 1})` }, { x: 0, y: 0, width: 10, height: 10 });
  await settle();
  assert.equal(last(toolbar, 'preview:design').sections.length, DESIGN_LIMIT);
  assert.match(last(toolbar, 'preview:error'), /up to 12 sections/);
  act('design-remove', 's5');
  assert.deepEqual(last(page, 'preview:design').sections.slice(1, 4).map(section => [section.id, section.n]), [['s4', 2], ['s6', 3], ['s7', 4]], 'Removing one renumbers the rest; ids never repeat.');
  act('design-clear');
  assert.deepEqual(last(page, 'preview:design').sections, []);
  // Closing Design notes takes the boxes off the page.
  mark('eeeeeeee01', { tag: 'li', selector: 'li' }, { x: 0, y: 0, width: 10, height: 10 }); await settle();
  act('design', { open: false });
  assert.deepEqual(last(page, 'preview:design'), { marking: false, sections: [] });
  assert.equal(last(toolbar, 'preview:design').sections.length, 1, 'Closing keeps the sections for when it opens again.');
  preview.dispose();
});

test('the toolbar keeps each note as it is typed, sends them with the sections, and the page preload gives the page nothing (#125)', () => {
  const html = fs.readFileSync(new URL('../desktop/preview-toolbar.html', import.meta.url), 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(html, /id="design-btn"/); assert.match(html, /id="design-panel"/);
  assert.doesNotMatch(script, /innerHTML/);
  const preload = fs.readFileSync(new URL('../desktop/preview-page-preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /attachShadow\(\{ mode: 'closed' \}\)[\s\S]*codeshi-design/);
  assert.doesNotMatch(preload, /contextBridge|exposeInMainWorld|postMessage/, 'The boxes and marks never reach the page’s scripts.');
  assert.doesNotMatch(preload, /attributes: true/, 'The boxes follow the page’s structure, not every style change, to keep idle work low.');
});

// A small page for the page preload: elements with ids, sizes and children, and the window's listeners, so marking
// with the keyboard can be tried without Electron.
function preloadPage() {
  const sent = [], listeners = {}, ipc = {};
  const make = (tag, id, size = [100, 20], kids = []) => {
    const node = { nodeType: 1, tagName: tag.toUpperCase(), id, children: kids, parentElement: null, classList: [], style: {}, isConnected: true, innerText: id, textContent: id, attributes: {}, scrolled: 0,
      getAttribute(name) { return this.attributes[name] ?? null; }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      matches(selector) { return selector.split(',').map(part => part.trim()).includes(tag); }, closest: () => null, querySelector: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: size[0], bottom: size[1], width: size[0], height: size[1] }), scrollIntoView() { this.scrolled++; } };
    for (const kid of kids) kid.parentElement = node;
    return node;
  };
  const one = make('h2', 'one'), hidden = make('p', 'hidden', [0, 0]), two = make('p', 'two'), three = make('a', 'three');
  const card = make('section', 'card', [300, 200], [one, hidden, two]), main = make('main', 'main', [800, 600], [card, three]);
  const script = make('script', 'script'), body = make('body', 'body', [800, 600], [script, main]);
  const all = [one, hidden, two, three, card, main, body];
  const documentElement = { nodeType: 1, appendChild() {} };
  body.parentElement = documentElement;
  const document = { body, documentElement, activeElement: body, hidden: false,
    querySelector: selector => selector.startsWith('main') ? main : null,
    querySelectorAll: selector => all.filter(node => '#' + node.id === selector),
    createElement: tag => ({ tagName: tag.toUpperCase(), style: {}, isConnected: true, remove() {}, attachShadow: () => ({ append() {}, replaceChildren() {} }) }) };
  const window = { addEventListener: (type, handler) => { (listeners[type] ||= []).push(handler); }, innerWidth: 1000, innerHeight: 700 };
  const require = () => ({ ipcRenderer: { send: (channel, value) => sent.push([channel, value]), on: (channel, handler) => { ipc[channel] = handler; } } });
  const source = fs.readFileSync(new URL('../desktop/preview-page-preload.cjs', import.meta.url), 'utf8');
  new Function('require', 'window', 'document', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'MutationObserver', 'CSS', 'addEventListener', 'setTimeout', source)(require, window, document, 1000, 700, () => 1, class { observe() {} disconnect() {} }, { escape: value => value }, window.addEventListener, () => 0);
  const key = (name, extra = {}) => { const event = { key: name, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() {}, ...extra }; for (const handler of listeners.keydown) handler(event); return event; };
  return { sent, ipc, key, nodes: { one, two, three, card, main, body } };
}

test('design notes can be marked with the keyboard: arrows move through the page like a tree, Enter marks, and the page never sees those keys (#125)', () => {
  const page = preloadPage(), named = () => page.sent.filter(([channel]) => channel === 'preview:design-cursor').map(([, value]) => value.text);
  // Not marking: the page keeps its keys.
  assert.equal(page.key('ArrowDown').stopped, false);
  page.ipc['preview:design'](null, { marking: true, sections: [] });
  // The first key outlines where to start: the focused element, or else the page's main content.
  assert.equal(page.key('ArrowDown').stopped, true);
  assert.deepEqual(named(), ['main']);
  page.key('ArrowRight'); page.key('ArrowRight');
  assert.deepEqual(named(), ['main', 'card', 'one'], 'Right goes in.');
  page.key('ArrowDown');
  assert.equal(named().at(-1), 'two', 'Down skips what takes up no space.');
  page.key('ArrowDown');
  assert.equal(named().length, 4, 'The last child stays outlined, and isn’t said again.');
  page.key('ArrowLeft'); page.key('ArrowDown');
  assert.deepEqual(named().slice(-2), ['card', 'three'], 'Left goes out, to the element around it.');
  assert.ok(page.nodes.three.scrolled, 'An outlined element is scrolled into view.');
  page.key('Enter');
  const marks = page.sent.filter(([channel]) => channel === 'preview:design-mark');
  assert.deepEqual(marks.map(([, value]) => [value.element.selector, value.offset]), [['#three', null]]);
  assert.equal(page.key('Enter', { repeat: true }).stopped, true, 'A held Enter marks once.');
  assert.equal(page.sent.filter(([channel]) => channel === 'preview:design-mark').length, 1);
  page.key('ArrowUp');
  assert.equal(named().at(-1), 'card', 'After a mark the arrows carry on from it.');
  // Shortcuts with ⌘ or Ctrl still reach the page, and Escape stops marking.
  assert.equal(page.key('ArrowDown', { metaKey: true }).stopped, false);
  page.key('Escape');
  assert.deepEqual(page.sent.at(-1), ['preview:design-stop', undefined]);
  assert.equal(page.key('ArrowDown').stopped, false, 'Marking is off, so the page has its keys back.');
});

test('design notes not yet in a message outlive their window, and come back to the next window on the same interface (#125)', async () => {
  const w = previewWindows(), { preview, windows, toolbar, page, handlers } = w;
  const last = (contents, name) => contents.sent.filter(([channel]) => channel === name).at(-1)?.[1];
  const mark = (win, nonce, selector) => handlers['preview:design-mark']({ sender: page(win) }, { nonce, element: { tag: 'section', text: selector, selector }, rect: { x: 0, y: 0, width: 50, height: 20 }, viewport: { width: 1000, height: 700 } });
  await preview.open({ projectId: 'p1', url: 'http://localhost:5173/' });
  const first = windows[0];
  w.act(first, 'design', { open: true, marking: true });
  mark(first, 'aaaaaaaa01', '#hero'); mark(first, 'aaaaaaaa02', '#plans'); await w.settle();
  w.act(first, 'design-notes', { notes: { s1: 'Bigger heading.', s2: 'Three columns.', nope: 'dropped' }, overall: 'Calmer.' });

  // The keyboard's outline is named for the toolbar to say, only while marking.
  handlers['preview:design-cursor']({ sender: page(first) }, { tag: 'nav', text: 'Menu', selector: 'nav' });
  assert.deepEqual(last(toolbar(first), 'preview:design-cursor'), { name: 'the “Menu” navigation' });
  // Escape on the page takes the keyboard to the notes.
  let focused = 0; toolbar(first).focus = () => { focused++; };
  handlers['preview:design-stop']({ sender: page(first) });
  assert.deepEqual([focused, toolbar(first).sent.at(-1)], [1, ['preview:design-write', undefined]]);
  handlers['preview:design-cursor']({ sender: page(first) }, { tag: 'nav', selector: 'nav' });
  assert.equal(toolbar(first).sent.filter(([channel]) => channel === 'preview:design-cursor').length, 1, 'Nothing is said while marking is off.');

  first.close();
  // Another workspace, or another interface, doesn't get them.
  await preview.open({ projectId: 'p2', url: 'http://localhost:5173/' });
  await preview.open({ projectId: 'p1', url: 'http://localhost:4200/' });
  for (const win of windows.slice(1)) { toolbar(win).emit('did-finish-load'); assert.equal(last(toolbar(win), 'preview:design-restore'), undefined); }
  // The same interface in the same workspace gets them back, sections and all, under any of this computer's names.
  await preview.open({ projectId: 'p1', url: 'http://127.0.0.1:5173/pricing' });
  const again = windows.at(-1);
  toolbar(again).emit('did-finish-load');
  assert.deepEqual(last(toolbar(again), 'preview:design-restore'), { notes: { s1: 'Bigger heading.', s2: 'Three columns.' }, overall: 'Calmer.', count: 2 });
  w.act(again, 'design', { open: true, marking: false });
  assert.deepEqual(last(page(again), 'preview:design'), { marking: false, sections: [{ id: 's1', n: 1, selector: '#hero', offset: null }, { id: 's2', n: 2, selector: '#plans', offset: null }] });
  mark(again, 'aaaaaaaa03', '#faq'); await w.settle();
  assert.equal(last(toolbar(again), 'preview:design').sections.length, 2, 'The panel opens with marking off.');
  w.act(again, 'design', { open: true, marking: true });
  mark(again, 'aaaaaaaa04', '#faq'); await w.settle();
  assert.deepEqual(last(toolbar(again), 'preview:design').sections.map(section => section.id), ['s1', 's2', 's3'], 'New sections never reuse an id.');

  // Once they're in a message, closing keeps nothing.
  w.act(again, 'design-send', { notes: {}, overall: '' });
  for (const until = Date.now() + 2000; !w.picks.length && Date.now() < until;) await w.settle();
  assert.equal(w.picks.length, 1);
  again.close();
  await preview.open({ projectId: 'p1', url: 'http://localhost:5173/' });
  toolbar(windows.at(-1)).emit('did-finish-load');
  assert.equal(last(toolbar(windows.at(-1)), 'preview:design-restore'), undefined);
  preview.dispose();
});

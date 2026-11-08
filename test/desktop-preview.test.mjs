import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { INSPECTOR_WIDTH, apiInterceptorScript, captureRect, cleanElement, createPreview, isPreviewURL, pickText, previewURL, sourceLocation, sourceScript } from '../desktop/preview.mjs';

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
  assert.equal(preview.projectId, null, 'Before it opens it follows nothing.');
  await preview.open({ projectId: 'p', url: 'http://localhost:5173/' });
  assert.equal(preview.projectId, 'p');
  sent.length = 0;
  preview.showEdit({ path: 'src/BuyBox.tsx', added: 4, removed: 2, contents: 'SECRET' });
  preview.showEdit({ path: 'src/BuyBox.tsx', added: 4, removed: 2 });
  preview.showEdit(null);
  assert.deepEqual(sent.filter(([channel]) => channel === 'preview:edit'), [['preview:edit', { path: 'src/BuyBox.tsx', added: 4, removed: 2 }], ['preview:edit', null]], 'Only a file and counts, and only when it changes.');
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
  preview.showStack(stack);
  assert.deepEqual(sent.filter(([ch]) => ch === 'preview:stack'), [['preview:stack', stack]]);
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
  const contents = () => ({ url: '', handlers: {}, isDestroyed: () => false, setWindowOpenHandler() {}, on(name, handler) { this.handlers[name] = handler; }, once() {}, loadFile() {}, send: (channel, value) => sent.push([channel, value]), focus() {}, isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false }, async loadURL(url) { this.url = url; }, getURL() { return this.url; }, getTitle: () => '', executeJavaScript: async () => {} });
  class View { constructor() { this.webContents = contents(); this.bounds = null; views.push(this); } setBounds(value) { this.bounds = value; } }
  class Window { constructor() { this.contentView = { addChildView: view => added.push(view) }; } getContentBounds() { return { ...size }; } on(name, handler) { events[name] = handler; } show() {} focus() {} setTitle() {} close() {} destroy() {} isDestroyed() { return false; } }
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
  assert.equal(page.bounds.width, 240, 'Opening another address keeps the inspector as the toolbar shows it.');
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

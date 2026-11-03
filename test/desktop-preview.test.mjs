import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { captureRect, cleanElement, createPreview, isPreviewURL, pickText, previewURL, sourceLocation, sourceScript } from '../desktop/preview.mjs';

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

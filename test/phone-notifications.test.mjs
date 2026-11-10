import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Runs the shipped Notifications step of the phone page (#23) with a controlled browser: push support, permission, a
// service worker and the computer's answers. No layout claims are made here.
const source = fs.readFileSync(new URL('../public/phone.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('  // ---- Home Screen.'), source.indexOf("  $('where').addEventListener('click'"));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');

function page({ installed = true, push = true, remote = true, permission = 'default', answer = 'granted', stored = {}, existing = null } = {}) {
  const storage = new Map(Object.entries(stored)), sheets = [], calls = [], toasts = [], subscribed = [], unsubscribed = [];
  let current = existing, computer = { subscribed: false, endpoint: null };
  const subscription = (endpoint, key) => ({ endpoint, options: { applicationServerKey: Uint8Array.from(Buffer.from(key, 'base64url')).buffer }, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { unsubscribed.push(endpoint); current = null; return true; } });
  if (existing) current = subscription(existing.endpoint, existing.key);
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async options => { subscribed.push(options); current = subscription('https://web.push.apple.com/new', Buffer.from(options.applicationServerKey).toString('base64url')); return current; },
  };
  const registration = { pushManager };
  const serviceWorker = { register: async (path, options) => { calls.push(['register', path, options.scope]); return registration; }, ready: Promise.resolve(registration), getRegistration: async () => current || existing ? registration : undefined };
  const Notification = { permission, requestPermission: async () => { Notification.permission = answer; return answer; } };
  const window = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: installed }), navigator: { standalone: installed }, isSecureContext: true, ...(push ? { PushManager: function () {}, Notification } : {}) });
  const element = (tag, cls, text) => ({ tag, cls, text, children: [], childElementCount: 0, append(...items) { this.children.push(...items); this.childElementCount = this.children.length; }, click: null });
  const context = {
    window, document: { hidden: false }, navigator: { userAgent: IPHONE, maxTouchPoints: 5, ...(push ? { serviceWorker } : {}) }, transport: { remote }, Notification, btoa, atob, Uint8Array, String, JSON,
    sheet: { open: false }, sheetView: null, S: { projects: [], projectId: null },
    remember: (key, value) => storage.set(key, value), recall: key => storage.get(key) ?? null,
    node: element, button: (text, handler, cls) => Object.assign(element('button', cls, text), { click: handler }),
    attempt: work => Promise.resolve().then(work), toast: message => toasts.push(message), drawSheet() {}, closeSheet() { context.sheetView = null; },
    openSheet(title, build) { const body = element('body'); build(body); context.sheetView = { title }; context.sheet.open = true; sheets.push({ title, body }); },
    moveToAnotherBrowser: async () => {}, setTimeout: fn => fn(),
    async phoneFetch(path, options = {}) {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push([path, body]);
      if (body?.action === 'subscribe') computer = { subscribed: true, endpoint: body.subscription.endpoint };
      if (body?.action === 'unsubscribe') computer = { subscribed: false, endpoint: null };
      return { ok: true, json: async () => ({ key: KEY, ...computer }) };
    },
  };
  const controls = vm.runInNewContext(`${section}\n({ notificationsSheet, notificationsAvailable, offerNotifications })`, context);
  const text = body => JSON.stringify(body, (key, value) => key === 'click' ? undefined : value);
  const buttons = body => { const found = []; const walk = item => { if (item?.tag === 'button') found.push(item); for (const child of item?.children || []) walk(child); }; walk(body); return found; };
  return { controls, storage, sheets, calls, toasts, subscribed, unsubscribed, context, text, buttons, last: () => sheets.at(-1) };
}

test('a Home Screen icon turns lock-screen notifications on with the computer’s key, and off again (#23)', async () => {
  const p = page();
  assert.equal(p.controls.notificationsAvailable(), true);
  await p.controls.notificationsSheet();
  assert.match(p.text(p.last().body), /lock screen/);
  assert.match(p.text(p.last().body), /only what happened and in which workspace/);
  const [on] = p.buttons(p.last().body);
  assert.equal(on.text, 'Turn on notifications');
  await on.click();
  assert.equal(p.subscribed.length, 1);
  assert.equal(p.subscribed[0].userVisibleOnly, true);
  assert.equal(Buffer.from(p.subscribed[0].applicationServerKey).toString('base64url'), KEY, 'It subscribes with the computer’s own key.');
  assert.deepEqual(p.calls.find(call => call[0] === 'register'), ['register', '/phone-sw.js', '/']);
  assert.deepEqual(p.calls.find(call => call[1]?.action === 'subscribe')[1], { action: 'subscribe', subscription: { endpoint: 'https://web.push.apple.com/new', keys: { p256dh: 'p', auth: 'a' } } });
  assert.match(p.text(p.last().body), /On\. /);
  const [off] = p.buttons(p.last().body);
  assert.equal(off.text, 'Turn off');
  await off.click();
  assert.deepEqual(p.unsubscribed, ['https://web.push.apple.com/new']);
  assert.ok(p.calls.some(call => call[1]?.action === 'unsubscribe'));
  assert.equal(p.buttons(p.last().body)[0].text, 'Turn on notifications');
});

test('a subscription made for another computer is replaced, and a refusal is explained (#23)', async () => {
  const p = page({ existing: { endpoint: 'https://web.push.apple.com/old', key: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url') } });
  await p.controls.notificationsSheet();
  await p.buttons(p.last().body)[0].click();
  assert.deepEqual(p.unsubscribed, ['https://web.push.apple.com/old']);
  assert.equal(p.subscribed.length, 1);

  const refused = page({ answer: 'denied' });
  await refused.controls.notificationsSheet();
  await refused.buttons(refused.last().body)[0].click();
  assert.equal(refused.subscribed.length, 0);
  assert.match(refused.text(refused.last().body), /blocked.*Settings › Notifications › Codeshi/);
  assert.equal(refused.buttons(refused.last().body).length, 0);
});

test('Safari on iPhone is sent to the Home Screen first; Same Wi-Fi has no notifications (#23)', async () => {
  const safari = page({ installed: false, push: false });
  assert.equal(safari.controls.notificationsAvailable(), true);
  await safari.controls.notificationsSheet();
  assert.match(safari.text(safari.last().body), /Home Screen icon/);
  assert.equal(safari.buttons(safari.last().body)[0].text, 'Add to Home Screen');

  assert.equal(page({ remote: false }).controls.notificationsAvailable(), false);
  assert.equal(page({ remote: false, installed: false, push: false }).controls.notificationsAvailable(), false);
});

test('the step is offered once in an installed app, and not when already answered (#23)', async () => {
  const p = page();
  p.controls.offerNotifications();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.sheets.length, 1);
  assert.equal(p.sheets[0].title, 'Notifications');
  p.context.sheet.open = false;
  p.controls.offerNotifications(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.sheets.length, 1);
  const again = page({ stored: Object.fromEntries(p.storage) });
  again.controls.offerNotifications(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(again.sheets.length, 0, 'Once seen, it stays at the bottom of the workspace list.');
  const decided = page({ permission: 'granted' });
  decided.controls.offerNotifications(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(decided.sheets.length, 0);
});

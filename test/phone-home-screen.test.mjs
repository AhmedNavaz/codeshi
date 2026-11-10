import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Runs the shipped Home Screen step with a controlled device, storage and sheet. No layout claims are made here.
const source = fs.readFileSync(new URL('../public/phone.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('  // ---- Home Screen.'), source.indexOf("  $('where').addEventListener('click'"));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SCANNER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

function page({ agent = IPHONE, remote = true, installed = false, stored = {} } = {}) {
  const storage = new Map(Object.entries(stored)), sheets = [], moves = [];
  const window = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: installed }), navigator: {} });
  const element = (tag, cls, text) => ({ tag, cls, text, children: [], childElementCount: 0, append(...items) { this.children.push(...items); this.childElementCount = this.children.length; }, click: null });
  const context = {
    window, document: { hidden: false }, navigator: { userAgent: agent, maxTouchPoints: agent === MAC ? 0 : 5 }, transport: remote ? { remote: true } : { remote: false },
    sheet: { open: false }, sheetView: null,
    remember: (key, value) => storage.set(key, value), recall: key => storage.get(key) ?? null,
    node: element, button: (text, handler, cls) => Object.assign(element('button', cls, text), { click: handler }),
    attempt: work => Promise.resolve().then(work), toast() {}, drawSheet() {}, closeSheet() { context.sheetView = null; },
    openSheet(title, build) { const body = element('body'); build(body); context.sheetView = { title }; context.sheet.open = true; sheets.push({ title, body }); },
    moveToAnotherBrowser: async () => { moves.push(true); }, setTimeout: fn => fn(),
  };
  const controls = vm.runInNewContext(`${section}\n({ offerHomeScreen, homeScreenAvailable, homeScreenSheet })`, context);
  const text = body => JSON.stringify(body, (key, value) => key === 'click' ? undefined : value);
  const buttons = body => { const found = []; const walk = item => { if (item?.tag === 'button') found.push(item); for (const child of item?.children || []) walk(child); }; walk(body); return found; };
  return { controls, storage, sheets, moves, window, context, text, buttons };
}

test('after pairing, an iPhone gets Add to Home Screen once, with a way to bring the connection to the icon (#115)', async () => {
  const p = page();
  p.controls.offerHomeScreen();
  assert.equal(p.sheets.length, 1);
  assert.equal(p.sheets[0].title, 'Add to Home Screen');
  assert.match(p.text(p.sheets[0].body), /Share menu.*Add to Home Screen/);
  assert.match(p.text(p.sheets[0].body), /If it asks for a code/);
  const [code] = p.buttons(p.sheets[0].body);
  assert.equal(code.text, 'Get a code');
  await code.click(); assert.equal(p.moves.length, 1, 'Get a code makes a one-use transfer for the new icon.');
  p.context.sheet.open = false;
  p.controls.offerHomeScreen(); assert.equal(p.sheets.length, 1, 'It is offered once per page load.');
  const again = page({ stored: Object.fromEntries(p.storage) });
  again.controls.offerHomeScreen(); assert.equal(again.sheets.length, 0, 'Once seen or dismissed, it does not come back by itself.');
  assert.equal(again.controls.homeScreenAvailable(), true, 'It stays reachable from the workspace list.');
});

test('a scanner app’s browser is sent to Safari first, and Android uses its install prompt (#115)', async () => {
  const scanner = page({ agent: SCANNER });
  scanner.controls.offerHomeScreen();
  assert.match(scanner.text(scanner.sheets[0].body), /another app’s browser/);
  assert.equal(scanner.buttons(scanner.sheets[0].body)[0].text, 'Move to Safari');

  const android = page({ agent: ANDROID });
  android.controls.homeScreenSheet();
  assert.match(android.text(android.sheets[0].body), /Install app or Add to Home screen/, 'Without a prompt yet, it explains the browser menu.');
  let prompted = 0;
  android.window.codeshiInstallPrompt = { prompt: async () => { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
  android.controls.homeScreenSheet();
  const install = android.buttons(android.sheets[1].body).find(item => item.text === 'Install');
  await install.click();
  assert.equal(prompted, 1);
  assert.equal(android.storage.get('codeshi:home-screen-step'), 'installed');
  assert.equal(android.controls.homeScreenAvailable(), false, 'An installed app is not offered again.');
});

test('the step is not offered in an installed app, on Same Wi-Fi, or on a computer (#115)', () => {
  for (const options of [{ installed: true }, { remote: false }, { agent: MAC }]) {
    const p = page(options);
    p.controls.offerHomeScreen();
    assert.equal(p.sheets.length, 0, JSON.stringify(options));
    assert.equal(p.controls.homeScreenAvailable(), false);
  }
  const installed = page();
  installed.window.dispatchEvent(new Event('appinstalled'));
  assert.equal(installed.storage.get('codeshi:home-screen-step'), 'installed');
});

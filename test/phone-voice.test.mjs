import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/phone.js', import.meta.url), 'utf8');

// Runs the phone page's real message box code, from clearing it through Send, Add to run and voice, against a fake
// browser speech recognizer and API, so the shipped logic is what's tested.
function voice({ supported = true, secure = true, agreed = false, startThrows = false, apiFails = false } = {}) {
  const block = source.slice(source.indexOf('  function clearComposer(draft) {'), source.indexOf('  // Photos are shrunk here first'));
  const recognizers = [], toasts = [], requests = [], sheets = [];
  const stored = new Map(agreed ? [['codeshi:phone-voice', 'ok']] : []);
  class Recognizer {
    constructor() { this.started = 0; this.stopped = 0; this.aborted = 0; recognizers.push(this); }
    start() { if (startThrows) throw Error('busy'); this.started++; }
    stop() { this.stopped++; }
    abort() { this.aborted++; }
    // A browser can still report after being stopped, which only reaches the page while a handler is attached.
    hear(parts) { this.onresult?.({ results: parts.map(text => [{ transcript: text }]) }); }
    end() { this.onend?.(); }
  }
  const attrs = new Map(), classes = new Set();
  const element = () => ({ listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  const mic = { ...element(), hidden: false, classList: { add: name => classes.add(name), remove: name => classes.delete(name) }, setAttribute: (name, value) => attrs.set(name, value) };
  const input = { value: '', blur() {} };
  const elements = { mic, composer: element(), 'add-to-run': element() };
  const document = new EventTarget(); document.hidden = false;
  const S = { sending: false, c: { id: 'c' }, attachments: new Map(), retry: null, settings: { provider: 'claude', model: '', effort: null, mode: 'edit', approvalPolicy: 'ask' }, savedChain: Promise.resolve(), draft: null };
  const view = { key: 'draft' };
  const context = {
    window: { isSecureContext: secure, ...(supported ? { SpeechRecognition: Recognizer } : {}) }, document, navigator: { language: 'en-GB' },
    $: id => elements[id] || {}, input, S, listening: null, pinned: false,
    sizeInput() {}, renderComposer() {}, remember: (key, value) => stored.set(key, value), recall: key => stored.get(key) ?? null, draftKey: () => view.key, viewKey: () => view.key,
    toast: message => { if (message) toasts.push(message); }, attempt: work => Promise.resolve().then(work).catch(error => toasts.push(error.message)),
    openSheet: (title, fill) => { const host = { children: [], append: (...items) => host.children.push(...items) }; fill(host); sheets.push({ title, host }); },
    closeSheet() {}, onSheetClosed: null, setTimeout, crypto: globalThis.crypto,
    node: (tag, cls, text) => ({ tag, cls, text, children: [], append(...items) { this.children.push(...items); } }), button: (label, onClick, cls) => ({ label, onClick, cls }),
    attachments: () => [], isRunning: () => false, routeFor: () => null, billingAllowed: async () => true, charged: () => false, refreshConversation: async () => {}, selectThread: async () => {},
    endpoint: name => name, L: { requestId: () => 'request' },
    api: async (path, options) => { requests.push({ path, body: options.body }); if (apiFails) throw Error('Could not send.'); return { added: true }; },
  };
  vm.runInNewContext(block, context);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  // A tap whose sheet is never answered stays pending, so the click itself isn't awaited.
  const tap = async () => { void mic.listeners.click(); await settle(); };
  const send = async () => { elements.composer.listeners.submit({ preventDefault() {} }); await settle(); };
  const addToRun = async () => { elements['add-to-run'].listeners.click(); await settle(); };
  return { mic, input, recognizers, toasts, stored, sheets, requests, tap, send, addToRun, attrs, classes, document, S, view, stopListening: () => context.stopListening(), listening: () => context.listening };
}

test('the mic is hidden where the browser cannot recognise speech, and on plain HTTP', () => {
  assert.equal(voice({ supported: false }).mic.hidden, true);
  assert.equal(voice({ secure: false }).mic.hidden, true, 'Browsers block the microphone on a same-Wi-Fi connection.');
  assert.equal(voice().mic.hidden, false);
});

test('the first use says where the audio goes, declining starts nothing, and agreeing is remembered', async () => {
  const v = voice();
  await v.tap();
  assert.equal(v.sheets.length, 1);
  assert.equal(v.sheets[0].title, 'Voice on this phone');
  assert.match(v.sheets[0].host.children[0].text, /Apple or Google/);
  assert.equal(v.recognizers.length, 0, 'Nothing listens until the person agrees.');
  const buttons = () => v.sheets.at(-1).host.children.at(-1).children.map(item => item.label);
  assert.deepEqual(buttons(), ['Not now', 'Use voice']);
  v.sheets[0].host.children.at(-1).children[0].onClick(); await v.tap();
  assert.equal(v.recognizers.length, 0, 'Not now starts nothing, and the next tap asks again.');
  assert.equal(v.sheets.length, 2);
  v.sheets[1].host.children.at(-1).children[1].onClick(); await v.tap();
  assert.equal(v.recognizers.length, 1, 'Agreeing starts listening.');
  assert.equal(v.stored.get('codeshi:phone-voice'), 'ok');
});

test('speech lands in the message box after what was typed, and stopping keeps it as the draft', async () => {
  const v = voice({ agreed: true });
  v.input.value = 'Fix the header';
  await v.tap();
  assert.equal(v.sheets.length, 0, 'An agreed phone is not asked again.');
  assert.equal(v.recognizers[0].started, 1);
  assert.equal(v.classes.has('listening'), true);
  assert.equal(v.attrs.get('aria-pressed'), 'true');
  v.recognizers[0].hear(['and make it ']);
  assert.equal(v.input.value, 'Fix the header and make it');
  v.recognizers[0].hear(['and make it ', 'blue']);
  assert.equal(v.input.value, 'Fix the header and make it blue');
  await v.tap();
  assert.equal(v.recognizers[0].stopped, 1);
  assert.equal(v.classes.has('listening'), false);
  assert.equal(v.stored.get('draft'), 'Fix the header and make it blue', 'The words are kept as the draft, not sent.');
  assert.deepEqual(v.requests, []);
  assert.deepEqual(v.toasts, []);
});

test('Send turns the mic off, sends what was heard and clears the box for good', async () => {
  const v = voice({ agreed: true });
  await v.tap();
  const recognizer = v.recognizers[0];
  recognizer.hear(['make the button blue']);
  await v.send();
  assert.equal(v.classes.has('listening'), false, 'The mic is off.');
  assert.equal(v.attrs.get('aria-pressed'), 'false');
  assert.equal(recognizer.aborted, 1);
  assert.equal(v.requests[0].body.text, 'make the button blue');
  assert.equal(v.input.value, '', 'The box is cleared.');
  assert.equal(v.stored.get('draft'), null, 'The draft is cleared.');
  recognizer.hear(['make the button blue and also']);
  recognizer.end();
  assert.equal(v.input.value, '', 'A late result doesn\'t bring the words back.');
  assert.equal(v.stored.get('draft'), null);
});

test('a failed Send turns the mic off and keeps the words to try again', async () => {
  const v = voice({ agreed: true, apiFails: true });
  await v.tap();
  v.recognizers[0].hear(['make the button blue']);
  await v.send();
  assert.equal(v.classes.has('listening'), false);
  assert.equal(v.input.value, 'make the button blue');
  assert.equal(v.stored.get('draft'), 'make the button blue');
  assert.deepEqual(v.toasts, ['Could not send.']);
});

test('Add to run turns the mic off and clears the box too', async () => {
  const v = voice({ agreed: true });
  await v.tap();
  const recognizer = v.recognizers[0];
  recognizer.hear(['also check the footer']);
  await v.addToRun();
  assert.equal(v.classes.has('listening'), false);
  assert.equal(v.requests[0].body.text, 'also check the footer');
  assert.equal(v.input.value, '');
  recognizer.hear(['also check the footer please']);
  assert.equal(v.input.value, '');
});

test('the last words after tapping the mic off still land, until the browser finishes', async () => {
  const v = voice({ agreed: true });
  await v.tap();
  const recognizer = v.recognizers[0];
  recognizer.hear(['make it']);
  await v.tap();
  assert.equal(v.classes.has('listening'), false, 'The mic looks off straight away.');
  recognizer.hear(['make it blue']);
  assert.equal(v.input.value, 'make it blue');
  recognizer.end();
  assert.equal(v.stored.get('draft'), 'make it blue');
  assert.equal(v.listening(), null);
  recognizer.hear(['make it blue again']);
  assert.equal(v.input.value, 'make it blue', 'Nothing lands once it has finished.');
});

test('sending while the last words are still being worked out drops them', async () => {
  const v = voice({ agreed: true });
  await v.tap();
  const recognizer = v.recognizers[0];
  recognizer.hear(['make it blue']);
  await v.tap();
  await v.send();
  recognizer.hear(['make it blue now']);
  assert.equal(v.input.value, '');
  assert.equal(v.requests[0].body.text, 'make it blue');
});

test('the mic can be turned on again straight after being tapped off', async () => {
  const v = voice({ agreed: true });
  await v.tap();
  v.recognizers[0].hear(['first']);
  await v.tap();
  await v.tap();
  assert.equal(v.recognizers.length, 2);
  assert.equal(v.classes.has('listening'), true);
  v.recognizers[0].hear(['first and old']);
  assert.equal(v.input.value, 'first', 'The earlier recogniser is finished with.');
  v.recognizers[1].hear(['second']);
  assert.equal(v.input.value, 'first second');
});

test('words changed by something else are not overwritten by the next result', async () => {
  const v = voice({ agreed: true });
  await v.tap();
  const recognizer = v.recognizers[0];
  recognizer.hear(['one']);
  v.input.value = 'changed elsewhere';
  recognizer.hear(['one two']);
  assert.equal(v.input.value, 'changed elsewhere');
  assert.equal(v.classes.has('listening'), false);
  assert.equal(recognizer.aborted, 1);
});

test('the draft stays with the conversation it was spoken in', async () => {
  const v = voice({ agreed: true });
  v.view.key = 'first';
  await v.tap();
  v.recognizers[0].hear(['for the first one']);
  v.view.key = 'second';
  v.stopListening();
  assert.equal(v.stored.get('first'), 'for the first one');
  assert.equal(v.stored.has('second'), false);
});

test('results from any browser read as one sentence', async () => {
  const android = voice({ agreed: true });
  await android.tap();
  android.recognizers[0].hear(['make', 'make it', 'make it blue']);
  assert.equal(android.input.value, 'make it blue', 'Android Chrome can repeat earlier words in each result.');

  const safari = voice({ agreed: true });
  await safari.tap();
  safari.recognizers[0].hear(['make it', 'blue', ' ', 'now']);
  assert.equal(safari.input.value, 'make it blue now', 'A space goes between results that lack one.');

  const typed = voice({ agreed: true });
  typed.input.value = 'Note: ';
  await typed.tap();
  typed.recognizers[0].hear(['check this']);
  assert.equal(typed.input.value, 'Note: check this', 'No second space after typed text that ends in one.');
});

test('the mic does not start while a message is being sent', async () => {
  const v = voice({ agreed: true });
  v.S.sending = true;
  await v.tap();
  assert.equal(v.recognizers.length, 0);
});

test('a denied microphone, a failure to start and a hidden page each stop listening with the right message', async () => {
  const denied = voice({ agreed: true });
  await denied.tap();
  denied.recognizers[0].onerror({ error: 'not-allowed' });
  assert.equal(denied.classes.has('listening'), false);
  assert.match(denied.toasts[0], /Allow the microphone/);

  const quiet = voice({ agreed: true });
  await quiet.tap();
  quiet.recognizers[0].onerror({ error: 'no-speech' });
  assert.equal(quiet.classes.has('listening'), false);
  assert.deepEqual(quiet.toasts, [], 'Silence is not an error worth a message.');

  const broken = voice({ agreed: true, startThrows: true });
  await broken.tap();
  assert.equal(broken.classes.has('listening'), false);
  assert.equal(broken.listening(), null);
  assert.match(broken.toasts[0], /dictation key/);

  const hidden = voice({ agreed: true });
  await hidden.tap();
  hidden.document.hidden = true; hidden.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(hidden.recognizers[0].stopped, 1);
  assert.equal(hidden.classes.has('listening'), false);
});

test('typing, moving to another conversation and an answered question all turn the mic off', () => {
  assert.match(source, /input\.addEventListener\('input', \(\) => \{ stopListening\(\);/);
  assert.match(source, /function changedView\([^)]*\) \{\s*stopListening\(\);/);
  assert.match(source, /if \(view === S\.view\) \{ stopListening\(\); \$\('input'\)\.value = draft;/);
  assert.match(source, /\$\('mic'\)\.disabled = S\.sending;/);
  // Moving to a conversation happens while the page starts, so this must be declared before anything can run it.
  assert.ok(source.indexOf('let listening = null') < source.indexOf('function changedView('));
});

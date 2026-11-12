import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Runs the phone page's shipped read-aloud code (#23) against a fake speech engine, so what's tested is what ships.
const source = fs.readFileSync(new URL('../public/phone.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const section = source.slice(source.indexOf('  // ---- Replies read aloud (#23)'), source.indexOf('  // ---- Sheets.'));
const logic = {};
vm.runInNewContext(fs.readFileSync(new URL('../public/phone-logic.js', import.meta.url), 'utf8'), logic);
// The script runs in its own realm, so its arrays are copied before comparing.
const spokenParts = text => [...logic.relayPhoneLogic.spokenParts(text)];

function page({ speech = true, stored = {}, running = null } = {}) {
  const storage = new Map(Object.entries(stored)), spoken = [], toasts = [], events = { stopListening: 0, drawn: 0 };
  let cancelled = 0;
  const synth = { speak: utterance => spoken.push(utterance), cancel: () => { cancelled++; } };
  class Utterance { constructor(text) { this.text = text; this.volume = 1; } }
  const document = new EventTarget(); document.hidden = false;
  const element = (tag, cls, text) => {
    const classes = new Set((cls || '').split(' ').filter(Boolean)), attrs = new Map(), use = { href: '', setAttribute(name, value) { this.href = value; } };
    return {
      tag, cls, text, children: [], attrs, use, classes,
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
      setAttribute: (name, value) => attrs.set(name, value),
      querySelector: selector => (selector === 'use' ? use : null),
      append(...items) { this.children.push(...items); },
      contains(item) { return item === this || this.children.some(child => child === item || child.contains?.(item)); },
      listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
    };
  };
  const mic = element('button');
  const S = { c: running ? { activeRun: { id: running } } : { activeRun: null }, messages: [] };
  const rows = new Map();
  const context = {
    window: speech ? { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance } : {}, document, navigator: { language: 'en-GB' }, mic, S, rows, listening: null,
    L: logic.relayPhoneLogic, isRunning: () => Boolean(S.c?.activeRun),
    remember: (key, value) => (value === null ? storage.delete(key) : storage.set(key, value)), recall: key => storage.get(key) ?? null,
    node: element, icon: id => element('svg', `icon ${id}`), button: (text, handler, cls) => Object.assign(element('button', cls, text), { click: handler }),
    segmented: (label, options, value, onChange) => ({ label, options, value, onChange }),
    toast: message => toasts.push(message), stopListening: () => { events.stopListening++; }, drawSheet: () => { events.drawn++; },
  };
  vm.runInNewContext(section, context);
  // A row on the page, as renderFeed would keep it.
  const row = message => { const speaker = context.speakerButton(message), host = element('div'); host.append(speaker); rows.set(message.id, { element: host }); return speaker; };
  const finish = (part = spoken.at(-1)) => part.onend?.();
  const update = after => { const before = S.c; S.c = after; context.readFinished(before, after); };
  const hide = hidden => { document.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
  return { context, spoken, toasts, storage, events, S, row, finish, update, hide, document, mic, cancelled: () => cancelled };
}

test('a reply is read as written, a paragraph at a time, without code, tables or Markdown marks', () => {
  const reply = [
    '## Done', '', 'I fixed **the login bug** in `auth.js`. See [the issue](https://github.com/o/r/issues/1).', '',
    '```js', 'const secret = 1;', '```', '', '| File | Change |', '| --- | --- |', '| a.js | b |', '', '- First point', '- Second point', '', '---', '', '> Quoted *note*',
  ].join('\n');
  assert.deepEqual(spokenParts(reply), ['Done', 'I fixed the login bug in auth.js. See the issue.', 'First point Second point', 'Quoted note']);
  assert.deepEqual(spokenParts('Before\n\n```sh\nnpm test'), ['Before'], 'A code block still being written is left out to the end.');
  assert.deepEqual(spokenParts('```\nonly code\n```'), []);
  assert.deepEqual(spokenParts(null), []);
});

test('the speaker reads a reply, a second tap stops it, and finishing resets it', () => {
  const p = page(), message = { id: 'm1', role: 'assistant', text: 'One.\n\nTwo.' }, speaker = p.row(message);
  assert.equal(speaker.attrs.get('aria-label'), 'Read aloud');
  speaker.click();
  assert.deepEqual(p.spoken.map(item => item.text), ['One.', 'Two.']);
  assert.equal(p.spoken[0].lang, 'en-GB');
  assert.equal(p.events.stopListening, 1, 'The mic stops, so it does not hear the reply.');
  assert.equal(speaker.attrs.get('aria-pressed'), 'true');
  assert.equal(speaker.attrs.get('aria-label'), 'Stop reading');
  assert.equal(speaker.use.href, '#i-stop');
  p.spoken[0].onend?.();
  assert.equal(speaker.attrs.get('aria-pressed'), 'true', 'Only the last paragraph ending finishes the reading.');
  p.finish();
  assert.equal(speaker.attrs.get('aria-pressed'), 'false');
  assert.equal(speaker.use.href, '#i-speaker');

  speaker.click();
  const before = p.cancelled();
  speaker.click();
  assert.equal(p.cancelled(), before + 1);
  assert.equal(speaker.attrs.get('aria-label'), 'Read aloud');
  const late = p.spoken.at(-1); p.spoken.at(-1).onerror?.(); late.onend?.();
  assert.equal(speaker.attrs.get('aria-pressed'), 'false', 'A cancelled reading reporting late changes nothing.');
});

test('reading another reply moves the stop state to it, and a reply of only code says so', () => {
  const p = page(), first = p.row({ id: 'a', text: 'First.' }), second = p.row({ id: 'b', text: 'Second.' });
  first.click(); second.click();
  assert.equal(first.attrs.get('aria-pressed'), 'false');
  assert.equal(second.attrs.get('aria-pressed'), 'true');
  const code = p.row({ id: 'c', text: '```\nx\n```' }), spoken = p.spoken.length;
  code.click();
  assert.equal(p.spoken.length, spoken);
  assert.match(p.toasts[0], /nothing to read/);
});

test('with Read replies aloud on, the last reply of a run that finished is read once', () => {
  const off = page({ running: 'r1' });
  off.S.messages = [{ id: 'm', role: 'assistant', runId: 'r1', text: 'Done.' }];
  off.update({ activeRun: null, lastRun: { id: 'r1', status: 'complete' } });
  assert.equal(off.spoken.length, 0, 'Off by default.');

  const p = page({ running: 'r1', stored: { 'codeshi:phone-read-aloud': 'on' } });
  p.S.messages = [
    { id: 'm1', role: 'assistant', runId: 'r1', text: 'Looking.' },
    { id: 'm2', role: 'assistant', runId: 'r1', text: 'All fixed.' },
    { id: 'm3', role: 'assistant', runId: 'r0', text: 'Older.' },
  ];
  p.update({ activeRun: null, lastRun: { id: 'r1', status: 'complete' } });
  assert.deepEqual(p.spoken.map(item => item.text), ['All fixed.']);
  p.update({ activeRun: null, lastRun: { id: 'r1', status: 'complete' } });
  assert.equal(p.spoken.length, 1, 'Later updates do not read it again.');

  const dictating = page({ running: 'r1', stored: { 'codeshi:phone-read-aloud': 'on' } });
  dictating.S.messages = [{ id: 'm', role: 'assistant', runId: 'r1', text: 'Done.' }];
  dictating.context.listening = { recognizer: {} };
  dictating.update({ activeRun: null, lastRun: { id: 'r1', status: 'complete' } });
  assert.equal(dictating.spoken.length, 0, 'Not while the microphone is listening.');
  assert.equal(dictating.events.stopListening, 0);
});

test('a run that stopped, or a plan reply, is not read', () => {
  for (const [lastRun, messages] of [
    [{ id: 'r1', status: 'interrupted' }, [{ id: 'm', role: 'assistant', runId: 'r1', text: 'Partial.' }]],
    [{ id: 'r1', status: 'complete' }, [{ id: 'm', role: 'assistant', runId: 'r1', text: 'Plan.', orchestrationId: 'o' }]],
  ]) {
    const p = page({ running: 'r1', stored: { 'codeshi:phone-read-aloud': 'on' } });
    p.S.messages = messages;
    p.update({ activeRun: null, lastRun });
    assert.equal(p.spoken.length, 0);
  }
});

test('a reply that finished while the page was hidden is not read on coming back, unless the run was seen again', () => {
  const p = page({ running: 'r1', stored: { 'codeshi:phone-read-aloud': 'on' } });
  p.S.messages = [{ id: 'm', role: 'assistant', runId: 'r1', text: 'Done.' }];
  p.hide(true); p.hide(false);
  p.update({ activeRun: null, lastRun: { id: 'r1', status: 'complete' } });
  assert.equal(p.spoken.length, 0);

  const again = page({ running: 'r1', stored: { 'codeshi:phone-read-aloud': 'on' } });
  again.S.messages = [{ id: 'm', role: 'assistant', runId: 'r1', text: 'Done.' }];
  again.hide(true); again.hide(false);
  again.update({ activeRun: { id: 'r1' } });
  again.update({ activeRun: null, lastRun: { id: 'r1', status: 'complete' } });
  assert.equal(again.spoken.length, 1);
});

test('hiding the page, or tapping the mic, stops reading', () => {
  const p = page(), speaker = p.row({ id: 'm', text: 'Hello.' });
  speaker.click(); p.hide(true);
  assert.equal(speaker.attrs.get('aria-pressed'), 'false');
  p.hide(false); speaker.click(); p.mic.listeners.click();
  assert.equal(speaker.attrs.get('aria-pressed'), 'false');
});

test('the first tap with reading on speaks silently once, so an iPhone allows reading later', () => {
  const off = page();
  off.document.dispatchEvent(new Event('pointerdown'));
  assert.equal(off.spoken.length, 0);
  const p = page({ stored: { 'codeshi:phone-read-aloud': 'on' } });
  p.document.dispatchEvent(new Event('pointerdown')); p.document.dispatchEvent(new Event('pointerdown'));
  assert.equal(p.spoken.length, 1);
  assert.equal(p.spoken[0].text, '');
  assert.equal(p.spoken[0].volume, 0);
});

test('the setting is in the workspace list only where the browser can speak, and turning it off stops reading', () => {
  const none = page({ speech: false }), empty = { children: [], append(...items) { this.children.push(...items); } };
  none.context.readAloudSetting(empty);
  assert.equal(empty.children.length, 0);

  const p = page(), host = { children: [], append(...items) { this.children.push(...items); } };
  p.context.readAloudSetting(host);
  const [setting, note] = host.children;
  assert.equal(setting.label, 'Read replies aloud');
  assert.equal(setting.value, 'off');
  assert.match(note.text, /while Codeshi is open/);
  setting.onChange('on');
  assert.equal(p.storage.get('codeshi:phone-read-aloud'), 'on');
  assert.equal(p.spoken.at(-1).volume, 0, 'Turning it on is a tap, so it unlocks speech at once.');
  const speaker = p.row({ id: 'm', text: 'Hello.' }); speaker.click();
  setting.onChange('off');
  assert.equal(p.storage.has('codeshi:phone-read-aloud'), false);
  assert.equal(speaker.attrs.get('aria-pressed'), 'false');
});

test('a reply still being written gets no speaker until its run ends', () => {
  assert.match(source, /if \(!message\.orchestrationId && !writing\(message\) && speech\(\)\) row\.append\(speakerButton\(message\)\);/);
  assert.match(source, /function rowKey\(message, showAgent\) \{\n\s+return `\$\{message\.role\}\\n\$\{showAgent\}\\n\$\{writing\(message\)\}/);
});

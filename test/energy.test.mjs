import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Runs public/flow-lounge.js with a small stand-in DOM. Animation frames are run by the test at the times it picks,
// so frame rates and loops can be counted. Canvas contexts record their drawing calls.
const source = fs.readFileSync(new URL('../public/flow-lounge.js', import.meta.url), 'utf8');

class Events {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn); }
  dispatchEvent(event) { event.target ||= this; for (const fn of this.listeners[event.type] || []) fn(event); return true; }
}
function recorder() {
  const calls = [];
  return new Proxy({ calls }, {
    get(target, key) { return key in target ? target[key] : (...args) => { calls.push([key, ...args]); }; },
    set(target, key, value) { target[key] = value; return true; },
  });
}
class Element extends Events {
  constructor(tag, document) {
    super(); this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.parentNode = null;
    this.attributes = {}; this.style = {}; this.dataset = {}; this.hidden = false; this.text = ''; this.classes = new Set(); this.id = '';
    const classes = this.classes;
    this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle: (name, force) => { const on = force ?? !classes.has(name); if (on) classes.add(name); else classes.delete(name); return on; } };
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) this.classes.add(name); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get isConnected() { for (let node = this; node; node = node.parentNode) if (node === this.document.body) return true; return false; }
  append(...nodes) { for (const item of nodes) { const child = typeof item === 'string' ? Object.assign(new Element('#text', this.document), { text: item }) : item; child.remove(); child.parentNode = this; this.children.push(child); } }
  prepend(...nodes) { this.append(...nodes); }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
  removeChild(child) { child.remove(); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
  focus() {} blur() {} click() { this.dispatchEvent({ type: 'click', preventDefault() {} }); }
  getContext() { return this.context ||= recorder(); }
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
  matches(selector) {
    const [, tag, id, classes] = selector.match(/^([a-z]*)(?:#([\w-]+))?((?:\.[\w-]+)*)$/i) || [];
    if (tag === undefined) return false;
    return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.id === id) && classes.split('.').filter(Boolean).every(name => this.classes.has(name));
  }
  querySelectorAll(selector) { const list = selector.split(',').map(part => part.trim()); return [...this.walk()].filter(node => list.some(part => node.matches(part))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function lounge({ reducedMotion = false, ledge = false, height = 800, random = null, keepWeather = true } = {}) {
  const document = new Events();
  document.hidden = false;
  document.body = new Element('body', document);
  document.createElement = tag => new Element(tag, document);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.getElementById = id => [...document.body.walk()].find(node => node.id === id) || null;
  for (const id of ['app-shell', 'toggle-flow-lounge', 'flow-left', 'flow-right', 'flow-lounge-left', 'flow-lounge-right']) {
    const element = new Element(id === 'toggle-flow-lounge' ? 'button' : 'div', document); element.id = id; document.body.append(element);
  }
  // A ledge for rain to splash on and snow to settle on, as the composer is in the app.
  if (ledge) {
    const composer = new Element('div', document); composer.className = 'composer-input';
    composer.getBoundingClientRect = () => ({ left: 100, right: 1100, top: 400, bottom: 440, width: 1000, height: 40 });
    document.body.append(composer);
  }
  const window = new Events();
  let flowOn = true;
  Object.assign(window, {
    innerWidth: 1200, innerHeight: height,
    matchMedia: query => ({ matches: reducedMotion && query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }),
    relayUI: { getState: () => ({ conversation: null }), isRunning: () => false },
    relayFlow: { isOn: () => flowOn },
  });
  let nextFrame = 0;
  const frames = new Map();
  const storage = new Map(keepWeather ? [] : [['throughline:lounge-keep-weather', '0']]);
  const context = vm.createContext({
    window, document, console,
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  });
  // The same scene every time: a seeded Math.random.
  vm.runInContext(random === null ? '{ let seed = 7; Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }' : `Math.random = () => ${random};`, context);
  vm.runInContext(source, context, { filename: 'public/flow-lounge.js' });
  const api = window.relayFlowLounge;
  return {
    api, document, window,
    // Runs the callbacks waiting for the next frame, as a browser does at a display refresh.
    frame(time) { const due = [...frames.values()]; frames.clear(); for (const fn of due) fn(time); },
    // The animation loops waiting for a frame, by function name.
    loops() { const counts = {}; for (const fn of frames.values()) counts[fn.name] = (counts[fn.name] || 0) + 1; return counts; },
    weather() { return document.getElementById('flow-lounge-weather-canvas')?.getContext().calls || []; },
    setHidden(hidden) { document.hidden = hidden; document.dispatchEvent({ type: 'visibilitychange' }); },
    setFlow(on) { flowOn = on; window.dispatchEvent({ type: 'relay-flow', detail: { on } }); },
  };
}
// Runs seconds of frames at a display's refresh rate.
function second(ui, hz, from = 0, seconds = 1) { for (let i = 0; i <= hz * seconds; i++) ui.frame(from + i * 1000 / hz); }
const drawnFrames = calls => calls.filter(([name]) => name === 'clearRect').length;
// The lines and dots drawn after the last clear: the scene on screen.
const lastScene = calls => calls.slice(calls.findLastIndex(([name]) => name === 'clearRect') + 1).filter(([name]) => ['moveTo', 'lineTo', 'arc'].includes(name));

test('Lounge weather draws at most 30 frames a second, at the same speed on 60 Hz and 120 Hz displays', () => {
  const at60 = lounge({ ledge: true }), at120 = lounge({ ledge: true });
  for (const ui of [at60, at120]) { ui.api.enter(); ui.api.setWeatherMode('rain'); }
  second(at60, 60); second(at120, 120);
  assert.ok(drawnFrames(at120.weather()) <= 31, `drew ${drawnFrames(at120.weather())} frames in a second at 120 Hz`);
  assert.ok(at60.weather().some(([name]) => name === 'ellipse'), 'drops splash on the ledge');
  assert.equal(drawnFrames(at60.weather()), drawnFrames(at120.weather()));
  const [slow, fast] = [lastScene(at60.weather()), lastScene(at120.weather())];
  assert.ok(slow.length > 50, 'rain is on screen');
  assert.equal(fast.length, slow.length);
  fast.forEach((call, i) => call.slice(1).forEach((value, j) => assert.ok(Math.abs(value - slow[i][j + 1]) < 1e-6, `${call[0]} ${i} is drawn at the same place`)));
});

for (const hz of [120, 50]) test(`Lounge rain falls at its 60 Hz speed on a ${hz} Hz display`, () => {
  // With Math.random fixed at 0.5, every drop starts at x 600, y 1500 (half the height) and falls 17 px a 60 Hz step.
  const ui = lounge({ height: 3000, random: 0.5 });
  ui.api.enter(); ui.api.setWeatherMode('rain');
  second(ui, hz);
  const drops = lastScene(ui.weather()).filter(([name]) => name === 'moveTo');
  assert.equal(drops.length, 110, 'each drop is drawn once in a frame');
  // One second is 60 steps after the first frame's step, give or take the step still to come.
  for (const [, x, y] of drops) { assert.ok(Math.abs(x - (600 - 1.2 * 61)) <= 1.2 * 1.5, `x ${x}`); assert.ok(Math.abs(y - (1500 + 17 * 61)) <= 17 * 1.5, `y ${y}`); }
});

test('Lounge snow and its settling run on elapsed time too', () => {
  const at60 = lounge({ ledge: true }), at120 = lounge({ ledge: true });
  for (const ui of [at60, at120]) { ui.api.enter(); ui.api.setWeatherMode('snow'); }
  second(at60, 60, 0, 20); second(at120, 120, 0, 20);
  assert.ok(drawnFrames(at120.weather()) <= 20 * 30 + 1);
  const [slow, fast] = [lastScene(at60.weather()), lastScene(at120.weather())];
  assert.ok(slow.length > 50, 'snow is on screen');
  assert.equal(fast.length, slow.length);
  fast.forEach((call, i) => call.slice(1).forEach((value, j) => assert.ok(Math.abs(value - slow[i][j + 1]) < 1e-6, `${call[0]} ${i} is drawn at the same place`)));
});

test('Lounge weather stays still when the system asks for reduced motion', () => {
  const ui = lounge({ reducedMotion: true });
  ui.api.enter(); ui.api.setWeatherMode('rain');
  second(ui, 60);
  assert.deepEqual(ui.weather().filter(([name]) => ['stroke', 'fill'].includes(name)), []);
  assert.equal(ui.loops().drawWeather, undefined, 'no weather loop waits for a frame');
  ui.api.setWeatherMode('snow'); second(ui, 60, 2000);
  assert.deepEqual(ui.weather().filter(([name]) => ['stroke', 'fill'].includes(name)), []);
});

test('weather keeps one loop at most through hide, recede, Flow on and off, weather changes and re-entry', () => {
  const ui = lounge();
  ui.api.enter(); ui.api.setWeatherMode('rain'); ui.frame(0);
  assert.deepEqual(ui.loops(), { drawWeather: 1 }, 'games draw once and wait for Start; only the weather runs');
  for (let i = 0; i < 4; i++) { ui.setHidden(true); assert.deepEqual(ui.loops(), {}, 'nothing runs while hidden'); ui.setHidden(false); }
  ui.frame(20);
  assert.deepEqual(ui.loops(), { drawWeather: 1 });
  for (const mode of ['snow', 'rain', 'snow', 'rain']) ui.api.setWeatherMode(mode);
  second(ui, 60);
  assert.deepEqual(ui.loops(), { drawWeather: 1 });
  ui.api.recede('attention'); second(ui, 60, 2000);
  assert.deepEqual(ui.loops(), { drawWeather: 1 }, 'weather kept on goes on over Flow while the Lounge has receded');
  ui.setFlow(false); second(ui, 60, 4000);
  assert.deepEqual(ui.loops(), {}, 'leaving Flow stops the weather');
  ui.setHidden(true); ui.setHidden(false); second(ui, 60, 6000);
  assert.deepEqual(ui.loops(), {}, 'showing the window again does not start it outside Flow');
  ui.setFlow(true); second(ui, 60, 8000);
  assert.deepEqual(ui.loops(), { drawWeather: 1 });
  ui.api.setWeatherMode('clear'); second(ui, 60, 10000);
  assert.deepEqual(ui.loops(), {}, 'Clear stops after clearing');
  ui.api.setWeatherMode('rain');
  for (let i = 0; i < 3; i++) { ui.api.exit(); ui.api.enter(); }
  second(ui, 60, 12000);
  assert.deepEqual(ui.loops(), { drawWeather: 1 });
});

test('with weather not kept outside the Lounge, leaving it stops the weather', () => {
  const ui = lounge({ keepWeather: false });
  ui.api.enter(); ui.api.setWeatherMode('rain'); second(ui, 60);
  assert.deepEqual(ui.loops(), { drawWeather: 1 });
  ui.api.recede('attention'); second(ui, 60, 2000);
  assert.deepEqual(ui.loops(), {}, 'a receded Lounge draws nothing');
  ui.api.resume(); second(ui, 60, 4000);
  assert.deepEqual(ui.loops(), { drawWeather: 1 });
  ui.api.exit(); second(ui, 60, 6000);
  assert.deepEqual(ui.loops(), {});
});

test('the setup screen glow drifts once rather than for as long as setup is open', () => {
  // A full-window layer animated forever keeps the GPU busy at the display's refresh rate the whole time.
  const css = fs.readFileSync(new URL('../public/onboarding.css', import.meta.url), 'utf8');
  const rule = css.match(/\.setup-dialog::before\s*\{([^}]*)\}/)?.[1];
  assert.match(rule, /animation:\s*ob-drift\b/);
  assert.doesNotMatch(rule, /infinite/);
});

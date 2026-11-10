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
    // globalAlpha is recorded too: how faint the next lines are drawn.
    set(target, key, value) { if (key === 'globalAlpha') calls.push([key, value]); target[key] = value; return true; },
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
  get parentElement() { return this.parentNode; }
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

function lounge({ reducedMotion = false, ledge = false, painted = true, height = 800, random = null, onMatchMedia = () => {} } = {}) {
  const document = new Events();
  document.hidden = false;
  document.body = new Element('body', document);
  // The page's own colour, behind everything.
  document.body.computed = { backgroundColor: 'rgb(17, 17, 17)', backgroundImage: 'none', borderTopStyle: 'none', borderTopWidth: '0px' };
  document.createElement = tag => new Element(tag, document);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.getElementById = id => [...document.body.walk()].find(node => node.id === id) || null;
  for (const id of ['app-shell', 'toggle-flow-lounge', 'flow-left', 'flow-right', 'flow-lounge-left', 'flow-lounge-right']) {
    const element = new Element(id === 'toggle-flow-lounge' ? 'button' : 'div', document); element.id = id; document.body.append(element);
  }
  // A ledge for rain to splash on and snow to settle on, as the composer is in the app.
  if (ledge) {
    const composer = new Element('div', document); composer.className = 'composer';
    composer.getBoundingClientRect = () => ({ left: 100, right: 1100, top: 400, bottom: 440, width: 1000, height: 40 });
    // Painted, it has a border a person can see. Unpainted, it is only a box in the layout, or one whose fill and
    // gradient are the page's own colour, as the sticky row behind a prompt is.
    composer.computed = painted === true
      ? { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgba(255, 255, 255, 0.12)', backgroundColor: 'rgb(24, 24, 27)', backgroundImage: 'none', borderTopLeftRadius: '10px', borderTopRightRadius: '10px' }
      : painted === 'page'
        ? { borderTopWidth: '0px', borderTopStyle: 'none', borderTopColor: 'rgb(255, 255, 255)', backgroundColor: 'rgb(17, 17, 17)', backgroundImage: 'linear-gradient(rgb(17, 17, 17) calc(100% - 14px), rgba(0, 0, 0, 0))' }
        : { borderTopWidth: '0px', borderTopStyle: 'none', borderTopColor: 'rgb(255, 255, 255)', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' };
    document.body.append(composer);
  }
  const window = new Events();
  let flowOn = true;
  Object.assign(window, {
    innerWidth: 1200, innerHeight: height,
    matchMedia: query => { onMatchMedia(query); return { matches: reducedMotion && query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }; },
    relayUI: { getState: () => ({ conversation: null }), isRunning: () => false },
    relayFlow: { isOn: () => flowOn },
  });
  let nextFrame = 0;
  const frames = new Map();
  const storage = new Map();
  const context = vm.createContext({
    window, document, console,
    getComputedStyle: element => element.computed || { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', borderTopStyle: 'none', borderTopWidth: '0px' },
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
  // With Math.random fixed at 0.5, every drop starts at x 600, y 1500 (half the height) and falls 19 px a 60 Hz step.
  // The wind carries it left by 7 to 10 hundredths of its fall.
  const ui = lounge({ height: 3000, random: 0.5 });
  ui.api.enter(); ui.api.setWeatherMode('rain');
  second(ui, hz);
  const drops = lastScene(ui.weather()).filter(([name]) => name === 'moveTo');
  assert.equal(drops.length, 2 * 150, 'each drop is drawn once in a frame: its streak and its brighter head');
  // One second is 60 steps after the first frame's step, give or take the step still to come.
  for (const [, x, y] of drops) {
    assert.ok(Math.abs(y - (1500 + 19 * 61)) <= 19 * 1.5, `y ${y}`);
    assert.ok(600 - x >= 0.07 * 19 * 59.5 && 600 - x <= 0.1 * 19 * 62.5, `x ${x}`);
  }
});

test('Lounge rain streaks cover the way each drop fell between drawn frames, fainter by as much as they are longer', () => {
  // With Math.random fixed at 0.5, every drop falls 19 px a 60 Hz step, its streak is 21 px long and it is drawn at
  // 0.37: the streak at 0.55 of that and the head, the lowest two fifths, at all of it. Drawn every second step, a
  // streak is 19 px longer, so the streaks of two frames in a row overlap as they do at 60 Hz.
  const ui = lounge({ height: 3000, random: 0.5 });
  ui.api.enter(); ui.api.setWeatherMode('rain');
  second(ui, 60);
  const calls = ui.weather(), start = calls.findLastIndex(([name]) => name === 'clearRect') + 1;
  const strokes = []; let alpha = 1, from = null;
  for (const [name, ...args] of calls.slice(start)) {
    if (name === 'globalAlpha') alpha = args[0];
    else if (name === 'moveTo') from = args;
    else if (name === 'lineTo' && from) strokes.push({ length: from[1] - args[1], alpha });
  }
  assert.equal(strokes.length, 2 * 150);
  strokes.forEach(({ length, alpha }, i) => {
    if (i % 2 === 0) {
      assert.ok(Math.abs(length - 40) < 1e-6, `a streak is ${length} px long`);
      assert.ok(Math.abs(alpha * length - 0.37 * 0.55 * 21) < 1e-6, `drawn at ${alpha}, a ${length} px streak gives off the light of a 21 px one`);
    } else {
      assert.ok(Math.abs(length - 16) < 1e-6, `a head is ${length} px long`);
      assert.ok(Math.abs(alpha * 40 - 0.37 * 21) < 1e-6, `a head is drawn at ${alpha}`);
    }
  });
  assert.equal(calls.filter(([name]) => name === 'globalAlpha').at(-1)[1], 1, 'what is drawn next is not faint');
  // A drop that reaches the bottom starts again above the view, at y -27.5 here. Its next streak covers only the way
  // it fell since: a step of 19 px and its own 21 px, so it reaches no higher than y -29.5.
  const low = lounge({ height: 100, random: 0.5 });
  low.api.enter(); low.api.setWeatherMode('rain');
  second(low, 60);
  const tops = low.weather().filter(([name]) => name === 'lineTo').map(([, , y]) => y);
  assert.ok(tops.length > 300 && tops.some(y => y < 0), 'drops fell through the view several times');
  assert.ok(Math.min(...tops) >= -29.5 - 1e-6, `a streak reached up to y ${Math.min(...tops)}`);
});

test('rain and snow land only on a surface a person can see', () => {
  // The composer's box is in the layout either way. Without a border or a fill of its own there is no edge to see,
  // so drops fall past it and no snow settles along it.
  // A fill and gradient in the page's own colour, as the sticky row behind a prompt has, is no edge either.
  // The bottom of the window (800 px here) is a floor every drop splashes on.
  const rings = ui => ui.weather().filter(call => call[0] === 'ellipse');
  const ledge = ui => rings(ui).filter(([, , y]) => y < 790);
  const seen = lounge({ ledge: true }), unseen = lounge({ ledge: true, painted: false }), page = lounge({ ledge: true, painted: 'page' });
  for (const ui of [seen, unseen, page]) { ui.api.enter(); ui.api.setWeatherMode('rain'); second(ui, 60, 0, 3); }
  assert.ok(ledge(seen).length > 0, 'drops splash on the painted composer');
  assert.equal(ledge(unseen).length, 0, 'nothing splashes on a box that is not painted');
  assert.equal(ledge(page).length, 0, 'nothing splashes on a box painted in the page colour');
  for (const ui of [seen, unseen, page]) assert.ok(rings(ui).some(([, , y]) => y === 798), 'drops splash at the bottom of the window');
  // Every splash above the floor is on the top edge, inside the rounded corners (a 10 px radius brings the ledge in by 3 px).
  for (const [, x, y] of ledge(seen)) { assert.equal(y, 400); assert.ok(x >= 103 && x <= 1097, `x ${x}`); }
  const settled = ui => lastScene(ui.weather()).filter(([name, , y]) => name === 'arc' && y > 390 && y < 400).length;
  for (const ui of [seen, unseen, page]) { ui.api.setWeatherMode('snow'); second(ui, 60, 4000, 20); }
  assert.ok(settled(seen) > 5, 'snow settles along the painted composer');
  assert.ok(settled(unseen) <= 2, 'only flakes falling past are near the unpainted one');
  assert.ok(settled(page) <= 2, 'only flakes falling past are near the one painted in the page colour');
});

// Starts a lounge game with its card's Start button and plays it on a display of the given refresh rate. Returns the
// frames drawn and the shapes on its board at the end.
function play(card, hz, seconds) {
  const ui = lounge();
  ui.api.enter(); ui.api.setWeatherMode('clear');
  const board = ui.document.getElementById(card), [canvas] = board.querySelectorAll('canvas');
  board.querySelectorAll('button').find(button => /Start/.test(button.textContent)).click();
  const before = canvas.getContext().calls.length;
  second(ui, hz, 1000, seconds);
  const calls = canvas.getContext().calls.slice(before);
  return { frames: drawnFrames(calls), scene: calls.slice(calls.findLastIndex(([name]) => name === 'clearRect') + 1).filter(([name]) => ['arc', 'roundRect'].includes(name)) };
}

test('Lounge Breakout moves at its 60 Hz speed on a 120 Hz display and draws only the frames that moved', () => {
  const [slow, fast] = [play('flow-card-lounge-arcade', 60, 0.5), play('flow-card-lounge-arcade', 120, 0.5)];
  const ball = scene => scene.filter(([name]) => name === 'arc').at(-1);
  assert.ok(slow.scene.length > 10, 'bricks, paddle and ball are on the board');
  assert.deepEqual(ball(fast.scene), ball(slow.scene), 'the ball is in the same place');
  assert.notDeepEqual(ball(slow.scene), play('flow-card-lounge-arcade', 60, 0.25).scene.filter(([name]) => name === 'arc').at(-1), 'and it moves');
  assert.ok(fast.frames <= slow.frames, `drew ${fast.frames} frames at 120 Hz and ${slow.frames} at 60 Hz`);
});

// Plays a lounge game at 60 Hz for the given frames, then does what `then` says, and returns the frames drawn and where
// its moving piece is: Breakout's ball, or the snake's head.
function game(card, frames, then = null, jitter = 0) {
  const ui = lounge();
  ui.api.enter(); ui.api.setWeatherMode('clear');
  const board = ui.document.getElementById(card), [canvas] = board.querySelectorAll('canvas');
  const control = () => board.querySelectorAll('button').find(button => /Start|Pause|Resume/.test(button.textContent));
  control().click();
  // Frames that come up to `jitter` ms early or late, as a display's do.
  for (let i = 0; i < frames; i++) ui.frame(1000 + i * 1000 / 60 + (i % 2 ? jitter : -jitter));
  const last = 1000 + (frames - 1) * 1000 / 60;
  if (then === 'hidden') { ui.setHidden(true); ui.frame(last + 2000); ui.setHidden(false); ui.frame(last + 5000); }
  else if (then === 'paused') { control().click(); ui.frame(last + 2000); control().click(); ui.frame(last + 5000); }
  else if (then === 'stalled') ui.frame(last + 1000);
  else for (let i = 1; i <= (then || 0); i++) ui.frame(last + i * 1000 / 60);
  const calls = canvas.getContext().calls, scene = calls.slice(calls.findLastIndex(([name]) => name === 'clearRect') + 1);
  return { frames: drawnFrames(calls), piece: card === 'flow-card-lounge-arcade' ? scene.filter(([name]) => name === 'arc').at(-1) : scene.find(([name]) => name === 'roundRect') };
}

test('Lounge Breakout goes on from where it was after a pause or time out of view, and keeps pace with uneven frames', () => {
  const arcade = 'flow-card-lounge-arcade', next = game(arcade, 31, 1);
  for (const then of ['hidden', 'paused']) assert.deepEqual(game(arcade, 31, then).piece, next.piece, `the ball takes one step after five seconds ${then}, as after one frame`);
  assert.deepEqual(game(arcade, 31, 'stalled').piece, game(arcade, 31, 4).piece, 'after a stall of a second the ball catches up by four steps, not sixty');
  const uneven = game(arcade, 31, 1, 0.4), even = game(arcade, 31, 1);
  assert.equal(uneven.frames, even.frames, 'a frame that comes a little early still moves the game, so none is skipped');
  assert.deepEqual(uneven.piece, even.piece);
});

test('Lounge Snake goes on from where it was after a pause or time out of view', () => {
  // After 33 steps the snake has moved 5 times, at steps 1, 8, 15, 22 and 29. One more step leaves it there; four would
  // reach its sixth move at step 36.
  const zen = 'flow-card-lounge-zen', next = game(zen, 33, 1);
  assert.notDeepEqual(game(zen, 33, 4).piece, next.piece);
  for (const then of ['hidden', 'paused']) assert.deepEqual(game(zen, 33, then).piece, next.piece, `the snake takes one step after five seconds ${then}`);
});

test('Lounge Snake moves at its 60 Hz speed on a 144 Hz display', () => {
  // The snake moves every 110 ms. Counted in display frames, that is every 116.7 ms at 60 Hz but every 111.1 ms at 144 Hz.
  const [slow, fast] = [play('flow-card-lounge-zen', 60, 1.45), play('flow-card-lounge-zen', 144, 1.45)];
  const head = scene => scene.find(([name]) => name === 'roundRect');
  assert.deepEqual(head(fast.scene), head(slow.scene), 'the snake has moved as far');
  assert.equal(head(slow.scene)[1], (5 + 13) * 15 + 1, 'thirteen moves to the right in 1.45 seconds');
  assert.ok(fast.frames <= slow.frames + 1, `drew ${fast.frames} frames at 144 Hz and ${slow.frames} at 60 Hz`);
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
  assert.deepEqual(ui.loops(), {}, 'the weather stops while the Lounge has receded for an approval');
  ui.setHidden(true); ui.setHidden(false); second(ui, 60, 3000);
  assert.deepEqual(ui.loops(), {}, 'showing the window again does not start it while receded');
  ui.api.resume(); second(ui, 60, 4000);
  assert.deepEqual(ui.loops(), { drawWeather: 1 }, 'returning to the Lounge starts it again');
  assert.equal(ui.api.getWeatherMode(), 'rain', 'with the same weather as before');
  ui.setFlow(false); second(ui, 60, 6000);
  assert.deepEqual(ui.loops(), {}, 'leaving Flow stops the weather');
  ui.setFlow(true); second(ui, 60, 8000);
  assert.deepEqual(ui.loops(), {}, 'Flow alone does not bring the weather back');
  ui.api.enter(); second(ui, 60, 9000);
  assert.deepEqual(ui.loops(), { drawWeather: 1 });
  ui.api.setWeatherMode('clear'); second(ui, 60, 10000);
  assert.deepEqual(ui.loops(), {}, 'Clear stops after clearing');
  ui.api.setWeatherMode('rain');
  for (let i = 0; i < 3; i++) { ui.api.exit(); ui.api.enter(); }
  second(ui, 60, 12000);
  assert.deepEqual(ui.loops(), { drawWeather: 1 });
});

test('weather stops when you leave the Lounge, and its canvas goes with it', () => {
  const ui = lounge();
  ui.api.enter(); ui.api.setWeatherMode('snow'); second(ui, 60, 0, 2);
  assert.ok(ui.document.getElementById('flow-lounge-weather-canvas'), 'snow falls in the Lounge');
  ui.api.exit(); second(ui, 60, 3000, 2);
  assert.deepEqual(ui.loops(), {}, 'nothing waits for a frame after leaving');
  assert.equal(ui.document.getElementById('flow-lounge-weather-canvas'), null, 'Flow keeps no full-window canvas');
  ui.api.enter(); second(ui, 60, 6000);
  assert.equal(ui.api.getWeatherMode(), 'snow', 'coming back keeps the choice');
  assert.deepEqual(ui.loops(), { drawWeather: 1 });
});

test('the weather asks about reduced motion once, not on every frame', () => {
  let queries = 0;
  const ui = lounge({ onMatchMedia: () => queries++ });
  ui.api.enter(); ui.api.setWeatherMode('rain'); second(ui, 60, 0, 2);
  assert.ok(drawnFrames(ui.weather()) > 30, 'the rain was drawn');
  assert.equal(queries, 1, 'one query when the script starts');
});

test('the setup screen glow drifts once rather than for as long as setup is open', () => {
  // A full-window layer animated forever keeps the GPU busy at the display's refresh rate the whole time.
  const css = fs.readFileSync(new URL('../public/onboarding.css', import.meta.url), 'utf8');
  const rule = css.match(/\.setup-dialog::before\s*\{([^}]*)\}/)?.[1];
  assert.match(rule, /animation:\s*ob-drift\b/);
  assert.doesNotMatch(rule, /infinite/);
});

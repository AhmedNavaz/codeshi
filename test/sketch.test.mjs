import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import '../public/sketch-logic.js';

// Sketch a page (#125): boxes for a page that doesn't exist yet, numbered in reading order, sent like Design notes.
const { FRAMES, KINDS, LIMIT, cleanBox, cleanSketch, ordered, sketchText, newBox, resize } = globalThis.relaySketchLogic;

test('a sketch is written as numbered sections an agent can build from, with where each sits', () => {
  const boxes = [
    { id: 'b3', kind: 'Cards', x: 0, y: 504, w: 1280, h: 280 },
    { id: 'b1', kind: 'Header', x: 0, y: 0, w: 1280, h: 80 },
    { id: 'b4', kind: 'Sidebar', x: 0, y: 80, w: 320, h: 424 },
    { id: 'b2', kind: 'Hero', x: 320, y: 80, w: 960, h: 424 },
    { id: 'b5', kind: 'Button', x: 400, y: 400, w: 200, h: 48 },
  ];
  assert.deepEqual(ordered(boxes).map(box => box.id), ['b1', 'b4', 'b2', 'b5', 'b3'], 'Top to bottom, then left to right along a row.');
  const text = sketchText({ boxes, notes: { b1: 'Logo left.', b2: 'One line and a button.', b5: '  Start free  ', other: 'ignored' }, overall: 'Calm.', name: 'Pricing', frame: 'desktop' });
  assert.equal(text, [
    'Layout sketch for a page that doesn’t exist yet, “Pricing”, for desktop (1280 px wide), 5 sections. The numbers match the boxes in the sketch. Build it in the project’s existing style unless the notes say otherwise.',
    '1. Header, full width, at the top (x 0–1280, y 0–80): Logo left.',
    '2. Sidebar, narrow, on the left, beside 3 (x 0–320, y 80–504):',
    '3. Hero, wide, on the right, beside 2 (x 320–1280, y 80–504): One line and a button.',
    '4. Button, narrow, on the left, inside 3 (x 400–600, y 400–448): Start free',
    '5. Cards, full width (x 0–1280, y 504–784):',
    'Whole page: Calm.',
  ].join('\n'));
  // Without a picture, the lead doesn't point at one; without a name or notes, nothing is made up.
  assert.equal(sketchText({ boxes: [{ id: 'b1', kind: 'Header', x: 0, y: 0, w: 390, h: 56 }], frame: 'phone', pictured: false }), 'Layout sketch for a page that doesn’t exist yet, for phone (390 px wide), 1 section. Build it in the project’s existing style unless the notes say otherwise.\n1. Header, full width, at the top (x 0–390, y 0–56):');
});

test('boxes stay on the frame and its grid, new ones go under the rest, and a narrower frame keeps each box’s share', () => {
  assert.deepEqual(cleanBox({ id: 'b1', kind: 'Hero', x: -30, y: 13, w: 5000, h: 3 }, 1280), { id: 'b1', kind: 'Hero', x: 0, y: 16, w: 1280, h: 8 });
  assert.deepEqual(cleanBox({ id: 'nope', kind: 'Spaceship', x: 1275, y: 'x', w: 40, h: 40 }, 1280), { id: 'b0', kind: 'Other', x: 1240, y: 0, w: 40, h: 40 });
  const header = newBox('Header', [], 'desktop', 'b1');
  assert.deepEqual(header, { id: 'b1', kind: 'Header', x: 0, y: 0, w: 1280, h: 80 });
  const form = newBox('Form', [header], 'desktop', 'b2');
  assert.deepEqual([form.x, form.y, form.w], [320, 80, 640], 'A narrow kind sits in the middle, under the others.');
  const sidebar = newBox('Sidebar', [header, form], 'desktop', 'b3');
  assert.deepEqual([sidebar.x, sidebar.y], [0, 80], 'A sidebar goes down the left, under the header.');
  assert.deepEqual(resize([form], 'desktop', 'phone').map(box => [box.x, box.w, box.h]), [[96, 192, 360]]);
  assert.deepEqual(Object.keys(FRAMES), ['desktop', 'tablet', 'phone']);
  assert.ok(KINDS.includes('Other'));
});

test('a saved sketch is read back only as far as it can be used', () => {
  const many = Array.from({ length: LIMIT + 3 }, (_, index) => ({ id: `b${index + 1}`, kind: 'Text', x: 0, y: index * 80, w: 400, h: 80 }));
  const saved = cleanSketch({ frame: 'watch', name: 'x'.repeat(200), boxes: [...many, { id: 'b1', kind: 'Text' }, { id: 'evil', kind: 'Text' }], notes: { b1: 'Keep', b99: 'Gone', b2: 7 }, overall: 3, clock: 2 });
  assert.equal(saved.frame, 'desktop');
  assert.equal(saved.name.length, 80);
  assert.equal(saved.boxes.length, LIMIT, 'At most the sections one message holds, each id once.');
  assert.deepEqual(saved.notes, { b1: 'Keep' });
  assert.equal(saved.overall, '');
  assert.equal(saved.clock, LIMIT, 'New boxes never reuse an id.');
  assert.deepEqual(cleanSketch(null), { frame: 'desktop', name: '', boxes: [], notes: {}, overall: '', clock: 0 });
});

test('the sketch is in the app, served, offered in the search bar, and sent the way Design notes are', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/sketch-logic.js') > html.indexOf('/preview.js') && html.indexOf('/sketch.js') > html.indexOf('/sketch-logic.js'), 'The logic loads before the dialog, after the preview helpers it sends with.');
  const server = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  for (const file of ['sketch.js', 'sketch-logic.js', 'sketch.css']) assert.match(server, new RegExp(`'/${file.replace('.', '\\.')}': \\['${file.replace('.', '\\.')}'`));
  assert.match(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), /label: "Sketch a page:[^"]*", run: \(\) => window\.relaySketch\?\.open\(\)/);
  const script = fs.readFileSync(new URL('../public/sketch.js', import.meta.url), 'utf8');
  assert.match(script, /relayPreview\?\.toPlan\?\.\(/); assert.match(script, /relayPreview\?\.toMessage\?\.\(/);
  assert.doesNotMatch(script, /innerHTML|fetch\(/, 'It builds its own nodes and only talks to the app through its helpers.');
});

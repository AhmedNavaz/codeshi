import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as brand from '../desktop/brand.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Git may check text out with CRLF on Windows; line endings do not change the generated artwork.
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const numbers = d => d.match(/-?\d+(?:\.\d+)?/g).map(Number);

test('the brush C is drawn the same way every time, with finite coordinates', () => {
  const full = brand.brush();
  assert.deepEqual(brand.brush(), full);
  for (const d of [full.solid, full.centreline, ...full.textured]) assert.ok(numbers(d).every(Number.isFinite), d.slice(0, 60));
});

// Angle in degrees between the curve arriving at an anchor and the curve leaving it.
const turn = (before, after) => {
  const a = [before[3][0] - before[2][0], before[3][1] - before[2][1]], b = [after[1][0] - after[0][0], after[1][1] - after[0][1]];
  return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / Math.hypot(...a) / Math.hypot(...b)))) * 180 / Math.PI;
};
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cubic = (b, t) => [0, 1].map(k => (1 - t) ** 3 * b[0][k] + 3 * (1 - t) ** 2 * t * b[1][k] + 3 * (1 - t) * t ** 2 * b[2][k] + t ** 3 * b[3][k]);
const sampleOutline = segments => segments.flatMap(b => Array.from({ length: 64 }, (_, k) => cubic(b, k / 64)));

test('the outline is one closed curve of cubic Béziers, with a corner only at the point of the tail', () => {
  const { segments } = brand.anchors();
  assert.ok(segments.length >= 8 && segments.length <= 32, `${segments.length} cubic segments`);
  for (let i = 0; i < segments.length; i++) assert.ok(distance(segments[i][3], segments[(i + 1) % segments.length][0]) < 1e-8, 'the contour closes without gaps');
  const corners = segments.filter((b, i) => turn(segments[(i + segments.length - 1) % segments.length], b) > 0.5);
  assert.equal(corners.length, 1, 'the rounded start and the edges meet without a kink');
  assert.match(brand.brush().solid, /^M[^MLCZ]*(?:C[^MLCZ]+)+Z$/, 'the outline uses cubic Béziers');
});

test('the stroke starts as a round cap of its own width, holds that width, then lifts', () => {
  const trace = brand.debugTrace(), { f: { c, r }, dir } = trace.edges[0];
  // Everything on the fitted outline behind the start centre lies on a half circle of the stroke's half-width.
  const cap = sampleOutline(brand.anchors().segments).filter(p => (p[0] - c[0]) * dir[0] + (p[1] - c[1]) * dir[1] < -0.3 && distance(p, c) < r + 2);
  assert.ok(cap.length > 50, 'the cap is sampled');
  for (const p of cap) assert.ok(Math.abs(distance(p, c) - r) < 0.02, `a cap point is ${distance(p, c)} from the centre, not ${r}`);
  // The width holds from the start until the brush lifts, then falls all the way to a point.
  const width = t => { const e = trace.edges[Math.round(t / trace.last * (trace.edges.length - 1))]; return distance(e.L, e.R); };
  for (const t of [0, 0.1, 0.25, 0.5]) assert.ok(Math.abs(width(t) - 2 * r) < 0.01, `the width at ${t} is ${width(t)}, not ${2 * r}`);
  const falling = [0.6, 0.7, 0.8, 0.9, trace.last].map(width);
  for (let i = 0; i < falling.length; i++) assert.ok(falling[i] < (i ? falling[i - 1] : 2 * r), `the stroke keeps thinning past ${[0.6, 0.7, 0.8, 0.9, 1][i]}`);
  assert.ok(width(trace.last) < 0.2, 'the stroke ends in a point');
});

test('the drawing exports the parts its callers expect', () => {
  const full = brand.brush(), coarse = brand.brush({ coarse: true });
  assert.equal(full.textured.length, 23, 'the solid body and 22 bristles');
  assert.equal(coarse.textured.length, 23);
  assert.ok(coarse.solid.length < full.solid.length, 'the coarse drawing has fewer digits');
  assert.match(full.centreline, /^M[^MLCZ]+(?:L[^MLCZ]+)+$/, 'the centreline is an open polyline for the welcome animation');
  assert.deepEqual(Object.keys(brand.brush({ detail: 'medium' })), ['solid']);
  assert.throws(() => brand.brush({ detail: 'small' }), /seal/, 'small sizes show the seal, never a small C');
});

test('each level of detail draws what it should', () => {
  assert.deepEqual([16, 32, 33, 64, 127, 128, 1024].map(brand.detailFor), ['small', 'small', 'medium', 'medium', 'medium', 'full', 'full']);
  const small = brand.tile({ pixels: 32 }), medium = brand.tile({ pixels: 64 }), full = brand.tile();
  // 32 px and below: the seal on its own, シ carved in cream, with no brush.
  assert.match(small, new RegExp(brand.colors.seal));
  assert.match(small, new RegExp(brand.colors.carve));
  assert.equal(small.match(/<path /g).length, 1, 'small detail is the seal and シ, one path');
  assert.doesNotMatch(small, new RegExp(brand.colors.paper.brush));
  assert.match(medium, new RegExp(brand.colors.seal));
  assert.equal(medium.match(/<path /g).length, 1, 'medium detail is one solid path with a plain seal');
  assert.match(full, new RegExp(brand.colors.seal));
  assert.ok(full.match(/<path /g).length > 22, 'full detail has the dry-brush tail');
  assert.match(full, /clip-path="url\(#brush-outline\)"/);
  assert.match(brand.mark({ pixels: 16 }), new RegExp(brand.colors.seal));
  assert.match(brand.mark({ pixels: 16, square: true }), /rx="0"/, 'the square touch icon leaves the rounding to the system');
});

test('the seal at small sizes is the same in both looks and keeps シ inside it', () => {
  assert.equal(brand.tile({ look: 'paper', pixels: 32 }).replace(/slope="[\d.]+"/, ''), brand.tile({ look: 'ink', pixels: 32 }).replace(/slope="[\d.]+"/, ''), 'only the shadow differs');
  const svg = brand.mark({ pixels: 16 }), shi = numbers(svg.match(/<path d="([^"]+)"/)[1]), half = brand.stamp.stroke / 2;
  assert.equal(svg.match(/<path d="[^"]+"/)[0].match(/M/g).length, 3, 'シ is three strokes');
  // Its strokes stay clear of the square's rounded corners and edges, so the carving is never cut off.
  assert.ok(Math.min(...shi) - half >= 8 && Math.max(...shi) + half <= 92, `シ spans ${Math.min(...shi)} to ${Math.max(...shi)}`);
});

test('the tile\'s gradient is drawn outside the shadow filter, which would band it', () => {
  const svg = brand.tile({ look: 'ink' });
  assert.match(svg, /<rect [^>]*filter="url\(#shadow\)"\/><rect [^>]*fill="url\(#tile\)"\/>/);
  assert.doesNotMatch(svg, /fill="url\(#tile\)" filter=/);
});

test('the in-app logo shows Paper, or Ink when the page is dark; the small logo is the seal in both', () => {
  const logo = brand.autoMark({ detail: 'medium' });
  assert.match(logo, /@media \(prefers-color-scheme:dark\)/);
  for (const color of [brand.colors.paper.brush, brand.colors.ink.brush, ...brand.colors.paper.tile, ...brand.colors.ink.tile]) assert.ok(logo.includes(color), color);
  const small = brand.autoMark({ detail: 'small' });
  assert.doesNotMatch(small, /@media/);
  assert.equal(small, brand.mark({ pixels: 16 }));
});

test('the menu bar images are シ alone, 16 points square, with the dot only when something needs you', () => {
  const idle = brand.template(), attention = brand.template({ attention: true });
  for (const image of [idle, attention]) {
    assert.deepEqual([image.width, image.height], [16, 16], 'the dot sits inside the image, so the icon never changes width');
    assert.doesNotMatch(image.svg, /<rect/, 'no square behind シ');
    assert.equal(image.svg.match(/<path /g).length, 1);
  }
  assert.doesNotMatch(idle.svg, /<circle/);
  assert.match(attention.svg, /<circle/);
});

test('シ on its own fills its box without being cut off, and the dot sits clear of its strokes', () => {
  const mark = brand.glyphMark(), d = mark.match(/ d="([^"]+)"/)[1], points = numbers(d), half = brand.glyph.stroke / 2;
  assert.doesNotMatch(mark, /<rect/, 'no background');
  assert.match(mark, new RegExp(`path\\{stroke:${brand.colors.seal}\\}`));
  assert.match(mark, new RegExp(`@media \\(prefers-color-scheme:dark\\)\\{path\\{stroke:${brand.glyph.dark}\\}\\}`));
  assert.ok(Math.min(...points) - half >= 0 && Math.max(...points) + half <= 100, `the strokes span ${Math.min(...points) - half} to ${Math.max(...points) + half}`);
  // Sample all three strokes and keep the dot at least a stroke's width from them.
  const [, ...strokes] = d.split('M'), samples = strokes.flatMap(stroke => {
    const n = numbers(stroke), at = t => n.length === 4 ? [n[0] + (n[2] - n[0]) * t, n[1] + (n[3] - n[1]) * t]
      : [0, 1].map(k => (1 - t) ** 2 * n[k] + 2 * (1 - t) * t * n[2 + k] + t ** 2 * n[4 + k]);
    return Array.from({ length: 101 }, (_, i) => at(i / 100));
  });
  const { x, y, r } = brand.glyph.dot, gap = Math.min(...samples.map(p => distance(p, [x, y]))) - half - r;
  assert.ok(gap >= brand.glyph.stroke / 2, `the dot is ${gap.toFixed(1)} units from シ`);
});

test('the macOS 26 icon has Paper and Ink looks, and every layer it names exists', () => {
  const files = brand.iconComposer(), icon = JSON.parse(files['icon.json']);
  assert.deepEqual(icon['fill-specializations'].map(item => item.appearance), [undefined, 'dark']);
  const layers = icon.groups.flatMap(group => group.layers);
  for (const layer of layers) assert.ok(files[`Assets/${layer['image-name']}`], layer['image-name']);
  const brush = layers.find(layer => layer.name === 'Brush');
  assert.deepEqual(brush['fill-specializations'].map(item => item.appearance), [undefined, 'dark', 'tinted']);
  assert.ok(files['Assets/Brush.svg'].match(/<path /g).length > 22, 'the layered icon retains the original fine brush lines');
  assert.match(files['Assets/Brush.svg'], /clip-path="url\(#brush-outline\)"/);
  assert.deepEqual(icon['supported-platforms'], { squares: ['macOS'] });
});

test('the committed icon sources match the drawings (run `npm run icons` after changing desktop/brand.mjs)', () => {
  assert.equal(read('assets/icon.svg'), brand.tile({ look: 'paper' }));
  assert.equal(read('assets/icon-dark.svg'), brand.tile({ look: 'ink' }));
  assert.equal(read('public/icon.svg'), brand.autoMark({ detail: 'small' }));
  assert.equal(read('public/logo.svg'), brand.autoMark({ detail: 'medium' }));
  assert.equal(read('public/mark.svg'), brand.glyphMark());
  assert.ok(read('desktop/overlay.html').includes(brand.inlineGlyph('mark-shi')), 'the alert panel シ in desktop/overlay.html');
  for (const [name, content] of Object.entries(brand.iconComposer())) assert.equal(read(path.join('assets/AppIcon.icon', name)), content, name);
  assert.ok(read('public/index.html').includes(brand.onboardingMark()), 'the welcome screen logo in public/index.html');
  for (const file of ['assets/Assets.car', 'assets/icon.icns', 'assets/icon.ico', 'assets/status/StatusTemplate@2x.png', 'assets/status/StatusAttentionTemplate@2x.png']) assert.ok(fs.statSync(path.join(root, file)).size > 0, file);
});

test('the Windows notification area icons are シ for a dark and a light taskbar, with a vermilion dot only when something needs you', () => {
  for (const taskbar of ['dark', 'light']) {
    const idle = brand.tray({ taskbar }), attention = brand.tray({ taskbar, attention: true });
    assert.match(idle, taskbar === 'dark' ? /stroke="#fff"/ : /stroke="#1b1917"/, 'Windows has no template images, so each taskbar gets its own colour');
    assert.doesNotMatch(idle, /<circle|<rect/);
    assert.match(attention, new RegExp(`<circle[^>]+fill="${taskbar === 'dark' ? brand.glyph.dark : brand.colors.seal}"`));
    for (const name of [`Tray${taskbar === 'dark' ? 'Dark' : 'Light'}.ico`, `Tray${taskbar === 'dark' ? 'Dark' : 'Light'}Attention.ico`]) {
      const icon = fs.readFileSync(path.join(root, 'assets/status', name)), count = icon.readUInt16LE(4);
      assert.deepEqual([icon.readUInt16LE(0), icon.readUInt16LE(2)], [0, 1], `${name} is an icon file`);
      assert.deepEqual(Array.from({ length: count }, (_, index) => icon.readUInt8(6 + 16 * index)), [16, 20, 24, 32, 40, 48], `${name} has a size for each taskbar scale`);
    }
  }
});

test('the welcome screen logo has every part its styles animate', () => {
  const css = read('public/onboarding.css'), mark = brand.onboardingMark();
  for (const part of ['mark-tile', 'mark-fill', 'mark-edge', 'mark-brush', 'mark-reveal', 'mark-seal']) {
    assert.ok(mark.includes(`class="${part}"`), part);
    assert.ok(css.includes(`.${part}`), part);
  }
});

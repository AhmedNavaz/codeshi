import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as brand from '../desktop/brand.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const numbers = d => d.match(/-?\d+(?:\.\d+)?/g).map(Number);

test('the brush C is drawn the same way every time, with finite coordinates', () => {
  const full = brand.brush(), small = brand.brush({ detail: 'small' });
  assert.deepEqual(brand.brush(), full);
  for (const d of [full.solid, full.centreline, ...full.textured, small.solid]) assert.ok(numbers(d).every(Number.isFinite), d.slice(0, 60));
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
  for (const detail of ['full', 'small']) {
    const { segments } = brand.anchors({ detail });
    assert.ok(segments.length >= 8 && segments.length <= 32, `${detail}: ${segments.length} cubic segments`);
    for (let i = 0; i < segments.length; i++) assert.ok(distance(segments[i][3], segments[(i + 1) % segments.length][0]) < 1e-8, `${detail}: contour closes without gaps`);
    const corners = segments.filter((b, i) => turn(segments[(i + segments.length - 1) % segments.length], b) > 0.5);
    assert.equal(corners.length, detail === 'full' ? 1 : 0, `${detail}: the rounded start and the edges meet without a kink`);
    assert.match(brand.brush({ detail }).solid, /^M[^MLCZ]*(?:C[^MLCZ]+)+Z$/, 'the outline uses cubic Béziers');
  }
});

test('the stroke starts as a round cap of its own width, holds that width, then lifts', () => {
  for (const detail of ['full', 'small']) {
    const trace = brand.debugTrace(detail), { f: { c, r }, dir } = trace.edges[0];
    // Everything on the fitted outline behind the start centre lies on a half circle of the stroke's half-width.
    const cap = sampleOutline(brand.anchors({ detail }).segments).filter(p => (p[0] - c[0]) * dir[0] + (p[1] - c[1]) * dir[1] < -0.3 && distance(p, c) < r + 2);
    assert.ok(cap.length > 50, `${detail}: the cap is sampled`);
    for (const p of cap) assert.ok(Math.abs(distance(p, c) - r) < 0.02, `${detail}: a cap point is ${distance(p, c)} from the centre, not ${r}`);
    // The width holds from the start until the brush lifts, then falls all the way to the end.
    const width = t => { const e = trace.edges[Math.round(t / trace.last * (trace.edges.length - 1))]; return distance(e.L, e.R); };
    const lifts = detail === 'full' ? 0.5 : 0.4;
    for (const t of [0, 0.1, 0.25, lifts]) assert.ok(Math.abs(width(t) - 2 * r) < 0.01, `${detail}: the width at ${t} is ${width(t)}, not ${2 * r}`);
    const falling = [0.6, 0.7, 0.8, 0.9, trace.last].map(width);
    for (let i = 0; i < falling.length; i++) assert.ok(falling[i] < (i ? falling[i - 1] : 2 * r), `${detail}: the stroke keeps thinning past ${[0.6, 0.7, 0.8, 0.9, 1][i]}`);
    if (detail === 'full') assert.ok(width(trace.last) < 0.2, 'the full stroke ends in a point');
    else assert.ok(Math.abs(width(trace.last) - r / 2) < 0.05, 'the small stroke ends in a rounded tip a quarter of its width');
  }
});

test('the drawing exports the parts its callers expect', () => {
  const full = brand.brush(), coarse = brand.brush({ coarse: true });
  assert.equal(full.textured.length, 23, 'the solid body and 22 bristles');
  assert.equal(coarse.textured.length, 23);
  assert.ok(coarse.solid.length < full.solid.length, 'the coarse drawing has fewer digits');
  assert.match(full.centreline, /^M[^MLCZ]+(?:L[^MLCZ]+)+$/, 'the centreline is an open polyline for the welcome animation');
  assert.deepEqual(Object.keys(brand.brush({ detail: 'medium' })), ['solid']);
  assert.deepEqual(Object.keys(brand.brush({ detail: 'small' })), ['solid']);
  assert.notEqual(brand.brush({ detail: 'small', pixels: 16 }).solid, brand.brush({ detail: 'small', pixels: 32 }).solid, 'the 16 px C is drawn larger');
});

test('each level of detail draws what it should', () => {
  assert.deepEqual([16, 32, 33, 64, 127, 128, 1024].map(brand.detailFor), ['small', 'small', 'medium', 'medium', 'medium', 'full', 'full']);
  const small = brand.tile({ pixels: 32 }), medium = brand.tile({ pixels: 64 }), full = brand.tile();
  assert.doesNotMatch(small, new RegExp(brand.colors.seal));
  assert.equal(small.match(/<path /g).length, 1);
  assert.match(medium, new RegExp(brand.colors.seal));
  assert.equal(medium.match(/<path /g).length, 1, 'medium detail is one solid path with a plain seal');
  assert.match(full, new RegExp(brand.colors.seal));
  assert.ok(full.match(/<path /g).length > 22, 'full detail has the dry-brush tail');
  assert.match(full, /clip-path="url\(#brush-outline\)"/);
  assert.doesNotMatch(brand.mark({ pixels: 16 }), new RegExp(brand.colors.seal));
});

test('the tile\'s gradient is drawn outside the shadow filter, which would band it', () => {
  const svg = brand.tile({ look: 'ink' });
  assert.match(svg, /<rect [^>]*filter="url\(#shadow\)"\/><rect [^>]*fill="url\(#tile\)"\/>/);
  assert.doesNotMatch(svg, /fill="url\(#tile\)" filter=/);
});

test('the in-app logos and favicon show Paper, or Ink when the page is dark', () => {
  for (const svg of [brand.autoMark({ detail: 'medium' }), brand.autoMark({ detail: 'small' })]) {
    assert.match(svg, /@media \(prefers-color-scheme:dark\)/);
    for (const color of [brand.colors.paper.brush, brand.colors.ink.brush, ...brand.colors.paper.tile, ...brand.colors.ink.tile]) assert.ok(svg.includes(color), color);
  }
});

test('the menu bar images are 16 points tall and a whole number of points wide', () => {
  const idle = brand.template(), attention = brand.template({ attention: true });
  for (const image of [idle, attention]) {
    assert.equal(image.height, 16);
    assert.ok(Number.isInteger(image.width) && image.width >= 12 && image.width <= 24, String(image.width));
  }
  assert.ok(attention.width > idle.width);
  assert.doesNotMatch(idle.svg, /<circle/);
  assert.match(attention.svg, /<circle/);
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
  for (const [name, content] of Object.entries(brand.iconComposer())) assert.equal(read(path.join('assets/AppIcon.icon', name)), content, name);
  assert.ok(read('public/index.html').includes(brand.onboardingMark()), 'the welcome screen logo in public/index.html');
  for (const file of ['assets/Assets.car', 'assets/icon.icns', 'assets/icon.ico', 'assets/status/StatusTemplate@2x.png', 'assets/status/StatusAttentionTemplate@2x.png']) assert.ok(fs.statSync(path.join(root, file)).size > 0, file);
});

test('the welcome screen logo has every part its styles animate', () => {
  const css = read('public/onboarding.css'), mark = brand.onboardingMark();
  for (const part of ['mark-tile', 'mark-fill', 'mark-edge', 'mark-brush', 'mark-reveal', 'mark-seal']) {
    assert.ok(mark.includes(`class="${part}"`), part);
    assert.ok(css.includes(`.${part}`), part);
  }
});

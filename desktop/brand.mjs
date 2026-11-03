// The Codeshi logo, drawn in code: a brush-stroke C (an ensō, the circle a Zen master paints in one stroke) and a
// vermilion seal carved with シ ("shi"), the way a master signs their work. `npm run icons` (desktop/icons.mjs) writes
// every icon file from these drawings.
//
// Two looks share one drawing: Paper (black ink on cream) is the default, and Ink (cream on black) is for dark
// appearances.
//
// How the C is drawn: a round brush travels along one centreline. It lands at the stroke's full width, so the start is
// a plain round cap, keeps that width over the top and down the left, then lifts to a point. The outline is the edge
// of everything the brush covers, so it is one continuous curve with no joins, and it is saved as cubic Béziers
// through a few evenly spaced anchor points.
//
// Three levels of detail, by the size the icon is drawn at (`detailFor`):
//   small   32 px and below   the seal on its own, with シ carved in cream (the C would only read as a plain letter)
//   medium  33 to 127 px      the C with a clean solid taper, and a simpler seal
//   full    128 px and up     the dry-brush tail and the carved seal
//
// Everything is drawn in a 100-unit square, the full-bleed icon tile.

const fmt = n => { const v = Math.round(n * 100) / 100; return Object.is(v, -0) ? '0' : String(v); };
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const distance = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
const deg = Math.PI / 180;
export const detailFor = pixels => pixels <= 32 ? 'small' : pixels < 128 ? 'medium' : 'full';
function random(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const polygon = (points, digits = 2) => {
  const f = n => digits === 2 ? fmt(n) : String(Math.round(n * 10) / 10);
  return 'M' + points.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';
};

export const colors = {
  paper: { tile: ['#f8f2e8', '#ebe1d0'], brush: '#1d1a17', edge: 'rgb(74 52 30 / .2)' },
  ink: { tile: ['#2b2825', '#141312'], brush: '#f4ede1', edge: 'rgb(255 255 255 / .1)' },
  seal: '#d9381e', carve: '#fbf4ea',
};

// The path the brush travels: an open, slightly irregular ellipse, anticlockwise on screen from the upper right.
function ensoPath({ cx, cy, rx, ry, rot, start, sweep, wobble = 0, flick = 0 }) {
  const c = Math.cos(rot * deg), s = Math.sin(rot * deg);
  return t => {
    const th = (start - sweep * t) * deg;
    const k = 1 + wobble * Math.sin(t * Math.PI * 2.3 + 0.6) + flick * smooth(0.8, 1, t);
    const x = rx * Math.cos(th) * k, y = ry * Math.sin(th) * k;
    return [cx + x * c - y * s, cy + x * s + y * c];
  };
}
// ---- The brush's footprint and the outline it leaves

// The brush at t: a circle of the stroke's half-width around the point on the centreline.
const footprint = (model, t) => ({ c: model.path(t), r: model.radius(t) });
const onCircle = (f, u) => [f.c[0] + f.r * Math.cos(u), f.c[1] + f.r * Math.sin(u)];
const direction = (model, t, h = 1e-4) => { const a = model.path(t - h), b = model.path(t + h), l = distance(a, b) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };

// Where the footprint at t meets the stroke's edges, as angles round the circle: straight out to either side while
// the width holds, leaning forward as the brush lifts. Left is the outside of the C, right the inside.
function contacts(model, t) {
  const h = 1e-4, f = footprint(model, t), dir = direction(model, t);
  const speed = distance(model.path(t - h), model.path(t + h)) / (2 * h), lift = (model.radius(t + h) - model.radius(t - h)) / (2 * h);
  const heading = Math.atan2(dir[1], dir[0]), lean = Math.acos(clamp(-lift / speed, -1, 1));
  const left = heading + lean, right = heading - lean;
  return { f, dir, left, right, L: onCircle(f, left), R: onCircle(f, right) };
}

// Points round the footprint from angle `from` to `to`, the way that passes the side facing `toward`.
function arc(f, from, to, toward, count) {
  const span = ((to - from) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI), p = onCircle(f, from + span / 2);
  const length = (p[0] - f.c[0]) * toward[0] + (p[1] - f.c[1]) * toward[1] > 0 ? span : span - 2 * Math.PI;
  return Array.from({ length: count - 1 }, (_, k) => onCircle(f, from + length * (k + 1) / count));
}

// The closed outline as dense points: round the cap at the start, along the left edge, round or to a point at the
// end (or straight across where `until` cuts the stroke short), and back along the right edge. `pins` mark where
// anchors must sit: the back of the cap and where it meets each edge, the end, and any corners.
function trace(model, { until = 1, samples = 1400 } = {}) {
  const pointed = model.end === 'point' && until === 1, last = pointed ? 1 - 1 / samples : until;
  const edges = Array.from({ length: samples + 1 }, (_, i) => contacts(model, last * i / samples));
  const start = edges[0], finish = edges.at(-1);
  const head = arc(start.f, start.right, start.left, start.dir.map(v => -v), 160);
  const end = pointed ? [model.path(1)] : until < 1 ? [] : arc(finish.f, finish.left, finish.right, finish.dir, 100);
  const points = [...head, ...edges.map(e => e.L), ...end, ...edges.slice().reverse().map(e => e.R)];
  const behind = p => (p[0] - start.f.c[0]) * start.dir[0] + (p[1] - start.f.c[1]) * start.dir[1];
  const back = head.reduce((best, p, i) => behind(p) < behind(head[best]) ? i : best, 0);
  const endIndex = head.length + edges.length;
  // Where a cap meets an edge, the outline's tangent is the circle's own at that angle, in the direction the cap is
  // traced; it is exact there, where a chord through the dense points would not be.
  const meet = (index, u) => ({ index, tangent: [Math.sin(u), -Math.cos(u)] });
  const pins = [{ index: back }, meet(head.length, start.left), meet(points.length - 1, start.right)];
  if (pointed) pins.push({ index: endIndex, corner: true });
  else if (until < 1) pins.push({ index: endIndex - 1, corner: true }, { index: endIndex, corner: true });
  else {
    const ahead = p => (p[0] - finish.f.c[0]) * finish.dir[0] + (p[1] - finish.f.c[1]) * finish.dir[1];
    // A brush that lifts to a rounded tip: anchor both sides of that cap and its front.
    pins.push(meet(endIndex - 1, finish.left), meet(endIndex + end.length, finish.right));
    pins.push({ index: endIndex + end.reduce((best, p, i) => ahead(p) > ahead(end[best]) ? i : best, 0) });
  }
  return { points, pins, edges, last };
}

// ---- Cubic Béziers through evenly spaced anchors

const bezier = (b, u) => { const m = 1 - u; return [0, 1].map(k => m * m * m * b[0][k] + 3 * m * m * u * b[1][k] + 3 * m * u * u * b[2][k] + u * u * u * b[3][k]); };
const bezier1 = (b, u) => { const m = 1 - u; return [0, 1].map(k => 3 * m * m * (b[1][k] - b[0][k]) + 6 * m * u * (b[2][k] - b[1][k]) + 3 * u * u * (b[3][k] - b[2][k])); };
const bezier2 = (b, u) => [0, 1].map(k => 6 * (1 - u) * (b[2][k] - 2 * b[1][k] + b[0][k]) + 6 * u * (b[3][k] - 2 * b[2][k] + b[1][k]));
const dot = (p, q) => p[0] * q[0] + p[1] * q[1];

// One cubic from pts[0] to its last point, leaving and arriving along the given unit tangents (least squares).
function fitCubic(pts, t1, t2) {
  const p0 = pts[0], p3 = pts.at(-1), chord = distance(p0, p3);
  let us = pts.map((_, i) => i / (pts.length - 1)), b;
  const solve = () => {
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    pts.forEach((p, i) => {
      const u = us[i], m = 1 - u, b0 = m * m * m, b1 = 3 * m * m * u, b2 = 3 * m * u * u, b3 = u * u * u;
      const a1 = [t1[0] * b1, t1[1] * b1], a2 = [-t2[0] * b2, -t2[1] * b2];
      const rest = [p[0] - p0[0] * (b0 + b1) - p3[0] * (b2 + b3), p[1] - p0[1] * (b0 + b1) - p3[1] * (b2 + b3)];
      c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2); x0 += dot(a1, rest); x1 += dot(a2, rest);
    });
    const det = c00 * c11 - c01 * c01;
    let k1 = det ? (x0 * c11 - x1 * c01) / det : 0, k2 = det ? (c00 * x1 - c01 * x0) / det : 0;
    if (!(k1 > chord * 1e-3) || !(k2 > chord * 1e-3)) k1 = k2 = chord / 3;
    b = [p0, [p0[0] + t1[0] * k1, p0[1] + t1[1] * k1], [p3[0] - t2[0] * k2, p3[1] - t2[1] * k2], p3];
  };
  solve();
  for (let round = 0; round < 8; round++) {
    us = us.map((u, i) => {
      const q = bezier(b, u), d1 = bezier1(b, u), d2 = bezier2(b, u), off = [q[0] - pts[i][0], q[1] - pts[i][1]];
      const den = dot(d1, d1) + dot(off, d2);
      return den ? clamp(u - dot(off, d1) / den) : u;
    });
    solve();
  }
  return { b, error: Math.max(...pts.map((p, i) => distance(bezier(b, us[i]), p))) };
}

// The outline as cubic Béziers. Anchors are spread evenly between the pins, closer only if the fit needs it.
function toBeziers({ points, pins }, { spacing = 11, tolerance = 0.15 } = {}) {
  const n = points.length, s = [0];
  for (let i = 1; i <= n; i++) s.push(s[i - 1] + distance(points[i - 1], points[i % n]));
  const total = s[n];
  const at = pos => {
    pos = ((pos % total) + total) % total;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid] <= pos) lo = mid; else hi = mid; }
    const a = points[lo], b = points[(lo + 1) % n], k = (pos - s[lo]) / (s[lo + 1] - s[lo] || 1);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  };
  const unit = (p, q) => { const l = distance(p, q) || 1; return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };
  const pinned = pins.map(pin => ({ pos: s[pin.index], corner: Boolean(pin.corner), tangent: pin.tangent })).sort((x, y) => x.pos - y.pos);
  for (let attempt = 0; ; attempt++) {
    const step = spacing * Math.pow(0.88, attempt), anchors = [];
    pinned.forEach((pin, i) => {
      const to = i + 1 < pinned.length ? pinned[i + 1].pos : pinned[0].pos + total, count = Math.max(1, Math.round((to - pin.pos) / step));
      for (let k = 0; k < count; k++) anchors.push({ pos: pin.pos + (to - pin.pos) * k / count, corner: k === 0 && pin.corner, tangent: k === 0 ? pin.tangent : undefined });
    });
    const delta = 0.2;
    for (const a of anchors) {
      a.point = at(a.pos);
      a.in = a.tangent || unit(at(a.pos - delta), a.corner ? a.point : at(a.pos + delta));
      a.out = a.corner ? unit(a.point, at(a.pos + delta)) : a.in;
    }
    let error = 0;
    const segments = anchors.map((a, i) => {
      const next = anchors[(i + 1) % anchors.length], to = i + 1 < anchors.length ? next.pos : next.pos + total;
      const pts = Array.from({ length: 41 }, (_, k) => at(a.pos + (to - a.pos) * k / 40));
      const fitted = fitCubic(pts, a.out, next.in);
      error = Math.max(error, fitted.error);
      return fitted.b;
    });
    if (error <= tolerance || attempt >= 14) return { anchors, segments, error, errors: segments.map((b, i) => fitCubic(Array.from({ length: 41 }, (_, k) => at(anchors[i].pos + ((i + 1 < anchors.length ? anchors[i + 1].pos : anchors[0].pos + total) - anchors[i].pos) * k / 40)), anchors[i].out, anchors[(i + 1) % anchors.length].in).error) };
  }
}
const pathData = ({ segments }, digits = 2) => {
  const f = n => digits === 2 ? fmt(n) : String(Math.round(n * 10) / 10), p = q => `${f(q[0])} ${f(q[1])}`;
  return `M${p(segments[0][0])}` + segments.map(b => `C${p(b[1])} ${p(b[2])} ${p(b[3])}`).join('') + 'Z';
};

// Dry brush: past the middle, the stroke is a set of bristles between its two edges. Neighbouring bristles run dry
// together in a few bands, leaving streaks of paper, and the rest carry on to the point.
function bristles(traced, { count = 22, from = 0.5, seed = 11, dryFrom = 0.62, stray = 0.12, samples = 64,
  bands = [[-0.78, 0.16], [-0.22, 0.2], [0.34, 0.14], [0.8, 0.12]] } = {}) {
  const { edges, last } = traced, edgeAt = t => {
    const x = clamp(t / last) * (edges.length - 1), i = Math.min(Math.floor(x), edges.length - 2), k = x - i;
    const mix = key => [0, 1].map(j => edges[i][key][j] + (edges[i + 1][key][j] - edges[i][key][j]) * k);
    return { L: mix('L'), R: mix('R') };
  };
  const next = random(seed), shapes = [];
  for (let i = 0; i < count; i++) {
    const o = -1 + (2 * i + 1) / count;
    const band = bands.find(([centre, reach]) => Math.abs(o - centre) <= reach);
    const dry = band ? next() < 0.85 : next() < stray;
    const end = dry ? dryFrom + (0.94 - dryFrom) * next() : 1;
    const phase = next() * 6, wiggle = 0.008 + next() * 0.016, half = 1.22 / count;
    const a = [], b = [];
    for (let k = 0; k <= samples; k++) {
      const t = from + (end - from) * k / samples, { L, R } = edgeAt(t);
      const taper = end < 1 ? 1 - smooth(end - 0.06, end, t) : 1;
      // Bristles stay inside the stroke, and only start to wander once clear of the solid part.
      const c = o + wiggle * Math.sin(t * 34 + phase) * smooth(from + 0.08, from + 0.2, t), h = half * Math.max(taper, 0.02);
      const place = v => [(L[0] + R[0]) / 2 + (L[0] - R[0]) / 2 * v, (L[1] + R[1]) / 2 + (L[1] - R[1]) / 2 * v];
      a.push(place(Math.min(c + h, 1))); b.push(place(Math.max(c - h, -1)));
    }
    shapes.push([...a, ...b.reverse()]);
  }
  return shapes;
}

// ---- The two brushes

// Both brushes travel the same centreline, and each holds one width before it lifts.
const taper = s => s >= 1 ? 0 : Math.pow(1 - s, 1.05) * (1 + 1.05 * s);
const fullPath = ensoPath({ cx: 46, cy: 49.5, rx: 23, ry: 24.5, rot: -8, start: -38, sweep: 282, flick: 0.03 });
// An even stroke over the first half, thinning to a point over the second.
const fullModel = { path: fullPath, radius: t => t < 0.5 ? 5.865 : 5.865 * taper((t - 0.5) / 0.5), end: 'point' };

const traced = new Map();
const traceOnce = (key, make) => { if (!traced.has(key)) traced.set(key, make()); return traced.get(key); };
const fullTrace = () => traceOnce('full', () => trace(fullModel));
const bodyTrace = () => traceOnce('body', () => trace(fullModel, { until: 0.6, samples: 840 }));
const fitted = (key, make) => traceOnce('fit:' + key, make);

// The brush C as SVG path data. full: { solid, textured: [body, ...bristles], centreline }; medium: { solid }. Small
// sizes show the seal instead (`stamp`). `coarse` uses fewer points and one decimal place, for drawings shown no
// larger than about 100 px.
export function brush({ detail = 'full', coarse = false } = {}) {
  if (detail === 'small') throw new Error('Small sizes show the seal, not the brush C.');
  const solid = pathData(fitted('full', () => toBeziers(fullTrace())), coarse ? 1 : 2);
  if (detail === 'medium') return { solid };
  const digits = coarse ? 1 : 2;
  return {
    solid,
    textured: [pathData(fitted('body', () => toBeziers(bodyTrace())), digits),
      ...bristles(fullTrace(), { samples: coarse ? 26 : 64 }).map(points => polygon(points, digits))],
    // The centreline, for drawing the stroke in: from just behind the head to the point.
    centreline: 'M' + Array.from({ length: 73 }, (_, i) => fullModel.path(-0.03 + 1.03 * i / 72)).map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L'),
  };
}

// The dense outline the Béziers are fitted to, for checking the fit.
export const debugTrace = () => fullTrace();

// Anchor points and handles of a drawing's outline, for checking its curves.
export function anchors(options = {}) {
  const fit = Object.keys(options).length ? toBeziers(fullTrace(), options) : fitted('full', () => toBeziers(fullTrace()));
  return { anchors: fit.segments.map(b => b[0]), segments: fit.segments };
}

// シ in three strokes, in a unit square: two short ticks, then the long sweep up to the right.
const shiStrokes = [[[0.25, 0.26], [0.4, 0.36]], [[0.2, 0.47], [0.35, 0.57]], [[0.25, 0.8], [0.62, 0.7], [0.79, 0.22]]];
const strokeData = (points, u) => `M${u(...points[0])}` + (points.length === 2 ? `L${u(...points[1])}` : `Q${u(...points[1])} ${u(...points[2])}`);

// The seal where the stroke ends, pressed by hand at a slight angle, with シ carved into it. At medium detail it is a
// plain vermilion square: at 64 px the carving is too small to read and only adds noise.
export const sealBox = { x: 64, y: 58, size: 15, rotate: -4 };
export function seal({ carve = colors.carve, fill = colors.seal, parts = false, detail = 'full' } = {}) {
  const { x, y, size: s, rotate } = sealBox, u = (px, py) => `${fmt(x + px * s)} ${fmt(y + py * s)}`;
  const transform = `rotate(${rotate} ${fmt(x + s / 2)} ${fmt(y + s / 2)})`;
  const body = `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(s)}" height="${fmt(s)}" rx="${fmt(s * 0.1)}" fill="${fill}"/>`;
  const shi = detail === 'medium' ? '' : `<g fill="none" stroke="${carve}" stroke-width="${fmt(s * 0.115)}" stroke-linecap="round" stroke-linejoin="round">`
    + shiStrokes.map(points => `<path d="${strokeData(points, u)}"/>`).join('') + '</g>';
  if (parts) return { transform, body, shi };
  return `<g transform="${transform}">${body}${shi}</g>`;
}

// The seal on its own, the mark at 32 px and below: upright so its edges stay sharp, the same in both looks, and with
// シ enlarged to fill the square and centred on it. Drawn in the 100-unit square; `radius` rounds its corners.
export const stamp = { radius: 18, stroke: 12.5, scale: 1.12 };
const stampShi = ({ scale = stamp.scale } = {}) => {
  const u = (x, y) => `${fmt(50 + (x - 0.495) * scale * 100)} ${fmt(50 + (y - 0.51) * scale * 100)}`;
  return shiStrokes.map(points => strokeData(points, u)).join('');
};
const stampParts = (radius = stamp.radius) => `<rect width="100" height="100" rx="${fmt(radius)}" fill="${colors.seal}"/>`
  + `<path d="${stampShi()}" fill="none" stroke="${colors.carve}" stroke-width="${stamp.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;

// シ on its own, without the square: the mark beside the name inside the app, and the menu bar icon. It fills the
// 100-unit square, and its sweep leaves the bottom right corner empty, where `dot` puts the "needs you" dot. On dark
// surfaces the strokes use a lighter vermilion, so their thin lines keep their contrast.
export const glyph = { scale: 1.42, stroke: 14, dark: '#ef6448', dot: { x: 89, y: 89, r: 17 } };
// `color` null leaves the stroke colour to a stylesheet.
const glyphPath = (color = 'currentColor') => `<path d="${stampShi({ scale: glyph.scale })}" fill="none"${color ? ` stroke="${color}"` : ''} stroke-width="${glyph.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
// public/mark.svg: vermilion, lighter when the page is dark (it follows the page's color-scheme).
export function glyphMark() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Codeshi</title>`
    + `<style>path{stroke:${colors.seal}}@media (prefers-color-scheme:dark){path{stroke:${glyph.dark}}}</style>${glyphPath(null)}</svg>`;
}
// The same drawing inline, in the page's current colour, for pages that may not load images (the alert panel).
export const inlineGlyph = className => `<svg class="${className}" viewBox="0 0 100 100" aria-hidden="true">${glyphPath()}</svg>`;

const gradient = (id, [top, bottom]) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`;
const brushPaths = detail => {
  const shape = brush({ detail });
  // The fit and the sampled bristles can differ by a fraction of a unit. Clip to the final Bézier silhouette,
  // so not even a hair can escape the outside edge in a raster export or an Icon Composer layer.
  return detail === 'full' ? `<defs><clipPath id="brush-outline"><path d="${shape.solid}"/></clipPath></defs>`
    + `<g clip-path="url(#brush-outline)">${shape.textured.map(d => `<path d="${d}"/>`).join('')}</g>` : `<path d="${shape.solid}"/>`;
};
// The tile's drop shadow, its own layer under the tile, so the tile's gradient never passes through a filter
// (Chromium runs filters in 8-bit linear colour, which bands dark gradients).
const tileShadow = look => `<filter id="shadow" x="-20%" y="-20%" width="140%" height="145%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="16"/><feOffset dy="14"/>`
  + `<feComponentTransfer><feFuncA type="linear" slope="${look === 'paper' ? 0.22 : 0.3}"/></feComponentTransfer></filter>`;

// macOS app icon on a 1024 canvas: an 824px tile with the system's margin and shadow (Paper or Ink). `pixels` is the
// size it will be drawn at: it picks the level of detail, and keeps Paper's edge line about half a pixel wide. At
// small detail the tile is the seal, in the system's tile shape.
export function tile({ look = 'paper', pixels = 1024, detail = detailFor(pixels) } = {}) {
  const c = colors[look], edge = Math.max(2.5, 0.6 * 1024 / pixels), shape = 'x="100" y="100" width="824" height="824" rx="186"';
  if (detail === 'small') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><title>Codeshi</title><defs>${tileShadow(look)}</defs>`
    + `<rect ${shape} filter="url(#shadow)"/><g transform="translate(100 100) scale(8.24)">${stampParts(186 / 8.24)}</g></svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><title>Codeshi</title><defs>${gradient('tile', c.tile)}${tileShadow(look)}</defs>`
    + `<rect ${shape} filter="url(#shadow)"/><rect ${shape} fill="url(#tile)"/>`
    + `<rect x="${fmt(100 + edge / 2)}" y="${fmt(100 + edge / 2)}" width="${fmt(824 - edge)}" height="${fmt(824 - edge)}" rx="${fmt(186 - edge / 2)}" fill="none" stroke="${c.edge}" stroke-width="${fmt(edge)}"/>`
    + `<g transform="translate(100 100) scale(8.24)"><g fill="${c.brush}">${brushPaths(detail)}</g>${seal({ detail })}</g></svg>`;
}

// Full-bleed tile (favicon, in-app logo, Windows icon) in one look. `square` drops the rounded corners and edge line,
// for icons that the system rounds itself (Apple touch icon, web app icons).
export function mark({ look = 'paper', pixels = 1024, detail = detailFor(pixels), square = false } = {}) {
  if (detail === 'small') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Codeshi</title>${stampParts(square ? 0 : stamp.radius)}</svg>`;
  const c = colors[look], edge = 1.6;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Codeshi</title><defs>${gradient('tile', c.tile)}</defs>`
    + `<rect width="100" height="100" rx="${square ? 0 : 22}" fill="url(#tile)"/>`
    + (square ? '' : `<rect x="${edge / 2}" y="${edge / 2}" width="${100 - edge}" height="${100 - edge}" rx="${22 - edge / 2}" fill="none" stroke="${c.edge}" stroke-width="${edge}"/>`)
    + `<g fill="${c.brush}">${brushPaths(detail)}</g>${seal({ detail })}</svg>`;
}

// One file for both looks: Paper, or Ink when the page or system is dark (it follows the page's color-scheme). The
// seal at small detail is the same in both looks.
export function autoMark({ detail = 'full' } = {}) {
  if (detail === 'small') return mark({ detail });
  const edge = 1.6, { paper, ink } = colors;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Codeshi</title>`
    + `<style>.tile{fill:url(#paper)}.edge{stroke:${paper.edge}}.brush{fill:${paper.brush}}`
    + `@media (prefers-color-scheme:dark){.tile{fill:url(#ink)}.edge{stroke:${ink.edge}}.brush{fill:${ink.brush}}}</style>`
    + `<defs>${gradient('paper', paper.tile)}${gradient('ink', ink.tile)}</defs>`
    + `<rect class="tile" width="100" height="100" rx="22"/>`
    + `<rect class="edge" x="${edge / 2}" y="${edge / 2}" width="${100 - edge}" height="${100 - edge}" rx="${22 - edge / 2}" fill="none" stroke-width="${edge}"/>`
    + `<g class="brush">${brushPaths(detail)}</g>${seal({ detail })}</svg>`;
}

// macOS menu bar template image: シ in black, 14 points square with a 1-point margin, so the image is 16 points square,
// with a dot in its empty bottom right corner when something needs you. Returns the SVG and its size in points. The
// macOS menu bar colours it to match.
export function template({ attention = false } = {}) {
  const unit = 100 / 14, box = [-unit, -unit, 16 * unit, 16 * unit].map(fmt).join(' '), { x, y, r } = glyph.dot;
  return { width: 16, height: 16, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${glyphPath('#000')}`
    + (attention ? `<circle cx="${x}" cy="${y}" r="${r}"/>` : '') + '</svg>' };
}

// The welcome screen's animated logo, kept in public/index.html by `npm run icons`. Its colours come from
// public/onboarding.css, so it shows Paper or Ink with the app's theme; the tile pops in, the brush paints the C
// along its stroke and the seal is stamped last.
export function onboardingMark() {
  const shape = brush({ coarse: true }), { paper, ink } = colors;
  const stops = ([top, bottom]) => `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>`;
  return `<svg class="onboarding-mark" viewBox="0 0 100 100" aria-hidden="true"><defs>`
    + `<linearGradient id="ob-paper" x1="0" y1="0" x2="0" y2="1">${stops(paper.tile)}</linearGradient><linearGradient id="ob-ink" x1="0" y1="0" x2="0" y2="1">${stops(ink.tile)}</linearGradient>`
    + `<mask id="ob-reveal" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><path class="mark-reveal" d="${shape.centreline}" pathLength="100" fill="none" stroke="#fff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/></mask></defs>`
    + `<g class="mark-tile"><rect class="mark-fill" width="100" height="100" rx="22"/><rect class="mark-edge" x="0.8" y="0.8" width="98.4" height="98.4" rx="21.2" fill="none" stroke-width="1.6"/></g>`
    + `<defs><clipPath id="ob-outline"><path d="${shape.solid}"/></clipPath></defs>`
    + `<g class="mark-brush" mask="url(#ob-reveal)" clip-path="url(#ob-outline)">${shape.textured.map(d => `<path d="${d}"/>`).join('')}</g>`
    + `<g class="mark-seal">${seal()}</g></svg>`;
}

// Icon Composer layers for macOS 26 and later, on its 1024-point canvas. The system draws the tile, its glass and
// shadows; the background and the brush colour change for the dark appearance.
export function iconComposer() {
  const layer = inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="scale(10.24)">${inner}</g></svg>`;
  const { transform, body, shi } = seal({ parts: true });
  const rgb = hex => hex.match(/\w\w/g).map(v => (parseInt(v, 16) / 255).toFixed(5)).join(',');
  const color = hex => `extended-srgb:${rgb(hex)},1.00000`;
  const fill = ([top, bottom]) => ({ 'linear-gradient': [color(top), color(bottom)], orientation: { start: { x: 0.5, y: 0 }, stop: { x: 0.5, y: 1 } } });
  const json = {
    'fill-specializations': [{ value: fill(colors.paper.tile) }, { appearance: 'dark', value: fill(colors.ink.tile) }],
    groups: [
      { name: 'Seal', layers: [
        { name: 'Shi', 'image-name': 'Shi.svg' },
        { name: 'Seal', 'image-name': 'Seal.svg' },
      ], shadow: { kind: 'neutral', opacity: 0.4 }, translucency: { enabled: false, value: 0.5 } },
      { name: 'Brush', layers: [
        // Tinted icons are drawn from each layer's brightness, so the brush is white there to stay the strongest shape.
        { name: 'Brush', 'image-name': 'Brush.svg', 'fill-specializations': [
          { value: { solid: color(colors.paper.brush) } }, { appearance: 'dark', value: { solid: color(colors.ink.brush) } },
          { appearance: 'tinted', value: { solid: color('#ffffff') } }] },
      ], shadow: { kind: 'neutral', opacity: 0.35 }, translucency: { enabled: false, value: 0.5 } },
    ],
    'supported-platforms': { squares: ['macOS'] },
  };
  return {
    'icon.json': JSON.stringify(json, null, 2) + '\n',
    'Assets/Brush.svg': layer(`<g fill="#000">${brushPaths('full')}</g>`),
    'Assets/Seal.svg': layer(`<g transform="${transform}">${body}</g>`),
    'Assets/Shi.svg': layer(`<g transform="${transform}">${shi}</g>`),
  };
}

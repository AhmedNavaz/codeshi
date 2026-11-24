// The layout sketch's logic that doesn't touch the page (#125): keeping boxes on the frame and on its grid, numbering them
// in reading order, saying where each sits, and writing the message. Loaded as a plain script in the page and as a module
// in tests, like phone-logic.js. The message follows Design notes' (desktop/preview.mjs designText): a lead line, then one
// numbered line per section, then the whole page, so the numbers match the boxes in the sketch's picture.
(root => {
  'use strict';
  const FRAMES = Object.freeze({ desktop: { name: 'desktop', width: 1280 }, tablet: { name: 'tablet', width: 768 }, phone: { name: 'phone', width: 390 } });
  const KINDS = Object.freeze(['Header', 'Navigation', 'Hero', 'Text', 'Image', 'Cards', 'List', 'Form', 'Table', 'Button', 'Sidebar', 'Footer', 'Other']);
  const LIMIT = 12, GRID = 8, DEPTH = 20000, NOTE = 2000, OVERALL = 4000, NAME = 80;
  const clip = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
  const snap = value => Math.round(value / GRID) * GRID;
  const frameOf = name => FRAMES[name] || FRAMES.desktop;

  // A box as it can be kept: a known kind, whole grid steps, at least one step in each direction, inside the frame's width.
  function cleanBox(input, width) {
    const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const w = Math.min(width, Math.max(GRID, snap(number(input?.w, GRID)))), x = Math.min(width - w, Math.max(0, snap(number(input?.x))));
    const h = Math.min(DEPTH, Math.max(GRID, snap(number(input?.h, GRID)))), y = Math.min(DEPTH - h, Math.max(0, snap(number(input?.y))));
    return { id: typeof input?.id === 'string' && /^b\d{1,6}$/.test(input.id) ? input.id : 'b0', kind: KINDS.includes(input?.kind) ? input.kind : 'Other', x, y, w, h };
  }
  // Reading order: top to bottom, and left to right among boxes that start within half a header's height of each other.
  function ordered(boxes) {
    return [...boxes].sort((a, b) => Math.abs(a.y - b.y) < 24 ? a.x - b.x || a.y - b.y : a.y - b.y);
  }
  // The smallest other box that holds this one whole.
  const holds = (outer, inner) => outer !== inner && outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h && outer.w * outer.h > inner.w * inner.h;
  function parentOf(box, boxes) {
    return boxes.filter(other => holds(other, box)).sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
  }
  // Where a box sits, in words an agent can build from: its width and side, what holds it or sits beside it, and its
  // place in frame pixels.
  function placeOf(box, boxes, width, numberOf) {
    const share = box.w / width, centre = (box.x + box.w / 2) / width, words = [];
    if (share >= 0.9) words.push('full width');
    else {
      const size = share >= 0.6 ? 'wide' : share >= 0.4 ? 'half width' : share >= 0.27 ? 'a third wide' : 'narrow';
      words.push(`${size}, ${centre < 0.4 ? 'on the left' : centre > 0.6 ? 'on the right' : 'in the middle'}`);
    }
    if (box.y === 0) words.push('at the top');
    const parent = parentOf(box, boxes);
    if (parent) words.push(`inside ${numberOf(parent)}`);
    else {
      // Beside: another top-level box that shares most of its height.
      const beside = boxes.find(other => other !== box && !parentOf(other, boxes) && !holds(box, other) && Math.min(box.y + box.h, other.y + other.h) - Math.max(box.y, other.y) >= Math.min(box.h, other.h) * 0.5 && (other.x + other.w <= box.x || box.x + box.w <= other.x));
      if (beside) words.push(`beside ${numberOf(beside)}`);
    }
    return `${words.join(', ')} (x ${box.x}–${box.x + box.w}, y ${box.y}–${box.y + box.h})`;
  }
  // The message: what the sketch is, then each section with its note, then the whole page.
  function sketchText({ boxes = [], notes = {}, overall = '', name = '', frame = 'desktop', pictured = true } = {}) {
    const { width, name: frameName } = frameOf(frame), list = ordered(boxes), number = new Map(list.map((box, index) => [box, index + 1]));
    const title = clip(name, NAME), count = list.length;
    const lead = `Layout sketch for a page that doesn’t exist yet${title ? `, “${title}”` : ''}, for ${frameName} (${width} px wide)${count ? `, ${count} ${count === 1 ? 'section' : 'sections'}` : ''}.${count && pictured ? ' The numbers match the boxes in the sketch.' : ''} Build it in the project’s existing style unless the notes say otherwise.`;
    const lines = list.map((box, index) => `${index + 1}. ${box.kind}, ${placeOf(box, list, width, other => number.get(other))}: ${clip(notes[box.id], NOTE)}`.trimEnd());
    const whole = clip(overall, OVERALL);
    return [lead, ...lines, ...(whole ? [`Whole page: ${whole}`] : [])].join('\n');
  }
  // Where a new box of a kind goes: under everything already there, at the kind's usual size. A sidebar goes down the left
  // under a header or navigation, and narrow kinds sit in the middle.
  const SIZES = { Header: [1, 80], Navigation: [1, 56], Hero: [1, 420], Text: [0.6, 160], Image: [0.5, 320], Cards: [1, 280], List: [1, 240], Form: [0.5, 360], Table: [1, 320], Button: [0.2, 48], Sidebar: [0.25, 600], Footer: [1, 160], Other: [1, 200] };
  function newBox(kind, boxes, frame, id) {
    const { width } = frameOf(frame), [share, h] = SIZES[kind] || SIZES.Other, w = Math.max(GRID * 6, snap(width * share));
    const bottom = Math.max(0, ...boxes.map(box => box.y + box.h));
    if (kind === 'Sidebar') {
      const top = Math.max(0, ...boxes.filter(box => ['Header', 'Navigation'].includes(box.kind)).map(box => box.y + box.h));
      return cleanBox({ id, kind, x: 0, y: top, w, h }, width);
    }
    return cleanBox({ id, kind, x: share < 1 ? snap((width - w) / 2) : 0, y: bottom, w, h }, width);
  }
  // A frame changed to another width: each box keeps its share of the width, and its height.
  function resize(boxes, from, to) {
    const ratio = frameOf(to).width / frameOf(from).width;
    return boxes.map(box => cleanBox({ ...box, x: box.x * ratio, w: box.w * ratio }, frameOf(to).width));
  }
  // A saved sketch as it can be used: known frame, at most LIMIT boxes with unique ids, notes only for boxes that exist.
  function cleanSketch(input) {
    const frame = FRAMES[input?.frame] ? input.frame : 'desktop', width = frameOf(frame).width, seen = new Set(), boxes = [];
    for (const raw of Array.isArray(input?.boxes) ? input.boxes : []) {
      const box = cleanBox(raw, width);
      if (box.id === 'b0' || seen.has(box.id) || boxes.length >= LIMIT) continue;
      seen.add(box.id); boxes.push(box);
    }
    const notes = Object.fromEntries(boxes.filter(box => typeof input?.notes?.[box.id] === 'string').map(box => [box.id, input.notes[box.id].slice(0, NOTE)]));
    const clock = Math.max(Number.isSafeInteger(input?.clock) ? input.clock : 0, ...boxes.map(box => Number(box.id.slice(1))));
    return { frame, name: typeof input?.name === 'string' ? input.name.slice(0, NAME) : '', boxes, notes, overall: typeof input?.overall === 'string' ? input.overall.slice(0, OVERALL) : '', clock };
  }

  root.relaySketchLogic = { FRAMES, KINDS, LIMIT, GRID, cleanBox, cleanSketch, ordered, parentOf, placeOf, sketchText, newBox, resize };
})(typeof window === 'undefined' ? globalThis : window);

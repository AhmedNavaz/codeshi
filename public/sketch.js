(() => {
  'use strict';
  // Sketch a page (#125): for a page that doesn't exist yet, so Design notes in the preview have nothing to mark. Boxes
  // for the page's sections (a header, a hero, cards, a form…) go on a frame the page's width, each numbered in reading
  // order with a note, and the sketch goes into the message box, or onto the Plan as a card, as one numbered message with
  // a picture of the boxes: the same way Design notes do (public/preview.js). Nothing is sent on its own, and no model
  // is asked anything. Each workspace keeps its unsent sketch on this computer until it's added or cleared.
  const api = window.relayUI, logic = window.relaySketchLogic;
  if (!api || !logic) return;
  const { FRAMES, KINDS, LIMIT, GRID } = logic;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'secondary-button') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const key = projectId => `codeshi:sketch:${projectId}`;
  let dialog = null, sketch = null, projectId = null, selected = null, scale = 1, drag = null;
  const parts = {};

  function load(id) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key(id)) || 'null'); } catch { saved = null; }
    return logic.cleanSketch(saved || {});
  }
  function save() {
    if (!projectId || !sketch) return;
    const empty = !sketch.boxes.length && !sketch.overall.trim() && !sketch.name.trim();
    try { if (empty) localStorage.removeItem(key(projectId)); else localStorage.setItem(key(projectId), JSON.stringify(sketch)); } catch { /* Kept for this session only. */ }
  }
  const width = () => FRAMES[sketch.frame].width;
  const number = box => logic.ordered(sketch.boxes).indexOf(box) + 1;
  const boxBy = id => sketch.boxes.find(box => box.id === id) || null;

  function build() {
    dialog = node('dialog', 'sketch-dialog'); dialog.setAttribute('aria-labelledby', 'sketch-title');
    const head = node('header', 'sketch-head');
    const title = node('h2', 'sketch-title', 'Sketch a page'); title.id = 'sketch-title';
    parts.name = node('input', 'sketch-name'); parts.name.placeholder = 'Page name, such as Pricing'; parts.name.maxLength = 80; parts.name.setAttribute('aria-label', 'Page name');
    parts.name.addEventListener('input', () => { sketch.name = parts.name.value; save(); });
    parts.frames = node('div', 'sketch-frames'); parts.frames.setAttribute('role', 'group'); parts.frames.setAttribute('aria-label', 'Page width');
    for (const [id, frame] of Object.entries(FRAMES)) {
      const choice = button(`${id[0].toUpperCase()}${id.slice(1)} · ${frame.width}`, () => setFrame(id), 'sketch-frame'); choice.dataset.frame = id; parts.frames.append(choice);
    }
    const close = button('', () => dialog.close(), 'icon-button sketch-close'); close.setAttribute('aria-label', 'Close the sketch'); close.title = 'Close. The sketch stays until you add it or clear it.';
    head.append(title, parts.name, parts.frames, close);

    const palette = node('div', 'sketch-palette'); palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', 'Add a section');
    palette.append(node('span', 'sketch-label', 'Add'));
    parts.kinds = KINDS.map(kind => { const add = button(kind, () => addBox(kind), 'sketch-kind'); add.title = `Add a ${kind.toLowerCase()} under the others`; palette.append(add); return add; });

    parts.stage = node('div', 'sketch-stage');
    parts.frame = node('div', 'sketch-frame-area'); parts.frame.setAttribute('aria-label', 'The page. Drag to draw a section.');
    parts.empty = node('p', 'sketch-empty', 'Add sections from the list, or drag here to draw one. Drag a box to move it, its corner to resize it; with a box selected, the arrow keys move it and Option or Alt with them resizes it.');
    parts.stage.append(parts.frame, parts.empty);
    parts.frame.addEventListener('pointerdown', startDraw);

    const side = node('div', 'sketch-side');
    parts.count = node('span', 'sketch-count');
    const sideHead = node('div', 'sketch-side-head'); sideHead.append(node('strong', '', 'Sections'), parts.count);
    parts.list = node('ol', 'sketch-list'); parts.list.setAttribute('aria-label', 'Sections, in reading order');
    side.append(sideHead, parts.list);

    const body = node('div', 'sketch-body'); body.append(palette, parts.stage, side);

    const foot = node('footer', 'sketch-foot');
    parts.overall = node('textarea', 'sketch-overall'); parts.overall.rows = 2; parts.overall.placeholder = 'About the whole page (optional)'; parts.overall.setAttribute('aria-label', 'About the whole page');
    parts.overall.addEventListener('input', () => { sketch.overall = parts.overall.value; save(); });
    parts.clear = button('Clear', clear, 'secondary-button sketch-clear');
    parts.plan = button('Add to Plan', () => send('plan'), 'secondary-button'); parts.plan.title = 'Put the sketch on the Plan as a card, with its picture attached';
    parts.send = button('Add to message', () => send('message'), 'primary-button'); parts.send.title = 'Put the sketch in your message, with its picture (⌘Enter)';
    const actions = node('div', 'sketch-actions'); actions.append(parts.clear, node('span', 'sketch-spacer'), parts.plan, parts.send);
    foot.append(parts.overall, actions);

    dialog.append(head, body, foot);
    dialog.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send('message'); } });
    window.addEventListener('resize', () => { if (dialog.open) draw(); });
    document.body.append(dialog);
  }

  // ---- Changing the sketch
  function addBox(kind) {
    if (sketch.boxes.length >= LIMIT) { api.showNotice(`A sketch holds up to ${LIMIT} sections. Add it to your message first, or remove one.`); return null; }
    const box = logic.newBox(kind, sketch.boxes, sketch.frame, `b${++sketch.clock}`);
    sketch.boxes.push(box); selected = box.id; save(); draw();
    parts.stage.scrollTop = Math.max(0, box.y * scale - 40);
    return box;
  }
  function removeBox(id) {
    sketch.boxes = sketch.boxes.filter(box => box.id !== id); delete sketch.notes[id];
    if (selected === id) selected = null;
    save(); draw();
  }
  function setFrame(frame) {
    if (frame === sketch.frame) return;
    sketch.boxes = logic.resize(sketch.boxes, sketch.frame, frame); sketch.frame = frame; save(); draw();
  }
  function clear() {
    if (sketch.boxes.length && !window.confirm('Clear this sketch? Its sections and notes are removed.')) return;
    sketch = logic.cleanSketch({ frame: sketch.frame }); selected = null; save(); draw();
  }
  const place = (box, change) => { Object.assign(box, logic.cleanBox({ ...box, ...change }, width())); };

  // Drawing a new box on the empty frame, and moving or resizing one, with the pointer. Positions snap to the grid.
  const frameUnits = event => { const rect = parts.frame.getBoundingClientRect(); return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }; };
  function startDraw(event) {
    if (event.button !== 0 || event.target !== parts.frame) return;
    if (sketch.boxes.length >= LIMIT) { api.showNotice(`A sketch holds up to ${LIMIT} sections.`); return; }
    const at = frameUnits(event);
    drag = { kind: 'draw', from: at, box: null, pointer: event.pointerId };
    parts.frame.setPointerCapture?.(event.pointerId);
    parts.frame.addEventListener('pointermove', moveDrag); parts.frame.addEventListener('pointerup', endDrag); parts.frame.addEventListener('pointercancel', endDrag);
  }
  function startBox(event, box, mode) {
    if (event.button !== 0) return;
    event.stopPropagation(); event.preventDefault();
    selected = box.id; draw(); parts.frame.querySelector(`[data-id="${box.id}"]`)?.focus({ preventScroll: true });
    drag = { kind: mode, from: frameUnits(event), start: { ...box }, box, pointer: event.pointerId };
    parts.frame.setPointerCapture?.(event.pointerId);
    parts.frame.addEventListener('pointermove', moveDrag); parts.frame.addEventListener('pointerup', endDrag); parts.frame.addEventListener('pointercancel', endDrag);
  }
  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const at = frameUnits(event), dx = at.x - drag.from.x, dy = at.y - drag.from.y;
    if (drag.kind === 'draw') {
      if (!drag.box) {
        if (Math.abs(dx) < GRID && Math.abs(dy) < GRID) return;
        drag.box = { id: `b${++sketch.clock}`, kind: 'Other', x: 0, y: 0, w: GRID, h: GRID }; sketch.boxes.push(drag.box); selected = drag.box.id;
      }
      place(drag.box, { x: Math.min(drag.from.x, at.x), y: Math.min(drag.from.y, at.y), w: Math.abs(dx), h: Math.abs(dy) });
    } else if (drag.kind === 'move') place(drag.box, { x: drag.start.x + dx, y: drag.start.y + dy });
    else place(drag.box, { w: drag.start.w + dx, h: drag.start.h + dy });
    drawFrame();
  }
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    parts.frame.removeEventListener('pointermove', moveDrag); parts.frame.removeEventListener('pointerup', endDrag); parts.frame.removeEventListener('pointercancel', endDrag);
    const made = drag.kind === 'draw' ? drag.box : null; drag = null;
    save(); draw();
    // A drawn box asks what it is: its kind is chosen in its row.
    if (made) parts.list.querySelector(`[data-id="${made.id}"] select`)?.focus();
  }
  // With a box focused: arrows move it a grid step (five with Shift), Option or Alt with them resizes it, Delete removes
  // it and Enter goes to its note.
  function boxKeys(event, box) {
    const step = GRID * (event.shiftKey ? 5 : 1), arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (arrows) {
      event.preventDefault();
      place(box, event.altKey ? { w: box.w + arrows[0] * step, h: box.h + arrows[1] * step } : { x: box.x + arrows[0] * step, y: box.y + arrows[1] * step });
      save(); draw(); parts.frame.querySelector(`[data-id="${box.id}"]`)?.focus({ preventScroll: true });
      api.announce?.(`${box.kind}: x ${box.x}, y ${box.y}, ${box.w} by ${box.h}.`);
    } else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeBox(box.id); parts.frame.focus?.(); }
    else if (event.key === 'Enter') { event.preventDefault(); parts.list.querySelector(`[data-id="${box.id}"] textarea`)?.focus(); }
  }

  // ---- Drawing
  function drawFrame() {
    const fit = Math.max(200, parts.stage.clientWidth - 48);
    scale = Math.min(1, fit / width());
    const bottom = Math.max(0, ...sketch.boxes.map(box => box.y + box.h));
    parts.frame.style.width = `${Math.round(width() * scale)}px`;
    parts.frame.style.height = `${Math.round(Math.max(bottom + 240, width() < 600 ? 844 : 800) * scale)}px`;
    parts.frame.style.backgroundSize = `${GRID * 4 * scale}px ${GRID * 4 * scale}px`;
    const shown = new Map([...parts.frame.querySelectorAll('.sketch-box')].map(item => [item.dataset.id, item]));
    for (const [id, item] of shown) if (!boxBy(id)) item.remove();
    for (const box of sketch.boxes) {
      let item = shown.get(box.id);
      if (!item) {
        item = node('div', 'sketch-box'); item.dataset.id = box.id; item.tabIndex = 0; item.setAttribute('role', 'button');
        const badge = node('span', 'sketch-badge'), kind = node('span', 'sketch-box-kind'), handle = node('span', 'sketch-handle');
        handle.setAttribute('aria-hidden', 'true'); handle.title = 'Drag to resize';
        item.append(badge, kind, handle);
        item.addEventListener('pointerdown', event => startBox(event, boxBy(box.id), event.target === handle ? 'resize' : 'move'));
        item.addEventListener('keydown', event => { const current = boxBy(box.id); if (current) boxKeys(event, current); });
        item.addEventListener('focus', () => { if (selected !== box.id) { selected = box.id; drawList(); markSelected(); } });
        parts.frame.append(item);
      }
      Object.assign(item.style, { left: `${box.x * scale}px`, top: `${box.y * scale}px`, width: `${box.w * scale}px`, height: `${box.h * scale}px` });
      item.querySelector('.sketch-badge').textContent = String(number(box));
      item.querySelector('.sketch-box-kind').textContent = box.kind;
      item.setAttribute('aria-label', `Section ${number(box)}: ${box.kind}, ${box.w} by ${box.h} at x ${box.x}, y ${box.y}`);
    }
    markSelected();
  }
  const markSelected = () => { for (const item of parts.frame.querySelectorAll('.sketch-box')) item.classList.toggle('selected', item.dataset.id === selected); for (const row of parts.list.children) row.classList.toggle('selected', row.dataset.id === selected); };
  function drawList() {
    const list = logic.ordered(sketch.boxes), rows = new Map([...parts.list.children].map(row => [row.dataset.id, row]));
    const keep = [];
    for (const box of list) {
      let row = rows.get(box.id);
      if (!row) {
        row = node('li', 'sketch-row'); row.dataset.id = box.id;
        const badge = node('span', 'sketch-badge'), kind = node('select', 'sketch-row-kind');
        kind.append(...KINDS.map(value => { const option = node('option', '', value); option.value = value; return option; }));
        kind.addEventListener('change', () => { const current = boxBy(box.id); if (current) { current.kind = kind.value; save(); draw(); } });
        const remove = button('', () => removeBox(box.id), 'icon-button sketch-remove');
        const note = node('textarea', 'sketch-note'); note.rows = 2; note.maxLength = 2000; note.placeholder = 'What it shows and how it works';
        note.addEventListener('input', () => { sketch.notes[box.id] = note.value; save(); });
        row.addEventListener('focusin', () => { if (selected !== box.id) { selected = box.id; markSelected(); } });
        row.append(badge, kind, remove, note);
        row.parts = { badge, kind, remove, note };
      }
      const n = number(box);
      row.parts.badge.textContent = String(n);
      row.parts.kind.value = box.kind; row.parts.kind.setAttribute('aria-label', `Section ${n} is a`);
      row.parts.remove.setAttribute('aria-label', `Remove section ${n}`);
      row.parts.note.setAttribute('aria-label', `Note for section ${n}, ${box.kind}`);
      if (document.activeElement !== row.parts.note) row.parts.note.value = sketch.notes[box.id] || '';
      keep.push(row);
    }
    // Rows move only when the order changed, so a note being typed keeps its place and focus.
    if (keep.length !== parts.list.children.length || keep.some((row, index) => parts.list.children[index] !== row)) parts.list.replaceChildren(...keep);
  }
  function draw() {
    if (!dialog || !sketch) return;
    drawFrame(); drawList();
    const count = sketch.boxes.length, full = count >= LIMIT;
    parts.count.textContent = `${count} of ${LIMIT}`;
    parts.empty.hidden = count > 0;
    for (const add of parts.kinds) add.disabled = full;
    parts.send.disabled = parts.plan.disabled = !count;
    parts.clear.disabled = !count && !sketch.overall.trim();
    for (const choice of parts.frames.children) choice.setAttribute('aria-pressed', String(choice.dataset.frame === sketch.frame));
    markSelected();
  }

  // ---- The picture: the boxes on a light page whatever the theme, numbered as in the message.
  function picture() {
    const frame = width(), boxes = logic.ordered(sketch.boxes), ratio = frame < 600 ? 2 : Math.min(1, 1600 / frame);
    const bottom = Math.max(...boxes.map(box => box.y + box.h)), pad = 16;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(frame * ratio + pad * 2); canvas.height = Math.round(Math.min(bottom * ratio + pad * 2, 8000));
    const g = canvas.getContext('2d');
    if (!g) return null;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d9482b';
    g.fillStyle = '#f7f5f1'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.strokeStyle = '#d6d1c8'; g.lineWidth = 1; g.strokeRect(pad - 0.5, pad - 0.5, frame * ratio + 1, bottom * ratio + 1);
    // Larger boxes first, so a box inside another is drawn over it.
    for (const box of [...boxes].sort((a, b) => b.w * b.h - a.w * a.h)) {
      const x = pad + box.x * ratio, y = pad + box.y * ratio, w = box.w * ratio, h = box.h * ratio;
      g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(x, y, w, h);
      g.strokeStyle = '#4a4540'; g.lineWidth = 1.5; g.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
      const size = Math.max(11, Math.min(15, h / 3)), r = Math.max(9, Math.min(12, h / 3));
      g.fillStyle = accent; g.beginPath(); g.arc(x + 6 + r, y + 6 + r, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff'; g.font = `600 ${Math.round(r * 1.1)}px -apple-system, "Segoe UI", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(boxes.indexOf(box) + 1), x + 6 + r, y + 6 + r + 0.5);
      g.fillStyle = '#2b2724'; g.font = `500 ${Math.round(size)}px -apple-system, "Segoe UI", sans-serif`; g.textAlign = 'left';
      if (w > r * 2 + 40) g.fillText(box.kind, x + 12 + r * 2, y + 6 + r + 0.5, w - r * 2 - 20);
    }
    return { name: 'sketch.png', data: canvas.toDataURL('image/png').split(',')[1] };
  }

  // ---- Sending: into the message box, or onto the Plan as a card. The sketch is cleared once it's there.
  async function send(to) {
    if (!sketch.boxes.length) return;
    const image = picture(), text = logic.sketchText({ ...sketch, pictured: Boolean(image) }), images = image ? [image] : [];
    const name = sketch.name.trim();
    dialog.close();
    const done = to === 'plan'
      ? await window.relayPreview?.toPlan?.({ title: `Build the ${name ? `“${name}”` : 'sketched'} page`, text, images, role: 'frontend' })
      : await window.relayPreview?.toMessage?.({ text, images });
    if (done === false || done === undefined) { open(); return; }
    sketch = logic.cleanSketch({ frame: sketch.frame }); selected = null; save();
    api.announce?.(to === 'plan' ? 'Your sketch is on a new card on the Plan. Choose who does it, then add it.' : 'Your sketch is in the message box. Read it, then send.');
  }

  function open() {
    const id = api.getState().projectId;
    if (!id) { api.showNotice('Open a workspace first.'); return false; }
    if (!dialog) build();
    if (projectId !== id) { projectId = id; sketch = load(id); selected = null; }
    parts.name.value = sketch.name; parts.overall.value = sketch.overall;
    if (!dialog.open) dialog.showModal();
    draw();
    (sketch.boxes.length ? parts.frame.querySelector('.sketch-box') : parts.kinds[0])?.focus();
    return true;
  }
  window.relaySketch = { open };
})();

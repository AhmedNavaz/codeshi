const { ipcRenderer } = require('electron');
// The element picker for Point and tell (#19). It runs in the preview page's isolated world: the page's scripts
// cannot see it or call it, and it gives the page nothing. While picking, the element under the pointer is outlined
// and named; a click picks it instead of reaching the page, and Escape stops. The picker reports what the element is,
// where it is on screen for its screenshot, and a one-time mark so the app can ask the page's framework where the
// element is written. Listeners are added before the page's own scripts run, on the window, in the capture phase.
let picking = false, overlay = null, box = null, tag = null, hovered = null;

const clip = (value, max) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? text.slice(0, max - 1) + '…' : text; };
const escape = value => (globalThis.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/[^\w-]/g, character => '\\' + character);
const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };

// The shortest stable way to find the element again: its id, a test id or label, or a short path from the nearest
// element that has one.
function selectorFor(element) {
  if (element.id && unique('#' + escape(element.id))) return '#' + escape(element.id);
  const name = element.tagName.toLowerCase();
  for (const attribute of ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name']) {
    const value = element.getAttribute(attribute);
    if (value && value.length <= 80) { const selector = `${name}[${attribute}="${value.replace(/"/g, '\\"')}"]`; if (unique(selector)) return selector; }
  }
  const parts = [];
  for (let node = element, depth = 0; node && node.nodeType === 1 && node !== document.documentElement && depth < 5; node = node.parentElement, depth++) {
    let part = node.tagName.toLowerCase();
    if (node.id && unique('#' + escape(node.id))) { parts.unshift('#' + escape(node.id)); break; }
    const classes = [...node.classList].filter(name => /^[A-Za-z][\w-]{0,40}$/.test(name)).slice(0, 2);
    if (classes.length) part += '.' + classes.map(escape).join('.');
    const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
    if (unique(parts.join(' > '))) break;
  }
  return parts.join(' > ');
}

// Where an inspector plugin wrote the element's source, when one did: "src/App.tsx:12:5" and the like.
function attributeSource(element) {
  const marked = element.closest('[data-insp-path],[data-v-inspector],[data-inspector-relative-path],[data-source-file]');
  if (!marked) return null;
  const relative = marked.getAttribute('data-inspector-relative-path');
  if (relative) return { file: relative, line: Number(marked.getAttribute('data-inspector-line')) || undefined };
  const file = marked.getAttribute('data-source-file');
  if (file) return { file, line: Number(marked.getAttribute('data-source-line')) || undefined };
  const value = marked.getAttribute('data-insp-path') || marked.getAttribute('data-v-inspector') || '';
  const match = /^(.+?):(\d+)(?::\d+)?(?::[\w-]+)?$/.exec(value);
  return match ? { file: match[1], line: Number(match[2]) } : null;
}

// A section, a card or a form is named by its own heading, not by all the text inside it.
const CONTAINER = 'section, article, aside, header, footer, nav, main, form, div, ul, ol, table, dialog, fieldset';
function textOf(element) {
  if (element.matches('input, textarea, select')) return '';
  const heading = element.matches(CONTAINER) ? element.querySelector('h1, h2, h3, h4, h5, h6, legend, caption') : null;
  return clip((heading || element).innerText || (heading || element).textContent, 120);
}
function describe(element) {
  const label = element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || element.getAttribute('name') || '';
  const text = textOf(element);
  return { tag: element.tagName.toLowerCase(), text, label: clip(label, 120), selector: clip(selectorFor(element), 300), attributeSource: attributeSource(element) };
}

// The outline (in the seal's vermilion) and its name live in a closed shadow root that ignores the pointer, styled through the CSSOM so a
// page's own rules and its content security policy leave them alone.
function ensureOverlay() {
  if (overlay?.isConnected) return;
  overlay = document.createElement('codeshi-picker');
  Object.assign(overlay.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647', display: 'none' });
  const shadow = overlay.attachShadow({ mode: 'closed' });
  box = document.createElement('div'); tag = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', border: '2px solid #d9381e', background: 'rgba(217, 56, 30, 0.12)', borderRadius: '3px', boxSizing: 'border-box', transition: 'all 60ms ease-out' });
  Object.assign(tag.style, { position: 'fixed', padding: '3px 7px', borderRadius: '5px', background: '#1c1a18', color: '#f4ede1', font: '12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,.3)' });
  shadow.append(box, tag);
  (document.documentElement || document).appendChild(overlay);
}
function outline(element) {
  hovered = element;
  if (!element) { if (overlay) overlay.style.display = 'none'; return; }
  ensureOverlay();
  const rect = element.getBoundingClientRect();
  overlay.style.display = 'block';
  Object.assign(box.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  const info = describe(element), name = info.text || info.label;
  tag.textContent = `${info.tag}${name ? ` · ${clip(name, 40)}` : ''} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  const above = rect.top - 26;
  Object.assign(tag.style, { left: Math.max(4, Math.min(rect.left, innerWidth - 300)) + 'px', top: (above >= 4 ? above : Math.min(innerHeight - 26, rect.bottom + 4)) + 'px' });
}
const target = event => { const element = document.elementFromPoint(event.clientX, event.clientY); return element && element !== overlay && element !== layer ? element : null; };
function stop(reported = true) { picking = false; outline(null); if (reported) ipcRenderer.send('preview:pick-cancelled'); }
function swallow(event) { if (!picking && !designing) return; if (designing) designEvent(event); event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); }
const nonceFor = element => {
  const nonce = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  element.setAttribute('data-codeshi-pick', nonce);
  // The mark is for one question from the app; it goes even if the question never comes.
  setTimeout(() => { if (element.getAttribute('data-codeshi-pick') === nonce) element.removeAttribute('data-codeshi-pick'); }, 3000);
  return nonce;
};

// Design notes (#125). While marking, a click marks the element under the pointer as a section, and a drag marks the
// box drawn, as an area inside the smallest element that holds it. Each section shows as a numbered box that follows
// its element as the page scrolls and changes; the app sends the numbers and selectors, nothing else. The page is told
// nothing, and the boxes live in a closed shadow root that ignores the pointer, like the picker's outline.
let designing = false, sections = [], layer = null, layerRoot = null, band = null, drag = null, frame = 0, watcher = null, reported = '';
const DRAG = 6;
function ensureLayer() {
  if (layer?.isConnected) return;
  layer = document.createElement('codeshi-design');
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483646' });
  layerRoot = layer.attachShadow({ mode: 'closed' });
  (document.documentElement || document).appendChild(layer);
}
function find(section) {
  let element = null;
  try { element = section.selector ? document.querySelector(section.selector) : null; } catch { element = null; }
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return section.offset ? { left: rect.left + section.offset.x, top: rect.top + section.offset.y, width: section.offset.width, height: section.offset.height } : { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
function draw() {
  frame = 0;
  if (!sections.length && !band) { layer?.remove(); layer = null; report([], []); return; }
  ensureLayer();
  const items = [], missing = [], offscreen = [];
  for (const section of sections) {
    const rect = find(section);
    if (!rect) { missing.push(section.id); continue; }
    if (rect.top < 0 || rect.left < 0 || rect.top + rect.height > innerHeight || rect.left + rect.width > innerWidth) offscreen.push(section.id);
    const box = document.createElement('div'), badge = document.createElement('div');
    Object.assign(box.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', boxSizing: 'border-box', border: '2px solid #d9381e', borderRadius: '3px', background: 'rgba(217, 56, 30, 0.07)' });
    Object.assign(badge.style, { position: 'fixed', left: Math.max(2, Math.min(rect.left - 9, innerWidth - 24)) + 'px', top: Math.max(2, Math.min(rect.top - 9, innerHeight - 24)) + 'px', minWidth: '22px', height: '22px', padding: '0 6px', boxSizing: 'border-box', borderRadius: '11px', background: '#d9381e', color: '#ffffff', font: '600 12px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,.35)' });
    badge.textContent = String(section.n);
    items.push(box, badge);
  }
  if (band) items.push(band);
  layerRoot.replaceChildren(...items);
  report(missing, offscreen);
}
function report(missing, offscreen) {
  const value = JSON.stringify([missing, offscreen]);
  if (value === reported) return;
  reported = value;
  ipcRenderer.send('preview:design-layout', { missing, offscreen });
}
const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };
// The boxes follow the page's own changes, such as a hot reload, but only while there are boxes to draw.
function watch() {
  if (sections.length && !watcher && document.documentElement) { watcher = new MutationObserver(redraw); watcher.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); }
  else if (!sections.length && watcher) { watcher.disconnect(); watcher = null; }
}
// The smallest element that holds the whole box drawn.
function holder(rect) {
  let element = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  for (; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
    const around = element.getBoundingClientRect();
    if (around.left <= rect.x + 1 && around.top <= rect.y + 1 && around.right >= rect.x + rect.width - 1 && around.bottom >= rect.y + rect.height - 1) break;
  }
  return element || document.body;
}
function mark(element, rect, offset) {
  ipcRenderer.send('preview:design-mark', { nonce: nonceFor(element), element: describe(element), rect, offset, viewport: { width: innerWidth, height: innerHeight } });
}
// Pointer events, because cancelling pointerdown (as both modes do, so the page never sees it) also stops the mouse
// events that would follow it.
function designEvent(event) {
  if (event.type === 'pointerdown' && event.button === 0) { drag = { x: event.clientX, y: event.clientY, moved: false }; return; }
  if (event.type !== 'pointerup' || !drag) return;
  const start = drag; drag = null;
  if (start.moved && band) {
    const rect = { x: parseFloat(band.style.left), y: parseFloat(band.style.top), width: parseFloat(band.style.width), height: parseFloat(band.style.height) };
    band = null; draw();
    const element = holder(rect), around = element.getBoundingClientRect();
    mark(element, rect, { x: rect.x - around.left, y: rect.y - around.top, width: rect.width, height: rect.height });
    return;
  }
  const element = target(event) || hovered;
  outline(null);
  if (!element) return;
  const rect = element.getBoundingClientRect();
  mark(element, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, null);
}
function dragTo(event) {
  if (!drag) return false;
  const width = Math.abs(event.clientX - drag.x), height = Math.abs(event.clientY - drag.y);
  if (!drag.moved && width < DRAG && height < DRAG) return false;
  drag.moved = true; outline(null);
  if (!band) { band = document.createElement('div'); Object.assign(band.style, { position: 'fixed', boxSizing: 'border-box', border: '2px dashed #d9381e', borderRadius: '3px', background: 'rgba(217, 56, 30, 0.10)' }); }
  Object.assign(band.style, { left: Math.min(event.clientX, drag.x) + 'px', top: Math.min(event.clientY, drag.y) + 'px', width: width + 'px', height: height + 'px' });
  draw();
  return true;
}
function stopDesigning(reported = true) {
  designing = false; drag = null; outline(null);
  if (band) { band = null; draw(); }
  if (reported) ipcRenderer.send('preview:design-stop');
}

window.addEventListener('mousemove', event => { if (picking && !designing) outline(target(event)); }, true);
window.addEventListener('pointermove', event => { if (designing && !dragTo(event)) outline(target(event)); }, true);
for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu', 'submit']) window.addEventListener(type, swallow, true);
window.addEventListener('click', event => {
  if (designing) { swallow(event); return; }
  if (!picking) return;
  swallow(event);
  const element = target(event) || hovered;
  if (!element) return;
  const nonce = nonceFor(element);
  const rect = element.getBoundingClientRect(), info = describe(element);
  picking = false; outline(null);
  ipcRenderer.send('preview:picked', { nonce, element: info, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, viewport: { width: innerWidth, height: innerHeight } });
}, true);
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (designing) { swallow(event); stopDesigning(); } else if (picking) { swallow(event); stop(); }
}, true);
window.addEventListener('scroll', () => { if ((picking || designing) && hovered) outline(hovered); if (sections.length) redraw(); }, true);
window.addEventListener('resize', () => { if (sections.length) redraw(); });
ipcRenderer.on('preview:picking', (_event, on) => { if (on) { picking = true; } else stop(false); });
ipcRenderer.on('preview:design', (_event, value) => {
  sections = (Array.isArray(value?.sections) ? value.sections : []).slice(0, 50).map(section => ({ id: String(section.id), n: Number(section.n) || 0, selector: typeof section.selector === 'string' ? section.selector : '', offset: section.offset || null }));
  if (value?.marking) { designing = true; if (picking) stop(false); } else if (designing) stopDesigning(false);
  watch(); draw();
});
window.addEventListener("message", event => { if (event.data?.type === "codeshi:api-call" && event.data.call) ipcRenderer.send("preview:api-call", event.data.call); });

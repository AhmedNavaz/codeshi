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

function describe(element) {
  const label = element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || element.getAttribute('name') || '';
  const text = element.matches('input, textarea, select') ? '' : clip(element.innerText || element.textContent, 120);
  return { tag: element.tagName.toLowerCase(), text, label: clip(label, 120), selector: clip(selectorFor(element), 300), attributeSource: attributeSource(element) };
}

// The outline and its name live in a closed shadow root that ignores the pointer, styled through the CSSOM so a
// page's own rules and its content security policy leave them alone.
function ensureOverlay() {
  if (overlay?.isConnected) return;
  overlay = document.createElement('codeshi-picker');
  Object.assign(overlay.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647', display: 'none' });
  const shadow = overlay.attachShadow({ mode: 'closed' });
  box = document.createElement('div'); tag = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', border: '2px solid #3b8eea', background: 'rgba(59, 142, 234, 0.12)', borderRadius: '3px', boxSizing: 'border-box', transition: 'all 60ms ease-out' });
  Object.assign(tag.style, { position: 'fixed', padding: '3px 7px', borderRadius: '5px', background: '#1f1f1f', color: '#ffffff', font: '12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,.3)' });
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
const target = event => { const element = document.elementFromPoint(event.clientX, event.clientY); return element && element !== overlay ? element : null; };
function stop(reported = true) { picking = false; outline(null); if (reported) ipcRenderer.send('preview:pick-cancelled'); }
function swallow(event) { if (!picking) return; event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); }

window.addEventListener('mousemove', event => { if (picking) outline(target(event)); }, true);
for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu', 'submit']) window.addEventListener(type, swallow, true);
window.addEventListener('click', event => {
  if (!picking) return;
  swallow(event);
  const element = target(event) || hovered;
  if (!element) return;
  const nonce = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  element.setAttribute('data-codeshi-pick', nonce);
  // The mark is for one question from the app; it goes even if the question never comes.
  setTimeout(() => { if (element.getAttribute('data-codeshi-pick') === nonce) element.removeAttribute('data-codeshi-pick'); }, 3000);
  const rect = element.getBoundingClientRect(), info = describe(element);
  picking = false; outline(null);
  ipcRenderer.send('preview:picked', { nonce, element: info, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, viewport: { width: innerWidth, height: innerHeight } });
}, true);
window.addEventListener('keydown', event => { if (picking && event.key === 'Escape') { swallow(event); stop(); } }, true);
window.addEventListener('scroll', () => { if (picking && hovered) outline(hovered); }, true);
ipcRenderer.on('preview:picking', (_event, on) => { if (on) { picking = true; } else stop(false); });

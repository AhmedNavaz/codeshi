import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Keyboard behaviour for menus, popover dialogs and the file tree (#26), run against a minimal page. It checks focus
// and attributes, not what a real screen reader announces; that needs VoiceOver on a Mac.
const source = fs.readFileSync(new URL('../public/keyboard.js', import.meta.url), 'utf8');

function page() {
  const document = { readyState: 'complete', activeElement: null };
  class Element {
    constructor(tag, attributes = {}) { this.tagName = tag.toUpperCase(); this.attributes = { ...attributes }; this.children = []; this.parentNode = null; this.hidden = false; this.disabled = false; this.dataset = {}; this.listeners = {}; this.clicks = 0; this.text = ''; this.popoverOpen = false; this.tabIndex = attributes.tabindex !== undefined ? Number(attributes.tabindex) : 0; }
    get isConnected() { for (let at = this; at; at = at.parentNode) if (at === document.body) return true; return false; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    append(...nodes) { for (const child of nodes) { child.parentNode = this; this.children.push(child); } return this; }
    getAttribute(name) { return name in this.attributes ? String(this.attributes[name]) : null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    hasAttribute(name) { return name in this.attributes; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatch(type, props = {}) { const event = { type, target: props.target || this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props }; for (let at = event.target; at; at = at.parentNode) for (const fn of at.listeners[type] || []) fn(event); return event; }
    focus() { document.activeElement = this; }
    click() { this.clicks++; for (const fn of this.listeners.click || []) fn({ target: this }); }
    contains(node) { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false; }
    matches(selector) {
      if (selector === ':popover-open') return this.popoverOpen;
      return selector.split(',').some(part => [...part.trim().matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)].every(([, name, op, value]) => {
        const actual = name === 'hidden' ? (this.hidden ? '' : null) : this.getAttribute(name);
        return actual !== null && (!op || (op === '=' ? actual === value : actual.startsWith(value)));
      }));
    }
    closest(selector) { for (let at = this; at; at = at.parentNode) if (at.matches?.(selector)) return at; return null; }
    querySelectorAll(selector) { const found = []; for (const child of this.children) { if (child.matches(selector)) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    hidePopover() { if (!this.popoverOpen) return; this.popoverOpen = false; this.dispatch('toggle', { newState: 'closed' }); }
    showPopover() { this.dispatch('beforetoggle', { newState: 'open' }); this.popoverOpen = true; this.dispatch('toggle', { newState: 'open' }); }
  }
  document.body = new Element('body');
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const element = (tag, attributes, text = '') => { const node = new Element(tag, attributes); node.text = text; return node; };
  const window = {};
  vm.runInNewContext(source, { window, document, MutationObserver: undefined });
  const key = (target, name, extra = {}) => target.dispatch('keydown', { key: name, target, ...extra });
  return { window, document, element, key, keyboard: window.codeshiKeyboard };
}

test('arrow keys, Home and End wrap within a list, and a letter finds the next match', () => {
  const { keyboard } = page();
  assert.deepEqual(['ArrowDown', 'ArrowDown', 'ArrowUp', 'Home', 'End'].map(key => keyboard.step(key, 2, 3)), [0, 0, 1, 0, 2]);
  assert.equal(keyboard.step('ArrowDown', -1, 3), 0, 'Down from nothing starts at the top.');
  assert.equal(keyboard.step('ArrowUp', -1, 3), 2, 'Up from nothing starts at the bottom.');
  assert.equal(keyboard.step('ArrowDown', 0, 0), -1);
  assert.equal(keyboard.typeAhead(['Review', 'Ask', 'Export', 'Edit'], 0, 'e'), 2);
  assert.equal(keyboard.typeAhead(['Review', 'Ask', 'Export', 'Edit'], 2, 'E'), 3, 'Letters ignore case and move past the current item.');
  assert.equal(keyboard.typeAhead(['Review', 'Ask'], 0, 'z'), -1);
});

test('a popover menu takes focus, moves with the arrow keys and returns focus to its button', () => {
  const { document, element, key, keyboard } = page();
  const opener = element('button'), menu = element('div', { popover: 'auto', role: 'menu' });
  const items = ['Review changes…', 'Ask a friend…', 'Previous chats…'].map(text => element('button', { role: 'menuitem' }, text));
  items[1].disabled = true;
  menu.append(...items); document.body.append(opener, menu);
  keyboard.wire();
  assert.equal(menu.dataset.keyboard, 'menu');

  opener.focus(); menu.showPopover();
  assert.equal(document.activeElement, items[0], 'The first item takes focus.');
  assert.deepEqual(items.map(item => item.tabIndex), [-1, -1, -1], 'Items move with the arrow keys, not Tab.');
  assert.equal(key(items[0], 'ArrowDown').defaultPrevented, true);
  assert.equal(document.activeElement, items[2], 'A disabled item is skipped.');
  key(items[2], 'ArrowDown'); assert.equal(document.activeElement, items[0], 'Down wraps to the top.');
  key(items[0], 'End'); assert.equal(document.activeElement, items[2]);
  key(items[2], 'r'); assert.equal(document.activeElement, items[0], 'A letter jumps to the next item starting with it.');

  menu.hidePopover();
  assert.equal(document.activeElement, opener, 'Closing with focus inside returns it to the button.');

  menu.showPopover(); key(document.activeElement, 'Tab');
  assert.equal(menu.popoverOpen, false, 'Tab closes the menu.');
  assert.equal(document.activeElement, opener, 'Tab carries on from the menu’s button.');
});

test('a menu with a chosen item opens on it', () => {
  const { document, element, keyboard } = page();
  const menu = element('div', { popover: 'auto', role: 'menu' });
  const items = [element('button', { role: 'menuitemradio', 'aria-checked': 'false' }, 'Dictation'), element('button', { role: 'menuitemradio', 'aria-checked': 'true' }, 'Conversation')];
  menu.append(...items); document.body.append(menu); keyboard.menu(menu);
  menu.showPopover();
  assert.equal(document.activeElement, items[1]);
});

test('a popover dialog takes focus so its title is read, and gives it back when it closes', () => {
  const { document, element, keyboard } = page();
  const opener = element('button'), popover = element('div', { popover: 'auto', role: 'dialog' }), close = element('button', {}, 'Close');
  popover.append(close); document.body.append(opener, popover); keyboard.wire();
  assert.equal(popover.tabIndex, -1, 'The dialog can take focus without joining the Tab order.');
  opener.focus(); popover.showPopover();
  assert.equal(document.activeElement, popover);
  close.focus(); popover.hidePopover();
  assert.equal(document.activeElement, opener);

  // A popover that moves focus inside itself as it opens, like the model picker's search, keeps it.
  const search = element('input'); popover.append(search);
  opener.focus(); popover.dispatch('beforetoggle', { newState: 'open' }); search.focus(); popover.popoverOpen = true; popover.dispatch('toggle', { newState: 'open' });
  assert.equal(document.activeElement, search);
  popover.hidePopover();
  assert.equal(document.activeElement, opener);

  // Focus that has moved elsewhere when it closes, such as to the message box after choosing a model, stays there.
  const elsewhere = element('textarea'); document.body.append(elsewhere);
  opener.focus(); popover.showPopover(); elsewhere.focus(); popover.hidePopover();
  assert.equal(document.activeElement, elsewhere);
});

test('the file tree keeps one row in the Tab order and moves by level with the arrow keys', () => {
  const { document, element, key, keyboard } = page();
  const tree = element('div', { role: 'tree' }), row = (level, text, expanded) => { const node = element('button', { role: 'treeitem', 'aria-level': level, ...(expanded ? { 'aria-expanded': expanded } : {}) }, text); return node; };
  const root = row(1, 'ws', 'true'), rootGroup = element('div', { role: 'group' });
  const src = row(2, 'src', 'true'), srcGroup = element('div', { role: 'group' }), a = row(3, 'a.js'), lib = row(3, 'lib', 'false'), libGroup = element('div', { role: 'group' });
  const readme = row(2, 'README.md');
  libGroup.hidden = true; libGroup.append(row(4, 'b.txt'));
  srcGroup.append(a, lib, libGroup); rootGroup.append(src, srcGroup, readme); tree.append(root, rootGroup);
  document.body.append(tree); keyboard.wire();
  assert.equal(tree.dataset.keyboard, 'tree');

  root.focus(); tree.dispatch('focusin', { target: root });
  const stops = () => tree.querySelectorAll('[role="treeitem"]').filter(node => node.tabIndex === 0);
  assert.deepEqual(stops(), [root], 'Only the focused row is in the Tab order.');
  key(root, 'ArrowDown'); assert.equal(document.activeElement, src);
  assert.deepEqual(stops(), [src]);
  key(src, 'End'); assert.equal(document.activeElement, readme, 'End skips rows inside a closed folder.');
  key(readme, 'Home'); assert.equal(document.activeElement, root);
  key(root, 'ArrowRight'); assert.equal(document.activeElement, src, 'Right on an open folder moves into it.');
  key(src, 'ArrowDown'); key(a, 'ArrowDown'); assert.equal(document.activeElement, lib);
  key(lib, 'ArrowRight'); assert.equal(lib.clicks, 1, 'Right on a closed folder opens it the way a click does.');
  key(lib, 'ArrowLeft'); assert.equal(document.activeElement, src, 'Left on a closed folder moves to its parent.');
  key(src, 'ArrowLeft'); assert.equal(src.clicks, 1, 'Left on an open folder closes it.');
  key(src, 'r'); assert.equal(document.activeElement, readme, 'A letter jumps to the next row starting with it.');
});

test('the page loads the keyboard script first and marks the file tree and command bar for screen readers', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script src="\/([\w-]+)\.js" defer>/g)].map(match => match[1]);
  // The interface language comes first (#27), so every script after it can translate what it draws.
  assert.deepEqual(scripts.slice(0, 3), ['i18n', 'locale', 'keyboard'], 'The keyboard script loads before the scripts whose menus and popovers it wires.');
  assert.match(html, /id="file-tree" class="file-tree" role="tree"/);
  assert.match(html, /<input id="workspace-search" type="search" role="combobox"[^>]*aria-expanded="false"/, 'The search box itself is the combobox.');
  assert.doesNotMatch(html, /class="command-bar" role=/);
  const files = fs.readFileSync(new URL('../public/files.js', import.meta.url), 'utf8');
  assert.match(files, /setAttribute\('role','treeitem'\)/);
  assert.match(files, /setAttribute\('role','group'\)/);
});

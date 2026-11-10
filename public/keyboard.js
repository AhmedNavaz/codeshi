'use strict';
// Keyboard and screen reader behaviour shared by the page's menus, popovers and the file tree (#26). It loads before the
// other page scripts and wires the menus and popovers already in the page; the file tree's rows are marked by files.js.
(() => {
  const focusable = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const shown = element => !element.hidden && !element.closest?.('[hidden]') && (element.checkVisibility ? element.checkVisibility() : true);
  const isOpen = element => { try { return element.matches(':popover-open'); } catch { return !element.hidden; } };

  // Where an arrow key moves within a list of `count` items, from `index` (-1 for none yet). Wraps at both ends.
  function step(key, index, count) {
    if (!count) return -1;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
    if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
    return index;
  }
  // The next item whose label starts with the typed letter, after the current one.
  function typeAhead(labels, index, letter) {
    const wanted = String(letter || '').toLowerCase();
    if (!wanted || wanted.length !== 1 || !labels.length) return -1;
    for (let offset = 1; offset <= labels.length; offset++) {
      const at = (index + offset) % labels.length;
      if (String(labels[at] || '').trim().toLowerCase().startsWith(wanted)) return at;
    }
    return -1;
  }
  const label = element => element.getAttribute('aria-label') || element.textContent || '';

  // A popover menu (role="menu"): the first item takes focus when it opens, the arrow keys, Home, End and a letter move
  // between items, and Tab closes it. Escape closes it as any popover does, and focus goes back to its button.
  function menu(element) {
    if (!element || element.dataset.keyboard) return;
    element.dataset.keyboard = 'menu';
    let opener = null;
    const items = () => [...element.querySelectorAll('[role^="menuitem"]')].filter(item => !item.disabled && shown(item));
    element.addEventListener('toggle', event => {
      if ((event.newState || (isOpen(element) ? 'open' : 'closed')) === 'open') {
        opener = element.contains(document.activeElement) ? opener : document.activeElement;
        for (const item of element.querySelectorAll('[role^="menuitem"]')) item.tabIndex = -1;
        if (!element.contains(document.activeElement)) { const list = items(), checked = list.find(item => item.getAttribute('aria-checked') === 'true'); (checked || list[0])?.focus(); }
      } else restore(element, opener);
    });
    element.addEventListener('keydown', event => {
      const list = items(), index = list.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); list[step(event.key, index, list.length)]?.focus(); return; }
      // Tab closes the menu and carries on from its button, to the control after it.
      if (event.key === 'Tab') { const from = opener; element.hidePopover?.(); if (from?.isConnected && shown(from)) from.focus(); return; }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { const at = typeAhead(list.map(label), index, event.key); if (at >= 0) { event.preventDefault(); list[at].focus(); } }
    });
  }

  // Focus goes back to what opened a popover when it closes with focus inside it, or with focus nowhere.
  function restore(element, opener) {
    const active = document.activeElement;
    if (!opener || !opener.isConnected || !shown(opener)) return;
    if (!active || active === document.body || element.contains(active)) opener.focus?.();
  }

  // A popover dialog (role="dialog" with the popover attribute), such as Plan usage or Software update. When it opens,
  // the dialog itself takes focus unless something inside already has it, so a screen reader reads its title and Tab
  // continues inside it. Tab wraps around inside it while it is open, and closing it returns focus to its opener.
  function dialog(element) {
    if (!element || element.dataset.keyboard) return;
    element.dataset.keyboard = 'dialog';
    if (!element.hasAttribute('tabindex')) element.tabIndex = -1;
    let opener = null;
    element.addEventListener('toggle', event => {
      if ((event.newState || (isOpen(element) ? 'open' : 'closed')) === 'open') {
        if (!element.contains(document.activeElement)) { opener = document.activeElement; element.focus({ preventScroll: true }); }
      } else { restore(element, opener); opener = null; }
    });
    // Openers that move focus in themselves (the model picker focuses its search) are remembered from the event.
    element.addEventListener('beforetoggle', event => { if (event.newState === 'open' && !element.contains(document.activeElement)) opener = document.activeElement; });
    element.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const list = [...element.querySelectorAll(focusable)].filter(shown);
      if (!list.length) { event.preventDefault(); return; }
      const first = list[0], last = list.at(-1), active = document.activeElement;
      if (event.shiftKey && (active === first || active === element)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    });
  }

  // A tree (role="tree") of rows marked role="treeitem", with aria-level and, for folders, aria-expanded. One row is in
  // the Tab order at a time. Up and Down move between visible rows, Home and End to the ends, Right opens a folder or
  // moves into it, Left closes it or moves to its parent, and a letter jumps to the next row starting with it. Opening
  // and closing are left to the row's own click, so a folder still loads its contents the way it does with a mouse.
  function tree(element) {
    if (!element || element.dataset.keyboard) return;
    element.dataset.keyboard = 'tree';
    const rows = () => [...element.querySelectorAll('[role="treeitem"]')].filter(row => !row.closest('[hidden]') || !element.contains(row.closest('[hidden]')));
    const level = row => Number(row.getAttribute('aria-level')) || 1;
    function settle(target) {
      const list = rows(); if (!list.length) return;
      const current = target && list.includes(target) ? target : list.find(row => row.tabIndex === 0) || list.find(row => row.getAttribute('aria-selected') === 'true') || list[0];
      for (const row of element.querySelectorAll('[role="treeitem"]')) row.tabIndex = row === current ? 0 : -1;
    }
    const move = row => { if (!row) return; settle(row); row.focus(); };
    element.addEventListener('focusin', event => { const row = event.target.closest?.('[role="treeitem"]'); if (row && element.contains(row)) settle(row); });
    element.addEventListener('keydown', event => {
      const row = event.target.closest?.('[role="treeitem"]'); if (!row || event.metaKey || event.ctrlKey || event.altKey) return;
      const list = rows(), index = list.indexOf(row), expanded = row.getAttribute('aria-expanded');
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); move(list[step(event.key, index, list.length)]); return; }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (expanded === 'false') row.click();
        else if (expanded === 'true') { const next = list[index + 1]; if (next && level(next) > level(row)) move(next); }
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (expanded === 'true') { row.click(); return; }
        for (let at = index - 1; at >= 0; at--) if (level(list[at]) < level(row)) { move(list[at]); return; }
        return;
      }
      if (event.key.length === 1 && event.key !== ' ') { const at = typeAhead(list.map(item => item.querySelector('.tree-label')?.textContent || label(item)), index, event.key); if (at >= 0) { event.preventDefault(); move(list[at]); } }
    });
    // Rows arrive as folders load; keep exactly one of them in the Tab order.
    if (typeof MutationObserver === 'function') new MutationObserver(() => settle(element.contains(document.activeElement) ? document.activeElement.closest?.('[role="treeitem"]') : null)).observe(element, { childList: true, subtree: true });
  }

  function wire(root = document) {
    for (const element of root.querySelectorAll('[popover][role="menu"]')) menu(element);
    for (const element of root.querySelectorAll('[popover][role="dialog"]')) dialog(element);
    for (const element of root.querySelectorAll('[role="tree"]')) tree(element);
  }
  window.codeshiKeyboard = { step, typeAhead, menu, dialog, tree, wire };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => wire()); else wire();
})();

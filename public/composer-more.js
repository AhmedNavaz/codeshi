// A narrow message box, such as the chat beside the Plan (#162): GitHub, Review after, Access and Permissions move into
// More, each shown with its name, so the row keeps Attach, the model, effort, the microphone and Send on one line instead of
// a row of bare icons. They are the same controls moved, not copies, so everything that sets or reads them still works.
// A wider box puts them back where they were.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const composer = $('composer'), more = $('composer-more'), menu = $('composer-more-menu');
  if (!composer || !more || !menu || typeof ResizeObserver !== 'function') return;
  // Below this width the full row no longer fits beside Send.
  const NARROW = 560;
  const homes = [$('github-context-open'), $('automatic-review-toggle'), composer.querySelector('.composer-controls .mode-control'), $('approval-control')]
    .filter(Boolean).map(item => { const marker = document.createComment(''); item.before(marker); return { item, marker }; });
  let folded = false;
  function fold(narrow) {
    if (narrow === folded) return;
    folded = narrow;
    if (!narrow && menu.matches?.(':popover-open')) menu.hidePopover();
    for (const { item, marker } of homes) { if (narrow) menu.append(item); else marker.after(item); }
    more.hidden = !narrow;
  }
  new ResizeObserver(entries => { const width = entries.at(-1)?.contentRect.width; if (width) fold(width < NARROW); }).observe(composer);
  // A choice closes the menu: a button opens its own dialog, and a picker has changed.
  menu.addEventListener('click', event => { if (event.target?.closest?.('button')) menu.hidePopover(); });
  menu.addEventListener('change', () => menu.hidePopover());
  menu.addEventListener('toggle', event => more.setAttribute('aria-expanded', String(event.newState === 'open')));
})();

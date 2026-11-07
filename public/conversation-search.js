(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI;
  const bar = $('conversation-search'), input = $('conversation-search-input'), count = $('conversation-search-count'), messages = $('messages'), scroller = $('messages-scroll');
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  // Author names, times, code language labels, activity summaries, buttons and the run's status and actions are interface text, not conversation text.
  const skipped = node => ['BUTTON', 'SUMMARY'].includes(node.tagName) || ['message-heading', 'message-actions', 'code-head', 'transcript-footer'].some(name => node.classList.contains(name));
  // Text inside these elements continues the surrounding text, so a match can cross formatting and syntax colors but not two paragraphs.
  const inline = new Set(['A', 'ABBR', 'B', 'CODE', 'DEL', 'EM', 'I', 'KBD', 'MARK', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U']);
  // Highlights paint over the rendered text, so the message elements stay as app.js built them.
  const supported = typeof Highlight === 'function' && typeof CSS !== 'undefined' && Boolean(CSS.highlights);
  const all = supported ? new Highlight() : null, active = supported ? new Highlight() : null;
  if (active) active.priority = 1;
  // The text walk is the slow part, so it is kept between keystrokes until the messages are rebuilt.
  let matches = [], current = -1, signature = null, conversation = null, text = null;

  function runs() {
    const found = [];
    let run = null;
    const visit = parent => {
      for (const node of parent.childNodes) {
        if (node.nodeType === 3) { if (!run) found.push(run = { nodes: [], text: '' }); run.nodes.push({ node, start: run.text.length }); run.text += node.data; continue; }
        if (node.nodeType !== 1) continue;
        const skip = skipped(node), separate = skip || !inline.has(node.tagName);
        if (separate) run = null;
        if (!skip) visit(node);
        if (separate) run = null;
      }
    };
    visit(messages);
    return found;
  }
  function search(query) {
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), found = [];
    const state = api?.getState?.();
    if (state && state.messagesSignature !== signature) {
      signature = state.messagesSignature;
      text = null;
    }
    text ||= runs();
    for (const run of text) {
      // Matches come in order, so one pass over the run's text nodes maps every match to its start and end nodes.
      let index = 0;
      const point = (offset, end) => {
        while (index < run.nodes.length - 1 && (end ? run.nodes[index].start + run.nodes[index].node.data.length < offset : run.nodes[index + 1].start <= offset)) index++;
        return [run.nodes[index].node, offset - run.nodes[index].start];
      };
      for (const match of run.text.matchAll(pattern)) { const range = document.createRange(); range.setStart(...point(match.index)); range.setEnd(...point(match.index + match[0].length, true)); found.push(range); }
    }
    return found;
  }
  // Text in a collapsed activity group is not rendered, so the group's summary stands in for its position.
  const collapsed = range => { const group = range.startContainer.parentNode.closest('details'); return group && !group.open ? group : null; };
  const box = range => (collapsed(range) || range).getBoundingClientRect();
  // The first match in view or below it, otherwise the closest one above. Matches run down the page in order,
  // so a binary search measures a few of them rather than every match above the view.
  function nearest() {
    const top = scroller.getBoundingClientRect().top;
    let low = 0, high = matches.length;
    while (low < high) { const middle = (low + high) >> 1; if (box(matches[middle]).bottom >= top) high = middle; else low = middle + 1; }
    return Math.min(low, matches.length - 1);
  }
  function show(index, scroll = true) {
    current = index;
    if (active) { active.clear(); if (matches[current]) active.add(matches[current]); }
    count.textContent = matches.length ? `${current + 1} of ${matches.length}` : input.value.trim() ? 'No results' : '';
    $('conversation-search-previous').disabled = $('conversation-search-next').disabled = !matches.length;
    const range = matches[current];
    if (!scroll || !range) return;
    const group = collapsed(range);
    if (group) group.open = true;
    let ancestor = range.startContainer.parentNode;
    while (ancestor && ancestor !== messages) {
      if (ancestor.tagName === 'DETAILS' && !ancestor.open) ancestor.open = true;
      if (ancestor.classList?.contains('activity-output') && ancestor.hidden) {
        ancestor.hidden = false;
        const toggle = ancestor.parentElement?.querySelector('.activity-output-toggle');
        if (toggle) { toggle.title = 'Hide details'; toggle.setAttribute('aria-expanded', 'true'); }
        ancestor.parentElement?.classList.add('open');
      }
      ancestor = ancestor.parentNode;
    }
    let shownAt = null;
    const reveal = () => {
      const view = scroller.getBoundingClientRect(), rect = range.getBoundingClientRect();
      if (rect.top !== shownAt && (rect.top < view.top || rect.bottom > view.bottom)) scroller.scrollTop += rect.top - view.top - (view.height - rect.height) / 2;
      shownAt = rect.top;
    };
    reveal();
    // Turns out of view have only an estimated height, so the match can move once they are drawn.
    let frames = 6;
    const settle = () => { if (frames-- <= 0 || matches[current] !== range) return; reveal(); requestAnimationFrame(settle); };
    requestAnimationFrame(settle);
  }
  let searchGeneration = 0;
  let searchingUnloaded = false;
  let lastUnloadedQuery = null;
  async function checkUnloadedSearch(query, generation) {
    if (!query || !api?.getState || searchingUnloaded || lastUnloadedQuery === query) return;
    const state = api.getState();
    if (!state.conversation?.earlier) return;
    lastUnloadedQuery = query;
    searchingUnloaded = true;
    const task = state.taskId;
    const queryParams = `q=${encodeURIComponent(query)}${task ? `&task=${encodeURIComponent(task)}` : ""}`;
    try {
      const res = await api.api(`/api/conversation/search?${queryParams}`, {}, state.projectId);
      if (generation !== searchGeneration) return;
      if (res?.matches?.length) {
        if (!matches.length && api.loadToMessage) {
          const target = res.matches.at(-1);
          await api.loadToMessage(target.id);
          if (generation === searchGeneration) {
            text = null;
            find(false);
          }
        }
      }
    } catch {
      // Ignore background search errors
    } finally {
      searchingUnloaded = false;
    }
  }

  function find(keep = false) {
    const previous = current;
    const query = input.value.trim();
    if (query !== lastUnloadedQuery) lastUnloadedQuery = null;
    const state = api?.getState?.();
    if (state && state.messagesSignature !== signature) {
      signature = state.messagesSignature;
      text = null;
    }
    matches = query ? search(query) : [];
    if (all) { all.clear(); for (const range of matches) all.add(range); }
    // A re-render keeps the current match and the scroll position; a new query starts from what is in view.
    if (keep && previous >= 0) show(Math.min(previous, matches.length - 1), false);
    else show(matches.length ? nearest() : -1, !keep);
    if (query && !matches.length && state?.conversation?.earlier && !searchingUnloaded) {
      const gen = ++searchGeneration;
      checkUnloadedSearch(query, gen);
    }
  }
  async function move(step) {
    if (!matches.length) return;
    if (step === -1 && current === 0 && api?.getState?.()?.conversation?.earlier) {
      const gen = ++searchGeneration;
      const state = api.getState();
      const task = state.taskId;
      const queryParams = `q=${encodeURIComponent(input.value.trim())}${task ? `&task=${encodeURIComponent(task)}` : ""}`;
      try {
        const res = await api.api(`/api/conversation/search?${queryParams}`, {}, state.projectId);
        if (gen !== searchGeneration) return;
        const firstLoaded = state.conversation.messages?.[0];
        const earlierMatches = res?.matches?.filter(m => !firstLoaded || m.index < state.conversation.earlier);
        if (earlierMatches?.length && api.loadToMessage) {
          await api.loadToMessage(earlierMatches.at(-1).id);
          if (gen === searchGeneration) {
            text = null;
            find(false);
            return;
          }
        }
      } catch {}
    }
    show((current + step + matches.length) % matches.length);
  }
  function open() {
    const opening = bar.hidden;
    bar.hidden = false; input.focus(); input.select();
    if (!opening) return;
    if (supported) { CSS.highlights.set('conversation-search', all); CSS.highlights.set('conversation-search-current', active); }
    find();
  }
  function close(focusComposer = true) {
    bar.hidden = true; matches = []; current = -1; text = null; lastUnloadedQuery = null; count.textContent = '';
    if (supported) { CSS.highlights.delete('conversation-search'); CSS.highlights.delete('conversation-search-current'); all.clear(); active.clear(); }
    if (focusComposer) $('message-input').focus();
  }

  // Dialogs and the file preview cover the conversation, so the browser keeps its own find there.
  const covered = () => document.querySelector('dialog[open]') || document.body.classList.contains('file-preview-open');
  // The menu bar's Find items; Find Next and Find Previous open a closed search again with its last text.
  Object.assign(api.commands, {
    find: () => { if (covered()) return false; open(); return true; },
    'find-next': () => { if (covered()) return false; if (bar.hidden) open(); else move(1); return true; },
    'find-previous': () => { if (covered()) return false; if (bar.hidden) open(); else move(-1); return true; },
  });
  document.addEventListener('keydown', event => {
    if (!(mac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') return;
    if (api.commands.find()) event.preventDefault();
  });
  input.addEventListener('input', () => find());
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); close(); }
    else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
  });
  $('conversation-search-previous').addEventListener('click', () => { move(-1); input.focus(); });
  $('conversation-search-next').addEventListener('click', () => { move(1); input.focus(); });
  $('conversation-search-close').addEventListener('click', () => close());
  window.addEventListener('relay-state', () => {
    const state = api.getState(), shown = `${state.projectId}:${state.conversation?.id}`;
    if (shown !== conversation) { conversation = shown; if (!bar.hidden) close(false); }
    // messagesSignature changes whenever app.js rebuilds the message elements, which detaches the old ranges.
    if (state.messagesSignature !== signature) { signature = state.messagesSignature; text = null; if (!bar.hidden) find(true); }
  });
})();

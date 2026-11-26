(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI;
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, cls, fn, id = '') => { const node = el('button', cls, text); node.type = 'button'; if (id) node.id = id; node.addEventListener('click', fn); return node; };
  const size = bytes => !bytes ? '0 KB' : bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.ceil(bytes / 1024)) + ' KB';
  const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
  const saveShortcut = mac ? '⌘S' : 'Ctrl+S', undoShortcut = mac ? '⌘Z' : 'Ctrl+Z', redoShortcut = mac ? '⇧⌘Z' : 'Ctrl+Y';
  // A sent Plan or card reads as what it is, like the message box's chip, rather than as a file name and a size.
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const attachmentLabel = file => file.plan ? (file.plan.whole ? `Plan · ${plural(file.plan.cards, 'card')}` : `Card · ${file.name.replace(/^Card – /, '').replace(/\.md$/i, '')}`) : file.name + ' · ' + size(file.bytes);
  const drafts = new Map(), uploads = new Map(), thumbnails = new Map();
  const browser = $('files-dialog'), opener = $('toggle-explorer');
  let project = '', signature = '', treeVersion = 0, previewVersion = 0, selected = null, editorNodes = null, dragDepth = 0;
  const key = id => 'relay-attachments:' + id;
  function files(id = api.getState().projectId) {
    if (!id) return [];
    if (!drafts.has(id)) {
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem(key(id)) || '[]'); } catch {}
      drafts.set(id, Array.isArray(saved) ? saved.filter(f => /^[a-f0-9]{64}$/.test(f?.id) && typeof f.name === 'string').slice(0,6) : []);
    }
    return drafts.get(id);
  }
  function save(id) { try { localStorage.setItem(key(id), JSON.stringify(files(id))); } catch {} }
  // Thumbnails are only drawn for draft attachments, so each one goes once no draft holds its image.
  function pruneThumbnails() { const kept = new Set([...drafts.values()].flat().map(file => file.id)); for (const id of thumbnails.keys()) if (!kept.has(id)) thumbnails.delete(id); }
  // counted is true while the line shows how many files are attached, so removing one can correct or clear it.
  let counted = false;
  function status(text = '', count = false) { counted = count && Boolean(text); $('attachment-status').textContent = text; $('attachment-status').hidden = !text; }
  const attachedLine = id => files(id).length ? files(id).length + ' attached · sent with your next message' : '';
  // Attachments leave the message box the moment their message is sent, like its text, and come back if it is refused.
  // They stay saved in the draft until the message is accepted.
  const held = new Map();
  const shown = (id = api.getState().projectId) => { const hidden = held.get(id); return hidden ? files(id).filter(file => !hidden.has(file.id)) : files(id); };
  function update() {
    const state = api.getState(), list = $('attachment-list'); list.replaceChildren();
    for (const file of shown()) {
      const chip = el('div', 'attachment-chip');
      const open = button('', 'attachment-open', () => openSaved(file, state.projectId));
      open.append(el('span', 'file-glyph ' + (file.kind === 'image' ? 'image' : 'code'), file.kind === 'image' ? '▧' : '≡'), el('span', 'attachment-name', file.name), el('small', '', size(file.bytes)));
      if (file.kind === 'image' && thumbnails.has(file.id)) { const thumb=el('img','attachment-thumbnail'); thumb.src=thumbnails.get(file.id); thumb.alt=''; open.firstChild.remove(); open.prepend(thumb); }
      const remove = button('', 'attachment-remove', () => { drafts.set(state.projectId, files(state.projectId).filter(f => f.id !== file.id)); save(state.projectId); pruneThumbnails(); if (counted) status(attachedLine(state.projectId), true); update(); });
      remove.setAttribute('aria-label', 'Remove ' + file.name); remove.disabled = Boolean(state.pending);
      chip.append(open, remove); list.append(chip);
    }
    list.hidden = !shown().length;
    $('attach-files').disabled = !state.ready || Boolean(state.pending) || uploads.has(state.projectId);
    $('attach-files').title = 'Attach up to 6 files · PNG, JPEG, GIF, WebP (5 MB), text/code (64 KB), Word .docx or PDF on macOS (5 MB, 64 KB of text) · paste or drop also works';
    api.renderControls();
  }
  // Files added while others upload wait their turn instead of being dropped, so the limits below always count what is already attached.
  // Problems are kept until the last waiting file is done, so a later success can't hide them.
  async function addSnapshots(snapshots, id = api.getState().projectId) {
    if (!id) return;
    const queue = uploads.get(id) || { count: 0, last: Promise.resolve(), errors: new Set() }, turn = queue.last.then(() => upload(snapshots, id, queue.errors));
    queue.count++; queue.last = turn; uploads.set(id, queue); update();
    try { return await turn; } finally {
      if (!--queue.count) {
        uploads.delete(id); update();
        const errors = [...queue.errors].join(' ');
        if (id === api.getState().projectId) status(errors || attachedLine(id), !errors);
        else if (errors) api.showNotice(errors);
      }
    }
  }
  async function upload(snapshots, id, errors) {
    if (id === api.getState().projectId) status('Adding attachments…');
    const added = [];
    for (const source of snapshots) {
      if (files(id).length >= 6) { errors.add('You can attach up to 6 files per message.'); break; }
      try {
        const data = typeof source === 'function' ? await source() : source;
        const meta = await api.post('/api/attachments', { name: data.name, data: data.data }, id);
        if (files(id).some(f => f.id === meta.id)) { added.push(meta.id); continue; }
        if (files(id).reduce((sum,f) => sum + f.bytes, meta.bytes) > 20 * 1024 * 1024) throw Error('Attachments must total 20 MB or less.');
        if (meta.kind === 'text' && files(id).filter(f => f.kind === 'text').reduce((sum,f) => sum + f.bytes, meta.bytes) > 128 * 1024) throw Error('Text attachments must total 128 KB or less.');
        if (meta.kind === 'image') thumbnails.set(meta.id,'data:'+meta.mime+';base64,'+data.data);
        files(id).push(meta); added.push(meta.id); save(id);
      } catch (error) { errors.add(error.message); }
    }
    update();
    return added;
  }
  function addFiles(input) {
    if (!api.getState().ready || api.getState().pending) return;
    const selectedFiles = Array.from(input || []);
    const snapshots = selectedFiles.map(file => async () => {
      if (file.size > 5 * 1024 * 1024) throw Error(file.name + ': files must be 5 MB or smaller.');
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(Error('Could not read ' + file.name)); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
      return { name: file.name, data };
    });
    return addSnapshots(snapshots);
  }
  let nav = null, pendingNav = null;
  const isDirty = () => Boolean(selected?.editing && selected.draftText !== selected.savedText);
  const canEdit = (file, saved, target) => Boolean(
    !saved &&
    target?.folder?.id &&
    target?.relative &&
    file?.kind === 'text' &&
    !file?.inCopy &&
    !file?.branch &&
    file?.editable !== false &&
    !/\.(pdf|docx)$/i.test(file?.name || '')
  );
  function paintNav() {
    const on = !!nav && !$('file-preview').hidden;
    for (const id of ['preview-prev', 'preview-next']) $(id).hidden = !on;
    if (on) { $('preview-prev').disabled = nav.index <= 0; $('preview-next').disabled = nav.index >= nav.count - 1; $('preview-count').textContent = (nav.index + 1) + ' of ' + nav.count; }
    $('preview-count').hidden = !on;
  }
  function stepImage(by) { if (!nav) return; const next = nav.index + by; if (next < 0 || next >= nav.count) return; const target = nav; pendingNav = { ...target, index: next }; target.go(next); }
  function forceClosePreview() {
    nav = pendingNav = null;
    paintNav();
    previewVersion++;
    selected = null;
    editorNodes = null;
    if ($('file-preview-banner')) $('file-preview-banner').hidden = true;
    if ($('file-preview-dirty')) $('file-preview-dirty').hidden = true;
    $('file-preview').hidden = true;
    document.body.classList.remove('file-preview-open');
  }
  function requestClosePreview(onProceed = null) {
    if (!isDirty()) {
      forceClosePreview();
      onProceed?.();
      return true;
    }
    selected.prompt = { kind: 'close', onProceed };
    renderBanner();
    $('file-discard-save')?.focus();
    return false;
  }
  // Pinch (a trackpad pinch arrives as ctrl+wheel) zooms toward the pointer, two-finger scroll or a drag pans a zoomed image, double-click resets.
  function zoomable(box, img) {
    let scale = 1, x = 0, y = 0, drag = null;
    const apply = () => { img.style.transform = scale === 1 ? '' : 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')'; img.style.cursor = scale > 1 ? 'grab' : ''; };
    const reset = () => { scale = 1; x = y = 0; apply(); };
    img.style.transformOrigin = 'center'; img.draggable = false; box.style.overflow = 'hidden'; box.style.touchAction = 'none';
    box.addEventListener('wheel', event => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = box.getBoundingClientRect(), px = event.clientX - rect.left - rect.width / 2, py = event.clientY - rect.top - rect.height / 2;
        const next = Math.min(16, Math.max(1, scale * Math.exp(-event.deltaY * 0.01))), ratio = next / scale;
        x = px - (px - x) * ratio; y = py - (py - y) * ratio; scale = next;
        if (scale === 1) x = y = 0;
      } else if (scale > 1) { x -= event.deltaX; y -= event.deltaY; }
      apply();
    }, { passive: false });
    box.addEventListener('pointerdown', event => { if (scale <= 1 || event.button !== 0) return; drag = { id: event.pointerId, x: event.clientX - x, y: event.clientY - y }; box.setPointerCapture?.(event.pointerId); img.style.cursor = 'grabbing'; });
    box.addEventListener('pointermove', event => { if (!drag || drag.id !== event.pointerId) return; x = event.clientX - drag.x; y = event.clientY - drag.y; apply(); });
    const end = event => { if (drag && drag.id === event.pointerId) { drag = null; apply(); } };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    box.addEventListener('dblclick', () => { if (scale === 1) { scale = 2; apply(); } else reset(); });
  }
  function byteSize(text) {
    try { return new TextEncoder().encode(String(text || '')).length; } catch { return String(text || '').length; }
  }
  function highlightText(text, fileName) {
    const ext = String(fileName || '').split('.').at(-1);
    return api.highlightLines ? api.highlightLines(text, ext) : String(text || '').split('\n').map(line => [['', line]]);
  }
  function renderReadOnlySource(file) {
    const content = $('file-preview-content'); content.replaceChildren();
    editorNodes = null;
    if (file.kind === 'image') { const img = el('img'); img.src = 'data:' + file.mime + ';base64,' + file.data; img.alt = file.name; content.append(img); zoomable(content, img); return; }
    // Syntax colors come from the shared highlighter so previews match chat code blocks.
    const source = el('pre', 'file-source'), text = String(file.text || ''), lines = highlightText(text, file.name);
    lines.forEach((tokens, index) => {
      const row = el('span', 'source-line'), code = el('code');
      for (const [kind, value] of tokens) code.append(kind ? el('span', 'tok-' + kind, value) : document.createTextNode(value));
      if (!tokens.length) code.textContent = ' ';
      row.append(el('span', 'line-number', String(index + 1)), code);
      source.append(row);
    });
    content.append(source);
  }
  function renderEditorHighlight(text) {
    if (!editorNodes || !selected) return;
    const lines = highlightText(text, selected.file.name);
    if (editorNodes.lineCount !== lines.length) {
      const gutterFrag = document.createDocumentFragment();
      for (let i = 1; i <= lines.length; i++) gutterFrag.append(el('span', '', String(i)));
      editorNodes.gutter.replaceChildren(gutterFrag);
      editorNodes.lineCount = lines.length;
    }
    const codeFrag = document.createDocumentFragment();
    lines.forEach((tokens, index) => {
      if (index) codeFrag.append(document.createTextNode('\n'));
      for (const [kind, value] of tokens) codeFrag.append(kind ? el('span', 'tok-' + kind, value) : document.createTextNode(value));
    });
    // A trailing space after a final newline keeps the overlay height aligned with the textarea's empty last line.
    if (!text || text.endsWith('\n')) codeFrag.append(document.createTextNode(' '));
    editorNodes.code.replaceChildren(codeFrag);
  }
  function pushHistory(text, start = 0, end = start, { coalesce = false } = {}) {
    if (!selected) return;
    const current = selected.history[selected.historyIndex];
    if (current && current.text === text) { current.start = start; current.end = end; return; }
    selected.history.splice(selected.historyIndex + 1);
    const now = Date.now();
    const canMerge = coalesce && selected.historyIndex > 0 && current && current.text !== selected.savedText &&
      now - selected.lastEditAt < 400 && Math.abs(text.length - current.text.length) <= 2 &&
      !text.slice(Math.min(start, current.start), Math.max(start, current.start)).includes('\n');
    if (canMerge) selected.history[selected.historyIndex] = { text, start, end };
    else {
      selected.history.push({ text, start, end });
      if (selected.history.length > 200) selected.history.shift();
      selected.historyIndex = selected.history.length - 1;
    }
    selected.lastEditAt = now;
  }
  function applyEditorState(text, start, end) {
    if (!selected) return;
    selected.draftText = text;
    selected.statusNote = null;
    if (selected.prompt?.kind === 'active-run') selected.prompt = null;
    if (editorNodes?.input) {
      editorNodes.input.value = text;
      if (typeof start === 'number' && typeof editorNodes.input.setSelectionRange === 'function') {
        try { editorNodes.input.setSelectionRange(start, typeof end === 'number' ? end : start); } catch {}
      } else if (typeof start === 'number') {
        editorNodes.input.selectionStart = start;
        editorNodes.input.selectionEnd = typeof end === 'number' ? end : start;
      }
      renderEditorHighlight(text);
    }
    renderEditorControls();
    renderBanner();
  }
  function undoEdit() {
    if (!selected?.editing || selected.conflict?.comparing || selected.historyIndex <= 0) return;
    selected.historyIndex--;
    const entry = selected.history[selected.historyIndex];
    applyEditorState(entry.text, entry.start, entry.end);
    editorNodes?.input?.focus();
  }
  function redoEdit() {
    if (!selected?.editing || selected.conflict?.comparing || selected.historyIndex >= selected.history.length - 1) return;
    selected.historyIndex++;
    const entry = selected.history[selected.historyIndex];
    applyEditorState(entry.text, entry.start, entry.end);
    editorNodes?.input?.focus();
  }
  function revertEdit() {
    if (!selected?.editing || !isDirty() || selected.saving) return;
    const savedText = selected.savedText;
    pushHistory(savedText, 0, 0, { coalesce: false });
    selected.conflict = null;
    selected.prompt = null;
    selected.error = null;
    if (!editorNodes) mountEditor();
    applyEditorState(savedText, 0, 0);
    selected.statusNote = 'Reverted';
    renderEditorControls();
    editorNodes?.input?.focus();
  }
  function mountEditor() {
    if (!selected) return;
    const content = $('file-preview-content'); content.replaceChildren();
    const wrap = el('div', 'file-editor'), gutter = el('div', 'file-editor-gutter'), surface = el('div', 'file-editor-surface');
    const pre = el('pre', 'file-editor-highlight'), code = el('code'), input = el('textarea', 'file-editor-input');
    gutter.setAttribute('aria-hidden', 'true');
    pre.setAttribute('aria-hidden', 'true');
    input.id = 'file-editor-input';
    input.setAttribute('aria-label', 'Edit ' + selected.file.name);
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('wrap', 'off');
    input.value = selected.draftText;
    pre.append(code);
    surface.append(pre, input);
    wrap.append(gutter, surface);
    content.append(wrap);
    editorNodes = { wrap, gutter, pre, code, input, lineCount: 0 };
    renderEditorHighlight(selected.draftText);
    input.addEventListener('input', () => {
      if (!selected?.editing) return;
      const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
      const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
      selected.draftText = input.value;
      selected.statusNote = null;
      if (selected.prompt?.kind === 'active-run') selected.prompt = null;
      pushHistory(input.value, start, end, { coalesce: true });
      renderEditorHighlight(input.value);
      renderEditorControls();
      renderBanner();
    });
    input.addEventListener('keydown', event => {
      if (!selected?.editing || event.isComposing) return;
      if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        const value = input.value;
        const start = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
        const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
        let next, nextStart, nextEnd;
        if (event.shiftKey) {
          const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
          const segment = value.slice(lineStart, end);
          const replaced = segment.replace(/^(?: {1,2}|\t)/gm, '');
          const firstRemoved = (value.slice(lineStart).match(/^(?: {1,2}|\t)/) || [''])[0].length;
          next = value.slice(0, lineStart) + replaced + value.slice(end);
          nextStart = Math.max(lineStart, start - firstRemoved);
          nextEnd = lineStart + replaced.length;
        } else if (start !== end && value.slice(start, end).includes('\n')) {
          const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
          const segment = value.slice(lineStart, end);
          const replaced = segment.replace(/^/gm, '  ');
          next = value.slice(0, lineStart) + replaced + value.slice(end);
          nextStart = start + 2;
          nextEnd = lineStart + replaced.length;
        } else {
          next = value.slice(0, start) + '  ' + value.slice(end);
          nextStart = nextEnd = start + 2;
        }
        pushHistory(next, nextStart, nextEnd, { coalesce: false });
        applyEditorState(next, nextStart, nextEnd);
      }
    });
  }
  function enterEditMode() {
    if (!selected || !selected.editable || selected.editing) return;
    selected.editing = true;
    selected.draftText = selected.savedText;
    selected.history = [{ text: selected.savedText, start: 0, end: 0 }];
    selected.historyIndex = 0;
    selected.lastEditAt = 0;
    selected.conflict = null;
    selected.prompt = null;
    selected.error = null;
    selected.statusNote = null;
    mountEditor();
    renderEditorControls();
    renderBanner();
    editorNodes?.input?.focus();
  }
  // Computes a compact unified diff comparing disk lines (−) with your unsaved edits (+).
  function computeLineDiff(diskText, draftText) {
    const a = diskText === null ? [] : String(diskText).split('\n');
    const b = String(draftText).split('\n');
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    const aMid = a.slice(prefix, a.length - suffix), bMid = b.slice(prefix, b.length - suffix);
    const ops = [];
    for (let i = 0; i < prefix; i++) ops.push({ kind: 'context', oldLine: i + 1, newLine: i + 1, text: a[i] });
    if (aMid.length * bMid.length <= 250000) {
      const m = aMid.length, n = bMid.length, dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          dp[i][j] = aMid[i] === bMid[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < m && j < n) {
        if (aMid[i] === bMid[j]) { ops.push({ kind: 'context', oldLine: prefix + i + 1, newLine: prefix + j + 1, text: aMid[i] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: 'del', oldLine: prefix + i + 1, newLine: '', text: aMid[i] }); i++; }
        else { ops.push({ kind: 'add', oldLine: '', newLine: prefix + j + 1, text: bMid[j] }); j++; }
      }
      while (i < m) { ops.push({ kind: 'del', oldLine: prefix + i + 1, newLine: '', text: aMid[i] }); i++; }
      while (j < n) { ops.push({ kind: 'add', oldLine: '', newLine: prefix + j + 1, text: bMid[j] }); j++; }
    } else {
      for (let i = 0; i < aMid.length; i++) ops.push({ kind: 'del', oldLine: prefix + i + 1, newLine: '', text: aMid[i] });
      for (let j = 0; j < bMid.length; j++) ops.push({ kind: 'add', oldLine: '', newLine: prefix + j + 1, text: bMid[j] });
    }
    for (let i = 0; i < suffix; i++) {
      const oi = a.length - suffix + i, ni = b.length - suffix + i;
      ops.push({ kind: 'context', oldLine: oi + 1, newLine: ni + 1, text: a[oi] });
    }
    return ops;
  }
  function renderCompareView() {
    if (!selected?.conflict) return;
    const content = $('file-preview-content'); content.replaceChildren();
    editorNodes = null;
    const head = el('div', 'file-compare-head', selected.conflict.deleted
      ? 'This file was deleted on disk. Your unsaved edits (+) will recreate it if you choose Save anyway.'
      : 'Comparing what is on disk (−) with your unsaved edits (+).');
    const lines = el('div', 'diff-lines');
    const ops = computeLineDiff(selected.conflict.deleted ? null : selected.conflict.text ?? '', selected.draftText);
    const changed = ops.some(op => op.kind !== 'context');
    if (!changed) {
      content.append(head, el('p', 'inspector-empty', 'Your edits match the file currently on disk.'));
      return;
    }
    for (const op of ops) {
      const row = el('div', 'diff-line ' + op.kind);
      row.append(
        el('span', 'diff-number', String(op.oldLine)),
        el('span', 'diff-number', String(op.newLine)),
        el('span', 'diff-sign', op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ''),
        el('span', 'diff-text', op.text)
      );
      lines.append(row);
    }
    content.append(head, lines);
  }
  function reloadFromDisk() {
    if (!selected?.conflict || selected.conflict.deleted) return;
    const nextText = typeof selected.conflict.text === 'string' ? selected.conflict.text : '';
    const nextHash = selected.conflict.sha256 || null;
    const nextBytes = typeof selected.conflict.bytes === 'number' ? selected.conflict.bytes : byteSize(nextText);
    selected.savedText = nextText;
    selected.savedHash = nextHash;
    selected.file = { ...selected.file, text: nextText, bytes: nextBytes, sha256: nextHash };
    selected.conflict = null;
    selected.prompt = null;
    selected.error = null;
    pushHistory(nextText, 0, 0, { coalesce: false });
    if (!editorNodes) mountEditor();
    applyEditorState(nextText, 0, 0);
    selected.statusNote = 'Reloaded from disk';
    renderEditorControls();
    renderBanner();
    editorNodes?.input?.focus();
  }
  function renderBanner() {
    const banner = $('file-preview-banner'), text = $('file-preview-banner-text'), actions = $('file-preview-banner-actions');
    if (!banner || !text || !actions) return;
    actions.replaceChildren();
    if (!selected) { banner.hidden = true; return; }
    if (selected.prompt?.kind === 'close') {
      banner.dataset.tone = 'warning';
      text.textContent = `You have unsaved changes in ${selected.file.name}.`;
      actions.append(
        button('Save and close', 'primary-button', () => saveFile({ closeAfter: true, onProceed: selected.prompt?.onProceed }), 'file-discard-save'),
        button('Discard changes', 'secondary-button', () => { const next = selected.prompt?.onProceed; forceClosePreview(); next?.(); }, 'file-discard-confirm'),
        button('Keep editing', 'secondary-button', () => { selected.prompt = null; renderBanner(); editorNodes?.input?.focus(); }, 'file-discard-cancel')
      );
      banner.hidden = false;
      return;
    }
    if (selected.conflict) {
      banner.dataset.tone = 'warning';
      const activeNote = selected.conflict.activeRun ? ` (${selected.conflict.activeRun.label} is working in this folder)` : '';
      text.textContent = (selected.conflict.deleted
        ? 'This file was deleted on disk since you opened it'
        : 'This file changed on disk since you opened it') + activeNote + '.';
      if (!selected.conflict.deleted) {
        actions.append(button('Reload', 'secondary-button', reloadFromDisk, 'file-conflict-reload'));
      }
      actions.append(
        button(selected.conflict.comparing ? 'Back to editor' : 'Compare', 'secondary-button', () => {
          if (!selected?.conflict) return;
          selected.conflict.comparing = !selected.conflict.comparing;
          if (selected.conflict.comparing) renderCompareView();
          else { mountEditor(); editorNodes?.input?.focus(); }
          renderBanner();
          renderEditorControls();
        }, 'file-conflict-compare'),
        button('Save anyway', 'primary-button', () => saveFile({ force: true, confirmActiveRun: true, closeAfter: Boolean(selected.conflict?.closeAfter), onProceed: selected.conflict?.onProceed }), 'file-conflict-force')
      );
      banner.hidden = false;
      return;
    }
    if (selected.prompt?.kind === 'active-run') {
      banner.dataset.tone = 'warning';
      text.textContent = selected.prompt.message + ' Saving now could conflict with its edits.';
      actions.append(
        button('Save anyway', 'primary-button', () => saveFile({ force: Boolean(selected.prompt?.force), confirmActiveRun: true, closeAfter: Boolean(selected.prompt?.closeAfter), onProceed: selected.prompt?.onProceed }), 'file-active-run-save'),
        button('Cancel', 'secondary-button', () => { selected.prompt = null; renderBanner(); editorNodes?.input?.focus(); }, 'file-active-run-cancel')
      );
      banner.hidden = false;
      return;
    }
    if (selected.error) {
      banner.dataset.tone = 'danger';
      text.textContent = selected.error;
      actions.append(button('Dismiss', 'secondary-button', () => { selected.error = null; renderBanner(); editorNodes?.input?.focus(); }, 'file-error-dismiss'));
      banner.hidden = false;
      return;
    }
    banner.hidden = true;
  }
  function renderEditorControls() {
    if (!selected) return;
    const editing = Boolean(selected.editing), dirty = isDirty(), comparing = Boolean(selected.conflict?.comparing);
    const dirtyBadge = $('file-preview-dirty');
    if (dirtyBadge) dirtyBadge.hidden = !dirty;
    if ($('edit-preview')) $('edit-preview').hidden = !selected.editable || editing;
    if ($('undo-preview')) {
      $('undo-preview').hidden = !editing;
      $('undo-preview').disabled = !editing || comparing || selected.saving || selected.historyIndex <= 0;
      $('undo-preview').title = `Undo (${undoShortcut})`;
    }
    if ($('redo-preview')) {
      $('redo-preview').hidden = !editing;
      $('redo-preview').disabled = !editing || comparing || selected.saving || selected.historyIndex >= selected.history.length - 1;
      $('redo-preview').title = `Redo (${redoShortcut})`;
    }
    if ($('revert-preview')) {
      $('revert-preview').hidden = !editing;
      $('revert-preview').disabled = !dirty || selected.saving;
    }
    if ($('save-preview')) {
      $('save-preview').hidden = !editing;
      $('save-preview').disabled = selected.saving || (!dirty && !selected.conflict);
      $('save-preview').textContent = selected.saving ? 'Saving…' : 'Save';
      $('save-preview').title = `Save (${saveShortcut})`;
    }
    const attach = $('attach-preview');
    if (attach) {
      attach.hidden = editing;
      const tooLarge = selected.file.kind === 'text' && (selected.file.bytes === 0 || selected.file.bytes > 64 * 1024);
      const alreadyAttached = selected.saved && files(selected.projectId).some(f => f.id === selected.file.id);
      attach.disabled = alreadyAttached || tooLarge;
      attach.textContent = alreadyAttached ? 'Attached' : 'Attach to message';
      attach.title = tooLarge ? (selected.file.bytes === 0 ? 'Empty files cannot be attached.' : 'Attachments support text files up to 64 KB.') : '';
    }
    const textValue = editing ? selected.draftText : String(selected.file.text || '');
    const bytes = editing ? byteSize(textValue) : selected.file.bytes;
    const read = /\.(pdf|docx)$/i.exec(selected.file.name)?.[1]?.toLowerCase();
    const linesCount = textValue.split('\n').length;
    const modeLabel = editing
      ? (selected.saving ? 'Saving…' : dirty ? `Unsaved changes · ${saveShortcut} to save` : (selected.statusNote || `Editing · ${saveShortcut} to save`))
      : 'Read-only preview';
    $('file-preview-meta').textContent = size(bytes) + ' · ' + (selected.file.kind === 'image'
      ? selected.file.mime.replace('image/', '').toUpperCase()
      : (read ? 'Text from the ' + (read === 'pdf' ? 'PDF' : 'Word document') : 'UTF-8') + ' · ' + plural(linesCount, 'line')) + ' · ' + modeLabel;
  }
  async function saveFile({ force = false, confirmActiveRun = false, closeAfter = false, onProceed = null } = {}) {
    if (!selected?.editing || selected.saving) return false;
    if (!isDirty() && !force) {
      if (closeAfter) { forceClosePreview(); onProceed?.(); }
      return true;
    }
    const snapshot = selected, text = snapshot.draftText;
    snapshot.saving = true;
    snapshot.error = null;
    snapshot.prompt = null;
    snapshot.statusNote = 'Saving…';
    renderEditorControls();
    renderBanner();
    try {
      const saved = await api.post('/api/files/save', {
        folderId: snapshot.folder.id,
        path: snapshot.relative,
        content: text,
        ...(force ? { force: true } : { expectedHash: snapshot.savedHash }),
        ...(confirmActiveRun ? { confirmActiveRun: true } : {}),
      }, snapshot.projectId);
      if (selected !== snapshot || snapshot.projectId !== api.getState().projectId) return false;
      snapshot.saving = false;
      snapshot.file = { ...snapshot.file, ...saved };
      snapshot.savedText = typeof saved.text === 'string' ? saved.text : text;
      snapshot.savedHash = saved.sha256 || snapshot.savedHash;
      snapshot.conflict = null;
      snapshot.prompt = null;
      snapshot.error = null;
      snapshot.statusNote = 'Saved';
      if (!editorNodes && snapshot.editing) mountEditor();
      renderEditorControls();
      renderBanner();
      window.relayGit?.refresh?.();
      api.announce?.(`Saved ${snapshot.file.name}.`);
      if (closeAfter && !isDirty()) {
        forceClosePreview();
        onProceed?.();
      }
      return true;
    } catch (error) {
      if (selected !== snapshot || snapshot.projectId !== api.getState().projectId) return false;
      snapshot.saving = false;
      snapshot.statusNote = null;
      const details = error?.details || null;
      if (error?.status === 409 && details?.code === 'FILE_CHANGED') {
        snapshot.conflict = { ...(details.current || {}), activeRun: details.activeRun || null, comparing: false, closeAfter, onProceed };
        snapshot.prompt = null;
        snapshot.error = null;
        if (!editorNodes) mountEditor();
      } else if (error?.status === 409 && details?.code === 'ACTIVE_RUN') {
        snapshot.prompt = { kind: 'active-run', activeRun: details.activeRun || null, message: error.message, force, closeAfter, onProceed };
        snapshot.error = null;
      } else {
        snapshot.error = error?.message || 'Could not save this file.';
      }
      renderEditorControls();
      renderBanner();
      return false;
    }
  }
  function showPreview(file, label, id, saved = false, target = null) {
    nav = null;
    const editable = canEdit(file, saved, target);
    const initialText = file.kind === 'text' ? String(file.text || '') : '';
    selected = {
      file,
      projectId: id,
      saved,
      folder: target?.folder || null,
      relative: target?.relative || file.path || null,
      editable,
      editing: false,
      savedText: initialText,
      savedHash: file.sha256 || null,
      draftText: initialText,
      history: [{ text: initialText, start: 0, end: 0 }],
      historyIndex: 0,
      lastEditAt: 0,
      saving: false,
      conflict: null,
      prompt: null,
      error: null,
      statusNote: null,
    };
    $('file-preview-name').textContent = file.name;
    $('file-preview-path').textContent = label;
    renderReadOnlySource(file);
    renderBanner();
    renderEditorControls();
    $('file-preview').hidden = false; document.body.classList.add('file-preview-open');
  }
  async function openSaved(file, id) {
    if (isDirty()) { requestClosePreview(() => openSaved(file, id)); return; }
    const version = ++previewVersion;
    try { const data = await api.api('/api/attachments/preview?id=' + encodeURIComponent(file.id), {}, id); if (version === previewVersion && id === api.getState().projectId) showPreview(data, 'Saved attachment', id, true); }
    catch (error) { if (version === previewVersion) api.showNotice(error.message); }
  }
  async function openFile(folder, entry, id) {
    if (isDirty()) {
      if (browser.open) browser.close();
      requestClosePreview(() => openFile(folder, entry, id));
      return false;
    }
    const version = ++previewVersion;
    $('files-error').hidden = true;
    try {
      const file = await api.api('/api/files/preview?folderId=' + encodeURIComponent(folder.id) + '&path=' + encodeURIComponent(entry.path), {}, id);
      if (version !== previewVersion || id !== api.getState().projectId) return;
      showPreview(file, (folder.displayName || folder.name) + ' / ' + entry.path, id, false, { folder, relative: entry.path });
      browser.close();
      $('close-file-preview').focus();
      return true;
    } catch (error) {
      if (version === previewVersion) {
        if (browser.open) { $('files-error').textContent = error.message; $('files-error').hidden = false; }
        else api.showNotice(error.message);
      }
    }
  }
  // The tree is an ARIA tree (#26): each row is a treeitem at its level, a folder's contents are its group, and
  // keyboard.js moves between rows with the arrow keys.
  const treeRow = (node, level) => { node.setAttribute('role','treeitem'); node.setAttribute('aria-level',String(level)); node.tabIndex = -1; return node; };
  function directory(folder, relative, name, host, id, version, root = false, level = 1) {
    const branch = el('div', 'tree-branch'), row = treeRow(button('', 'tree-row tree-directory' + (root ? ' tree-root' : ''), toggle), level), children = el('div', 'tree-children');
    row.append(el('span','tree-chevron'), el('span','file-glyph folder'), el('span','tree-label',name));
    branch.setAttribute('role','none'); children.setAttribute('role','group');
    row.title = relative || folder.path; row.setAttribute('aria-expanded','false'); children.hidden = true;
    branch.append(row,children); host.append(branch); let loaded = false, loading = false;
    async function load(offset = 0) {
      loading = true; row.setAttribute('aria-busy','true');
      if (!offset) children.replaceChildren(el('p','tree-note','Loading…'));
      try {
        const result = await api.api('/api/files?folderId=' + encodeURIComponent(folder.id) + '&path=' + encodeURIComponent(relative) + '&offset=' + offset, {}, id);
        if (version !== treeVersion) return;
        if (!offset) children.replaceChildren();
        for (const entry of result.entries) {
          if (entry.kind === 'directory') directory(folder,entry.path,entry.name,children,id,version,false,level + 1);
          else {
            const file = treeRow(button('', 'tree-row tree-file', () => { for (const node of $('file-tree').querySelectorAll('.tree-file')) { node.classList.remove('selected'); node.setAttribute('aria-selected','false'); } file.classList.add('selected'); file.setAttribute('aria-selected','true'); openFile(folder,entry,id); }), level + 1);
            file.setAttribute('aria-selected','false');
            const ext = entry.name.split('.').at(-1).toLowerCase(), image = ['png','jpg','jpeg','gif','webp'].includes(ext);
            const glyph = el('span','file-glyph ' + (image ? 'image' : ['js','jsx','ts','tsx','json'].includes(ext) ? 'script' : 'code'), image ? '▧' : ['js','jsx','ts','tsx'].includes(ext) ? ext.slice(0,2).toUpperCase() : '≡'); glyph.setAttribute('aria-hidden','true');
            file.append(glyph, el('span','tree-label',entry.name)); file.title = entry.path; children.append(file);
          }
        }
        if (!result.entries.length && !offset) { const empty = treeRow(el('p','tree-note','No visible files'), level + 1); empty.setAttribute('aria-disabled','true'); children.append(empty); }
        if (result.nextOffset !== null) { const more = treeRow(button('Load more…','tree-more', () => { more.disabled = true; load(result.nextOffset).then(ok => { if (ok) more.remove(); else more.disabled = false; }); }), level + 1); children.append(more); }
        loaded = true; return true;
      } catch (error) { if (version === treeVersion) { if (!offset) children.replaceChildren(); const retry = treeRow(button('Retry','tree-more',() => { retry.remove(); load(offset); }), level + 1); retry.setAttribute('aria-label', 'Retry. ' + error.message); children.append(el('p','tree-note',error.message),retry); } return false; }
      finally { loading = false; row.removeAttribute('aria-busy'); }
    }
    function toggle() { if (loading) return; const expanded = row.getAttribute('aria-expanded') === 'true'; row.setAttribute('aria-expanded',String(!expanded)); children.hidden = expanded; if (!expanded && !loaded) load(); }
    if (root) toggle();
  }
  function refreshTree() {
    const state = api.getState(), current = state.projects.find(p => p.id === state.projectId), tree = $('file-tree'), version = ++treeVersion;
    tree.replaceChildren();
    $('files-error').hidden = true;
    if (!current) { tree.append(el('p','tree-note','Add a workspace to browse its files.')); return; }
    // Only the folder selected in the sidebar is shown, so multi-folder workspaces stay readable.
    const folderId = api.sidebarLevel?.() === 'workspace' ? null : api.selectedFolderId?.();
    $('files-location').textContent = current.name;
    for (const folder of (current.folders || []).filter(folder => !folderId || folder.id === folderId)) directory(folder,'',folder.displayName || folder.name,tree,state.projectId,version,true);
  }
  function sync() {
    const state = api.getState(), current = state.projects.find(p => p.id === state.projectId), next = JSON.stringify([state.projectId,current?.folders,api.selectedFolderId?.(),api.sidebarLevel?.()]);
    opener.disabled = !state.projectId;
    if (signature !== next) {
      signature = next; forceClosePreview(); treeVersion++;
      if (browser.open) refreshTree(); else $('file-tree').replaceChildren();
    }
    if (!state.projectId && browser.open) browser.close();
    if (project !== state.projectId) { project = state.projectId; status(); }
    update();
  }
  $('attach-files').addEventListener('click', () => { $('attachment-input').value = ''; $('attachment-input').click(); });
  $('attachment-input').addEventListener('change', () => addFiles($('attachment-input').files));
  $('message-input').addEventListener('paste',event => { const images = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean); if (images.length) { event.preventDefault(); addFiles(images); } });
  const composer = $('composer');
  composer.addEventListener('dragenter',event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); dragDepth++; composer.classList.add('file-drop'); } });
  composer.addEventListener('dragover',event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  composer.addEventListener('dragleave',() => { if (--dragDepth <= 0) { dragDepth = 0; composer.classList.remove('file-drop'); } });
  composer.addEventListener('drop',event => { event.preventDefault(); dragDepth = 0; composer.classList.remove('file-drop'); addFiles(event.dataTransfer?.files); });
  // Prevent dropping a file outside the composer from navigating away from the app.
  window.addEventListener('dragover',event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  window.addEventListener('drop',event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  $('edit-preview')?.addEventListener('click', enterEditMode);
  $('undo-preview')?.addEventListener('click', undoEdit);
  $('redo-preview')?.addEventListener('click', redoEdit);
  $('revert-preview')?.addEventListener('click', revertEdit);
  $('save-preview')?.addEventListener('click', () => saveFile());
  $('close-file-preview').addEventListener('click', () => requestClosePreview());
  $('attach-preview').addEventListener('click',async () => {
    if (!selected || api.getState().pending) return;
    const snapshot = selected;
    if (snapshot.projectId !== api.getState().projectId) return;
    const added = await addSnapshots([snapshot.file], snapshot.projectId);
    if (selected === snapshot && added?.length) { forceClosePreview(); $('message-input').focus(); }
  });
  $('refresh-files').addEventListener('click',refreshTree);
  // Browsing is an explicit action and never changes the workspace/folder task scope or the sidebar's geometry.
  opener.addEventListener('click', () => {
    if (browser.open) { browser.close(); return; }
    if (!api.getState().projectId) return;
    $('explorer').hidden = false; opener.setAttribute('aria-expanded', 'true'); browser.showModal(); refreshTree();
    $('file-tree').querySelector('[role="treeitem"]')?.focus();
    window.dispatchEvent(new Event('relay-files'));
  });
  $('close-files').addEventListener('click', () => browser.close());
  browser.addEventListener('close', () => {
    $('explorer').hidden = true; opener.setAttribute('aria-expanded', 'false');
    window.dispatchEvent(new Event('relay-files'));
    ($('file-preview').hidden ? opener : $('close-file-preview')).focus();
  });
  window.addEventListener('keydown', event => {
    if (event.isComposing || document.querySelector('dialog[open]') || $('file-preview').hidden) return;
    if (event.key === 'Escape') {
      if (selected?.prompt?.kind === 'close') { selected.prompt = null; renderBanner(); editorNodes?.input?.focus(); return; }
      if (selected?.conflict?.comparing) { selected.conflict.comparing = false; mountEditor(); renderBanner(); renderEditorControls(); editorNodes?.input?.focus(); return; }
      requestClosePreview();
      return;
    }
    if (!selected?.editing || event.altKey) return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const lower = String(event.key || '').toLowerCase();
    if (lower === 's') {
      event.preventDefault();
      saveFile();
      return;
    }
    const target = event.target;
    const inOtherField = target && target !== editorNodes?.input && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''));
    if (inOtherField) return;
    if (lower === 'z') {
      event.preventDefault();
      if (event.shiftKey) redoEdit();
      else undoEdit();
      return;
    }
    if (lower === 'y' && event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      redoEdit();
    }
  });
  window.addEventListener('keydown', event => {
    if (!nav || $('file-preview').hidden || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || document.querySelector('dialog[open]')) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target; if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault(); stepImage(event.key === 'ArrowLeft' ? -1 : 1);
  });
  window.addEventListener('beforeunload', event => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } });
  $('preview-prev').addEventListener('click', () => stepImage(-1));
  $('preview-next').addEventListener('click', () => stepImage(1));
  window.addEventListener('relay-state',sync);
  function focusLine(line, endLine = line, id = api.getState().projectId) {
    if (id !== api.getState().projectId || !Number.isSafeInteger(line) || line < 1) return;
    const rows = $('file-preview-content').querySelectorAll('.source-line'), finish = Number.isSafeInteger(endLine) && endLine >= line ? endLine : line;
    for (let index = line; index <= finish; index++) rows[index - 1]?.classList.add('review-line');
    rows[line - 1]?.scrollIntoView({ block: 'center' });
  }
  window.relayFiles = {
    async openAt(folderId, relative, line, endLine = line) {
      const state = api.getState(), id = state.projectId, folder = state.projects.find(project => project.id === id)?.folders.find(folder => folder.id === folderId);
      if (!folder) return api.showNotice('That folder is no longer in this workspace.');
      if (!await openFile(folder, { path: relative }, id)) return;
      focusLine(line, endLine, id);
    },
    showPreviewAt(folder, relative, file, line, endLine = line) {
      if (isDirty()) { requestClosePreview(() => window.relayFiles.showPreviewAt(folder, relative, file, line, endLine)); return; }
      const id = api.getState().projectId;
      previewVersion++;
      showPreview(file, (folder.displayName || folder.name) + (file.inCopy ? ' (copy)' : file.branch ? ` (${file.branch})` : '') + ' / ' + relative, id, false, { folder, relative });
      nav = pendingNav; pendingNav = null; paintNav();
      if (browser.open) browser.close();
      $('close-file-preview').focus();
      focusLine(line, endLine, id);
    },
    setImageNav(next) { pendingNav = next; },
    ids: () => files().map(file => file.id), uploading: () => uploads.has(api.getState().projectId), addFiles, addSnapshots,
    // The Plan, or a card, attached from the Plan (#97): already saved as a text snapshot, so it only joins the message's
    // attachments, under the same limits as a file. Says what it added, or throws why it can't.
    attachSaved(meta, id = api.getState().projectId) {
      if (!id || !meta?.id) throw Error('Select a workspace first.');
      if (!files(id).some(f => f.id === meta.id)) {
        if (files(id).length >= 6) throw Error('You can attach up to 6 files per message. Remove one first.');
        if (files(id).filter(f => f.kind === 'text').reduce((sum, f) => sum + f.bytes, meta.bytes) > 128 * 1024) throw Error('Text attachments must total 128 KB or less. Remove one first.');
        files(id).push(meta); save(id);
      }
      if (id === api.getState().projectId) { status(attachedLine(id), true); update(); }
      return size(meta.bytes);
    },
    take(id, ids) { held.set(id, new Set(ids)); const taken = files(id).filter(file => ids.includes(file.id)); if (id === api.getState().projectId) { status(); update(); } return taken; },
    giveBack(id) { if (!held.delete(id)) return; if (id === api.getState().projectId) { status(attachedLine(id), true); update(); } },
    accepted(id, ids) { held.delete(id); drafts.set(id, files(id).filter(file => !ids.includes(file.id))); save(id); pruneThumbnails(); if (id === api.getState().projectId) { status(); forceClosePreview(); update(); } },
    renderMessageAttachments(row, attachments = []) { if (!attachments.length) return; const host = el('div','message-attachments'), id = api.getState().projectId; for (const file of attachments) { const chip = button((file.kind === 'image' ? '▧ ' : '≡ ') + attachmentLabel(file) + (file.withheld ? ' · left out' : ''),'saved-attachment',() => openSaved(file,id)); if (file.plan) chip.title = 'What went with this message from the Plan. Select to read it.'; if (file.withheld) { chip.classList.add('withheld'); chip.title = `Not sent to the agent: ${file.withheld}.`; } host.append(chip); } row.append(host); },
  };
  sync();
})();

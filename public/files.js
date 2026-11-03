(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI;
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, cls, fn) => { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', fn); return node; };
  const size = bytes => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.ceil(bytes / 1024)) + ' KB';
  const drafts = new Map(), uploads = new Map(), thumbnails = new Map();
  let project = '', signature = '', treeVersion = 0, previewVersion = 0, selected = null, dragDepth = 0;
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
  function status(text = '') { $('attachment-status').textContent = text; $('attachment-status').hidden = !text; }
  function update() {
    const state = api.getState(), list = $('attachment-list'); list.replaceChildren();
    for (const file of files()) {
      const chip = el('div', 'attachment-chip');
      const open = button('', 'attachment-open', () => openSaved(file, state.projectId));
      open.append(el('span', 'file-glyph ' + (file.kind === 'image' ? 'image' : 'code'), file.kind === 'image' ? '▧' : '≡'), el('span', 'attachment-name', file.name), el('small', '', size(file.bytes)));
      if (file.kind === 'image' && thumbnails.has(file.id)) { const thumb=el('img','attachment-thumbnail'); thumb.src=thumbnails.get(file.id); thumb.alt=''; open.firstChild.remove(); open.prepend(thumb); }
      const remove = button('', 'attachment-remove', () => { drafts.set(state.projectId, files(state.projectId).filter(f => f.id !== file.id)); save(state.projectId); pruneThumbnails(); update(); });
      remove.setAttribute('aria-label', 'Remove ' + file.name); remove.disabled = Boolean(state.pending);
      chip.append(open, remove); list.append(chip);
    }
    list.hidden = !files().length;
    $('attach-files').disabled = !state.ready || Boolean(state.pending) || uploads.has(state.projectId);
    $('attach-files').title = 'Attach up to 6 files · PNG, JPEG, GIF, WebP (5 MB) or text/code (64 KB) · paste or drop also works';
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
        if (id === api.getState().projectId) status(errors || files(id).length + ' attached · sent with your next message');
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
  function closePreview() { previewVersion++; selected = null; $('file-preview').hidden = true; document.body.classList.remove('file-preview-open'); }
  function showPreview(file, label, id, saved = false) {
    selected = { file, projectId: id, saved };
    $('file-preview-name').textContent = file.name;
    $('file-preview-path').textContent = label;
    const content = $('file-preview-content'); content.replaceChildren();
    if (file.kind === 'image') { const img = el('img'); img.src = 'data:' + file.mime + ';base64,' + file.data; img.alt = file.name; content.append(img); }
    else {
      // Syntax colors come from the shared highlighter so previews match chat code blocks.
      const source = el('pre', 'file-source'), text = String(file.text || ''), lines = api.highlightLines ? api.highlightLines(text, file.name.split('.').at(-1)) : text.split('\n').map(line => [['', line]]);
      lines.forEach((tokens,index) => { const row = el('span', 'source-line'), code = el('code'); for (const [kind, value] of tokens) code.append(kind ? el('span', 'tok-' + kind, value) : document.createTextNode(value)); if (!tokens.length) code.textContent = ' '; row.append(el('span', 'line-number', String(index + 1)), code); source.append(row); });
      content.append(source);
    }
    $('file-preview-meta').textContent = size(file.bytes) + ' · ' + (file.kind === 'image' ? file.mime.replace('image/','').toUpperCase() : 'UTF-8 · ' + String(file.text || '').split('\n').length + ' lines') + ' · Read-only preview';
    $('attach-preview').disabled = saved && files(id).some(f => f.id === file.id);
    $('attach-preview').textContent = $('attach-preview').disabled ? 'Attached' : 'Attach to message';
    $('file-preview').hidden = false; document.body.classList.add('file-preview-open');
  }
  async function openSaved(file, id) {
    const version = ++previewVersion;
    try { const data = await api.api('/api/attachments/preview?id=' + encodeURIComponent(file.id), {}, id); if (version === previewVersion && id === api.getState().projectId) showPreview(data, 'Saved attachment', id, true); }
    catch (error) { if (version === previewVersion) api.showNotice(error.message); }
  }
  async function openFile(folder, entry, id) {
    const version = ++previewVersion;
    try {
      const file = await api.api('/api/files/preview?folderId=' + encodeURIComponent(folder.id) + '&path=' + encodeURIComponent(entry.path), {}, id);
      if (version !== previewVersion || id !== api.getState().projectId) return;
      showPreview(file, (folder.displayName || folder.name) + ' / ' + entry.path, id);
      return true;
    } catch (error) { if (version === previewVersion) api.showNotice(error.message); }
  }
  function directory(folder, relative, name, host, id, version, root = false) {
    const branch = el('div', 'tree-branch'), row = button('', 'tree-row tree-directory' + (root ? ' tree-root' : ''), toggle), children = el('div', 'tree-children');
    row.append(el('span','tree-chevron'), el('span','file-glyph folder'), el('span','tree-label',name));
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
          if (entry.kind === 'directory') directory(folder,entry.path,entry.name,children,id,version);
          else {
            const file = button('', 'tree-row tree-file', () => { for (const node of $('file-tree').querySelectorAll('.tree-file')) node.classList.remove('selected'); file.classList.add('selected'); openFile(folder,entry,id); });
            const ext = entry.name.split('.').at(-1).toLowerCase(), image = ['png','jpg','jpeg','gif','webp'].includes(ext);
            file.append(el('span','file-glyph ' + (image ? 'image' : ['js','jsx','ts','tsx','json'].includes(ext) ? 'script' : 'code'), image ? '▧' : ['js','jsx','ts','tsx'].includes(ext) ? ext.slice(0,2).toUpperCase() : '≡'), el('span','tree-label',entry.name)); file.title = entry.path; children.append(file);
          }
        }
        if (!result.entries.length && !offset) children.append(el('p','tree-note','No visible files'));
        if (result.nextOffset !== null) { const more = button('Load more…','tree-more', () => { more.disabled = true; load(result.nextOffset).then(ok => { if (ok) more.remove(); else more.disabled = false; }); }); children.append(more); }
        loaded = true; return true;
      } catch (error) { if (version === treeVersion) { if (!offset) children.replaceChildren(); const retry = button('Retry','tree-more',() => { retry.remove(); load(offset); }); children.append(el('p','tree-note',error.message),retry); } return false; }
      finally { loading = false; row.removeAttribute('aria-busy'); }
    }
    function toggle() { if (loading) return; const expanded = row.getAttribute('aria-expanded') === 'true'; row.setAttribute('aria-expanded',String(!expanded)); children.hidden = expanded; if (!expanded && !loaded) load(); }
    row.addEventListener('keydown',event => { if (event.key === 'ArrowRight' && children.hidden || event.key === 'ArrowLeft' && !children.hidden) { event.preventDefault(); toggle(); } });
    if (root) toggle();
  }
  function refreshTree() {
    const state = api.getState(), current = state.projects.find(p => p.id === state.projectId), tree = $('file-tree'), version = ++treeVersion;
    tree.replaceChildren();
    if (!current) { tree.append(el('p','tree-note','Add a workspace to browse its files.')); return; }
    // Only the folder selected in the sidebar is shown, so multi-folder workspaces stay readable.
    const folderId = api.selectedFolderId?.();
    for (const folder of (current.folders || []).filter(folder => !folderId || folder.id === folderId)) directory(folder,'',folder.displayName || folder.name,tree,state.projectId,version,true);
  }
  function sync() {
    const state = api.getState(), current = state.projects.find(p => p.id === state.projectId), next = JSON.stringify([state.projectId,current?.folders,api.selectedFolderId?.()]);
    if (signature !== next) { signature = next; closePreview(); refreshTree(); }
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
  $('close-file-preview').addEventListener('click',closePreview);
  $('attach-preview').addEventListener('click',async () => {
    if (!selected || api.getState().pending) return;
    const snapshot = selected;
    if (snapshot.projectId !== api.getState().projectId) return;
    const added = await addSnapshots([snapshot.file], snapshot.projectId);
    if (selected === snapshot && added?.length) { closePreview(); $('message-input').focus(); }
  });
  $('refresh-files').addEventListener('click',refreshTree);
  $('toggle-explorer').addEventListener('click', () => { const hidden = !$('file-tree').hidden; $('file-tree').hidden = hidden; $('explorer').classList.toggle('collapsed',hidden); $('toggle-explorer').setAttribute('aria-expanded',String(!hidden)); });
  window.addEventListener('keydown',event => { if (event.key === 'Escape' && !event.isComposing && !$('file-preview').hidden) closePreview(); });
  window.addEventListener('relay-state',sync);
  window.relayFiles = {
    async openAt(folderId, relative, line) {
      const state = api.getState(), id = state.projectId, folder = state.projects.find(project => project.id === id)?.folders.find(folder => folder.id === folderId);
      if (!folder) return api.showNotice('That folder is no longer in this workspace.');
      if (!await openFile(folder, { path: relative }, id)) return;
      if (id !== api.getState().projectId || !Number.isSafeInteger(line)) return;
      const target = $('file-preview-content').querySelectorAll('.source-line')[line - 1];
      if (target) { target.classList.add('review-line'); target.scrollIntoView({ block: 'center' }); }
    },
    ids: () => files().map(file => file.id), uploading: () => uploads.has(api.getState().projectId), addFiles, addSnapshots,
    accepted(id, ids) { drafts.set(id, files(id).filter(file => !ids.includes(file.id))); save(id); pruneThumbnails(); if (id === api.getState().projectId) { status(); closePreview(); update(); } },
    renderMessageAttachments(row, attachments = []) { if (!attachments.length) return; const host = el('div','message-attachments'), id = api.getState().projectId; for (const file of attachments) { const chip = button((file.kind === 'image' ? '▧ ' : '≡ ') + file.name + ' · ' + size(file.bytes),'saved-attachment',() => openSaved(file,id)); host.append(chip); } row.append(host); },
  };
  sync();
})();

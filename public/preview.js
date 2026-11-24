(() => {
  'use strict';
  // Point and tell (#19), in the page: opens the workspace's app in the desktop app's preview, a window for each
  // interface (#142), and puts what is picked in any of them into the message box as a sentence, with a screenshot of
  // the element attached. Design notes (#125) arrive the same way, as one numbered message with their screenshots, or
  // as a new card on the Plan. Nothing is sent: the person says or types what should change and sends it as usual, or
  // looks the card over and adds it. Only the desktop app has the preview; sketches (sketch.js) use the same two ways.
  const api = window.relayUI, bridge = window.relayDesktop;
  if (!api) return;
  const available = typeof bridge?.openPreview === 'function';
  const NOTES = 20000, IMAGES = 4;
  const imagesOf = value => (Array.isArray(value) ? value : []).filter(image => typeof image?.data === 'string' && image.data).slice(0, IMAGES);
  async function open(url) {
    if (!available) return false;
    const projectId = api.getState().projectId;
    if (!projectId) { api.showNotice('Open a workspace first.'); return false; }
    try { await bridge.openPreview({ projectId, url }); return true; }
    catch (error) { api.showNotice(String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); return false; }
  }
  // Into the message box: each starts its own line, so several can be described in one message, with its screenshots.
  async function toMessage({ text, images = [] }) {
    const input = document.getElementById('message-input');
    if (!input) return false;
    input.value = input.value.trim() ? `${input.value.trimEnd()}\n${text}` : text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const shots = imagesOf(images);
    if (shots.length) await window.relayFiles?.addSnapshots?.(shots.map(image => ({ name: image.name, data: image.data })), api.getState().projectId);
    return true;
  }
  // Onto the Plan (#125): a new card opens filled in, with the notes as its description and the screenshots attached, for
  // the person to choose who does it and add it. The screenshots are saved first; one that can't be is said and left out.
  async function toPlan({ title, text, files = [], images = [], role = 'frontend' }) {
    const attachments = [], problems = [];
    for (const image of imagesOf(images)) {
      try { const meta = await api.post('/api/attachments', { name: image.name, data: image.data }); if (!attachments.some(file => file.id === meta.id)) attachments.push({ id: meta.id, name: meta.name, kind: meta.kind, mime: meta.mime, bytes: meta.bytes }); }
      catch (error) { problems.push(error.message); }
    }
    const notes = text.length > NOTES ? `${text.slice(0, NOTES - 1).trimEnd()}…` : text;
    const opened = window.relayBoard?.open?.({ title: String(title || 'Design notes').slice(0, 200), notes, files: files.slice(0, 12).join(', '), role, attachments });
    if (!opened) { api.showNotice('The Plan couldn’t open, so the notes went into your message instead.'); await toMessage({ text, images }); return false; }
    if (problems.length) api.showNotice(`A screenshot couldn’t be attached: ${problems[0]}`);
    return true;
  }
  bridge?.onPreviewPick?.(async pick => {
    if (!pick || typeof pick !== 'object') return;
    if (pick.projectId && pick.projectId !== api.getState().projectId && api.getState().projects.some(project => project.id === pick.projectId)) await api.selectProject(pick.projectId);
    // The preview's Design notes asked for a sketch of a page that doesn't exist yet.
    if (pick.sketch) { window.relaySketch?.open?.(); return; }
    if (typeof pick.text !== 'string') return;
    const images = Array.isArray(pick.images) ? pick.images : pick.image ? [pick.image] : [];
    if (pick.design && pick.card && typeof pick.card === 'object') {
      if (await toPlan({ title: pick.card.title, text: pick.text, files: Array.isArray(pick.card.files) ? pick.card.files.filter(file => typeof file === 'string') : [], images })) api.announce?.('Your design notes are on a new card on the Plan. Choose who does it, then add it.');
      return;
    }
    if (!await toMessage({ text: pick.text, images })) return;
    api.announce?.(pick.design ? 'Your design notes are in the message box. Read them, then send.' : 'The element you picked is in the message box. Say or type what should change.');
  });
  // Stop review closes the windows showing the review's services in its workspace; other windows stay open.
  async function close(urls, projectId = api.getState().projectId) {
    if (typeof bridge?.closePreviews !== 'function' || !projectId || !Array.isArray(urls) || !urls.length) return 0;
    try { return await bridge.closePreviews({ projectId, urls }); } catch { return 0; }
  }
  window.relayPreview = { available, open, close, toMessage, toPlan };
})();

(() => {
  'use strict';
  // Point and tell (#19), in the page: opens the workspace's app in the desktop app's preview, a window for each
  // interface (#142), and puts what is picked in any of them into the message box as a sentence, with a screenshot of
  // the element attached. Design notes (#125) arrive the same way, as one numbered message with their screenshots.
  // Nothing is sent: the person says or types what should change and sends it as usual. Only the desktop app has the
  // preview.
  const api = window.relayUI, bridge = window.relayDesktop;
  if (!api) return;
  const available = typeof bridge?.openPreview === 'function';
  async function open(url) {
    if (!available) return false;
    const projectId = api.getState().projectId;
    if (!projectId) { api.showNotice('Open a workspace first.'); return false; }
    try { await bridge.openPreview({ projectId, url }); return true; }
    catch (error) { api.showNotice(String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); return false; }
  }
  bridge?.onPreviewPick?.(async pick => {
    if (!pick || typeof pick.text !== 'string') return;
    if (pick.projectId && pick.projectId !== api.getState().projectId && api.getState().projects.some(project => project.id === pick.projectId)) await api.selectProject(pick.projectId);
    const input = document.getElementById('message-input');
    if (!input) return;
    // Each pick starts its own line, so several can be described in one message.
    input.value = input.value.trim() ? `${input.value.trimEnd()}\n${pick.text}` : pick.text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Design notes (#125) bring their screenshots: the page with its numbered boxes, then sections it didn't show.
    const images = (Array.isArray(pick.images) ? pick.images : pick.image ? [pick.image] : []).filter(image => typeof image?.data === 'string' && image.data).slice(0, 4);
    if (images.length) await window.relayFiles?.addSnapshots?.(images.map(image => ({ name: image.name, data: image.data })), api.getState().projectId);
    api.announce?.(pick.design ? 'Your design notes are in the message box. Read them, then send.' : 'The element you picked is in the message box. Say or type what should change.');
  });
  // Stop review closes the windows showing the review's services in its workspace; other windows stay open.
  async function close(urls, projectId = api.getState().projectId) {
    if (typeof bridge?.closePreviews !== 'function' || !projectId || !Array.isArray(urls) || !urls.length) return 0;
    try { return await bridge.closePreviews({ projectId, urls }); } catch { return 0; }
  }
  window.relayPreview = { available, open, close };
})();

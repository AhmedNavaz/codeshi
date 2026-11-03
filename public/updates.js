(() => {
  'use strict';
  const bridge = window.relayDesktop, api = window.relayUI, $ = id => document.getElementById(id), dialog = $('updates-dialog');
  if (!bridge?.getLaunchState || !bridge?.acknowledgeUpdate) return;
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  let launch, pending = false, busy = false, returnFocus = null;
  const ready = Promise.all([bridge.getLaunchState(), window.relaySetup?.ready]).then(([state, preferences]) => {
    launch = state; pending = state.updated && preferences?.firstRun === false; maybeShow();
  }).catch(error => api.showNotice('Update details could not be loaded. ' + error.message));
  function render(automatic) {
    $('updates-eyebrow').textContent = automatic ? 'UPDATE INSTALLED' : 'WHAT’S NEW';
    $('updates-title').textContent = `Codeshi ${launch.version}`;
    $('updates-description').textContent = automatic ? launch.previousVersion ? `Updated from ${launch.previousVersion}. Your workspace is ready to continue.` : 'Your update is installed. Your workspace is ready to continue.' : 'Features and improvements in your installed version.';
    const content = $('updates-content'); content.replaceChildren();
    if (!launch.releases?.length) content.append(node('p', 'Release details are not bundled with this build. You can view the full release notes below.', 'updates-empty'));
    for (const [index, release] of (launch.releases || []).entries()) {
      if (!release.sections?.length) continue;
      const entry = node(index ? 'details' : 'section', undefined, 'updates-release');
      if (index) entry.append(node('summary', `Also included · ${release.version}`));
      const body = node('div', undefined, 'updates-release-body');
      if (!index) body.append(node('h3', `In ${release.version}`));
      for (const section of release.sections) {
        if (!section.items?.length) continue;
        body.append(node('h4', section.title));
        const items = node('ul'); for (const text of section.items) items.append(node('li', text)); body.append(items);
      }
      entry.append(body); content.append(entry);
    }
    if (!content.children.length) content.append(node('p', 'Release details are not bundled with this build. You can view the full release notes below.', 'updates-empty'));
  }
  function show(automatic) {
    if (!launch || document.querySelector('dialog[open]')) return false;
    pending = false; returnFocus = document.activeElement; render(automatic); dialog.showModal(); $('updates-dismiss').focus(); return true;
  }
  function maybeShow() { if (pending && !api.getState().loading) show(true); }
  async function dismiss() {
    if (busy) return; busy = true;
    $('updates-dismiss').disabled = true; $('updates-close').disabled = true;
    try { launch = await bridge.acknowledgeUpdate(); }
    catch (error) { api.showNotice('Could not save the update dismissal. It may appear again next time. ' + error.message); }
    finally {
      pending = false; dialog.close(); busy = false;
      $('updates-dismiss').disabled = false; $('updates-close').disabled = false;
      returnFocus?.focus();
    }
  }
  $('updates-dismiss').addEventListener('click', dismiss);
  $('updates-close').addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  $('updates-release-notes').addEventListener('click', () => {
    bridge.openExternal('https://github.com/AhmedNavaz/codeshi/releases').catch(error => api.showNotice(error.message));
  });
  window.addEventListener('relay-state', maybeShow);
  document.addEventListener('close', maybeShow, true);
  window.relayUpdates = { async open() { await ready; return show(false); } };
})();

(() => {
  'use strict';
  const bridge = window.relayDesktop, api = window.relayUI, $ = id => document.getElementById(id), dialog = $('updates-dialog');
  if (!bridge?.getLaunchState || !bridge?.acknowledgeUpdate) return;
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  const repository = 'https://github.com/AhmedNavaz/codeshi', patreon = 'https://www.patreon.com/17048317/join';
  const external = url => bridge.openExternal(url).catch(error => api.showNotice(error.message));
  // A contributor's name opens their GitHub profile. The address is built here from the login alone.
  const profile = login => { const link = node('button', `@${login}`, 'text-link updates-contributor'); link.type = 'button'; link.title = `${login} on GitHub`; link.addEventListener('click', () => external(`https://github.com/${encodeURIComponent(login)}`)); return link; };
  // "Thanks to @name for the import fixes." as the changelog wrote it, or the names alone where it only named them.
  function thanks(list) {
    const people = (Array.isArray(list) ? list : []).filter(item => /^[A-Za-z\d][A-Za-z\d-]{0,38}$/.test(item?.login || ''));
    if (!people.length) return null;
    const block = node('div', undefined, 'updates-thanks'), line = parts => { const row = node('p'); row.append(...parts); block.append(row); };
    block.append(node('h4', 'Thank you'));
    const named = [], shown = new Set();
    for (const person of people) {
      const text = String(person.text || ''), at = text.indexOf(`@${person.login}`);
      if (at < 0) { named.push(person); continue; }
      // A sentence that thanks several people links each of them, and is shown once.
      if (shown.has(text)) continue; shown.add(text);
      const parts = []; let rest = text;
      for (const other of people.filter(item => text.includes(`@${item.login}`)).sort((a, b) => text.indexOf(`@${a.login}`) - text.indexOf(`@${b.login}`))) {
        const index = rest.indexOf(`@${other.login}`); if (index < 0) continue;
        parts.push(rest.slice(0, index), profile(other.login)); rest = rest.slice(index + other.login.length + 1);
      }
      line([...parts, rest]);
    }
    if (named.length) line(['Thanks to ', ...named.flatMap((person, index) => [index ? index === named.length - 1 ? ' and ' : ', ' : '', profile(person.login)]), ' for contributing to this release.']);
    return block;
  }
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
        const items = node('ul');
        for (const item of section.items) {
          const title = typeof item === 'string' ? '' : item?.title || '', text = typeof item === 'string' ? item : item?.text || '';
          if (!title && !text) continue;
          const row = node('li');
          if (title) row.append(node('strong', title));
          if (text) row.append(node('span', text));
          items.append(row);
        }
        body.append(items);
      }
      const credit = thanks(release.thanks); if (credit) body.append(credit);
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
  $('updates-release-notes').addEventListener('click', () => external(`${repository}/releases`));
  $('updates-star').addEventListener('click', () => external(repository));
  $('updates-patreon').addEventListener('click', () => external(patreon));
  window.addEventListener('relay-state', maybeShow);
  document.addEventListener('close', maybeShow, true);
  window.relayUpdates = { async open() { await ready; return show(false); } };
})();

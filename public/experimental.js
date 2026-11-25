(() => {
  'use strict';
  // Experimental features (#176): the newer parts of Codeshi, each with a switch in Settings › Experimental. Most are
  // on by default; Smart results (#190) starts off. A feature that is off disappears from the window: the flag is set
  // on the page, and the page's styles and scripts leave its entry points out. The last answer is kept in the browser
  // so a reload doesn't flash what is off.
  const t = text => window.codeshiText ? window.codeshiText.t(text) : text; // i18n-ignore
  const FEATURES = [
    { id: 'remote', name: t('Remote access'), description: t('Use this workspace from your phone or tablet, on the same Wi-Fi or away from home.') },
    { id: 'plan', name: t('Plan'), description: t('The Plan view: cards on a canvas, in columns or as a list, each run as its own task you review and merge.') },
    { id: 'review', name: t('Run and review your project'), description: t('A launch map for your app, with live services, a preview, and pointing at what to change.') },
    { id: 'smartResults', default: false, name: t('Smart results'), description: t('What Smart, Saver and Ultra routing saved, worked out from your own tasks on this computer.') },
    { id: 'tasks', name: t('Tasks side by side'), description: t('Independent tasks in folders beside the Workspace chat, each with its own output, approvals and review.') },
  ];
  const KEY = 'codeshi:experimental', listeners = new Set();
  const defaultFor = item => item.default !== false;
  let flags = Object.fromEntries(FEATURES.map(item => [item.id, defaultFor(item)]));
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const item of FEATURES) if (typeof stored?.[item.id] === 'boolean') flags[item.id] = stored[item.id];
  } catch { /* Defaults apply. */ }
  const apply = () => {
    const root = document.documentElement;
    for (const { id } of FEATURES) root.dataset[`exp${id[0].toUpperCase()}${id.slice(1)}`] = flags[id] === false ? 'off' : 'on';
    try { localStorage.setItem(KEY, JSON.stringify(flags)); } catch { /* A convenience only. */ }
  };
  const take = value => {
    for (const item of FEATURES) flags[item.id] = typeof value?.[item.id] === 'boolean' ? value[item.id] : defaultFor(item);
    apply();
    for (const listener of listeners) listener(flags);
  };
  apply();
  // The one badge every place uses, so each experimental feature is marked the same way.
  const badge = () => { const mark = document.createElement('span'); mark.className = 'experimental-badge'; mark.textContent = t('Experimental'); mark.title = t('Experimental: it may change, and you can turn it off in Settings › Experimental.'); return mark; };
  const load = () => fetch('/api/preferences').then(response => response.ok ? response.json() : null).then(value => { if (value?.experimental) take(value.experimental); }).catch(() => {});
  window.relayExperimental = {
    features: FEATURES, badge,
    enabled: id => flags[id] !== false,
    onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async set(id, value) {
      const response = await fetch('/api/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { [id]: value } }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'This could not be saved.');
      take(result.experimental);
    },
    reload: load,
  };
  // Places in the page's own markup that carry the badge: <span data-experimental-mark></span>.
  const mark = () => document.querySelectorAll('[data-experimental-mark]:empty').forEach(place => place.append(badge()));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mark); else mark();
  load();
})();

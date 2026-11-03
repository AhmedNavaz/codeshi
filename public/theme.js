(() => {
  'use strict';
  const key = 'ai-relay:appearance', choices = ['system', 'graphite', 'light'];
  // The OS appearance in a browser. In the desktop app the main process also points it at a saved Light or
  // Dark choice, so the first palette is right before the saved preference arrives.
  const system = window.matchMedia?.('(prefers-color-scheme: dark)');
  let revision = 0, saving = Promise.resolve(), preference = 'system';
  const headers = () => window.relayDesktop?.token ? { 'X-AI-Relay-Token': window.relayDesktop.token } : {};
  function message(text = '') { const status = document.getElementById('appearance-status'); if (status) status.textContent = text; }
  // The preference is saved and cached; the palette is what it resolves to now.
  function apply(value, save = false) {
    preference = choices.includes(value) ? value : 'system';
    const theme = preference === 'system' ? (system?.matches === false ? 'light' : 'graphite') : preference;
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'graphite' ? '#161513' : '#f4efe6');
    document.querySelectorAll('[data-appearance]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.appearance === preference)));
    try { localStorage.setItem(key, preference); } catch { /* Appearance also works without storage. */ }
    if (save) {
      const chosen = preference;
      revision++;
      saving = saving.catch(() => {}).then(async () => {
        try {
          const response = await fetch('/api/appearance', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify({ theme: chosen }) });
          if (!response.ok) throw new Error();
          message();
        } catch { message('Appearance could not be saved. Choose it again to retry.'); }
      });
    }
  }
  // The macOS desktop window draws its own title bar; leave room for the window controls.
  if (window.relayDesktop?.platform === 'darwin') document.documentElement.classList.add('mac-titlebar');
  let initial;
  try { initial = localStorage.getItem(key); } catch {}
  apply(initial);
  fetch('/api/appearance', { headers: headers() }).then(response => response.ok ? response.json() : null).then(saved => {
    if (!revision && choices.includes(saved?.theme)) apply(saved.theme);
  }).catch(() => {});
  // Only System follows the OS. A Light or Dark choice stays as it is.
  system?.addEventListener?.('change', () => { if (preference === 'system') apply('system'); });
  // The status bar's buttons are bound here; setup and Settings bind the controls they draw.
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('appearance-options')?.querySelectorAll('[data-appearance]').forEach(button => button.addEventListener('click', () => apply(button.dataset.appearance, true)));
    apply(preference);
  });
  // Every [data-appearance] control shows the current preference, wherever it is drawn.
  window.relayTheme = { choose: value => apply(value, true), preference: () => preference, current: () => document.documentElement.getAttribute('data-theme') || 'graphite' };
  window.addEventListener('storage', event => { if (event.key === key) apply(event.newValue); });
})();

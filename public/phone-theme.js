(() => {
  'use strict';
  // The phone's own appearance, kept in this browser. The computer's setting is left alone: it's saved for the whole app, so
  // choosing it here would also change the desktop window. Loaded before the page draws, so it never flashes the wrong colours.
  const KEY = 'codeshi:phone-theme', CHOICES = ['system', 'light', 'graphite'], BAR = { graphite: '#161513', light: '#f4efe6' };
  const system = window.matchMedia?.('(prefers-color-scheme: dark)');
  let choice = 'system';
  try { const saved = localStorage.getItem(KEY); if (CHOICES.includes(saved)) choice = saved; } catch { /* Follows the phone, then. */ }
  function apply() {
    const theme = choice === 'system' ? (system?.matches === false ? 'light' : 'graphite') : choice;
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR[theme]);
  }
  apply();
  system?.addEventListener?.('change', apply);
  window.relayPhoneTheme = {
    choice: () => choice,
    choose(value) {
      if (!CHOICES.includes(value)) return;
      choice = value;
      try { localStorage.setItem(KEY, value); } catch { /* It still applies until the page reloads. */ }
      apply();
    },
  };
})();

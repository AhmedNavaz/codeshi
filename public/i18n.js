// Translation (#27). The English is written in the code and is also the key: t('Keep awake') gives the chosen
// language's words, or the English when a catalog has none. Catalogs are JSON files in public/locales/; the server
// sends the chosen one as /locale.js, which runs before any other page script, so there is no build step. The same
// file gives the desktop menus their words, through src/i18n.mjs.
//
//   t('Keep awake')                                  a fixed text
//   t('Use {agent} for your next message', { agent }) a text with a value in it
//   tn(count, 'One file changed', '{count} files changed')
//                                                    a text that depends on a number; the catalog keys it by the
//                                                    second form and gives each plural form its language has
//
// Write each sentence whole, with its values as {names}, so a translation can put them in its own order. Never build
// a sentence from pieces, and pass t() a plain quoted string, so `npm run i18n` can find it.
(() => {
  'use strict';
  // Text that is never translated in the page: code, the terminal, and anything marked translate="no".
  const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'CODE', 'PRE', 'TEXTAREA', 'KBD', 'NOSCRIPT']);
  const ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt'];
  const tidy = text => String(text).replace(/\s+/g, ' ').trim();
  // Names stay as they are in every language, wherever they appear on their own.
  const NAMES = new Set(['Codeshi', 'Codex', 'Claude', 'Claude Code', 'Gemini', 'Flow', 'Ollama', 'GitHub', 'Git', 'Antigravity', 'Firebase', 'English']);

  function create() {
    let language = 'en', direction = 'ltr', messages = Object.create(null), size = 0, plurals = null, numbers = null;
    const value = key => NAMES.has(key) ? undefined : messages[key];
    const fill = (text, values) => !values ? text : text.replace(/\{(\w+)\}/g, (all, name) => {
      if (!Object.prototype.hasOwnProperty.call(values, name)) return all;
      const item = values[name];
      return typeof item === 'number' ? (numbers ||= new Intl.NumberFormat(language)).format(item) : String(item);
    });
    function t(text, values) { const found = value(text); return fill(typeof found === 'string' && found ? found : text, values); }
    function tn(count, one, other, values) {
      const all = { count, ...values }, found = value(other);
      if (found && typeof found === 'object') {
        const form = found[(plurals ||= new Intl.PluralRules(language)).select(count)] || found.other;
        if (typeof form === 'string' && form) return fill(form, all);
      }
      return fill(count === 1 ? one : other, all);
    }
    // A text from the page's HTML, matched with its spaces tidied as the catalog keeps it; null when it has none.
    function lookup(text) { const found = value(tidy(text)); return typeof found === 'string' && found ? found : null; }
    function translate(root) {
      if (!size || !root) return;
      const visit = node => {
        if (node.nodeType === 3) {
          const raw = node.data, text = raw.trim(), next = text && lookup(text);
          if (next) node.data = raw.slice(0, raw.indexOf(text)) + next + raw.slice(raw.indexOf(text) + text.length);
          return;
        }
        if (node.nodeType === 1) {
          if (SKIP.has(String(node.nodeName).toUpperCase()) || node.getAttribute?.('translate') === 'no') return;
          for (const name of ATTRIBUTES) { const text = node.getAttribute?.(name), next = text && lookup(text); if (next) node.setAttribute(name, next); }
          if (node.content?.childNodes) [...node.content.childNodes].forEach(visit);
        }
        if (node.childNodes) [...node.childNodes].forEach(visit);
      };
      visit(root);
    }
    // Sets the language and its catalog. In a page it also names the language for screen readers and spell checking,
    // and translates the page's own HTML once, before the scripts that draw the rest of it.
    function load({ language: chosen = 'en', direction: way = 'ltr', messages: catalog = null } = {}) {
      language = typeof chosen === 'string' && chosen ? chosen : 'en'; direction = way === 'rtl' ? 'rtl' : 'ltr';
      messages = Object.create(null); size = 0; plurals = null; numbers = null;
      if (catalog && typeof catalog === 'object') for (const [key, item] of Object.entries(catalog)) if (!key.startsWith('$') && (typeof item === 'string' ? item : item && typeof item === 'object')) { messages[key] = item; size++; }
      if (typeof document === 'object' && document?.documentElement) {
        document.documentElement.setAttribute?.('lang', language);
        document.documentElement.setAttribute?.('dir', direction);
        translate(document.body);
      }
      return api;
    }
    const api = { t, tn, load, translate, tidy, names: NAMES, get language() { return language; }, get direction() { return direction; }, get size() { return size; } };
    return api;
  }
  const text = create();
  text.create = create;
  (typeof window === 'object' && window ? window : globalThis).codeshiText = text;
})();

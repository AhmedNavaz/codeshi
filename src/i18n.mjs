// Translation on the computer's side (#27): which catalogs exist, which language to use, and the words for the
// desktop menus. The page and the menus share public/i18n.js, so a text is translated the same way in both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../public/i18n.js';

const shared = globalThis.codeshiText;
export const createText = shared.create;
export const tidy = shared.tidy;
// English needs no catalog: it is the text in the code.
export const english = createText();
export const localesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');
// A catalog is named by its BCP 47 tag, such as es.json or pt-BR.json. en-XA is the pseudo-language `npm run i18n`
// writes for checking what is still untranslated; it is offered in Settings but never chosen by the system.
const TAG = /^[a-z]{2,3}(?:-[A-Z][A-Za-z]{1,3}|-[0-9]{3})?$/;
export const PSEUDO = 'en-XA';

function read(dir, id) {
  if (!TAG.test(id) || id === 'en') return null;
  let data; try { data = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); } catch { return null; }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

// The languages Settings offers: English and each catalog in the folder, by the name it gives itself.
export function languages(dir = localesDir) {
  let files = []; try { files = fs.readdirSync(dir); } catch { /* No catalogs: English only. */ }
  const found = files.filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).filter(id => TAG.test(id) && id !== 'en').sort()
    .map(id => { const data = read(dir, id); return data && { id, name: typeof data.$name === 'string' && data.$name.trim() ? data.$name.trim().slice(0, 60) : id, direction: data.$direction === 'rtl' ? 'rtl' : 'ltr' }; }).filter(Boolean);
  return [{ id: 'en', name: 'English', direction: 'ltr' }, ...found];
}

// The language to use: the one chosen in Settings when it still has a catalog, otherwise the first of the system's
// languages that has one, matching a region to its language (es-MX uses es), otherwise English.
export function chooseLanguage(preference, system = [], available = languages()) {
  const ids = available.map(item => item.id);
  if (preference && preference !== 'system' && ids.includes(preference)) return preference;
  const wanted = (Array.isArray(system) ? system : String(system || '').split(','))
    .map((item, index) => { const [tag, ...rest] = String(item).trim().split(';'); const q = Number((rest.find(part => part.trim().startsWith('q=')) || 'q=1').trim().slice(2)); return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index }; })
    .filter(item => item.tag && item.tag !== '*' && item.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  const choosable = ids.filter(id => id !== PSEUDO), lower = choosable.map(id => id.toLowerCase());
  for (const { tag } of wanted) {
    const exact = lower.indexOf(tag.toLowerCase()); if (exact >= 0) return choosable[exact];
    const base = tag.split('-')[0].toLowerCase(); if (base === 'en') return 'en';
    const near = lower.indexOf(base); if (near >= 0) return choosable[near];
  }
  return 'en';
}

// What /locale.js hands the page, and the menus' words: the language, its direction and its catalog.
export function catalog(id, dir = localesDir) {
  const data = id === 'en' ? null : read(dir, id);
  if (!data) return { language: 'en', direction: 'ltr', messages: {} };
  const messages = {};
  for (const [key, item] of Object.entries(data)) if (!key.startsWith('$') && (typeof item === 'string' || (item && typeof item === 'object' && !Array.isArray(item)))) messages[key] = item;
  return { language: id, direction: data.$direction === 'rtl' ? 'rtl' : 'ltr', messages };
}
export const textFor = (id, dir = localesDir) => createText().load(catalog(id, dir));

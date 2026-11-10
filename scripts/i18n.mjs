// Finds the interface's translatable texts and keeps catalogs in step with them (#27). No build step: the app reads
// the catalogs as they are.
//
//   npm run i18n                 how complete each catalog is, and any problems
//   npm run i18n -- es           create or update public/locales/es.json, adding new texts with empty translations
//   npm run i18n -- --pseudo     write public/locales/en-XA.json, accented and padded, to see what is still English
//
// Texts come from public/index.html (its text and its title, aria-label, aria-description, placeholder and alt
// attributes) and from every t('…') and tn(count, '…', '…') in public/*.js and desktop/*.mjs. A line that passes t() a text
// translated elsewhere ends with // i18n-ignore.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { english, PSEUDO, tidy } from '../src/i18n.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt'];
const SKIPPED = ['script', 'style', 'svg', 'code', 'pre', 'textarea', 'kbd', 'noscript'];
const letters = /\p{L}/u;

const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, code) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[code.toLowerCase()]
  ?? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))));

// The page's own texts, as the page pass in public/i18n.js meets them: the body only, without code or icons.
export function fromHTML(html) {
  let body = (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] || '').replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of SKIPPED) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi'), '');
  const found = [];
  for (const [, attributes] of body.matchAll(/<[a-z][\w-]*\b([^>]*)>/gi))
    for (const [, name, value] of attributes.matchAll(/\s([\w-]+)="([^"]*)"/g)) if (ATTRIBUTES.includes(name.toLowerCase())) found.push(tidy(decode(value)));
  for (const [, text] of body.matchAll(/>([^<>]+)</g)) found.push(tidy(decode(text)));
  return found.filter(text => letters.test(text));
}

// A quoted JavaScript string, or null when the argument is anything else, such as a template with a value in it.
function literal(source) {
  const text = source.trim(), quote = text[0];
  if (!['"', "'", '`'].includes(quote) || text.at(-1) !== quote || text.length < 2) return null;
  const inner = text.slice(1, -1);
  if (quote === '`' && inner.includes('${')) return null;
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === quote) return null;
    if (char !== '\\') { out += char; continue; }
    const next = inner[++i];
    if (next === 'n') out += '\n'; else if (next === 't') out += '\t';
    else if (next === 'u') { const braced = inner[i + 1] === '{', end = braced ? inner.indexOf('}', i) : i + 4; out += String.fromCodePoint(parseInt(inner.slice(i + (braced ? 2 : 1), end + (braced ? 0 : 1)), 16)); i = end; }
    else out += next;
  }
  return out;
}
// The arguments of a call that starts at `at`, split at its top-level commas, skipping over strings and brackets.
function argumentsAt(source, at) {
  const parts = []; let depth = 0, start = at, quote = null;
  for (let i = at; i < source.length; i++) {
    const char = source[i];
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) { if (!depth) { parts.push(source.slice(start, i)); return parts; } depth--; }
    else if (char === ',' && !depth) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  return parts;
}
// Every t() and tn() in a script: the texts, and the calls whose text can't be read because it isn't a plain string.
export function fromScript(source, file = '') {
  const texts = [], plurals = [], unreadable = [];
  const lines = source.split('\n');
  for (const match of source.matchAll(/\b(tn?)\(/g)) {
    const args = argumentsAt(source, match.index + match[0].length), line = source.slice(0, match.index).split('\n').length;
    // A call that passes on a text translated elsewhere says so, and is left alone.
    if (lines[line - 1].includes('// i18n-ignore')) continue;
    if (match[1] === 't') { const text = literal(args[0] || ''); if (text) texts.push(text); else unreadable.push(`${file}:${line}`); continue; }
    const one = literal(args[1] || ''), other = literal(args[2] || '');
    if (one && other) plurals.push({ one, other }); else unreadable.push(`${file}:${line}`);
  }
  return { texts, plurals, unreadable };
}

// Everything to translate: { key: null } for a text, { key: { one } } for a text that depends on a number.
export function extract(base = root) {
  const keys = new Map(), unreadable = [];
  for (const text of fromHTML(fs.readFileSync(path.join(base, 'public', 'index.html'), 'utf8'))) if (!keys.has(text)) keys.set(text, null);
  const scripts = [
    ...fs.readdirSync(path.join(base, 'public')).filter(name => name.endsWith('.js') && name !== 'i18n.js').sort().map(name => path.join('public', name)),
    ...fs.readdirSync(path.join(base, 'desktop')).filter(name => name.endsWith('.mjs')).sort().map(name => path.join('desktop', name)),
  ];
  for (const file of scripts) {
    const found = fromScript(fs.readFileSync(path.join(base, file), 'utf8'), file);
    for (const text of found.texts) if (!keys.has(text)) keys.set(text, null);
    for (const { one, other } of found.plurals) keys.set(other, { one });
    unreadable.push(...found.unreadable);
  }
  // Product and agent names are never translated, so they aren't listed.
  for (const name of english.names) keys.delete(name);
  return { keys, unreadable };
}

const names = text => new Set([...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]));
// What is wrong with one translation: a {value} it adds that the English doesn't have, or one it leaves out.
export function problems(key, entry, source) {
  const wanted = new Set([...names(key), ...names(source?.one || '')]), found = [];
  const forms = typeof entry === 'string' ? (entry ? [['', entry]] : []) : Object.entries(entry || {}).filter(([, text]) => typeof text === 'string' && text);
  for (const [form, text] of forms) {
    const has = names(text), where = form ? ` (${form})` : '';
    for (const name of has) if (!wanted.has(name)) found.push(`“${key}”${where} has {${name}}, which the English doesn’t`);
    for (const name of wanted) if (name !== 'count' && !has.has(name)) found.push(`“${key}”${where} leaves out {${name}}`);
  }
  return found;
}

// Report how complete each catalog is.
export function report(base = root) {
  const { keys, unreadable } = extract(base), dir = path.join(base, 'public', 'locales'), lines = [`${keys.size} texts to translate.`];
  if (unreadable.length) lines.push(`${unreadable.length} t() calls without a plain quoted text, which can't be translated: ${unreadable.slice(0, 8).join(', ')}${unreadable.length > 8 ? ', …' : ''}`);
  let files = []; try { files = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort(); } catch { /* None yet. */ }
  let failed = false;
  for (const file of files) {
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), done = [...keys.keys()].filter(key => { const entry = catalog[key]; return typeof entry === 'string' ? Boolean(entry) : Boolean(entry && Object.values(entry).some(Boolean)); });
    const stale = Object.keys(catalog).filter(key => !key.startsWith('$') && !keys.has(key)), wrong = Object.entries(catalog).filter(([key]) => !key.startsWith('$')).flatMap(([key, entry]) => problems(key, entry, keys.get(key)));
    lines.push(`${file.slice(0, -5)}: ${done.length} of ${keys.size} translated (${Math.floor(done.length / Math.max(keys.size, 1) * 100)}%)${stale.length ? `, ${stale.length} no longer used` : ''}${wrong.length ? `, ${wrong.length} problems` : ''}`);
    for (const problem of wrong) lines.push(`  ${problem}`);
    if (wrong.length) failed = true;
  }
  if (!files.length) lines.push('No catalogs yet. Add one with: npm run i18n -- <language>, for example es or pt-BR.');
  return { text: lines.join('\n'), failed };
}

// A new or updated catalog: its translations kept, new texts added empty, and texts the app no longer has left out.
export function update(id, base = root) {
  if (!/^[a-z]{2,3}(?:-[A-Z][A-Za-z]{1,3}|-[0-9]{3})?$/.test(id) || id === 'en') throw new Error('Name a language by its tag, such as es, fr or pt-BR. English is the text in the code and has no catalog.');
  const dir = path.join(base, 'public', 'locales'), file = path.join(dir, `${id}.json`), { keys } = extract(base);
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  let name = id; try { name = new Intl.DisplayNames([id], { type: 'language' }).of(id) || id; } catch { /* The tag stands for its name. */ }
  const categories = new Intl.PluralRules(id).resolvedOptions().pluralCategories;
  const next = { $name: old.$name || name.charAt(0).toLocaleUpperCase(id) + name.slice(1), $direction: old.$direction || (['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'yi'].includes(id.split('-')[0]) ? 'rtl' : 'ltr') };
  for (const [key, plural] of keys) {
    const previous = old[key];
    if (!plural) next[key] = typeof previous === 'string' ? previous : '';
    else next[key] = Object.fromEntries(categories.map(form => [form, typeof previous?.[form] === 'string' ? previous[form] : '']));
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return { file, count: keys.size };
}

// Accented and about a third longer, inside brackets, with {values} left alone: anything still plain is untranslated,
// and anything cut off has no room to grow.
const ACCENTS = { a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž', A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž' };
export function pseudo(text) {
  const accented = String(text).split(/(\{\w+\})/).map(part => /^\{\w+\}$/.test(part) ? part : [...part].map(char => ACCENTS[char] || char).join('')).join('');
  return `⟦${accented}${'·'.repeat(Math.ceil(String(text).length * 0.3))}⟧`;
}
export function writePseudo(base = root) {
  const { keys } = extract(base), dir = path.join(base, 'public', 'locales'), out = { $name: 'Pseudo (for testing)', $direction: 'ltr' };
  for (const [key, plural] of keys) out[key] = plural ? { one: pseudo(plural.one), other: pseudo(key) } : pseudo(key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${PSEUDO}.json`); fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return { file, count: keys.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [arg] = process.argv.slice(2);
  try {
    if (!arg) { const { text, failed } = report(); console.log(text); process.exitCode = failed ? 1 : 0; }
    else if (arg === '--pseudo') { const { file, count } = writePseudo(); console.log(`Wrote ${path.relative(root, file)} with ${count} texts. Choose “Pseudo (for testing)” in Settings › General › Language.`); }
    else { const { file, count } = update(arg); console.log(`Updated ${path.relative(root, file)}: ${count} texts. Fill in the empty ones; an empty one shows the English.`); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

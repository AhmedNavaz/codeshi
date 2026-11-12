import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catalog, chooseLanguage, createText, english, languages, PSEUDO, textFor } from '../src/i18n.mjs';
import { extract, fromHTML, fromScript, problems, pseudo, update } from '../scripts/i18n.mjs';
import { menuTemplate } from '../desktop/menu.mjs';
import { statusMenu, statusTitle } from '../desktop/status.mjs';

const folder = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-i18n-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('English is the text in the code, and a catalog replaces it text by text (#27)', () => {
  assert.equal(english.t('Keep awake'), 'Keep awake');
  assert.equal(english.t('Use {agent} for your next message', { agent: 'Codex' }), 'Use Codex for your next message');
  assert.equal(english.tn(1, '1 file changed', '{count} files changed'), '1 file changed');
  assert.equal(english.tn(1200, '1 file changed', '{count} files changed'), '1,200 files changed', 'Numbers are written the language’s way.');
  const es = createText().load({ language: 'es', messages: { 'Keep awake': 'Mantener activo', 'Use {agent} for your next message': 'Usar {agent} para el próximo mensaje', '{count} files changed': { one: '{count} archivo cambiado', other: '{count} archivos cambiados' }, Empty: '' } });
  assert.equal(es.t('Keep awake'), 'Mantener activo');
  assert.equal(es.t('Use {agent} for your next message', { agent: 'Claude' }), 'Usar Claude para el próximo mensaje');
  assert.equal(es.tn(1, '1 file changed', '{count} files changed'), '1 archivo cambiado');
  assert.equal(es.tn(1200, '1 file changed', '{count} files changed'), '1200 archivos cambiados');
  assert.equal(es.t('Empty'), 'Empty', 'An empty translation shows the English.');
  assert.equal(es.t('Not in the catalog'), 'Not in the catalog');
  assert.equal(es.t('{unknown} stays', {}), '{unknown} stays', 'A value that wasn’t given is left as written.');
  // A language with more plural forms than English picks the right one, and falls back to other.
  const pl = createText().load({ language: 'pl', messages: { '{count} files': { one: '{count} plik', few: '{count} pliki', many: '{count} plików', other: '{count} pliku' } } });
  assert.deepEqual([1, 3, 5, 22].map(count => pl.tn(count, '1 file', '{count} files')), ['1 plik', '3 pliki', '5 plików', '22 pliki']);
  const partial = createText().load({ language: 'pl', messages: { '{count} files': { other: '{count} pliku' } } });
  assert.equal(partial.tn(3, '1 file', '{count} files'), '3 pliku');
  // Keys starting with $ describe the catalog and are never texts.
  assert.equal(createText().load({ language: 'es', messages: { $name: 'Español' } }).t('$name'), '$name');
});

// A small DOM: elements with attributes and children, and text nodes.
function element(name, attributes = {}, children = []) {
  const node = { nodeType: 1, nodeName: name.toUpperCase(), attributes: { ...attributes }, childNodes: [],
    getAttribute: key => node.attributes[key] ?? null, setAttribute: (key, value) => { node.attributes[key] = String(value); } };
  for (const child of children) node.childNodes.push(typeof child === 'string' ? { nodeType: 3, data: child } : child);
  return node;
}

test('the page’s own HTML is translated once, its text and labels, but never code or what is marked translate="no" (#27)', () => {
  const button = element('button', { title: 'Refresh   files', 'aria-label': 'Refresh files', 'data-x': 'Refresh files' }, ['\n   Refresh\n      files  ']);
  const code = element('code', {}, ['Refresh files']), kept = element('span', { translate: 'no' }, ['Refresh files']), icon = element('svg', {}, [element('title', {}, ['Refresh files'])]);
  const body = element('body', {}, [button, code, kept, icon, element('p', {}, ['Unknown words'])]);
  const text = createText().load({ language: 'fr', messages: { 'Refresh files': 'Actualiser les fichiers' } });
  text.translate(body);
  assert.equal(button.childNodes[0].data, '\n   Actualiser les fichiers  ', 'Spaces around the text stay; spaces inside are tidied to match.');
  assert.equal(button.attributes.title, 'Actualiser les fichiers');
  assert.equal(button.attributes['aria-label'], 'Actualiser les fichiers');
  assert.equal(button.attributes['data-x'], 'Refresh files', 'Only attributes people read or hear are translated.');
  assert.equal(code.childNodes[0].data, 'Refresh files');
  assert.equal(kept.childNodes[0].data, 'Refresh files');
  assert.equal(icon.childNodes[0].childNodes[0].data, 'Refresh files');
  assert.equal(body.childNodes[4].childNodes[0].data, 'Unknown words');
});

test('the language follows Settings, then the system’s languages in order, then English; the pseudo-language is never chosen for you (#27)', () => {
  const available = [{ id: 'en' }, { id: 'es' }, { id: 'pt-BR' }, { id: PSEUDO }];
  assert.equal(chooseLanguage('system', 'fr-FR,es-MX;q=0.8,en;q=0.5', available), 'es', 'A region uses its language’s catalog.');
  assert.equal(chooseLanguage('system', 'en-GB,es;q=0.9', available), 'en', 'English comes first when the system puts it first.');
  assert.equal(chooseLanguage('system', 'es;q=0.2,pt-br;q=0.9', available), 'pt-BR', 'Order follows q, and tags match without regard to case.');
  assert.equal(chooseLanguage('system', ['de-DE', 'pt-BR'], available), 'pt-BR', 'The desktop app passes the system’s list.');
  assert.equal(chooseLanguage('system', 'en-XA', available), 'en');
  assert.equal(chooseLanguage(PSEUDO, 'es', available), PSEUDO, 'It can be chosen in Settings.');
  assert.equal(chooseLanguage('es', 'pt-BR', available), 'es');
  assert.equal(chooseLanguage('de', 'pt-BR', available), 'pt-BR', 'A chosen language whose catalog is gone follows the system.');
  assert.equal(chooseLanguage('system', '', available), 'en');
  assert.equal(chooseLanguage('system', '*,de', available), 'en');
});

test('catalogs are read from their folder, named by their tag and the name they give themselves (#27)', t => {
  const dir = folder(t);
  assert.deepEqual(languages(path.join(dir, 'missing')), [{ id: 'en', name: 'English', direction: 'ltr' }]);
  fs.writeFileSync(path.join(dir, 'es.json'), JSON.stringify({ $name: 'Español', 'Keep awake': 'Mantener activo', Listed: ['not', 'a', 'text'] }));
  fs.writeFileSync(path.join(dir, 'ar.json'), JSON.stringify({ $name: 'العربية', $direction: 'rtl' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  fs.writeFileSync(path.join(dir, 'Bad_Tag.json'), '{}');
  fs.writeFileSync(path.join(dir, 'en.json'), JSON.stringify({ 'Keep awake': 'Stay up' }));
  assert.deepEqual(languages(dir), [{ id: 'en', name: 'English', direction: 'ltr' }, { id: 'ar', name: 'العربية', direction: 'rtl' }, { id: 'es', name: 'Español', direction: 'ltr' }]);
  assert.deepEqual(catalog('es', dir), { language: 'es', direction: 'ltr', messages: { 'Keep awake': 'Mantener activo' } });
  assert.deepEqual(catalog('en', dir), { language: 'en', direction: 'ltr', messages: {} }, 'English never has a catalog.');
  assert.deepEqual(catalog('../es', dir).messages, {});
  assert.equal(textFor('es', dir).t('Keep awake'), 'Mantener activo');
  assert.equal(textFor('ar', dir).direction, 'rtl');
});

test('npm run i18n finds texts in the page and in t() and tn() calls, and says which calls it can’t read (#27)', () => {
  assert.deepEqual(fromHTML(`<html><head><title>Codeshi</title></head><body>
    <button title="Close &amp; save" aria-label="Close">  Close
      now </button><code>npm test</code><svg><title>Icon</title></svg><!-- Hidden --><span data-x="Skipped">→</span>
    <input placeholder="Search…"><script>t('No')</script></body></html>`), ['Close & save', 'Close', 'Search…', 'Close now']);
  const found = fromScript(`t('One'); t("Two \\"quoted\\""); t(\`Three\`); x.tn(count, 'One file', '{count} files'); tn(f(a, b), '1 row', '{count} rows', { a });
    t(\`Hi \${name}\`); t(variable); format(x); split('a'); t('Don\\'t {agent}', { agent });`, 'a.js');
  assert.deepEqual(found.texts, ['One', 'Two "quoted"', 'Three', 'Don\'t {agent}']);
  assert.deepEqual(found.plurals, [{ one: 'One file', other: '{count} files' }, { one: '1 row', other: '{count} rows' }]);
  assert.deepEqual(found.unreadable, ['a.js:2', 'a.js:2']);
});

test('every t() and tn() in the app has a plain quoted text, so each can be translated (#27)', () => {
  const { keys, unreadable } = extract();
  assert.deepEqual(unreadable, [], 'Write t(\'…\', { value }) instead of building the text, so npm run i18n can find it.');
  assert(keys.size > 600, 'The page, Settings, the composer and the menus are translatable.');
  for (const text of ['Keep awake', 'Send', 'Describe the task or ask a question…', 'Open Codeshi', 'When something happens', 'Settings…']) assert(keys.has(text), text);
  assert.deepEqual(keys.get('{count} queued prompts move too.'), { one: '1 queued prompt moves too.' });
  for (const name of ['Codeshi', 'Codex', 'Claude', 'Gemini', 'Flow']) assert.equal(keys.has(name), false, `${name} is a name, never translated.`);
  assert.equal(createText().load({ language: 'es', messages: { Codeshi: 'Kodeshi', Send: 'Enviar' } }).t('Codeshi'), 'Codeshi');
});

test('a translation must keep each {value} of its English, and add none (#27)', () => {
  assert.deepEqual(problems('Use {agent} now', 'Usa {agent} ahora'), []);
  assert.deepEqual(problems('Use {agent} now', 'Usa ahora'), ['“Use {agent} now” leaves out {agent}']);
  assert.deepEqual(problems('Use {agent} now', 'Usa {agnet}'), ['“Use {agent} now” has {agnet}, which the English doesn’t', '“Use {agent} now” leaves out {agent}']);
  assert.deepEqual(problems('{count} files', { one: 'Un archivo', other: '{count} archivos' }, { one: '1 file' }), [], 'A plural form may leave out the count.');
  assert.deepEqual(problems('{count} files in {folder}', { one: 'Un archivo', other: '{count} archivos en {folder}' }, { one: '1 file in {folder}' }), ['“{count} files in {folder}” (one) leaves out {folder}']);
  assert.deepEqual(problems('Anything', ''), [], 'An untranslated text is no problem.');
  assert.equal(pseudo('Use {agent} now'), '⟦Ûšé {agent} ñöŵ·····⟧');
});

test('npm run i18n -- <language> writes a catalog with every text, keeping translations and each plural form the language has (#27)', t => {
  const base = folder(t);
  fs.mkdirSync(path.join(base, 'public')); fs.mkdirSync(path.join(base, 'desktop'));
  fs.writeFileSync(path.join(base, 'public', 'index.html'), '<body><button>Send</button></body>');
  fs.writeFileSync(path.join(base, 'public', 'app.js'), "t('Stop'); tn(n, '1 file', '{count} files');");
  fs.writeFileSync(path.join(base, 'desktop', 'menu.mjs'), "t('Quit Codeshi');");
  update('pl', base);
  const file = path.join(base, 'public', 'locales', 'pl.json'), written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written, { $name: 'Polski', $direction: 'ltr', Send: '', Stop: '', '{count} files': { one: '', few: '', many: '', other: '' }, 'Quit Codeshi': '' });
  fs.writeFileSync(file, JSON.stringify({ ...written, Send: 'Wyślij', Gone: 'Stare' }));
  update('pl', base);
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(again.Send, 'Wyślij'); assert.equal('Gone' in again, false, 'Texts the app no longer has are left out.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(update('ur', base).file), 'utf8')).$direction, 'rtl');
  assert.throws(() => update('en', base), /English is the text in the code/);
  assert.throws(() => update('../x', base), /Name a language/);
});

test('the menus and the status item use the interface language, and stay in English without one (#27)', () => {
  const text = createText().load({ language: 'es', messages: { File: 'Archivo', 'New Workspace': 'Nuevo espacio', 'Use {agent}': 'Usar {agent}', 'Offer at {percent}%': 'Ofrecer al {percent} %', 'Open Codeshi': 'Abrir Codeshi', Banners: 'Avisos', 'Approval needed': 'Aprobación necesaria', '{count} working': { one: '{count} trabajando', other: '{count} trabajando' } } });
  const menu = menuTemplate({ platform: 'darwin', version: '1', osVersion: '15', arch: 'arm64', appearance: 'system', keepAwake: false, send: () => {}, open: () => {}, text });
  const file = menu.find(item => item.label === 'Archivo');
  assert(file, 'Top-level menus are translated.');
  assert.equal(file.submenu[0].label, 'Nuevo espacio');
  const agent = menu.find(item => item.label === 'Agent');
  assert.equal(agent.submenu[0].label, 'Usar Codex', 'Agent has no translation here, so it stays English while its items are translated.');
  assert(agent.submenu.find(item => item.label === 'Hand Off Near Usage Limits').submenu.some(item => item.label === 'Ofrecer al 90 %'));
  const english = menuTemplate({ platform: 'darwin', version: '1', osVersion: '15', arch: 'arm64', appearance: 'system', keepAwake: false, send: () => {}, open: () => {} });
  assert(english.some(item => item.label === 'File'));
  const items = statusMenu({ rows: [], attention: 0, running: 0 }, { text });
  assert(items.some(item => item.label === 'Abrir Codeshi'));
  assert.equal(items.find(item => item.submenu)?.submenu[0].label, 'Avisos');
  assert.equal(statusTitle({ rows: [{ kind: 'approval', attention: true }], attention: 1, running: 0 }, text), 'Aprobación necesaria');
  assert.equal(statusTitle({ rows: [], attention: 0, running: 3 }, text), '3 trabajando');
  assert.equal(statusTitle({ rows: [], attention: 0, running: 3 }), '3 working');
});

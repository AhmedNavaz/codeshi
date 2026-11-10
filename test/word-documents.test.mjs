import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { AttachmentStore, describeAttachment } from '../src/attachments.mjs';
import { readExplorerFile } from '../src/file-explorer.mjs';
import { prepareContext } from '../src/context.mjs';
import { createRelayServer } from '../src/server.mjs';

// Builds a zip file, as Word saves a .docx: each entry deflated (method 8) or stored (method 0).
function zip(entries, { method = 8 } = {}) {
  const parts = [], directory = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content), packed = method === 8 ? zlib.deflateRawSync(data) : data, file = Buffer.from(name), crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, file, packed); directory.push(central, file);
    offset += 30 + file.length + packed.length;
  }
  const listing = Buffer.concat(directory), end = Buffer.alloc(22), count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(listing.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listing, end]);
}
const xml = body => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
const word = (body, options) => zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml(body) }, options);
const run = text => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (text, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${text}</w:p>`;
const item = (text, level) => paragraph(run(text), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr>`);
const cell = text => `<w:tc><w:tcPr><w:tcW w:w="2000"/></w:tcPr>${paragraph(run(text))}</w:tc>`;

// A client's brief, with what Word documents usually hold.
const brief = word([
  paragraph(run('Shop rewrite'), '<w:pStyle w:val="Title"/>'),
  paragraph(''),
  paragraph(run('Customers &amp; staff ') + run('sign in with email.')),
  paragraph(run('Scope'), '<w:pStyle w:val="Heading2"/>'),
  item('Checkout', 0),
  item('Cards and wallets', 1),
  `<w:tbl><w:tblPr/><w:tr>${cell('Area')}${cell('Owner')}</w:tr><w:tr>${cell('API')}${cell('Back | end')}</w:tr></w:tbl>`,
  // Tab stops in the paragraph's properties are not tabs in its text.
  paragraph(run('Due:') + '<w:r><w:tab/></w:r>' + run('March') + '<w:r><w:br/></w:r>' + run('Budget &lt; &#8364;5k'), '<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>'),
  // A text box is saved twice: for current Word, and in an older form for older readers.
  paragraph('<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>' + paragraph(run('Logo goes here')) + '</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent>' + paragraph(run('Logo goes here')) + '</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>'),
  paragraph('<w:del w:id="1" w:author="A"><w:r><w:delText>Old wording</w:delText></w:r></w:del><w:ins w:id="2" w:author="A">' + run('New wording') + '</w:ins>'),
].join(''));
const briefText = [
  '# Shop rewrite',
  'Customers & staff sign in with email.',
  '## Scope',
  '- Checkout\n  - Cards and wallets',
  '| Area | Owner |\n| API | Back \\| end |',
  'Due:\tMarch\nBudget < €5k',
  'Logo goes here',
  'New wording',
].join('\n\n');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-word-'))), workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, store: new AttachmentStore(path.join(root, 'data')) };
}

test('a Word document is attached as its text, with headings, lists, tables and line breaks kept as Markdown', t => {
  const f = fixture(t), saved = f.store.put({ name: 'brief.docx', data: brief.toString('base64') });
  assert.deepEqual({ ...saved, id: undefined }, { name: 'brief.docx', mime: 'text/plain', kind: 'text', bytes: Buffer.byteLength(briefText), id: undefined });
  assert.equal(describeAttachment('brief.docx', brief).bytes, Buffer.byteLength(briefText), 'its size is the size of its text, which is what the text limits count');
  const read = f.store.read(saved.id);
  assert.equal(read.text, briefText);
  assert.equal(read.data, brief.toString('base64'), 'the saved snapshot is the document itself, checked again each time it is read');
  assert.deepEqual(f.store.select([saved.id]), [saved]);
  // A snapshot changed on disk is refused before it is unpacked.
  const disk = path.join(f.store.root, saved.id + '.json'), changed = JSON.parse(fs.readFileSync(disk, 'utf8'));
  fs.writeFileSync(disk, JSON.stringify({ ...changed, data: word(paragraph(run('x')) + ' '.repeat(9 * 1024 * 1024)).toString('base64') }));
  assert.throws(() => f.store.read(saved.id), /changed/);
  // Stored entries, which some tools write, read the same.
  assert.equal(f.store.read(f.store.put({ name: 'stored.docx', data: word(paragraph(run('Plain'))).toString('base64') }).id).text, 'Plain');
  assert.equal(f.store.read(f.store.put({ name: 'stored.docx', data: word(paragraph(run('Stored')), { method: 0 }).toString('base64') }).id).text, 'Stored');
});

test('an agent gets a Word document’s text in its prompt, and the file browser previews it as text', t => {
  const f = fixture(t), saved = f.store.put({ name: 'brief.docx', data: brief.toString('base64') });
  const c = { provider: 'codex', mode: 'read', sessions: {}, messages: [] };
  const { prompt } = prepareContext(c, 'Plan this', { workspace: f.workspace, attachments: [saved], readAttachment: id => f.store.read(id) });
  // The request goes to the agent inside JSON.
  assert.ok(prompt.includes(JSON.stringify('Attached file "brief.docx":\n' + briefText).slice(1, -1)), 'the text goes in the prompt, not the zip');
  assert.ok(!prompt.includes('word/document.xml'));
  fs.writeFileSync(path.join(f.workspace, 'brief.docx'), brief);
  const preview = readExplorerFile({ id: 'root', name: 'project', path: f.workspace }, 'brief.docx');
  assert.equal(preview.kind, 'text'); assert.equal(preview.text, briefText); assert.equal(preview.data, brief.toString('base64'));
});

test('a Word document of nearly 5 MB is uploaded and previewed as its text through the app', async t => {
  // Hooks run in the order they are added: the app closes before its folder is removed.
  let app;
  t.after(async () => { await app?.close(); });
  const f = fixture(t);
  app = createRelayServer({ workspace: f.workspace, dataRoot: path.join(f.root, 'server'), accessToken: 'local-test', bins: { codex: process.execPath, claude: process.execPath } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port, project = app.registry.list()[0], headers = { 'X-AI-Relay-Token': 'local-test' };
  // Most of a large .docx is its pictures.
  const document = zip({ 'word/document.xml': xml(paragraph(run('Pictures of the shop'))), 'word/media/image1.png': randomBytes(4.8 * 1024 * 1024) }, { method: 0 });
  assert.ok(document.length > 4.8 * 1024 * 1024 && document.length < 5 * 1024 * 1024);
  const upload = await fetch(base + '/api/attachments?projectId=' + project.id, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify({ name: 'shop.docx', data: document.toString('base64') }) });
  assert.equal(upload.status, 201);
  const saved = await upload.json();
  assert.deepEqual([saved.kind, saved.bytes], ['text', 20]);
  assert.equal((await (await fetch(base + '/api/attachments/preview?projectId=' + project.id + '&id=' + saved.id, { headers })).json()).text, 'Pictures of the shop');
});

test('a Word document that can’t be read is refused with what to do instead', () => {
  const refused = (name, bytes, message) => assert.throws(() => describeAttachment(name, bytes), error => message.test(error.message) && error.status >= 400, name);
  refused('brief.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), /Save it as \.docx or as text/);
  // Word saves a document with a password as an encrypted container, not a zip.
  refused('locked.docx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), /can't be read.*password/);
  refused('broken.docx', Buffer.from('PK\x03\x04 not really a zip'), /can't be read/);
  refused('sheet.docx', zip({ 'xl/workbook.xml': '<workbook/>' }), /can't be read/);
  refused('empty.docx', word(paragraph('') + paragraph(run('   '))), /no text/);
  refused('long.docx', word(paragraph(run('a'.repeat(70 * 1024)))), /64 KB/);
  // 30,000 characters, but 90,000 bytes of UTF-8: the limit counts bytes.
  refused('euros.docx', word(paragraph(run('€'.repeat(30000)))), /64 KB/);
  refused('big.docx', Buffer.alloc(5 * 1024 * 1024 + 1), /5 MB/);
  // A small file whose document unpacks to more than 8 MB.
  const bomb = word(paragraph(run('x')) + ' '.repeat(9 * 1024 * 1024));
  assert.ok(bomb.length < 200 * 1024);
  refused('bomb.docx', bomb, /too large/);
  // The same, with its size written down as 100 bytes.
  const understated = Buffer.from(bomb);
  understated.writeUInt32LE(100, understated.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
  refused('understated.docx', understated, /too large/);
  // An entry packed some other way than Word's, and an encrypted one.
  const entry = (bytes, offset, value) => { const copy = Buffer.from(bytes); copy.writeUInt16LE(value, copy.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + offset); return copy; };
  const plain = word(paragraph(run('Text')));
  assert.equal(describeAttachment('plain.docx', plain).bytes, 4);
  refused('odd.docx', entry(plain, 10, 12), /can't be read/);
  refused('encrypted.docx', entry(plain, 8, 1), /can't be read/);
});

test('the attach button offers Word documents and says how large they can be', () => {
  const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), files = fs.readFileSync(new URL('../public/files.js', import.meta.url), 'utf8');
  assert.match(page.match(/<input id="attachment-input"[^>]*>/)[0], /accept="[^"]*\.docx[,"]/);
  assert.match(files, /Word \.docx \(5 MB, 64 KB of text\)/);
});

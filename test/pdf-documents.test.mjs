import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { AttachmentStore, describeAttachment } from '../src/attachments.mjs';
import { PDF_READER, pdfLimits, pdfPagesText, pdfText } from '../src/pdf-documents.mjs';
import { readExplorerFile } from '../src/file-explorer.mjs';
import { prepareContext } from '../src/context.mjs';
import { createRelayServer } from '../src/server.mjs';

// A small PDF, as a word processor saves one: each page's lines in Helvetica, and '' for a page with no text, as a
// scanned page has.
function pdf(pages) {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, index) => {
    const stream = text ? `BT /F1 12 Tf 14 TL 72 720 Td ${text.split('\n').map(line => `(${line.replace(/[\\()]/g, '\\$&')}) '`).join(' ')} ET` : '';
    objects[4 + index * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`;
    objects[5 + index * 2] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let number = 1; number < objects.length; number++) { offsets[number] = Buffer.byteLength(out); out += `${number} 0 obj\n${objects[number]}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const brief = pdf(['Checkout rewrite\nAgree the API (v2) first.', '', 'QA, then release.']);
const briefText = '[Page 2 has no text, so it’s left out. It may be blank or scanned.]\n\n[Page 1]\nCheckout rewrite\nAgree the API (v2) first.\n\n[Page 3]\nQA, then release.';

function fixture(t, readPdf) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pdf-'))), workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, store: new AttachmentStore(path.join(root, 'data'), readPdf ? { readPdf } : {}) };
}
// macOS's reader, as pdfText starts it: what it was given on its standard input, and what it answers.
function reader(answer, { close = true } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter(), input = [];
    child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = signal => { child.killed = signal; };
    child.stdin.on('data', chunk => input.push(chunk));
    child.stdin.on('end', () => {
      calls.at(-1).input = Buffer.concat(input);
      if (!close) return;
      if (answer !== null) child.stdout.end(typeof answer === 'string' ? answer : `${JSON.stringify(answer)}\n`); else child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    });
    calls.push({ file, args, options, child });
    return child;
  };
  return { calls, spawnImpl };
}

test('a PDF’s pages become its text, each under its number, with a note naming the pages that had none', () => {
  assert.equal(pdfPagesText(['Only page\r\nSecond line   ']), 'Only page\nSecond line', 'one page has no number');
  const text = pdfPagesText(['One', '  \n ', 'Three\f\x0bFour\x00\x07', '', '', 'Six\n\n\n\nSeven']);
  assert.equal(text, '[Pages 2 and 4–5 have no text, so they’re left out. They may be blank or scanned.]\n\n[Page 1]\nOne\n\n[Page 3]\nThree\n\nFour\n\n[Page 6]\nSix\n\nSeven');
  assert.doesNotMatch(text, /[\x00-\x08\x0b\x0c\x0e-\x1f]/, 'nothing an attachment would refuse as binary');
  assert.match(pdfPagesText(['Text', ...Array(45).fill('')]), /^\[45 pages have no text/);
  assert.throws(() => pdfPagesText(['', ' \n\t ']), /no text to read.*scanned.*attach the pages as images/s, 'a scanned PDF says what to do instead');
  assert.throws(() => pdfPagesText([]), /can't be read/);
  // 30,000 characters, but 90,000 bytes of UTF-8: the limit counts bytes.
  assert.throws(() => pdfPagesText(['€'.repeat(30000)]), error => /more than 64 KB/.test(error.message) && error.status === 413);
});

test('macOS’s PDF reader gets the file on its standard input and says what stopped it', async () => {
  const file = pdf(['Hello']);
  let stand = reader({ pages: ['Hello'], count: 1, more: false });
  assert.equal(await pdfText(file, { platform: 'darwin', spawnImpl: stand.spawnImpl }), 'Hello');
  const [call] = stand.calls;
  assert.deepEqual([call.file, call.args], ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_READER]], 'osascript runs Codeshi’s own reader, never a script from the file');
  assert.deepEqual(call.input, file, 'the PDF goes in on standard input, not as a path');
  assert.match(PDF_READER, /ObjC\.import\('PDFKit'\)/);
  const refused = async (answer, message, options = {}) => {
    stand = reader(answer, options);
    await assert.rejects(pdfText(file, { platform: 'darwin', spawnImpl: stand.spawnImpl, ...options }), error => message.test(error.message) && error.status >= 400);
    return stand;
  };
  await refused({ error: 'locked' }, /has a password/);
  await refused({ error: 'unreadable' }, /can't be read/);
  await refused('osascript: execution error\n', /can't be read/);
  await refused(null, /can't be read/);
  await refused({ pages: ['x'.repeat(10)], count: 900, more: true }, /more than 64 KB/);
  await refused({ pages: [''], count: 1, more: false }, /scanned/);
  const slow = await refused(null, /took too long/, { close: false, timeout: 20 });
  assert.equal(slow.calls[0].child.killed, 'SIGKILL', 'a reader that hangs is stopped');
  // osascript missing or refused.
  await assert.rejects(pdfText(file, { platform: 'darwin', spawnImpl: () => { throw new Error('spawn EACCES'); } }), /couldn't start macOS's PDF reader/);
  stand = reader(null, { close: false });
  const failing = pdfText(file, { platform: 'darwin', spawnImpl: stand.spawnImpl });
  stand.calls[0].child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(failing, /couldn't start macOS's PDF reader/);
  // Refused before anything starts.
  const never = () => { throw new Error('should not start'); };
  for (const platform of ['win32', 'linux']) await assert.rejects(pdfText(file, { platform, spawnImpl: never }), error => /on macOS for now.*text or Word/.test(error.message) && error.status === 415);
  await assert.rejects(pdfText(Buffer.from('PK\x03\x04 a zip called .pdf'), { platform: 'darwin', spawnImpl: never }), /can't be read/);
  await assert.rejects(pdfText(Buffer.alloc(pdfLimits.fileBytes + 1, 32), { platform: 'darwin', spawnImpl: never }), /5 MB/);
});

test('a PDF is read once when it’s attached, and its text is what an agent and the preview get', async t => {
  let reads = 0;
  const f = fixture(t, async bytes => { reads++; assert.deepEqual(bytes, brief); return briefText; });
  const saved = await f.store.upload({ name: 'brief.pdf', data: brief.toString('base64') });
  assert.deepEqual([saved.kind, saved.mime, saved.bytes], ['text', 'text/plain', Buffer.byteLength(briefText)], 'its size is its text’s, which the text limits count');
  assert.equal(reads, 1);
  // Read from the snapshot afterwards, also by a new store after a restart.
  assert.equal(f.store.read(saved.id).text, briefText);
  assert.equal(new AttachmentStore(path.join(f.root, 'data'), { readPdf: () => { throw new Error('read again'); } }).read(saved.id).text, briefText);
  assert.equal(reads, 1);
  assert.deepEqual(f.store.select([saved.id]).map(file => file.kind), ['text']);
  const c = { provider: 'codex', mode: 'read', sessions: {}, messages: [] };
  const { prompt } = prepareContext(c, 'Plan this', { workspace: f.workspace, attachments: [saved], readAttachment: id => f.store.read(id) });
  assert.ok(prompt.includes(JSON.stringify('Attached file "brief.pdf":\n' + briefText).slice(1, -1)), 'the text goes in the prompt, not the PDF');
  assert.ok(!prompt.includes('%PDF'));
  // The same file attached again is the same attachment.
  assert.equal((await f.store.upload({ name: 'brief.pdf', data: brief.toString('base64') })).id, saved.id);
  // A snapshot whose text was changed or lost isn't used.
  const disk = path.join(f.store.root, `${saved.id}.json`), kept = JSON.parse(fs.readFileSync(disk, 'utf8'));
  fs.writeFileSync(disk, JSON.stringify({ ...kept, text: 'binary\x01' }));
  assert.throws(() => f.store.read(saved.id), /has changed/);
  fs.writeFileSync(disk, JSON.stringify({ ...kept, text: undefined }));
  assert.throws(() => f.store.read(saved.id), /has changed/);
});

test('a PDF that can’t be read is refused with what to do instead, and only an upload reads one', async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error('This PDF has a password. Remove it.'), { status: 400 }); });
  await assert.rejects(f.store.upload({ name: 'locked.pdf', data: brief.toString('base64') }), /password/);
  assert.ok(!fs.existsSync(f.store.root) || !fs.readdirSync(f.store.root).length, 'nothing is saved');
  await assert.rejects(f.store.upload({ name: 'bad/name.pdf', data: brief.toString('base64') }), /valid filename/);
  await assert.rejects(f.store.upload({ name: 'empty.pdf', data: '' }), /empty/);
  await assert.rejects(f.store.upload({ name: 'odd.pdf', data: '!!!!' }), /Invalid/);
  // Text can't be handed in with the file: put, which an upload of anything else uses, never reads a PDF.
  assert.throws(() => f.store.put({ name: 'brief.pdf', data: brief.toString('base64'), pdfText: 'Made up' }), /doesn't preview PDFs.*attach it from the message box/);
  assert.throws(() => describeAttachment('file.pdf', Buffer.from('%PDF-1.2')), /doesn't preview PDFs/);
  // The file browser shows files as they are, so it can't preview a PDF either.
  fs.writeFileSync(path.join(f.workspace, 'brief.pdf'), brief);
  assert.throws(() => readExplorerFile({ id: 'root', name: 'project', path: f.workspace }, 'brief.pdf'), error => /doesn't preview PDFs/.test(error.message) && error.status === 415);
  // Text files are stored as before.
  assert.equal(f.store.read((await f.store.upload({ name: 'notes.md', data: Buffer.from('Notes').toString('base64') })).id).text, 'Notes');
});

test('a PDF is uploaded and previewed as its text through the app, and extra fields can’t supply its text', async t => {
  let app;
  t.after(async () => { await app?.close(); });
  const f = fixture(t);
  app = createRelayServer({ workspace: f.workspace, dataRoot: path.join(f.root, 'server'), accessToken: 'local-test', bins: { codex: process.execPath, claude: process.execPath } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port, project = app.registry.list()[0], headers = { 'X-AI-Relay-Token': 'local-test' };
  const read = [];
  app.registry.broker(project.id).attachments.readPdf = async bytes => { read.push(bytes.length); return 'Read by the reader'; };
  const post = body => fetch(base + '/api/attachments?projectId=' + project.id, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(body) });
  const upload = await post({ name: 'brief.pdf', data: brief.toString('base64'), pdfText: 'Made up', text: 'Made up' });
  assert.equal(upload.status, 201);
  const saved = await upload.json();
  assert.deepEqual([saved.kind, saved.bytes, read], ['text', 18, [brief.length]]);
  assert.equal((await (await fetch(base + '/api/attachments/preview?projectId=' + project.id + '&id=' + saved.id, { headers })).json()).text, 'Read by the reader');
  app.registry.broker(project.id).attachments.readPdf = async () => { throw Object.assign(new Error('This PDF has no text to read.'), { status: 400 }); };
  const scanned = await post({ name: 'scan.pdf', data: pdf(['']).toString('base64') });
  assert.equal(scanned.status, 400);
  assert.match((await scanned.json()).error, /no text to read/);
});

test('macOS reads a real PDF’s text through PDFKit', { skip: process.platform !== 'darwin' && 'PDFKit is part of macOS' }, async t => {
  assert.equal(await pdfText(brief), briefText);
  await assert.rejects(pdfText(pdf(['', ''])), /scanned/);
  await assert.rejects(pdfText(Buffer.from('%PDF-1.4\nnot really a PDF\n')), /can't be read/);
  // The whole way, through the app.
  let app;
  t.after(async () => { await app?.close(); });
  const f = fixture(t);
  app = createRelayServer({ workspace: f.workspace, dataRoot: path.join(f.root, 'server'), accessToken: 'local-test', bins: { codex: process.execPath, claude: process.execPath } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port, project = app.registry.list()[0], headers = { 'X-AI-Relay-Token': 'local-test' };
  const upload = await fetch(base + '/api/attachments?projectId=' + project.id, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify({ name: 'brief.pdf', data: brief.toString('base64') }) });
  assert.equal(upload.status, 201);
  const saved = await upload.json();
  assert.equal((await (await fetch(base + '/api/attachments/preview?projectId=' + project.id + '&id=' + saved.id, { headers })).json()).text, briefText);
});

test('the attach button offers PDFs and says they’re read on macOS', () => {
  const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), files = fs.readFileSync(new URL('../public/files.js', import.meta.url), 'utf8');
  assert.match(page.match(/<input id="attachment-input"[^>]*>/)[0], /accept="[^"]*\.pdf[,"]/);
  assert.match(files, /PDF on macOS \(5 MB, 64 KB of text\)/);
  assert.match(files, /Text from the ' \+ \(read === 'pdf' \? 'PDF'/);
});

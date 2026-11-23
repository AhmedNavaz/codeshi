import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { wordText } from './word-documents.mjs';
import { pdfLimits, pdfMessages, pdfText as readPdfText } from './pdf-documents.mjs';

export const attachmentLimits = { count: 6, imageBytes: 5 * 1024 * 1024, textBytes: 64 * 1024, totalBytes: 20 * 1024 * 1024, totalTextBytes: 128 * 1024 };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const digest = data => createHash('sha256').update(data).digest('hex');
const imageType = bytes => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
  : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
  : /^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii')) ? 'image/gif'
  : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : null;
const checkName = name => { if (typeof name !== 'string' || !name.trim() || name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(name)) fail('Choose a file with a valid filename.'); };
const isPdf = name => typeof name === 'string' && /\.pdf$/i.test(name);
// An upload's bytes, sent as base64 and no larger than the largest file an attachment can be.
function decoded(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(attachmentLimits.imageBytes / 3) * 4 || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) fail('Invalid or oversized attachment.', 413);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) fail('Invalid base64 attachment.');
  return bytes;
}

// What a file is, and for text the text an agent gets. A Word document (.docx) or a PDF is text: its size is its text's
// size, which is what the text limits count. A PDF's text is read when it's attached (pdfText, from upload) and saved
// with its snapshot, since reading one takes a process of its own.
export function inspectAttachment(name, bytes, { pdfText } = {}) {
  checkName(name);
  if (!bytes.length) fail('This file is empty.');
  if (/\.docx$/i.test(name)) { const text = wordText(bytes); return { name, mime: 'text/plain', kind: 'text', bytes: Buffer.byteLength(text), text }; }
  if (/\.doc$/i.test(name)) fail("Word 97-2003 documents (.doc) can't be read. Save it as .docx or as text, and attach that.");
  if (isPdf(name)) {
    if (bytes.length > pdfLimits.fileBytes) fail(pdfMessages.large, 413);
    if (typeof pdfText !== 'string') fail(pdfMessages.preview, 415);
    if (!pdfText || Buffer.byteLength(pdfText) > pdfLimits.textBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(pdfText)) fail('The saved attachment has changed.', 409);
    return { name, mime: 'text/plain', kind: 'text', bytes: Buffer.byteLength(pdfText), text: pdfText };
  }
  if (bytes.length > attachmentLimits.imageBytes) fail('Images must be 5 MB or smaller.', 413);
  const mime = imageType(bytes);
  if (mime) return { name, mime, kind: 'image', bytes: bytes.length };
  if (/\.(png|jpe?g|gif|webp|xlsx?|pptx?|zip|gz|mp[34]|mov|wav|heic|avif)$/i.test(name)) fail('Attach PNG, JPEG, GIF, WebP, PDF, Word (.docx) or UTF-8 text/code files. This file format is not supported.');
  if (bytes.length > attachmentLimits.textBytes) fail('Text and code attachments must be 64 KB or smaller.', 413);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('This is a binary file. Attach an image or a UTF-8 text/code file.'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('This is a binary file. Attach an image or a UTF-8 text/code file.');
  return { name, mime: 'text/plain', kind: 'text', bytes: bytes.length, text };
}
export function describeAttachment(name, bytes, options) {
  const { text, ...meta } = inspectAttachment(name, bytes, options);
  return meta;
}

// Immutable snapshots live in the workspace's application storage, never its source tree.
// IDs are bound to both the filename and contents; no caller can provide a local path.
export class AttachmentStore {
  constructor(dataDir, { readPdf = readPdfText } = {}) { this.root = path.join(dataDir, 'attachments'); this.readPdf = readPdf; }
  ensure() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(this.root) !== path.resolve(this.root)) fail('Attachment storage cannot be a symbolic link.');
  }
  // A file you attach. A PDF is read first, which takes a moment (pdf-documents.mjs); anything else is stored at once.
  async upload(input) {
    const { name, data } = input && typeof input === 'object' ? input : {};
    if (!isPdf(name)) return this.put({ name, data });
    checkName(name);
    const bytes = decoded(data);
    if (!bytes.length) fail('This file is empty.');
    return this.put({ name, data }, { pdfText: await this.readPdf(bytes) });
  }
  // plan (#97): a Plan attachment's cards, kept with its snapshot so a prompt put together later can leave it out once
  // they're closed to agents. Only Codeshi's own Plan sets it; an upload can't. pdfText is the text upload read from a
  // PDF, which the snapshot keeps.
  put({ name, data }, { plan = null, pdfText } = {}) {
    const bytes = decoded(data);
    const meta = describeAttachment(name, bytes, { pdfText });
    const id = digest(Buffer.concat([Buffer.from(name + '\0'), bytes]));
    this.ensure();
    const file = path.join(this.root, id + '.json');
    const temporary = path.join(this.root, randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ ...meta, id, data, ...(isPdf(name) ? { text: pdfText } : {}), ...(plan ? { plan } : {}) })); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      // The same text attached again keeps its first snapshot, so a Plan link is added to it rather than lost.
      try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; const saved = this.read(id); if (plan && JSON.stringify(saved.plan || null) !== JSON.stringify(plan)) fs.renameSync(temporary, file); }
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
    return { ...meta, id, ...(plan ? { plan: { cards: plan.cards.length, whole: plan.whole === true } } : {}) };
  }
  read(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('Invalid attachment ID.');
    this.ensure();
    let fd;
    try {
      fd = fs.openSync(path.join(this.root, id + '.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 7 * 1024 * 1024) fail('Invalid attachment snapshot.');
      const saved = JSON.parse(fs.readFileSync(fd, 'utf8')), bytes = Buffer.from(saved.data, 'base64');
      // Checked against its ID before it is read, since reading a Word document means unpacking it. A PDF's text was read
      // when it was attached and is kept beside it.
      if (typeof saved.name !== 'string' || digest(Buffer.concat([Buffer.from(saved.name + '\0'), bytes])) !== id) fail('The saved attachment has changed.', 409);
      const { text, ...meta } = inspectAttachment(saved.name, bytes, { pdfText: isPdf(saved.name) ? (typeof saved.text === 'string' ? saved.text : '') : undefined });
      return { ...meta, id, data: bytes.toString('base64'), ...(meta.kind === 'text' ? { text } : {}), ...(saved.plan && typeof saved.plan === 'object' ? { plan: saved.plan } : {}) };
    } catch (error) { if (error.code === 'ENOENT') fail('An attachment is no longer available. Remove it and attach the file again.', 404); throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  // What an agent is given for an attachment: its text, unless it's a Plan attachment whose Plan or cards were closed to
  // agents since (#97). Every prompt asks this, including retries, handoffs and context refreshes.
  forAgent(id) {
    const file = this.read(id), why = file.plan && this.planGate ? this.planGate(file.plan) : null;
    return why ? { ...file, text: `[Left out: ${why}.]`, withheld: why } : file;
  }
  select(ids = []) {
    if (!Array.isArray(ids) || ids.length > attachmentLimits.count || new Set(ids).size !== ids.length) fail('Attach up to 6 different files per message.');
    const files = ids.map(id => this.read(id));
    if (files.reduce((n,f) => n + f.bytes, 0) > attachmentLimits.totalBytes) fail('Attachments must total 20 MB or less.', 413);
    if (files.filter(f => f.kind === 'text').reduce((n,f) => n + f.bytes, 0) > attachmentLimits.totalTextBytes) fail('Text attachments must total 128 KB or less.', 413);
    // A Plan attachment closed to agents since it was attached is still listed with the message, marked as left out, and
    // the agent gets only that note (forAgent), so a retry or a run after a usage reset doesn't fail over it.
    return files.map(({ data, text, plan, ...meta }) => { const why = plan && this.planGate ? this.planGate(plan) : null; return { ...meta, ...(plan ? { plan: { cards: plan.cards?.length || 0, whole: plan.whole === true, ...(plan.ids === true ? { ids: true } : {}) } } : {}), ...(why ? { withheld: why } : {}) }; });
  }
  imageInput(id) {
    const file = this.read(id);
    if (file.kind !== 'image') fail('Expected an image.');
    const filename = path.join(this.root, id + '.' + file.mime.split('/')[1]);
    // Materialize for Codex's localImage transport. Regenerate from the verified snapshot.
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, Buffer.from(file.data, 'base64')); } finally { fs.closeSync(fd); }
    return { id, name: file.name, mime: file.mime, data: file.data, path: filename };
  }
}

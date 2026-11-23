import { spawn } from 'node:child_process';

// PDF documents (#97) are attached as their text, read once when they're attached and kept with the snapshot
// (AttachmentStore.upload). On macOS the system's PDFKit reads them, through osascript's JavaScript and its bridge to
// Apple's frameworks, so there's nothing to build or install. The PDF goes to that process on its standard input, it
// answers with each page's text as JSON, and it's stopped if it takes too long. PDFKit only reads the text: nothing in
// the file runs. A scanned PDF has no text to read, since there's no OCR, and other systems can't read PDFs yet. Both
// say what to attach instead.
export const pdfLimits = { fileBytes: 5 * 1024 * 1024, textBytes: 64 * 1024, pages: 2000, timeout: 30 * 1000 };
const INSTEAD = 'Export it as text or Word (.docx) and attach that.';
export const pdfMessages = {
  system: `Codeshi reads PDFs on macOS for now. ${INSTEAD}`,
  large: 'PDFs must be 5 MB or smaller.',
  unreadable: `This PDF can't be read. It may be damaged. ${INSTEAD}`,
  locked: `This PDF has a password. Remove it, or export the PDF as text or Word (.docx), and attach that.`,
  scanned: "This PDF has no text to read. Its pages look scanned, and Codeshi doesn't read text from images. Export it as text or Word (.docx), or attach the pages as images.",
  long: 'This PDF has more than 64 KB of text. Attach the part that matters, or save parts of it as text files.',
  slow: `Reading this PDF took too long. ${INSTEAD}`,
  unavailable: `Codeshi couldn't start macOS's PDF reader. ${INSTEAD}`,
  // The file explorer shows files as they are on disk, and a PDF's text is only read when it's attached.
  preview: "Codeshi doesn't preview PDFs. To give one to an agent, attach it from the message box.",
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// More text than this can't fit once tidied, so the reader stops early rather than send a book's worth back.
const READ_CHARS = pdfLimits.textBytes * 4, OUTPUT_BYTES = READ_CHARS * 6 + 64 * 1024;
export const PDF_READER = `ObjC.import('Foundation'); ObjC.import('PDFKit');
function run() {
  const doc = $.PDFDocument.alloc.initWithData($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile);
  if (!doc || doc.isNil()) return JSON.stringify({ error: 'unreadable' });
  if (doc.isLocked) return JSON.stringify({ error: 'locked' });
  const count = doc.pageCount, pages = [];
  let length = 0;
  for (let index = 0; index < count && index < ${pdfLimits.pages}; index++) {
    const page = doc.pageAtIndex(index), text = page && !page.isNil() ? page.string : null, value = text && !text.isNil() ? text.js : '';
    pages.push(value); length += value.length;
    if (length > ${READ_CHARS}) return JSON.stringify({ pages, count, more: true });
  }
  return JSON.stringify({ pages, count, more: count > ${pdfLimits.pages} });
}`;

// Page numbers as short runs: 3, 5–7 and 9.
function pageList(numbers) {
  const runs = [];
  for (const number of numbers) { const last = runs.at(-1); if (last && number === last[1] + 1) last[1] = number; else runs.push([number, number]); }
  const names = runs.map(([from, to]) => from === to ? String(from) : `${from}–${to}`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

// The text an agent gets from the pages PDFKit read: each page under its number, without the control characters a PDF
// often carries, and a note naming the pages that had no text, such as blank or scanned ones.
export function pdfPagesText(pages) {
  if (!Array.isArray(pages) || !pages.length) throw fail(pdfMessages.unreadable);
  const tidy = page => String(page ?? '').replace(/\r\n?|[\v\f]/g, '\n').replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '').replace(/[ \t\xa0]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const texts = pages.map(tidy), blank = texts.flatMap((text, index) => text ? [] : [index + 1]);
  if (blank.length === texts.length) throw fail(pdfMessages.scanned);
  const body = texts.length === 1 ? texts[0] : texts.flatMap((text, index) => text ? [`[Page ${index + 1}]\n${text}`] : []).join('\n\n');
  const one = blank.length === 1;
  const note = blank.length ? `[${one ? `Page ${blank[0]} has` : blank.length > 40 ? `${blank.length} pages have` : `Pages ${pageList(blank)} have`} no text, so ${one ? 'it’s' : 'they’re'} left out. ${one ? 'It' : 'They'} may be blank or scanned.]\n\n` : '';
  const text = `${note}${body}`;
  if (Buffer.byteLength(text) > pdfLimits.textBytes) throw fail(pdfMessages.long, 413);
  return text;
}

export function pdfText(bytes, { platform = process.platform, spawnImpl = spawn, timeout = pdfLimits.timeout } = {}) {
  if (platform !== 'darwin') return Promise.reject(fail(pdfMessages.system, 415));
  if (bytes.length > pdfLimits.fileBytes) return Promise.reject(fail(pdfMessages.large, 413));
  // A PDF starts with its header, near the top of the file. Anything else isn't one, whatever it's called.
  if (!bytes.subarray(0, 1024).includes('%PDF-')) return Promise.reject(fail(pdfMessages.unreadable));
  return new Promise((resolve, reject) => {
    let child, done = false, size = 0, timer = null;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) { try { child?.kill('SIGKILL'); } catch { /* Already gone. */ } reject(error); } else resolve(value);
    };
    try { child = spawnImpl('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_READER], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(fail(pdfMessages.unavailable, 503)); return; }
    timer = setTimeout(() => finish(fail(pdfMessages.slow, 413)), timeout);
    child.on('error', () => finish(fail(pdfMessages.unavailable, 503)));
    child.stdout.on('data', chunk => { size += chunk.length; if (size > OUTPUT_BYTES) finish(fail(pdfMessages.long, 413)); else chunks.push(chunk); });
    child.on('close', () => {
      if (done) return;
      let answer = null;
      try { answer = JSON.parse(Buffer.concat(chunks).toString('utf8').trim().split('\n').at(-1)); } catch { /* Not an answer. */ }
      if (answer?.error === 'locked') return finish(fail(pdfMessages.locked));
      if (!Array.isArray(answer?.pages)) return finish(fail(pdfMessages.unreadable));
      if (answer.more) return finish(fail(pdfMessages.long, 413));
      try { finish(null, pdfPagesText(answer.pages)); } catch (error) { finish(error); }
    });
    // The reader may stop before taking the whole file, when it isn't a PDF it can open.
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

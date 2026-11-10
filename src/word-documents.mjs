import zlib from 'node:zlib';

// Word documents (.docx) are attached as their text. A .docx is a zip file whose text is in word/document.xml. Its
// headings, list items and table rows come out as Markdown lines, so an agent sees the document's shape.
export const wordLimits = { fileBytes: 5 * 1024 * 1024, documentBytes: 8 * 1024 * 1024, textBytes: 64 * 1024 };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const unreadable = () => fail("This Word document can't be read. If it has a password, remove it, or save it as text and attach that.");
const tooLarge = () => fail('This Word document is too large to read. Save it as text and attach that.', 413);
const tooLong = () => fail('This Word document has more than 64 KB of text. Attach the part that matters, or save parts of it as text files.', 413);

// The document's XML, read from the zip's list of entries. Only unencrypted stored and deflated entries are read, and
// the XML is unpacked to 8 MB at most, whatever size the zip claims. A document with 64 KB of text, however heavily
// formatted, has a few MB of XML.
function documentXml(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length) unreadable();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  for (let at = start, entry = 0; entry < count; entry++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) unreadable();
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), packed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28), local = bytes.readUInt32LE(at + 42), name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    if (name !== 'word/document.xml') continue;
    if (flags & 1 || (method !== 0 && method !== 8)) unreadable();
    if (local + 30 > end || bytes.readUInt32LE(local) !== 0x04034b50) unreadable();
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (data + packed > end) unreadable();
    const content = bytes.subarray(data, data + packed);
    if (method === 0) return content;
    try { return zlib.inflateRawSync(content, { maxOutputLength: wordLimits.documentBytes }); }
    catch (error) { if (error.code === 'ERR_BUFFER_TOO_LARGE') tooLarge(); unreadable(); }
  }
  unreadable();
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const character = code => { try { return String.fromCodePoint(code); } catch { return '�'; } };
const decode = text => text
  .replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/gi, (whole, hex, decimal, name) => hex ? character(parseInt(hex, 16)) : decimal ? character(Number(decimal)) : entities[name.toLowerCase()])
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

export function wordText(bytes) {
  if (bytes.length > wordLimits.fileBytes) fail('Word documents must be 5 MB or smaller.', 413);
  const source = documentXml(bytes).toString('utf8');
  // One pass over the tags, in order. Paragraphs can hold other paragraphs (text boxes), so they are a stack; a table
  // inside a table adds its text to the outer table's cell.
  const blocks = [], paragraphs = [];
  let tables = 0, rows = [], row = null, cell = null, inText = false, inProperties = 0, skipped = 0, length = 0;
  for (let at = source.indexOf('<'); at !== -1;) {
    const close = source.indexOf('>', at);
    if (close === -1) break;
    const next = source.indexOf('<', close), tag = source.slice(at + 1, close);
    const ending = tag[0] === '/', single = tag.endsWith('/'), name = (ending ? tag.slice(1) : tag).split(/[\s/]/, 1)[0];
    const paragraph = paragraphs.at(-1);
    // A text box is saved twice, once in an older form inside mc:Fallback, which is left out.
    if (name === 'mc:Fallback') skipped += ending ? -1 : single ? 0 : 1;
    else if (skipped) { /* inside an older copy */ }
    else if (name === 'w:p') {
      if (!ending && !single) paragraphs.push({ text: '', style: '', list: false, level: 0 });
      else if (ending && paragraph) {
        paragraphs.pop();
        const text = paragraph.text.replace(/\s+$/, '');
        if (tables) { if (cell && text.trim()) cell.push(text.trim().replace(/\s*\n\s*/g, ' ')); }
        else if (text.trim()) {
          const heading = /^heading\s*([1-6])$/i.exec(paragraph.style)?.[1] || (/^title$/i.test(paragraph.style) ? '1' : '');
          blocks.push(heading ? { kind: 'heading', text: '#'.repeat(Number(heading)) + ' ' + text.trim() }
            : paragraph.list ? { kind: 'item', text: '  '.repeat(Math.min(paragraph.level, 8)) + '- ' + text.trim() }
            : { kind: 'paragraph', text });
        }
      }
    } else if (name === 'w:pPr' || name === 'w:rPr') { if (!single) inProperties += ending ? -1 : 1; }
    else if (paragraph && !ending && name === 'w:pStyle') paragraph.style = attribute(tag, 'w:val') || '';
    else if (paragraph && !ending && name === 'w:numPr') paragraph.list = true;
    else if (paragraph && !ending && name === 'w:ilvl') paragraph.level = Number(attribute(tag, 'w:val')) || 0;
    else if (name === 'w:t') inText = !ending && !single;
    else if (paragraph && !inProperties && !ending && name === 'w:tab') paragraph.text += '\t';
    else if (paragraph && !inProperties && !ending && (name === 'w:br' || name === 'w:cr')) paragraph.text += '\n';
    else if (paragraph && !ending && name === 'w:noBreakHyphen') paragraph.text += '-';
    else if (name === 'w:tbl' && !single) {
      tables += ending ? -1 : 1;
      if (ending && !tables) {
        const lines = rows.filter(cells => cells.some(Boolean)).map(cells => '| ' + cells.map(text => text.replace(/\|/g, '\\|')).join(' | ') + ' |');
        if (lines.length) blocks.push({ kind: 'table', text: lines.join('\n') });
        rows = []; row = cell = null;
      }
    } else if (name === 'w:tr' && tables === 1 && !single) { if (ending) { if (row) rows.push(row); row = null; } else row = []; }
    else if (name === 'w:tc' && tables === 1 && !single) { if (ending) { if (row && cell) row.push(cell.join(' ')); cell = null; } else cell = []; }
    if (inText && paragraph && !skipped && next > close + 1) {
      const text = decode(source.slice(close + 1, next));
      paragraph.text += text;
      // Reading stops as soon as there is more text than can be attached.
      if ((length += text.length) > wordLimits.textBytes) tooLong();
    }
    at = next;
  }
  // List items follow each other line by line; every other block is a paragraph of its own.
  const text = blocks.map((block, index) => (index ? (block.kind === 'item' && blocks[index - 1].kind === 'item' ? '\n' : '\n\n') : '') + block.text).join('');
  if (!text.trim()) fail('This Word document has no text to read.');
  if (Buffer.byteLength(text) > wordLimits.textBytes) tooLong();
  return text;
}

// The phone page's logic that doesn't touch the page: reading a reply's Markdown, naming what the agent is doing, merging
// conversation updates. Loaded as a plain script in the page and as a module in tests, like routing.js.
(root => {
  'use strict';

  // Spans within a line: `code`, **bold**, *italic* and [links](https://…). Only http(s) links are links.
  const SPAN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  function spans(text) {
    const out = []; let at = 0;
    for (const match of String(text).matchAll(SPAN)) {
      if (match.index > at) out.push({ type: 'text', text: text.slice(at, match.index) });
      if (match[1]) out.push({ type: 'code', text: match[1].slice(1, -1) });
      else if (match[2]) out.push({ type: 'bold', text: match[2].slice(2, -2) });
      else if (match[3]) out.push({ type: 'italic', text: match[3].slice(1, -1) });
      else out.push({ type: 'link', text: match[4], href: match[5] });
      at = match.index + match[0].length;
    }
    if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
    return out;
  }

  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const isRule = line => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('|');
  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  // A reply as blocks. A reply still being written can end inside a code fence, which then runs to the end.
  function blocks(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n'), out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+.-]*)/);
      if (fence) {
        const code = []; i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
        i++;
        out.push({ type: 'code', language: fence[2] || '', text: code.join('\n') });
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) { out.push({ type: 'heading', level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, '') }); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ type: 'rule' }); i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1])) {
        const rows = [cells(line)]; i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push({ type: 'table', head: rows[0], rows: rows.slice(1) });
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push({ type: 'quote', text: quote.join(' ') });
        continue;
      }
      const item = line.match(LIST);
      if (item) {
        const ordered = /\d/.test(item[2]), items = [];
        while (i < lines.length) {
          const row = lines[i].match(LIST);
          if (row && /\d/.test(row[2]) === ordered && row[1].length < 2) { items.push(row[3]); i++; continue; }
          // A nested row or a wrapped line stays with the item above it, as text.
          if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) { items[items.length - 1] += ` ${lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, '')}`; i++; continue; }
          break;
        }
        out.push({ type: 'list', ordered, items });
        continue;
      }
      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !LIST.test(lines[i]) && !(lines[i].includes('|') && isRule(lines[i + 1] || ''))) paragraph.push(lines[i++]);
      if (paragraph.length) out.push({ type: 'paragraph', text: paragraph.join('\n') });
      else i++;
    }
    return out;
  }

  const shortPath = value => String(value || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  const shellInner = command => String(command).match(/^(?:\/[\w./-]+\/)?(?:bash|zsh|sh)\s+(?:-(?:lc|cl|c)|-l\s+-c)\s+(['"])(.*)\1$/)?.[2] || String(command);
  const VERBS = { Read: 'Reading', read_file: 'Reading', Edit: 'Editing', MultiEdit: 'Editing', edit_file: 'Editing', NotebookEdit: 'Editing', Write: 'Writing', write_file: 'Writing', Glob: 'Finding', Grep: 'Searching', search_files: 'Searching', WebFetch: 'Fetching', WebSearch: 'Searching the web', search_web: 'Searching the web', Task: 'Running an agent', Agent: 'Running an agent', AskUserQuestion: 'Asking you' };

  // One line saying what a saved step is, in the page's own words. The exact command is still shown in any approval.
  function describeStep(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (text.startsWith('$ ')) return `Running ${shellInner(text.slice(2).split('\n')[0].trim())}`;
    const check = text.match(/^Tests (running|passed|failed|timed out|stopped|skipped|interrupted): ([^\n]*)/);
    if (check) return check[1] === 'running' ? 'Running the tests' : `Tests ${check[1]}`;
    if (text.startsWith('File changes:')) {
      let names = [];
      try { names = JSON.parse(text.slice('File changes:'.length)).map(file => shortPath(file?.path || file?.file)).filter(Boolean); } catch { /* The step is still a change. */ }
      return names.length ? `Editing ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''}` : 'Editing files';
    }
    const tool = text.match(/^([A-Za-z_][\w-]*)\n(\{[\s\S]*)/);
    if (tool) {
      const [, name, rest] = tool;
      // The step may be cut short, so each field is read from the text instead of parsing the whole line.
      const field = key => { const found = rest.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`)); if (!found) return ''; try { return JSON.parse(`"${found[1]}"`); } catch { return ''; } };
      if (name === 'Bash') return field('description') || `Running ${shellInner(field('command'))}`.trim();
      if (name === 'TodoWrite') return 'Updating its plan';
      const detail = shortPath(field('file_path') || field('notebook_path') || field('path')) || field('pattern') || field('query') || field('url') || field('description');
      return [VERBS[name] || `Using ${name}`, detail].filter(Boolean).join(' ');
    }
    const remote = text.match(/^(mcp_tool_call|web_search): ?([^\n]*)/);
    if (remote) return remote[1] === 'web_search' ? `Searching the web ${remote[2]}`.trim() : remote[2] || 'Using a tool';
    const automatic = text.match(/^Auto-approved: ([^\n]*)/);
    if (automatic) return `Running ${shellInner(automatic[1])}`;
    if (/^Approval allowed/.test(text)) return 'You allowed the request';
    if (/^Approval denied/.test(text)) return 'You denied the request';
    const line = text.split('\n')[0];
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }

  // An update's messages into the list the page holds: changed ones in place, new ones at the end. A full update replaces it.
  function mergeMessages(current, update) {
    if (!update.delta) return update.messages || [];
    const out = [...current], at = new Map(out.map((message, index) => [message.id, index]));
    for (const message of update.messages || []) {
      const index = at.get(message.id);
      if (index === undefined) { at.set(message.id, out.length); out.push(message); } else out[index] = message;
    }
    return out;
  }

  function duration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  // crypto.randomUUID only exists on HTTPS and localhost, and a phone reaches the computer over plain HTTP on the local
  // network. getRandomValues exists everywhere, and a request ID only has to be unique.
  const requestId = source => [...source.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');

  root.relayPhoneLogic = { spans, blocks, describeStep, mergeMessages, duration, requestId, shortPath };
})(typeof window === 'undefined' ? globalThis : window);

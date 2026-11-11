// How the interactive codeshi session (#90) draws a conversation: the agent's steps, diffs, replies and the status line.
// Everything here is plain data, so it can be tested without a terminal. A line is a list of spans; a span is text and
// its style ({ color, dim, bold, italic, inverse }). cli-session.mjs turns them into Ink elements.
import path from 'node:path';

export const ACCENT = '#e4553f';
const NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
export const agentName = provider => NAMES[provider] || provider || 'Agent';

const span = (text, style = {}) => ({ text: String(text ?? ''), ...style });
const clip = (text, width) => { const value = String(text ?? ''); return value.length > width ? `${value.slice(0, width - 1)}…` : value; };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// A path inside one of the workspace's folders, shown relative to it; anything else as it is.
export function shortPath(file, roots = []) {
  const value = String(file || '');
  if (!path.isAbsolute(value)) return value;
  for (const root of roots) {
    const relative = path.relative(root, value);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
    if (relative === '') return path.basename(value);
  }
  const home = process.env.HOME;
  return home && value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

// Codex runs commands through a login shell: `/bin/zsh -lc 'git log'` reads better as `git log`.
export function unwrapShell(command) {
  const match = String(command || '').match(/^\S*\/(?:ba|z|fi)?sh\s+-l?c\s+([\s\S]+)$/);
  if (!match) return String(command || '');
  const inner = match[1].trim();
  if (inner.startsWith("'") && inner.endsWith("'")) return inner.slice(1, -1).replace(/'\\''/g, "'");
  if (inner.startsWith('"') && inner.endsWith('"')) return inner.slice(1, -1).replace(/\\"/g, '"');
  return inner;
}

// Output without its blank first and last lines, and without the indent every line shares.
function tidy(lines) {
  const kept = [...lines]; while (kept.length && !kept[0].trim()) kept.shift(); while (kept.length && !kept.at(-1).trim()) kept.pop();
  const indent = Math.min(...kept.filter(line => line.trim()).map(line => line.match(/^\s*/)[0].length));
  return kept.map(line => line.slice(Number.isFinite(indent) ? indent : 0).trimEnd()).join('\n');
}

// A step as the engine records it. Claude's tools are "Name\n{input}\noutput"; Codex's commands are "$ command\noutput"
// and its edits "File changes: [...]". Anything else is a note, such as "Approval allowed by the user."
export function parseActivity(text) {
  const value = String(text ?? ''), lines = value.split('\n'), first = lines[0].trim();
  if (/^[A-Za-z_][\w.:-]*$/.test(first) && lines[1]?.trim().startsWith('{')) {
    try { return { kind: 'tool', tool: first, input: JSON.parse(lines[1]), output: tidy(lines.slice(2)) }; } catch { /* Not a tool step after all. */ }
  }
  if (first.startsWith('$ ')) return { kind: 'tool', tool: 'Bash', input: { command: unwrapShell(first.slice(2)) }, output: tidy(lines.slice(1)) };
  const changes = value.match(/^File changes: (\[[\s\S]*\])\s*$/);
  if (changes) { try { return { kind: 'changes', files: JSON.parse(changes[1]) }; } catch { /* Shown as a note. */ } }
  return { kind: 'note', text: value.trim() };
}

// The lines that changed between two versions of some text: the common start and end are left out.
export function lineDiff(before, after) {
  const a = String(before ?? '').replace(/\n$/, '').split('\n'), b = String(after ?? '').replace(/\n$/, '').split('\n');
  if (before === '' || before == null) return { removed: [], added: after ? b : [] };
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0; while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
}

function diffLines(removed, added, { limit = 12, width = 200 } = {}) {
  const all = [...removed.map(line => ['-', line]), ...added.map(line => ['+', line])];
  const shown = all.slice(0, limit).map(([sign, line]) => [span('    '), span(`${sign} ${clip(line, width)}`, { color: sign === '+' ? 'green' : 'red' })]);
  if (all.length > limit) shown.push([span(`    … ${plural(all.length - limit, 'more line')}`, { dim: true })]);
  return shown;
}

const counted = (added, removed) => [added ? `Added ${plural(added, 'line')}` : '', removed ? `${added ? 'removed' : 'Removed'} ${plural(removed, 'line')}` : ''].filter(Boolean).join(', ') || 'No lines changed';

// A file edit's changes, from Claude's Edit, MultiEdit and Write inputs.
export function editChanges(tool, input = {}) {
  if (tool === 'Write') return lineDiff('', input.content ?? '');
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.reduce((sum, edit) => { const diff = lineDiff(edit.old_string, edit.new_string); return { removed: [...sum.removed, ...diff.removed], added: [...sum.added, ...diff.added] }; }, { removed: [], added: [] });
  }
  if ('old_string' in input || 'new_string' in input) return lineDiff(input.old_string ?? '', input.new_string ?? '');
  return null;
}

// Tool names as the session shows them, with the argument that says what each did.
const TOOL_LABEL = { Read: 'Read', Edit: 'Update', MultiEdit: 'Update', Write: 'Write', NotebookEdit: 'Update', Bash: 'Bash', Grep: 'Search', Glob: 'Search', LS: 'List', WebFetch: 'Fetch', WebSearch: 'Web search', Task: 'Task', Agent: 'Task', TodoWrite: 'Update todos' };
function toolArgument(tool, input = {}, roots) {
  const file = input.file_path || input.notebook_path || input.path;
  if (tool === 'Bash') return input.command || '';
  if (tool === 'Grep') return `"${input.pattern || ''}"${input.path ? ` in ${shortPath(input.path, roots)}` : ''}`;
  if (tool === 'Glob') return input.pattern || '';
  if (tool === 'WebFetch') return input.url || '';
  if (tool === 'WebSearch') return input.query || '';
  if (tool === 'Task' || tool === 'Agent') return input.description || '';
  if (tool === 'TodoWrite') return '';
  if (file) return shortPath(file, roots);
  const first = Object.values(input).find(value => typeof value === 'string');
  return first || '';
}

// One step of a run, as a header line and a few detail lines.
//   ● Update(math.js)
//     ⎿ Added 1 line
//       + export const subtract = (a, b) => a - b;
export function formatActivity(message, { roots = [], width = 100, pending = false } = {}) {
  const step = parseActivity(message.text), failed = message.toolOutcome?.isError === true;
  const bullet = span('● ', { color: pending ? ACCENT : failed ? 'red' : 'green' });
  if (step.kind === 'note') return step.text.split('\n').filter(line => line.trim()).slice(0, 4).map((line, index) => [span(index ? '    ' : '  ⎿ ', { dim: true }), span(clip(line, width), { dim: true })]);
  if (step.kind === 'changes') {
    return step.files.flatMap(file => [
      [bullet, span(file.kind === 'add' ? 'Write' : file.kind === 'delete' ? 'Delete' : 'Update', { bold: true }), span(`(${shortPath(file.path, roots)})`)],
      [span('  ⎿ ', { dim: true }), span(file.kind === 'delete' ? 'Deleted' : counted(file.added || 0, file.removed || 0), { dim: true })],
    ]);
  }
  // A question is answered in its own box, and the answer follows as a note.
  if (step.tool === 'AskUserQuestion') return [[bullet, span('Question', { bold: true }), ...(step.input.questions?.[0]?.question ? [span(`(${clip(step.input.questions[0].question, width)})`)] : [])]];
  const label = TOOL_LABEL[step.tool] || step.tool.replace(/^mcp__([^_]+)__/, '$1 · ');
  const argument = toolArgument(step.tool, step.input, roots);
  const lines = [[bullet, span(label, { bold: true }), ...(argument ? [span(`(${clip(argument.split('\n')[0], width)})`)] : [])]];
  const detail = text => lines.push([span('  ⎿ ', { dim: true }), span(text, { dim: true })]);
  const changes = editChanges(step.tool, step.input);
  if (changes) {
    if (pending) detail('Waiting for your answer…');
    else if (failed) detail(clip(step.output.split('\n').find(Boolean) || 'The edit failed.', width));
    else { detail(counted(changes.added.length, changes.removed.length)); lines.push(...diffLines(changes.removed, changes.added, { width })); }
    return lines;
  }
  if (step.tool === 'TodoWrite' && Array.isArray(step.input.todos)) {
    for (const todo of step.input.todos.slice(0, 8)) lines.push([span('    '), span(todo.status === 'completed' ? '☒ ' : '☐ ', { dim: todo.status === 'completed' }), span(todo.content || '', { dim: todo.status === 'completed', bold: todo.status === 'in_progress' })]);
    return lines;
  }
  if (pending) { detail('Running…'); return lines; }
  const output = step.output.split('\n').filter(line => line.trim());
  if (step.tool === 'Read') detail(output.length ? `Read ${plural(output.length, 'line')}` : 'Read');
  else if (step.tool === 'Grep' || step.tool === 'Glob') detail(output.length ? `Found ${plural(output.length, output.length === 1 ? 'match' : 'result')}` : 'Nothing found');
  else if (output.length) {
    output.slice(0, 3).forEach((line, index) => lines.push([span(index ? '    ' : '  ⎿ ', { dim: true }), span(clip(line, width), { dim: !failed, color: failed ? 'red' : undefined })]));
    if (output.length > 3) lines.push([span(`    … ${plural(output.length - 3, 'more line')}`, { dim: true })]);
  }
  return lines;
}

// Inline Markdown: **bold**, `code` and *italic*, as spans.
export function inline(text, base = {}) {
  const spans = [], pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > last) spans.push(span(text.slice(last, match.index), base));
    const token = match[0];
    if (token.startsWith('**')) spans.push(span(token.slice(2, -2), { ...base, bold: true }));
    else if (token.startsWith('`')) spans.push(span(token.slice(1, -1), { ...base, color: 'cyan' }));
    else spans.push(span(token.slice(1, -1), { ...base, italic: true }));
    last = match.index + token.length;
  }
  if (last < text.length) spans.push(span(text.slice(last), base));
  return spans.length ? spans : [span('', base)];
}

// The agent's reply, as Markdown drawn for a terminal: headings, lists, quotes, code blocks and inline styles.
export function formatMarkdown(text, { bullet = true } = {}) {
  const lines = [], source = String(text ?? '').replace(/\s+$/, '').split('\n');
  let fence = null;
  for (const raw of source) {
    const prefix = () => [span(lines.length === 0 && bullet ? '● ' : '  ', lines.length === 0 && bullet ? {} : {})];
    const fenceMatch = raw.match(/^\s*(```|~~~)(.*)$/);
    if (fenceMatch) { fence = fence ? null : fenceMatch[2].trim() || 'code'; continue; }
    if (fence) { lines.push([...prefix(), span('│ ', { dim: true }), span(raw, { color: 'cyan' })]); continue; }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { lines.push([...prefix(), ...inline(heading[2], { bold: true })]); continue; }
    const item = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) { const marker = /\d/.test(item[2]) ? item[2] : '•'; lines.push([...prefix(), span(`${item[1]}${marker} `, { dim: marker === '•' }), ...inline(item[3])]); continue; }
    const quote = raw.match(/^>\s?(.*)$/);
    if (quote) { lines.push([...prefix(), span('│ ', { dim: true }), ...inline(quote[1], { italic: true, dim: true })]); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) { lines.push([...prefix(), span('─'.repeat(24), { dim: true })]); continue; }
    lines.push([...prefix(), ...inline(raw)]);
  }
  return lines;
}

// A message that ends a run badly, or says something the person should see.
export function formatNotice(message, width = 200) {
  const error = message.role === 'error';
  return String(message.text || '').split('\n').filter(Boolean).slice(0, 6).map((line, index) => [span(index ? '  ' : error ? '✗ ' : '! ', { color: error ? 'red' : 'yellow' }), span(clip(line, width), { color: error ? 'red' : undefined })]);
}

export function formatUser(message) {
  return String(message.text || '').split('\n').map((line, index) => [span(index ? '  ' : '› ', { color: ACCENT, bold: true }), span(line, { dim: false })]);
}

// The access a conversation runs with, in a few words.
export function accessLabel(mode, approvalPolicy) {
  if (mode === 'read') return 'read only';
  return approvalPolicy === 'auto' ? 'edits without asking' : 'asks before changes';
}
// Shift+Tab steps through these, as the session's status line shows them.
export const ACCESS_STEPS = [{ mode: 'edit', approvalPolicy: 'ask' }, { mode: 'edit', approvalPolicy: 'auto' }, { mode: 'read', approvalPolicy: 'ask' }];
export function nextAccess(mode, approvalPolicy) {
  const index = ACCESS_STEPS.findIndex(step => step.mode === mode && (mode === 'read' || step.approvalPolicy === approvalPolicy));
  return ACCESS_STEPS[(index + 1) % ACCESS_STEPS.length];
}

// The model's name from the agent's catalogue, or its ID.
export function modelName(catalogue, model) {
  const id = entry => entry.value || entry.id || entry.model;
  if (!model || model === 'default') {
    const fallback = catalogue?.find(entry => entry.isDefault) || catalogue?.find(entry => id(entry) === 'default');
    if (!fallback) return 'default model';
    if (id(fallback) !== 'default') return fallback.displayName || id(fallback);
    return catalogue.find(entry => id(entry) !== 'default' && entry.resolvedModel === fallback.resolvedModel)?.displayName || fallback.resolvedModel || 'default model';
  }
  const found = catalogue?.find(entry => [entry.value, entry.id, entry.model].includes(model));
  return found?.displayName || model;
}
// The catalogue entry used when no model is chosen.
export const defaultModelId = catalogue => { const entry = catalogue?.find(item => item.isDefault) || catalogue?.find(item => (item.value || item.id) === 'default'); return entry ? entry.value || entry.id || entry.model : 'default'; };

// An approval or question, for the box that asks it: a title, what it's about and, for an edit, the change.
export function describeRequest(item, { roots = [], width = 100 } = {}) {
  const agent = agentName(item.provider), input = item.input || {};
  const command = item.command || input.command, file = input.file_path || input.notebook_path || input.path;
  if (item.kind === 'question') return { title: `${agent} has ${item.questions?.length > 1 ? `${item.questions.length} questions` : 'a question'}`, lines: [] };
  const changes = editChanges(item.kind, input);
  if (changes || (file && !command)) {
    const lines = changes ? diffLines(changes.removed, changes.added, { width, limit: 16 }) : [];
    return { title: `${item.kind === 'Write' ? 'Create' : 'Edit'} ${shortPath(file, roots)}`, lines, question: `Do you want ${agent} to make this ${item.kind === 'Write' ? 'file' : 'edit'}?` };
  }
  if (command) return { title: 'Run a command', lines: [[span('    '), span(unwrapShell(command), { bold: true })], ...(item.reason || input.description ? [[span('    '), span(item.reason || input.description, { dim: true })]] : [])], question: `Do you want ${agent} to run it?` };
  if (item.connector) return { title: `Use ${item.connector}`, lines: item.title ? [[span('    '), span(item.title, { dim: true })]] : [], question: `Do you want ${agent} to use ${item.connector}?` };
  if (item.kind === 'item/permissions/requestApproval') return { title: 'More access', lines: item.title ? [[span('    '), span(item.title, { dim: true })]] : [], question: `Do you want to give ${agent} more access?` };
  return { title: item.title || item.kind || 'Permission', lines: Object.keys(input).length ? [[span('    '), span(clip(JSON.stringify(input), width), { dim: true })]] : [], question: `Do you want to allow ${agent} to do this?` };
}

// The choices an approval offers. The engine accepts "remember for this run" only when it gave the request a scope.
export function approvalChoices(item) {
  return [
    { id: 'yes', label: 'Yes' },
    ...(item.scope ? [{ id: 'run', label: `Yes, and don't ask again for ${item.scope.label ? item.scope.label.replace(/^./, letter => letter.toLowerCase()) : 'this'} in this run` }] : []),
    { id: 'no', label: 'No', hint: 'esc' },
  ];
}

export const formatElapsed = ms => { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`; };
export const formatTokens = count => count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k` : String(count);

// Which messages are final and can go into the terminal's scrollback, in order. The first one still changing, and
// everything after it, stay in the live area under it, so the scrollback never shows a step out of order.
export function settledMessages(messages, { printed, activeRunId }) {
  const ready = [], live = [];
  let holding = false;
  messages.forEach((message, index) => {
    if (printed.has(message.id)) return;
    const running = activeRunId && message.runId === activeRunId, last = index === messages.length - 1;
    const settled = !running || message.role === 'user' || message.role === 'error' || message.role === 'notice'
      || (message.role === 'assistant' ? message.status === 'complete' || !last : message.toolOutcome ? message.toolOutcome.status !== 'running' && message.toolOutcome.status !== 'pending' && message.toolOutcome.status !== 'in_progress' : !last);
    if (!holding && settled) ready.push(message); else { holding = true; live.push(message); }
  });
  return { ready, live };
}

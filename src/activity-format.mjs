// How a step of a run is saved in the conversation: small enough to keep, and always readable afterwards. A tool's
// input stays one valid line of JSON, and a file change keeps its path, what happened to it and how many lines.

const lines = text => { const value = String(text ?? ''); return value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0; };
// Lines removed and added by replacing one text with another: lines both share at the start and the end are set
// aside, and the rest are compared line by line when that stays quick.
export function lineCounts(before = '', after = '') {
  const split = text => (text = String(text ?? '')) ? text.split('\n') : [], a = split(before), b = split(after);
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end), y = b.slice(start, b.length - end);
  return { added: y.length - kept(x, y), removed: x.length - kept(x, y) };
}
// How many lines two texts keep in common, in order (their longest common subsequence).
function kept(x, y) {
  if (!x.length || !y.length || x.length * y.length > 1000000) return 0;
  let previous = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    const row = new Uint32Array(y.length + 1);
    for (let j = 1; j <= y.length; j++) row[j] = x[i - 1] === y[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1]);
    previous = row;
  }
  return previous[y.length];
}
// What a file-editing tool changed, in lines; null for other tools. A written file only reports the lines it has.
export function toolCounts(name, input = {}) {
  if (['Edit', 'edit_file'].includes(name) && (typeof input.old_string === 'string' || typeof input.new_string === 'string')) return lineCounts(input.old_string, input.new_string);
  if (name === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.reduce((sum, edit) => { const counts = lineCounts(edit?.old_string, edit?.new_string); return { added: sum.added + counts.added, removed: sum.removed + counts.removed }; }, { added: 0, removed: 0 });
  if (['Write', 'write_file'].includes(name) && typeof input.content === 'string') return { added: lines(input.content) };
  return null;
}
const shorten = (value, limit) => typeof value === 'string' ? (value.length > limit ? `${value.slice(0, limit)}… [${value.length - limit} more characters]` : value)
  : Array.isArray(value) ? value.slice(0, 50).map(item => shorten(item, limit))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shorten(item, limit)])) : value;
// A tool's input as one line of JSON that always parses. Long text inside it is shortened rather than the line being
// cut, and an editing tool whose text was shortened keeps its line counts.
export function toolInput(name, input, max = 12000) {
  const value = input && typeof input === 'object' ? input : {}, json = JSON.stringify(value);
  if (json.length <= max) return json;
  const counts = toolCounts(name, value);
  for (const limit of [4000, 1500, 400, 100]) {
    const text = JSON.stringify({ ...shorten(value, limit), ...(counts ? { lineCounts: counts } : {}) });
    if (text.length <= max) return text;
  }
  return JSON.stringify({ ...Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'object').map(([key, item]) => [key, shorten(item, 200)]).slice(0, 20)), shortened: true });
}

// Added and removed lines in a diff. A new or deleted file may come as its plain contents instead of a diff.
export function diffCounts(diff, kind) {
  const text = String(diff ?? '');
  if (!text) return null;
  const rows = text.split('\n');
  if (!rows.some(row => row.startsWith('@@'))) return kind === 'add' ? { added: lines(text), removed: 0 } : kind === 'delete' ? { added: 0, removed: lines(text) } : null;
  let added = 0, removed = 0;
  for (const row of rows) { if (row.startsWith('+') && !row.startsWith('+++')) added++; else if (row.startsWith('-') && !row.startsWith('---')) removed++; }
  return { added, removed };
}
// Codex reports a kind as "add", "delete" or "update", or as { type, move_path } with the file's diff. Each change is
// The latest file a run's steps edited, for the preview's toolbar (#102): the file and its line counts, never its contents.
export function latestEdit(messages = [], folders = []) {
  const relative = file => { for (const folder of folders) if (folder && file.startsWith(`${folder}/`)) return file.slice(folder.length + 1); return file.startsWith('/') ? file.split('/').pop() : file; };
  const found = (file, counts) => ({ path: relative(String(file)), added: counts?.added || 0, removed: counts?.removed || 0 });
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'activity') continue;
    const text = String(message.text || '');
    if (text.startsWith('File changes:')) {
      try { const changes = JSON.parse(text.slice('File changes:'.length)), last = changes.findLast?.(change => change?.path || change?.file); if (last) return found(last.path || last.file, last); } catch { /* A step that can't be read says nothing. */ }
      continue;
    }
    const tool = text.match(/^([A-Za-z_][\w-]*)\n(\{.*\})/);
    if (!tool || !['Edit', 'MultiEdit', 'Write', 'edit_file', 'write_file'].includes(tool[1])) continue;
    try { const input = JSON.parse(tool[2]), file = input.file_path || input.path; if (file) return found(file, input.lineCounts || toolCounts(tool[1], input)); } catch { /* As above. */ }
  }
  return null;
}
// kept as its path, what happened to it, where it moved and its line counts, without the diff itself.
export function fileChanges(changes) {
  return (Array.isArray(changes) ? changes : []).slice(0, 200).map(change => {
    const raw = String(typeof change?.kind === 'string' ? change.kind : change?.kind?.type || change?.type || '').toLowerCase();
    const kind = ['add', 'added', 'create', 'created'].includes(raw) ? 'add' : ['delete', 'deleted', 'remove', 'removed'].includes(raw) ? 'delete' : 'update';
    const moved = change?.kind?.move_path || change?.move_path, counts = typeof change?.diff === 'string' ? diffCounts(change.diff, kind) : null;
    return { path: String(change?.path || change?.file || ''), kind, ...(moved ? { to: String(moved) } : {}), ...(counts || {}) };
  }).filter(change => change.path);
}

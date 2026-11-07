import os from 'node:os';
import path from 'node:path';

// One line saying what an agent asked to do, for the run's activity.
export function requestSummary(request = {}) {
  let command = request.command ?? request.input?.command;
  if (Array.isArray(command)) command = command.length === 3 && ['-c', '-lc'].includes(command[1]) ? command[2] : command.join(' ');
  const tool = request.connector && request.title ? `${request.connector}: ${request.title}` : null;
  return String(command || tool || request.reason || request.title || 'A change outside the sandbox').split('\n')[0].slice(0, 200);
}

// What a command prints when a read-only sandbox stopped it. It reads like a network or disk fault, not like a setting.
const sandboxBlock = /could not resolve host|temporary failure in name resolution|name or service not known|network is unreachable|enotfound|eai_again|read-only file system|erofs|operation not permitted/i;
export const blockedBySandbox = output => sandboxBlock.test(String(output || ''));

// "Ask before changes": approval requests for actions that only read the workspace are allowed without asking.
// Anything that could write, delete, install, reach the network, run project code, or read outside the workspace
// folders still asks. The rules err toward asking: shell features the check cannot fully reason about (chaining,
// redirection, substitution, variables, unknown programs or paths) always ask.

const readTools = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'read_file', 'list_directory', 'glob', 'search_file_content', 'read_many_files']);
const readKinds = new Set(['read', 'search', 'think']);
const commandTools = new Set(['Bash', 'item/commandExecution/requestApproval', 'execute', 'run_shell_command', 'shell']);

// Programs that only print, with any arguments. Options that write are rejected separately.
const printers = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'file', 'stat', 'du', 'df', 'tree', 'which', 'type', 'whoami', 'date', 'echo', 'basename', 'dirname', 'realpath', 'readlink', 'uname', 'diff', 'cmp', 'comm', 'cut', 'tr', 'nl', 'column', 'jq', 'true', 'false', 'test', 'od', 'hexdump', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum']);
const writingOptions = { sort: ['-o', '--output'], tree: ['-o'], rg: ['--pre'] };
const findWrites = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const gitReads = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'describe', 'shortlog', 'cat-file', 'merge-base', 'name-rev', 'whatchanged', 'count-objects']);
const versionPrograms = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'pip', 'pip3', 'ruby', 'go', 'rustc', 'cargo', 'java', 'javac', 'swift', 'php', 'git', 'gh', 'docker', 'tsc', 'clang', 'gcc', 'make', 'cmake']);

// Splits a simple shell command into words. Returns null for anything beyond plain words, quotes and pipes.
function words(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000) return null;
  if (/[;&<>`$\\\n\r(){}]/.test(command) || /\|\|/.test(command)) return null;
  const segments = [[]];
  let current = '', quote = null, started = false;
  for (const char of command) {
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '|') { if (started) segments.at(-1).push(current); current = ''; started = false; segments.push([]); continue; }
    if (/\s/.test(char)) { if (started) segments.at(-1).push(current); current = ''; started = false; continue; }
    current += char; started = true;
  }
  if (quote) return null;
  if (started) segments.at(-1).push(current);
  return segments.every(segment => segment.length) ? segments : null;
}

const insideAny = (target, roots) => roots.some(root => target === root || target.startsWith(root + path.sep));
// Arguments naming a path must stay inside the workspace folders.
function pathsInside(args, cwd, roots) {
  for (const arg of args) {
    const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (!value || value.startsWith('-') && !value.includes('/')) continue;
    if (value.startsWith('~')) return false;
    if (value.startsWith('/') || value.includes('..') || value.includes('/')) {
      const resolved = path.resolve(cwd, value);
      if (!insideAny(resolved, roots)) return false;
    }
  }
  return true;
}

function readOnlySegment(args, cwd, roots) {
  const [program, ...rest] = args;
  if (!/^[\w.+-]+$/.test(program)) return false; // Paths and assignments name something that cannot be checked.
  if (rest.length === 1 && ['--version', '-v', '-V', 'version'].includes(rest[0]) && versionPrograms.has(program)) return true;
  if (printers.has(program)) {
    const writes = writingOptions[program] || [];
    if (rest.some(arg => writes.some(option => arg === option || arg.startsWith(option + '=') || arg.startsWith(option) && option.length === 2 && !option.startsWith('--')))) return false;
    if (program === 'tail' && rest.some(arg => arg === '-f' || arg === '-F' || arg === '--follow')) return false; // Never ends.
    if (program === 'date' && rest.some(arg => !arg.startsWith('+') && !['-u', '-R', '-I', '--utc'].includes(arg))) return false; // Can set the clock.
    return pathsInside(rest, cwd, roots);
  }
  if (program === 'find') return !rest.some(arg => findWrites.has(arg)) && pathsInside(rest, cwd, roots);
  if (program === 'git') {
    let index = 0;
    while (rest[index] === '--no-pager' || rest[index] === '-C') index += rest[index] === '-C' ? 2 : 1;
    if (rest.slice(0, index).includes('-C') && !pathsInside([rest[rest.indexOf('-C') + 1] || ''], cwd, roots)) return false;
    const [command, ...options] = rest.slice(index);
    if (command === 'branch') return options.every(option => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes', '--verbose'].includes(option));
    if (command === 'remote') return options.every(option => option === '-v' || option === '--verbose');
    // A tag name without --list creates a tag.
    if (command === 'tag') return !options.length || (options.includes('-l') || options.includes('--list')) && options.every(option => option === '-l' || option === '--list' || !option.startsWith('-'));
    if (command === 'config') return options.some(option => ['--get', '--list', '-l', '--get-all'].includes(option)) && !options.some(option => ['--add', '--unset', '--unset-all', '--replace-all', '--edit', '-e'].includes(option));
    if (command === 'diff' && options.some(option => option.startsWith('--output'))) return false;
    if (command === 'log' && options.some(option => option.startsWith('--output'))) return false;
    return gitReads.has(command) && pathsInside(options, cwd, roots);
  }
  return false;
}

// Whether a shell command only reads files inside the workspace folders.
export function readOnlyCommand(command, { cwd, workspaces = [] } = {}) {
  const roots = workspaces.map(root => path.resolve(root));
  const directory = path.resolve(cwd || roots[0] || os.homedir());
  if (!insideAny(directory, roots)) return false;
  // Codex can send the command as argv, including a shell wrapper around the real command.
  if (Array.isArray(command)) {
    if (command.length === 3 && ['bash', 'sh', 'zsh', '/bin/bash', '/bin/sh', '/bin/zsh'].includes(command[0]) && ['-c', '-lc'].includes(command[1])) command = command[2];
    else if (command.every(part => typeof part === 'string')) command = command.map(part => /[\s'"]/.test(part) ? `'${part.replace(/'/g, '')}'` : part).join(' ');
    else return false;
  }
  const segments = words(command);
  return Boolean(segments) && segments.every(segment => readOnlySegment(segment, directory, roots));
}

// Whether an approval request only reads the workspace, and a short description for the activity log.
export function readOnlyRequest(request = {}, { workspaces = [] } = {}) {
  const roots = workspaces.map(root => path.resolve(root)), kind = String(request.kind || '');
  const input = request.input && typeof request.input === 'object' ? request.input : {};
  // Every path a read names must be inside the workspace folders; a home-relative path never is.
  const inside = target => typeof target === 'string' && !target.startsWith('~') && insideAny(path.resolve(roots[0] || '/', target), roots);
  const named = [input.file_path, input.path, input.notebook_path, input.directory, input.absolute_path, input.dir_path, ...(Array.isArray(input.paths) ? input.paths : [])].filter(value => value !== undefined && value !== null && value !== '');
  if (readTools.has(kind)) {
    const pattern = ['Glob', 'glob'].includes(kind) && typeof input.pattern === 'string' && /^[/~]/.test(input.pattern) ? [input.pattern] : [];
    return roots.length > 0 && [...named, ...pattern].every(inside);
  }
  if (readKinds.has(kind)) {
    const locations = (request.toolCall?.locations || []).map(location => location?.path).filter(Boolean);
    return roots.length > 0 && [...named, ...locations].every(inside);
  }
  if (commandTools.has(kind)) {
    const command = request.command ?? input.command ?? request.toolCall?.rawInput?.command;
    return readOnlyCommand(command, { cwd: request.cwd || input.directory || input.cwd || roots[0], workspaces: roots });
  }
  return false;
}

// What an approval can be remembered as: the exact action, never a broader one. A command is its agent, its exact words
// and the folder it runs in, and only a single command without pipes, chaining or redirection qualifies. A file edit is
// its agent and that exact file inside the workspace. Anything else can only be allowed once.
const editTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write_file', 'replace', 'edit_file']);
export function approvalScope(request = {}, { provider, workspaces = [] } = {}) {
  const roots = workspaces.map(root => path.resolve(root)), kind = String(request.kind || '');
  const input = request.input && typeof request.input === 'object' ? request.input : {};
  if (!roots.length || !provider) return null;
  if (commandTools.has(kind)) {
    let command = request.command ?? input.command ?? request.toolCall?.rawInput?.command;
    if (Array.isArray(command) && command.length === 3 && ['-c', '-lc'].includes(command[1]) && /(?:^|\/)(?:ba|z)?sh$/.test(command[0])) command = command[2];
    const segments = typeof command === 'string' ? words(command) : null;
    if (!segments || segments.length !== 1) return null;
    const cwd = path.resolve(request.cwd || input.directory || input.cwd || roots[0]);
    if (!insideAny(cwd, roots)) return null;
    const argv = segments[0], label = argv.map(word => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word}'`).join(' ');
    return { kind: 'command', key: JSON.stringify([provider, 'command', cwd, argv]), label, cwd };
  }
  if (editTools.has(kind)) {
    const target = input.file_path || input.path || input.absolute_path || input.notebook_path || request.toolCall?.locations?.[0]?.path;
    if (typeof target !== 'string' || target.startsWith('~')) return null;
    const file = path.resolve(roots[0], target);
    if (!insideAny(file, roots)) return null;
    const root = roots.find(candidate => file.startsWith(candidate + path.sep)) || roots[0];
    return { kind: 'edit', key: JSON.stringify([provider, 'edit', file]), label: `Edit ${path.relative(root, file) || path.basename(file)}`, path: file };
  }
  return null;
}

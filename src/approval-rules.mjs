import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unwrapShell } from './cli-format.mjs';

// One line saying what an agent asked to do, for the run's activity.
export function requestSummary(request = {}) {
  let command = request.command ?? request.input?.command;
  if (Array.isArray(command)) command = command.length === 3 && ['-c', '-lc'].includes(command[1]) ? command[2] : command.join(' ');
  // Codex names the shell it runs a command through, and the line reads better without it.
  else if (typeof command === 'string') command = unwrapShell(command);
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

// Codex runs each command through the person's shell and asks about the whole line, such as `/bin/zsh -lc 'git status'`
// (the same can arrive as argv). What that shell runs, when the line is exactly a known shell given one script;
// anything else stays as it is, and is judged and remembered together with whatever runs it.
const codexCommands = 'item/commandExecution/requestApproval';
const wrappingShells = new Set(['bash', 'sh', 'zsh', '/bin/bash', '/bin/sh', '/bin/zsh']);
function shellScript(command) {
  const line = typeof command === 'string' ? words(command) : null;
  return line?.length === 1 && line[0].length === 3 && wrappingShells.has(line[0][0]) && ['-c', '-lc'].includes(line[0][1]) ? line[0][2] : command;
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
    if (command.length === 3 && wrappingShells.has(command[0]) && ['-c', '-lc'].includes(command[1])) command = command[2];
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
    // Input Codex sends to a terminal that is already running isn't the command it names, so it always asks.
    if (request.codexKind) return false;
    const command = request.command ?? input.command ?? request.toolCall?.rawInput?.command;
    return readOnlyCommand(kind === codexCommands ? shellScript(command) : command, { cwd: request.cwd || input.directory || input.cwd || roots[0], workspaces: roots });
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
    if (request.codexKind) return null;
    let command = request.command ?? input.command ?? request.toolCall?.rawInput?.command;
    if (Array.isArray(command) && command.length === 3 && ['-c', '-lc'].includes(command[1]) && /(?:^|\/)(?:ba|z)?sh$/.test(command[0])) command = command[2];
    else if (kind === codexCommands) command = shellScript(command);
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

// A shell command as the simple commands it runs, in order: each one's words, the files its output is sent to, and the
// folder it runs in, following cd, pushd and popd (null once that can't be known, as after cd $DIR). A quoted word stays
// whole. $HOME, ${HOME} and a leading ~ are the home folder and $PWD the folder it's in; any other expansion can't be
// known, so a word holding one carries OPAQUE. What $(...), backticks, sh -c and eval run is read as commands of its own,
// and a here-document's text isn't read as commands. Returns null for a command this can't follow.
const OPAQUE = '\u0000';
const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const keywords = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', '!', '{', '}', 'time']);
function shellSteps(command, { cwd = null, home = os.homedir(), depth = 0 } = {}) {
  if (typeof command !== 'string' || command.length > 20000 || depth > 3) return null;
  const steps = [], subshells = [], pushed = [], heredocs = [];
  let dir = cwd, words = [], outputs = [], word = null, redirect = null, failed = false;
  const add = text => { word = (word ?? '') + text; };
  const nested = (text, at) => { const inner = shellSteps(text, { cwd: at, home, depth: depth + 1 }); if (inner) steps.push(...inner); else failed = true; return OPAQUE; };
  // Where the bracket opened at open closes, past the quotes and brackets inside it; -1 if it doesn't.
  const closing = open => {
    for (let j = open + 1, level = 1; j < command.length; j++) {
      const char = command[j];
      if (char === '\\') { j++; continue; }
      if (char === "'") { j = command.indexOf("'", j + 1); if (j === -1) return -1; continue; }
      if (char === '"') { for (j++; j < command.length && command[j] !== '"'; j++) if (command[j] === '\\') j++; if (j >= command.length) return -1; continue; }
      if (char === '(') level++;
      if (char === ')' && --level === 0) return j;
    }
    return -1;
  };
  const backtick = open => { for (let j = open + 1; j < command.length; j++) { if (command[j] === '\\') { j++; continue; } if (command[j] === '`') return j; } return -1; };
  // The $ expansion at i: what it stands for, and the index it ends at.
  const expansion = i => {
    const rest = command.slice(i + 1);
    if (rest.startsWith('((')) { const end = command.indexOf('))', i + 3); return end === -1 ? null : { text: OPAQUE, end: end + 1 }; }
    if (rest.startsWith('(')) { const end = closing(i + 1); return end === -1 ? null : { text: nested(command.slice(i + 2, end), dir), end }; }
    const braced = rest.match(/^\{([^}]*)\}/), plain = rest.match(/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/);
    const name = braced ? braced[1] : plain?.[0];
    if (name === undefined) return { text: '$', end: i };
    return { text: name === 'HOME' ? home : name === 'PWD' && dir ? dir : OPAQUE, end: i + (braced ? braced[0].length : name.length) };
  };
  const finishWord = () => {
    if (word === null) return;
    const value = word; word = null;
    if (!redirect) { words.push(value); return; }
    const kind = redirect; redirect = null;
    if (kind === 'out' || kind === 'dup' && !/^(?:\d+|-)$/.test(value)) outputs.push(value);
    else if (kind === 'heredoc' || kind === 'heredoc-') heredocs.push({ end: value, strip: kind === 'heredoc-' });
  };
  const finishStep = () => {
    finishWord(); redirect = null;
    const current = words, sent = outputs; words = []; outputs = [];
    while (keywords.has(current[0])) current.shift();
    if (!current.length && !sent.length) return;
    const [program = '', ...args] = current;
    // A shell given a script with -c, or eval, runs that script here.
    const script = shells.has(path.basename(program)) ? args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg)) : -1;
    if (script !== -1 && typeof args[script + 1] === 'string' || program === 'eval') {
      nested(program === 'eval' ? args.join(' ') : args[script + 1], dir);
      if (sent.length) steps.push({ words: [], outputs: sent, dir });
      return;
    }
    steps.push({ words: current, outputs: sent, dir });
    if (program === 'cd' || program === 'pushd') {
      if (program === 'pushd') pushed.push(dir);
      const target = args.find(arg => !/^-[LPe@]+$/.test(arg));
      dir = target === undefined ? (program === 'cd' ? home : dir) : target === '-' || target.includes(OPAQUE) ? null : path.isAbsolute(target) ? path.resolve(target) : dir ? path.resolve(dir, target) : null;
    } else if (program === 'popd') dir = pushed.length ? pushed.pop() : null;
  };
  for (let i = 0; i < command.length && !failed; i++) {
    const char = command[i], next = command[i + 1];
    if (char === '\n') {
      finishStep();
      // The here-documents begun on this line: each one's text runs to a line holding only its end word.
      for (const { end, strip } of heredocs.splice(0)) {
        for (let from = i + 1; ; from = i + 1) {
          if (from >= command.length) { i = command.length; break; }
          const to = command.indexOf('\n', from) === -1 ? command.length : command.indexOf('\n', from), line = command.slice(from, to);
          i = to;
          if ((strip ? line.replace(/^\t+/, '') : line) === end) break;
        }
      }
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') { finishWord(); continue; }
    if (char === '#' && word === null) { const end = command.indexOf('\n', i); i = (end === -1 ? command.length : end) - 1; continue; }
    if (char === '\\') { if (next !== '\n' && next !== undefined) add(next); i++; continue; }
    if (char === "'") { const end = command.indexOf("'", i + 1); if (end === -1) return null; add(command.slice(i + 1, end)); i = end; continue; }
    if (char === '"') {
      let text = '', j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const inner = command[j];
        if (inner === '\\' && '"\\$`\n'.includes(command[j + 1] ?? '')) { if (command[j + 1] !== '\n') text += command[j + 1]; j++; continue; }
        if (inner === '$') { const found = expansion(j); if (!found) return null; text += found.text; j = found.end; continue; }
        if (inner === '`') { const end = backtick(j); if (end === -1) return null; text += nested(command.slice(j + 1, end), dir); j = end; continue; }
        text += inner;
      }
      if (j >= command.length) return null;
      add(text); i = j; continue;
    }
    if (char === '$') { const found = expansion(i); if (!found) return null; add(found.text); i = found.end; continue; }
    if (char === '`') { const end = backtick(i); if (end === -1) return null; add(nested(command.slice(i + 1, end), dir)); i = end; continue; }
    if (char === '~' && word === null && (next === undefined || /[/\s;&|)]/.test(next))) { add(home); continue; }
    if (char === '&' && next === '&' || char === '|' && next === '|') { finishStep(); i++; continue; }
    if (char === '&' && next === '>') { finishWord(); redirect = 'out'; i += command[i + 2] === '>' ? 2 : 1; continue; }
    if (char === ';' || char === '&' || char === '|') { finishStep(); if (char === '|' && next === '&' || char === ';' && next === ';') i++; continue; }
    if (char === '(') { if (word !== null || words.length) return null; finishStep(); subshells.push(dir); continue; }
    if (char === ')') { finishStep(); if (!subshells.length) return null; dir = subshells.pop(); continue; }
    if (char === '>' || char === '<') {
      // A number right before it is the stream it redirects, not a word.
      if (word !== null && /^\d+$/.test(word)) word = null; else finishWord();
      if (next === '(') { const end = closing(i + 1); if (end === -1) return null; add(nested(command.slice(i + 2, end), dir)); finishWord(); i = end; continue; }
      if (char === '<') redirect = command.startsWith('<<<', i) ? 'string' : command.startsWith('<<-', i) ? 'heredoc-' : next === '<' ? 'heredoc' : next === '>' ? 'out' : 'in';
      else redirect = next === '&' ? 'dup' : 'out';
      i += redirect === 'string' || redirect === 'heredoc-' ? 2 : redirect === 'heredoc' || char === '<' && next === '>' || char === '<' && next === '&' || char === '>' && (next === '>' || next === '|' || next === '&') ? 1 : 0;
      continue;
    }
    add(char);
  }
  finishStep();
  return failed || subshells.length ? null : steps;
}

// The command a step runs, past NAME=value settings and the wrappers that only run it, such as env, nohup and timeout.
function unwrap(words) {
  let i = 0;
  for (let round = 0; round < 8; round++) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const word = words[i];
    if (word === 'env') { i++; while (i < words.length && /^-|^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += ['-u', '-C', '-S'].includes(words[i]) ? 2 : 1; continue; }
    if (['nohup', 'exec', 'builtin'].includes(word) || word === 'command' && !/^-/.test(words[i + 1] || '')) { i++; continue; }
    if (word === 'nice') { i++; if (words[i] === '-n') i += 2; else if (/^-\d+$/.test(words[i] || '')) i++; continue; }
    if (word === 'timeout' || word === 'gtimeout') { i++; while (i < words.length && words[i].startsWith('-')) i += ['-s', '--signal', '-k', '--kill-after'].includes(words[i]) ? 2 : 1; i++; continue; }
    break;
  }
  return words.slice(i);
}

const pastOptions = (list, valued) => { let i = 0; while (i < list.length && list[i].startsWith('-') && list[i] !== '--') i += valued.has(list[i]) ? 2 : 1; return list.slice(list[i] === '--' ? i + 1 : i); };
const managerOptions = new Set(['--prefix', '-C', '--dir', '--cwd', '-w', '--workspace', '--filter', '-F', '--loglevel']);

// Commands that change no files: waiting, stopping a process, setting a variable, testing a condition, asking a package
// manager what's installed, or fetching a page without saving it.
const quietPrograms = new Set(['cd', 'pushd', 'popd', 'sleep', 'wait', 'kill', 'pkill', 'killall', 'pgrep', 'ps', 'lsof', 'true', 'false', 'export', 'unset', 'set', ':', '[', '[[', 'printf', 'command']);
function quiet([program, ...args]) {
  if (quietPrograms.has(program)) return true;
  if (program === 'curl') return !args.some(arg => /^--(?:output|output-dir|remote-name|remote-name-all|remote-header-name|dump-header|cookie-jar|trace|trace-ascii|stderr|libcurl|etag-save|hsts|alt-svc|create-dirs)(?:=|$)/.test(arg) || /^-[a-zA-Z]*[oOcDJ]/.test(arg));
  if (program === 'open') return args.length > 0 && args.every(arg => /^https?:\/\//i.test(arg));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    const [command, ...rest] = pastOptions(args, managerOptions);
    return ['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'outdated', 'explain', 'why', 'root', 'bin', 'prefix', 'help'].includes(command) || command === 'config' && ['get', 'list', 'ls'].includes(rest[0]);
  }
  return false;
}

// Where cp, rsync, ditto or git clone copy to, as an absolute path: copying out of a folder only reads it. Null for any
// other command, and for a copy that can also change what it copies from, such as rsync --remove-source-files.
const rsyncValues = new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--exclude-from', '--include-from', '--files-from', '--link-dest', '--compare-dest', '--copy-dest', '--chmod', '--chown', '--rsync-path', '--max-size', '--min-size', '--timeout', '--port', '--password-file', '--bwlimit', '--suffix']);
const cloneValues = new Set(['-b', '--branch', '-o', '--origin', '--depth', '-c', '--config', '--reference', '--reference-if-able', '-j', '--jobs', '--filter', '--template', '-u', '--upload-pack', '--shallow-since', '--shallow-exclude', '--bundle-uri', '--server-option', '--ref-format', '--revision']);
function copyDestination([program, ...args], dir, place) {
  const operands = (list, valued) => { const out = []; for (let i = 0; i < list.length; i++) { const arg = list[i]; if (arg === '--') { out.push(...list.slice(i + 1)); break; } if (valued.has(arg)) { i++; continue; } if (!arg.startsWith('-')) out.push(arg); } return out; };
  if (program === 'cp' || program === 'ditto' || program === 'rsync') {
    if (program === 'rsync' && args.some(arg => /^--(?:remove-source-files|log-file|backup-dir|partial-dir|temp-dir|write-batch|only-write-batch)(?:=|$)/.test(arg) || arg === '-T')) return null;
    const flag = program === 'cp' ? args.findIndex(arg => arg === '-t' || arg === '--target-directory') : -1, named = program === 'cp' ? args.find(arg => arg.startsWith('--target-directory=')) : null;
    if (flag !== -1) return place(args[flag + 1], dir);
    if (named) return place(named.slice('--target-directory='.length), dir);
    const list = operands(args, program === 'rsync' ? rsyncValues : new Set());
    return list.length > 1 ? place(list.at(-1), dir) : null;
  }
  if (program === 'git') {
    let i = 0, base = dir;
    while (i < args.length && args[i].startsWith('-')) { if (args[i] === '-C') base = place(args[i + 1], base); i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1; }
    if (args[i] !== 'clone' || args.some(arg => arg.startsWith('--separate-git-dir'))) return null;
    const list = operands(args.slice(i + 1), cloneValues);
    return list.length ? place(list[1] ?? path.basename(list[0].replace(/[\\/]+$/, '')).replace(/\.git$/, ''), base) : null;
  }
  return null;
}

// Builds, tests, type checks, linters and dev servers: what a task may run in another workspace folder. They write only
// their output and caches there, which Git ignores. A script or option that installs, formats, fixes, updates snapshots,
// generates code, migrates, releases or commits doesn't count, and neither does a program that isn't listed here.
const checkScript = /^(?:build|dev|start|serve|preview|test|tests|typecheck|type-check|types|tsc|check|lint|e2e|storybook)(?:[:._-][\w:.-]*)?$/i;
const changingScript = /fix|format|fmt|write|update|upgrade|migrat|seed|codegen|generat|release|version|deploy|publish|clean|reset|prune|sync|init|setup|install|snapshot|prepare|bump|push|commit|eject/i;
const changingOptions = new Set(['-u', '--update', '--updateSnapshot', '--update-snapshot', '--update-snapshots', '--fix', '--fix-type', '--write']);
const checkTools = { next: ['build', 'dev', 'start', 'lint', 'info'], vite: ['', 'dev', 'serve', 'build', 'preview'], vitest: ['', 'run', 'watch', 'bench', 'list', 'related'], playwright: ['test'], astro: ['build', 'dev', 'preview', 'check'], 'react-scripts': ['build', 'start', 'test'], cargo: ['build', 'test', 'check', 'run', 'clippy', 'bench'], go: ['test', 'vet', 'run'], swift: ['build', 'test', 'run'], dotnet: ['build', 'test', 'run'], flask: ['run'], jest: null, mocha: null, eslint: null, pytest: null, serve: null, 'http-server': null, uvicorn: null, gunicorn: null };
const scriptName = name => typeof name === 'string' && checkScript.test(name) && !changingScript.test(name);
function checksOnly(words) {
  const [first = '', ...args] = words;
  const program = /node_modules[\\/]\.bin[\\/]/.test(first) || path.isAbsolute(first) && /^(?:npm|npx|pnpm|yarn|bun|bunx|node)$/.test(path.basename(first)) ? path.basename(first) : first;
  if (args.some(arg => changingOptions.has(arg.split('=')[0]))) return false;
  // npx and the like run a tool by name, unless told to run a command line with -c.
  const runner = list => { const tool = pastOptions(list, new Set(['-p', '--package'])); return tool.length > 0 && !list.slice(0, list.length - tool.length).some(arg => arg === '-c' || arg.startsWith('--call')) && checksOnly(tool); };
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    const [command, ...rest] = pastOptions(args, managerOptions);
    if (command === 'test' || program !== 'bun' && ['t', 'tst', 'start'].includes(command)) return true;
    if (command === 'run' || command === 'run-script' && program === 'npm') return scriptName(pastOptions(rest, managerOptions)[0]);
    if (command === 'exec' && program !== 'bun' || command === 'dlx' && program !== 'npm' || command === 'x' && (program === 'npm' || program === 'bun')) return runner(rest);
    return (program === 'pnpm' || program === 'yarn') && scriptName(command);
  }
  if (program === 'npx' || program === 'bunx') return runner(args);
  if (program === 'node') return args[0] === '--test' || args[0] === '--run' && scriptName(args[1]);
  if (program === 'python' || program === 'python3') return args[0] === '-m' ? ['pytest', 'unittest', 'http.server'].includes(args[1]) : /(?:^|[\\/])manage\.py$/.test(args[0] || '') && ['runserver', 'test', 'check'].includes(args[1]);
  if (program === 'tsc') return args.some(arg => /^--?noEmit$/.test(arg.split('=')[0]));
  if (!Object.hasOwn(checkTools, program)) return false;
  return !checkTools[program] || checkTools[program].includes(args[0] && !args[0].startsWith('-') ? args[0] : '');
}

// A task changes only its own folder: its copy, or the folder itself when it works there directly. The workspace's other
// folders, and the real folder a copy came from, are guarded, whatever the approval policy: a change there would skip the
// task's review and merge, and could collide with other work. This reads what a request names. An edit tool's file, a
// Codex file change's paths and the root it asks to write to, and write access asked for are checked by path. A command
// is read step by step (shellSteps). A step may read a guarded folder, or copy out of it to somewhere unguarded, and may
// run another folder's builds, tests, type checks, linters and dev servers there (checksOnly), which write only their
// output and caches. The real folder a copy came from gets none of those runs: they belong in the copy. Anything else
// that sends output into a guarded folder, runs in one or names one is refused, as is any command that names one when
// it can't be followed. A command can still reach a folder without naming it, so this keeps honest work in its place
// and isn't a sandbox.
// guarded: each { path, name, copy }, copy being where this task's copy of that folder is, if it has one.
// Returns { path, folder } for the first guarded path, or null.
const changeKinds = new Set([...editTools, 'delete', 'move', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);
export function guardedWrite(request = {}, { own = [], guarded = [], home = os.homedir(), caseless = process.platform !== 'linux', windows = process.platform === 'win32' } = {}) {
  if (!guarded.length || !request || typeof request !== 'object') return null;
  const kind = String(request.kind || ''), input = request.input && typeof request.input === 'object' ? request.input : {};
  if (readTools.has(kind) || readKinds.has(kind)) return null;
  const same = value => caseless ? value.toLowerCase() : value;
  const within = (target, root) => { const a = same(target), b = same(root); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };
  // Gemini names the folder a command runs in relative to its own.
  const roots = own.map(root => path.resolve(root)), cwd = path.resolve(roots[0] || home, String(request.cwd || input.cwd || input.directory || roots[0] || home));
  // The path as it really is: a link on the way to it is followed, as far as the path exists.
  const real = target => {
    let probe = target, rest = '';
    for (let step = 0; step < 64; step++) {
      try { return path.join(fs.realpathSync.native(probe), rest); }
      catch { const parent = path.dirname(probe); if (parent === probe) return target; rest = path.join(path.basename(probe), rest); probe = parent; }
    }
    return target;
  };
  const check = value => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const expanded = value.trim().replace(/^(?:\$\{HOME\}|\$HOME|~)(?=[\\/]|$)/, home);
    const target = path.resolve(cwd, expanded), seen = [target, real(target)];
    if (seen.some(item => roots.some(root => within(item, root)))) return null;
    for (const folder of guarded) { const inside = seen.find(item => within(item, folder.path)); if (inside) return { path: target, real: inside, folder }; }
    return null;
  };
  const first = values => { for (const value of values) { const found = check(value); if (found) return found; } return null; };
  const locations = [...(Array.isArray(request.paths) ? request.paths : []), ...(request.toolCall?.locations || []).map(location => location?.path)];
  if (changeKinds.has(kind)) return first([input.file_path, input.path, input.absolute_path, input.notebook_path, input.target_file, ...(Array.isArray(input.paths) ? input.paths : []), request.grantRoot, ...(Array.isArray(request.writes) ? request.writes : []), ...locations]);
  if (commandTools.has(kind)) {
    let command = request.command ?? input.command ?? request.toolCall?.rawInput?.command;
    if (Array.isArray(command)) command = command.length === 3 && ['-c', '-lc'].includes(command[1]) ? command[2] : command.join(' ');
    if (typeof command !== 'string') return null;
    // On Windows a backslash before a name is a path separator (D:\work\site), as PowerShell and cmd read it, not a POSIX
    // escape, which there would only stand for the letter after it. An escaped space or quote stays an escape.
    if (windows) command = command.replace(/\\(?=[\w.-])/g, '/');
    const everywhere = [...roots, ...guarded.map(folder => folder.path)];
    if (readOnlyCommand(command, { cwd, workspaces: everywhere })) return null;
    const steps = shellSteps(command, { cwd, home });
    if (!steps) {
      // One it can't follow: where it runs, then every word that could be a path. A quoted path is one word, spaces and
      // all, as is one whose spaces are escaped; $HOME and ${HOME} are the home folder, so their braces don't split it.
      const mark = '\u0001', marked = command.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, mark);
      const words = [...marked.matchAll(/"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'`;&|<>(){},=\\])+)/g)].map(match => (match[1] ?? match[2] ?? match[3].replace(/\\(.)/g, '$1')).replaceAll(mark, home));
      return first([cwd, ...words.filter(word => path.isAbsolute(word) || /^[.~$]/.test(word) || /[\\/]/.test(word))]);
    }
    // Where a word of a step points, when that can be known: not a URL, nor a word holding an unknown expansion.
    const place = (value, dir) => typeof value !== 'string' || !value || value.includes(OPAQUE) || /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? null : path.isAbsolute(value) ? path.resolve(value) : dir ? path.resolve(dir, value) : null;
    for (const { words, outputs, dir } of steps) {
      // Output sent to a file in a guarded folder changes it, whatever the command is.
      const sent = first(outputs.map(target => place(target, dir)));
      if (sent) return sent;
      const named = [];
      if (dir) { const found = check(dir); if (found) named.push(found); }
      for (const value of words.flatMap(item => [item, ...(/^(?:--?[\w-]+|[A-Za-z_]\w*)=/.test(item) ? [item.slice(item.indexOf('=') + 1)] : [])])) {
        if (value.startsWith('-') || !(path.isAbsolute(value) || value.startsWith('.') || /[\\/]/.test(value))) continue;
        const found = check(place(value, dir)); if (found) named.push(found);
      }
      if (!named.length) continue;
      const run = unwrap(words);
      if (!run.length || readOnlySegment(run, dir || cwd, everywhere) || quiet(run)) continue;
      const copied = copyDestination(run, dir, place);
      if (copied && !check(copied)) continue;
      if (named.every(found => !found.folder.copy) && checksOnly(run)) continue;
      return named[0];
    }
    return null;
  }
  return first(locations);
}

// What the agent is told when a change is refused, so it can carry on in the right place.
export function guardedReason({ path: target, real = target, folder }, { own = [] } = {}) {
  const copy = folder.copy ? path.join(folder.copy, path.relative(folder.path, real)) : null;
  if (copy) return `Codeshi blocked this: ${target} is in the real ${folder.name} folder, and this task works in its own copy of ${folder.name} at ${folder.copy}. Make changes and run commands in the copy instead (${copy}). The person reviews the copy's changes and merges them.`;
  return `Codeshi blocked this: ${target} is in ${folder.name}, another folder of this workspace, and this task changes only ${own[0] || 'its own folder'}. In ${folder.name} it can read, copy files out to this task's folder or a scratch folder, and run builds, tests, type checks, linters and dev servers, but not change anything else. Leave ${folder.name} as it is, and say in your reply what it needs, so it can be done there.`;
}

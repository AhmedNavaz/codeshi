import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { googleRuntimePath } from './antigravity-install.mjs';

const variable = provider => `AI_RELAY_${provider.toUpperCase()}_BIN`;
const expandHome = (value, home) => value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;

function executable(filename) {
  try {
    if (!fs.statSync(filename).isFile()) return false;
    fs.accessSync(filename, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// npm and pnpm install a CLI on Windows as a .cmd script, which Node cannot start without a shell, and a shell would
// reinterpret the arguments. The script names the program it starts: a native executable, such as Claude Code's, is
// used directly, and Codex's Node launcher is followed to the native executable it would start.
const codexTargets = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };
export function windowsShimTarget(filename, arch = process.arch) {
  let text;
  try { if (fs.statSync(filename).size > 64 * 1024) return null; text = fs.readFileSync(filename, 'utf8'); } catch { return null; }
  // The last quoted %dp0% path is the program; an earlier one can be a node.exe kept beside the script.
  const target = [...text.matchAll(/"%(?:~dp0|dp0%)\\([^"%]+)"/g)].at(-1)?.[1];
  if (!target) return null;
  const program = path.join(path.dirname(filename), ...target.split('\\'));
  if (/\.exe$/i.test(program)) return executable(program) ? program : null;
  const triple = codexTargets[arch];
  if (!/[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i.test(program) || !triple) return null;
  // The native build is a package of its own: inside Codex's folder (npm), beside it (npm, or pnpm's linked store), or
  // in Codex's own vendor folder (earlier versions).
  let codex = path.dirname(path.dirname(program));
  try { codex = fs.realpathSync(codex); } catch { /* Checked as written. */ }
  const vendors = [path.join(codex, 'node_modules', '@openai', `codex-win32-${arch}`), path.join(path.dirname(codex), `codex-win32-${arch}`), codex].map(folder => path.join(folder, 'vendor', triple));
  return vendors.flatMap(vendor => ['bin', 'codex'].map(folder => path.join(vendor, folder, 'codex.exe'))).find(executable) || null;
}

// Windows starts programs from .exe files; a .cmd script is followed to the program it starts.
function runnable(filename, platform, arch) {
  if (!path.isAbsolute(filename) || !executable(filename)) return null;
  return platform === 'win32' && /\.cmd$/i.test(filename) ? windowsShimTarget(filename, arch) : filename;
}

function firstExecutable(candidates, platform = process.platform, arch = process.arch) {
  for (const filename of candidates) { const found = runnable(filename, platform, arch); if (found) return found; }
  return null;
}

// A name without an extension is a POSIX script on Windows, such as the one npm writes for Git Bash, and cannot be started.
const commandNames = (name, platform) => platform === 'win32' && !path.extname(name) ? [`${name}.exe`, `${name}.cmd`] : [name];
const searchPath = (env, platform) => (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : path.delimiter)
  .map(directory => platform === 'win32' ? directory.replace(/^"(.*)"$/, '$1') : directory)
  .filter(directory => path.isAbsolute(directory));

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (b[i] || 0) - (a[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

function nvmBinDirs(home, env) {
  const root = path.join(env.NVM_DIR ? expandHome(env.NVM_DIR, home) : path.join(home, '.nvm'), 'versions/node');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && /^v\d+(?:\.\d+)*$/.test(entry.name))
    .map(entry => ({ version: entry.name.slice(1).split('.').map(Number), dir: path.join(root, entry.name, 'bin') }))
    .sort((a, b) => compareVersions(a.version, b.version))
    .map(entry => entry.dir);
}

// Keep the selected binary's directory on PATH so #!/usr/bin/env node CLIs work when the desktop app starts from Finder.
export function withBinaryPath(bin, env = process.env, platform = process.platform) {
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) return env;
  const key = platform === 'win32' && !('PATH' in env) && 'Path' in env ? 'Path' : 'PATH';
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const dir = path.dirname(bin), entries = (env[key] || '').split(delimiter).filter(Boolean);
  return entries.includes(dir) ? env : { ...env, [key]: [dir, ...entries].join(delimiter) };
}

function extensionExecutables(roots, platform, arch) {
  const target = {
    'darwin-arm64': 'macos-aarch64', 'darwin-x64': 'macos-x86_64',
    'linux-arm64': 'linux-aarch64', 'linux-x64': 'linux-x86_64',
    'win32-arm64': 'windows-aarch64', 'win32-x64': 'windows-x86_64',
  }[`${platform}-${arch}`];
  if (!target) return [];
  const found = [];
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const match = entry.name.match(/^openai\.chatgpt-(\d+(?:\.\d+)*)(.*)$/);
      if (!match) continue;
      const host = match[2].match(/-(darwin|linux|win32)-(arm64|x64)(?:$|-)/);
      if (host && (host[1] !== platform || host[2] !== arch)) continue;
      found.push({ version: match[1].split('.').map(Number), name: entry.name,
        filename: path.join(root, entry.name, 'bin', target, platform === 'win32' ? 'codex.exe' : 'codex') });
    }
  }
  found.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const difference = (b.version[i] || 0) - (a.version[i] || 0);
      if (difference) return difference;
    }
    return b.name.localeCompare(a.name);
  });
  return found.map(entry => entry.filename);
}

// Search installations outside the project. Empty/relative PATH entries must not
// cause a checked-out repository's executable to be selected automatically.
export function resolveBinary(provider, {
  override, googleRoot, env = process.env, home = os.homedir(), platform = process.platform, arch = process.arch,
  applicationRoots = ['/Applications', path.join(home, 'Applications')],
  extensionRoots = [path.join(home, '.vscode/extensions'), path.join(home, '.vscode-insiders/extensions')],
  systemBinDirs = ['/opt/homebrew/bin', '/usr/local/bin'],
} = {}) {
  if (!['codex', 'claude', 'gemini'].includes(provider)) throw new Error('Unknown assistant executable.');
  const explicit = override || env[variable(provider)];
  if (explicit) {
    const expanded = expandHome(explicit, home);
    if (path.isAbsolute(expanded) || expanded.includes('/') || expanded.includes('\\')) return expanded;
    // An explicitly selected command is never silently replaced by another tool.
    return firstExecutable(searchPath(env, platform).flatMap(directory => commandNames(expanded, platform).map(name => path.join(directory, name))), platform, arch) || expanded;
  }

  const pathEntries = searchPath(env, platform);

  if (provider === 'gemini') {
    const winAgyBin = platform === 'win32' && env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'agy/bin')] : [];
    const native = firstExecutable([...(googleRoot ? [googleRuntimePath(googleRoot, platform)] : []), ...[...pathEntries, ...winAgyBin].flatMap(directory => ['agy_acp_server.par', 'agy_acp_server.exe', 'antigravity-acp'].map(name => path.join(directory, name)))], platform, arch);
    if (native) return native;

    const agyNames = ['agy', 'antigravity'].flatMap(name => commandNames(name, platform));
    const agyDirs = [
      path.join(home, '.gemini/bin'),
      ...pathEntries,
      path.join(home, '.local/bin'),
      path.join(home, 'bin'),
      ...(platform === 'win32' && env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'agy/bin')] : []),
    ];
    const agy = firstExecutable(agyDirs.flatMap(directory => agyNames.map(name => path.join(directory, name))), platform, arch);
    if (agy) return agy;
  }

  const names = commandNames(provider, platform);
  const onPath = firstExecutable(pathEntries.flatMap(directory => names.map(name => path.join(directory, name))), platform, arch);
  if (onPath) return onPath;

  const directories = [
    ...(provider === 'gemini' ? [path.join(home, '.gemini/bin')] : []),
    ...(provider === 'codex' && env.CODEX_INSTALL_DIR ? [expandHome(env.CODEX_INSTALL_DIR, home)] : []),
    path.join(home, '.local/bin'), path.join(home, 'bin'), path.join(home, '.npm-global/bin'),
    env.VOLTA_HOME ? path.join(expandHome(env.VOLTA_HOME, home), 'bin') : path.join(home, '.volta/bin'),
    env.PNPM_HOME ? expandHome(env.PNPM_HOME, home) : platform === 'darwin' ? path.join(home, 'Library/pnpm') : path.join(home, '.local/share/pnpm'),
    env.BUN_INSTALL ? path.join(expandHome(env.BUN_INSTALL, home), 'bin') : path.join(home, '.bun/bin'),
    path.join(home, '.local/share/mise/shims'), path.join(home, '.asdf/shims'),
    path.join(home, '.local/share/fnm/aliases/default/bin'), path.join(home, 'Library/Application Support/fnm/aliases/default/bin'),
    ...nvmBinDirs(home, env),
    ...systemBinDirs,
  ];
  if (platform === 'win32') {
    const winDirs = [path.join(home, '.gemini/bin')];
    if (env.LOCALAPPDATA) {
      winDirs.push(path.join(env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin'), path.join(env.LOCALAPPDATA, 'Volta/bin'), path.join(env.LOCALAPPDATA, 'pnpm'), path.join(env.LOCALAPPDATA, 'agy/bin'));
    }
    // npm's global folder on Windows.
    if (env.APPDATA) winDirs.push(path.join(env.APPDATA, 'npm'));
    directories.unshift(...winDirs);
  }
  const standard = firstExecutable(directories.flatMap(directory => names.map(name => path.join(directory, name))), platform, arch);
  if (standard) return standard;
  if (provider === 'codex' && platform === 'darwin') {
    const bundled = firstExecutable(applicationRoots.flatMap(directory => ['ChatGPT.app', 'Codex.app'].flatMap(app => [
      path.join(directory, app, 'Contents/Resources/codex-cli/bin/codex'),
      path.join(directory, app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
      path.join(directory, app, 'Contents/Resources/codex'),
    ])));
    if (bundled) return bundled;
  }
  return provider === 'codex' ? firstExecutable(extensionExecutables(extensionRoots, platform, arch)) : null;
}

// Finder launches have a minimal PATH. Project commands need the user's Node/package
// manager installations, but never resolve executables from an empty/relative entry.
// Windows apps start with the person's full PATH, so only its relative entries are dropped there.
export function commandEnvironment(env = process.env, home = os.homedir(), platform = process.platform) {
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('AI_RELAY_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)));
  const key = platform === 'win32' && !('PATH' in result) && 'Path' in result ? 'Path' : 'PATH';
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const directories = (result[key] || '').split(delimiter).filter(value => path.isAbsolute(value));
  const added = platform === 'win32' ? [] : [...nvmBinDirs(home, env), path.join(home, '.volta/bin'), path.join(home, '.bun/bin'), path.join(home, 'Library/pnpm'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  result[key] = [...new Set([...directories, ...added])].join(delimiter);
  return result;
}

// Git is started by its full path. Windows looks for a bare program name in the working folder before PATH, so an
// attached folder could otherwise supply its own git.exe. A Git found once is kept; one that is missing is looked for
// again, so installing Git needs no restart.
const gits = new Map();
export function gitExecutable(env = process.env, platform = process.platform) {
  const key = `${platform}\0${env.PATH || env.Path || ''}`;
  if (gits.has(key)) return gits.get(key);
  const windows = platform === 'win32';
  const installs = windows
    ? [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean).map(directory => path.join(directory, 'Git', 'cmd'))
    : ['/usr/bin', ...searchPath(env, platform), '/usr/local/bin', '/opt/homebrew/bin'];
  const found = firstExecutable([...windows ? searchPath(env, platform) : [], ...installs].map(directory => path.join(directory, windows ? 'git.exe' : 'git')), platform);
  if (found) gits.set(key, found);
  return found || (windows ? path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe') : '/usr/bin/git');
}

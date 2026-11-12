import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitExecutable, resolveBinary } from '../src/resolve-binary.mjs';
import { Broker } from '../src/broker.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-relay-resolver-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    home, env: { PATH: path.join(root, 'empty-path') }, platform: 'darwin', arch: 'arm64',
    applicationRoots: [], extensionRoots: [], systemBinDirs: [],
  };
  function executable(filename, source = '#!/bin/sh\nexit 0\n') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source, { mode: 0o700 });
    return filename;
  }
  return { root, home, options, executable };
}

test('explicit overrides win, expand home paths, and do not silently fall back when invalid', t => {
  const f = setup(t);
  const onPath = f.executable(path.join(f.root, 'path-bin', 'codex'));
  const environment = f.executable(path.join(f.root, 'env-bin', 'codex'));
  const explicit = f.executable(path.join(f.root, 'explicit-bin', 'codex'));
  const options = { ...f.options, env: { PATH: path.dirname(onPath), AI_RELAY_CODEX_BIN: environment } };
  assert.equal(resolveBinary('codex', { ...options, override: explicit }), explicit);
  assert.equal(resolveBinary('codex', options), environment);
  assert.equal(resolveBinary('codex', { ...options, override: '~/selected/codex' }), path.join(f.home, 'selected', 'codex'));
  const missing = path.join(f.root, 'missing', 'codex');
  assert.equal(resolveBinary('codex', { ...options, override: missing }), missing);
  assert.equal(resolveBinary('codex', { ...f.options, override: 'deliberately-selected-command' }), 'deliberately-selected-command');
  const custom = f.executable(path.join(f.root, 'path-bin', 'custom-codex'));
  assert.equal(resolveBinary('codex', { ...options, override: 'custom-codex' }), custom);
});

test('PATH order wins over install fallbacks and skips non-executable files and directories', { skip: process.platform === 'win32' && 'Windows files have no execute permission to remove' }, t => {
  const f = setup(t);
  const notExecutable = path.join(f.root, 'non-executable', 'codex');
  f.executable(notExecutable);
  fs.chmodSync(notExecutable, 0o600);
  const directory = path.join(f.root, 'directory-bin', 'codex');
  fs.mkdirSync(directory, { recursive: true });
  const first = f.executable(path.join(f.root, 'first bin', 'codex'));
  const second = f.executable(path.join(f.root, 'second-bin', 'codex'));
  f.executable(path.join(f.home, '.local', 'bin', 'codex'));
  const env = { PATH: [path.dirname(notExecutable), path.dirname(directory), path.dirname(first), path.dirname(second)].join(path.delimiter) };
  assert.equal(resolveBinary('codex', { ...f.options, env }), first);
});

test('standard home install locations and CODEX_INSTALL_DIR are discovered without PATH', t => {
  const f = setup(t);
  const local = f.executable(path.join(f.home, '.local', 'bin', 'codex'));
  assert.equal(resolveBinary('codex', f.options), local);
  const custom = f.executable(path.join(f.root, 'custom-install', 'codex'));
  assert.equal(resolveBinary('codex', { ...f.options, env: { PATH: '', CODEX_INSTALL_DIR: path.dirname(custom) } }), custom);
  const claude = f.executable(path.join(f.home, '.npm-global', 'bin', 'claude'));
  assert.equal(resolveBinary('claude', f.options), claude);
});

test('Antigravity CLI takes priority over deprecated Gemini CLI and explicit overrides stay respected', t => {
  const f = setup(t);
  const legacyGemini = f.executable(path.join(f.home, '.local', 'bin', 'gemini'));
  const agy = f.executable(path.join(f.home, '.gemini', 'bin', 'agy'));
  assert.equal(resolveBinary('gemini', f.options), agy);
  assert.equal(resolveBinary('gemini', { ...f.options, override: legacyGemini }), legacyGemini);
  fs.unlinkSync(agy);
  assert.equal(resolveBinary('gemini', f.options), legacyGemini);
});

test('Windows CLI discovery splits PATH entries and ignores scripts that start no native program', t => {
  const f = setup(t);
  const codex = f.executable(path.join(f.root, 'windows path', 'codex.exe'));
  const claudeShim = f.executable(path.join(f.root, 'npm bin', 'claude.cmd'));
  f.executable(path.join(f.root, 'npm bin', 'claude'));
  const options = {
    ...f.options,
    platform: 'win32',
    arch: 'x64',
    env: { Path: [path.dirname(codex), `"${path.dirname(claudeShim)}"`].join(';') },
  };

  assert.equal(resolveBinary('codex', options), codex);
  assert.equal(resolveBinary('claude', options), null,
    'a .cmd script is never started through a shell, and npm’s extensionless script is for POSIX shells');
});

// What npm writes for a CLI on Windows: a native program is started directly, a JavaScript one through node.
const npmShim = target => /\.js$/.test(target)
  ? `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`
  : `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${target}"   %*\r\n`;

test('Windows npm installs are followed from their .cmd script to the native program', t => {
  const f = setup(t);
  const npm = path.join(f.root, 'AppData', 'Roaming', 'npm');
  const options = { ...f.options, platform: 'win32', arch: 'x64', env: { PATH: '', APPDATA: path.dirname(npm) } };
  f.executable(path.join(npm, 'claude.cmd'), npmShim('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
  assert.equal(resolveBinary('claude', options), null, 'a script whose program is missing is skipped');
  const claude = f.executable(path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  assert.equal(resolveBinary('claude', options), claude);

  // Codex's npm script starts a Node launcher; Codeshi starts the native build that launcher would.
  f.executable(path.join(npm, 'codex.cmd'), npmShim('node_modules\\@openai\\codex\\bin\\codex.js'));
  f.executable(path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  assert.equal(resolveBinary('codex', options), null, 'a JavaScript program is never started through a shell');
  const hoisted = f.executable(path.join(npm, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
  // Codex's folder is followed through links, as pnpm's is, so the result is its real path (macOS's /var is /private/var).
  assert.equal(resolveBinary('codex', options), fs.realpathSync(hoisted));
  const nested = f.executable(path.join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
  assert.equal(resolveBinary('codex', options), fs.realpathSync(nested), 'the build inside Codex’s own folder is the one its launcher uses');
  assert.equal(resolveBinary('codex', { ...options, arch: 'arm64' }), null, 'a build for another architecture is never used');

  // Another package's JavaScript CLI has no native program to start.
  f.executable(path.join(npm, 'gemini.cmd'), npmShim('node_modules\\@google\\gemini-cli\\dist\\index.js'));
  f.executable(path.join(npm, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js'));
  assert.equal(resolveBinary('gemini', options), null);
});

test('an explicitly named command on Windows is found as an .exe or through its .cmd script', t => {
  const f = setup(t);
  const npm = path.join(f.root, 'npm');
  f.executable(path.join(npm, 'my-claude.cmd'), npmShim('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
  const claude = f.executable(path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  const options = { ...f.options, platform: 'win32', arch: 'x64', env: { Path: npm, AI_RELAY_CLAUDE_BIN: 'my-claude' } };
  assert.equal(resolveBinary('claude', options), claude);
});

test('Git is started by its full path, never looked up in the working folder', t => {
  const f = setup(t);
  const tools = path.join(f.root, 'tools');
  const git = f.executable(path.join(tools, 'git.exe'));
  f.executable(path.join(tools, 'git'));
  assert.equal(gitExecutable({ Path: ['.', tools].join(';') }, 'win32'), git);
  const programFiles = path.join(f.root, 'Program Files');
  assert.equal(gitExecutable({ PATH: '', ProgramFiles: programFiles }, 'win32'), path.join(programFiles, 'Git', 'cmd', 'git.exe'), 'a missing Git is reported at its standard location');
  const installed = f.executable(path.join(programFiles, 'Git', 'cmd', 'git.exe'));
  assert.equal(gitExecutable({ PATH: '', ProgramFiles: programFiles }, 'win32'), installed, 'Git installed after a failed lookup is found without a restart');
  if (process.platform !== 'win32') assert.equal(gitExecutable({ PATH: tools }, process.platform), fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : path.join(tools, 'git'));
});

test('Windows Codex and Antigravity ACP installs under LOCALAPPDATA are discovered without PATH', t => {
  const f = setup(t);
  const localAppData = path.join(f.root, 'local app data');
  const codex = f.executable(path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  const agyAcp = f.executable(path.join(localAppData, 'agy', 'bin', 'agy_acp_server.exe'));
  const options = {
    ...f.options,
    platform: 'win32',
    arch: 'x64',
    env: { PATH: '', LOCALAPPDATA: localAppData },
  };

  assert.equal(resolveBinary('codex', options), codex);
  assert.equal(resolveBinary('gemini', options), agyAcp);
});

test('Linux user install locations are discovered without PATH', t => {
  const f = setup(t);
  const codex = f.executable(path.join(f.home, '.local', 'bin', 'codex'));
  const claude = f.executable(path.join(f.home, '.npm-global', 'bin', 'claude'));
  const options = { ...f.options, platform: 'linux', arch: 'x64', env: { PATH: '' } };

  assert.equal(resolveBinary('codex', options), codex);
  assert.equal(resolveBinary('claude', options), claude);
});

test('macOS app bundles are discovered after standard installs', t => {
  const f = setup(t);
  const applications = path.join(f.root, 'Applications');
  const bundled = f.executable(path.join(applications, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'));
  const options = { ...f.options, applicationRoots: [applications] };
  assert.equal(resolveBinary('codex', options), bundled);
  const onPath = f.executable(path.join(f.root, 'preferred-bin', 'codex'));
  assert.equal(resolveBinary('codex', { ...options, env: { PATH: path.dirname(onPath) } }), onPath);
  assert.equal(resolveBinary('claude', options), null, 'a bundled Codex executable is never used for Claude');
});

test('VS Code fallback selects the highest numeric version for the host architecture', t => {
  const f = setup(t);
  const extensions = path.join(f.root, 'extensions');
  const old = f.executable(path.join(extensions, 'openai.chatgpt-0.9.0-darwin-arm64', 'bin', 'macos-aarch64', 'codex'));
  const latest = f.executable(path.join(extensions, 'openai.chatgpt-0.10.0-darwin-arm64', 'bin', 'macos-aarch64', 'codex'));
  const x64 = f.executable(path.join(extensions, 'openai.chatgpt-99.0.0-darwin-x64', 'bin', 'macos-x86_64', 'codex'));
  f.executable(path.join(extensions, 'openai.chatgpt-100.0.0-linux-x64', 'bin', 'linux-x86_64', 'codex'));
  const options = { ...f.options, extensionRoots: [extensions] };
  assert.equal(resolveBinary('codex', options), latest);
  assert.equal(resolveBinary('codex', { ...options, arch: 'x64' }), x64);
  fs.unlinkSync(latest);
  assert.equal(resolveBinary('codex', options), old, 'a stale extension without its executable is skipped');
});

test('relative and empty PATH entries never discover executables inside the target workspace', t => {
  const f = setup(t);
  const workspace = path.join(f.root, 'untrusted-project');
  f.executable(path.join(workspace, 'codex'));
  f.executable(path.join(workspace, 'node_modules', '.bin', 'codex'));
  const previous = process.cwd();
  try {
    process.chdir(workspace);
    assert.equal(resolveBinary('codex', { ...f.options, env: { PATH: ['', '.', 'node_modules/.bin'].join(path.delimiter) } }), null);
  } finally { process.chdir(previous); }
});

test('Broker status probes and actual runs use the same selected executable', { skip: process.platform === 'win32' && 'Windows cannot start a script as a stand-in agent CLI' }, async t => {
  // Hooks run in the order they're added, so this closes the broker, and the work it saves in the folder, before the folder is removed.
  let broker; t.after(() => broker?.close());
  const f = setup(t);
  const workspace = path.join(f.root, 'project');
  fs.mkdirSync(workspace);
  const capture = path.join(f.root, 'invocations.jsonl');
  const source = `#!${process.execPath}\n`
    + `import fs from 'node:fs';\n`
    + `fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');\n`
    + `if(process.argv.includes('--version')){console.log('resolver-fixture 1.0');process.exit(0);}\n`
    + `for await(const chunk of process.stdin){}\n`
    + `console.log(JSON.stringify({type:'thread.started',thread_id:'resolver-thread'}));\n`
    + `console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Resolved binary ran.'}}));\n`
    + `console.log(JSON.stringify({type:'turn.completed'}));\n`;
  const selected = f.executable(path.join(f.root, 'selected binary', 'codex.mjs'), source);
  broker = new Broker({ workspace, dataDir: path.join(f.root, 'history'), bins: { codex: selected, claude: selected } });
  const status = await broker.status();
  assert.equal(status.providers.codex.available, true);
  assert.equal(status.providers.codex.version, 'resolver-fixture 1.0');
  assert.equal(broker.bins.codex, selected);
  await broker.status();
  assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, 2);
  for (const check of Object.values(broker.providerChecks)) check.at -= 5 * 60 * 1000;
  await Promise.all([broker.status(), broker.status()]);
  const c = broker.get(broker.create().id);
  broker.start(c, { text: 'Run the selected binary', provider: 'codex', mode: 'read' });
  await broker.running.done;
  assert.equal(c.status, 'complete');
  assert.ok(c.messages.some(message => message.text === 'Resolved binary ran.'));
  const invocations = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations.filter(invocation => invocation.args.includes('--version')).length, 4);
  assert.equal(invocations.filter(invocation => invocation.args.includes('exec')).length, 1);
  assert.ok(invocations.every(invocation => invocation.cwd === fs.realpathSync(workspace) || invocation.args.includes('--version')));
});

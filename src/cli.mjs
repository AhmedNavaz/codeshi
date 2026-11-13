// The codeshi command (#90): a client of Codeshi's engine. It talks to the same local engine the window uses, through the
// address and token the app writes for it (desktop/cli.mjs), so a run started here is the same run in the window, with the
// same journal, approvals, limits and handoff. It never runs an engine of its own: when Codeshi isn't open, it starts the
// app in the background, with no window. `codeshi` alone opens the interactive session (cli-session.mjs, built on Ink);
// the other commands need nothing but Node's built-ins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import tty from 'node:tty';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI_SCHEMA = 1;
// Documented in docs/cli.md. Scripts rely on them, so they don't change meaning.
export const EXIT = { ok: 0, failed: 1, usage: 2, needsInput: 3, busy: 4, unavailable: 5, detached: 130 };
const AGENTS = ['codex', 'claude', 'gemini'], NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
const COMMANDS = ['status', 'run', 'continue', 'wait', 'stop', 'tasks', 'help'];
export const FLOW_MODES = ['smart', 'saver', 'ultra'];
export const FLOW_NAMES = { smart: 'Smart', saver: 'Saver', ultra: 'Ultra' };
const LEGACY_FLOW = { balanced: 'smart', saving: 'saver', quality: 'ultra' };

// Flow (#12): the engine picks the agent, model and effort for each message, as it does for the window and the phone.
// The workspace's Flow mode, or null when you choose the agent yourself.
export const flowMode = view => { const mode = view?.routing?.mode; return FLOW_MODES.includes(mode) ? mode : LEGACY_FLOW[mode] || null; };
// What a send asks of the engine in Flow. A terminal message is never split into tasks (no allowSplit): the suggestion
// needs the window to answer. It never confirms charges either, so Flow can't start an agent that bills by use from here.
export const flowRequest = view => { const mode = flowMode(view); return mode ? { routing: { mode }, executionRevision: view.execution?.defaults?.revision ?? 0 } : {}; };
// Turns Flow on in a mode, or off, as Flow's switch in the window does. It keeps the window's other routing choices.
export async function setFlow(api, target, view, mode) {
  if ((flowMode(view) || 'off') === mode) return view;
  return api.post(target, mode === 'off' ? { mode: null, executionRevision: view.execution?.defaults?.revision ?? 0 }
    : { mode, allowApi: view.routing?.allowApi === true, check: view.routing?.check === true, executionRevision: view.execution?.defaults?.revision ?? 0 });
}
// What Flow chose for a run, in the result and events.
export const runRouting = run => run?.routing?.mode ? { mode: LEGACY_FLOW[run.routing.mode] || run.routing.mode, tier: run.routing.tier || null, reason: run.routing.reason || null } : null;
// The engine's refusal of an agent that bills by use names a confirmation the terminal doesn't have.
// Stop (here, in the window or by Codeshi) while Flow rated the message: nothing started.
export const flowStopped = error => /Routing assessment stopped/.test(error?.message || '');
export const flowError = error => /bills by use/.test(error?.message || '')
  ? new CliError("Flow chose an agent that bills by use, and the terminal never agrees to charges. Send this from the Codeshi window, or name an agent on a subscription with --agent.", EXIT.failed)
  : error;

export const HELP = `Usage: codeshi [options]          Start an interactive session in this terminal
       codeshi <command> [options]

Works with Codeshi's engine, starting the app in the background (no window) when
it isn't open. A run started here shows in the app, and the app's runs can be
followed here.

Commands
  status               Workspaces, what's working and what's waiting for you
  run <message>        Send a message to the workspace's chat and follow the run
                       (use - or a pipe to read the message from standard input)
  continue             Continue the last run, as Continue does in the app
  wait                 Follow the run that's working now until it ends
  stop                 Stop the run that's working in the workspace
  tasks                List the workspace's tasks

Options
  -w, --workspace <name|path>  Workspace to use (default: the one holding this folder)
  -a, --agent <codex|claude|gemini>
  -m, --model <id>             Model for run and continue (default: the agent's choice in the app)
  -e, --effort <level>         Effort for run and continue
      --flow <smart|saver|ultra|off>
                               Turn Flow on in that mode, or off, for the workspace
                               first. In Flow, Codeshi picks the agent for each
                               message unless you name one with --agent
      --detach                Return as soon as the run starts
      --no-input               Never ask here; exit with code 3 when the run needs you
      --json                   Print one JSON result on standard output
      --jsonl                  Print JSON events on standard output as they happen
  -h, --help                   Show this help
  -v, --version                Show the version

Progress goes to standard error; the agent's reply, or JSON, to standard output.
Exit codes: 0 done, 1 run failed or was stopped, 2 usage, 3 needs your input,
4 another run is working, 5 Codeshi couldn't be reached, 130 stopped watching (Ctrl+C).
Full reference: https://github.com/AhmedNavaz/codeshi/blob/main/docs/cli.md`;

export class CliError extends Error { constructor(message, code = EXIT.failed, extra = {}) { super(message); this.code = code; Object.assign(this, extra); } }

export function parseArgs(argv) {
  const options = { command: null, words: [], workspace: null, agent: null, model: null, effort: null, flow: null, detach: false, noInput: false, json: false, jsonl: false };
  const value = (name, index) => { const next = argv[index + 1]; if (next === undefined || (next.startsWith('-') && next !== '-')) throw new CliError(`${name} needs a value.`, EXIT.usage); return next; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { options.words.push(...argv.slice(i + 1)); break; }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const take = name => { if (inline !== undefined) return inline; const next = value(name, i); i++; return next; };
    if (flag === '-h' || flag === '--help') options.command = 'help';
    else if (flag === '-v' || flag === '--version') options.command = 'version';
    else if (flag === '-w' || flag === '--workspace') options.workspace = take(flag);
    else if (flag === '-a' || flag === '--agent') options.agent = take(flag).toLowerCase();
    else if (flag === '-m' || flag === '--model') options.model = take(flag);
    else if (flag === '-e' || flag === '--effort') options.effort = take(flag);
    else if (flag === '--flow') options.flow = take(flag).toLowerCase();
    else if (flag === '--detach') options.detach = true;
    else if (flag === '--no-input') options.noInput = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--jsonl') options.jsonl = true;
    else if (arg.startsWith('-') && arg !== '-') throw new CliError(`Unknown option ${flag}. See codeshi --help.`, EXIT.usage);
    else if (!options.command) options.command = arg;
    else options.words.push(arg);
  }
  if (options.command === null) options.command = 'session';
  if (!COMMANDS.includes(options.command) && !['version', 'session'].includes(options.command)) throw new CliError(`Unknown command ${options.command}. See codeshi --help.`, EXIT.usage);
  if (options.json && options.jsonl) throw new CliError('Choose --json or --jsonl, not both.', EXIT.usage);
  if (options.agent && !AGENTS.includes(options.agent)) throw new CliError('Choose codex, claude or gemini for --agent.', EXIT.usage);
  if ((options.agent || options.model || options.effort) && !['run', 'continue', 'session'].includes(options.command)) throw new CliError('--agent, --model and --effort apply to run, continue and the session.', EXIT.usage);
  if (options.flow !== null) {
    if (![...FLOW_MODES, 'off'].includes(options.flow)) throw new CliError('Choose smart, saver, ultra or off for --flow.', EXIT.usage);
    if (!['run', 'session'].includes(options.command)) throw new CliError('--flow applies to run and the session.', EXIT.usage);
    if (options.flow !== 'off' && (options.agent || options.model || options.effort)) throw new CliError('In Flow, Codeshi picks the agent, model and effort. Choose --flow or --agent, --model and --effort, not both.', EXIT.usage);
  }
  if (options.command === 'session' && (options.json || options.jsonl || options.noInput)) throw new CliError('The session is interactive. For scripts, use codeshi run.', EXIT.usage);
  if (options.detach && !['run', 'continue'].includes(options.command)) throw new CliError('--detach applies to run and continue.', EXIT.usage);
  if (options.words.length && options.command !== 'run') throw new CliError(`codeshi ${options.command} takes no message.`, EXIT.usage);
  return options;
}

// Where the app writes its address: the data folder of the installed app, an older name's, or a copy run from source.
export function connectionCandidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.CODESHI_CONNECTION) return [env.CODESHI_CONNECTION];
  const appData = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['Codeshi', 'Throughline', 'AI Relay', 'Codeshi Dev', 'Throughline Dev'].map(name => path.join(appData, name, 'cli.json'));
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
export function readConnection(candidates) {
  for (const file of candidates) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (saved?.version !== 1 || typeof saved.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(saved.url) || typeof saved.token !== 'string' || !Number.isInteger(saved.pid)) continue;
    if (alive(saved.pid)) return saved;
  }
  throw new CliError("Codeshi isn't open. Open it, then try again.", EXIT.unavailable);
}

// Where this command runs from: inside the macOS app (the link the menu installs), another packaged app, or a checkout.
export function appLocation({ execPath = process.execPath, env = process.env, here = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  if (env.ELECTRON_RUN_AS_NODE) {
    const bundle = execPath.match(/^(.+\.app)\/Contents\/MacOS\/[^/]+$/)?.[1];
    return bundle ? { kind: 'bundle', path: bundle } : { kind: 'binary', path: execPath };
  }
  const root = path.resolve(here, '..');
  return fs.existsSync(path.join(root, 'desktop', 'launch.mjs')) ? { kind: 'source', path: root } : null;
}

// Starts Codeshi with no window: the engine and the menu bar status only. The app quits by itself once nothing uses it.
export function startApp(location, { spawnImpl = spawn, env = process.env, node = process.execPath } = {}) {
  if (!location) throw new CliError("Codeshi isn't open, and this command can't find the app to start it. Open Codeshi, then try again.", EXIT.unavailable);
  const quiet = { detached: true, stdio: 'ignore' };
  const { ELECTRON_RUN_AS_NODE, ...appEnv } = env;
  const child = location.kind === 'bundle' ? spawnImpl('open', ['-g', '-a', location.path, '--args', '--background'], { ...quiet, env: appEnv })
    : location.kind === 'binary' ? spawnImpl(location.path, ['--background'], { ...quiet, env: appEnv })
    : spawnImpl(node, [path.join(location.path, 'desktop', 'launch.mjs'), '--background'], { ...quiet, windowsHide: true, cwd: location.path, env: appEnv });
  child.on?.('error', () => {});
  child.unref?.();
}

// Windows GUI executables (Codeshi.exe with ELECTRON_RUN_AS_NODE=1) lose their console standard input handle even when
// a terminal owns standard output. Recover the console input stream so interactive sessions and approvals work.
export function consoleInput({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  platform = process.platform,
  openSync = fs.openSync,
  fstatSync = fs.fstatSync,
  closeSync = fs.closeSync,
  isatty = tty.isatty,
  ReadStream = tty.ReadStream,
} = {}) {
  if (platform !== 'win32' || !env.ELECTRON_RUN_AS_NODE || stdin.isTTY || (!stdout.isTTY && !stderr.isTTY)) {
    return { stdin, close() {} };
  }
  try {
    const stat = fstatSync(0);
    if (!stat?.isCharacterDevice?.() || stat.isFIFO?.() || stat.isFile?.()) return { stdin, close() {} };
  } catch (error) {
    if (error?.code !== 'EBADF') return { stdin, close() {} };
  }
  let fd = null;
  try {
    fd = openSync('\\\\.\\CONIN$', 'r+');
    if (!isatty(fd)) { closeSync(fd); return { stdin, close() {} }; }
    const stream = new ReadStream(fd);
    return { stdin: stream, close() { try { stream.destroy(); } catch { /* Already closed. */ } } };
  } catch {
    if (fd !== null) try { closeSync(fd); } catch { /* Already closed. */ }
    return { stdin, close() {} };
  }
}

// The open app's engine, or one started in the background for this command. A test's CODESHI_CONNECTION is never started.
export async function connect({ env = process.env, start = true, say = () => {}, wait = 45000, poll = 300, location = appLocation({ env }), spawnImpl, readImpl = readConnection } = {}) {
  const candidates = connectionCandidates({ env });
  try { return readImpl(candidates); } catch (error) { if (!start || env.CODESHI_CONNECTION) throw error; }
  say('Starting Codeshi in the background…');
  startApp(location, { env, ...(spawnImpl ? { spawnImpl } : {}) });
  for (const end = Date.now() + wait; Date.now() < end;) {
    await new Promise(resolve => setTimeout(resolve, poll));
    try { return readImpl(candidates); } catch { /* Still starting. */ }
  }
  throw new CliError("Codeshi didn't start. Open it, then try again.", EXIT.unavailable);
}

export function client(connection, { fetchImpl = fetch } = {}) {
  const headers = { 'x-ai-relay-token': connection.token, 'x-ai-relay': '1', 'content-type': 'application/json' };
  const request = async (method, route, body) => {
    let response;
    try { response = await fetchImpl(connection.url + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new CliError("Codeshi isn't open. Open it, then try again.", EXIT.unavailable); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 503) throw new CliError('Codeshi is quitting.', EXIT.unavailable);
    if (response.status === 403) throw new CliError("Codeshi didn't accept this connection. Quit and reopen Codeshi, then try again.", EXIT.unavailable);
    if (!response.ok) throw new CliError(data.error || `Codeshi answered ${response.status}.`, /already working/.test(data.error || '') ? EXIT.busy : EXIT.failed, { status: response.status });
    return data;
  };
  // Wakes the follower when the engine reports a change; it still checks on a timer, so a dropped stream only slows it down.
  const events = (onUpdate, signal) => (async () => {
      try {
        const response = await fetchImpl(`${connection.url}/api/events?token=${encodeURIComponent(connection.token)}`, { signal });
        const decoder = new TextDecoder(); let buffer = '';
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').find(line => line.startsWith('data: '));
            if (block.includes('event: update') && data) { try { onUpdate(JSON.parse(data.slice(6))); } catch { /* A malformed event only skips one wake-up. */ } }
          }
        }
      } catch { /* The timer keeps the follower going. */ }
  })();
  return { get: route => request('GET', route), post: (route, body = {}) => request('POST', route, body), events };
}

// The workspace named on the command line, or the one whose folder holds the current directory (the deepest, if nested).
export function chooseWorkspace(projects, { name, cwd }) {
  const real = value => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  const inside = (folder, place) => { const relative = path.relative(real(folder), real(place)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
  if (name) {
    const lower = name.toLowerCase();
    const found = projects.find(project => project.id === name) || projects.find(project => project.name.toLowerCase() === lower)
      || (fs.existsSync(name) ? projects.find(project => project.folders.some(folder => inside(folder.path, name))) : null);
    if (!found) throw new CliError(`No workspace is called ${name}. Workspaces: ${projects.map(project => project.name).join(', ') || 'none'}.`, EXIT.usage);
    return found;
  }
  const matches = projects.flatMap(project => project.folders.filter(folder => inside(folder.path, cwd)).map(folder => ({ project, depth: real(folder.path).length })));
  if (matches.length) return matches.sort((a, b) => b.depth - a.depth)[0].project;
  if (projects.length === 1) return projects[0];
  throw new CliError(projects.length ? `This folder isn't in a Codeshi workspace. Run it from a workspace folder, or choose one with --workspace: ${projects.map(project => project.name).join(', ')}.` : 'Codeshi has no workspaces yet. Add one in the app first.', EXIT.usage);
}

// An approval or question in a few words, as the app and phone describe it.
export function describePending(item) {
  const agent = NAMES[item.provider] || 'The agent';
  if (item.kind === 'question') return { kind: 'question', summary: `${agent} has a question: ${item.questions?.[0]?.question || ''}`.trim(), detail: null };
  const command = item.command || item.input?.command, target = item.input?.file_path || item.input?.path;
  const files = item.kind?.includes?.('fileChange') || target, access = item.kind === 'item/permissions/requestApproval';
  const summary = `${agent} ${command ? 'wants to run a command' : item.connector ? `wants to use ${item.connector}` : access ? 'wants more access' : files ? 'wants to change files' : 'needs your permission'}`;
  return { kind: 'approval', summary, detail: command || target || (item.title && item.title !== summary ? item.title : null) };
}

const firstLine = (text, width = 120) => { const line = String(text || '').split('\n').find(part => part.trim()) || ''; return line.length > width ? `${line.slice(0, width - 1)}…` : line; };

export async function main(argv, { stdin: givenStdin, stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), version = '0.0.0', fetchImpl = fetch, signals = process } = {}) {
  let options;
  const say = line => { try { stderr.write(`${line}\n`); } catch { /* A closed terminal only loses progress. */ } };
  // Ctrl+C, or a closed pipe on standard output (codeshi run … | head), stops following, never the run.
  let interrupted = false, onInterrupt = () => {}, closed = false;
  const interrupt = () => { interrupted = true; onInterrupt(); };
  const out = text => { if (closed) return; try { stdout.write(text); } catch { closed = true; interrupt(); } };
  stdout.on?.('error', () => { closed = true; interrupt(); });
  try { options = parseArgs(argv); }
  catch (error) { say(error.message); return error.code || EXIT.usage; }
  const emit = value => out(`${JSON.stringify({ v: CLI_SCHEMA, ...value })}\n`);
  if (options.command === 'help') { out(`${HELP}\n`); return EXIT.ok; }
  if (options.command === 'version') { out(`codeshi ${version}\n`); return EXIT.ok; }
  const needStdin = !givenStdin && (options.command === 'session' ? stdout.isTTY : ['run', 'continue', 'wait'].includes(options.command));
  const recovered = needStdin ? consoleInput({ stdin: process.stdin, stdout, stderr, env }) : null;
  const stdin = givenStdin || recovered?.stdin || process.stdin;
  const finish = (result, code) => {
    if (options.json || options.jsonl) emit(options.jsonl ? { type: 'result', ...result } : result);
    return code;
  };
  try {
    if (options.command === 'session') {
      // Not a terminal on both ends (a pipe, a script): there's no one to type, so the help says what to use instead.
      if (!stdin.isTTY || !stdout.isTTY) { out(`${HELP}\n`); return EXIT.ok; }
      try {
        const { session } = await import('./cli-session.mjs');
        return await session({ options, env, cwd, version, fetchImpl, stdin, stdout, stderr });
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        say(error.message); return error.code;
      }
    }
    // Ctrl+C while a run is followed stops following, never the run. Listening from the start means one pressed while the
    // message is being sent is handled the same way, instead of ending the command with the run's start unreported.
    const following = ['run', 'continue', 'wait'].includes(options.command);
    if (following) signals.on?.('SIGINT', interrupt);
    try {
    // Stop and wait have nothing to act on when Codeshi isn't open, so they don't start it.
    const api = client(await connect({ env, start: !['stop', 'wait'].includes(options.command), say: options.json || options.jsonl ? () => {} : say }), { fetchImpl });
    const projects = await api.get('/api/projects');
    if (options.command === 'status') return status(projects);
    const project = chooseWorkspace(projects, { name: options.workspace, cwd });
    const workspace = { id: project.id, name: project.name }, q = `projectId=${encodeURIComponent(project.id)}`;
    if (options.command === 'tasks') return tasks(project, (await api.get(`/api/tasks?${q}`)).tasks || []);
    const conversation = await api.get(`/api/conversation?${q}&limit=1`);
    const route = action => `/api/conversations/${conversation.id}/${action}?${q}&limit=1`;
    if (options.command === 'stop') {
      const { stopped } = await api.post(route('stop'));
      if (!options.json && !options.jsonl) say(stopped ? `Stopped the run in ${project.name}.` : `Nothing is working in ${project.name}.`);
      return finish({ result: stopped ? 'stopped' : 'idle', workspace, conversationId: conversation.id }, EXIT.ok);
    }
    if (options.command === 'wait') {
      const runId = conversation.activeRun?.id || null;
      if (!runId) { const last = conversation.lastRun?.id || null; return report(last ? await api.get(`/api/conversation?${q}&toRun=${encodeURIComponent(last)}`) : conversation, last, { workspace, followed: false }); }
      return await follow(runId);
    }
    // One run at a time in a workspace's chat, as in the app. The engine refuses a second one too; this says what to do.
    if (conversation.status === 'running') throw new CliError(`An agent is already working in ${project.name}. Follow it with codeshi wait, or stop it with codeshi stop.`, EXIT.busy);
    let started;
    const choice = { ...(options.agent ? { provider: options.agent } : {}), ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}), requestId: `cli-${randomUUID()}` };
    if (options.command === 'run') {
      const fromInput = !options.words.length || (options.words.length === 1 && options.words[0] === '-');
      if (fromInput && stdin.isTTY) throw new CliError('Write the message after codeshi run, or pipe it in.', EXIT.usage);
      const text = fromInput ? await readAll(stdin) : options.words.join(' ');
      if (!text.trim()) throw new CliError('The message is empty.', EXIT.usage);
      options.fromInput = fromInput;
      const view = options.flow ? await setFlow(api, route('routing'), conversation, options.flow) : conversation;
      // In Flow the engine rates the message and picks who does it before answering. Naming an agent, model or effort
      // sends this one message to your choice instead, as choosing by hand does in the window.
      const flow = options.agent || options.model || options.effort ? {} : flowRequest(view);
      if (flow.routing && !options.json && !options.jsonl) say(`Flow (${FLOW_NAMES[flow.routing.mode]}) is choosing an agent…`);
      try { started = await api.post(route('messages'), { text, ...choice, ...flow }); }
      catch (error) {
        if (!flowStopped(error)) throw flowError(error);
        if (!options.json && !options.jsonl) say('Stopped before Flow chose an agent. Nothing ran.');
        return finish({ result: 'stopped', workspace, conversationId: conversation.id, runId: null, taskId: null, agent: null, model: null, routing: null, reply: '', error: null, errorCategory: null }, EXIT.failed);
      }
    } else started = await api.post(route('continue'), choice);
    if (options.detach) {
      if (!options.json && !options.jsonl) say(`Started in ${project.name}. Follow it with codeshi wait.`);
      return finish({ result: 'started', workspace, conversationId: conversation.id, runId: started.runId }, EXIT.ok);
    }
    return await follow(started.runId);

    async function follow(firstRun) {
      const interactive = !options.noInput && !options.fromInput && stdin.isTTY && stderr.isTTY;
      const seen = new Map(), announced = new Set(), controller = new AbortController();
      let runId = firstRun, taskId = null, view = null, wake = null, asking = null, startedSaid = false, choosing = false;
      const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });
      api.events(update => { if (update?.projectId === project.id) wake?.(); }, controller.signal);
      onInterrupt = () => { asking?.abort(); wake?.(); };
      try {
        for (;;) {
          view = await api.get(`/api/conversation?${q}&toRun=${encodeURIComponent(runId)}`);
          const active = view.activeRun?.id === runId ? view.activeRun : null, run = active || (view.lastRun?.id === runId ? view.lastRun : null);
          taskId ||= run?.execution?.taskId || run?.taskId || null;
          // codeshi wait while Flow is still choosing: that isn't the agent's run yet, so it follows to the run Flow starts.
          if (active?.purpose === 'routing') {
            if (!choosing && !options.json && !options.jsonl) say('Flow is choosing an agent…');
            choosing = true;
          } else if (!startedSaid && run) {
            startedSaid = true;
            const routing = runRouting(run);
            if (options.jsonl) emit({ type: 'started', workspace, conversationId: view.id, runId, taskId, agent: run.provider, model: run.model || null, routing });
            else if (!options.json) {
              if (routing) say(`Flow (${FLOW_NAMES[routing.mode] || routing.mode}) chose ${[NAMES[run.provider] || run.provider, run.model, run.effort].filter(Boolean).join(' · ')}${routing.reason ? `: ${firstLine(routing.reason, 200)}` : ''}.`);
              say(`${NAMES[run.provider] || run.provider} is working in ${project.name}…`);
            }
          }
          for (const message of view.messages || []) {
            if (message.runId !== runId || message.role === 'user') continue;
            const settled = message.role !== 'assistant' || message.status === 'complete' || !active;
            if (!settled || seen.get(message.id) === message.text) continue;
            const first = !seen.has(message.id); seen.set(message.id, message.text);
            if (options.jsonl) emit({ type: message.role === 'assistant' ? 'message' : 'activity', runId, id: message.id, role: message.role, text: message.text });
            else if (!options.json && first && message.role !== 'assistant') say(`  ${firstLine(message.text)}`);
          }
          const pending = (view.pendingApprovals || []).filter(item => !item.runId || item.runId === runId);
          for (const item of pending) if (!announced.has(item.id)) {
            announced.add(item.id);
            const described = describePending(item);
            if (options.jsonl) emit({ type: 'needs_input', runId, id: item.id, ...described });
          }
          if (!active) {
            // A handoff or retry continues the same task in a new run; follow it there.
            const next = view.activeRun && taskId && (view.activeRun.execution?.taskId || view.activeRun.taskId) === taskId ? view.activeRun.id : null;
            if (next && next !== runId) { runId = next; startedSaid = false; continue; }
            if (run) return report(view, runId, { workspace, followed: true });
            // Flow ended without starting a run: it was stopped, or no agent could take the message.
            if (choosing) {
              const problem = 'Flow stopped before an agent started. If it was not stopped, the Codeshi window says why no agent could take the message.';
              if (!options.json && !options.jsonl) say(problem);
              return finish({ result: 'incomplete', workspace, conversationId: view.id, runId: null, taskId, agent: null, model: null, routing: null, reply: '', error: problem, errorCategory: null }, EXIT.failed);
            }
          }
          if (pending.length) {
            if (!interactive) {
              const waiting = pending.map(item => ({ id: item.id, ...describePending(item) }));
              if (!options.json && !options.jsonl) { for (const item of waiting) say(`${item.summary}${item.detail ? `:\n    ${firstLine(item.detail, 200)}` : '.'}`); say('It waits for you in Codeshi. Answer it there, then follow the run with codeshi wait.'); }
              return finish({ result: 'needs_input', workspace, conversationId: view.id, runId, taskId, pending: waiting }, EXIT.needsInput);
            }
            const approval = pending.find(item => item.kind !== 'question');
            if (approval) await ask(approval);
            else if (!announced.has(`said:${pending[0].id}`)) { announced.add(`said:${pending[0].id}`); say(`${describePending(pending[0]).summary}\n  Answer it in Codeshi; this keeps following the run.`); }
          }
          if (interrupted) break;
          await sleep(3000);
          if (interrupted) break;
        }
      } finally { controller.abort(); }
      if (!options.json && !options.jsonl) say('Stopped following. The run carries on in Codeshi: codeshi wait follows it again, codeshi stop stops it.');
      return finish({ result: 'detached', workspace, conversationId: view?.id || conversation.id, runId, taskId }, EXIT.detached);

      // In a terminal, an approval is answered here or in the app, whichever comes first.
      async function ask(item) {
        const described = describePending(item);
        say(`${described.summary}${described.detail ? `:\n    ${described.detail}` : '.'}`);
        const choices = item.scope ? 'y = allow, n = deny, r = allow for the rest of this run' : 'y = allow, n = deny';
        asking = new AbortController();
        const prompt = readline.createInterface({ input: stdin, output: stderr, terminal: true });
        // While it reads a line, the terminal's Ctrl+C reaches the prompt rather than the process.
        prompt.on('SIGINT', interrupt);
        const gone = setInterval(async () => {
          try { const now = await api.get(`/api/conversation?${q}&limit=1`); if (!(now.pendingApprovals || []).some(entry => entry.id === item.id)) asking?.abort(); } catch { /* Keep asking. */ }
        }, 1500);
        try {
          for (;;) {
            const answer = (await prompt.question(`Allow? (${choices}) `, { signal: asking.signal })).trim().toLowerCase();
            if (!['y', 'yes', 'n', 'no', ...(item.scope ? ['r'] : [])].includes(answer)) continue;
            const allow = answer !== 'n' && answer !== 'no';
            try { await api.post(route('approval'), { runId: item.runId, approvalId: item.id, allow, ...(answer === 'r' ? { remember: 'run' } : {}) }); }
            // The engine notes the answer in the conversation, and that line follows here.
            catch (error) { say(error.message); }
            return;
          }
        } catch (error) {
          if (error.name !== 'AbortError') throw error;
          if (!interrupted) say('  Answered in Codeshi.');
        } finally { clearInterval(gone); prompt.close(); asking = null; }
      }
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    say(error.message);
    return finish({ result: 'error', error: error.message }, error.code);
  } finally { if (following) signals.removeListener?.('SIGINT', interrupt); }
  } finally { recovered?.close(); }

  function report(view, runId, { workspace, followed }) {
    const run = view.lastRun?.id === runId ? view.lastRun : (view.runs || []).find(item => item.id === runId) || null;
    if (!run) {
      if (!options.json && !options.jsonl) say(`Nothing is working in ${workspace.name}.`);
      return finish({ result: 'idle', workspace, conversationId: view.id }, EXIT.ok);
    }
    const messages = (view.messages || []).filter(message => message.runId === runId);
    const reply = messages.filter(message => message.role === 'assistant').map(message => message.text).filter(Boolean).join('\n\n');
    const problem = [...messages].reverse().find(message => message.role === 'error' || message.role === 'notice')?.text || null;
    const result = run.status === 'complete' ? 'complete' : run.status === 'interrupted' ? 'stopped' : run.status === 'running' ? 'working' : 'incomplete';
    if (!options.json && !options.jsonl) {
      if (!followed) say(`The last run in ${workspace.name} ${result === 'complete' ? 'finished' : result === 'stopped' ? 'was stopped' : "didn't finish"}.`);
      if (reply) out(`${reply}\n`);
      if (result === 'stopped') say('The run was stopped.');
      else if (result === 'incomplete') say(`The run didn't finish${run.errorCategory === 'quota' ? ': the agent reached its usage limit. codeshi continue --agent <another> hands it on.' : problem ? `: ${firstLine(problem, 300)}` : '.'}`);
    }
    return finish({ result, workspace, conversationId: view.id, runId, taskId: run.execution?.taskId || run.taskId || null, agent: run.provider, model: run.model || null, routing: runRouting(run), reply, error: result === 'complete' ? null : problem, errorCategory: run.errorCategory || null }, result === 'complete' ? EXIT.ok : EXIT.failed);
  }

  function status(projects) {
    const here = (() => { try { return chooseWorkspace(projects, { cwd }).id; } catch { return null; } })();
    const listed = projects.map(project => ({ id: project.id, name: project.name, folders: project.folders.map(folder => folder.path), working: Boolean(project.runningConversationId), waiting: project.pendingApprovals || 0, current: project.id === here }));
    if (options.json || options.jsonl) return finish({ result: 'status', workspaces: listed }, EXIT.ok);
    if (!listed.length) out('No workspaces yet. Add one in Codeshi.\n');
    const width = Math.min(32, Math.max(...listed.map(item => item.name.length), 4));
    for (const item of listed) out(`${item.current ? '*' : ' '} ${item.name.padEnd(width)}  ${[item.working ? 'working' : 'idle', item.waiting ? `${item.waiting} waiting for you` : ''].filter(Boolean).join(' · ')}\n`);
    return EXIT.ok;
  }

  function tasks(project, list) {
    const shown = list.map(task => ({ id: task.id, title: task.title, status: task.status, agent: task.runningProvider || task.provider || null, folder: task.folderName || null, waiting: task.approvals || 0 }));
    if (options.json || options.jsonl) return finish({ result: 'tasks', workspace: { id: project.id, name: project.name }, tasks: shown }, EXIT.ok);
    if (!shown.length) out(`No tasks in ${project.name}.\n`);
    for (const task of shown) out(`${task.id.slice(0, 8)}  ${task.status.padEnd(10)}  ${(NAMES[task.agent] || task.agent || '').padEnd(6)}  ${task.title}${task.waiting ? `  (${task.waiting} waiting for you)` : ''}\n`);
    return EXIT.ok;
  }
}

async function readAll(stream) { let text = ''; stream.setEncoding?.('utf8'); for await (const chunk of stream) text += chunk; return text; }

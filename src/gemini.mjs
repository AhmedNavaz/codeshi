import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GeminiClient } from './acp-client.mjs';
import { acpApprovalRequest, acpToolItem, allowedWrites, writeKey } from './acp-tools.mjs';
import { isAntigravityACP, antigravityInvocation, antigravityRelay, antigravitySessionParams, configureAntigravitySession, antigravityAccount, antigravityQuestion, verifyAntigravity, removeRuntimeSkill, antigravityInitializeTimeout } from './antigravity.mjs';
import { probeCli } from './cli-probe.mjs';
import { withBinaryPath } from './resolve-binary.mjs';
import { readWorkspaceFile, writeWorkspaceFile } from './workspace-files.mjs';

const reads = ['read_file', 'list_directory', 'glob', 'grep_search', 'read_many_files'];
const edits = ['write_file', 'replace', 'run_shell_command'];
export const isAgy = bin => Boolean(bin && /^(?:agy|antigravity)(?:\.exe)?$/i.test(path.basename(bin)));
export const agyUnsupported = 'Antigravity CLI does not expose interactive tool approvals to this connection. Use Google Antigravity ACP from Settings for Google sign-in, or the native terminal.';
export const geminiSetup = 'Connect Gemini with Google Antigravity in Settings: install the official connection, then sign in with Google. Available models and usage limits come from your Google account. Gemini CLI remains an advanced option for API-key and enterprise connections.';
// How long an agent may say nothing, with no command running and nothing waiting for the person, before its run ends.
const promptSilence = 15 * 60 * 1000;
// Reading a file that's missing, a folder or too large is an ordinary tool error: the agent is told and carries on. A path
// the safety checks refuse (a symlink, or outside the workspace) is still reported at the end of the run.
const ordinaryReadFailure = /^(?:Cannot access selected file|File parent is not a directory|Only regular text files|Binary or oversized files|Files must contain valid UTF-8)/;
// How a runtime continues a saved session: its own resume keeps the session as it is, while the standard load first
// replays every saved message. Nothing, when it can only start new sessions.
export const sessionResume = initialized => initialized.agentCapabilities?.sessionCapabilities?.resume ? 'session/resume' : initialized.agentCapabilities?.loadSession ? 'session/load' : null;
// What the run's turns used, added up. Input counts only what was not read from cache, as Codex's does.
export function promptUsage(turns) {
  const reported = turns.filter(usage => usage && typeof usage === 'object' && ['inputTokens', 'outputTokens'].some(key => typeof usage[key] === 'number'));
  if (!reported.length) return null;
  const sum = key => reported.every(usage => typeof usage[key] === 'number') ? reported.reduce((total, usage) => total + usage[key], 0) : null;
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), thoughtTokens: sum('thoughtTokens'), cachedReadTokens: sum('cachedReadTokens'), cachedWriteTokens: sum('cachedWriteTokens') };
}

// Antigravity headless mode may soft-deny tools and still exit successfully.
// Never replace Codeshi approvals with pre-approved native write permissions.
export async function runAgy() { throw new Error(agyUnsupported); }

// Isolate invocation policy without changing the user's settings or authentication.
// Managed system policy cannot safely be replaced by this per-run configuration.
export function geminiInvocation(config, { env = process.env, platform = process.platform, systemDirectory } = {}) {
  const system = systemDirectory || (platform === 'darwin' ? '/Library/Application Support/GeminiCli' : platform === 'win32' ? path.join(env.ProgramData || 'C:\\ProgramData', 'gemini-cli') : '/etc/gemini-cli');
  let policies = [];
  try { policies = fs.readdirSync(path.join(system, 'policies')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || fs.existsSync(path.join(system, 'settings.json')) || policies.some(name => name.endsWith('.toml'))) throw new Error('Gemini uses managed system settings or policy. This connection cannot enforce Codeshi access settings alongside that configuration. Use the native CLI.');
  const folders = [...new Set([config.workspace, ...(config.workspaces || [])])];
  if (folders.length > 6) throw new Error('Gemini supports a primary folder and up to five additional folders. Use a workspace with at most six folders.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-gemini-'));
  const cleanup = () => fs.rmSync(temporary, { recursive: true, force: true });
  try {
    fs.chmodSync(temporary, 0o700);
    const policy = path.join(temporary, 'access.toml'), settings = path.join(temporary, 'settings.json');
    fs.writeFileSync(policy, `[[rule]]\ntoolName = "*"\ndecision = "${config.mode === 'read' ? 'deny' : 'ask_user'}"\npriority = 998\n${config.routingAssessment ? '' : `\n[[rule]]\ntoolName = ${JSON.stringify(reads)}\ndecision = "allow"\npriority = 999\n`}`, { mode: 0o600 });
    fs.writeFileSync(settings, JSON.stringify({ policyPaths: [], adminPolicyPaths: [policy], tools: { core: [...reads, ...(config.mode === 'read' ? [] : edits)], sandbox: false }, hooksConfig: { enabled: false }, admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } }, telemetry: { enabled: false }, experimental: { autoMemory: false } }), { mode: 0o600 });
    const args = ['--acp', '--approval-mode', 'default', '--admin-policy', policy, '--extensions', 'none'];
    if (config.model) args.push('--model', config.model);
    for (const folder of folders.slice(1)) args.push('--include-directories', folder);
    return { args, env: { ...withBinaryPath(config.bin, env, platform), GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, GEMINI_TELEMETRY_ENABLED: 'false' }, cleanup };
  } catch (error) { cleanup(); throw error; }
}

export { GeminiClient } from './acp-client.mjs';

export function geminiFile(config, filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Gemini requested an invalid absolute file path.');
  const target = path.resolve(filename);
  for (const root of [config.workspace, ...(config.workspaces || [])]) {
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) return { root, relative: relative.split(path.sep).join('/') };
  }
  throw new Error('Gemini requested a file outside this workspace.');
}

export async function runGemini(config, { event, approval, question = null, metadata, cancelled = () => false, steerable = () => {}, probe = probeCli, invocation = geminiInvocation, clientFactory = options => new GeminiClient(options), spawnImpl = spawn }) {
  if (isAgy(config.bin)) return runAgy(config, { event, metadata, cancelled, spawnImpl });
  const antigravity = isAntigravityACP(config.bin);
  if (!antigravity && config.effort) throw new Error('Gemini reasoning effort is controlled by its native model; clear the effort selection.');
  const version = antigravity ? null : await probe(config.bin, ['--version'], 5000), match = version?.stdout?.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!antigravity && (version.status !== 0 || !match || +match[1] === 0 && +match[2] < 66)) throw new Error('Gemini CLI 0.66.0 or newer is required. ' + geminiSetup);
  const options = antigravity ? antigravityInvocation({ ...config, relay: await antigravityRelay(config, { commands: true }) }) : invocation(config);
  const removeSkill = antigravity ? removeRuntimeSkill(config.workspace) : () => {};
  let client;
  try { client = clientFactory({ bin: config.bin, cwd: config.workspace, ...options }); }
  catch (error) { options.cleanup(); throw error; }
  let sessionId, response = '', segment = 0, steering = false, denied = false, deniedReason = '', asking = 0, loading = false;
  const tools = new Map(), approvedWrites = new Set();
  const timer = setInterval(() => { if (cancelled()) { if (sessionId) client.send({ method: 'session/cancel', params: { sessionId } }); client.close(); } }, 100);
  // Text before a tool is finished: what comes after it is a new message, below the tool, not more of the same one.
  const finishText = () => { if (!response) return; event({ type: 'item.completed', item: { id: segment ? `response-${segment}` : 'response', type: 'agent_message', text: response } }); response = ''; segment++; };
  const syncSilence = () => client.pauseSilence?.(asking > 0 || [...tools.values()].some(tool => tool.kind === 'execute' && !['completed', 'failed'].includes(tool.status)));
  const ask = async (request, handler = approval) => { asking++; syncSilence(); try { return await handler(request); } finally { asking--; syncSilence(); } };
  client.on('message', async message => {
    const p = message.params || {};
    try {
      if (p.sessionId !== sessionId || !sessionId) throw new Error('Gemini requested an unknown session.');
      if (message.id !== undefined) {
        let result;
        if (message.method === 'session/request_permission') {
          const once = p.options?.find(option => option.kind === 'allow_once');
          const tool = p.toolCall || {};
          if (antigravity && /^interaction_/.test(tool.toolCallId || '')) {
            const form = antigravityQuestion(p);
            if (!form) throw new Error('Codeshi could not display this Antigravity question and its choices. No answer was selected.');
            finishText();
            const answers = question && !config.reviewSnapshot && !config.routingAssessment && !cancelled() ? await ask({ id: String(message.id), questions: form.questions }, question) : null;
            result = form.respond(cancelled() ? null : answers);
          } else {
            const allow = !cancelled() && config.mode !== 'read' && once && await ask({ id: String(message.id), ...acpApprovalRequest(tool), toolCall: tool });
            if (!allow || cancelled()) { denied = true; result = { outcome: { outcome: 'cancelled' } }; }
            else { for (const key of allowedWrites(tool)) approvedWrites.add(key); result = { outcome: { outcome: 'selected', optionId: once.optionId } }; }
          }
        } else if (message.method === 'fs/read_text_file') {
          const file = geminiFile(config, p.path);
          let saved;
          try { saved = readWorkspaceFile(file.root, file.relative); }
          catch (error) { if (!ordinaryReadFailure.test(error.message)) throw error; client.send({ id: message.id, error: { code: -32000, message: error.message } }); return; }
          const line = p.line ?? 1, limit = p.limit;
          if (!Number.isInteger(line) || line < 1 || limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('Invalid Gemini file line range.');
          result = { content: saved.content.split('\n').slice(line - 1, limit === undefined ? undefined : line - 1 + limit).join('\n') };
        } else if (message.method === 'fs/write_text_file') {
          if (config.mode === 'read' || cancelled()) throw new Error('Write permission denied in read-only mode.');
          const file = geminiFile(config, p.path), before = readWorkspaceFile(file.root, file.relative, { allowMissing: true });
          const allow = approvedWrites.delete(writeKey(p.path, p.content)) || await ask({ id: String(message.id), kind: 'write_file', input: { path: p.path, content: p.content } });
          if (!allow || cancelled()) { denied = true; throw new Error('Write permission denied.'); }
          writeWorkspaceFile(file.root, file.relative, p.content, { expectedHash: before.sha256 }); result = {};
        } else throw new Error('This Gemini interaction is unsupported by Codeshi.');
        client.send({ id: message.id, result }); return;
      }
      // While a saved session loads, the runtime replays what it holds: messages and steps Codeshi already has.
      if (message.method !== 'session/update' || loading) return;
      const update = p.update || {};
      // Text after the prompt was stopped for a note is the runtime's notice that it was cancelled, not a reply.
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && !steering) { response += update.content.text; event({ type: 'relay.delta', id: segment ? `response-${segment}` : 'response', text: update.content.text }); }
      if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) event({ type: 'relay.plan', steps: update.entries.map(entry => ({ text: entry.content, status: entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'active' : 'pending' })) });
      if (update.sessionUpdate === 'agent_thought_chunk') event({ type: 'relay.progress', phase: 'reasoning' });
      if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
        const tool = { ...tools.get(update.toolCallId), ...update };
        // A command that outlasts its wait moves to the background, and the agent speaks again when it ends, with no new tool between.
        if (!tools.has(update.toolCallId) || tool.kind === 'execute' && ['completed', 'failed'].includes(tool.status)) finishText();
        tools.set(tool.toolCallId, tool);
        event({ type: ['completed', 'failed'].includes(tool.status) ? 'item.completed' : 'item.started', item: acpToolItem(tool) });
        syncSilence();
      }
      if (update.sessionUpdate === 'usage_update') metadata({ usage: { used: update.used, size: update.size, cost: update.cost } });
    } catch (error) {
      if (message.id !== undefined) { denied = true; deniedReason = error.message; client.send({ id: message.id, error: { code: -32000, message: error.message } }); }
      else client.fail(error);
    }
  });
  try {
    const initialized = await client.request('initialize', { protocolVersion: 1, clientInfo: { name: 'throughline', version: '0.11.0' }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: config.mode !== 'read' }, terminal: false } }, antigravity ? Math.max(30000, antigravityInitializeTimeout()) : 30000);
    if (initialized.protocolVersion !== 1) throw new Error('Unsupported Gemini ACP protocol version.');
    if (antigravity) verifyAntigravity(initialized);
    if (cancelled()) throw new Error('Gemini run cancelled.');
    const params = antigravity ? antigravitySessionParams(initialized, config) : { cwd: config.workspace, mcpServers: [] };
    const resume = sessionResume(initialized);
    let session;
    if (config.sessionId) {
      // The prompt continues this session, so a session that can't be continued is a failed run, not a quiet new start.
      if (!resume) throw Object.assign(new Error('This Gemini runtime cannot continue a saved session. The next message starts a fresh session with a task brief.'), { category: 'session' });
      sessionId = config.sessionId; loading = resume === 'session/load';
      // The reply describes the session without naming it.
      try { session = { ...await client.request(resume, { sessionId, ...params }, 60000, { silence: true }), sessionId }; }
      catch (error) { throw Object.assign(new Error(`Gemini could not continue its saved session: ${error.message.replace(/\.?$/, '.')} The next message starts a fresh session with a task brief.`), { category: 'session' }); }
      finally { loading = false; }
    } else {
      session = await client.request('session/new', params, 60000); sessionId = session.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid Gemini ACP session.');
    }
    // Only a session the runtime can continue is worth remembering.
    if (resume) event({ type: 'thread.started', thread_id: sessionId });
    if (antigravity) await configureAntigravitySession(client, session, config);
    if (!antigravity && config.model && session.models?.currentModelId !== config.model) throw new Error('Gemini did not select the requested model. No prompt was sent.');
    const images = config.images || [];
    if (images.length && !initialized.agentCapabilities?.promptCapabilities?.image) throw new Error('This Gemini CLI does not support image attachments.');
    metadata({ effectiveModel: antigravity ? session.configOptions?.find(option => option.id === 'model')?.currentValue || config.model || 'Provider default' : session.models?.currentModelId || config.model || 'Provider default', effectiveEffort: antigravity ? session.configOptions?.find(option => ['thinking_level', 'thought_level'].includes(option.id))?.currentValue || null : null, transport: 'acp', account: antigravity ? antigravityAccount(session) : { authenticated: true, authMode: 'native-cli', billingSource: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? 'api' : 'unknown' } });
    event({ type: 'relay.progress', phase: 'working' });
    if (cancelled()) throw new Error('Gemini run cancelled.');
    // ACP has no way to add to a running prompt, so a note the person adds stops the prompt and continues the same
    // session with the note. The session keeps everything done so far.
    const notes = [];
    steerable(async text => { notes.push(text); if (!steering) { steering = true; client.send({ method: 'session/cancel', params: { sessionId } }); } });
    let prompt = [{ type: 'text', text: config.prompt }, ...images.map(image => ({ type: 'image', mimeType: image.mime, data: image.data }))], result;
    const turns = [];
    while (true) {
      result = await client.request('session/prompt', { sessionId, prompt }, promptSilence, { silence: true });
      steering = false; turns.push(result.usage);
      if (!notes.length || cancelled()) break;
      finishText();
      prompt =[{ type: 'text', text: `While you were working, the person added this to the current task:\n\n${notes.splice(0).join('\n\n')}\n\nTake it into account and carry on with the task from where you stopped.` }];
    }
    steerable(null);
    const usage = promptUsage(turns); if (usage) metadata({ usage });
    if (result.stopReason !== 'end_turn' || cancelled()) throw new Error('Gemini turn did not complete: ' + (result.stopReason || 'unknown'));
    if (denied) throw new Error('Gemini requested an action that was denied or unsupported. Some work may be incomplete.' + (deniedReason ? ' ' + deniedReason : ''));
    finishText();
    event({ type: 'turn.completed' });
  } finally { steerable(null); clearInterval(timer); client.close(); options.cleanup(); removeSkill(); }
}

import { claudeRequestContext } from './context-state.mjs';
import { googleQuota } from './antigravity-usage.mjs';
import { isAntigravityACP, googleMetadata, connectGoogle, disconnectGoogle, closeGoogleConnections } from './antigravity.mjs';
import { geminiSetup, isAgy, agyUnsupported } from './gemini.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import os from 'node:os';
import { probeCli } from './cli-probe.mjs';
import { resolveBinary, withBinaryPath } from './resolve-binary.mjs';
import { localEndpoint, verifyLocalModel } from './local-models.mjs';
import { claudeQuestions, claudeAnswers, codexQuestions, codexAnswers } from './agent-questions.mjs';
import { isToolApproval, toolApprovalRequest, toolApprovalAnswer, isToolApprovalQuestion, toolQuestionRequest, toolQuestionAnswer, permissionsRequest, permissionsAnswer, elicitationQuestions, elicitationCancelled, cannotShow, toolCallOutcome } from './codex-requests.mjs';
import { claudePlanName, readClaudeProfile } from './claude-plan.mjs';

export function classifyError(error) {
  const text = typeof error === 'string' ? error : `${error?.code || ''} ${error?.message || ''} ${JSON.stringify(error?.data || error || {})}`;
  if (/usage.?limit|rate.?limit|hit.*limit|limit.*reset|out of.*usage|quota|429|credits?.*(?:exhaust|deplet)|UsageLimitExceeded/i.test(text)) return 'quota';
  if (/unauth|not.?logged|login|sign.?in|authenticat|401|invalid.?api.?key/i.test(text)) return 'authentication';
  if (/ENOENT|not found|not installed|could not be found|Cannot find package/i.test(text)) return 'installation';
  if (/permission|approv|denied|sandbox|EACCES|EPERM/i.test(text)) return 'permission';
  if (/abort|cancel|stopped|interrupt/i.test(text)) return 'interrupted';
  if (/protocol|JSON|without complet|oversized|invalid.*event|unexpected.*event/i.test(text)) return 'protocol';
  return 'execution';
}
export function capabilities(provider, transport = 'auto') {
  const native = transport !== 'cli';
  return { approvals: native, nativeResume: provider !== 'gemini', models: native,
    readOnly: provider === 'codex' ? 'native-sandbox' : 'restricted-tools',
    hooks: 'User/project hooks disabled for this invocation; administrator policy may remain active.',
    readOnlyLimit: 'Access settings govern provider tools. They are not a host-wide guarantee against administrator hooks or external processes.' };
}

export function localCodexConfig(local) {
  return { model_provider: 'throughline_ollama', model: local.model,
    'model_providers.throughline_ollama': { name: 'Ollama (local)', base_url: localEndpoint(local.endpoint) + '/v1', wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0, capabilities: { external_web_access: false, remote_compaction: 'unsupported' } },
    mcp_servers: {}, web_search: 'disabled', 'analytics.enabled': false, 'otel.exporter': 'none', 'otel.metrics_exporter': 'none', 'otel.trace_exporter': 'none',
    model_context_window: Math.min(local.contextWindow || 32768, 65536) };
}
const toml = value => typeof value === 'object' && value !== null ? '{' + Object.entries(value).map(([key, entry]) => JSON.stringify(key) + '=' + toml(entry)).join(',') + '}' : JSON.stringify(value);
// A routing assessment reads one short brief and returns JSON. On a real account, plugins, skills and the coding-agent
// instructions made that 20,000 input tokens and five seconds of thread setup, so its one process starts without them.
// Codex ignores a name it doesn't know; a version that refused one fails the assessment, and Send uses the local estimate.
const ASSESSOR_INSTRUCTIONS = 'You rate coding requests for a router. Reply with only one JSON object. Never perform the request.';
const ASSESSOR_DISABLED_FEATURES = ['apps', 'browser_use', 'browser_use_external', 'code_mode_host', 'computer_use', 'goals', 'guardian_approval', 'image_generation', 'in_app_browser', 'multi_agent', 'plugins', 'remote_plugin', 'shell_snapshot', 'shell_tool', 'skill_mcp_dependency_install', 'skill_search', 'sleep_tool', 'tool_suggest', 'unified_exec', 'view_image', 'worktrees', 'workspace_dependencies'];
const ASSESSOR_CONFIG = ['skills.include_instructions=false', 'include_permissions_instructions=false', 'include_apps_instructions=false', 'include_collaboration_mode_instructions=false', 'include_environment_context=false', 'include_apply_patch_tool=false', 'project_doc_max_bytes=0'];
export class CodexClient extends EventEmitter {
  constructor({ bin, cwd = os.homedir(), spawnImpl = spawn, local, reviewSnapshot, routingAssessment } = {}) {
    super();
    this.pending = new Map(); this.counter = 0; this.closed = false;
    const args = ['-c', 'features.hooks=false', '-c', 'notify=[]'];
    if (reviewSnapshot) args.push('-c', 'mcp_servers={}', '-c', 'web_search="disabled"');
    if (routingAssessment) for (const setting of [...ASSESSOR_DISABLED_FEATURES.map(feature => `features.${feature}=false`), ...ASSESSOR_CONFIG]) args.push('-c', setting);
    if (local) for (const [key, value] of Object.entries(localCodexConfig(local))) args.push('-c', key + '=' + toml(value));
    const env = withBinaryPath(bin, { ...process.env });
    if (local) for (const key of Object.keys(env)) if (/^(?:OPENAI|CODEX_API|OLLAMA|ANTHROPIC)_/.test(key)) delete env[key];
    this.child = spawnImpl(bin, [...args, 'app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env });
    let diagnostic = '';
    this.child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-16000); });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && !message.method) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Codex protocol error'), { data: message.error.data }));
          else pending.resolve(message.result);
        } else this.emit('message', message);
      } catch (error) {
        const failure = new Error(`Invalid Codex JSON-RPC protocol: ${error.message}`);
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(failure); }
        this.pending.clear(); this.emit('closed', failure); this.close();
      }
    });
    const end = error => {
      this.closed = true;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear(); this.emit('closed', error);
    };
    this.child.on('error', end);
    this.child.on('close', (code, signal) => end(new Error(diagnostic || `Codex app-server closed (${code ?? signal}).`)));
    this.child.stdin.on('error', () => {});
  }
  send(message) { if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params = {}, timeout = 20000) {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed.'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex protocol timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async initialize() { await this.request('initialize', { clientInfo: { name: 'ai_relay', title: 'Codeshi', version: '0.2.0' } }); this.send({ method: 'initialized', params: {} }); }
  close() { if (!this.closed) { this.child.stdin.end(); this.child.kill('SIGTERM'); } }
}

export async function runCodex(config, { event, approval, question = null, metadata, cancelled = () => false, steerable = () => {}, clientFactory = options => new CodexClient(options), verifyLocal = verifyLocalModel }) {
  if (config.routingAssessment) { if (config.mode !== 'read' || config.sessionId) throw new Error('Routing assessments require read-only access and a fresh session.'); config = { ...config, reviewSnapshot: true }; }
  if (config.reviewSnapshot && (config.mode !== 'read' || config.sessionId)) throw new Error('Snapshot reviews require read-only access and a fresh native session.');
  if (config.local) config.local = { ...config.local, ...await verifyLocal(config.local.model, config.local.digest, { endpoint: config.local.endpoint }) };
  const client = clientFactory({ bin: config.bin, cwd: config.workspace, ...(config.local ? { local: config.local } : {}), ...(config.reviewSnapshot ? { reviewSnapshot: true } : {}), ...(config.routingAssessment ? { routingAssessment: true } : {}) });
  let threadId, turnId, resolveEnd, rejectEnd, compactionId = null, compactionNumber = 0;
  const ended = new Promise((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject; });
  // Initialization failures may happen before awaiting the terminal promise.
  ended.catch(() => {});
  client.on('closed', rejectEnd);
  client.on('message', async message => {
    try {
      const p = message.params || {};
      if (message.id !== undefined && message.method) {
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
          const allow = config.mode === 'read' ? false : await approval({ id: String(message.id), kind: message.method, ...p });
          client.send({ id: message.id, result: { decision: allow ? 'accept' : 'decline' } });
        } else if (message.method === 'mcpServer/elicitation/request' && isToolApproval(p)) {
          // Running a connector or MCP tool is an approval like a command, so it follows the run's policy.
          const allow = config.mode === 'read' ? false : await approval(toolApprovalRequest(message.id, p));
          client.send({ id: message.id, result: toolApprovalAnswer(allow) });
        } else if (message.method === 'mcpServer/elicitation/request') {
          const form = question && !config.reviewSnapshot && config.mode !== 'read' ? elicitationQuestions(p) : null;
          const result = form ? form.respond(await question({ id: String(message.id), questions: form.questions })) : null;
          if (!result && !config.reviewSnapshot) event({ type: 'relay.notice', text: cannotShow(p) });
          client.send({ id: message.id, result: result || elicitationCancelled() });
        } else if (message.method === 'item/permissions/requestApproval') {
          const allow = config.mode === 'read' ? false : await approval(permissionsRequest(message.id, p));
          client.send({ id: message.id, result: permissionsAnswer(p, allow) });
        } else if (message.method === 'item/tool/requestUserInput' && isToolApprovalQuestion(p)) {
          const allow = config.mode === 'read' ? false : await approval(toolQuestionRequest(message.id, p));
          client.send({ id: message.id, result: toolQuestionAnswer(p, allow) });
        } else if (message.method === 'item/tool/requestUserInput' && question && !config.reviewSnapshot) {
          // Codex asks you to choose: the question waits in Codeshi like an approval, and skipping it sends no answers.
          const questions = codexQuestions(p), answers = questions.length ? await question({ id: String(message.id), questions }) : null;
          client.send({ id: message.id, result: codexAnswers(p, answers || null) });
        } else client.send({ id: message.id, error: { code: -32601, message: 'This interaction is not supported by Codeshi; use the native client.' } });
        return;
      }
      if (p.threadId && threadId && p.threadId !== threadId) return;
      if (/reasoning.*(?:Delta|delta)|reasoning\//i.test(message.method)) event({ type: 'relay.progress', phase: 'reasoning' });
      if (message.method === 'item/commandExecution/outputDelta') event({ type: 'relay.progress', phase: 'tool' });
      if (message.method === 'thread/tokenUsage/updated') metadata({ usage: p.tokenUsage });
      if (p.item?.type === 'contextCompaction' && ['item/started', 'item/completed'].includes(message.method)) {
        compactionId = p.item.id || compactionId || `compaction-${++compactionNumber}`;
        event({ type: 'relay.compaction', id: compactionId, stage: message.method === 'item/started' ? 'started' : 'complete', source: 'codex-context-compaction' });
      }
      if (message.method === 'thread/compacted') {
        event({ type: 'relay.compaction', id: compactionId || `compaction-${++compactionNumber}`, stage: 'complete', source: 'codex-thread-compacted' });
        compactionId = null;
      }
      if (message.method === 'turn/plan/updated' && Array.isArray(p.plan)) event({ type: 'relay.plan', explanation: p.explanation || null, steps: p.plan.map(step => ({ text: step.step, status: step.status === 'completed' ? 'done' : step.status === 'inProgress' ? 'active' : 'pending' })) });
      if (message.method === 'item/agentMessage/delta') event({ type: 'relay.delta', id: p.itemId, text: p.delta });
      if (['item/started', 'item/completed'].includes(message.method)) {
        const item = p.item;
        if (item?.type === 'reasoning') event({ type: 'relay.progress', phase: 'reasoning' });
        if (item?.type === 'commandExecution' || item?.type === 'fileChange') event({ type: 'relay.progress', phase: message.method === 'item/started' ? 'tool' : 'working' });
        if (item?.type === 'agentMessage') event({ type: message.method === 'item/completed' ? 'item.completed' : 'item.started', item: { ...item, type: 'agent_message' } });
        if (item?.type === 'commandExecution') event({ type: message.method === 'item/completed' ? 'item.completed' : 'item.started', item: { ...item, type: 'command_execution', aggregated_output: item.aggregatedOutput || '', exit_code: item.exitCode ?? item.exit_code } });
        if (item?.type === 'fileChange') event({ type: message.method === 'item/completed' ? 'item.completed' : 'item.started', item: { ...item, type: 'file_change' } });
        if (item?.type === 'mcpToolCall') event({ type: message.method === 'item/completed' ? 'item.completed' : 'item.started', item: { id: item.id, type: 'mcp_tool_call', tool: item.tool, status: item.status, error: item.error || null, result: toolCallOutcome(item) } });
      }
      if (message.method === 'error') event(p.willRetry ? { type: 'error', message: p.error?.message || 'Retrying connection' } : { type: 'turn.failed', error: p.error });
      if (message.method === 'turn/completed') {
        steerable(null);
        if (p.turn?.status === 'completed') { event({ type: 'turn.completed' }); resolveEnd(); }
        else rejectEnd(new Error(p.turn?.error?.message || `Codex turn ${p.turn?.status || 'failed'}`));
      }
    } catch (error) { rejectEnd(error); }
  });
  try {
    await client.initialize();
    if (cancelled()) throw new Error('Run interrupted.');
    let selectedEffort = config.effort || null, selectedModel = config.model || null;
    if (!config.local && (!selectedEffort || !selectedModel)) {
      try {
        const { data } = await client.request('model/list', { limit: 100, includeHidden: false }, 2500);
        const model = data.find(row => selectedModel ? [row.id, row.model].includes(selectedModel) : row.isDefault);
        if (!selectedModel) selectedModel = model?.model || model?.id || null;
        if (!selectedEffort) selectedEffort = model?.defaultReasoningEffort || null;
      } catch { /* Older clients may not expose defaults; do not invent one. */ }
    }
    const roots = [...new Set([config.workspace, ...(config.workspaces || [])])];
    // Full auto-approval keeps asking: with "never", Codex cannot request anything its sandbox blocks, so writing outside
    // the workspace would simply fail instead of reaching the broker, which approves it. It also has the network. Codex
    // only asks for that after a command has failed, and it can report an outage instead. Any request would be approved
    // and then run outside the sandbox altogether, so this allows less than asking does.
    const network = config.mode !== 'read' && config.approvalPolicy === 'auto';
    const options = { cwd: config.workspace, approvalPolicy: config.mode === 'read' ? 'never' : 'on-request', approvalsReviewer: 'user', sandbox: config.mode === 'read' ? 'read-only' : 'workspace-write', config: { 'sandbox_workspace_write.writable_roots': config.mode === 'read' ? [] : roots, 'sandbox_workspace_write.network_access': network, ...(selectedEffort ? { model_reasoning_effort: selectedEffort } : {}), ...(config.local ? localCodexConfig(config.local) : {}), ...(config.reviewSnapshot ? { mcp_servers: {}, web_search: 'disabled' } : {}) }, ...(selectedModel ? { model: selectedModel } : {}), ...(config.local ? { modelProvider: 'throughline_ollama' } : {}), ...(config.local || config.reviewSnapshot ? { ephemeral: true } : {}), ...(config.routingAssessment ? { baseInstructions: ASSESSOR_INSTRUCTIONS, developerInstructions: '' } : {}) };
    if (config.local && (!selectedModel || config.sessionId)) throw new Error('Local runs require an explicit model and a fresh session.');
    // Codex keeps its plan for the run with its plan tool, shown as a to-do list. A Codex that doesn't know the
    // setting refuses it, so the thread then starts without it.
    if (!config.reviewSnapshot) options.config['tools.update_plan'] = { enabled: true };
    const startThread = () => client.request(config.sessionId ? 'thread/resume' : 'thread/start', { ...options, ...(config.sessionId ? { threadId: config.sessionId } : {}) });
    let started;
    try { started = await startThread(); }
    catch (error) { if (!options.config['tools.update_plan'] || !/update_plan|UpdatePlanTool/i.test(error.message)) throw error; delete options.config['tools.update_plan']; started = await startThread(); }
    if (config.local && (started.thread.modelProvider !== 'throughline_ollama' || started.model && started.model !== selectedModel || started.thread.model && started.thread.model !== selectedModel)) throw new Error('The native client did not confirm the selected local provider and model. No task was sent.');
    threadId = started.thread.id;
    event({ type: 'thread.started', thread_id: threadId });
    metadata({ effectiveModel: started.model || started.thread.model || selectedModel || 'unknown', transport: 'app-server', effectiveEffort: started.reasoningEffort || selectedEffort || null, ...(config.local ? { connection: 'local', account: { authenticated: true, authMode: 'local', billingSource: 'local' } } : {}) });
    const turn = await client.request('turn/start', { threadId, ...(selectedEffort ? { effort: selectedEffort } : {}), input: [{ type: 'text', text: config.prompt }, ...(config.images || []).flatMap(image => [{ type: 'text', text: 'Attached image: ' + image.name }, { type: 'localImage', path: image.path }])], cwd: config.workspace,
      approvalPolicy: options.approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: config.mode === 'read' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: roots, networkAccess: network }, ...(selectedModel ? { model: selectedModel } : {}), ...(config.routingAssessment ? { outputSchema: config.outputSchema } : {}) });
    turnId = turn.turn.id;
    // A note the person adds while Codex works joins this same turn; it fails once the turn has finished.
    if (!config.reviewSnapshot) steerable(async text => { await client.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] }, 10000); });
    const timer = setInterval(() => { if (cancelled()) client.request('turn/interrupt', { threadId, turnId }).catch(() => {}); }, 200);
    try { await ended; } finally { clearInterval(timer); }
  } finally { steerable(null); client.close(); }
}

// How long a run waits for Claude once a turn has ended: settleMs for a finished background command or a late note to start
// another turn, and backgroundMs for a background command that never reports back. Claude stops its own background
// commands within two hours, so reaching that limit means something is stuck.
export const claudeWaits = { settleMs: 5000, backgroundMs: 125 * 60_000 };

export async function runClaude(config, { event, approval, question = null, metadata, cancelled = () => false, steerable = () => {}, queryImpl, waits = claudeWaits } = {}) {
  if (config.routingAssessment) { if (config.mode !== 'read' || config.sessionId) throw new Error('Routing assessments require read-only access and a fresh session.'); config = { ...config, reviewSnapshot: true }; question = null; }
  const query = queryImpl || (await import('@anthropic-ai/claude-agent-sdk')).query;
  const controller = new AbortController();
  const timer = setInterval(() => { if (cancelled()) controller.abort(); }, 100);
  // The prompt is streamed, so a note the person adds while Claude works joins the turn at its next step. Permission
  // requests use this same connection, and a finished background command wakes Claude after its result (#112), so input
  // stays open until a turn has ended with nothing left that could start another.
  const inbox = []; let wake = null, open = true;
  const deliver = value => { if (wake) { const resolve = wake; wake = null; resolve(value); } else inbox.push(value); };
  const close = () => { if (!open) return; open = false; steerable(null); deliver(null); };
  const todoIds = new Set();
  // reportsState: this Claude says when it is idle. Without it, use turn results plus any background/request events.
  let reportsState = false, turnOver = false, live = 0, unread = false, settling = null, expiry = null, expired = false;
  const waitNoLonger = () => { clearTimeout(settling); clearTimeout(expiry); settling = expiry = null; };
  const review = () => {
    waitNoLonger();
    if (!open || !turnOver) return;
    if (live) expiry = setTimeout(() => { expired = true; controller.abort(); }, waits.backgroundMs);
    else if (unread) settling = setTimeout(close, waits.settleMs);
    else close();
  };
  const follow = message => {
    if (message.type === 'result' && !reportsState) { turnOver = true; review(); }
    if (message.type === 'assistant' && !reportsState) { turnOver = false; review(); }
    if (message.type !== 'system') return;
    if (message.subtype === 'session_state_changed') { reportsState = true; turnOver = message.state === 'idle'; review(); }
    // A model request has consumed the pending wake/note and is active work, even before its first assistant
    // message or session-state event. Cancel the old idle closing timer so a slow request can still ask permission.
    if (message.subtype === 'status' && message.status === 'requesting') { unread = false; turnOver = false; review(); }
    if (message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
      const running = message.tasks.filter(task => !task.ambient).length;
      if (running < live) unread = true;
      live = running; review();
    }
  };
  const stuck = () => new Error(`A background command was still running after ${Math.round(waits.backgroundMs / 3_600_000)} hours, so Codeshi ended this run. Anything it was still doing may be incomplete.`);
  // Tools Codeshi answered itself. Declining one is a normal answer that Claude carries on from, unlike a request that never got through.
  const declined = new Set();
  try {
    const first = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: config.images?.length ? [
      { type: 'text', text: config.prompt },
      ...config.images.flatMap(image => [
        { type: 'text', text: 'Attached image: ' + image.name },
        { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } },
      ]),
    ] : config.prompt } };
    async function* input() {
      yield first;
      while (true) { const next = inbox.length ? inbox.shift() : await new Promise(resolve => { wake = resolve; }); if (!next) return; yield next; }
    }
    if (!config.reviewSnapshot) steerable(async text => { if (!open || cancelled()) throw new Error('This turn has finished.'); unread = true; deliver({ type: 'user', parent_tool_use_id: null, priority: 'next', message: { role: 'user', content: text } }); });
    const stream = query({ prompt: input(), options: {
      cwd: config.workspace, pathToClaudeCodeExecutable: config.bin, permissionMode: config.mode === 'read' ? 'plan' : 'default',
      // Current versions of Claude Code replace TodoWrite with task tools unless told otherwise, and Claude's plan comes from TodoWrite.
      env: { ...process.env, CLAUDE_CODE_ENABLE_TASKS: 'false', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
      additionalDirectories: [...new Set(config.workspaces || [])].filter(directory => directory !== config.workspace),
      settingSources: [], settings: { disableAllHooks: true }, mcpServers: {}, strictMcpConfig: true, disallowedTools: ['mcp__*'],
      // Claude enforces a spending limit itself when it is billed per use; on a subscription this isn't set (#87).
      ...(typeof config.maxBudgetUsd === 'number' ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
      // TodoWrite only keeps Claude's own to-do list, shown as the run's plan; it reads and changes nothing. With
      // AskUserQuestion Claude can ask you to choose between options; asking changes nothing either, so read-only runs
      // keep it, and only a background review, which nobody answers, goes without.
      tools: config.routingAssessment ? [] : [...(config.mode === 'read' ? ['Read', 'Glob', 'Grep', 'TodoWrite'] : ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'TodoWrite']), ...(question && !config.reviewSnapshot ? ['AskUserQuestion'] : [])],
      ...(config.routingAssessment ? { maxTurns: 1, persistSession: false } : {}),
      includePartialMessages: true, ...(config.effort ? { effort: config.effort } : {}), abortController: controller, ...(config.sessionId ? { resume: config.sessionId } : {}), model: config.model || 'default',
      canUseTool: async (toolName, input, options) => {
        const answer = await decide(toolName, input, options);
        if (answer.behavior === 'deny' && options?.toolUseID) declined.add(options.toolUseID);
        return answer;
      },
    } });
    async function decide(toolName, input, options) {
      if (config.routingAssessment) return { behavior: 'deny', message: 'Routing assessment does not use tools.' };
      if (toolName === 'TodoWrite') return { behavior: 'allow', updatedInput: input };
      // The questions wait in Codeshi like an approval; the answers go back with them, and skipping tells Claude to decide.
      if (toolName === 'AskUserQuestion') {
        const questions = question && !config.reviewSnapshot ? claudeQuestions(input) : [];
        const answers = questions.length ? await question({ id: options?.toolUseID || `${Date.now()}-${Math.random()}`, questions }) : null;
        return answers ? { behavior: 'allow', updatedInput: { ...input, answers: claudeAnswers(input, answers) } } : { behavior: 'deny', message: 'The user skipped these questions. Continue with your best judgement, and say which choices you made.' };
      }
      if (config.mode === 'read' && !['Read', 'Glob', 'Grep'].includes(toolName)) return { behavior: 'deny', message: 'Read-only mode blocks this tool.' };
      const allow = await approval({ id: options?.toolUseID || `${Date.now()}-${Math.random()}`, kind: toolName, input });
      return allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined this action.' };
    }
    // Claude only sums a run up in its result, and a run that is stopped, as at a handoff, never gets one. Its messages each
    // carry their own usage, so what they add up to is kept until then, marked as a partial count.
    const seenUsage = new Map();
    let lastModelUsage = null;
    const countMessage = ({ id, usage }) => {
      if (!id || !usage) return;
      seenUsage.set(id, usage);
      const sum = key => {
        const reported = [...seenUsage.values()].map(item => item[key]).filter(value => typeof value === 'number' && Number.isFinite(value));
        return reported.length ? reported.reduce((total, value) => total + value, 0) : undefined;
      };
      metadata({ usage: { input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cache_read_input_tokens: sum('cache_read_input_tokens'), cache_creation_input_tokens: sum('cache_creation_input_tokens'), partial: true,
        ...(lastModelUsage ? { modelUsage: lastModelUsage, pendingUsage: { inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), cacheReadInputTokens: sum('cache_read_input_tokens'), cacheCreationInputTokens: sum('cache_creation_input_tokens') } } : {}) } });
    };
    for await (const received of stream) {
      const message = received.type === 'result' && received.permission_denials?.length ? { ...received, permission_denials: received.permission_denials.filter(denial => !declined.has(denial.tool_use_id)) } : received;
      if (message.type === 'assistant' && message.message) {
        countMessage(message.message);
        const reading = !message.parent_tool_use_id && !message.agent_id && claudeRequestContext(message.message.usage);
        if (reading) metadata({ contextUsage: { ...reading, model: message.message.model || null } });
      }
      if (message.type === 'stream_event' && (message.event?.content_block?.type === 'thinking' || message.event?.delta?.type === 'thinking_delta')) event({ type: 'relay.progress', phase: 'reasoning' });
      if (message.type === 'system' && message.subtype === 'status' && message.status === 'compacting') event({ type: 'relay.progress', phase: 'compacting' });
      if (message.type === 'system' && message.subtype === 'init') metadata({ effectiveModel: message.model || 'unknown', transport: 'sdk', authMode: message.apiKeySource || 'unknown', effectiveEffort: message.effort ?? config.effort ?? null });
      if (message.context_usage && !message.parent_tool_use_id) metadata({ contextUsage: { used: message.context_usage.total_tokens, capacity: message.context_usage.raw_max_tokens,
        model: message.context_usage.model, source: 'claude-context-report', estimated: true, windowKind: 'compaction-policy-or-model' } });
      if (message.type === 'result') {
        metadata({ ...(message.modelUsage ? { effectiveModel: Object.keys(message.modelUsage).join(', ') || 'unknown' } : {}), ...(message.usage || message.modelUsage ? { usage: { ...message.usage, ...(message.modelUsage ? { modelUsage: message.modelUsage } : {}) } } : {}), costUSD: message.total_cost_usd });
        lastModelUsage = message.modelUsage || null;
        seenUsage.clear();
      }
      follow(message);
      event(withoutTodos(message, todoIds, event));
    }
    if (expired) throw stuck();
  } catch (error) { throw expired ? stuck() : error; }
  finally { waitNoLonger(); close(); clearInterval(timer); }
}
// Claude's to-do list becomes the run's plan instead of tool activity.
function withoutTodos(message, todoIds, event) {
  const content = message.message?.content;
  if (!Array.isArray(content)) return message;
  if (message.type === 'assistant') for (const block of content) if (block.type === 'tool_use' && block.name === 'TodoWrite') {
    todoIds.add(block.id);
    const todos = Array.isArray(block.input?.todos) ? block.input.todos : [];
    event({ type: 'relay.plan', steps: todos.map(todo => ({ text: todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content, status: todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'pending' })) });
  }
  const kept = content.filter(block => !(block.type === 'tool_use' && block.name === 'TodoWrite') && !(block.type === 'tool_result' && todoIds.has(block.tool_use_id)));
  return kept.length === content.length ? message : { ...message, message: { ...message.message, content: kept } };
}

const logins = new Map();
export function closeAccountConnections() { closeGoogleConnections(); for (const client of logins.values()) client.close(); logins.clear(); googleChecks.clear(); }
// Each Google check starts the Antigravity runtime and a session, which takes seconds. The app asks for the account
// and its models together, so both share one check, and a signed-in result is reused briefly.
const googleChecks = new Map();
function sharedGoogleMetadata({ bin, googleRoot, refresh = false }) {
  const key = JSON.stringify([bin, googleRoot || null]), current = googleChecks.get(key);
  if (current && (current.pending || !refresh && Date.now() - current.at < 60000)) return current.promise;
  const entry = { pending: true, at: 0 };
  entry.promise = googleMetadata({ bin, googleRoot }).then(result => {
    entry.pending = false; entry.at = Date.now();
    if (result.authenticated !== true && googleChecks.get(key) === entry) googleChecks.delete(key);
    return result;
  }, error => { if (googleChecks.get(key) === entry) googleChecks.delete(key); throw error; });
  googleChecks.set(key, entry);
  return entry.promise;
}
export async function accountStatus(provider, { bin = resolveBinary(provider), workspace = os.homedir(), googleRoot, refresh = false } = {}) {
  const base = { installed: false, available: false, authenticated: 'unknown', authMode: 'unknown', billingSource: 'unknown', usage: 'unknown', path: bin, capabilities: capabilities(provider) };
  if (!bin) return { ...base, ...(provider === 'gemini' ? { message: geminiSetup } : {}) };
  if (provider === 'gemini' && isAntigravityACP(bin)) {
    const { models, ...status } = await sharedGoogleMetadata({ bin, googleRoot, refresh });
    return { ...base, ...status, capabilities: { ...base.capabilities, ...status.capabilities, readOnly: 'unavailable', hooks: 'Antigravity manages native hooks and workspace trust. Codeshi does not grant workspace-trust questions automatically.' }, message: 'Google Antigravity connection. Sign in with Google to use the models and allowance available to your account. Coding uses native approvals; read-only work uses Codex or Claude.' };
  }
  const version = await probeCli(bin, ['--version'], 4000);
  // An installed CLI that answers too slowly is unverified, not missing.
  if (version.timedOut) return { ...base, installed: true, errorCategory: 'timeout' };
  if (version.status !== 0) return { ...base, errorCategory: 'installation' };
  base.installed = base.available = true; base.version = version.stdout.trim().slice(0, 200);
  if (provider === 'gemini') {
    if (isAgy(bin)) {
      return { ...base, available: false, authenticated: 'unknown', authMode: 'native-cli', billingSource: 'unknown', capabilities: { ...base.capabilities, approvals: false, readOnly: 'unavailable' }, message: agyUnsupported };
    }
    return { ...base, authMode: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? 'api-key-present' : 'native-cli', billingSource: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? 'api' : 'unknown', message: geminiSetup };
  }
  if (provider === 'claude') {
    const result = await probeCli(bin, ['auth', 'status', '--json'], 5000);
    if (result.timedOut) return { ...base, errorCategory: 'timeout' };
    try {
      const status = JSON.parse(result.stdout);
      // The CLI says "pro" for Max accounts too; the profile in its config knows the plan and its tier (Max 5x, Max 20x).
      const plan = status.loggedIn === true ? claudePlanName({ subscriptionType: status.subscriptionType, ...readClaudeProfile() }) : null;
      return { ...base, authenticated: status.loggedIn ?? 'unknown', authMode: status.authMethod || status.apiKeySource || 'unknown', billingSource: /oauth|claude.?ai/i.test(status.authMethod || '') ? 'subscription' : /api.?key/i.test(status.authMethod || '') ? 'api' : 'unknown', subscriptionType: status.subscriptionType || null, ...(plan ? { planType: plan } : {}) };
    } catch { return base; }
  }
  const client = new CodexClient({ bin, cwd: workspace });
  try {
    await client.initialize();
    const { account, requiresOpenaiAuth } = await client.request('account/read', { refreshToken: false });
    let usage = 'unknown';
    try { usage = (await client.request('account/rateLimits/read', {}, 5000)).rateLimits || 'unknown'; } catch {}
    return { ...base, authenticated: account ? (['chatgpt', 'apiKey'].includes(account.type) ? true : 'unknown') : requiresOpenaiAuth === false ? 'unknown' : false, authMode: account?.type || 'unknown', billingSource: account?.type === 'chatgpt' ? 'subscription' : account?.type === 'apiKey' ? 'api' : 'unknown', planType: account?.planType || null, usage };
  } catch (error) { return { ...base, error: error.message, errorCategory: classifyError(error) }; }
  finally { client.close(); }
}
// Plan usage windows, normalized for both providers: [{ id, label, usedPercent, resetsAt, scope? }].
const windowLabel = minutes => minutes >= 10080 ? 'Weekly' : minutes >= 1440 ? 'Daily' : minutes >= 60 ? `${Math.round(minutes / 60)}-hour` : 'Current';
export function codexUsageWindows(limits) {
  return ['primary', 'secondary'].map(id => limits?.[id]).filter(period => typeof period?.usedPercent === 'number').map((period, index) => ({ id: index ? 'secondary' : 'primary', label: windowLabel(period.windowDurationMins), usedPercent: period.usedPercent, resetsAt: Number.isFinite(period.resetsAt) ? new Date(period.resetsAt * 1000).toISOString() : null }));
}
export function claudeUsageWindows(limits) {
  const rows = [['five_hour', '5-hour'], ['seven_day', 'Weekly'], ['seven_day_opus', 'Weekly · Opus', 'opus'], ['seven_day_sonnet', 'Weekly · Sonnet', 'sonnet']].map(([id, label, scope]) => ({ id, label, scope, period: limits?.[id] }));
  for (const [index, period] of (Array.isArray(limits?.model_scoped) ? limits.model_scoped : []).entries()) if (period?.display_name) rows.push({ id: `model-${index}`, label: `Weekly · ${period.display_name}`, scope: String(period.display_name).toLowerCase(), period });
  return rows.filter(row => typeof row.period?.utilization === 'number').map(({ id, label, scope, period }) => ({ id, label, usedPercent: period.utilization, resetsAt: period.resets_at || null, ...(scope ? { scope } : {}) }));
}
const usageCache = new Map();
function clearUsage(provider) { for (const key of usageCache.keys()) if (JSON.parse(key)[0] === provider) usageCache.delete(key); }
export function providerUsage(provider, { bin = resolveBinary(provider), workspace = os.homedir(), googleRoot, refresh = false } = {}) {
  const key = JSON.stringify([provider, bin, workspace, googleRoot || null]);
  const cached = usageCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < 60000) return cached.promise;
  const promise = readUsage(provider, bin, workspace, googleRoot).catch(error => ({ available: false, reason: error.message || 'Usage could not be read.' })).then(result => ({ provider, checkedAt: new Date().toISOString(), ...result }));
  usageCache.set(key, { at: Date.now(), promise });
  return promise;
}
async function readUsage(provider, bin, workspace, googleRoot) {
  if (provider === 'gemini') {
    if (isAntigravityACP(bin)) return googleQuota({ bin, googleRoot });
    return { available: false, reason: 'Gemini CLI does not expose account quota metadata through this connection. Check your Google account for usage and reset times.' };
  }
  if (!bin) return { available: false, reason: 'Install the provider CLI first.' };
  if (provider === 'claude') {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const controller = new AbortController();
    async function* noPrompt() { await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); }
    const stream = query({ prompt: noPrompt(), options: { cwd: workspace, pathToClaudeCodeExecutable: bin, settingSources: [], settings: { disableAllHooks: true }, mcpServers: {}, strictMcpConfig: true, disallowedTools: ['mcp__*'], abortController: controller } });
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      // Claude Code only exposes plan usage through an experimental SDK call; treat its absence as "not reported".
      const read = stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof read !== 'function') return { available: false, reason: 'This Claude Code version does not report plan usage.' };
      const result = await read.call(stream, { skipBehaviors: true });
      const windows = result?.rate_limits_available ? claudeUsageWindows(result.rate_limits) : [];
      return windows.length ? { available: true, plan: claudePlanName({ subscriptionType: result.subscription_type, ...readClaudeProfile() }), windows } : { available: false, reason: 'Plan usage is reported only for Claude subscription accounts.' };
    } finally { clearTimeout(timeout); controller.abort(); stream.close(); }
  }
  const client = new CodexClient({ bin, cwd: workspace });
  try {
    await client.initialize();
    const limits = (await client.request('account/rateLimits/read', {}, 5000)).rateLimits, windows = codexUsageWindows(limits);
    return windows.length ? { available: true, plan: limits?.planType || null, windows } : { available: false, reason: 'Plan usage is not reported for this account.' };
  } finally { client.close(); }
}
const geminiModelsCache = { at: 0, models: null };
async function fetchAgyModels(bin, options = {}) {
  if (!options.refresh && geminiModelsCache.models && Date.now() - geminiModelsCache.at < 300000) {
    return { models: geminiModelsCache.models, source: 'antigravity-cli', manualSelection: true };
  }
  try {
    const probed = await probeCli(bin, ['models'], 15000);
    if (probed.status === 0 && probed.stdout) {
      const lines = probed.stdout.split('\n');
      const models = [];
      for (const line of lines) {
        const clean = line.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Fetching available models\.\.\./g, '').trim();
        const match = clean.match(/^([a-zA-Z0-9_.-]+)\s+(.+)$/);
        if (match) {
          const id = match[1].trim();
          const displayName = match[2].trim();
          if (id.toLowerCase().startsWith('gemini')) {
            models.push({
              id,
              model: id,
              displayName,
              isDefault: id === 'gemini-3.8-flash-medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Low' },
                { reasoningEffort: 'medium', description: 'Medium' },
                { reasoningEffort: 'high', description: 'High' }
              ]
            });
          }
        }
      }
      if (models.length > 0) {
        geminiModelsCache.at = Date.now();
        geminiModelsCache.models = models;
        return { models, source: 'antigravity-cli', manualSelection: true };
      }
    }
  } catch {}
  return { models: [], source: 'unavailable', manualSelection: false, message: agyUnsupported };
}

export async function listModels(provider, options = {}) {
  if (provider === 'gemini') {
    const bin = options.bin || resolveBinary(provider);
    if (isAntigravityACP(bin)) {
      const result = await sharedGoogleMetadata({ bin, googleRoot: options.googleRoot, refresh: options.refresh });
      if (Array.isArray(result?.models) && result.models.length > 0 && result.authenticated !== false) {
        return { ...result, models: result.models.filter(m => String(m.id || m.model || m.value || '').toLowerCase().startsWith('gemini')) };
      }
      const agyBin = resolveBinary('gemini');
      if (agyBin && isAgy(agyBin)) {
        return fetchAgyModels(agyBin, options);
      }
      return result;
    }
    if (isAgy(bin)) {
      return fetchAgyModels(bin, options);
    }
    return { models: [], source: 'native-cli', manualSelection: true, message: 'Use the Gemini CLI default or enter a model ID available to your account. The selected model is verified before sending a prompt.' };
  }
  if (provider === 'claude') {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const controller = new AbortController();
    async function* noPrompt() { await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); }
    const stream = query({ prompt: noPrompt(), options: { cwd: options.workspace || os.homedir(), pathToClaudeCodeExecutable: options.bin || resolveBinary(provider), settingSources: [], settings: { disableAllHooks: true }, mcpServers: {}, strictMcpConfig: true, disallowedTools: ['mcp__*'], abortController: controller } });
    const timeout = setTimeout(() => controller.abort(), 6000);
    try { const models = await stream.supportedModels(); return { models: models.map(model => ({ ...model, id: model.value, model: model.value })), source: 'provider', manualSelection: true }; }
    finally { clearTimeout(timeout); controller.abort(); stream.close(); }
  }
  const client = new CodexClient({ bin: options.bin || resolveBinary(provider), cwd: options.workspace || os.homedir() });
  try { await client.initialize(); const result = await client.request('model/list', { limit: 100, includeHidden: false }); return { models: result.data, source: 'provider', nextCursor: result.nextCursor }; }
  finally { client.close(); }
}
export async function connectAccount(provider, { bin = resolveBinary(provider), workspace = os.homedir(), googleRoot } = {}) {
  clearUsage(provider);
  if (provider === 'gemini') {
    if (isAntigravityACP(bin)) { googleChecks.clear(); return connectGoogle({ bin, googleRoot }); }
    if (isAgy(bin)) return { started: false, nativeFlow: true, message: 'Sign in to Google using the Antigravity app or CLI (agy), then refresh status in Codeshi.' };
    return { started: false, nativeFlow: true, message: geminiSetup };
  }
  if (!bin) throw Object.assign(new Error('Install the provider CLI first.'), { status: 503 });
  if (provider === 'claude') {
    const child = spawn(bin, ['auth', 'login'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: workspace, shell: false });
    const id = `claude:${child.pid}:${Date.now()}`;
    const timer = setTimeout(() => { child.kill('SIGTERM'); logins.delete(id); }, 10 * 60 * 1000); timer.unref();
    logins.set(id, { close() { clearTimeout(timer); child.kill('SIGTERM'); } });
    child.on('close', () => { clearTimeout(timer); logins.delete(id); });
    child.on('error', () => {}); child.stdout.resume(); child.stderr.resume();
    return { started: true, nativeFlow: true, message: 'Claude Code started its own browser authentication flow. Complete sign-in there, then refresh status. All native authentication choices remain available in the installed CLI.' };
  }
  const client = new CodexClient({ bin, cwd: workspace }); await client.initialize();
  try {
    const login = await client.request('account/login/start', { type: 'chatgpt' });
    logins.set(login.loginId, client);
    const timer = setTimeout(() => { client.close(); logins.delete(login.loginId); }, 10 * 60 * 1000); timer.unref();
    client.on('message', message => { if (message.method === 'account/login/completed') { clearTimeout(timer); client.close(); logins.delete(login.loginId); } });
    return login;
  } catch (error) { client.close(); throw error; }
}
export async function disconnectAccount(provider, { bin = resolveBinary(provider), workspace = os.homedir(), googleRoot } = {}) {
  clearUsage(provider);
  if (provider === 'gemini' && isAntigravityACP(bin)) { googleChecks.clear(); return disconnectGoogle({ bin, googleRoot }); }
  if (provider === 'gemini') throw Object.assign(new Error('Manage Google and Gemini authentication in the native Antigravity or Gemini CLI. Codeshi stores no credentials.'), { status: 400 });
  if (!bin) throw Object.assign(new Error('Install the provider CLI first.'), { status: 503 });
  if (provider === 'claude') { const result = spawnSync(bin, ['auth', 'logout'], { cwd: workspace, encoding: 'utf8', timeout: 5000, shell: false }); if (result.status !== 0) throw new Error(result.stderr || 'Claude logout failed.'); return { disconnected: true }; }
  const client = new CodexClient({ bin, cwd: workspace }); try { await client.initialize(); await client.request('account/logout'); return { disconnected: true }; } finally { client.close(); }
}

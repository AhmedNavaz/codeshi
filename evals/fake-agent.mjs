// A stand-in Codex app-server that replays a recorded trace, so evaluations run in CI without a model or an account.
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('eval-trace-agent 1'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const { EVAL_TRACE: traceFile, EVAL_STATE: stateFile, EVAL_FOLDERS: foldersJson } = process.env, trace = JSON.parse(fs.readFileSync(traceFile, 'utf8')), folders = JSON.parse(foldersJson);
const claude = process.argv.includes('--output-format');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let threadId = randomUUID();
const sessionFile = stateFile + '.sessions';
const sessions = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : {};
let totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
let resumeAfterQuestion = null;
async function playTurn(prompt = '') {
  const count = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, 'utf8')) : 0, turn = trace[Math.min(count, trace.length - 1)] || { steps: [] };
  fs.writeFileSync(stateFile, String(count + 1));
  if (turn.requiresPrompt?.some(fact => !prompt.includes(fact))) {
    if (claude) send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Recorded context requirement missing.' });
    else send({ method: 'turn/completed', params: { threadId, turn: { status: 'failed', error: { message: 'Recorded context requirement missing.' } } } });
    return;
  }
  if (claude) send({ type: 'system', subtype: 'init', session_id: threadId, model: 'recorded-trace' });
  if (turn.compact) {
    if (claude) send({ type: 'relay.progress', phase: 'compacting' });
    else send({ method: 'thread/compacted', params: { threadId } });
  }
  const item = value => {
    if (!claude) return send({ method: 'item/completed', params: { threadId, item: value } });
    if (value.type === 'agentMessage') send({ type: 'assistant', message: { id: value.id, content: [{ type: 'text', text: value.text }] } });
    else send({ type: 'assistant', message: { id: value.id, content: [{ type: 'tool_use', id: value.id, name: value.type === 'fileChange' ? 'Edit' : 'Bash', input: value.type === 'fileChange' ? { file_path: value.changes[0].path } : { command: value.command } }] } });
  };
  for (const [index, step] of turn.steps.entries()) {
    const id = `step-${count}-${index}`;
    if (step.type === 'ask') { send({ id: 700 + index, method: 'item/tool/requestUserInput', params: { threadId, turnId: 'trace-turn', itemId: id, questions: [{ id: 'q', header: 'Which?', question: step.text, options: [{ label: 'One', description: 'One' }] }] } }); await new Promise(resolve => { resumeAfterQuestion = resolve; }); }
    if (step.type === 'say') item({ id, type: 'agentMessage', text: step.text });
    if (step.type === 'command') item({ id, type: 'commandExecution', command: step.command, aggregatedOutput: step.output || '' });
    if (step.type === 'write') { const file = path.join(folders[step.folder], step.file); fs.writeFileSync(file, step.content); item({ id, type: 'fileChange', changes: [{ path: file, kind: { type: 'update' } }] }); }
  }
  if (turn.usage) {
    const usage = turn.usage;
    totals = { inputTokens: totals.inputTokens + usage.input + usage.cached, cachedInputTokens: totals.cachedInputTokens + usage.cached, outputTokens: totals.outputTokens + usage.output, reasoningOutputTokens: totals.reasoningOutputTokens + usage.reasoning };
    sessions[threadId] = totals; fs.writeFileSync(sessionFile, JSON.stringify(sessions));
    if (claude) send({ type: 'result', subtype: 'success', usage: { input_tokens: usage.input, cache_read_input_tokens: usage.cached, output_tokens: usage.output }, modelUsage: { 'recorded-trace': { inputTokens: totals.inputTokens - totals.cachedInputTokens, cacheReadInputTokens: totals.cachedInputTokens, outputTokens: totals.outputTokens } } });
    else send({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total: { ...totals, totalTokens: totals.inputTokens + totals.outputTokens }, last: { inputTokens: usage.input + usage.cached, cachedInputTokens: usage.cached, outputTokens: usage.output, reasoningOutputTokens: usage.reasoning }, modelContextWindow: 200000 } } });
  }
  if (!turn.hold) {
    if (claude) { if (!turn.usage) send({ type: 'result', subtype: 'success' }); }
    else send({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
  } else if (claude) setInterval(() => {}, 1000);
}
if (claude) {
  const resume = process.argv.indexOf('--resume');
  if (resume >= 0) { threadId = process.argv[resume + 1]; totals = sessions[threadId] || totals; }
  if (process.argv.includes('--input-format')) {
    // The SDK keeps stdin open for later control messages. Its first user message starts this recorded turn.
    let played = false;
    readline.createInterface({ input: process.stdin }).on('line', async line => {
      const message = JSON.parse(line);
      if (message.type !== 'user' || played) return;
      played = true;
      const content = message.message?.content;
      await playTurn(typeof content === 'string' ? content : (content || []).map(block => block.text || '').join('\n'));
    });
  } else {
    let prompt = '';
    for await (const part of process.stdin) prompt += part;
    await playTurn(prompt);
  }
} else readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id >= 700 && !message.method) return resumeAfterQuestion?.();
  if (message.id === undefined || !message.method) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'model/list') return send({ id: message.id, result: { data: [] } });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.method === 'thread/resume') { threadId = message.params.threadId; totals = sessions[threadId] || totals; }
    return send({ id: message.id, result: { thread: { id: threadId }, model: 'recorded-trace' } });
  }
  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false } });
  if (message.method === 'turn/start') { send({ id: message.id, result: { turn: { id: 'trace-turn' } } }); return playTurn((message.params.input || []).map(item => item.text || '').join('\n')); }
  send({ id: message.id, error: { code: -32601, message: 'Not recorded.' } });
});

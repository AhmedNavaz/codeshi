// A stand-in Codex app-server that replays a recorded trace, so evaluations run in CI without a model or an account.
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('eval-trace-agent 1'); process.exit(0); }
const { EVAL_TRACE: traceFile, EVAL_STATE: stateFile, EVAL_FOLDERS: foldersJson } = process.env, trace = JSON.parse(fs.readFileSync(traceFile, 'utf8')), folders = JSON.parse(foldersJson);
const send = value => process.stdout.write(JSON.stringify(value) + '\n'), threadId = 'trace-thread';
let totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
let resumeAfterQuestion = null;
async function playTurn() {
  const count = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, 'utf8')) : 0, turn = trace[Math.min(count, trace.length - 1)] || { steps: [] };
  fs.writeFileSync(stateFile, String(count + 1));
  for (const [index, step] of turn.steps.entries()) {
    const id = `step-${count}-${index}`;
    if (step.type === 'ask') { send({ id: 700 + index, method: 'item/tool/requestUserInput', params: { threadId, turnId: 'trace-turn', itemId: id, questions: [{ id: 'q', header: 'Which?', question: step.text, options: [{ label: 'One', description: 'One' }] }] } }); await new Promise(resolve => { resumeAfterQuestion = resolve; }); }
    if (step.type === 'say') send({ method: 'item/completed', params: { threadId, item: { id, type: 'agentMessage', text: step.text } } });
    if (step.type === 'command') send({ method: 'item/completed', params: { threadId, item: { id, type: 'commandExecution', command: step.command, aggregatedOutput: step.output || '' } } });
    if (step.type === 'write') { const file = path.join(folders[step.folder], step.file); fs.writeFileSync(file, step.content); send({ method: 'item/completed', params: { threadId, item: { id, type: 'fileChange', changes: [{ path: file, kind: { type: 'update' } }] } } }); }
  }
  if (turn.usage) {
    const usage = turn.usage;
    totals = { inputTokens: totals.inputTokens + usage.input + usage.cached, cachedInputTokens: totals.cachedInputTokens + usage.cached, outputTokens: totals.outputTokens + usage.output, reasoningOutputTokens: totals.reasoningOutputTokens + usage.reasoning };
    send({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total: { ...totals, totalTokens: totals.inputTokens + totals.outputTokens }, last: {}, modelContextWindow: 200000 } } });
  }
  if (!turn.hold) send({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id >= 700 && !message.method) return resumeAfterQuestion?.();
  if (message.id === undefined || !message.method) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'model/list') return send({ id: message.id, result: { data: [] } });
  if (message.method === 'thread/start' || message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: threadId }, model: 'recorded-trace' } });
  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false } });
  if (message.method === 'turn/start') { send({ id: message.id, result: { turn: { id: 'trace-turn' } } }); return playTurn(); }
  send({ id: message.id, error: { code: -32601, message: 'Not recorded.' } });
});

import fs from 'node:fs';
import path from 'node:path';

const provider = path.basename(process.argv[1]).startsWith('claude') ? 'claude' : 'codex';
if (process.argv.includes('--version')) {
  console.log(`${provider} test fixture 1.0`);
  process.exit(0);
}

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
const config = JSON.parse(fs.readFileSync('.mock-scenarios.json', 'utf8'));
const scenario = config[context.currentRequest] || {};
fs.appendFileSync('.mock-captures.jsonl', `${JSON.stringify({ provider, args: process.argv.slice(2), prompt, context, cwd: process.cwd(), electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null })}\n`);

// Split JSON records across writes, and leave one final event unterminated. This
// exercises the production parser rather than calling its event handler directly.
async function emit(value, final = false) {
  const line = JSON.stringify(value) + (final ? '' : '\n');
  const middle = Math.floor(line.length / 2);
  process.stdout.write(line.slice(0, middle));
  await new Promise(resolve => setTimeout(resolve, 2));
  process.stdout.write(line.slice(middle));
}

const sessionId = `${provider}-test-session`;
if (provider === 'codex') {
  await emit({ type: 'thread.started', thread_id: sessionId });
  if (scenario.behavior === 'reconnect') {
    await emit({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
  }
  await emit({ type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: scenario.text || `Codex: ${context.currentRequest}` } });
  await emit({ type: 'item.completed', item: { id: 'command', type: 'command_execution', command: 'inspect-project', aggregated_output: 'project inspection retained' } });
  if (scenario.changes) await emit({ type: 'item.completed', item: { id: 'patch', type: 'file_change', changes: scenario.changes } });
  // Writes and removes files as the scenario says, as an agent's edits would.
  for (const [file, content] of Object.entries(scenario.write || {})) {
    if (content === null) fs.rmSync(file, { force: true });
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  }
  // Holds the run open until the test creates .release, then finishes normally.
  if (scenario.behavior === 'hold') await new Promise(resolve => { const timer = setInterval(() => { if (fs.existsSync('.release')) { clearInterval(timer); resolve(); } }, 20); });
  if (scenario.behavior === 'hang') {
    setInterval(() => {}, 1000);
  } else if (scenario.behavior === 'quota') {
    await emit({ type: 'turn.failed', error: { message: 'Usage limit reached in mock Codex.' } }, true);
    process.exitCode = 1;
  } else if (scenario.behavior === 'no-terminal') {
    // A clean process exit is not sufficient evidence of a completed turn.
  } else if (scenario.behavior === 'bad-exit') {
    await emit({ type: 'turn.completed' }, true);
    process.exitCode = 1;
  } else {
    await emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: scenario.text || `Codex: ${context.currentRequest}` } });
    await emit({ type: 'turn.completed' }, true);
  }
} else {
  await emit({ type: 'system', subtype: 'init', session_id: sessionId });
  await emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'claude-answer' } } });
  const text = scenario.text || `Claude: ${context.currentRequest}`;
  const middle = Math.floor(text.length / 2);
  for (const part of [text.slice(0, middle), text.slice(middle)]) {
    await emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
  }
  await emit({ type: 'assistant', message: { id: 'claude-answer', content: [
    { type: 'text', text },
    { type: 'tool_use', id: 'read-project', name: 'Read', input: { file_path: 'project.txt' } },
  ] } });
  await emit({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'read-project', content: 'Claude project inspection retained' },
  ] } });
  await emit({ type: 'result', subtype: 'success', session_id: sessionId, result: text, is_error: false,
    ...(scenario.behavior === 'permission-denied' ? { permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'needs-approval' } }] } : {}),
  }, true);
}

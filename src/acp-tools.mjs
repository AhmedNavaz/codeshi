// An agent on the Agent Client Protocol describes each tool in its own words. Antigravity calls a command CommandLine
// while asking and command_line while running, and reports a command's result in rawOutput instead of content. These
// become the steps Codex and Claude report, so the timeline, approval rules and task records read every agent alike.

const objectOf = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const firstText = (source, keys) => { for (const key of keys) if (typeof source[key] === 'string' && source[key]) return source[key]; return ''; };
const diffsOf = tool => (Array.isArray(tool.content) ? tool.content : []).filter(block => block?.type === 'diff' && typeof block.path === 'string');
const isNewFile = diff => diff._meta?.kind === 'add' || diff.oldText === null || diff.oldText === undefined;
// "Running view_file" and "Run search_web?" name the runtime's tool. "Run tests" is already a description.
const nameInTitle = title => String(title || '').match(/^(?:Running|Run)\s+([A-Za-z]+_[\w-]*)\??$|^Run\s+([A-Za-z_][\w-]*)\?$/)?.slice(1).find(Boolean) || null;

export function toolOutput(tool) {
  const raw = tool.rawOutput;
  const reported = typeof raw === 'string' ? raw : firstText(objectOf(raw), ['combinedOutput', 'formatted_output', 'output', 'stdout', 'error', 'message']);
  const written = (Array.isArray(tool.content) ? tool.content : []).map(block => block?.content?.text ?? block?.text).filter(text => typeof text === 'string').join('\n');
  return (reported || written).replace(/\r\n/g, '\n').trimEnd();
}

export function acpToolItem(tool) {
  const id = tool.toolCallId, input = objectOf(tool.rawInput), output = toolOutput(tool), failed = tool.status === 'failed';
  const step = (name, stepInput, result = output) => ({ id, type: 'agent_tool', name, input: stepInput, result, failed });
  const command = firstText(input, ['command', 'CommandLine', 'command_line', 'commandLine']);
  if (tool.kind === 'execute' && command) {
    const report = objectOf(tool.rawOutput), exit = report.exitCode ?? report.exit_code;
    return { id, type: 'command_execution', command, aggregated_output: output, ...(failed ? { status: 'failed' } : {}), ...(Number.isInteger(exit) ? { exit_code: exit } : {}) };
  }
  const diffs = diffsOf(tool);
  if (diffs.length > 1) return { id, type: 'file_change', changes: diffs.map(diff => ({ path: diff.path, kind: isNewFile(diff) ? 'add' : 'update' })) };
  if (diffs.length === 1) {
    const [diff] = diffs;
    if (isNewFile(diff)) return step('Write', { file_path: diff.path, content: String(diff.newText ?? '') }, output || 'Created');
    return step('Edit', { file_path: diff.path, old_string: String(diff.oldText ?? ''), new_string: String(diff.newText ?? '') });
  }
  const target = firstText(input, ['file_path', 'absolute_path', 'target_file', 'path']) || tool.locations?.[0]?.path;
  if (tool.kind === 'read' && target) return step('Read', { file_path: target });
  const named = nameInTitle(tool.title), query = firstText(input, ['query']), url = firstText(input, ['url', 'Url']);
  if (tool.kind === 'search' && query && /web/i.test(named || '')) return step('WebSearch', { query });
  if (tool.kind === 'fetch' && url) return step('WebFetch', { url });
  if (named) return step(named, input);
  return { id, type: 'mcp_tool_call', tool: tool.title || tool.kind || 'Gemini tool', result: output };
}

// What the person and the approval rules see. Rules read `command` and `file_path`; a request they can't read always
// asks and can never be remembered, so the runtime's own names are translated here.
export function acpApprovalRequest(tool) {
  const item = acpToolItem(tool), input = objectOf(tool.rawInput), kind = tool.kind || 'tool';
  if (item.type === 'command_execution') {
    const cwd = firstText(input, ['cwd', 'Cwd', 'working_dir', 'directory']);
    return { kind, title: tool.title, input: { command: item.command, ...(cwd ? { cwd } : {}) } };
  }
  if (item.type === 'agent_tool' && ['Read', 'Edit', 'Write'].includes(item.name)) return { kind, input: item.input };
  return { kind, title: tool.title, input: tool.rawInput || { action: tool.title } };
}

// A file write the person already allowed through this tool's own approval. The runtime then writes it through the
// client, and asking again for the same bytes would be a second prompt for one edit.
export const allowedWrites = tool => diffsOf(tool).map(diff => writeKey(diff.path, String(diff.newText ?? '')));
export const writeKey = (file, content) => `${file}\0${content}`;

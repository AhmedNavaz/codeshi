// What Codex asks of you beyond commands and file changes: running a connector or MCP tool, more access, and what an
// MCP server asks for itself. Codex reads a request nobody answers as "user rejected MCP tool call", so each one here
// gets a real answer. Approvals go through the run's policy like any other. What a server wants from a person, such as
// finishing a sign-in, is shown as a question, because no policy can answer it for them.
import { webLink } from './agent-questions.mjs';

const DETAILS = 4000;
const line = (value, max = 200) => (typeof value === 'string' ? value : '').trim().slice(0, max);
const shown = value => typeof value === 'string' ? value : JSON.stringify(value) ?? '';
const clipped = text => text.length > DETAILS ? `${text.slice(0, DETAILS)}\n… (cut here)` : text;
const answer = (action, content = null) => ({ action, content, _meta: null });

// A tool's input is kept apart from a request's `input`, whose command and path fields mean a shell command or a file
// to the approval rules. A tool can name its own parameters anything, so none of them is read as one of those.
function parameterLines(meta) {
  const display = Array.isArray(meta?.tool_params_display) ? meta.tool_params_display : null;
  const rows = display ? display.map(row => [row?.display_name || row?.name, row?.value]) : Object.entries(meta?.tool_params && typeof meta.tool_params === 'object' ? meta.tool_params : {});
  return clipped(rows.map(([name, value]) => `${name}: ${shown(value)}`).join('\n'));
}
const toolFrom = message => /run tool "([^"]+)"/.exec(message || '')?.[1] || '';

export const isToolApproval = params => params?._meta?.codex_approval_kind === 'mcp_tool_call';
export function toolApprovalRequest(id, params) {
  const meta = params?._meta || {}, connector = serverLabel(params) || 'A connector';
  return { id: String(id), kind: 'mcpServer/elicitation/request', connector, title: line(meta.tool_title) || toolFrom(params?.message) || 'A tool', details: parameterLines(meta) };
}
// The tool runs this once: nothing is remembered, so the next call asks again and a denial ends with this call.
export const toolApprovalAnswer = allow => allow ? answer('accept', {}) : answer('decline');

// The same approval can arrive as a question, when Codex's elicitation feature is off.
export const isToolApprovalQuestion = params => params?.questions?.length === 1 && /^mcp_tool_call_approval_/.test(String(params.questions[0]?.id));
export function toolQuestionRequest(id, params) {
  const text = String(params.questions[0].question || ''), connector = line(/^Allow (?:the )?(.+?)(?: MCP server)? to run tool/.exec(text)?.[1]) || 'An MCP server';
  return { id: String(id), kind: 'item/tool/requestUserInput', connector, title: line(toolFrom(text)) || 'A tool', details: '' };
}
// An answer that names no option cancels the call, so anything unexpected refuses.
export function toolQuestionAnswer(params, allow) {
  const question = params.questions[0], labels = (question.options || []).map(option => option?.label);
  const label = labels.find(value => allow ? /^(?:allow|approve)(?: once)?$/i.test(value) : /^(?:cancel|deny|decline)$/i.test(value));
  return { answers: { [question.id]: { answers: label ? [label] : [] } } };
}

export function permissionsRequest(id, params) {
  const { network, fileSystem } = params?.permissions || {}, wanted = [network?.enabled ? 'Network access' : '', fileSystem ? 'Access to files' : ''].filter(Boolean);
  const paths = fileSystem ? [['Read', fileSystem.read], ['Write', fileSystem.write]].filter(([, list]) => list?.length).map(([name, list]) => `${name}: ${list.join(', ')}`) : [];
  if (fileSystem?.entries?.length) paths.push(`Paths: ${shown(fileSystem.entries)}`);
  return { id: String(id), kind: 'item/permissions/requestApproval', ...(params?.cwd ? { cwd: params.cwd } : {}), title: wanted.join(' and ') || 'More access', details: clipped([line(params?.reason, 1000) && `Reason: ${line(params.reason, 1000)}`, ...paths].filter(Boolean).join('\n')) };
}
// Exactly what was asked for, for this turn only.
export function permissionsAnswer(params, allow) {
  const permissions = {}, wanted = params?.permissions || {};
  if (allow) { if (wanted.network) permissions.network = wanted.network; if (wanted.fileSystem) permissions.fileSystem = wanted.fileSystem; }
  return { permissions, scope: 'turn' };
}

// One field of a server's form as a question, and how to read its answer back. Null when it can't be shown as one.
function fieldQuestion(name, schema) {
  if (!schema || typeof schema !== 'object') return null;
  const header = line(schema.title) || name, question = line(schema.description, 1000) || header, base = { id: name, header, question };
  const choices = rows => {
    const values = new Map();
    for (const [label, value] of rows) if (line(label) && !values.has(line(label))) values.set(line(label), value);
    return values.size && values.size <= 8 ? values : null;
  };
  const list = spec => spec.oneOf || spec.anyOf ? (spec.oneOf || spec.anyOf).map(row => [row?.title || row?.const, row?.const]) : Array.isArray(spec.enum) ? spec.enum.map((value, index) => [spec.enumNames?.[index] || value, value]) : null;
  if (schema.type === 'boolean') return { ...base, options: [{ label: 'Yes' }, { label: 'No' }], read: ([value]) => value === 'Yes' };
  const multiple = schema.type === 'array', rows = list(multiple ? schema.items || {} : schema);
  if (multiple && !rows) return null;
  if (rows) {
    const values = choices(rows);
    if (!values) return null;
    return { ...base, options: [...values.keys()].map(label => ({ label })), multiple, read: picked => multiple ? picked.map(label => values.get(label)) : values.get(picked[0]) };
  }
  if (schema.type === 'string') return { ...base, other: true, read: ([value]) => value };
  if (schema.type === 'number' || schema.type === 'integer') return { ...base, other: true, read: ([value]) => { const number = Number(value); return Number.isFinite(number) && (schema.type === 'number' || Number.isInteger(number)) ? number : undefined; } };
  return null;
}

// Connectors all arrive through one server with an internal name, so what you see is the connector's own, if it says.
const serverLabel = params => line(params?._meta?.connector_name, 40) || (params?.serverName === 'codex_apps' ? '' : line(params?.serverName, 40));

// What a server asks of the person, as questions and how their answers go back. Null when Codeshi can't show it.
export function elicitationQuestions(params) {
  const message = line(params?.message, 1000), header = serverLabel(params);
  const confirm = (confirmed, refused, content, extra = {}) => ({
    questions: [{ id: 'confirm', header, question: message || 'Continue?', options: [{ label: confirmed }, { label: refused }], ...extra }],
    respond: answers => !answers ? answer('cancel') : answers[0]?.[0] === confirmed ? answer('accept', content) : answer('decline'),
  });
  if (params?.mode === 'url') { const link = webLink(params.url); return link ? confirm('Done', 'Cancel', null, { link }) : null; }
  if (params?.mode !== 'form') return null;
  const fields = Object.entries(params.requestedSchema?.properties || {});
  if (!fields.length) return confirm('Continue', 'Cancel', {});
  if (fields.length > 6) return null;
  const questions = fields.map(([name, schema]) => fieldQuestion(name, schema));
  if (questions.includes(null)) return null;
  return {
    questions: questions.map(({ read, ...question }) => question),
    respond: answers => {
      if (!answers) return answer('cancel');
      const content = {};
      for (const [index, [name]] of fields.entries()) { const value = questions[index].read(answers[index]); if (value === undefined) return null; content[name] = value; }
      return answer('accept', content);
    },
  };
}
export const elicitationCancelled = () => answer('cancel');
export const cannotShow = params => `${serverLabel(params) || 'A connector'} asked for something Codeshi can't show, so it was cancelled${line(params?.message, 300) ? `: ${line(params.message, 300)}` : '.'} To answer it, run this from Codex directly.`;

// What the timeline shows for a connector or MCP tool: its input while it runs, then its answer or the reason it failed.
export function toolCallOutcome(item) {
  if (item.error?.message) return String(item.error.message);
  const text = (Array.isArray(item.result?.content) ? item.result.content : []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
  if (text) return clipped(text);
  return item.status === 'inProgress' ? item.arguments : '';
}

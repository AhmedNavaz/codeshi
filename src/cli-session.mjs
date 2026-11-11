// `codeshi` with no command: an interactive session in the terminal (#90), built on Ink. It's a client of Codeshi's engine
// like the window, so it's the same conversation: what's typed here shows in the app, and the app's runs show here. The
// finished parts of the conversation go into the terminal's own scrollback; only the live run, the prompt and any
// approval are redrawn. Leaving the session never stops a run: it carries on in Codeshi.
import React from 'react';
import { render, Box, Text, Static, useInput, usePaste, useApp, useWindowSize } from 'ink';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { client, connect, chooseWorkspace, CliError, EXIT } from './cli.mjs';
import {
  ACCENT, ACCESS_STEPS, accessLabel, agentName, approvalChoices, describeRequest, formatActivity, formatElapsed, formatMarkdown,
  formatNotice, formatTokens, formatUser, modelName, defaultModelId, nextAccess, settledMessages, shortPath,
} from './cli-format.mjs';

const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;
const AGENTS = ['codex', 'claude', 'gemini'];
const SPINNER = ['✻', '✽', '✶', '✳', '✢', '·', '✢', '✳', '✶', '✽'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The branch, also in a repository with no commits yet; a detached HEAD shows its short hash.
const gitBranch = cwd => new Promise(resolve => execFile('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, timeout: 3000 }, (error, out) => {
  if (!error) return resolve(out.trim() || null);
  execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: 3000 }, (failed, hash) => resolve(failed ? null : hash.trim() || null));
}));

// In a tab of the Codeshi window (CODESHI_EMBEDDED), the chat is one click away: /open and leaving go back to it, and the
// tab belongs to one workspace, so switching is left to the sidebar.
const EMBEDDED = process.env.CODESHI_EMBEDDED === '1';
const ALL_COMMANDS = [
  ['/help', 'Commands and keys'],
  ['/agent', 'Switch agent: codex, claude or gemini'],
  ['/model', 'Choose the model'],
  ['/effort', 'Choose how hard the model thinks'],
  ['/access', 'Read only, ask before changes, or edit without asking'],
  ['/stop', 'Stop the run (or press esc)'],
  ['/continue', 'Continue the last run'],
  ['/handoff', 'Hand the task to another agent'],
  ['/queue', 'Messages waiting for the next run'],
  ['/tasks', 'Tasks in this workspace'],
  ['/board', 'Cards on the board'],
  ['/status', 'Workspaces, and what each is doing'],
  ['/workspace', 'Switch workspace'],
  ['/open', EMBEDDED ? 'Back to the chat; this tab keeps running' : 'Open this conversation in the Codeshi window'],
  ['/clear', 'Clear the screen'],
  ['/exit', EMBEDDED ? 'Close this tab; a run carries on in the chat' : 'Leave; a run carries on in Codeshi'],
];
export const COMMANDS = EMBEDDED ? ALL_COMMANDS.filter(([name]) => name !== '/workspace') : ALL_COMMANDS;

const KEYS = [
  ['enter', 'send; while a run works, add it to the run or queue it'],
  ['\\ enter, ⌥ enter', 'new line'],
  ['esc', 'stop the run, close a list, or clear what you typed'],
  ['shift+tab', 'switch access: asks before changes → edits without asking → read only'],
  ['↑ ↓', 'earlier messages'],
  ['@', 'mention a file'],
  ['ctrl+c', 'clear what you typed; twice to leave'],
  ['ctrl+a ctrl+e', 'start and end of the line'],
  ['ctrl+u ctrl+k ctrl+w', 'delete to start, to end, the word before'],
];

// Spans as Ink text. Each line wraps at the terminal's width.
const styled = (parts, keyBase = 0) => parts.map((part, index) => h(Text, { key: keyBase + index, color: part.color, dimColor: part.dim, bold: part.bold, italic: part.italic, inverse: part.inverse }, part.text));
// A line that starts with a marker (●, ›, ⎿ or an indent) wraps under its text, not under the marker.
const Line = ({ spans }) => {
  const marker = spans.length > 1 && /^\s*(?:[●›⎿•✗!│✻]\s*)?$/.test(spans[0].text) && spans[0].text.length <= 8 ? spans[0] : null;
  if (!marker) return h(Text, { wrap: 'wrap' }, ...styled(spans));
  return h(Box, null, h(Box, { width: marker.text.length, flexShrink: 0 }, h(Text, null, ...styled([marker]))), h(Box, { flexGrow: 1, flexShrink: 1 }, h(Text, { wrap: 'wrap' }, ...styled(spans.slice(1), 1))));
};
// Ink lays out scrollback (Static) apart from the screen, so its lines get the terminal's width explicitly.
const Lines = ({ lines, marginTop = 0, width }) => h(Box, { flexDirection: 'column', marginTop, width }, ...lines.map((spans, index) => h(Line, { key: index, spans })));
const plain = (text, style = {}) => [{ text, ...style }];
const one = (text, style = {}) => [plain(text, style)];

// The prompt's text with its cursor. Rows are the typed lines; the cursor is an inverted cell.
function Editor({ value, cursor, placeholder, prefixColor }) {
  const rows = value.split('\n');
  let offset = cursor, row = 0;
  while (row < rows.length - 1 && offset > rows[row].length) { offset -= rows[row].length + 1; row++; }
  if (!value) return h(Text, null, h(Text, { color: prefixColor, bold: true }, '› '), h(Text, { inverse: true }, placeholder[0] || ' '), h(Text, { dimColor: true }, placeholder.slice(1)));
  return h(Box, { flexDirection: 'column' }, ...rows.map((text, index) => h(Text, { key: index, wrap: 'wrap' },
    h(Text, { color: prefixColor, bold: true }, index ? '  ' : '› '),
    index === row ? [h(Text, { key: 'a' }, text.slice(0, offset)), h(Text, { key: 'b', inverse: true }, text[offset] || ' '), h(Text, { key: 'c' }, text.slice(offset + 1))] : text)));
}

// A list to choose from: arrows or numbers, enter to choose, esc to close.
function Choices({ choices, index }) {
  return h(Box, { flexDirection: 'column' }, ...choices.map((choice, position) => h(Text, { key: position, wrap: 'truncate-end' },
    h(Text, { color: position === index ? ACCENT : undefined, bold: position === index }, `${position === index ? '❯' : ' '} ${position + 1}. ${choice.label}`),
    choice.picked ? h(Text, { color: 'green' }, ' ✔') : null,
    choice.hint ? h(Text, { dimColor: true }, ` (${choice.hint})`) : null,
    choice.description ? h(Text, { dimColor: true }, `  ${choice.description}`) : null)));
}

function Panel({ title, children, color = ACCENT }) {
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: color, paddingX: 1, marginTop: 1 },
    title ? h(Text, { bold: true, color }, title) : null, children);
}

function Session({ engine, start, onClear, onLeave }) {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const width = Math.max(40, (columns || 80) - 6);
  const [items, setItems] = useState(start.banner);
  const [staticKey, setStaticKey] = useState(0);
  const [view, setView] = useState(start.view);
  const [project, setProject] = useState(start.project);
  // Keys can arrive faster than the screen redraws, so each one reads and writes these refs at once, not the last render.
  const [input, setInputState] = useState({ value: '', cursor: 0 });
  const inputRef = useRef(input);
  const setInput = next => { inputRef.current = next; setInputState(next); };
  const [overlay, setOverlayState] = useState(null);
  const setOverlay = next => { overlayRef.current = next; setOverlayState(next); };
  const [notice, setNotice] = useState(null);
  const [help, setHelp] = useState(false);
  const [suggest, setSuggest] = useState({ list: [], index: 0, kind: null });
  const [tick, setTick] = useState(0);
  const [offline, setOffline] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const [branch, setBranch] = useState(start.branch);
  const [catalogues, setCatalogues] = useState({});
  const printed = useRef(start.printed), runClock = useRef(start.view.activeRun ? { id: start.view.activeRun.id, at: Date.parse(start.view.activeRun.startedAt) || Date.now() } : null);
  const history = useRef(start.history), browsing = useRef(null), exitArmed = useRef(0), answered = useRef(new Set()), answeredHere = useRef(new Map()), dismissed = useRef(new Set());
  const projectRef = useRef(start.project), viewRef = useRef(start.view), overlayRef = useRef(null), noticeTimer = useRef(null);
  const syncing = useRef(false), again = useRef(false), scheduled = useRef(null), fileSearch = useRef(0);
  viewRef.current = view; projectRef.current = project;

  const roots = (project.folders || []).map(folder => folder.path);
  const q = () => `projectId=${encodeURIComponent(projectRef.current.id)}`;
  const route = action => `/api/conversations/${viewRef.current.id}/${action}?${q()}&limit=1`;
  const print = useCallback((lines, marginTop = 1) => { if (lines.length) setItems(list => [...list, { id: randomUUID(), lines, marginTop }]); }, []);
  const say = useCallback((text, ms = 4000) => { clearTimeout(noticeTimer.current); setNotice(text); if (ms) noticeTimer.current = setTimeout(() => setNotice(null), ms); }, []);
  const problem = useCallback(error => print([[{ text: '✗ ', color: 'red' }, { text: error.message || String(error), color: 'red' }]]), [print]);

  const catalogue = useCallback(async provider => {
    if (catalogues[provider]) return catalogues[provider];
    try { const { models = [] } = await engine.api.get(`/api/providers/${provider}/models?${q()}`); setCatalogues(all => ({ ...all, [provider]: models })); return models; }
    catch { return []; }
  }, [catalogues, engine]);
  useEffect(() => { catalogue(view.provider); }, [view.provider]);

  // The finished parts of the conversation go to the scrollback, in order, once.
  // Kept in a ref, so the event stream and timers below never restart when the window is resized.
  const applyRef = useRef(null);
  applyRef.current = next => {
    const activeRunId = next.activeRun?.id || null;
    const { ready } = settledMessages(next.messages || [], { printed: printed.current, activeRunId });
    for (const message of ready) {
      printed.current.add(message.id);
      if (message.role === 'user') { print(formatUser(message)); if (!history.current.includes(message.text)) history.current.push(message.text); }
      else if (message.role === 'assistant') print(formatMarkdown(message.text));
      // An approval answered in its box needs no second line; one denied, or answered in the window, still says so.
      else if (message.role === 'activity' && message.text === 'Approval allowed by the user.' && answeredHere.current.get(message.runId) > 0) { answeredHere.current.set(message.runId, answeredHere.current.get(message.runId) - 1); continue; }
      else if (message.role === 'activity') print(formatActivity(message, { roots, width }), message.toolOutcome || /^\$ |^File changes:/.test(message.text) || /^[A-Za-z_][\w.:-]*\n\{/.test(message.text) ? 1 : 0);
      else if (message.role === 'error' || message.role === 'notice') print(formatNotice(message, width));
    }
    // A run that ends says how, once.
    if (runClock.current && runClock.current.id !== activeRunId) {
      const ended = (next.runs || []).find(run => run.id === runClock.current.id) || (next.lastRun?.id === runClock.current.id ? next.lastRun : null);
      const took = formatElapsed(Date.now() - runClock.current.at);
      if (ended?.status === 'interrupted') print(one(`  ⎿ Stopped after ${took}`, { dim: true }));
      else if (ended && ended.status !== 'complete' && ended.status !== 'running') print([{ text: '  ⎿ ', dim: true }, { text: `Didn't finish after ${took}${ended.errorCategory === 'quota' ? ': the agent reached its usage limit. /handoff passes the task to another agent.' : '.'}`, color: 'yellow' }]);
      else print(one(`✻ Worked for ${took}`, { dim: true }));
      runClock.current = null;
      refreshBranch();
    }
    if (activeRunId && !runClock.current) runClock.current = { id: activeRunId, at: Date.parse(next.activeRun.startedAt) || Date.now() };
    // An approval, question or handoff offer asks in its own box; one answered in the app closes it here.
    const pending = (next.pendingApprovals || []).filter(item => !answered.current.has(item.id));
    const open = overlayRef.current;
    if (open && (open.type === 'approval' || open.type === 'question') && !pending.some(item => item.id === open.item.id)) { setOverlay(null); print(one('  ⎿ Answered in Codeshi', { dim: true }), 0); }
    else if (open?.type === 'handoff' && next.handoffOffer?.id !== open.offer.id) setOverlay(null);
    else if (!open || open.type === 'handoff') {
      const first = pending[0];
      if (first) setOverlay(first.kind === 'question' ? { type: 'question', item: first, step: 0, index: 0, answers: [], picked: [], typing: null } : { type: 'approval', item: first, index: 0 });
      else if (!open && next.handoffOffer && next.status === 'running' && !dismissed.current.has(next.handoffOffer.id)) setOverlay({ type: 'handoff', offer: next.handoffOffer, index: 0 });
    }
    if (next.retryOffer && !dismissed.current.has(`retry:${next.retryOffer.id}`)) { dismissed.current.add(`retry:${next.retryOffer.id}`); print(one(`! Codeshi offers to retry with ${agentName(next.retryOffer.provider)}. /open to answer it in the window.`, { color: 'yellow' })); }
    setView(next);
  };

  const sync = useRef(async () => {
    if (syncing.current) { again.current = true; return; }
    syncing.current = true;
    try {
      do { again.current = false; applyRef.current(await engine.api.get(`/api/conversation?${q()}&limit=80`)); } while (again.current);
      setOffline(null);
    } catch (error) { setOffline(error.code === EXIT.unavailable ? "Codeshi isn't running" : error.message); }
    finally { syncing.current = false; }
  }).current;
  const schedule = useRef(() => { if (!scheduled.current) scheduled.current = setTimeout(() => { scheduled.current = null; sync(); }, 60); }).current;

  function refreshBranch() { gitBranch(roots[0] || process.cwd()).then(setBranch); }

  // The engine says when anything changes; a slow timer covers a dropped stream.
  useEffect(() => {
    const controller = new AbortController(); let stopped = false;
    (async () => {
      while (!stopped) {
        await engine.api.events(update => { if (!update?.projectId || update.projectId === projectRef.current.id) schedule(); }, controller.signal);
        if (stopped) break;
        await sleep(1500); schedule();
      }
    })();
    const timer = setInterval(schedule, 2500);
    schedule();
    return () => { stopped = true; controller.abort(); clearInterval(timer); };
  }, [engine, schedule]);

  const running = view.status === 'running' || Boolean(view.activeRun);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setTick(value => value + 1), 150);
    return () => clearInterval(timer);
  }, [running]);

  // Reaching the engine again after the app quit: starts it in the background, as the session did at first.
  async function reconnect() {
    say('Starting Codeshi…', 0);
    const connection = await connect({ env: engine.env, say: () => {} });
    engine.api = client(connection, { fetchImpl: engine.fetchImpl });
    setOffline(null); say(null, 1); schedule();
  }
  const call = async (method, target, body) => {
    try { return await (method === 'get' ? engine.api.get(target) : engine.api.post(target, body)); }
    catch (error) {
      if (error.code !== EXIT.unavailable) throw error;
      await reconnect();
      return method === 'get' ? engine.api.get(target) : engine.api.post(target, body);
    }
  };
  const settle = async (method, target, body) => { try { const result = await call(method, target, body); schedule(); return result; } catch (error) { problem(error); return null; } };

  async function changeSettings(patch) {
    const current = viewRef.current;
    const body = { provider: current.provider, mode: current.mode, approvalPolicy: current.approvalPolicy || 'ask', ...patch };
    const next = await settle('post', route('provider'), body);
    if (next?.id) setView(next);
    return next;
  }

  // --- Commands --------------------------------------------------------------------------------------------------------
  async function command(text) {
    const [name, ...rest] = text.trim().split(/\s+/), argument = rest.join(' ');
    const current = viewRef.current;
    print(formatUser({ text }));
    switch (name) {
      case '/help': case '/?': {
        const pad = Math.max(...COMMANDS.map(([cmd]) => cmd.length)) + 2, keyPad = Math.max(...KEYS.map(([key]) => key.length)) + 2;
        print([plain('Commands', { bold: true }), ...COMMANDS.map(([cmd, about]) => [{ text: `  ${cmd.padEnd(pad)}`, color: ACCENT }, { text: about, dim: true }]), [], plain('Keys', { bold: true }), ...KEYS.map(([key, about]) => [{ text: `  ${key.padEnd(keyPad)}` }, { text: about, dim: true }])], 0);
        return;
      }
      case '/exit': case '/quit': leave(); return;
      case '/clear': onClear(); setItems([]); setStaticKey(key => key + 1); return;
      case '/stop': {
        const result = await settle('post', route('stop'));
        if (result && !result.stopped) print(one('  ⎿ Nothing is working.', { dim: true }), 0);
        return;
      }
      case '/continue': if (await settle('post', route('continue'), { requestId: `cli-${randomUUID()}` })) print(one('  ⎿ Continuing the last run', { dim: true }), 0); return;
      case '/open': if (await settle('post', '/api/window', { projectId: projectRef.current.id })) print(one(EMBEDDED ? '  ⎿ Showing the chat. This tab keeps running.' : '  ⎿ Opened in the Codeshi window', { dim: true }), 0); return;
      case '/agent': {
        const pick = async provider => { const next = await changeSettings({ provider }); if (next) print(one(`  ⎿ ${agentName(provider)} · ${modelName(await catalogue(provider), next.model)}`, { dim: true }), 0); };
        if (AGENTS.includes(argument.toLowerCase())) return pick(argument.toLowerCase());
        if (argument) { print(one('  ⎿ Choose codex, claude or gemini.', { color: 'yellow' }), 0); return; }
        setOverlay({ type: 'picker', title: 'Agent', index: Math.max(0, AGENTS.indexOf(current.provider)), choices: AGENTS.map(provider => ({ label: agentName(provider), value: provider, picked: provider === current.provider, description: engine.providers?.[provider]?.available === false ? 'not installed' : '' })), onPick: pick });
        return;
      }
      case '/model': {
        const models = (await catalogue(current.provider)).filter(model => !model.hidden);
        const pick = async model => { const next = await changeSettings({ model }); if (next) print(one(`  ⎿ ${agentName(next.provider)} · ${modelName(models, next.model)}`, { dim: true }), 0); };
        if (argument) return pick(argument);
        if (!models.length) { print(one(`  ⎿ ${agentName(current.provider)} didn't list its models. Name one: /model <id>`, { color: 'yellow' }), 0); return; }
        const id = model => model.value || model.id || model.model, chosen = current.model || defaultModelId(models);
        setOverlay({ type: 'picker', title: `${agentName(current.provider)} model`, index: Math.max(0, models.findIndex(model => id(model) === chosen)), choices: models.map(model => ({ label: model.displayName || id(model), value: id(model), picked: id(model) === chosen, description: model.description || '' })), onPick: pick });
        return;
      }
      case '/effort': {
        const models = await catalogue(current.provider), entry = models.find(model => [model.value, model.id, model.model].includes(current.model || defaultModelId(models))) || models[0];
        const levels = entry?.supportedEffortLevels || entry?.supportedReasoningEfforts?.map(level => level.reasoningEffort) || [];
        const pick = async effort => { const next = await changeSettings({ model: current.model, effort: effort === 'default' ? null : effort }); if (next) print(one(`  ⎿ Effort: ${next.effort || 'default'}`, { dim: true }), 0); };
        if (argument) return pick(argument);
        if (!levels.length) { print(one('  ⎿ This model has no effort settings.', { dim: true }), 0); return; }
        const choices = ['default', ...levels];
        setOverlay({ type: 'picker', title: 'Effort', index: Math.max(0, choices.indexOf(current.effort || 'default')), choices: choices.map(level => ({ label: level, value: level, picked: level === (current.effort || 'default') })), onPick: pick });
        return;
      }
      case '/access': {
        const pick = async step => { const next = await changeSettings(step); if (next) print(one(`  ⎿ ${accessLabel(next.mode, next.approvalPolicy)}`, { dim: true }), 0); };
        setOverlay({ type: 'picker', title: 'Access', index: 0, choices: ACCESS_STEPS.map(step => ({ label: accessLabel(step.mode, step.approvalPolicy), value: step, picked: step.mode === current.mode && (step.mode === 'read' || step.approvalPolicy === current.approvalPolicy) })), onPick: pick });
        return;
      }
      case '/handoff': {
        if (current.handoffOffer && running) { setOverlay({ type: 'handoff', offer: current.handoffOffer, index: 0 }); return; }
        const others = AGENTS.filter(provider => provider !== (current.lastRun?.provider || current.provider));
        const pick = async provider => { if (await settle('post', route('continue'), { provider, requestId: `cli-${randomUUID()}` })) print(one(`  ⎿ ${agentName(provider)} continues the task`, { dim: true }), 0); };
        if (running) { print(one('  ⎿ Stop the run first (esc), or wait for Codeshi to offer a handoff.', { color: 'yellow' }), 0); return; }
        if (!current.lastRun) { print(one('  ⎿ There is no task to hand off yet.', { dim: true }), 0); return; }
        if (AGENTS.includes(argument.toLowerCase())) return pick(argument.toLowerCase());
        setOverlay({ type: 'picker', title: 'Hand the task to', index: 0, choices: others.map(provider => ({ label: agentName(provider), value: provider })), onPick: pick });
        return;
      }
      case '/queue': {
        const queue = current.queue || [];
        print(queue.length ? queue.map((item, index) => [{ text: `  ${index + 1}. `, dim: true }, { text: (item.text || '').split('\n')[0] }, { text: `  ${agentName(item.provider)}`, dim: true }]) : one('  ⎿ Nothing is queued.', { dim: true }), 0);
        return;
      }
      case '/tasks': {
        const tasks = (await settle('get', `/api/tasks?${q()}`))?.tasks || [];
        print(tasks.length ? tasks.map(task => [{ text: `  ${task.status.padEnd(10)}`, color: task.status === 'running' ? ACCENT : undefined, dim: task.status !== 'running' }, { text: task.title }, { text: task.runningProvider || task.provider ? `  ${agentName(task.runningProvider || task.provider)}` : '', dim: true }]) : one('  ⎿ No tasks.', { dim: true }), 0);
        return;
      }
      case '/board': {
        const board = await settle('get', `/api/board?${q()}`);
        const cards = board?.cards || [];
        if (!cards.length) { print(one('  ⎿ The board is empty. Add cards with Board in the window.', { dim: true }), 0); return; }
        const columns = ['backlog', 'ready', 'doing', 'review', 'done'];
        print(columns.flatMap(column => { const list = cards.filter(card => card.column === column); return list.length ? [plain(`  ${column[0].toUpperCase()}${column.slice(1)} (${list.length})`, { bold: true }), ...list.map(card => [{ text: '    • ', dim: true }, { text: card.title }])] : []; }), 0);
        return;
      }
      case '/status': {
        const projects = await settle('get', '/api/projects') || [];
        print(projects.map(item => [{ text: item.id === projectRef.current.id ? '  * ' : '    ', color: ACCENT }, { text: item.name.padEnd(24) }, { text: item.runningConversationId ? 'working' : 'idle', color: item.runningConversationId ? ACCENT : undefined, dim: !item.runningConversationId }, { text: item.pendingApprovals ? ` · ${item.pendingApprovals} waiting for you` : '', color: 'yellow' }]), 0);
        return;
      }
      case '/workspace': {
        if (EMBEDDED) { print(one('  ⎿ This tab belongs to this workspace. Pick another in the sidebar; each has its own tab.', { dim: true }), 0); return; }
        const projects = await settle('get', '/api/projects') || [];
        const pick = async id => {
          const chosen = projects.find(item => item.id === id); if (!chosen) return;
          const next = await settle('get', `/api/conversation?projectId=${encodeURIComponent(id)}&limit=80`); if (!next) return;
          projectRef.current = chosen; setProject(chosen); viewRef.current = next;
          printed.current = new Set((next.messages || []).filter(message => message.runId !== next.activeRun?.id).map(message => message.id));
          runClock.current = next.activeRun ? { id: next.activeRun.id, at: Date.parse(next.activeRun.startedAt) || Date.now() } : null;
          print([[{ text: '── ', dim: true }, { text: chosen.name, bold: true }, { text: ` · ${shortPath(chosen.path)} ──`, dim: true }], ...recap(next, width)]);
          setView(next); schedule();
        };
        const match = argument && projects.find(item => item.name.toLowerCase() === argument.toLowerCase());
        if (match) return pick(match.id);
        setOverlay({ type: 'picker', title: 'Workspace', index: Math.max(0, projects.findIndex(item => item.id === projectRef.current.id)), choices: projects.map(item => ({ label: item.name, value: item.id, picked: item.id === projectRef.current.id, description: shortPath(item.path) })), onPick: pick });
        return;
      }
      default: print(one(`  ⎿ Unknown command ${name}. /help lists them.`, { color: 'yellow' }), 0);
    }
  }

  async function send(text) {
    const current = viewRef.current;
    if (history.current.at(-1) !== text) history.current.push(text);
    if (current.status === 'running') {
      // While a run works, a message joins it when the agent can take one, or else waits in the queue.
      if (current.canAddToRun) {
        const result = await settle('post', route('steer'), { text });
        if (result) { print(formatUser({ text })); print(one('  ⎿ Added to the run', { dim: true }), 0); return; }
      }
      const queued = await settle('post', route('queue'), { executionRevision: current.execution?.defaults?.revision ?? 0, action: 'add', text, provider: current.provider, model: current.model || null, effort: current.effort || null, mode: current.mode, approvalPolicy: current.approvalPolicy || 'ask' });
      if (queued) { print(formatUser({ text })); print(one('  ⎿ Queued for after this run', { dim: true }), 0); }
      return;
    }
    await settle('post', route('messages'), { text, requestId: `cli-${randomUUID()}` });
  }

  // Leaving takes the prompt away first, so the terminal is left with the conversation only.
  function leave() { onLeave(viewRef.current); setLeaving(true); setTimeout(() => exit(), 30); }

  // --- Typing -------------------------------------------------------------------------------------------------------------
  const setValue = (value, cursor = value.length) => { setInput({ value, cursor }); updateSuggestions(value, cursor); };
  function updateSuggestions(value, cursor) {
    if (/^\/\S*$/.test(value)) { const list = COMMANDS.filter(([cmd]) => cmd.startsWith(value)).map(([cmd, about]) => ({ label: cmd, insert: `${cmd} `, about })); setSuggest({ list, index: 0, kind: 'command' }); return; }
    const word = value.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
    if (word && word[1].length >= 2) {
      const ticket = ++fileSearch.current;
      engine.api.get(`/api/file-search?q=${encodeURIComponent(word[1])}`).then(({ files = [] }) => {
        if (ticket !== fileSearch.current) return;
        const list = files.filter(file => file.projectId === projectRef.current.id).slice(0, 8).map(file => ({ label: file.path, insert: `@${file.path} `, about: (projectRef.current.folders || []).length > 1 ? file.folderName : '', replace: word[1].length + 1 }));
        setSuggest({ list, index: 0, kind: 'file' });
      }).catch(() => {});
      return;
    }
    fileSearch.current++;
    setSuggest(state => state.list.length ? { list: [], index: 0, kind: null } : state);
  }
  function complete(choice) {
    const { value, cursor } = inputRef.current;
    if (suggest.kind === 'command') { setValue(choice.insert); return; }
    const before = value.slice(0, cursor - choice.replace), after = value.slice(cursor);
    setValue(before + choice.insert + after.replace(/^\s+/, ''), (before + choice.insert).length);
  }
  async function submit() {
    const text = inputRef.current.value.trim();
    if (!text) return;
    setValue(''); browsing.current = null;
    if (offline) { try { await reconnect(); } catch (error) { problem(error); return; } }
    if (text.startsWith('/') && !text.startsWith('//')) await command(text);
    else await send(text.startsWith('//') ? text.slice(1) : text);
  }

  usePaste(text => {
    if (overlayRef.current) return;
    const { value: before, cursor } = inputRef.current, pasted = text.replace(/\r\n?/g, '\n');
    setValue(before.slice(0, cursor) + pasted + before.slice(cursor), cursor + pasted.length);
  });

  useInput((key, info) => {
    if (overlayRef.current) { overlayKey(key, info); return; }
    if (help) { setHelp(false); if (!key || info.escape) return; }
    // Keys typed faster than they're read arrive together, Enter included; pasted text comes through usePaste instead.
    if (key && key.length > 1 && /[\r\n]/.test(key) && !info.ctrl && !info.meta) {
      const parts = key.split(/\r\n?|\n/);
      parts.forEach((part, index) => {
        if (part) { const now = inputRef.current; setValue(now.value.slice(0, now.cursor) + part + now.value.slice(now.cursor), now.cursor + part.length); }
        if (index < parts.length - 1) submit();
      });
      return;
    }
    const { value, cursor } = inputRef.current;
    if (info.ctrl && key === 'c') {
      if (value) { setValue(''); return; }
      if (Date.now() - exitArmed.current < 2000) { leave(); return; }
      exitArmed.current = Date.now(); say(running ? 'Press ctrl+c again to leave. The run carries on in Codeshi.' : 'Press ctrl+c again to leave.', 2000);
      return;
    }
    if (info.ctrl && key === 'd') { if (!value) leave(); return; }
    if (suggest.list.length) {
      if (info.upArrow) { setSuggest(state => ({ ...state, index: (state.index + state.list.length - 1) % state.list.length })); return; }
      if (info.downArrow) { setSuggest(state => ({ ...state, index: (state.index + 1) % state.list.length })); return; }
      if (info.tab) { complete(suggest.list[suggest.index]); return; }
      if (info.return && !(suggest.kind === 'command' && suggest.list[suggest.index].label === value.trim())) { complete(suggest.list[suggest.index]); return; }
      if (info.escape) { setSuggest({ list: [], index: 0, kind: null }); return; }
    }
    if (info.escape) {
      if (running) { settle('post', route('stop')); say('Stopping…', 2000); }
      else if (value) setValue('');
      return;
    }
    if (info.tab && info.shift) {
      const current = viewRef.current, step = nextAccess(current.mode, current.approvalPolicy);
      changeSettings(step).then(next => { if (next) say(`Access: ${accessLabel(next.mode, next.approvalPolicy)}`, 2500); });
      return;
    }
    if (info.return) {
      if (info.meta || info.shift) { setValue(value.slice(0, cursor) + '\n' + value.slice(cursor), cursor + 1); return; }
      if (value.slice(0, cursor).endsWith('\\')) { setValue(value.slice(0, cursor - 1) + '\n' + value.slice(cursor), cursor); return; }
      submit(); return;
    }
    const rows = value.split('\n'), rowOf = position => value.slice(0, position).split('\n').length - 1;
    if (info.upArrow || info.downArrow) {
      const row = rowOf(cursor);
      if (info.upArrow && row > 0) { const column = cursor - value.lastIndexOf('\n', cursor - 1) - 1, start = value.lastIndexOf('\n', cursor - 1), previous = value.lastIndexOf('\n', start - 1) + 1; setInput({ value, cursor: previous + Math.min(column, rows[row - 1].length) }); return; }
      if (info.downArrow && row < rows.length - 1) { const column = cursor - value.lastIndexOf('\n', cursor - 1) - 1, next = value.indexOf('\n', cursor) + 1; setInput({ value, cursor: next + Math.min(column, rows[row + 1].length) }); return; }
      const list = history.current; if (!list.length) return;
      if (browsing.current === null) { if (info.downArrow) return; browsing.current = { index: list.length, draft: value }; }
      const index = Math.max(0, Math.min(list.length, browsing.current.index + (info.upArrow ? -1 : 1)));
      browsing.current.index = index;
      setValue(index === list.length ? browsing.current.draft : list[index]);
      if (index === list.length) browsing.current = null;
      return;
    }
    if (info.leftArrow) { setInput({ value, cursor: info.meta || info.ctrl ? value.slice(0, cursor).search(/\S+\s*$/) === -1 ? 0 : value.slice(0, cursor).search(/\S+\s*$/) : Math.max(0, cursor - 1) }); return; }
    if (info.rightArrow) { const rest = value.slice(cursor).match(/^\s*\S+/); setInput({ value, cursor: info.meta || info.ctrl ? cursor + (rest ? rest[0].length : value.length - cursor) : Math.min(value.length, cursor + 1) }); return; }
    if (info.home || (info.ctrl && key === 'a')) { setInput({ value, cursor: value.lastIndexOf('\n', cursor - 1) + 1 }); return; }
    if (info.end || (info.ctrl && key === 'e')) { const end = value.indexOf('\n', cursor); setInput({ value, cursor: end === -1 ? value.length : end }); return; }
    if (info.ctrl && key === 'u') { const start = value.lastIndexOf('\n', cursor - 1) + 1; setValue(value.slice(0, start) + value.slice(cursor), start); return; }
    if (info.ctrl && key === 'k') { const end = value.indexOf('\n', cursor); setValue(value.slice(0, cursor) + value.slice(end === -1 ? value.length : end), cursor); return; }
    if ((info.ctrl && key === 'w') || (info.meta && (info.backspace || info.delete))) { const start = value.slice(0, cursor).search(/\S+\s*$/); const from = start === -1 ? 0 : start; setValue(value.slice(0, from) + value.slice(cursor), from); return; }
    if (info.backspace || info.delete) { if (cursor > 0) setValue(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1); return; }
    if (info.ctrl || info.meta || info.tab || !key) return;
    if (key === '?' && !value) { setHelp(true); return; }
    exitArmed.current = 0;
    setValue(value.slice(0, cursor) + key + value.slice(cursor), cursor + key.length);
  });

  // Keys while a box asks something.
  function overlayKey(key, info) {
    const open = overlayRef.current;
    const choices = overlayChoices(open);
    const move = delta => setOverlay({ ...open, index: (open.index + delta + choices.length) % choices.length });
    if (open.type === 'question' && open.typing !== null) {
      if (info.escape) { setOverlay({ ...open, typing: null }); return; }
      if (info.return) { if (open.typing.trim()) answerQuestion(open, [open.typing.trim()]); return; }
      if (info.backspace || info.delete) { setOverlay({ ...open, typing: open.typing.slice(0, -1) }); return; }
      if (!info.ctrl && !info.meta && key) setOverlay({ ...open, typing: open.typing + key });
      return;
    }
    if (info.ctrl && key === 'c') { if (open.type === 'picker') setOverlay(null); else say('Answer it first, or press esc.', 2000); return; }
    if (info.upArrow) { move(-1); return; }
    if (info.downArrow || info.tab) { move(1); return; }
    const number = /^[1-9]$/.test(key) ? Number(key) - 1 : null;
    if (open.type === 'approval' && (key === 'y' || key === 'n')) { choose(open, choices.findIndex(choice => choice.id === (key === 'y' ? 'yes' : 'no'))); return; }
    if (info.escape) { cancel(open); return; }
    if (open.type === 'question' && key === ' ' && open.item.questions[open.step].multiple) { toggle(open, open.index); return; }
    if (number !== null && number < choices.length) {
      if (open.type === 'question' && open.item.questions[open.step].multiple) toggle(open, number);
      else choose(open, number);
      return;
    }
    if (info.return) choose(open, open.index);
  }
  function overlayChoices(open) {
    if (!open) return [];
    if (open.type === 'picker') return open.choices;
    if (open.type === 'approval') return approvalChoices(open.item);
    if (open.type === 'handoff') {
      const charges = open.offer.to?.billingSource !== 'subscription';
      return [{ id: 'accept', label: charges ? `Hand off and accept ${open.offer.to?.billingSource === 'api' ? 'API charges' : 'possible charges'}` : 'Hand off' }, { id: 'dismiss', label: 'Not now', hint: 'esc' }];
    }
    const question = open.item.questions[open.step];
    return [...question.options.map(option => ({ label: option.label, description: option.description || '', picked: open.picked.includes(option.label) })), ...(question.other ? [{ label: 'Type something else', other: true }] : []), ...(question.multiple ? [{ label: 'Done', done: true }] : [])];
  }
  function toggle(open, index) {
    const choice = overlayChoices(open)[index];
    if (!choice || choice.other || choice.done) { choose(open, index); return; }
    const picked = open.picked.includes(choice.label) ? open.picked.filter(label => label !== choice.label) : [...open.picked, choice.label];
    setOverlay({ ...open, picked, index });
  }
  async function choose(open, index) {
    const choice = overlayChoices(open)[index];
    if (!choice) return;
    if (open.type === 'picker') { setOverlay(null); await open.onPick(choice.value); return; }
    if (open.type === 'approval') {
      answered.current.add(open.item.id); setOverlay(null);
      if (choice.id !== 'no') answeredHere.current.set(open.item.runId, (answeredHere.current.get(open.item.runId) || 0) + 1);
      await settle('post', route('approval'), { runId: open.item.runId, approvalId: open.item.id, allow: choice.id !== 'no', ...(choice.id === 'run' ? { remember: 'run' } : {}) });
      return;
    }
    if (open.type === 'handoff') {
      dismissed.current.add(open.offer.id); setOverlay(null);
      const accept = choice.id === 'accept';
      await settle('post', route('handoff'), accept ? { offerId: open.offer.id, accept: true, billingConfirmed: true, queueBillingConfirmed: false, queueDigest: open.offer.queue?.digest ?? null } : { offerId: open.offer.id, accept: false });
      if (accept) print(one(`  ⎿ Handed off to ${agentName(open.offer.to?.provider)}`, { dim: true }), 0);
      return;
    }
    if (choice.other) { setOverlay({ ...open, typing: '' }); return; }
    const question = open.item.questions[open.step];
    if (question.multiple) { if (choice.done) { if (open.picked.length) answerQuestion(open, open.picked); } else toggle(open, index); return; }
    answerQuestion(open, [choice.label]);
  }
  async function answerQuestion(open, values) {
    const answers = [...open.answers, values];
    if (answers.length < open.item.questions.length) { setOverlay({ ...open, step: open.step + 1, answers, picked: [], index: 0, typing: null }); return; }
    answered.current.add(open.item.id); setOverlay(null);
    await settle('post', route('answer'), { runId: open.item.runId, questionId: open.item.id, answers });
  }
  async function cancel(open) {
    if (open.type === 'picker') { setOverlay(null); return; }
    if (open.type === 'approval') { choose(open, overlayChoices(open).findIndex(choice => choice.id === 'no')); return; }
    if (open.type === 'handoff') { choose(open, 1); return; }
    answered.current.add(open.item.id); setOverlay(null);
    await settle('post', route('answer'), { runId: open.item.runId, questionId: open.item.id, skip: true });
    print(one('  ⎿ Skipped the questions', { dim: true }), 0);
  }

  // --- Drawing ------------------------------------------------------------------------------------------------------------
  const { live } = settledMessages(view.messages || [], { printed: printed.current, activeRunId: view.activeRun?.id || null });
  const liveLines = live.flatMap(message => {
    if (message.role === 'assistant') { const lines = formatMarkdown(message.text); return lines.length > 14 ? [plain('  …', { dim: true }), ...lines.slice(-14)] : lines; }
    if (message.role === 'activity') return formatActivity(message, { roots, width, pending: true });
    return [];
  });
  const agent = agentName(view.activeRun?.provider || view.provider);
  const waiting = (view.pendingApprovals || []).length > 0;
  const elapsed = runClock.current ? formatElapsed(Date.now() - runClock.current.at) : '';
  const models = catalogues[view.provider];
  const used = view.contextControl?.used;
  const status = [
    { text: project.name, bold: true },
    branch ? { text: ` ⎇ ${branch}`, dim: true } : null,
    { text: '  ·  ', dim: true }, { text: agentName(view.provider) }, { text: ` · ${modelName(models, view.model)}${view.effort ? ` · ${view.effort}` : ''}`, dim: true },
    { text: '  ·  ', dim: true }, { text: accessLabel(view.mode, view.approvalPolicy), color: view.mode === 'edit' && view.approvalPolicy === 'auto' ? 'yellow' : undefined, dim: !(view.mode === 'edit' && view.approvalPolicy === 'auto') },
    used ? { text: `  ·  ${formatTokens(used)} context`, dim: true } : null,
  ].filter(Boolean);
  const queued = (view.queue || []).length;

  let box = null;
  if (overlay?.type === 'approval') {
    const request = describeRequest(overlay.item, { roots, width: width - 8 });
    box = h(Panel, { title: request.title }, h(Lines, { lines: request.lines }), h(Box, { marginTop: 1 }, h(Text, null, request.question)), h(Choices, { choices: overlayChoices(overlay), index: overlay.index }));
  } else if (overlay?.type === 'question') {
    const question = overlay.item.questions[overlay.step], total = overlay.item.questions.length;
    box = h(Panel, { title: `${agentName(overlay.item.provider)} asks${total > 1 ? ` (${overlay.step + 1} of ${total})` : ''}${question.header ? ` · ${question.header}` : ''}` },
      h(Text, { wrap: 'wrap' }, question.question),
      h(Box, { marginTop: 1, flexDirection: 'column' }, h(Choices, { choices: overlayChoices(overlay), index: overlay.index })),
      overlay.typing !== null ? h(Box, { marginTop: 1 }, h(Text, null, h(Text, { color: ACCENT }, '› '), overlay.typing, h(Text, { inverse: true }, ' '))) : null,
      h(Text, { dimColor: true }, question.multiple ? 'space or a number picks · enter on Done sends · esc skips' : 'enter chooses · esc skips the questions'));
  } else if (overlay?.type === 'handoff') {
    const offer = overlay.offer, model = offer.to?.model ? ` · ${modelName(catalogues[offer.to.provider], offer.to.model)}` : '';
    box = h(Panel, { title: `${agentName(offer.from?.provider)} has used ${Math.round(offer.from?.usedPercent || 0)}% of its ${offer.from?.window ? `${offer.from.window} ` : ''}limit`, color: 'yellow' },
      h(Text, { wrap: 'wrap' }, `Hand off to ${agentName(offer.to?.provider)}${model} to continue${offer.task ? ` “${offer.task.replace(/[.!?]+$/, '')}”` : ' this task'}. ${offer.to?.mode === 'read' ? 'Read only' : 'Can edit files'}.`),
      h(Box, { marginTop: 1 }, h(Choices, { choices: overlayChoices(overlay), index: overlay.index })));
  } else if (overlay?.type === 'picker') {
    box = h(Panel, { title: overlay.title }, h(Choices, { choices: overlay.choices, index: overlay.index }), h(Text, { dimColor: true }, 'enter chooses · esc closes'));
  }

  const scrollback = h(Static, { key: staticKey, items }, item => h(Lines, { key: item.id, lines: item.lines, marginTop: item.marginTop ?? 1, width: columns || 80 }));
  if (leaving) return h(Box, { flexDirection: 'column' }, scrollback);
  return h(Box, { flexDirection: 'column' },
    scrollback,
    liveLines.length ? h(Lines, { lines: liveLines, marginTop: 1 }) : null,
    running ? h(Box, { marginTop: 1 }, h(Text, null,
      h(Text, { color: ACCENT }, `${SPINNER[tick % SPINNER.length]} `),
      h(Text, { color: ACCENT }, waiting ? `${agent} is waiting for you…` : `${agent} is working…`),
      h(Text, { dimColor: true }, ` (${elapsed}${waiting ? '' : ' · esc to stop'})`))) : null,
    box,
    box ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, marginTop: 1 },
      h(Editor, { value: input.value, cursor: input.cursor, prefixColor: ACCENT, placeholder: running ? 'Add to the run, or queue a message' : `Ask ${agentName(view.provider)}, or type / for commands` })),
    !box && suggest.list.length ? h(Box, { flexDirection: 'column', paddingX: 2 }, ...suggest.list.map((choice, index) => h(Text, { key: choice.label, wrap: 'truncate-end' },
      h(Text, { color: index === suggest.index ? ACCENT : undefined, bold: index === suggest.index }, (suggest.kind === 'command' ? choice.label.padEnd(12) : choice.label)),
      choice.about ? h(Text, { dimColor: true }, `  ${choice.about}`) : null))) : null,
    !box && help ? h(Box, { flexDirection: 'column', paddingX: 2 }, ...KEYS.map(([keys, about]) => h(Text, { key: keys }, h(Text, null, keys.padEnd(22)), h(Text, { dimColor: true }, about))), h(Text, { dimColor: true }, '/help lists the commands')) : null,
    offline || notice ? h(Box, { paddingX: 2 }, h(Text, { color: offline ? 'red' : 'yellow', wrap: 'truncate-end' }, offline ? `${offline} · press enter to start it` : notice))
      : h(Box, { paddingX: 2, justifyContent: 'space-between' },
        h(Box, { flexShrink: 0, marginRight: 2 }, h(Text, { dimColor: true }, queued ? `${queued} queued · /queue` : '? for shortcuts')),
        h(Box, { flexShrink: 1 }, h(Text, { wrap: 'truncate-start' }, ...status.map((part, index) => h(Text, { key: index, color: part.color, dimColor: part.dim, bold: part.bold }, part.text))))));
}

// A few lines from earlier in the conversation, so the session doesn't start blank in the middle of a task.
function recap(view, width = 100) {
  const earlier = (view.messages || []).filter(message => message.runId !== view.activeRun?.id && (message.role === 'user' || (message.role === 'assistant' && message.status !== 'streaming')));
  if (!earlier.length) return [];
  const shown = earlier.slice(-4), hidden = (view.messageCount || earlier.length) - shown.length;
  const clip = text => { const line = (String(text || '').split('\n').find(part => part.trim()) || '').replace(/\*\*|`/g, ''); return line.length > width ? `${line.slice(0, width - 1)}…` : line; };
  return [
    [{ text: `Earlier in this conversation${hidden > 0 ? ` (${hidden} more in the window: /open)` : ''}`, dim: true }],
    ...shown.map(message => message.role === 'user' ? [{ text: '› ', color: ACCENT, dim: true }, { text: clip(message.text), dim: true }] : [{ text: '● ', dim: true }, { text: clip(message.text), dim: true }]),
  ];
}

// This folder isn't in a workspace: offer to add it, as opening a folder in the app would.
async function chooseOrAdd(api, projects, { name, cwd, stdin, stderr }) {
  try { return chooseWorkspace(projects, { name, cwd }); }
  catch (error) {
    if (name || !(error instanceof CliError)) throw error;
    const prompt = readline.createInterface({ input: stdin, output: stderr, terminal: true });
    let answer;
    try { answer = (await prompt.question(`${cwd} isn't a Codeshi workspace yet. Add it? (Y/n) `)).trim().toLowerCase(); } finally { prompt.close(); }
    if (answer && !['y', 'yes'].includes(answer)) throw new CliError('Choose a workspace with --workspace, or run codeshi in a workspace folder.', EXIT.usage);
    return api.post('/api/projects', { path: cwd });
  }
}

export async function session({ options, env, cwd, version, fetchImpl, stdin, stdout, stderr }) {
  const say = line => stderr.write(`${line}\n`);
  const engine = { env, fetchImpl, api: client(await connect({ env, say }), { fetchImpl }) };
  const projects = await engine.api.get('/api/projects');
  const project = await chooseOrAdd(engine.api, projects, { name: options.workspace, cwd, stdin, stderr });
  const q = `projectId=${encodeURIComponent(project.id)}`;
  let view = await engine.api.get(`/api/conversation?${q}&limit=80`);
  // --agent, --model and --effort choose for the conversation, as the picker in the window does.
  if (options.agent || options.model || options.effort) {
    if (view.status === 'running') say('An agent is working, so --agent, --model and --effort wait until you change them with /agent, /model or /effort.');
    else view = await engine.api.post(`/api/conversations/${view.id}/provider?${q}&limit=80`, { provider: options.agent || view.provider, mode: view.mode, approvalPolicy: view.approvalPolicy || 'ask', ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) });
  }
  try { engine.providers = (await engine.api.get(`/api/status?${q}`)).providers; } catch { engine.providers = null; }
  const branch = await gitBranch(project.folders?.[0]?.path || project.path);
  const banner = [{ id: 'banner', marginTop: 0, lines: [
    [{ text: ' シ ', inverse: true, color: ACCENT, bold: true }, { text: '  Codeshi', bold: true }, { text: ` ${version}`, dim: true }],
    [{ text: '     ' }, { text: project.name }, { text: ` · ${shortPath(project.path)}`, dim: true }],
    [{ text: '     ' }, { text: EMBEDDED ? '/help for commands · /open shows the chat · esc stops a run' : '/help for commands · /open shows the window · esc stops a run', dim: true }],
  ] }];
  const earlier = recap(view, Math.max(40, (stdout.columns || 80) - 4));
  if (earlier.length) banner.push({ id: 'recap', marginTop: 1, lines: earlier });
  const printed = new Set((view.messages || []).filter(message => message.runId !== view.activeRun?.id || !view.activeRun).map(message => message.id));
  const history = (view.messages || []).filter(message => message.role === 'user').map(message => message.text);
  stdout.write(`\x1b]0;codeshi · ${project.name}\x07`);
  let last = view;
  const instance = render(h(Session, {
    engine, start: { project, view, banner, printed, history, branch },
    onClear: () => { instance.clear(); stdout.write('\x1b[2J\x1b[3J\x1b[H'); },
    onLeave: current => { last = current; },
  }), { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false, incrementalRendering: true, kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] } });
  await instance.waitUntilExit();
  stdout.write('\x1b]0;\x07');
  if (last?.status === 'running') say(`${agentName(last.activeRun?.provider || last.provider)} is still working in Codeshi. codeshi brings you back; codeshi stop stops it.`);
  return EXIT.ok;
}


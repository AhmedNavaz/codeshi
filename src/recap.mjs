import { workspaceGit } from './workspace-git.mjs';

// "While you were away" (#22): what ran, what changed and what is waiting, across every open workspace since a given
// time. It is put together from what Codeshi recorded, with no agent call: each conversation keeps a short run
// history (src/broker.mjs), each run's steps say which files it changed and which commands it ran, and its last reply
// says what it came to (#202).
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export const TESTS = /\b(?:test|tests|jest|vitest|pytest|mocha|rspec|go test|cargo test)\b/;

// The files a run changed and the commands it ran, read from its recorded steps.
export function runSteps(messages) {
  const files = new Set(); let commands = 0, tests = false;
  for (const message of messages) {
    if (message.role !== 'activity') continue;
    const text = String(message.text || '');
    if (text.startsWith('File changes:')) {
      try { for (const change of JSON.parse(text.slice('File changes:'.length))) if (change?.path || change?.file) files.add(String(change.path || change.file)); } catch { /* A step that can't be read adds nothing. */ }
      continue;
    }
    if (text.startsWith('$ ')) { commands++; if (TESTS.test(text.split('\n')[0])) tests = true; continue; }
    const tool = text.match(/^([A-Za-z_][\w-]*)\n(\{.*\})/);
    if (!tool) continue;
    let input = {}; try { input = JSON.parse(tool[2]); } catch { continue; }
    if (['Edit', 'MultiEdit', 'Write', 'edit_file', 'write_file', 'NotebookEdit'].includes(tool[1]) && (input.file_path || input.path)) files.add(String(input.file_path || input.path));
    if (tool[1] === 'Bash') { commands++; if (TESTS.test(String(input.command || ''))) tests = true; }
  }
  return { files: [...files], commands, tests };
}

// The first line of a prompt, short enough to read in a sentence.
const brief = text => { const line = String(text || '').trim().split('\n')[0]; return line.length > 90 ? line.slice(0, 90).replace(/\s+\S*$/, '') + '…' : line; };

// What a run came to, in the agent's own words (#202): the opening of its last reply, where agents usually say what they
// did ("Fixed the login redirect; the tests pass."). No model is asked. Code, headings and tables are skipped, Markdown is
// read as plain text, and a bare opener such as "Done." takes the sentence after it too.
const FILLER = /^(?:done|all done|all set|ok(?:ay)?|great|perfect|finished|sure|got it)\b[\s!.,:—–-]*$/i;
export function outcomeOf(reply, size = 180) {
  const lines = [];
  let fenced = false;
  for (const raw of String(reply || '').split('\n')) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (!line) { if (lines.length) break; continue; }
    if (/^#{1,6}\s/.test(line) || /^\|/.test(line) || /^[-*_]{3,}$/.test(line) || /^>/.test(line)) { if (lines.length) break; continue; }
    lines.push(line.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
  }
  const plain = lines.join(' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2').replace(/(?<![\w*])\*(\S(?:.*?\S)?)\*(?![\w*])/g, '$1').replace(/`/g, '').replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  const sentences = plain.split(/(?<=[.!?])\s+/).filter(Boolean);
  let text = sentences[0];
  if (FILLER.test(text) && sentences[1]) text = sentences[1];
  else if (text.length < 40 && sentences[1] && text.length + sentences[1].length < size) text = `${text} ${sentences[1]}`;
  return text.length > size ? `${text.slice(0, size - 1).replace(/\s+\S*$/, '')}…` : text;
}
// The outcome of the last of the given runs that replied.
const lastOutcome = (messages, runIds) => outcomeOf(messages.findLast(message => message.role === 'assistant' && runIds.has(message.runId) && String(message.text || '').trim())?.text);

// Tasks beside the main conversation (#88): the ones working, waiting on you, or ended since the recap starts. A plan's
// steps (#89) fold into one line for the plan. Merging, keeping and discarding are your own actions, so they're left out.
const QUIET = new Set(['integrated', 'kept', 'discarded', 'cancelled', 'detached', 'lost']);
function taskRecap(broker, c, from, running) {
  const tasks = [], plans = new Map();
  for (const task of c.parallelTasks || []) {
    if (task.closed || QUIET.has(task.status) || ['project-review', 'plan-chat'].includes(task.purpose)) continue;
    const lane = broker.tasks?.lanes?.get(task.id), approvals = lane?.broker?.pendingCount?.() || 0;
    const ended = Date.parse(task.endedAt || '') >= from, check = task.stepCheck?.status || null;
    const working = task.status === 'running' || running.has(task.id);
    if (!working && !approvals && !ended && check !== 'failed') continue;
    let files = [], outcome = '';
    if (lane?.c) {
      const runs = new Set((lane.c.runs || []).filter(run => Date.parse(run.endedAt || run.startedAt) >= from || run.id === lane.c.activeRun?.id).map(run => run.id));
      files = runSteps(lane.c.messages.filter(message => runs.has(message.runId))).files;
      if (!working && task.status === 'complete') outcome = lastOutcome(lane.c.messages, runs);
    }
    const entry = { id: task.id, title: brief(task.title), folder: task.folderName, provider: task.provider, status: working ? 'running' : task.status, approvals, files: files.slice(0, 20), fileCount: files.length, unmerged: task.mode === 'worktree' && task.status === 'complete', check, outcome };
    if (!task.plan) { tasks.push(entry); continue; }
    const plan = (c.orchestrations || []).find(item => item.id === task.plan.id);
    if (!plans.has(task.plan.id)) {
      const all = (c.parallelTasks || []).filter(item => item.plan?.id === task.plan.id && item.status !== 'cancelled');
      plans.set(task.plan.id, { id: task.plan.id, goal: brief(plan?.goal || plan?.title || 'A plan'), total: all.length, done: all.filter(item => ['complete', 'integrated', 'kept'].includes(item.status)).length, steps: [] });
    }
    plans.get(task.plan.id).steps.push({ ...entry, number: task.plan.number });
  }
  return { tasks, plans: [...plans.values()] };
}

export function buildRecap({ registry, since, now = new Date(), git = workspaceGit }) {
  const from = Date.parse(since);
  if (!Number.isFinite(from) || from > now.getTime()) fail('Give the time the recap starts from.');
  const workspaces = [];
  for (const project of registry.list()) {
    const broker = registry.brokers.get(project.id)?.broker;
    const c = project.conversationId ? broker?.conversations.get(project.conversationId) : null;
    if (!c) continue;
    const running = c.activeRun?.id && !c.activeRun.reviewId ? c.activeRun.id : null;
    const runs = (c.runs || []).filter(run => run.id === running || Date.parse(run.endedAt || run.startedAt) >= from).map(run => {
      const steps = runSteps(c.messages.filter(message => message.runId === run.id)), status = run.id === running ? 'running' : run.status;
      return { id: run.id, provider: run.provider, local: run.local, prompt: brief(run.prompt), status, errorCategory: run.errorCategory, startedAt: run.startedAt, endedAt: run.endedAt, files: steps.files.slice(0, 20), fileCount: steps.files.length, commands: steps.commands, tests: steps.tests, outcome: status === 'complete' ? lastOutcome(c.messages, new Set([run.id])) : '' };
    });
    const approvals = broker.running?.c.id === c.id ? broker.running.approvals.size : 0;
    const resume = c.resume ? { ...c.resume, ...broker.resume?.view?.(c) } : null;
    const resets = resume ? Object.values(resume.agents || {}).map(agent => agent?.resetsAt).filter(Boolean).sort()[0] || null : null;
    const waiting = resume ? { providers: resume.providers || [], resetsAt: resets } : null;
    const queue = c.queue?.length ? { count: c.queue.length, paused: Boolean(c.queuePaused) } : null;
    const handoff = c.handoffOffer ? { from: c.handoffOffer.from?.provider || null, to: c.handoffOffer.to?.provider || null } : null;
    const { tasks, plans } = taskRecap(broker, c, from, new Set([...(broker.tasks?.lanes?.values() || [])].filter(lane => lane.broker?.running).map(lane => lane.task?.id)));
    // Scheduled runs that didn't start (#132) wait for you until you run or dismiss them.
    const missed = broker.schedules?.missed(c) || [];
    if (!runs.length && !approvals && !waiting && !handoff && !tasks.length && !plans.length && !missed.length) continue;
    // Uncommitted files, for workspaces where something ran; reads only, with Git hooks and filters off.
    let uncommitted = null;
    if (runs.length || tasks.length || plans.length) { try { uncommitted = git(project.folders).repositories.reduce((sum, repo) => sum + (repo.available ? repo.totalChanges || 0 : 0), 0); } catch { uncommitted = null; } }
    workspaces.push({ projectId: project.id, name: project.name, runs, tasks, plans, approvals, waiting, queue, handoff, missed, uncommitted });
  }
  return { since: new Date(from).toISOString(), until: now.toISOString(), workspaces };
}

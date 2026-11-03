import { workspaceGit } from './workspace-git.mjs';

// "While you were away" (#22): what ran, what changed and what is waiting, across every open workspace since a given
// time. It is put together from what Codeshi recorded, with no agent call: each conversation keeps a short run
// history (src/broker.mjs), and each run's steps say which files it changed and which commands it ran.
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
      const steps = runSteps(c.messages.filter(message => message.runId === run.id));
      return { id: run.id, provider: run.provider, local: run.local, prompt: brief(run.prompt), status: run.id === running ? 'running' : run.status, errorCategory: run.errorCategory, startedAt: run.startedAt, endedAt: run.endedAt, files: steps.files.slice(0, 20), fileCount: steps.files.length, commands: steps.commands, tests: steps.tests };
    });
    const approvals = broker.running?.c.id === c.id ? broker.running.approvals.size : 0;
    const resume = c.resume ? { ...c.resume, ...broker.resume?.view?.(c) } : null;
    const resets = resume ? Object.values(resume.agents || {}).map(agent => agent?.resetsAt).filter(Boolean).sort()[0] || null : null;
    const waiting = resume ? { providers: resume.providers || [], resetsAt: resets } : null;
    const queue = c.queue?.length ? { count: c.queue.length, paused: Boolean(c.queuePaused) } : null;
    const handoff = c.handoffOffer ? { from: c.handoffOffer.from?.provider || null, to: c.handoffOffer.to?.provider || null } : null;
    if (!runs.length && !approvals && !waiting && !handoff) continue;
    // Uncommitted files, for workspaces where something ran; reads only, with Git hooks and filters off.
    let uncommitted = null;
    if (runs.length) { try { uncommitted = git(project.folders).repositories.reduce((sum, repo) => sum + (repo.available ? repo.totalChanges || 0 : 0), 0); } catch { uncommitted = null; } }
    workspaces.push({ projectId: project.id, name: project.name, runs, approvals, waiting, queue, handoff, uncommitted });
  }
  return { since: new Date(from).toISOString(), until: now.toISOString(), workspaces };
}

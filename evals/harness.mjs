import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Broker } from '../src/broker.mjs';
import { continuationRequest, prepareContext } from '../src/context.mjs';
import { providerUsage } from '../src/providers.mjs';
import { STARTER_ROOT } from '../src/skills.mjs';
import { sumUsage } from '../src/task-ledger.mjs';
import { validateContextLimit } from '../src/context-rollover.mjs';
import { checkPin, comparisonKey, experimentInputs, fingerprint, observedModels, validatePin } from './experiment.mjs';

// Runs one fixture under one policy and reports what happened (#84). Everything happens in a throwaway copy of the fixture.
// Live runs use the person's own agents and allowance, so they need a stated budget and stop when it is spent. Recorded runs
// replay a trace through the real broker, for CI. Nothing is sent anywhere: results are local files, holding no prompts.
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXED_DATE = '2026-01-01T00:00:00Z';
export const RUN_LIMIT_MS = 300000;
const gitIn = (cwd, args) => spawnSync('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE } });

// Writes a fixture's folders and commits them with fixed dates, so the same fixture is always the same commit.
function pinnedFolders(root, fixture) {
  const folders = {}, snapshot = {};
  for (const [name, files] of Object.entries(fixture.folders)) {
    const folder = path.join(root, name); fs.mkdirSync(folder, { recursive: true });
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, file), content);
    gitIn(folder, ['init', '-q']); gitIn(folder, ['add', '.']); gitIn(folder, ['commit', '-qm', 'Fixture']);
    folders[name] = fs.realpathSync(folder);
    snapshot[name] = gitIn(folder, ['rev-parse', 'HEAD']).stdout.trim();
  }
  return { folders, snapshot };
}

function runCheck(fixture, folders, replies) {
  const results = [];
  if (fixture.checkReply) results.push({ command: `last reply matches ${fixture.checkReply}`, passed: fixture.checkReply.test(replies.at(-1) || '') });
  for (const [name, files] of Object.entries(fixture.check || {})) {
    const directory = path.join(folders[name], '.eval-check'); fs.mkdirSync(directory, { recursive: true });
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), content);
    const result = spawnSync(process.execPath, ['--test', ...Object.keys(files).map(file => path.join(directory, file))], { cwd: folders[name], encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH } });
    results.push({ folder: name, command: `node --test .eval-check`, passed: result.status === 0, exitCode: result.status });
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return { passed: results.every(result => result.passed), results };
}

// File paths an agent read that an earlier run had already read. This is observed read activity, not all filesystem I/O.
export function repeatedFileReads(messages, { workspace = null } = {}) {
  const byRun = new Map(), target = text => { const value = String(text || ''); if (value.startsWith('Read\n')) { try { return JSON.parse(value.split('\n')[1]).file_path; } catch { return null; } } return value.match(/^\$ (?:\/bin\/\w+ -\w+ )?['"]?(?:cat|sed -n \S+|head(?: -\S+ \S+)?|tail(?: -\S+ \S+)?|nl(?: -\S+ \S+)?) ([^\s'"|;&]+)/)?.[1] || null; };
  for (const message of messages) { if (message.role !== 'activity' || !message.runId) continue; const file = target(message.text); if (!file) continue; if (!byRun.has(message.runId)) byRun.set(message.runId, new Set()); byRun.get(message.runId).add(workspace ? path.resolve(workspace, file) : path.normalize(file)); }
  const seen = new Set(); let repeated = 0;
  for (const files of byRun.values()) { for (const file of files) if (seen.has(file)) repeated++; for (const file of files) seen.add(file); }
  return repeated;
}

const describeAgent = text => { const [provider, model, effort] = String(text).split(':'); return { provider, model: model || null, effort: effort || null }; };
export const parsePolicy = ({ agent, to = null, context = 'task', skills = true, skill = null, limits = null, threads = 'continuous', contextLimit = 'off' }) => {
  if (!['continuous', 'separate'].includes(threads)) throw new Error('Choose continuous or separate task threads.');
  contextLimit = validateContextLimit(contextLimit);
  return { builder: describeAgent(agent), to: to ? describeAgent(to) : null, context, skills, skill, limits, threads, contextLimit,
    id: [agent, to && `to-${to}`, context, threads === 'separate' && 'separate-threads', contextLimit !== 'off' && `context-limit-${contextLimit}`, skills ? null : 'no-skills', skill && `skill-${skill}`, limits && `limits-${JSON.stringify(limits)}`].filter(Boolean).join(' ') };
};

// Includes each skill's text, so a changed skill counts as a different experiment.
const sameFixture = fixture => fingerprint({ ...fixture, checkReply: fixture.checkReply && { source: fixture.checkReply.source, flags: fixture.checkReply.flags }, history: fixture.history?.toString(), trace: undefined });

// budget is shared across a whole evaluation: { maxRuns, maxTokens, runs, tokens }.
export async function runFixture(fixture, policy, { live = false, budget, stateDir = null, runLimitMs = RUN_LIMIT_MS, pin = null } = {}) {
  if (live && !(Number.isSafeInteger(budget?.maxRuns) && budget.maxRuns > 0)) throw new Error('A live evaluation runs on your own accounts and needs a stated budget with a positive, finite number of runs.');
  if (pin) validatePin(pin);
  const began = performance.now();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(stateDir || os.tmpdir(), 'codeshi-eval-')));
  const { folders, snapshot } = pinnedFolders(path.join(root, 'work'), fixture), names = Object.keys(folders);
  const workspaceFolders = names.map(name => ({ id: createHash('sha256').update(name).digest('hex').slice(0, 16), name, displayName: name, path: folders[name] }));
  const bins = {};
  if (!live) {
    const trace = path.join(root, 'trace.json'), wrapper = path.join(root, 'agent.mjs');
    fs.writeFileSync(trace, JSON.stringify(fixture.trace));
    fs.writeFileSync(wrapper, `#!${process.execPath}\nprocess.env.EVAL_TRACE=${JSON.stringify(trace)};process.env.EVAL_STATE=${JSON.stringify(path.join(root, 'trace.state'))};process.env.EVAL_FOLDERS=${JSON.stringify(JSON.stringify(folders))};\nawait import(${JSON.stringify(pathToFileURL(path.join(here, 'fake-agent.mjs')).href)});\n`, { mode: 0o700 });
    bins.codex = wrapper; bins.claude = wrapper; bins.gemini = path.join(root, 'not-installed');
  }
  const broker = new Broker({ workspace: folders[names[0]], workspaceFolders, dataDir: path.join(root, 'data'), bins, contextPolicy: policy.context, contextLimit: () => policy.contextLimit || 'off', handoffPreferences: () => ({ threshold: 0, automatic: false }) });
  let c = broker.get(broker.create().id);
  const conversations = [c], run = { fixture: fixture.id, fixtureHash: sameFixture(fixture), snapshot, policy, live, sourceCommit: gitIn(here, ['rev-parse', 'HEAD']).stdout.trim() || null, startedAt: new Date().toISOString(), skipped: null, rubric: { criteria: fixture.rubric, verdict: null } };
  const quota = async phase => { if (!live) return null; const readings = {}; for (const provider of new Set([policy.builder.provider, policy.to?.provider].filter(Boolean))) { try { const usage = await providerUsage(provider, { ...broker.usageOptions(provider), refresh: true }); readings[provider] = usage.available ? { observedAt: new Date().toISOString(), windows: usage.windows.map(({ label, usedPercent, resetsAt }) => ({ label, usedPercent, resetsAt })) } : { unavailable: usage.reason || true }; } catch { readings[provider] = { unavailable: true }; } } return { phase, note: 'Account-wide: other tools count here too, so this is not what the task used.', readings }; };
  const spent = () => budget && (budget.runs >= budget.maxRuns || (budget.maxTokens && budget.tokens >= budget.maxTokens));
  const start = async (agent, text, { fresh = false, stopAfterFirstEdit = false, mode = 'edit' } = {}) => {
    if (spent()) { run.skipped = 'budget'; return false; }
    if (budget) budget.runs++;
    broker.start(c, { text, provider: agent.provider, ...(live ? {} : { transport: agent.provider === 'claude' ? 'cli' : 'app-server' }), model: agent.model, effort: agent.effort, mode, approvalPolicy: mode === 'read' ? 'ask' : 'auto', fresh, requestId: `eval-${Date.now()}-${budget?.runs ?? Math.random().toString(36).slice(2)}` });
    const active = broker.running;
    // Nobody is here to answer. A question is skipped and counted, since needing to ask is part of the result, and a request
    // for approval is declined. A run that goes past the time limit is stopped rather than waited for.
    const unattended = () => { for (const pending of [...active.approvals.values()]) { try { if (pending.kind === 'question') { run.questionsAsked = (run.questionsAsked || 0) + 1; broker.answer(active.id, pending.id, null); } else broker.approve(active.id, pending.id, false); } catch { /* It has just been answered. */ } } };
    broker.on('update', unattended);
    const limit = setTimeout(() => { run.timedOut = true; if (broker.running === active) broker.stop(c.id); }, runLimitMs);
    active.done.finally(() => { clearTimeout(limit); broker.off('update', unattended); });
    if (stopAfterFirstEdit) {
      // Stop ends the agent at once, and a usage line it has just written can be lost on the way. So a turn that reports
      // usage is stopped only once that usage is recorded, or after three seconds without it, and polling stands in for
      // update events, which are throttled.
      const edited = () => c.messages.some(message => message.runId === active.id && message.role === 'activity' && /^(File changes|Edit\n|Write\n)/.test(message.text));
      let editedAt = null;
      const poll = setInterval(() => {
        if (broker.running !== active || !edited()) return;
        editedAt ||= Date.now();
        if (stopAfterFirstEdit !== 'after-usage' || c.activeRun?.usageMeasured || Date.now() - editedAt > 3000) { clearInterval(poll); broker.stop(c.id); }
      }, 20);
      try { await active.done; } finally { clearInterval(poll); }
    } else await active.done;
    return true;
  };
  try {
    for (const message of fixture.history?.(folders) || []) broker.message(c, message.role, message.text, policy.builder.provider);
    for (const entry of fixture.memory || []) broker.changeMemory(c, { action: 'add', ...entry });
    if (policy.limits) broker.budget.setPolicy(c, policy.limits);
    // Skills are copied into place, so a run's own edits can't reach them and the fixture's folder stays clean.
    if (policy.skills) for (const [name, text] of Object.entries(fixture.skills || {})) {
      const directory = path.join(root, 'skills', name); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'SKILL.md'), text);
      broker.skills.change(c, { action: 'add-folder', path: path.join(root, 'skills') });
      broker.skills.change(c, { action: 'enable', path: directory });
    }
    if (policy.skill) broker.skills.change(c, { action: 'enable', path: path.join(STARTER_ROOT, policy.skill) });
    run.experiment = experimentInputs({ fixture, fixtureHash: run.fixtureHash, snapshot, policy, live, skills: (c.skills || []).filter(skill => skill.enabled), runLimitMs });
    if (pin) checkPin(pin, run.experiment);
    run.quotaBefore = await quota('before');
    if (fixture.facts) {
      const prepared = prepareContext(c, fixture.continues ? continuationRequest : fixture.prompt, { workspace: folders[names[0]], workspaceFolders, fresh: true, provider: policy.builder.provider, mode: 'edit', policy: policy.context, readAttachment: () => ({ text: '' }), includeImages: false });
      const prompt = prepared.prompt;
      run.context = { bytes: prepared.metadata.bytes, factsKept: fixture.facts.filter(fact => prompt.includes(fact)).length, factsTotal: fixture.facts.length, unrelatedSteps: fixture.leakMarker ? prompt.split(fixture.leakMarker).length - 1 : 0 };
    }
    if (fixture.turns) {
      run.turns = [];
      for (const [index, turn] of fixture.turns.entries()) {
        if (spent()) { run.skipped = 'budget'; break; }
        if (index && policy.threads === 'separate') {
          c = broker.get(broker.create().id); conversations.push(c);
          // Independent threads receive the same enabled procedures and limits, with the fixture's explicit standalone
          // brief supplying prior decisions. They share the identical working files and hidden final acceptance checks.
          const original = conversations[0];
          if (original.skills?.length) broker.record(c, { type: 'skills', skills: original.skills, dirs: original.skillDirs || [] });
          for (const entry of original.memory || []) broker.record(c, { type: 'memory_add', entry });
          if (policy.limits) broker.budget.setPolicy(c, policy.limits);
        }
        const agent = index % 2 && policy.to ? policy.to : policy.builder;
        const text = policy.threads === 'separate' ? turn.standalone : turn.prompt;
        // This probe measures what a fresh handoff can reconstruct, not what the provider retained internally.
        const probe = prepareContext(c, text, { workspace: folders[names[0]], workspaceFolders, fresh: true, provider: agent.provider, mode: 'edit', policy: policy.context, readAttachment: () => ({ text: '' }), includeImages: false });
        const facts = turn.facts || [];
        const started = await start(agent, text);
        if (!started) break;
        const context = c.lastRun?.context;
        run.turns.push({ index, provider: agent.provider, status: c.lastRun?.status || null,
          context: context ? { bytes: context.bytes, estimatedTokens: context.size?.estimatedTokens ?? null, sessionMode: context.sessionMode, sessionReason: context.sessionReason, omittedMessages: context.omittedMessages, shortenedMessages: context.shortenedMessages, ...(context.restoredAfterCompaction ? { restoredAfterCompaction: true } : {}) } : null,
          reconstruction: { source: 'fresh-envelope-probe', factsKept: facts.filter(fact => probe.prompt.includes(fact)).length, factsTotal: facts.length } });
        // Limits count every reported input, including cache hits; reasoning is already part of output.
        if (budget) {
          const latest = (await broker.ledger(c)).runs.at(-1)?.usage;
          budget.tokens += (latest?.input || 0) + (latest?.output || 0) + (latest?.cacheRead || 0) + (latest?.cacheWrite || 0);
        }
        if (run.timedOut || c.lastRun?.status !== 'complete') break;
      }
    } else if (fixture.continues) await start(policy.builder, continuationRequest, { fresh: true });
    else {
      await start(policy.builder, policy.skill ? `/${policy.skill} ${fixture.prompt}` : fixture.prompt, { stopAfterFirstEdit: fixture.stopAfterFirstEdit && (fixture.trace?.[0]?.usage ? 'after-usage' : true), mode: fixture.readOnly ? 'read' : 'edit' });
      if (fixture.needsSecondAgent) await start(policy.to || policy.builder, continuationRequest, { fresh: true });
    }
    await broker.checkpoints?.close?.();
    const ledgers = await Promise.all(conversations.map(conversation => broker.ledger(conversation)));
    const ledger = { runs: ledgers.flatMap(item => item.runs), tasks: ledgers.flatMap(item => item.tasks) };
    const messages = conversations.flatMap(conversation => conversation.messages);
    run.check = run.skipped && !ledger.runs.length ? { passed: false, results: [] } : runCheck(fixture, folders, messages.filter(message => message.role === 'assistant').map(message => message.text));
    run.runs = ledger.runs.map(entry => { const { usage, ...rest } = entry; return { ...rest, usage: usage && { ...usage, raw: undefined } }; });
    run.tasks = ledger.tasks;
    run.usage = sumUsage(ledger.runs.map(entry => entry.usage));
    if (budget && !fixture.turns) budget.tokens += (run.usage.input || 0) + (run.usage.output || 0) + (run.usage.cacheRead || 0) + (run.usage.cacheWrite || 0);
    const real = ledger.runs;
    run.outcome = {
      firstAttemptSuccess: real.every(entry => entry.status === 'complete') && real.length > 0 && !fixture.stopAfterFirstEdit ? run.check.passed : fixture.stopAfterFirstEdit ? null : false,
      verifiedCompletion: run.check.passed, workingMs: real.reduce((sum, entry) => sum + (entry.elapsedMs || 0), 0), runs: real.length,
      retries: real.filter(entry => entry.relation === 'retry').length, interventions: real.reduce((sum, entry) => sum + entry.interventions, 0),
      questionsAsked: run.questionsAsked || 0, timedOut: Boolean(run.timedOut), repeatedFileReads: repeatedFileReads(messages, { workspace: folders[names[0]] }), missingUsage: real.filter(entry => !entry.usage?.reported?.length).length,
      compactions: real.reduce((sum, entry) => sum + entry.compactions, 0),
    };
    run.accounting = { source: 'broker-journals', planning: 'local-rules-or-in-provider-usage', summaries: 'no-separate-codeshi-model-calls', retrieval: 'local-rules',
      nativeDelegation: 'included-in-claude-modelUsage-where-reported; other-providers-unknown', nativeCompactionUsage: 'not-separately-attributable',
      providerCoverage: real.map(entry => ({ provider: entry.provider, source: entry.usage?.source || 'unreported', coverage: entry.usage?.coverage || null })) };
    run.quotaAfter = await quota('after');
    if (pin && fingerprint(observedModels(pin.runs || [])) !== fingerprint(observedModels(run.runs))) {
      run.failure = 'The provider-reported model or effort changed. This run is not a repeat of the pinned experiment.';
    }
  } catch (error) {
    run.failure = error.message;
    // A later dispatch or check error must not erase the work already paid for. Gather every conversation before its
    // temporary journals are removed, just as on a successful workload.
    if (!run.runs) {
      const ledgers = await Promise.all(conversations.map(conversation => broker.ledger(conversation)));
      const measured = ledgers.flatMap(ledger => ledger.runs);
      run.runs = measured.map(({ usage, ...entry }) => ({ ...entry, usage: usage && { ...usage, raw: undefined } }));
      run.tasks = ledgers.flatMap(ledger => ledger.tasks);
      run.usage = sumUsage(measured.map(entry => entry.usage));
      if (budget && !fixture.turns) budget.tokens += (run.usage.input || 0) + (run.usage.output || 0) + (run.usage.cacheRead || 0) + (run.usage.cacheWrite || 0);
    }
    run.outcome = { firstAttemptSuccess: false, verifiedCompletion: false,
      workingMs: run.runs.reduce((sum, entry) => sum + (entry.elapsedMs || 0), 0), runs: run.runs.length,
      retries: run.runs.filter(entry => entry.relation === 'retry').length, interventions: run.runs.reduce((sum, entry) => sum + entry.interventions, 0),
      repeatedFileReads: repeatedFileReads(conversations.flatMap(conversation => conversation.messages), { workspace: folders[names[0]] }), missingUsage: run.runs.filter(entry => !entry.usage?.reported?.length).length };
  } finally {
    await broker.close(); fs.rmSync(root, { recursive: true, force: true });
  }
  run.endedAt = new Date().toISOString();
  run.outcome.wallMs = Math.round(performance.now() - began);
  return run;
}

const median = values => { const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null; };
const spread = values => { const known = values.filter(value => typeof value === 'number' && Number.isFinite(value)); return known.length ? { median: median(known), min: Math.min(...known), max: Math.max(...known), reported: known.length, of: values.length } : { median: null, reported: 0, of: values.length }; };

// Compares results fixture by fixture: how often each policy worked, and what it used, with the spread across repeats and what went unreported.
export function compareResults(results) {
  const groups = new Map();
  for (const [index, result] of results.entries()) { const key = comparisonKey(result, index); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(result); }
  return [...groups.values()].map(list => {
    const outcomes = list.map(result => result.outcome || {}), rate = key => { const known = outcomes.filter(outcome => typeof outcome[key] === 'boolean'); return known.length ? { passed: known.filter(outcome => outcome[key]).length, of: known.length } : null; };
    return { fixture: list[0].fixture, policy: list[0].policy.id, experiment: list[0].experiment?.id || null, models: observedModels(list[0].runs || []), live: list[0].live, repeats: list.length, firstAttemptSuccess: rate('firstAttemptSuccess'), verifiedCompletion: rate('verifiedCompletion'),
      input: spread(list.map(result => result.usage?.input ?? null)), output: spread(list.map(result => result.usage?.output ?? null)), cacheRead: spread(list.map(result => result.usage?.cacheRead ?? null)), cacheWrite: spread(list.map(result => result.usage?.cacheWrite ?? null)),
      reasoning: spread(list.map(result => result.usage?.reasoning ?? null)), compactions: spread(outcomes.map(outcome => outcome.compactions ?? null)),
      tokenCoverage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].map(field => [field, list.every(result => result.usage?.reportedBy && typeof result.usage.runs === 'number')
        ? { reported: list.reduce((sum, result) => sum + result.usage.reportedBy[field], 0), of: list.reduce((sum, result) => sum + result.usage.runs, 0) } : null])),
      reconstruction: spread(list.map(result => result.turns?.length ? result.turns.reduce((sum, turn) => sum + turn.reconstruction.factsKept, 0) / result.turns.reduce((sum, turn) => sum + turn.reconstruction.factsTotal, 0) : null)),
      workingMs: spread(outcomes.map(outcome => outcome.workingMs ?? null)), retries: spread(outcomes.map(outcome => outcome.retries ?? null)), interventions: spread(outcomes.map(outcome => outcome.interventions ?? null)), repeatedFileReads: spread(outcomes.map(outcome => outcome.repeatedFileReads ?? null)),
      wallMs: spread(outcomes.map(outcome => outcome.wallMs ?? null)),
      contextBytes: spread(list.map(result => result.context?.bytes ?? null)), factsKept: list[0].context ? `${list[0].context.factsKept} of ${list[0].context.factsTotal}` : null, unrelatedSteps: list[0].context ? median(list.map(result => result.context?.unrelatedSteps)) : null,
      missingUsage: spread(outcomes.map(outcome => outcome.missingUsage ?? null)), skipped: list.filter(result => result.skipped).length, failures: list.filter(result => result.failure).length };
  });
}

const cell = value => value?.median === null || value === undefined ? 'unknown' : value.min === value.max ? value.median.toLocaleString('en-US') : `${value.median.toLocaleString('en-US')} (${value.min.toLocaleString('en-US')}–${value.max.toLocaleString('en-US')})`;
const rateCell = value => value ? `${value.passed}/${value.of}` : 'n/a';
export function reportMarkdown(rows) {
  const lines = ['| Fixture | Policy | Experiment | Models / effort | Runs | First try | Verified | Input | Cache read | Cache write | Output | Reasoning (in output) | Work (ms) | Wall (ms) | Retries | Asked you | Repeat reads | Facts kept | Unrelated steps | Observed compactions | Reconstruction fraction | Runs without usage |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${row.fixture} | ${row.policy}${row.live ? '' : ' (recorded)'} | ${row.experiment?.slice(0, 12) || 'legacy (unmatched)'} | ${row.models.map(agent => `${agent.provider}:${agent.model || 'unknown'}:${agent.effort || 'unknown'}`).join(' → ') || 'unknown'} | ${row.repeats} | ${rateCell(row.firstAttemptSuccess)} | ${rateCell(row.verifiedCompletion)} | ${cell(row.input)} | ${cell(row.cacheRead)} | ${cell(row.cacheWrite)} | ${cell(row.output)} | ${cell(row.reasoning)} | ${cell(row.workingMs)} | ${cell(row.wallMs)} | ${cell(row.retries)} | ${cell(row.interventions)} | ${cell(row.repeatedFileReads)} | ${row.factsKept ?? 'n/a'} | ${row.unrelatedSteps ?? 'n/a'} | ${cell(row.compactions)} | ${cell(row.reconstruction)} | ${cell(row.missingUsage)} |`);
  lines.push('', 'Repeats are grouped only when pinned inputs, recorded/live mode and reported model/effort sequences match. Older results without pins stay separate. A changed skill, fixture, check, policy, engine or runtime starts another experiment.');
  lines.push('', 'Values are the median, with the range across repeats. "Asked you" counts approvals and questions; nobody answers a question in an evaluation, so the agent carries on without an answer. "unknown" means the agent did not report it: it is not zero. Totals only cover runs that reported, so check the last column: a run stopped part way usually reports nothing. Tokens are not a price, and usage limit readings are kept apart because other tools count toward them too.');
  lines.push('', 'Reconstruction is the fraction of fixture facts present in a fresh envelope probe. It does not measure retention inside a resumed native session. Observed compactions count notifications, not their token cost; zero means none observed. Provider-internal delegation and compaction costs are not separately attributable. Text envelope estimates, last-request counters and cumulative session usage are separate readings in saved results.');
  lines.push('', '| Fixture / policy | Token field coverage (reporting runs / all runs, across repeats) |', '| --- | --- |');
  for (const row of rows) lines.push(`| ${row.fixture} / ${row.policy} / ${row.experiment?.slice(0, 12) || 'legacy'} | ${Object.entries(row.tokenCoverage).map(([key, value]) => `${key}: ${value ? `${value.reported}/${value.of}` : 'unknown'}`).join('; ')} |`);
  return lines.join('\n') + '\n';
}

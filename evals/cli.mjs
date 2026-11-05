#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures, fixtureById } from './fixtures.mjs';
import { compareResults, parsePolicy, reportMarkdown, runFixture } from './harness.mjs';

// npm run eval -- run --agent claude:haiku --context task,recency --live --max-runs 12
// npm run eval -- report | list | delete <file or all>
const resultsDir = process.env.CODESHI_EVAL_RESULTS || path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const [command = 'run', ...rest] = process.argv.slice(2), options = { _: [] };
for (let index = 0; index < rest.length; index++) { const word = rest[index]; if (word.startsWith('--')) { const next = rest[index + 1]; if (next === undefined || next.startsWith('--')) options[word.slice(2)] = true; else { options[word.slice(2)] = next; index++; } } else options._.push(word); }
const saved = () => fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter(name => name.endsWith('.json')).sort() : [];

if (command === 'run') {
  const live = options.live === true, chosen = options.fixture ? String(options.fixture).split(',').map(id => fixtureById(id) || (() => { throw new Error(`No fixture named ${id}. There are: ${fixtures.map(item => item.id).join(', ')}`); })()) : fixtures;
  if (live && !(Number(options['max-runs']) > 0)) { console.error('A live evaluation runs on your own accounts. State a budget with --max-runs, and optionally --max-tokens.'); process.exit(2); }
  const budget = { maxRuns: live ? Number(options['max-runs']) : Infinity, maxTokens: Number(options['max-tokens']) || 0, runs: 0, tokens: 0 }, repeat = Number(options.repeat) || 1, results = [];
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  for (const context of String(options.context || 'task').split(',')) for (const fixture of chosen) for (let index = 0; index < repeat; index++) {
    const policy = parsePolicy({ agent: options.agent || 'codex', to: options.to || null, context, skills: options['no-skills'] !== true, skill: options.skill || null, limits: options.limits ? JSON.parse(options.limits) : null });
    const result = await runFixture(fixture, policy, { live, budget });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${fixture.id}-${context}-${index}.json`;
    fs.writeFileSync(path.join(resultsDir, name), JSON.stringify(result, null, 2), { mode: 0o600 });
    results.push(result);
    console.log(`${fixture.id} [${policy.id}] ${result.skipped ? 'skipped: budget spent' : result.failure ? `failed: ${result.failure}` : result.outcome.verifiedCompletion ? 'verified' : 'not verified'}`);
  }
  console.log('\n' + reportMarkdown(compareResults(results)));
  console.log(`Saved to ${resultsDir}. Live runs: ${live ? budget.runs : 0} of ${live ? budget.maxRuns : 0} budgeted.`);
} else if (command === 'report') {
  const results = saved().map(name => JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8')));
  console.log(results.length ? reportMarkdown(compareResults(options.live ? results.filter(result => result.live) : results)) : 'No results saved yet.');
} else if (command === 'list') console.log(saved().join('\n') || 'No results saved yet.');
else if (command === 'delete') {
  const target = options._[0];
  if (!target) { console.error('Say which result to delete, or "all".'); process.exit(2); }
  const names = target === 'all' ? saved() : saved().filter(name => name === path.basename(target));
  for (const name of names) fs.rmSync(path.join(resultsDir, name));
  console.log(`Deleted ${names.length}.`);
} else { console.error(`Unknown command ${command}. Use run, report, list or delete.`); process.exit(2); }

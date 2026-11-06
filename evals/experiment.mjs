import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// Hash the code that runs the experiment, independently of Git's working tree. Uncommitted engine edits must also
// distinguish experiments. Results contain hashes and relative file names, never the files' text or local paths.
function engineVersion() {
  const files = ['package.json', 'package-lock.json'];
  const visit = directory => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory() && directory.startsWith('src')) visit(name);
      else if (entry.isFile() && name.endsWith('.mjs')) files.push(name);
    }
  };
  visit('src'); visit('evals');
  return fingerprint(files.sort().map(name => [name, fs.readFileSync(path.join(root, name)).toString('base64')]));
}

export function experimentInputs({ fixture, fixtureHash, snapshot, policy, live, skills, runLimitMs }) {
  const inputs = {
    fixtureHash, snapshot, policy, live, runLimitMs,
    trace: live ? null : fingerprint(fixture.trace),
    skills: skills.map(skill => ({ name: skill.name, version: skill.version,
      files: skill.files.map(name => ({ name, hash: createHash('sha256').update(fs.readFileSync(path.join(skill.snapshot, name))).digest('hex') })) })).sort((a, b) => a.name.localeCompare(b.name)),
    checks: {
      files: fingerprint(fixture.check || {}),
      reply: fixture.checkReply ? { source: fixture.checkReply.source, flags: fixture.checkReply.flags } : null,
      commands: Object.keys(fixture.check || {}).sort().map(folder => ({ folder, command: 'node --test .eval-check', files: Object.keys(fixture.check[folder]).sort() })),
    },
    engine: engineVersion(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
  };
  return { version: 1, id: fingerprint(inputs), inputs };
}

export function validatePin(pin) {
  if (pin?.experiment?.version !== 1 || !pin.experiment.inputs || pin.experiment.id !== fingerprint(pin.experiment.inputs)) {
    throw new Error('This result has no valid experiment pin. Run the evaluation again to create one.');
  }
}

export function checkPin(pin, experiment) {
  validatePin(pin);
  if (pin.experiment.id === experiment.id) return;
  const changed = Object.keys(experiment.inputs).filter(key => fingerprint(pin.experiment.inputs[key] ?? null) !== fingerprint(experiment.inputs[key] ?? null));
  throw new Error(`Pinned evaluation inputs changed: ${changed.join(', ')}. Restore those versions before repeating this experiment.`);
}

export const observedModels = runs => runs.map(run => ({ provider: run.provider, model: run.effectiveModel || run.model || null, effort: run.effort || null }));

// Old results lack enough provenance to establish equivalence. Keep each apart rather than inventing a common baseline.
export function comparisonKey(result, index) {
  const models = observedModels(result.runs || []);
  if (result.live && (!models.length || models.some(agent => !agent.model || agent.model === 'unknown'))) return `unreported-model-${index}`;
  return result.experiment?.version === 1
    ? fingerprint({ experiment: result.experiment.id, models, live: result.live })
    : `legacy-${index}`;
}

// Loaded by `npm test`. The running app and every copy of it coordinate through one folder in the temporary directory, so
// tests using it would wait for a Codeshi you have open, or for another test run, and could make that app wait too. Each
// test run keeps to its own folder instead. The test files run as child processes, and inherit it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.AI_RELAY_MUTATIONS_DIR) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-test-mutations-'));
  process.env.AI_RELAY_MUTATIONS_DIR = folder;
  process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));
}

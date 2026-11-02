import fs from 'node:fs';
import path from 'node:path';
import { withFileGuard } from '../../src/mutation-lock.mjs';
const [filename, mode, counter] = process.argv.slice(2);
const pause = new Int32Array(new SharedArrayBuffer(4));
if (mode === 'recover-and-crash') {
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    rename(source, destination);
    if (String(source).includes(path.join(filename + '.guard', 'owner-'))) {
      fs.writeFileSync(filename + '.claimed', 'yes');
      process.kill(process.pid, 'SIGKILL');
    }
  };
  withFileGuard(filename, () => { throw new Error('The recovery fixture must crash before entering a transaction.'); });
} else if (mode === 'hold') withFileGuard(filename, () => {
  fs.writeFileSync(filename + '.ready', String(process.pid));
  Atomics.wait(pause, 0, 0, 60000);
});
else for (let index = 0; index < 8; index++) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      withFileGuard(filename, () => {
        const value = Number(fs.readFileSync(counter, 'utf8'));
        Atomics.wait(pause, 0, 0, 4);
        fs.writeFileSync(counter, String(value + 1));
      });
      break;
    } catch (error) { if (error.status !== 409 || Date.now() >= deadline) throw error; }
  }
}

import { execFile as nodeExecFile } from 'node:child_process';

// Gives the front back on the Mac. A press on the panel near the top of the screen brings Codeshi forward (see
// overlay.mjs), and its × is meant to leave the person where they were. Electron can't name or activate another
// app, so macOS's own tools do it: `lsappinfo` lists the apps with windows from front to back, and `open` brings
// the first one behind Codeshi forward again. Nothing happens unless Codeshi really is in front.
export const appOrder = text => [...String(text || '').matchAll(/ASN:0x[0-9a-f]+-0x[0-9a-f]+/gi)].map(match => match[0]);
export function appDetails(text) {
  const value = String(text || ''), pid = value.match(/\bpid\s*=\s*(\d+)/), bundle = value.match(/bundle path="([^"]+\.app)"/);
  return { pid: pid ? Number(pid[1]) : null, path: bundle ? bundle[1] : null };
}

export async function giveFrontBack({ pid = process.pid, execFile = nodeExecFile, platform = process.platform } = {}) {
  if (platform !== 'darwin') return false;
  const run = (file, args) => new Promise(resolve => execFile(file, args, { timeout: 3000 }, (error, stdout) => resolve(error ? '' : String(stdout))));
  const details = async asn => appDetails(await run('/usr/bin/lsappinfo', ['info', '-only', 'pid,bundlepath', asn]));
  const [front] = appOrder(await run('/usr/bin/lsappinfo', ['front']));
  if (!front || (await details(front)).pid !== pid) return false;
  for (const asn of appOrder(await run('/usr/bin/lsappinfo', ['visibleProcessList']))) {
    if (asn === front) continue;
    const behind = await details(asn);
    if (!behind.path || behind.pid === pid) continue;
    await run('/usr/bin/open', [behind.path]);
    return true;
  }
  return false;
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

// Google's official distribution, pinned to the ACP registry release and checksum.
// https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
export const antigravityVersion = '1.4.5';
const releases = {
  'darwin-arm64': ['macos', 'darwin-arm64', '886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f'],
  'darwin-x64': ['macos', 'darwin-x86_64', 'b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a'],
  'linux-x64': ['linux', 'linux-x86_64', '923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b'],
  'linux-arm64': ['linux', 'linux-arm64', '7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056'],
  'win32-x64': ['windows', 'windows-x86_64', 'd24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50'],
  'win32-arm64': ['windows', 'windows-arm64', 'ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c'],
};
// The Windows archive holds .exe files; Windows has no unzip, and its own tar reads zip archives.
const runtimeFiles = platform => platform === 'win32' ? ['agy_acp_server.exe', 'localharness_external.exe'] : ['agy_acp_server.par', 'localharness_external'];
const extractCommand = (platform, archive, name, env = process.env) => platform === 'win32'
  ? [path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe'), ['-xOf', archive, name]]
  : [platform === 'darwin' ? '/usr/bin/unzip' : 'unzip', ['-p', archive, name]];
export const googleRuntimePath = (root, platform = process.platform) => path.join(root, 'runtime', antigravityVersion, runtimeFiles(platform)[0]);
const installs = new Map();
export function installAntigravity(root, options = {}) {
  if (installs.has(root)) return installs.get(root);
  const pending = install(root, options).finally(() => installs.delete(root)); installs.set(root, pending); return pending;
}
async function install(root, { platform = process.platform, arch = process.arch, fetchImpl = fetch, spawnImpl = spawn } = {}) {
  const release = releases[platform + '-' + arch];
  if (!release) throw Object.assign(new Error('Codeshi can’t install Antigravity automatically on this system yet.'), { status: 400 });
  const destination = path.dirname(googleRuntimePath(root, platform));
  if (fs.existsSync(destination)) return { installed: true, version: antigravityVersion };
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.download-'));
  try {
    const response = await fetchImpl(`https://dl.google.com/agy-extensions/releases/${release[0]}/agy-acp-server-${antigravityVersion}-${release[1]}.zip`, { redirect: 'error', signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error('Could not download the official Antigravity runtime. Try again.');
    const archive = path.join(temporary, 'runtime.zip'), hash = createHash('sha256'); let size = 0;
    await pipeline(response.body, async function* (source) { for await (const chunk of source) { size += chunk.length; if (size > 180 * 1024 * 1024) throw new Error('Antigravity download exceeded the size limit.'); hash.update(chunk); yield chunk; } }, fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    if (hash.digest('hex') !== release[2]) throw new Error('Antigravity download checksum did not match. Nothing was installed.');
    const extracted = path.join(temporary, 'runtime'); fs.mkdirSync(extracted, { mode: 0o700 });
    // Extract only these literal members to regular files. Archive paths, symlinks
    // and permissions are never applied to the filesystem.
    for (const name of runtimeFiles(platform)) {
      const [command, args] = extractCommand(platform, archive, name);
      const child = spawnImpl(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(platform === 'win32' ? 'Could not extract Antigravity. Try again.' : 'Could not extract Antigravity. Install unzip and retry.'))); }); exit.catch(() => {}); child.stderr.resume();
      let bytes = 0;
      try { await pipeline(child.stdout, async function* (source) { for await (const chunk of source) { bytes += chunk.length; if (bytes > 260 * 1024 * 1024) throw new Error('Antigravity runtime exceeded the size limit.'); yield chunk; } }, fs.createWriteStream(path.join(extracted, name), { flags: 'wx', mode: 0o700 })); await exit; if (!bytes) throw new Error('Missing Antigravity runtime file.'); }
      finally { child.kill('SIGTERM'); }
    }
    fs.renameSync(extracted, destination);
    return { installed: true, version: antigravityVersion };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

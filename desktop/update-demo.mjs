// `npm run start:update-demo`: the update flow from a source checkout, without downloading or replacing anything.
// GitHub and the macOS tools are stood in for: the next minor version is offered, its "download" takes a few seconds
// and passes every check, and restarting opens this same copy again, so the offer comes back.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLE_ID } from './updater.mjs';

const REPOSITORY = 'https://github.com/AhmedNavaz/codeshi';

export function updateDemo({ version, build, relaunch, chunks = 40, pause = 120 }) {
  const [major, minor] = version.split('.').map(Number), next = `${major}.${minor + 1}.0`;
  const file = `Codeshi-${next}-mac-${build}.zip`, base = `${REPOSITORY}/releases/download/v${next}/`;
  const bytes = Buffer.alloc(chunks * 64 * 1024, 7), sum = createHash('sha256').update(bytes).digest('hex');
  const release = { tag_name: `v${next}`, html_url: `${REPOSITORY}/releases/tag/v${next}`, draft: false, prerelease: false, published_at: new Date().toISOString(),
    assets: [{ name: file, size: bytes.length, browser_download_url: base + file }, { name: 'SHA256SUMS.txt', browser_download_url: base + 'SHA256SUMS.txt' }] };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(release));
    if (url.endsWith('/SHA256SUMS.txt')) return new Response(`${sum}  ${file}\n`);
    if (url === base + file) return new Response(new ReadableStream({ async start(controller) {
      const size = bytes.length / chunks;
      for (let index = 0; index < chunks; index++) {
        if (options.signal?.aborted) { controller.error(new DOMException('The download was cancelled.', 'AbortError')); return; }
        controller.enqueue(bytes.subarray(index * size, (index + 1) * size)); await wait(pause);
      }
      controller.close();
    } }), { headers: { 'content-length': String(bytes.length) } });
    return new Response('', { status: 404 });
  };
  // Unpacking makes an empty app with the expected name and version, and the signature check passes.
  const exec = async (tool, args) => {
    if (tool.endsWith('/ditto')) { const contents = path.join(args[3], 'Codeshi.app', 'Contents'); fs.mkdirSync(contents, { recursive: true }); fs.writeFileSync(path.join(contents, 'Info.plist'), 'demo'); }
    if (tool.endsWith('/plutil')) return `${args[1] === 'CFBundleIdentifier' ? BUNDLE_ID : next}\n`;
    return '';
  };
  return { fetchImpl, exec, launch: () => {}, quit: relaunch, location: { bundle: path.join(path.sep, 'Applications', 'Codeshi (update demo).app'), blocked: null } };
}

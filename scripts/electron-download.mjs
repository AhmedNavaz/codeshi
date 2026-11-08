// Fetches Electron for `npm run package` when GitHub's release downloads are failing.
//
// Electron Packager fetches the Electron zip, then SHASUMS256.txt, from github.com, each in one request with no retry.
// GitHub's asset storage answered the checksum request with 504s for an entire morning and the release of 0.34.0
// failed four times (#138). This downloader retries GitHub with growing pauses, then gets the file from a mirror. The
// zip is verified against the checksums the electron npm package ships for its own version (pinned by package-lock.json),
// so SHASUMS256.txt is never fetched and the mirror cannot substitute a different binary.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const GITHUB_RELEASES = 'https://github.com/electron/electron/releases/download/';
export const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
// The responses worth another try: the server or a gateway in front of it was busy or out, not that the file is missing.
const TRY_AGAIN = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HTTPError extends Error {
  constructor(status, statusText, url) {
    super(`Response code ${status} (${statusText}) for ${url}`);
    this.name = 'HTTPError'; this.status = status; this.url = url;
  }
}

// The checksums of every artifact of the installed Electron version, by file name, as the electron package ships them.
export function electronChecksums(root) {
  const file = path.join(root, 'node_modules', 'electron', 'checksums.json');
  if (!fs.existsSync(file)) throw new Error(`${file} is missing, so the Electron download cannot be verified; reinstall with npm ci.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const worthRetrying = error => !(error instanceof HTTPError) || TRY_AGAIN.has(error.status);

/**
 * A downloader for @electron/get: GitHub first, tried again after each of `delays`, then the mirror the same way. A
 * download that sends nothing for `stall` milliseconds counts as failed. A URL that is not GitHub's, such as one from
 * ELECTRON_MIRROR, is retried but has no fallback.
 */
export function createElectronDownloader({ fetch = globalThis.fetch, mirror = ELECTRON_MIRROR, delays = [5_000, 15_000, 45_000], stall = 60_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = line => console.warn(line) } = {}) {
  async function fetchToFile(url, target, init) {
    const controller = new AbortController();
    let timer;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), stall); };
    touch();
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new HTTPError(response.status, response.statusText, url);
      if (!response.body) throw new Error(`Empty response for ${url}`);
      await pipeline(Readable.fromWeb(response.body, { signal: controller.signal }), async function* (chunks) { for await (const chunk of chunks) { touch(); yield chunk; } }, fs.createWriteStream(target));
    } catch (error) {
      throw controller.signal.aborted ? new Error(`No data from ${url} for ${stall / 1000} s`) : error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function keepTrying(url, target, init) {
    for (let attempt = 0; ; attempt++) {
      try { return await fetchToFile(url, target, init); } catch (error) {
        await fs.promises.rm(target, { force: true });
        if (!worthRetrying(error) || attempt >= delays.length) throw error;
        log(`Electron download failed (${error.message}); trying again in ${delays[attempt] / 1000} s (attempt ${attempt + 2} of ${delays.length + 1}).`);
        await sleep(delays[attempt]);
      }
    }
  }
  return {
    async download(url, targetFilePath, options = {}) {
      const { quiet, getProgressCallback, ...init } = options;
      await fs.promises.mkdir(path.dirname(targetFilePath), { recursive: true });
      try { await keepTrying(url, targetFilePath, init); } catch (error) {
        if (!url.startsWith(GITHUB_RELEASES) || !worthRetrying(error)) throw error;
        log(`GitHub's Electron downloads keep failing (${error.message}); getting ${path.basename(url)} from ${mirror} instead. Its checksum is still verified.`);
        await keepTrying(mirror + url.slice(GITHUB_RELEASES.length), targetFilePath, init);
      }
    },
  };
}

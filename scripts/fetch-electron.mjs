// Puts this computer's Electron zip in @electron/get's cache through the retrying downloader, so that the electron
// package's own download on first use, which has no retry, finds it there and never touches the network. CI runs it
// before npm test; it is also the way to fetch Electron by hand while GitHub's downloads are failing (#138).
import { createRequire } from 'node:module';
import path from 'node:path';
import { downloadArtifact } from '@electron/get';
import { createElectronDownloader, electronChecksums } from './electron-download.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { version } = createRequire(import.meta.url)('electron/package.json');
const file = await downloadArtifact({ version, artifactName: 'electron', checksums: electronChecksums(root), downloader: createElectronDownloader() });
console.log(`Electron ${version} is at ${file}`);

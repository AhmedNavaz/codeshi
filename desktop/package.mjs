import {packager} from '@electron/packager';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildHelper} from '../src/voice.mjs';
import {packageOptions} from './package-options.mjs';
import {createElectronDownloader,electronChecksums} from '../scripts/electron-download.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const identity=process.env.AI_RELAY_SIGN_IDENTITY;
// npm installs node-pty's macOS helper without its execute bit; the terminal's shell cannot start without it.
for(const arch of ['arm64','x64']){const helper=path.join(root,'node_modules','node-pty','prebuilds',`darwin-${arch}`,'spawn-helper');if(fs.existsSync(helper))fs.chmodSync(helper,0o755);}
// Voice input's speech helper is built for this architecture and ships inside the app (macOS and Windows).
if(process.platform==='darwin'||process.platform==='win32')console.log('Built '+await buildHelper());
// The Agent SDK's bundled Claude Code binary is left out: Codeshi always runs the user's own installed Claude Code.
// Electron comes from GitHub's releases, verified against the checksums the electron package ships rather than a fetched
// SHASUMS256.txt, with retries and a mirror for when GitHub's downloads fail (#138).
const download={checksums:electronChecksums(root),downloader:createElectronDownloader()};
const builds=await packager(packageOptions({root,platform:process.platform,arch:process.arch,identity,download}));
// Packaging invalidates Electron's signature. Without an identity, sign ad hoc so Apple Silicon will launch the app (it is still not notarized).
if(process.platform==='darwin'&&!identity) for(const build of builds) execFileSync('codesign',['--force','--deep','--sign','-',path.join(build,'Codeshi.app')],{stdio:'inherit'});
console.log('Packaged Codeshi: '+builds.join(', '));

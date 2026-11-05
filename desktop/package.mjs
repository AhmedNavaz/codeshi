import {packager} from '@electron/packager';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildHelper} from '../src/voice.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const identity=process.env.AI_RELAY_SIGN_IDENTITY;
// npm installs node-pty's macOS helper without its execute bit; the terminal's shell cannot start without it.
for(const arch of ['arm64','x64']){const helper=path.join(root,'node_modules','node-pty','prebuilds',`darwin-${arch}`,'spawn-helper');if(fs.existsSync(helper))fs.chmodSync(helper,0o755);}
// Voice input's speech helper is built for this architecture and ships inside the app (macOS only).
if(process.platform==='darwin')console.log('Built '+await buildHelper());
// The Agent SDK's bundled Claude Code binary is left out: Codeshi always runs the user's own installed Claude Code.
// On macOS 26 and later the app icon comes from the layers in assets/AppIcon.icon, compiled by `npm run icons` into
// assets/Assets.car so any build machine can ship them; earlier macOS versions use icon.icns. The car goes into the app
// before it is signed. Electron Packager also looks for assets/icon.icon to compile itself and warns that there is none:
// that is expected, since it can only compile on macOS 26 and the Intel build runs on macOS 15.
const mac=process.platform==='darwin';
const layeredIcon=mac?{extendInfo:{CFBundleIconName:'AppIcon'},afterCopy:[({buildPath})=>fs.copyFileSync(path.join(root,'assets','Assets.car'),path.join(buildPath,'..','Assets.car'))]}:{extendInfo:{}};
const builds=await packager({dir:root,name:'Codeshi',out:path.join(root,'dist'),overwrite:true,asar:false,prune:true,appBundleId:'local.throughline.desktop',icon:path.join(root,'assets',process.platform==='win32'?'icon.ico':process.platform==='darwin'?'icon.icns':'icon.png'),appCategoryType:'public.app-category.developer-tools',...layeredIcon,extendInfo:{...layeredIcon.extendInfo,NSMicrophoneUsageDescription:'Codeshi listens while voice input is on, to turn what you say into a message.',NSSpeechRecognitionUsageDescription:'Codeshi recognizes your speech on this Mac. The audio never leaves it.'},ignore:[/\.code-workspace$/,/^\/\.data(?:\/|$)/,/^\/docs(?:\/|$)/,/^\/\.github(?:\/|$)/,/^\/dist(?:\/|$)/,/^\/output(?:\/|$)/,/^\/test(?:\/|$)/,/^\/evals(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/\.git(?:\/|$)/,/^\/sharing\/\.data(?:\/|$)/,/^\/sharing\/test(?:\/|$)/,/^\/install\.(?:sh|ps1)$/,
  // Icon sources and the brand kit are build inputs; the app only reads its PNG icons at run time.
  /^\/assets\/(?:brand|AppIcon\.icon)(?:\/|$)/,/^\/assets\/(?:Assets\.car|social-preview\.png|icon(?:-dark)?\.svg)$/,/^\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+(?:\/|$)/,
  // The terminal needs node-pty's binaries for this system and architecture and its JavaScript, not other binaries, debug symbols, sources or build headers.
  new RegExp(`^/node_modules/node-pty/(?:prebuilds/(?!${process.platform}-${process.arch}(?:/|$))[^/]+|deps|third_party|src|scripts|typings|binding\\.gyp)(?:/|$)`),/^\/node_modules\/node-pty\/.*\.pdb$/,/^\/node_modules\/node-addon-api(?:\/|$)/,/^\/node_modules\/@xterm\/.*\.map$/,
  // The page loads xterm's built files. Its TypeScript sources hold the deepest paths, which some Windows tools cannot handle.
  /^\/node_modules\/@xterm\/[^/]+\/src(?:\/|$)/],...(identity?{osxSign:{identity}}:{})});
// Packaging invalidates Electron's signature. Without an identity, sign ad hoc so Apple Silicon will launch the app (it is still not notarized).
if(process.platform==='darwin'&&!identity) for(const build of builds) execFileSync('codesign',['--force','--deep','--sign','-',path.join(build,'Codeshi.app')],{stdio:'inherit'});
console.log('Packaged Codeshi: '+builds.join(', '));

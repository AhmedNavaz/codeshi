import {packager} from '@electron/packager';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const identity=process.env.AI_RELAY_SIGN_IDENTITY;
// npm installs node-pty's macOS helper without its execute bit; the terminal's shell cannot start without it.
for(const arch of ['arm64','x64']){const helper=path.join(root,'node_modules','node-pty','prebuilds',`darwin-${arch}`,'spawn-helper');if(fs.existsSync(helper))fs.chmodSync(helper,0o755);}
// The Agent SDK's bundled Claude Code binary is left out: Throughline always runs the user's own installed Claude Code.
const builds=await packager({dir:root,name:'Throughline',out:path.join(root,'dist'),overwrite:true,asar:false,prune:true,appBundleId:'local.throughline.desktop',icon:path.join(root,'assets',process.platform==='win32'?'icon.ico':process.platform==='darwin'?'icon.icns':'icon.png'),appCategoryType:'public.app-category.developer-tools',ignore:[/\.code-workspace$/,/^\/\.data(?:\/|$)/,/^\/docs(?:\/|$)/,/^\/\.github(?:\/|$)/,/^\/dist(?:\/|$)/,/^\/output(?:\/|$)/,/^\/test(?:\/|$)/,/^\/\.git(?:\/|$)/,/^\/sharing\/\.data(?:\/|$)/,/^\/sharing\/test(?:\/|$)/,/^\/install\.(?:sh|ps1)$/,/^\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+(?:\/|$)/,
  // The terminal needs node-pty's binaries for this system and architecture and its JavaScript, not other binaries, debug symbols, sources or build headers.
  new RegExp(`^/node_modules/node-pty/(?:prebuilds/(?!${process.platform}-${process.arch}(?:/|$))[^/]+|deps|third_party|src|scripts|typings|binding\\.gyp)(?:/|$)`),/^\/node_modules\/node-pty\/.*\.pdb$/,/^\/node_modules\/node-addon-api(?:\/|$)/,/^\/node_modules\/@xterm\/.*\.map$/,
  // The page loads xterm's built files. Its TypeScript sources hold the deepest paths, which some Windows tools cannot handle.
  /^\/node_modules\/@xterm\/[^/]+\/src(?:\/|$)/],...(identity?{osxSign:{identity}}:{})});
// Packaging invalidates Electron's signature. Without an identity, sign ad hoc so Apple Silicon will launch the app (it is still not notarized).
if(process.platform==='darwin'&&!identity) for(const build of builds) execFileSync('codesign',['--force','--deep','--sign','-',path.join(build,'Throughline.app')],{stdio:'inherit'});
console.log('Packaged Throughline: '+builds.join(', '));

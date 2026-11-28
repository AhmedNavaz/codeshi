import fs from 'node:fs';
import path from 'node:path';
// Pure packaging options for desktop/package.mjs, kept apart so they can be tested on any system without running Electron Packager.
// The terminal needs node-pty's binaries for this system and architecture and its JavaScript, not other binaries, debug symbols, sources or build headers.
export function ignoredPackagePaths({platform=process.platform,arch=process.arch}={}) {
  return [/\.code-workspace$/,/^\/\.data(?:\/|$)/,/^\/docs(?:\/|$)/,/^\/\.github(?:\/|$)/,/^\/dist(?:\/|$)/,/^\/output(?:\/|$)/,/^\/test(?:\/|$)/,/^\/evals(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/\.git(?:\/|$)/,/^\/sharing\/\.data(?:\/|$)/,/^\/sharing\/(?:test|deploy)(?:\/|$)/,/^\/install\.(?:sh|ps1)$/,
    /^\/remote\/(?:dist|test)(?:\/|$)/,
    // Icon sources and the brand kit are build inputs; the app only reads its PNG icons at run time.
    /^\/assets\/(?:brand|AppIcon\.icon)(?:\/|$)/,/^\/assets\/(?:Assets\.car|social-preview\.png|icon(?:-dark)?\.svg)$/,/^\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+(?:\/|$)/,
    new RegExp(`^/node_modules/node-pty/(?:prebuilds/(?!${platform}-${arch}(?:/|$))[^/]+|deps|third_party|src|scripts|typings|binding\\.gyp)(?:/|$)`),/^\/node_modules\/node-pty\/.*\.pdb$/,/^\/node_modules\/node-addon-api(?:\/|$)/,/^\/node_modules\/@xterm\/.*\.map$/,
    // The page loads xterm's built files. Its TypeScript sources hold the deepest paths, which some Windows tools cannot handle.
    /^\/node_modules\/@xterm\/[^/]+\/src(?:\/|$)/];
}
export function packageIcon(root,platform=process.platform){return path.join(root,'assets',platform==='win32'?'icon.ico':platform==='darwin'?'icon.icns':'icon.png');}
// On macOS 26 and later the app icon comes from the layers in assets/AppIcon.icon, compiled by `npm run icons` into
// assets/Assets.car so any build machine can ship them; earlier macOS versions use icon.icns. The car goes into the app
// before it is signed. Electron Packager also looks for assets/icon.icon to compile itself and warns that there is none:
// that is expected, since it can only compile on macOS 26 and the Intel build runs on macOS 15.
// Give the fallback its own resource name too. System menus can resolve CFBundleIconFile separately from the
// layered icon; retaining Electron's generic electron.icns name can leave them showing a cached older design.
// Packager copies assets/icon.icns to the CFBundleIconFile destination before signing.
export function layeredIconOptions(root,platform=process.platform){
  return platform==='darwin'?{extendInfo:{CFBundleIconName:'AppIcon',CFBundleIconFile:'Codeshi.icns'},afterCopy:[({buildPath})=>fs.copyFileSync(path.join(root,'assets','Assets.car'),path.join(buildPath,'..','Assets.car'))]}:{extendInfo:{}};
}
export function packageOptions({root,platform=process.platform,arch=process.arch,identity,keychain,notarize,download}){
  const layeredIcon=layeredIconOptions(root,platform);
  const osxSign=platform==='darwin'&&identity?{identity,continueOnError:false,...(keychain?{keychain}:{})}:null;
  const osxNotarize=osxSign&&notarize?.appleApiKey&&notarize?.appleApiKeyId
    ?{appleApiKey:notarize.appleApiKey,appleApiKeyId:notarize.appleApiKeyId,...(notarize.appleApiIssuer?{appleApiIssuer:notarize.appleApiIssuer}:{})}
    :null;
  return {dir:root,name:'Codeshi',out:path.join(root,'dist'),overwrite:true,download,asar:false,prune:true,appBundleId:'local.throughline.desktop',icon:packageIcon(root,platform),appCategoryType:'public.app-category.developer-tools',...layeredIcon,extendInfo:{...layeredIcon.extendInfo,NSMicrophoneUsageDescription:'Codeshi listens while voice input is on, to turn what you say into a message.',NSSpeechRecognitionUsageDescription:'Codeshi recognizes your speech on this Mac. The audio never leaves it.',NSLocalNetworkUsageDescription:'Codeshi connects to a paired phone browser on your local network when you turn on Remote access.'},ignore:ignoredPackagePaths({platform,arch}),...(osxSign?{osxSign}:{}),...(osxNotarize?{osxNotarize}:{})};
}

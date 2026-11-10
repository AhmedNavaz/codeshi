// Builds every icon from the drawings in desktop/brand.mjs: `npm run icons`. On a Mac with Xcode 26 or later it also
// compiles the layered macOS icon; elsewhere that step is skipped and the committed assets/Assets.car is kept.
//
//   assets/icon.svg, icon-dark.svg    macOS tiles in Paper and Ink (shown at the top of the README)
//   assets/AppIcon.icon/              Icon Composer layers: macOS 26 and later draw Paper, Ink, clear and tinted from them
//   assets/Assets.car                 the compiled layers, which desktop/package.mjs puts in the app
//   assets/icon.icns, icon.png        Paper, for macOS 15 and earlier and for the window in development
//   assets/icon-dark.png              Ink, for the Dock in development when the appearance is dark
//   assets/icon.ico                   Windows (Paper)
//   assets/status/*.png               menu bar template images: シ on its own, with a dot when something needs you
//   assets/status/Tray*.ico           Windows notification area: the same, for a dark or a light taskbar
//   assets/brand/*.png              both looks at every size from 16 to 1024 (16 and 32 are the seal)
//   public/icon.svg                   favicon: the seal, the same in both themes
//   public/mark.svg                   the mark beside the name in the app: シ in vermilion
//   desktop/overlay.html              the alert panel's シ, drawn inside the page
//   public/logo.svg                   in-app logo (medium detail), Paper or Ink with the page
//   public/index.html                 the welcome screen's animated logo
//   public/icon-{16,32,180,192,512}.png PNG favicons, touch and Home Screen icons (Paper)
//   assets/social-preview.png         the GitHub repository card
import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as brand from './brand.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets'), pub = path.join(root, 'public');
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const sized = (svg, width, height = width) => svg.replace('<svg ', `<svg width="${width}" height="${height}" `);

// PNG-compressed ICO entries are supported by Windows Vista and later.
function ico(images) {
  const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12);
    offset += png.length; return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(image => image.png)]);
}

// Compiles the Icon Composer layers the way Electron Packager does, so the app can ship them from any build machine.
function compileLayers(source) {
  if (process.platform !== 'darwin') return 'skipped Assets.car: actool is only available on macOS';
  let version = null;
  try { version = execFileSync('xcrun', ['actool', '--version'], { encoding: 'utf8' }).match(/short-bundle-version<\/key>\s*<string>([\d.]+)/)?.[1] || null; } catch { /* No Xcode. */ }
  if (!version || Number.parseInt(version, 10) < 26) return `skipped Assets.car: it needs actool from Xcode 26 or later${version ? `, found ${version}` : ''}`;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-icon-')), out = path.join(temporary, 'out');
  try {
    fs.cpSync(source, path.join(temporary, 'AppIcon.icon'), { recursive: true });
    fs.mkdirSync(out);
    execFileSync('xcrun', ['actool', path.join(temporary, 'AppIcon.icon'), '--compile', out, '--output-format', 'human-readable-text', '--errors', '--warnings',
      '--output-partial-info-plist', path.join(out, 'info.plist'), '--app-icon', 'AppIcon', '--include-all-app-icons', '--enable-on-demand-resources', 'NO',
      '--development-region', 'en', '--target-device', 'mac', '--minimum-deployment-target', '26.0', '--platform', 'macosx'], { stdio: 'inherit' });
    fs.copyFileSync(path.join(out, 'Assets.car'), path.join(assets, 'Assets.car'));
    return `compiled Assets.car with actool ${version}`;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 640, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body style="margin:0">');
  // Rasterize the vector at the target size so small icons stay sharp.
  const render = async (svg, width, height = width) => Buffer.from(await win.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = 'data:image/svg+xml;base64,${Buffer.from(sized(svg, width, height)).toString('base64')}'; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = ${width}; canvas.height = ${height};
    canvas.getContext('2d').drawImage(image, 0, 0, ${width}, ${height});
    return canvas.toDataURL('image/png').split(',')[1];
  })()`), 'base64');
  // Each size gets its level of detail: small at 32 px and below, medium up to 127 px, full from 128 px.
  const tilePng = (look, pixels) => render(brand.tile({ look, pixels }), pixels);

  write(path.join(assets, 'icon.svg'), brand.tile({ look: 'paper' }));
  write(path.join(assets, 'icon-dark.svg'), brand.tile({ look: 'ink' }));
  write(path.join(pub, 'icon.svg'), brand.autoMark({ detail: 'small' }));
  write(path.join(pub, 'logo.svg'), brand.autoMark({ detail: 'medium' }));
  write(path.join(pub, 'mark.svg'), brand.glyphMark());
  // The alert panel's page loads no images, so its シ is drawn inside it.
  const panel = path.join(root, 'desktop', 'overlay.html'), panelHtml = fs.readFileSync(panel, 'utf8'), at = panelHtml.indexOf('<svg class="mark-shi"');
  if (at < 0) throw new Error('desktop/overlay.html has no mark-shi drawing to update.');
  write(panel, panelHtml.slice(0, at) + brand.inlineGlyph('mark-shi') + panelHtml.slice(panelHtml.indexOf('</svg>', at) + '</svg>'.length));
  // The welcome screen draws its logo inside the page, so it can animate.
  const page = path.join(pub, 'index.html'), html = fs.readFileSync(page, 'utf8'), start = html.indexOf('<svg class="onboarding-mark"');
  if (start < 0) throw new Error('public/index.html has no onboarding-mark drawing to update.');
  write(page, html.slice(0, start) + brand.onboardingMark() + html.slice(html.indexOf('</svg>', start) + '</svg>'.length));

  // actool's output differs from run to run, so Assets.car is only compiled again when the layers change.
  // Delete it to compile it regardless, for example after updating Xcode.
  const layers = path.join(assets, 'AppIcon.icon'), drawn = brand.iconComposer();
  const listed = folder => fs.existsSync(folder) ? fs.readdirSync(folder, { recursive: true }).filter(name => fs.statSync(path.join(folder, name)).isFile()).sort() : [];
  const compiledIcon = path.join(assets, 'Assets.car');
  // A headless preview can update the SVG sources even when Apple's compiler cannot run. A newer drawing module
  // must still trigger compilation on the next desktop run, rather than reusing the previous binary catalogue.
  const layersUnchanged = fs.existsSync(compiledIcon) && fs.statSync(compiledIcon).mtimeMs >= fs.statSync(path.join(root, 'desktop', 'brand.mjs')).mtimeMs
    && JSON.stringify(listed(layers)) === JSON.stringify(Object.keys(drawn).sort())
    && Object.entries(drawn).every(([name, content]) => fs.readFileSync(path.join(layers, name), 'utf8') === content);
  fs.rmSync(layers, { recursive: true, force: true });
  for (const [name, content] of Object.entries(drawn)) write(path.join(layers, name), content);

  const iconset = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-')), 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    write(path.join(iconset, `icon_${size}x${size}.png`), await tilePng('paper', size));
    write(path.join(iconset, `icon_${size}x${size}@2x.png`), await tilePng('paper', size * 2));
  }
  if (process.platform === 'darwin') execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')]);
  else console.warn('Skipping icon.icns: iconutil is only available on macOS.');
  fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
  write(path.join(assets, 'icon.png'), await tilePng('paper', 512));
  write(path.join(assets, 'icon-dark.png'), await tilePng('ink', 512));
  write(path.join(assets, 'icon.ico'), ico(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async size => ({ size, png: await render(brand.mark({ pixels: size }), size) })))));

  for (const [name, attention] of [['StatusTemplate', false], ['StatusAttentionTemplate', true]]) {
    const { svg, width, height } = brand.template({ attention });
    write(path.join(assets, 'status', `${name}.png`), await render(svg, width, height));
    write(path.join(assets, 'status', `${name}@2x.png`), await render(svg, width * 2, height * 2));
  }
  // Windows picks the entry that fits the taskbar's scale: 16 px at 100%, 20 at 125%, 24 at 150%, 32 at 200%.
  for (const taskbar of ['dark', 'light']) for (const attention of [false, true])
    write(path.join(assets, 'status', `Tray${taskbar === 'dark' ? 'Dark' : 'Light'}${attention ? 'Attention' : ''}.ico`), ico(await Promise.all([16, 20, 24, 32, 40, 48].map(async size => ({ size, png: await render(brand.tray({ taskbar, attention }), size) })))));
  for (const look of ['paper', 'ink']) for (const size of [16, 32, 64, 128, 256, 512, 1024]) write(path.join(assets, 'brand', `codeshi-${look}-${size}.png`), await tilePng(look, size));
  for (const size of [16, 32]) write(path.join(pub, `icon-${size}.png`), await render(brand.mark({ pixels: size }), size));
  for (const size of [180, 192, 512]) write(path.join(pub, `icon-${size}.png`), await render(brand.mark({ pixels: size, square: true }), size));
  const compiled = layersUnchanged ? 'kept Assets.car, since the layers have not changed' : compileLayers(layers);

  const card = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; width: 1280px; height: 640px; display: flex; align-items: center; gap: 56px; padding: 0 120px; box-sizing: border-box;
      background: radial-gradient(circle at 17% 26%, rgb(217 56 30 / .2) 0, transparent 44%), linear-gradient(160deg, #24211e, #121110 72%); color: #f4ede1; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    img { width: 260px; height: 260px; flex: none; }
    h1 { margin: 0; font-size: 92px; font-weight: 700; letter-spacing: -0.03em; }
    p { margin: 16px 0 0; max-width: 680px; color: #c9bfb1; font-size: 34px; line-height: 1.35; }
    small { display: block; margin-top: 28px; color: #8d8377; font-size: 24px; letter-spacing: 0.01em; }
  </style><img src="data:image/svg+xml;base64,${Buffer.from(sized(brand.tile({ look: 'ink', pixels: 260 }), 260)).toString('base64')}"><div><h1>Codeshi</h1>
    <p>Claude Code, Codex, Gemini and local models in one conversation.</p>
    <small>Open source · Your own agent accounts</small></div>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(card).toString('base64'));
  await new Promise(resolve => setTimeout(resolve, 300));
  const preview = await win.webContents.capturePage();
  write(path.join(assets, 'social-preview.png'), preview.resize({ width: 1280, height: 640 }).toPNG());
  console.log(`Icons written to assets/ and public/; ${compiled}.`);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

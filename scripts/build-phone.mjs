import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firebaseConfig } from '../public/phone-firebase.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = firebaseConfig(JSON.parse(fs.readFileSync(path.join(root, 'remote/firebase-public.json'), 'utf8')));
const output = path.join(root, 'remote/dist');
fs.mkdirSync(output, { recursive: true });
const assets = ['phone.js', 'phone-remote.mjs', 'phone-firebase.mjs', 'phone-transfer.mjs', 'phone-logic.js', 'phone-theme.js', 'routing.js', 'phone.css', 'editor-theme.css', 'mark.svg'];
const permitted = new Set([...assets, 'index.html', 'remote-config.json']);
if (fs.readdirSync(output).some(name => !permitted.has(name))) throw Error('The generated phone directory contains unexpected files. Inspect it before building or deploying.');
// This dedicated static host serves the small phone interface only. No desktop app, projects, credentials,
// development files or server code are copied to Firebase Hosting.
for (const filename of assets) {
  fs.copyFileSync(path.join(root, 'public', filename), path.join(output, filename));
}
const html = fs.readFileSync(path.join(root, 'public/phone.html'), 'utf8')
  .replace('<script src="/phone.js" defer></script>', '<script type="module" src="/phone-remote.mjs"></script>')
  .replace('id="app" class="app"', 'id="app" class="app" hidden');
fs.writeFileSync(path.join(output, 'index.html'), html);
fs.writeFileSync(path.join(output, 'remote-config.json'), JSON.stringify(config));
// Keep the host's CSP in sync when an operator uses another Firebase project.
const settings = JSON.parse(fs.readFileSync(path.join(root, 'remote/firebase.json'), 'utf8'));
const csp = settings.hosting.headers[0].headers.find(header => header.key === 'Content-Security-Policy');
csp.value = csp.value.replace(/https:\/\/[a-z0-9.-]+\.(?:firebaseio\.com|firebasedatabase\.app)/g, config.databaseURL);
fs.writeFileSync(path.join(root, 'remote/firebase.json'), `${JSON.stringify(settings, null, 2)}\n`);
console.log(`Built phone page in ${output}`);

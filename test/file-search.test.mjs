import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { noSymlinks } from './platform.mjs';
import { searchFiles } from '../src/file-explorer.mjs';

test('file search covers every workspace folder, ranks by name and never shows private, build or linked paths', { skip: noSymlinks }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-file-search-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const web = path.join(root, 'web'), api = path.join(root, 'api');
  for (const file of ['src/app.js', 'src/components/AppShell.jsx', 'docs/mapping-notes.md', 'node_modules/lib/app.js', '.git/app.js', '.env', 'dist/app.js', 'keys/app.pem']) write(path.join(web, file));
  write(path.join(api, 'server/app.js'));
  write(path.join(root, 'elsewhere/app.js')); fs.symlinkSync(path.join(root, 'elsewhere'), path.join(web, 'linked'));
  const workspaces = [{ id: 'one', name: 'Web', folders: [{ id: 'web', name: 'web', path: web }] }, { id: 'two', name: 'API', folders: [{ id: 'api', name: 'api', path: api }] }];
  const found = searchFiles(workspaces, 'app');
  assert.deepEqual(found.map(file => [file.projectName, file.path]), [['Web', 'src/app.js'], ['API', 'server/app.js'], ['Web', 'src/components/AppShell.jsx'], ['Web', 'docs/mapping-notes.md']], 'Names that start with the text first, shorter paths first among them, then names that contain it; nothing private, built or linked.');
  assert.deepEqual(found[1], { projectId: 'two', projectName: 'API', folderId: 'api', folderName: 'api', path: 'server/app.js' });
  assert.deepEqual(searchFiles(workspaces, 'a'), [], 'One character is too little to search.');
  assert.equal(searchFiles(workspaces, 'app', 2).length, 2);
  assert.deepEqual(searchFiles(workspaces, 'app.js').slice(0, 2).map(file => file.path), ['src/app.js', 'server/app.js'], 'An exact name comes first.');
  assert.deepEqual(searchFiles(workspaces, 'SRC/APP').map(file => file.path), ['src/app.js'], 'Paths match too, ignoring case.');
});

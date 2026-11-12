import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Every dialog shares one head and one foot (.panel-dialog-head and .panel-dialog-foot in public/styles.css), so a new
// dialog can't bring its own paddings, title size or button heights. The ones listed here are whole views or a short
// question rather than a form or a viewer, and say why.
const OWN_LAYOUT = {
  'compact-confirmation': 'a question: an icon beside the title, and the two answers',
  'remove-workspace-dialog': 'a question: the title, what happens, and the two answers',
  'flow-detail': 'a full view inside Flow',
  'files-dialog': 'the file explorer, with the heading the sidebar explorer uses',
  'setup-dialog': 'the setup guide',
  'updates-dialog': 'What’s New keeps its logo heading; its foot is shared',
  settings: 'a page title beside the navigation',
  'plan-view': 'a full-screen view with its own toolbar'
};
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dialogs = [...html.matchAll(/<dialog id="([^"]+)"[^>]*>([\s\S]*?)<\/dialog>/g)].map(match => ({ id: match[1], body: match[2] }));

test('every dialog uses the shared head and foot, apart from the listed views', () => {
  assert.ok(dialogs.length >= 25, 'the dialogs were found in index.html');
  for (const id of Object.keys(OWN_LAYOUT)) assert.ok(dialogs.some(dialog => dialog.id === id), `${id} is still a dialog`);
  for (const { id, body } of dialogs) {
    const tags = [...body.matchAll(/<(header|footer)\b([^>]*)>/g)].map(match => ({ tag: match[1], attributes: match[2] }));
    if (id === 'updates-dialog') { assert.match(tags.find(tag => tag.tag === 'footer').attributes, /\bpanel-dialog-foot\b/, 'What’s New uses the shared foot'); continue; }
    if (OWN_LAYOUT[id]) continue;
    assert.ok(tags.some(tag => tag.tag === 'header'), `#${id} has a head`);
    for (const { tag, attributes } of tags) {
      const shared = tag === 'header' ? 'panel-dialog-head' : 'panel-dialog-foot';
      assert.match(attributes, new RegExp(`\\b${shared}\\b`), `#${id} <${tag}> uses .${shared}`);
    }
  }
});

test('the close button in a dialog head is the icon, not a typed character', () => {
  for (const { id, body } of dialogs) {
    for (const [, head] of body.matchAll(/<header\b[^>]*panel-dialog-head[^>]*>([\s\S]*?)<\/header>/g)) {
      for (const [, label] of head.matchAll(/<button\b[^>]*class="icon-button"[^>]*>([\s\S]*?)<\/button>/g)) assert.match(label, /^<svg class="icon"/, `#${id} close button`);
    }
  }
});

test('no dialog styles its own head or foot again', () => {
  const directory = new URL('../public/', import.meta.url);
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.css'))) {
    const css = fs.readFileSync(new URL(file, directory), 'utf8');
    for (const [, selector, rule] of css.matchAll(/([^{}]*-dialog\s*>\s*(?:header|footer)|#workbench\s*>\s*header)\s*\{([^}]*)\}/g)) {
      assert.doesNotMatch(rule, /border-(top|bottom)|(?<!-)padding\s*:/, `${file}: ${selector.trim()} leaves padding and borders to the shared layout`);
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Badge and status text must keep WCAG AA (4.5:1) in Light, Dark and Graphite, on every surface a badge sits on: plain,
// on its own tint, and on the accent-tinted Flow cards. Colours come from public/editor-theme.css itself.
const css = readFileSync(new URL('../public/editor-theme.css', import.meta.url), 'utf8');
const block = (selector) => {
  const start = css.indexOf('{', css.indexOf(`${selector} {`));
  return css.slice(start + 1, css.indexOf('\n}', start));
};
const tokens = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)\s*;/g)].map((match) => [match[1], match[2]]));
const graphite = tokens(block(':root[data-theme="graphite"]'));
const themes = {
  graphite,
  // Dark lists only what differs from Graphite.
  dark: { ...graphite, ...tokens(block(':root[data-theme="dark"]')) },
  light: tokens(block(':root[data-theme="light"]')),
};

const rgba = (hex) => [1, 3, 5, 7].map((index) => (hex.length > index + 1 ? parseInt(hex.slice(index, index + 2), 16) : 255) / 255);
const over = (top, under) => [0, 1, 2].map((index) => top[index] * top[3] + under[index] * (1 - top[3])).concat(1);
const mix = (color, percent, under) => over([...color.slice(0, 3), percent / 100], under);
const luminance = (color) => {
  const [r, g, b] = color.slice(0, 3).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (text, surface) => {
  const [high, low] = [luminance(over(text, surface)), luminance(surface)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
};

// Page, sidebar and status bar, bottom panel, raised cards, menus and dialogs, and selected rows.
const surfaces = ['bg', 'sidebar', 'statusbar-bg', 'panel-bg', 'surface-raised', 'overlay-bg', 'list-active'];
const states = ['text', 'muted', 'faint', 'success', 'warning', 'danger', 'link'];
const tinted = [['success', 'success-bg'], ['warning', 'warning-bg'], ['danger', 'danger-bg'], ['muted', 'chip-bg'], ['link', 'chip-bg']];

function pairs(theme) {
  const color = (name) => {
    assert.ok(theme[name], `--${name} is defined`);
    return rgba(theme[name]);
  };
  const list = [];
  const add = (label, text, surface, minimum = 4.5) => list.push({ label, ratio: contrast(text, surface), minimum });
  for (const surface of surfaces) {
    const base = color(surface);
    for (const state of states) add(`${state} on ${surface}`, color(state), base);
    for (const [state, tint] of tinted) add(`${state} on ${tint} over ${surface}`, color(state), over(color(tint), base));
    // Board and plan status boxes tint with 10% of their own colour. They never sit on a selected row.
    if (surface !== 'list-active') for (const state of ['success', 'danger']) add(`${state} on 10% ${state} over ${surface}`, color(state), mix(color(state), 10, base));
  }
  // Filled badges: the approval and task counts, primary buttons.
  add('bg on warning', color('bg'), color('warning'));
  add('on-accent on accent', color('on-accent'), color('accent'));
  add('on-accent on accent-strong', color('on-accent'), color('accent-strong'));
  // The recording microphone is an icon, so 3:1.
  add('bg icon on danger', color('bg'), color('danger'), 3);
  // Flow: the Working badge on an active plan, and each routing mode's tag on its card.
  const activePlan = mix(color('accent'), 8, color('surface-raised'));
  add('link on Working badge', color('link'), mix(color('accent'), 14, activePlan));
  for (const [mode, tone] of [['Ultra', 'accent'], ['Saver', 'success'], ['Smart', 'gemini']]) {
    const card = mix(color(tone), tone === 'accent' ? 6 : 5, color('surface-raised'));
    const text = tone === 'accent' ? color('link') : color(tone);
    add(`${mode} eyebrow`, text, card);
    add(`${mode} tag`, text, mix(color(tone), 12, card));
  }
  return list;
}

for (const [name, theme] of Object.entries(themes)) {
  test(`${name} theme: badge and status colours meet WCAG AA`, () => {
    const failing = pairs(theme).filter(({ ratio, minimum }) => ratio < minimum).map(({ label, ratio, minimum }) => `${label}: ${ratio.toFixed(2)} (needs ${minimum})`);
    assert.deepEqual(failing, []);
  });
}

test('the accent is a fill colour, too dim for small text in the dark themes', () => {
  // Guards the reason running states and eyebrows use --link: if this stops holding, the rule can be revisited.
  assert.ok(contrast(rgba(themes.graphite.accent), rgba(themes.graphite['surface-raised'])) < 4.5);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceWindows, cascade } from '../desktop/workspace-windows.mjs';

const fakeWindow = (name) => { const window = { name, destroyed: false, visible: true, isDestroyed: () => window.destroyed, isVisible: () => window.visible }; return window; };

test('each workspace shows in one window: a switch to one open elsewhere is refused and names that window (#203)', () => {
  const pages = createWorkspaceWindows(), main = pages.track(fakeWindow('main'), { primary: true }), second = pages.track(fakeWindow('second'), { projectId: 'b' });
  assert.deepEqual(pages.claim(main, 'a'), { here: true });
  assert.equal(pages.showing('a'), main);
  assert.equal(pages.showing('b'), second);
  assert.deepEqual(pages.claim(main, 'b'), { elsewhere: second }, 'b is open in the second window, so main stays on a.');
  assert.equal(pages.projectOf(main), 'a');
  assert.deepEqual(pages.claim(second, 'b'), { here: true }, 'A window may keep its own workspace.');
  assert.deepEqual(pages.claim(main, 'c'), { here: true });
  assert.equal(pages.showing('a'), null, 'Main moved on from a.');
  assert.deepEqual(pages.claim(fakeWindow('stranger'), 'a'), { refused: true }, 'Only Codeshi windows are tracked.');
});

test('a window\'s first load takes its workspace even when another window shows it, so it never opens empty (#203)', () => {
  const pages = createWorkspaceWindows(), main = pages.track(fakeWindow('main'), { primary: true }), second = pages.track(fakeWindow('second'), { projectId: 'a' });
  assert.deepEqual(pages.claim(main, 'a', { initial: true }), { here: true });
  pages.touch(main);
  assert.equal(pages.showing('a'), main, 'Shown twice, the window last in front is the one a notification opens.');
  pages.touch(second);
  assert.equal(pages.showing('a'), second);
});

test('notifications and commands skip hidden and closed windows, and the window last in front gets plain commands (#203)', () => {
  const pages = createWorkspaceWindows(), main = pages.track(fakeWindow('main'), { primary: true, projectId: 'a' }), second = pages.track(fakeWindow('second'), { projectId: 'b' });
  pages.touch(second);
  assert.equal(pages.front(), second);
  pages.touch(main);
  assert.equal(pages.front(), main);
  main.visible = false;
  assert.equal(pages.showing('a'), null, 'The hidden main window shows nothing to bring forward.');
  assert.equal(pages.front(), second);
  assert.deepEqual(pages.elsewhere(second), [], 'A hidden window marks nothing in the others.');
  assert.equal(pages.othersVisible(second), false, 'Closing the second window now closes the last one.');
  main.visible = true;
  assert.deepEqual(pages.elsewhere(second), ['a']);
  assert.deepEqual(pages.elsewhere(main), ['b']);
  assert.equal(pages.othersVisible(second), true);
  second.destroyed = true;
  assert.equal(pages.showing('b'), null);
  assert.deepEqual(pages.windows(), [main]);
  pages.forget(second);
  assert.equal(pages.has(second), false);
});

test('a new window opens a step below and right of the one in front, inside the screen (#203)', () => {
  const area = { x: 0, y: 25, width: 1512, height: 920 };
  assert.deepEqual(cascade({ x: 40, y: 60, width: 1200, height: 800 }, area), { x: 68, y: 88, width: 1200, height: 800 });
  assert.deepEqual(cascade({ x: 300, y: 140, width: 1440, height: 1000 }, area), { x: 0, y: 25, width: 1440, height: 920 }, 'Too far right and down: back to the corner, no taller than the screen.');
  assert.deepEqual(cascade(null, area), { x: 116, y: 35, width: 1280, height: 900 }, 'With no window in front, it opens centred.');
});

test('a window still opening counts as showing its workspace, so a second click brings it rather than opening another (#203)', () => {
  const pages = createWorkspaceWindows(), main = pages.track(fakeWindow('main'), { primary: true, projectId: 'a' }), loading = fakeWindow('loading');
  loading.visible = false;
  pages.track(loading, { projectId: 'b', opening: true });
  assert.equal(pages.showing('b'), loading);
  assert.deepEqual(pages.claim(main, 'b'), { elsewhere: loading });
  pages.opened(loading);
  assert.equal(pages.showing('b'), null, 'Opened but hidden again: no longer showing.');
  loading.visible = true;
  assert.equal(pages.showing('b'), loading);
});

test('a notification for a workspace pinned in a companion lane goes to that window when none shows it (#203)', () => {
  const pages = createWorkspaceWindows(), main = pages.track(fakeWindow('main'), { primary: true, projectId: 'a' }), second = pages.track(fakeWindow('second'), { projectId: 'b' });
  pages.lanes(second, ['c', 'c', 'd']);
  assert.equal(pages.pinned('c'), second);
  assert.equal(pages.showing('c'), null, 'A lane isn\'t a window showing the workspace, so it can still open elsewhere.');
  pages.lanes(main, ['c']); pages.touch(main);
  assert.equal(pages.pinned('c'), main, 'Pinned twice, the window last in front.');
  main.visible = false;
  assert.equal(pages.pinned('c'), second, 'A hidden window doesn\'t count.');
  pages.lanes(second, []);
  assert.equal(pages.pinned('c'), null);
  assert.equal(pages.pinned(null), null);
});

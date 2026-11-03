// The window follows the saved appearance. themeSource drives native menus and dialogs and the page's
// prefers-color-scheme, so System follows the OS while Light and Dark override it.
export function createAppearance({ nativeTheme, onBackground = () => {} }) {
  // The page background of each palette (--bg in public/editor-theme.css), shown until the page paints.
  const background = () => nativeTheme.shouldUseDarkColors ? '#1c1a18' : '#fbf8f3';
  nativeTheme.on('updated', () => onBackground(background()));
  return {
    background,
    // Electron emits updated when this changes what the window shows.
    set(preference) { nativeTheme.themeSource = preference === 'light' ? 'light' : preference === 'graphite' ? 'dark' : 'system'; },
  };
}

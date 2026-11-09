// The window follows the saved appearance. themeSource drives native menus and dialogs and the page's
// prefers-color-scheme, so System follows the OS while Light and Dark override it.
export function createAppearance({ nativeTheme, onBackground = () => {} }) {
  // The page background of each palette (--bg in public/editor-theme.css), shown until the page paints. System follows
  // the OS between Light and Dark; Graphite is the warm dark.
  let preference = 'system';
  const background = () => preference === 'graphite' ? '#1c1a18' : nativeTheme.shouldUseDarkColors ? '#111111' : '#fbf8f3';
  nativeTheme.on('updated', () => onBackground(background()));
  return {
    background,
    // Electron emits updated when this changes what the window shows.
    set(value) { preference = value; nativeTheme.themeSource = value === 'light' ? 'light' : value === 'dark' || value === 'graphite' ? 'dark' : 'system'; onBackground(background()); },
  };
}

/**
 * Web app manifest for the installable PWA (#155).
 *
 * Imported by vite.config.ts (vite-plugin-pwa emits it as
 * /manifest.webmanifest) and by manifest.test.ts. No `@/` imports here: the
 * Vite config loads this file outside the app's alias resolution.
 *
 * The colours are the brand tokens from src/index.css — `brand-deep` for the
 * status bar / title bar and `brand-primary` for the splash background — and
 * manifest.test.ts fails if they drift from the tokens.
 */

/** `--brand-deep` (#3A3542): theme colour, iOS/Android status bar. */
export const PWA_THEME_COLOR = '#3A3542';
/** `--brand-primary` (#6D657A): splash screen background. */
export const PWA_BACKGROUND_COLOR = '#6D657A';

const PWA_ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] as const;

export const pwaManifest = {
  // `id` is the permanent install identity: changing it makes every installed
  // copy a different app. Never change it.
  id: '/',
  name: 'Bliss',
  short_name: 'Bliss',
  description: 'Your personal finance companion',
  start_url: '/',
  scope: '/',
  display: 'standalone' as const,
  orientation: 'portrait' as const,
  theme_color: PWA_THEME_COLOR,
  background_color: PWA_BACKGROUND_COLOR,
  icons: PWA_ICONS.map((icon) => ({ ...icon })),
};

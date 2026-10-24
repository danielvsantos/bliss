/**
 * Workbox options for the generated service worker (#155).
 *
 * The service worker is an app-shell cache only: it precaches the built
 * bundle (hashed /static/* files, index.html, icons) and nothing else.
 *
 * - No runtimeCaching: no response fetched at runtime is ever stored. The API
 *   is cross-origin in production and same-origin `/api/*` (dev proxy) never
 *   matches a precache entry, so financial data never reaches Cache Storage.
 * - Navigations fall back to the precached index.html so deep links to SPA
 *   routes open, except `/api/*` and `/version.json`.
 * - skipWaiting is off: the page decides when a new worker takes over
 *   (src/lib/pwa/register.ts), so a page is never reloaded under someone
 *   mid-edit.
 *
 * Imported by vite.config.ts and sw-policy.test.ts. No `@/` imports.
 */

export const NAVIGATE_FALLBACK_DENYLIST = [/^\/api\//, /^\/version\.json$/];

export const pwaWorkboxOptions = {
  globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,webmanifest}'],
  // Not part of the shell: source maps, the build stamp, the CSV templates and
  // the 1 MB sign-in illustration (still served normally, just not precached).
  globIgnores: ['**/*.map', 'version.json', 'templates/**', 'images/**'],
  // The main bundle is ~3 MB; Workbox's 2 MiB default would silently drop it.
  maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
  navigateFallback: '/index.html',
  navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,
  runtimeCaching: [],
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: false,
};

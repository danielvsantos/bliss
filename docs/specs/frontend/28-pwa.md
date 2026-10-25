# 28. Installable PWA ("Add to Home Screen")

Task #155. `apps/web` is installable as a Progressive Web App: from the iPhone home screen (Safari → Share → Add to Home Screen) and with Chrome's one-tap install on Android and desktop, Bliss opens full-screen like an app. It is not a native app and is not distributed through any store.

The work ships in three pull requests:

| Phase | Scope | Status |
|---|---|---|
| 1 — Installable | Manifest + icons, iOS meta tags, app-shell service worker, offline screen, update flow, nginx cache headers, install control, third-party script removed, base safe areas | Shipped |
| 2a — Standalone correctness | Logout cache clearing, desktop-only bank connections, resume refetch, keyboard-aware dialogs, safe areas on dialogs / sheets / drawers / full-screen phone modals | Shipped (§28.9) |
| 2b — Phone layout pass | 390 px pass on Dashboard, Transactions, Transaction Review, Subscriptions, Portfolio, Insights, Notifications and the profile / admin section (Settings, users); back navigation on detail views | Shipped (§28.10) |

Out of scope by decision: push notifications, the app badge, offline access to financial data, connecting banks from the installed app, a native/Capacitor app, analytics or KPIs, a user-facing install guide (the in-app instructions are the only help).

## 28.1. Manifest and icons

| File | Role |
|---|---|
| `src/lib/pwa/manifest.ts` | The manifest object (`pwaManifest`) and its colours. Imported by `vite.config.ts` (vite-plugin-pwa emits `/manifest.webmanifest` and injects the `<link rel="manifest">`) and by `manifest.test.ts`. No `@/` imports: the Vite config loads it outside the alias. |
| `pwa-assets/icon-source.jpg` | The capybara mascot (2000×2000). Outside `public/`, so it is never served. |
| `scripts/generate-pwa-icons.mjs` | `pnpm --filter @bliss/web pwa:icons` (sharp). Writes the four icons below. The outputs are committed: the Docker build installs with `--ignore-scripts` on alpine, and the icons only change with the mascot. |
| `public/icons/icon-192.png` | 192, head crop (`HEAD_CROP`) |
| `public/icons/icon-512.png` | 512, the full mascot |
| `public/icons/icon-maskable-512.png` | 512 maskable. The head does not fit the central 80 % safe zone of any crop of the source, so the canvas is first extended on the top and left with the source's own background colour (`MASKABLE_PAD`), then cropped (`MASKABLE_CROP`). Circle and squircle masks keep the glasses and both ears. |
| `public/apple-touch-icon.png` | 180, head crop, opaque (iOS adds its own rounding) |

Manifest: `id: '/'` (the permanent install identity — never change it), `name`/`short_name` "Bliss", `start_url` and `scope` `/`, `display: standalone`, `orientation: portrait`, `theme_color` `#3A3542` (`brand-deep`), `background_color` `#6D657A` (`brand-primary`). `manifest.test.ts` converts the HSL tokens in `src/index.css` and fails if either colour drifts from its token, and checks the two `theme-color` meta tags.

The browser-tab favicon (`public/favicon.*`) is unchanged.

`index.html` carries the iOS tags: `apple-mobile-web-app-capable`, `mobile-web-app-capable`, `apple-mobile-web-app-title` "Bliss", `apple-mobile-web-app-status-bar-style` `black-translucent`, the `apple-touch-icon` link, `theme-color` for light and dark (both `brand-deep`), and `viewport-fit=cover`. The Lovable leftovers are gone: the `cdn.gpteng.co/gptengineer.js` script (a third-party script a finance app must not load), `twitter:site @lovable_dev`, and the broken `/public/favicon.png` image paths. `sw-policy.test.ts` fails if `index.html` loads any absolute-URL script.

## 28.2. Service worker: app shell only

vite-plugin-pwa (pinned exact) with `strategies: 'generateSW'`, `registerType: 'prompt'`, `injectRegister: false`, `filename: 'sw.js'`. The Workbox options live in `src/lib/pwa/sw-config.ts` and are tested by `sw-policy.test.ts`.

| Option | Value | Why |
|---|---|---|
| `globPatterns` | `**/*.{js,css,html,svg,png,ico,woff2,webmanifest}` | The built shell |
| `globIgnores` | `**/*.map`, `version.json`, `templates/**`, `images/**` | Not part of the shell. The 1 MB sign-in illustration is still served, just not precached. |
| `maximumFileSizeToCacheInBytes` | 6 MiB | The main bundle is ~2.5 MB; Workbox's 2 MiB default would silently drop it |
| `runtimeCaching` | `[]` | Nothing fetched at runtime is ever stored |
| `navigateFallback` | `/index.html` | Deep links to SPA routes open from the precache |
| `navigateFallbackDenylist` | `/^\/api\//`, `/^\/version\.json$/` | Never answered with the shell |
| `cleanupOutdatedCaches` / `clientsClaim` / `skipWaiting` | `true` / `true` / `false` | The page decides when a new worker takes over (§28.3) |

**No financial data in Cache Storage, by construction:** the API is a different origin in production, cross-origin requests never match a precache route, and there is no runtime route, so the service worker never stores an API response. Same-origin `/api/*` (the dev proxy) is excluded from the navigation fallback. The service worker is registered in production builds only (`import.meta.env.PROD` in `main.tsx`); `vite dev` has none (`devOptions.enabled: false`).

The current build precaches 14 entries (~3.8 MB): `index.html`, the three `/static/` bundles, the manifest, favicons and icons.

## 28.3. Update flow

`src/lib/pwa/register.ts` wraps `registerSW` from `virtual:pwa-register` (aliased to `src/test/mocks/pwa-register.ts` in Vitest). The browser detects a new build by byte-diffing `/sw.js`, which nginx serves `no-cache` (§28.6).

- **Launch window.** When a new worker is waiting within `LAUNCH_WINDOW_MS` (10 s) of page load and before any `pointerdown`/`keydown`, it is applied at once (`updateSW(true)`: `SKIP_WAITING`, then reload). An app opened after a deploy therefore runs the new build with no prompt.
- **Already in use.** Later, `register.ts` dispatches `pwa:need-refresh` and `<PwaUpdater />` (mounted once in `App.tsx`) shows a persistent toast: `notifications.info.newVersion` with a `pwa.update.reload` action. Nothing ever reloads under someone who is mid-edit.
- **Toast ignored.** The waiting worker activates once every window of the app has closed, so the next cold open runs the new build. The toast can also be replaced by another toast (`TOAST_LIMIT` is 1); the same fallback applies.
- **Checks.** `registration.update()` runs when the app becomes visible (throttled to once per `UPDATE_CHECK_THROTTLE_MS`, 60 s) and every `UPDATE_CHECK_INTERVAL_MS` (60 min) while visible. A failed check (offline) is ignored.
- `version.json` is not polled: it stays a diagnostic build stamp and is excluded from the precache.

There are no lazy-loaded chunks today, so an old precache can never ask for a chunk that a deploy removed. If code-splitting is introduced, add a reload path for dynamic-import failures in the error boundary.

### Kill switch

A service worker cannot be removed by deleting it from the build: browsers keep the installed one. To retire the PWA, remove `VitePWA` from `vite.config.ts` and ship a `public/sw.js` that unregisters itself:

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
  await self.registration.unregister();
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => client.navigate(client.url));
});
```

Keep it deployed until every installed copy has opened at least once.

## 28.4. Install control

| File | Role |
|---|---|
| `src/lib/pwa/platform.ts` | `isStandalone()` (`display-mode: standalone` or iOS `navigator.standalone`), `isIOS()` (iPhone/iPad/iPod, or a touch `MacIntel` for iPadOS), `getInstallMode(canPrompt)` → `standalone` \| `ios-instructions` \| `prompt` \| `unsupported` |
| `src/lib/pwa/install-prompt.ts` | Captures `beforeinstallprompt` at module load (imported from `main.tsx`, because Chrome can fire it before React mounts), calls `preventDefault()` to suppress the mini-infobar, clears it on `appinstalled`. `promptInstall()` uses the event once. |
| `src/hooks/use-display-mode.ts` | `useIsStandalone()` (`useSyncExternalStore`, like `use-page-visible`) |
| `src/hooks/use-install-prompt.ts` | `{ mode, install }` |
| `src/components/pwa/install-app-button.tsx` | iOS: opens the instructions drawer. Chrome: the native prompt. Renders nothing for `standalone` and `unsupported` (e.g. Firefox desktop). |
| `src/components/pwa/install-instructions-drawer.tsx` | vaul drawer: Share → Add to Home Screen → Add, ending with the note that the app does not share the browser's login, so you sign in once inside it |
| `src/components/pwa/install-banner.tsx` | Dashboard banner. Dismissal is permanent on the device: `localStorage['bliss.pwa.installBannerDismissed'] = '1'` (storage errors hide it for the session only) |
| `src/components/pwa/install-app-card.tsx` | Settings → General: the always-available control |

The banner and Settings card are worded device-neutrally ("its own window, from your home screen, dock or taskbar") with an app-window icon, because desktop Chrome installs Bliss as an app too; only the iOS instructions mention the phone. Strings: `pwa.install.*` in all five locales (parity test in `i18n-parity.test.ts`). Tests (`install-app-button.test.tsx`) cover the four branches: iOS instructions with the sign-in note, the Chrome prompt, hidden when standalone/unsupported, and permanent banner dismissal.

## 28.5. Offline

`useOnlineStatus()` (`navigator.onLine` + `online`/`offline` events). `AppShell` renders `<OfflineScreen />` **instead of** the page while offline, so no figures are shown — not even the persisted TanStack Query cache in localStorage. `/auth` shows the same screen, since signing in needs the network. The screen (`pwa.offline.*`) has a retry button; the page comes back by itself on the `online` event and TanStack refetches on reconnect. `navigator.onLine` can miss a flaky connection; that case falls through to the normal request error states.

## 28.6. Edge headers (nginx)

`docker/nginx.conf` is the only edge config. It covers Railway (which builds `docker/Dockerfile.web`) and Docker Compose alike.

| Path | Cache-Control |
|---|---|
| `= /index.html`, `= /sw.js`, `= /manifest.webmanifest` (`application/manifest+json`), `= /version.json` | `no-cache` |
| `/` (SPA fallback, every response is `index.html`) | `no-cache` |
| `/static/` | `public, immutable`, 1 year (unchanged) |
| `/icons/` | `public, max-age=604800` |

`no-cache` still allows a 304. A CDN or proxy in front of the web service must respect these headers, or bypass the four entry files; otherwise installed apps can stay on an old build (see `12-deployment.md`).

## 28.7. Safe areas (Phase 1 base)

The status bar is `black-translucent` with `viewport-fit=cover`, so the page extends under it. In the installed app:

- `body` gets `padding-top: env(safe-area-inset-top)`, and a fixed `.pwa-status-bar` band in `brand-deep` (rendered in `App.tsx`) sits behind the status bar so its white text stays readable in both themes.
- `AppShell` is pinned to the screen with `fixed inset-0` and pads itself below the status bar (`pt-[env(safe-area-inset-top)]`) and clear of the landscape notch (`.pwa-safe-x`). It is deliberately **not** sized with `dvh`: in iOS standalone mode with the translucent status bar, `100dvh` already excludes the status bar, so `dvh` arithmetic left an empty band above the home indicator. Full-screen surfaces should follow the same pattern (`fixed inset-0` + inset padding), not `h-[100dvh]`.
- `<main>` adds `env(safe-area-inset-bottom)` to its own bottom padding, so its background runs to the bottom edge and the last content scrolls clear of the home indicator. The mobile sidebar drawer starts below the status bar and clears the home indicator on its own background.
- The toast viewport sits below the status bar on phones (`components/ui/toaster.tsx`, class-only change).

Every `env(safe-area-inset-*)` is 0 in a browser tab and on desktop, so nothing changes there. Dialogs, sheets, drawers and the full-screen phone modals follow in Phase 2a (§28.9).

**Theme.** `ThemeProvider` defaults to `light`. There is no theme switcher, and the sign-in page stores `light`, so browsers always ended up on light; an installed app starts with empty storage, and the former `system` default put it in the unfinished dark theme whenever the phone was in dark mode.

## 28.8. Testing

| Test | Covers |
|---|---|
| `src/lib/pwa/manifest.test.ts` | Manifest fields, token drift, theme-color tags, icon files exist |
| `src/lib/pwa/sw-policy.test.ts` | No runtime caching, `/api` + `/version.json` denylist, precache globs, no auto-skipWaiting, the Vite wiring, no third-party script in `index.html` |
| `src/lib/pwa/register.test.ts` | Launch window applies the update, after the window or after input → toast event, throttled update checks, offline check swallowed, no SW support |
| `src/lib/pwa/platform.test.ts` | iOS / iPadOS detection, standalone detection, install mode |
| `src/lib/pwa/install-prompt.test.ts` | `beforeinstallprompt` captured and `preventDefault`ed, single-use prompt, cleared on `appinstalled` |
| `src/components/pwa/install-app-button.test.tsx` | The four install branches |
| `src/components/pwa/pwa-updater.test.tsx` | Toast on `pwa:need-refresh`, Reload applies the update |
| `src/components/layout/app-shell.test.tsx` | Offline gate shows no figures and recovers on `online` |
| `src/lib/query-client.test.ts`, `src/contexts/AuthContext.test.tsx` | Logout clears the cache and the persisted copy, also when sign-out fails; session expiry does not |
| `src/components/plaid-connect.test.tsx`, `enable-banking/connect-dialog.test.tsx`, `accounts/bank-connection-card.test.tsx` | Standalone: desktop-only note, Plaid Link never loaded, no Enable Banking connect / reconnect |
| `src/hooks/use-resume-refresh.test.tsx` | Refetch + update check after 6 min away, nothing after 4 min |
| `src/lib/pwa/visual-viewport.test.ts` | `--vv-height` / `--vv-top` follow the keyboard; leftover pan reset only once it closes |

Manual (real device): see the QA checklist in the task's completion proof — installability in Chrome DevTools (Lighthouse 12 dropped the PWA category), iPhone Add to Home Screen, Cache Storage contents after a session, airplane mode, and the update flow across a deploy.

## 28.9. Phase 2a: standalone correctness

### Logout hygiene
The QueryClient and its localStorage persister live in `src/lib/query-client.ts` (moved out of `providers.tsx` so `AuthContext` can import them without a cycle). `AuthContext.signOut()` calls `clearPersistedQueryCache()` in a `finally`: `queryClient.clear()`, then `persister.removeClient()`, so no portfolio, account or metadata payload stays on the device, even when the sign-out request itself fails. An `auth:session-expired` event does **not** clear it (PRD D9); the cache ages out on its 24 h `gcTime`.

### Bank connections are desktop-only in the installed app
Plaid Link and the Enable Banking consent page navigate out of the app's scope, which iOS runs in a browser sheet that does not share the app's session.
- `PlaidConnect` (new connection and update/reconnect mode) renders `<DesktopOnlyBankNote />` (`pwa.banks.desktopOnly`) when `useIsStandalone()`. Plaid Link is never loaded there: the gate sits above the component that calls `usePlaidLink`.
- `EnableBankingConnect` renders nothing in standalone: every page that has it (Accounts, Onboarding) also renders `PlaidConnect`, whose note covers both.
- `BankConnectionCard` replaces the Enable Banking **Reconnect** button with the note. Sync now, Manage accounts and Disconnect stay; reviewing synced transactions is unaffected.

### Google Sign-In
Tested on a real iPhone (iOS, production): Google Sign-In completes inside the installed app, so it stays offered there. No standalone fallback is needed; email/password works as before.

### Resume freshness
`useResumeRefresh()` (mounted in `AppShell`) records when the page is hidden. Returning after at least `RESUME_REFRESH_AFTER_MS` (5 min) calls `queryClient.invalidateQueries({ refetchType: 'active' })` (the visible page refetches even inside its `staleTime`, which TanStack's focus refetch skips) and `checkForPwaUpdate(now, true)`.

### Keyboard and dialogs
When the iOS keyboard opens, only the *visual* viewport shrinks; `vh`-sized dialogs stay taller than what is visible, fields end up under the keyboard, and moving between them makes iOS pan the whole page (worst in standalone, with the status bar overlaid).
- `src/lib/pwa/visual-viewport.ts` (`installVisualViewportVars()`, from `main.tsx`) publishes `--vv-height` / `--vv-top` on `<html>` from `window.visualViewport`, updated per animation frame on its `resize` / `scroll`.
- `DialogContent` centres itself in the visible area (`top: calc(var(--vv-top) + var(--vv-height) / 2)`) and caps its height at 90 % of it, scrolling inside. With no keyboard both equal the old `50%` / `90vh`, so desktop is unchanged.
- The full-screen phone modals (`MOBILE_SHEET_CLASSES` in `lib/manage-assets.ts`, now also used by the Income Terms modal) take `--vv-height` instead of `100dvh`, pad themselves clear of the notch and home indicator, and move their close button below the status bar.
- When the keyboard closes and the document is not meant to scroll (the app shell is pinned), any leftover window scroll that iOS left behind is reset.
- In standalone, `html` / `body` get `overscroll-behavior: none` (no rubber-banding of the whole app).
- Selects are Radix components, not native `<select>`, so iOS never zooms on them; text inputs and textareas are already 16 px on phones.

### Safe areas on overlays
`components/ui/sheet.tsx` (side sheets pad top and bottom; the close button sits below the status bar; top/bottom sheets pad their outer edge) and `components/ui/drawer.tsx` (bottom drawers pad above the home indicator; top/side drawers pad the status bar). Class-only changes, 0 outside the installed app.

## 28.10. Phase 2b: phone layout pass

Measured at 390 × 844 against a locally seeded workspace (a year of transactions in EUR / USD / BRL with long bank descriptors, investments, a property and mortgage, a Plaid review queue with a failed row, insights, detected subscriptions) with a Playwright crawl that reports horizontal overflow per page and screenshots each one, then re-run after the changes. Every change is scoped below `sm` / `md`, so tablet and desktop are unchanged: screenshots of the touched pages at 1280 × 800 are pixel-identical before and after (apart from the "Updated N min ago" line).

**Page padding.** Transactions, Transaction Review, Subscriptions, Categories and Smart Import wrapped themselves in `p-6` inside `<main>`'s own padding — 40 px per side on a phone. They now use `md:p-6`; Settings uses `px-0 sm:px-7` and its cards `px-5 sm:px-7`. New pages should do the same: `<main>` already pads phones.

| Page | Phone change |
|---|---|
| Dashboard | Expense donut: no outside labels (they collided) and a larger ring; the legend under it lists every slice |
| Transactions | No empty column-header row; the amount column sizes to its content, so the description gets the width (date · category · account stay underneath). Filter drawer is a single full-width column (it was right-aligned in a column flex) |
| Transaction Review | Header stacks: title, then the failed badge and Bulk Promote; the tab strip scrolls on its own and the view toggle wraps below (the page scrolled sideways before). Group header: the name keeps its width and **Approve All** wraps below instead of squeezing the name to one letter; no empty Card gaps between header, divider and rows. Row actions (approve / skip / retry / diff) are 36 px touch targets |
| Subscriptions | Monthly and annual totals side by side, count below; merchant names up to two lines; cadence and next charge under the name (their columns are desktop-only); the rename pencil is always visible on touch screens (it was hover-only) |
| Portfolio | Liabilities: Edit Terms is an icon button with an accessible label, so the table fits |
| Settings | Label + description + button rows stack (they squeezed the label into a narrow column) |
| User management | Header stacks (title, then Create User); Status and Last login columns are desktop-only, last login shows under the name |
| Insights, Notifications, Accounts | Already fit; unchanged |

**Dialogs and sheets on touch devices** (`preventTouchAutoFocus` in `components/ui/utils.ts`, used by `DialogContent` and `SheetContent`): opening one no longer focuses its first field, which popped the keyboard over the form before the user chose a field. Fields with an explicit `autoFocus` still focus.

**Back navigation.** Detail views reachable from these pages already have a way back without browser chrome: the account detail panel and user management have a Back control; transaction edit, the review drawer and the Income Terms / Manage Assets modals close in place.

**Out of scope (unchanged):** Smart Import, Maintenance and the other Settings tabs only need to work; they do, with the padding change above.

import { registerSW } from 'virtual:pwa-register';

/**
 * Service worker registration and update orchestration (#155, PRD D3).
 *
 * A new build is detected by the browser's byte-diff of /sw.js (served
 * no-cache by nginx). When a new worker is waiting:
 *  - during the launch window (first LAUNCH_WINDOW_MS after load, before any
 *    pointer or key input) it is applied at once: skipWaiting + reload, so an
 *    app opened after a deploy runs the new build with no prompt;
 *  - later, PWA_NEED_REFRESH_EVENT is dispatched and <PwaUpdater /> shows a
 *    "New version available — Reload" toast. Nothing reloads under someone
 *    mid-edit; if the toast is ignored the waiting worker activates once every
 *    window has closed, so the next cold open runs the new build anyway.
 *
 * Called from main.tsx in production builds only.
 */

export const LAUNCH_WINDOW_MS = 10_000;
export const UPDATE_CHECK_THROTTLE_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000;
export const PWA_NEED_REFRESH_EVENT = 'pwa:need-refresh';

let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;
let registration: ServiceWorkerRegistration | undefined;
let lastUpdateCheck = 0;

export function registerPwa(now: () => number = Date.now): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const loadedAt = now();
  let interacted = false;
  const markInteracted = () => {
    interacted = true;
  };
  window.addEventListener('pointerdown', markInteracted, { once: true, capture: true });
  window.addEventListener('keydown', markInteracted, { once: true, capture: true });

  applyUpdate = registerSW({
    onNeedRefresh() {
      if (!interacted && now() - loadedAt <= LAUNCH_WINDOW_MS) {
        void applyPwaUpdate();
        return;
      }
      window.dispatchEvent(new Event(PWA_NEED_REFRESH_EVENT));
    },
    onRegisteredSW(_swUrl, reg) {
      registration = reg;
      if (!reg) return;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkForPwaUpdate(now);
      });
      setInterval(() => {
        if (document.visibilityState === 'visible') void checkForPwaUpdate(now, true);
      }, UPDATE_CHECK_INTERVAL_MS);
    },
  });
}

/**
 * Asks the browser to re-fetch /sw.js. Throttled to once per
 * UPDATE_CHECK_THROTTLE_MS unless `force`. Never throws: an offline check is
 * simply skipped.
 */
export async function checkForPwaUpdate(now: () => number = Date.now, force = false): Promise<void> {
  if (!registration) return;
  const at = now();
  if (!force && at - lastUpdateCheck < UPDATE_CHECK_THROTTLE_MS) return;
  lastUpdateCheck = at;
  try {
    await registration.update();
  } catch {
    // Offline or the server is unreachable: try again on the next trigger.
  }
}

/** Activates the waiting service worker and reloads the page. */
export function applyPwaUpdate(): Promise<void> {
  return applyUpdate ? applyUpdate(true) : Promise.resolve();
}

/** Test-only: forget module state between tests. */
export function resetPwaRegistrationForTests(): void {
  applyUpdate = null;
  registration = undefined;
  lastUpdateCheck = 0;
}

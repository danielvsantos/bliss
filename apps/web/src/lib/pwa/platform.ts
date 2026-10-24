/**
 * Platform and display-mode detection for the installable PWA (#155).
 * Pure functions over `window` / `navigator`, read on every call.
 */

export type InstallMode = 'standalone' | 'ios-instructions' | 'prompt' | 'unsupported';

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

/** True when running as an installed app (home screen / app window). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const displayModeStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  return displayModeStandalone || (navigator as NavigatorWithStandalone).standalone === true;
}

/** iPhone, iPod or iPad (iPadOS reports itself as a touch-capable Mac). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/**
 * How the "Install app" control behaves here:
 * - `standalone`: already installed — render nothing;
 * - `ios-instructions`: iOS has no install prompt — show Share → Add to Home Screen;
 * - `prompt`: the browser offered beforeinstallprompt — one-tap install;
 * - `unsupported`: neither (e.g. Firefox desktop) — render nothing.
 */
export function getInstallMode(canPrompt: boolean): InstallMode {
  if (isStandalone()) return 'standalone';
  if (isIOS()) return 'ios-instructions';
  if (canPrompt) return 'prompt';
  return 'unsupported';
}

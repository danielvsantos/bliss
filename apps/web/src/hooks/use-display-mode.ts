import { useSyncExternalStore } from 'react';
import { isStandalone } from '@/lib/pwa/platform';

const STANDALONE_QUERY = '(display-mode: standalone)';

function subscribe(callback: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(STANDALONE_QUERY);
  mql.addEventListener?.('change', callback);
  return () => mql.removeEventListener?.('change', callback);
}

function getServerSnapshot() {
  return false;
}

/**
 * Returns `true` when Bliss runs as an installed app (home screen on iOS,
 * app window on Android/desktop Chrome) — #155.
 */
export function useIsStandalone(): boolean {
  return useSyncExternalStore(subscribe, isStandalone, getServerSnapshot);
}

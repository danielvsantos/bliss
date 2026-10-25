import { useCallback, useSyncExternalStore } from 'react';
import {
  getDeferredInstallPrompt,
  promptInstall,
  subscribeInstallPrompt,
} from '@/lib/pwa/install-prompt';
import { getInstallMode, type InstallMode } from '@/lib/pwa/platform';
import { useIsStandalone } from './use-display-mode';

function getCanPrompt() {
  return getDeferredInstallPrompt() !== null;
}

/**
 * Install state for the "Install app" control (#155): which behaviour applies
 * on this device, and `install()` for the one-tap Chrome prompt.
 */
export function useInstallPrompt(): {
  mode: InstallMode;
  install: () => Promise<'accepted' | 'dismissed' | null>;
} {
  const canPrompt = useSyncExternalStore(subscribeInstallPrompt, getCanPrompt, () => false);
  // Subscribing keeps `mode` current when the app switches into standalone
  // (e.g. right after a desktop install).
  useIsStandalone();
  const install = useCallback(() => promptInstall(), []);
  return { mode: getInstallMode(canPrompt), install };
}

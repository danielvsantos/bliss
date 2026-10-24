/**
 * Captures Chrome's `beforeinstallprompt` event (#155).
 *
 * Imported for its side effect from main.tsx, before React mounts: Chrome can
 * fire the event before any component exists, and it is fired only once per
 * page load. use-install-prompt.ts subscribes to the captured event.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep Chrome's mini-infobar from showing; our own control triggers it.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Shows the native install prompt. The event can be used once, so it is
 * cleared whatever the outcome. Returns the outcome, or null when there was
 * no prompt to show.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
  const event = deferredPrompt;
  if (!event) return null;
  deferredPrompt = null;
  notify();
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome;
}

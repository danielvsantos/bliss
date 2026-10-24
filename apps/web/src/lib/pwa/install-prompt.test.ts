import { describe, it, expect, vi } from 'vitest';
import { getDeferredInstallPrompt, promptInstall, subscribeInstallPrompt } from './install-prompt';

function fakeInstallPromptEvent(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  return Object.assign(event, {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  });
}

describe('beforeinstallprompt capture (#155)', () => {
  it('captures the event, suppresses the mini-infobar and prompts exactly once', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInstallPrompt(listener);
    expect(await promptInstall()).toBeNull();

    const event = fakeInstallPromptEvent('accepted');
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(getDeferredInstallPrompt()).toBe(event);
    expect(listener).toHaveBeenCalled();

    expect(await promptInstall()).toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    // The event is single-use.
    expect(getDeferredInstallPrompt()).toBeNull();
    expect(await promptInstall()).toBeNull();
    unsubscribe();
  });

  it('forgets the prompt once the app is installed', () => {
    window.dispatchEvent(fakeInstallPromptEvent('dismissed'));
    expect(getDeferredInstallPrompt()).not.toBeNull();
    window.dispatchEvent(new Event('appinstalled'));
    expect(getDeferredInstallPrompt()).toBeNull();
  });
});

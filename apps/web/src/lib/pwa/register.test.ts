import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pwaRegisterMock, updateSW } from '@/test/mocks/pwa-register';
import {
  registerPwa,
  checkForPwaUpdate,
  resetPwaRegistrationForTests,
  LAUNCH_WINDOW_MS,
  UPDATE_CHECK_THROTTLE_MS,
  PWA_NEED_REFRESH_EVENT,
} from './register';

describe('registerPwa — update orchestration (#155, PRD D3)', () => {
  let clock = 0;
  const now = () => clock;
  const onNeedRefreshEvent = vi.fn();

  beforeEach(() => {
    clock = 1_000_000;
    vi.clearAllMocks();
    resetPwaRegistrationForTests();
    pwaRegisterMock.lastOptions = null;
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    window.addEventListener(PWA_NEED_REFRESH_EVENT, onNeedRefreshEvent);
  });

  afterEach(() => {
    window.removeEventListener(PWA_NEED_REFRESH_EVENT, onNeedRefreshEvent);
  });

  it('applies a waiting build at once during the launch window (no prompt)', () => {
    registerPwa(now);
    clock += LAUNCH_WINDOW_MS - 1;
    pwaRegisterMock.lastOptions?.onNeedRefresh?.();
    expect(updateSW).toHaveBeenCalledWith(true);
    expect(onNeedRefreshEvent).not.toHaveBeenCalled();
  });

  it('asks via the toast event once the launch window has passed', () => {
    registerPwa(now);
    clock += LAUNCH_WINDOW_MS + 1;
    pwaRegisterMock.lastOptions?.onNeedRefresh?.();
    expect(updateSW).not.toHaveBeenCalled();
    expect(onNeedRefreshEvent).toHaveBeenCalledTimes(1);
  });

  it('never reloads after the user has interacted, even inside the window', () => {
    registerPwa(now);
    window.dispatchEvent(new Event('pointerdown'));
    pwaRegisterMock.lastOptions?.onNeedRefresh?.();
    expect(updateSW).not.toHaveBeenCalled();
    expect(onNeedRefreshEvent).toHaveBeenCalledTimes(1);
  });

  it('checks for a new worker when the app becomes visible, throttled', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    registerPwa(now);
    pwaRegisterMock.lastOptions?.onRegisteredSW?.('/sw.js', { update } as unknown as ServiceWorkerRegistration);

    await checkForPwaUpdate(now);
    await checkForPwaUpdate(now);
    expect(update).toHaveBeenCalledTimes(1);

    clock += UPDATE_CHECK_THROTTLE_MS;
    await checkForPwaUpdate(now);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed update check (offline)', async () => {
    const update = vi.fn().mockRejectedValue(new Error('offline'));
    registerPwa(now);
    pwaRegisterMock.lastOptions?.onRegisteredSW?.('/sw.js', { update } as unknown as ServiceWorkerRegistration);
    await expect(checkForPwaUpdate(now)).resolves.toBeUndefined();
  });

  it('does nothing without service worker support', () => {
    // @ts-expect-error — simulate a browser without the API
    delete navigator.serviceWorker;
    registerPwa(now);
    expect(pwaRegisterMock.lastOptions).toBeNull();
  });
});

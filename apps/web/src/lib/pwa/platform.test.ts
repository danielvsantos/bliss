import { describe, it, expect, afterEach, vi } from 'vitest';
import { getInstallMode, isIOS, isStandalone } from './platform';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

function setNavigator(ua: string, platform = 'Linux x86_64', maxTouchPoints = 0, standalone?: boolean) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
  Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
}

function setDisplayModeStandalone(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(display-mode: standalone)' ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('PWA platform detection (#155)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects iPhone and iPadOS (touch Mac) as iOS', () => {
    setNavigator(IPHONE_UA);
    expect(isIOS()).toBe(true);
    setNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5);
    expect(isIOS()).toBe(true);
    setNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0);
    expect(isIOS()).toBe(false);
  });

  it('is standalone via display-mode or the iOS navigator.standalone flag', () => {
    setNavigator(ANDROID_UA);
    setDisplayModeStandalone(true);
    expect(isStandalone()).toBe(true);
    setDisplayModeStandalone(false);
    expect(isStandalone()).toBe(false);
    setNavigator(IPHONE_UA, 'iPhone', 5, true);
    expect(isStandalone()).toBe(true);
  });

  it('picks the install mode', () => {
    setDisplayModeStandalone(false);
    setNavigator(IPHONE_UA, 'iPhone', 5);
    expect(getInstallMode(false)).toBe('ios-instructions');
    setNavigator(ANDROID_UA);
    expect(getInstallMode(true)).toBe('prompt');
    expect(getInstallMode(false)).toBe('unsupported');
    setDisplayModeStandalone(true);
    expect(getInstallMode(true)).toBe('standalone');
  });
});

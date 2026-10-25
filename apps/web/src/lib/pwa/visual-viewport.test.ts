import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installVisualViewportVars } from './visual-viewport';

class FakeVisualViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
}

describe('installVisualViewportVars (#155)', () => {
  let vv: FakeVisualViewport;
  let uninstall: () => void;
  const scrollTo = vi.fn();

  beforeEach(() => {
    vv = new FakeVisualViewport();
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    scrollTo.mockClear();
    uninstall = installVisualViewportVars();
  });

  afterEach(() => {
    uninstall();
    vi.restoreAllMocks();
  });

  const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);

  it('publishes the visible area and follows the keyboard', () => {
    expect(cssVar('--vv-height')).toBe('844px');
    vv.height = 480;
    vv.offsetTop = 120;
    vv.dispatchEvent(new Event('resize'));
    expect(cssVar('--vv-height')).toBe('480px');
    expect(cssVar('--vv-top')).toBe('120px');
  });

  it('resets a pan left behind when the keyboard closes', () => {
    Object.defineProperty(window, 'scrollY', { value: 140, configurable: true });
    vv.height = 844;
    vv.dispatchEvent(new Event('resize'));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('never resets the scroll while the keyboard is open', () => {
    Object.defineProperty(window, 'scrollY', { value: 140, configurable: true });
    vv.height = 480;
    vv.dispatchEvent(new Event('resize'));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

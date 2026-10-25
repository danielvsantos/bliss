import { describe, it, expect, vi, afterEach } from 'vitest';
import { preventTouchAutoFocus } from './utils';

function setCoarsePointer(coarse: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('preventTouchAutoFocus (#155)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the keyboard down on touch devices', () => {
    setCoarsePointer(true);
    const event = new Event('focus.autoFocusOnMount', { cancelable: true });
    preventTouchAutoFocus()(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves auto-focus alone with a mouse, and calls the caller handler first', () => {
    setCoarsePointer(false);
    const handler = vi.fn();
    const event = new Event('focus.autoFocusOnMount', { cancelable: true });
    preventTouchAutoFocus(handler)(event);
    expect(handler).toHaveBeenCalledWith(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

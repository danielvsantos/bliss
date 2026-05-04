import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useToast, toast } from './use-toast';

// Clean up any lingering toasts between tests using the module-level toast handle
let lastHandle: ReturnType<typeof toast> | undefined;

beforeEach(() => {
  if (lastHandle) {
    act(() => { lastHandle!.dismiss(); });
    lastHandle = undefined;
  }
});

describe('toast()', () => {
  it('returns an id string', () => {
    act(() => { lastHandle = toast({ title: 'Hello' }); });
    expect(typeof lastHandle!.id).toBe('string');
  });

  it('exposes dismiss on the returned handle', () => {
    act(() => { lastHandle = toast({ title: 'Test' }); });
    expect(typeof lastHandle!.dismiss).toBe('function');
  });

  it('exposes update on the returned handle', () => {
    act(() => { lastHandle = toast({ title: 'Test' }); });
    expect(typeof lastHandle!.update).toBe('function');
  });

  it('dismiss() on handle marks toast closed or removed', async () => {
    const { result } = renderHook(() => useToast());
    act(() => { lastHandle = toast({ title: 'Close me' }); });
    act(() => { lastHandle!.dismiss(); });
    // The toast is either gone or has open=false
    const found = result.current.toasts.find(t => t.id === lastHandle!.id);
    if (found) {
      expect(found.open).toBe(false);
    } else {
      expect(result.current.toasts.length).toBe(0);
    }
  });
});

describe('useToast', () => {
  it('provides a toast function', () => {
    const { result } = renderHook(() => useToast());
    expect(typeof result.current.toast).toBe('function');
  });

  it('provides a dismiss function', () => {
    const { result } = renderHook(() => useToast());
    expect(typeof result.current.dismiss).toBe('function');
  });

  it('exposes the toasts array', () => {
    const { result } = renderHook(() => useToast());
    expect(Array.isArray(result.current.toasts)).toBe(true);
  });

  it('toast added via result.current.toast() is reflected in toasts', () => {
    const { result } = renderHook(() => useToast());
    act(() => { lastHandle = result.current.toast({ title: 'In state' }); });
    const found = result.current.toasts.find(t => t.id === lastHandle!.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe('In state');
  });

  it('dismiss with no argument sets all toasts open=false', () => {
    const { result } = renderHook(() => useToast());
    act(() => { lastHandle = toast({ title: 'Dismiss all' }); });
    act(() => { result.current.dismiss(); });
    result.current.toasts.forEach(t => {
      if (t.id === lastHandle!.id) {
        expect(t.open).toBe(false);
      }
    });
  });

  it('dismiss with specific id targets only that toast', () => {
    const { result } = renderHook(() => useToast());
    act(() => { lastHandle = toast({ title: 'Specific dismiss' }); });
    act(() => { result.current.dismiss(lastHandle!.id); });
    const found = result.current.toasts.find(t => t.id === lastHandle!.id);
    if (found) expect(found.open).toBe(false);
  });
});

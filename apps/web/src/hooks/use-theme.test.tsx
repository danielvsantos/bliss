import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import { ThemeProviderContext, type ThemeProviderState } from '@/lib/theme-context';
import { useTheme } from './use-theme';

const createWrapper = (value: ThemeProviderState) =>
  ({ children }: { children: React.ReactNode }) => (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );

describe('useTheme', () => {
  it('returns the current theme from context', () => {
    const mockCtx: ThemeProviderState = { theme: 'dark', setTheme: () => {} };
    const { result } = renderHook(() => useTheme(), { wrapper: createWrapper(mockCtx) });
    expect(result.current.theme).toBe('dark');
  });

  it('returns setTheme function from context', () => {
    const setTheme = () => {};
    const mockCtx: ThemeProviderState = { theme: 'light', setTheme };
    const { result } = renderHook(() => useTheme(), { wrapper: createWrapper(mockCtx) });
    expect(result.current.setTheme).toBe(setTheme);
  });

  it('returns light theme', () => {
    const mockCtx: ThemeProviderState = { theme: 'light', setTheme: () => {} };
    const { result } = renderHook(() => useTheme(), { wrapper: createWrapper(mockCtx) });
    expect(result.current.theme).toBe('light');
  });

  it('returns system theme', () => {
    const mockCtx: ThemeProviderState = { theme: 'system', setTheme: () => {} };
    const { result } = renderHook(() => useTheme(), { wrapper: createWrapper(mockCtx) });
    expect(result.current.theme).toBe('system');
  });

  it('returns the default system theme when used without a provider', () => {
    // ThemeProviderContext has initialState = { theme: 'system', setTheme: () => null }
    // so useTheme() will not throw — it returns the default context value.
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('system');
  });
});

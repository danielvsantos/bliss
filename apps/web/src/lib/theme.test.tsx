import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThemeProvider } from './theme';

function preferDark(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? dark : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('ThemeProvider default', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
  });

  it('is light with empty storage even when the device prefers dark (installed PWA, #155)', () => {
    preferDark(true);
    act(() => {
      render(<ThemeProvider><div /></ThemeProvider>);
    });
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('still honours a stored theme', () => {
    preferDark(false);
    window.localStorage.setItem('bliss-ui-theme', 'dark');
    act(() => {
      render(<ThemeProvider><div /></ThemeProvider>);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

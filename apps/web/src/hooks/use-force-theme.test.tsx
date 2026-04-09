import React from 'react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useForceTheme } from './use-force-theme';

// Mock dependencies
const mockSetTheme = vi.fn();
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ setTheme: mockSetTheme }),
}));

let mockPathname = '/dashboard';
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: mockPathname }),
}));

describe('useForceTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/dashboard';
  });

  it('returns null', () => {
    const { result } = renderHook(() => useForceTheme());
    expect(result.current).toBeNull();
  });

  it('does not set theme on non-auth pages', () => {
    mockPathname = '/dashboard';
    renderHook(() => useForceTheme());
    expect(mockSetTheme).not.toHaveBeenCalled();
  });

  it('sets theme to light on the auth page', () => {
    mockPathname = '/auth';
    renderHook(() => useForceTheme());
    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });
});

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { api } from '@/lib/api';
import { useManualAssetValues } from './use-manual-asset-values';
import type { ManualAssetValue } from '@/types/api';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

const row: ManualAssetValue = {
  id: 'v1',
  date: '2026-01-31',
  value: 1000,
  currency: 'USD',
  notes: 'Q1 statement',
  createdAt: '2026-02-01T10:00:00.000Z',
  updatedAt: '2026-02-01T10:00:00.000Z',
};

describe('useManualAssetValues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not fetch when itemId is undefined', () => {
    const { result } = renderHook(() => useManualAssetValues(undefined), {
      wrapper: createWrapper(),
    });

    expect(api.getManualAssetValues).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('does not fetch when itemId is null', () => {
    renderHook(() => useManualAssetValues(null), { wrapper: createWrapper() });
    expect(api.getManualAssetValues).not.toHaveBeenCalled();
  });

  it('fetches the history for a given itemId', async () => {
    vi.mocked(api.getManualAssetValues).mockResolvedValueOnce([row]);

    const { result } = renderHook(() => useManualAssetValues(42), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getManualAssetValues).toHaveBeenCalledWith(42);
    expect(result.current.data).toEqual([row]);
  });

  it('surfaces an error when the request fails', async () => {
    vi.mocked(api.getManualAssetValues).mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useManualAssetValues(7), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

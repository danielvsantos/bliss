import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { useSyncLogs } from './use-sync-logs';

vi.mock('@/lib/api');
vi.mock('./use-plaid-actions', () => ({
  plaidItemKeys: {
    all: ['plaid-items'] as const,
    syncLogs: (plaidItemId: string) => ['plaid-sync-logs', plaidItemId] as const,
  },
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
};

describe('useSyncLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches sync logs when plaidItemId provided', async () => {
    const mockLogs = [
      { id: 1, status: 'success', createdAt: '2024-01-15T10:00:00Z' },
      { id: 2, status: 'error', createdAt: '2024-01-14T10:00:00Z' },
    ];
    vi.mocked(api.getPlaidSyncLogs).mockResolvedValueOnce(
      mockLogs as unknown as Awaited<ReturnType<typeof api.getPlaidSyncLogs>>,
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSyncLogs('plaid-item-123'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getPlaidSyncLogs).toHaveBeenCalledWith('plaid-item-123', 10);
    expect(result.current.data).toEqual(mockLogs);
  });

  it('does not fetch when plaidItemId is null', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSyncLogs(null), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(api.getPlaidSyncLogs).not.toHaveBeenCalled();
  });
});

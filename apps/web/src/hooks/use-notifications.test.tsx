import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/api';
import React from 'react';
import { useNotificationSummary, useMarkNotificationsSeen } from './use-notifications';

vi.mock('@/lib/api', () => ({
  default: {
    getNotificationSummary: vi.fn(),
    markNotificationsSeen: vi.fn(),
  },
}));

vi.mock('@/hooks/use-page-visible', () => ({
  usePageVisible: () => true,
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
    queryClient,
  };
};

describe('useNotificationSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches notification summary', async () => {
    const mockSummary = { totalUnseen: 3, lastSeenAt: null, signals: [] };
    vi.mocked(api.getNotificationSummary).mockResolvedValueOnce(mockSummary);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useNotificationSummary(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getNotificationSummary).toHaveBeenCalledOnce();
    expect(result.current.data).toEqual(mockSummary);
  });
});

describe('useMarkNotificationsSeen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls API and invalidates cache', async () => {
    vi.mocked(api.markNotificationsSeen).mockResolvedValueOnce(undefined);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useMarkNotificationsSeen(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(api.markNotificationsSeen).toHaveBeenCalledOnce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notification-summary'] });
  });
});

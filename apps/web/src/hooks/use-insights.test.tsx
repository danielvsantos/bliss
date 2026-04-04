import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/api';
import React from 'react';
import { useInsights, useDismissInsight, useGenerateInsights } from './use-insights';

vi.mock('@/lib/api', () => ({
  default: {
    getInsights: vi.fn(),
    dismissInsight: vi.fn(),
    generateInsights: vi.fn(),
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
    queryClient,
  };
};

describe('useInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches insights', async () => {
    const mockInsights = {
      insights: [
        { id: 'ins-1', lens: 'spending_velocity', title: 'Spending up', severity: 'warning' },
      ],
      total: 1,
    };
    vi.mocked(api.getInsights).mockResolvedValueOnce(mockInsights as any);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useInsights({ limit: 10 }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getInsights).toHaveBeenCalledWith({ limit: 10 });
    expect(result.current.data).toEqual(mockInsights);
  });
});

describe('useDismissInsight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls dismiss and invalidates', async () => {
    vi.mocked(api.dismissInsight).mockResolvedValueOnce(undefined as any);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDismissInsight(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ insightId: 'ins-1', dismissed: true });
    });

    expect(api.dismissInsight).toHaveBeenCalledWith('ins-1', true);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['insights'] });
  });
});

describe('useGenerateInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('triggers generation', async () => {
    vi.mocked(api.generateInsights).mockResolvedValueOnce(undefined as any);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useGenerateInsights(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(api.generateInsights).toHaveBeenCalledOnce();

    // The invalidation happens after a 5-second setTimeout
    vi.advanceTimersByTime(5000);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['insights'] });

    vi.useRealTimers();
  });
});

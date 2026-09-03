import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { usePortfolioHistory, HISTORY_QUERY_KEY } from './use-portfolio-history';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
  };
};

describe('usePortfolioHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches portfolio history with resolution overrides', async () => {
    vi.mocked(api.getPortfolioHistory).mockResolvedValueOnce({
      portfolioCurrency: 'USD',
      resolution: 'weekly',
      history: [{ date: '2023-01-01' }]
    } as unknown as Awaited<ReturnType<typeof api.getPortfolioHistory>>);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioHistory({ from: '2023-01-01', resolution: 'weekly' }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    
    expect(api.getPortfolioHistory).toHaveBeenCalledWith({ from: '2023-01-01', resolution: 'weekly' });
    expect(result.current.data?.history.length).toBe(1);
    expect(result.current.data?.resolution).toBe('weekly');
  });

  it('does not refetch on a second mount within the freshness window', async () => {
    vi.mocked(api.getPortfolioHistory).mockResolvedValue({
      portfolioCurrency: 'USD',
      resolution: 'weekly',
      history: [],
    } as unknown as Awaited<ReturnType<typeof api.getPortfolioHistory>>);

    const { wrapper } = createWrapper();
    const { result, unmount } = renderHook(() => usePortfolioHistory(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getPortfolioHistory).toHaveBeenCalledTimes(1);

    unmount();
    const { result: result2 } = renderHook(() => usePortfolioHistory(), { wrapper });
    await waitFor(() => expect(result2.current.isSuccess).toBe(true));

    expect(api.getPortfolioHistory).toHaveBeenCalledTimes(1);
  });

  it('refetches immediately when the portfolio-history key is invalidated', async () => {
    vi.mocked(api.getPortfolioHistory).mockResolvedValue({
      portfolioCurrency: 'USD',
      resolution: 'weekly',
      history: [],
    } as unknown as Awaited<ReturnType<typeof api.getPortfolioHistory>>);

    const { wrapper, queryClient } = createWrapper();
    const { result } = renderHook(() => usePortfolioHistory(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getPortfolioHistory).toHaveBeenCalledTimes(1);

    await queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY] });

    await waitFor(() => expect(api.getPortfolioHistory).toHaveBeenCalledTimes(2));
  });
});

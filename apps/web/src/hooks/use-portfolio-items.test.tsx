import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { usePortfolioItems, PORTFOLIO_ITEMS_QUERY_KEY } from './use-portfolio-items';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
  };
};

describe('usePortfolioItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports the correct query key constant', () => {
    expect(PORTFOLIO_ITEMS_QUERY_KEY).toBe('portfolio-items');
  });

  it('fetches portfolio items with manual values flag', async () => {
    vi.mocked(api.getPortfolioItems).mockResolvedValueOnce({
      portfolioCurrency: 'USD',
      items: [{ id: 1, name: 'Apple' }]
    } as unknown as Awaited<ReturnType<typeof api.getPortfolioItems>>);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioItems({ includeManualValues: true }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getPortfolioItems).toHaveBeenCalledWith({ include_manual_values: true });
    expect(result.current.data?.items.length).toBe(1);
    expect(result.current.data?.portfolioCurrency).toBe('USD');
  });

  it('starts in loading state without manual values flag', () => {
    vi.mocked(api.getPortfolioItems).mockReturnValue(new Promise(() => {}));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioItems(), { wrapper });
    expect(result.current.isLoading).toBe(true);
  });

  it('calls api without include_manual_values when option is not set', async () => {
    vi.mocked(api.getPortfolioItems).mockResolvedValueOnce({
      portfolioCurrency: 'EUR',
      items: [],
    } as unknown as Awaited<ReturnType<typeof api.getPortfolioItems>>);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioItems(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getPortfolioItems).toHaveBeenCalledWith({ include_manual_values: undefined });
  });

  it('handles API error', async () => {
    vi.mocked(api.getPortfolioItems).mockRejectedValueOnce(new Error('Network error'));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioItems(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

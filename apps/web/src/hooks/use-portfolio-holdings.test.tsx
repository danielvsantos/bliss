import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { usePortfolioHoldings } from './use-portfolio-holdings';

vi.mock('@/lib/api');

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

describe('usePortfolioHoldings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches holdings without filters', async () => {
    const mockHoldings = [
      { id: 1, ticker: 'AAPL', quantity: 10, currentValue: 1500 },
      { id: 2, ticker: 'MSFT', quantity: 5, currentValue: 2000 },
    ];
    vi.mocked(api.getPortfolioHoldings).mockResolvedValueOnce(mockHoldings as any);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioHoldings(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getPortfolioHoldings).toHaveBeenCalledWith({});
    expect(result.current.data).toEqual(mockHoldings);
  });

  it('passes filters to API call', async () => {
    const mockHoldings = [{ id: 1, ticker: 'AAPL', quantity: 10, currentValue: 1500 }];
    vi.mocked(api.getPortfolioHoldings).mockResolvedValueOnce(mockHoldings as any);

    const filters = { account: 'brokerage', category: 'stocks', ticker: 'AAPL' };
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioHoldings(filters), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getPortfolioHoldings).toHaveBeenCalledWith(filters);
    expect(result.current.data).toEqual(mockHoldings);
  });
});

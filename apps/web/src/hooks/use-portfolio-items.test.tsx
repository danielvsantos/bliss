import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { usePortfolioItems } from './use-portfolio-items';

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

  it('fetches portfolio items with manual values flag', async () => {
    vi.mocked(api.getPortfolioItems).mockResolvedValueOnce({
      portfolioCurrency: 'USD',
      items: [{ id: 1, name: 'Apple' }]
    } as any);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioItems({ includeManualValues: true }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    
    expect(api.getPortfolioItems).toHaveBeenCalledWith({ include_manual_values: true });
    expect(result.current.data?.items.length).toBe(1);
    expect(result.current.data?.portfolioCurrency).toBe('USD');
  });
});

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { usePortfolioHistory } from './use-portfolio-history';

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
});

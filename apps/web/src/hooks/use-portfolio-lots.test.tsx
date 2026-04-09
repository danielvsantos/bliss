import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { usePortfolioLots } from './use-portfolio-lots';

vi.mock('@/lib/api', () => {
  const mockApi = {
    getPortfolioLots: vi.fn(),
  };
  return {
    api: mockApi,
  };
});

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

describe('usePortfolioLots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches lots when assetId is provided', async () => {
    const mockLots = [
      { id: 1, quantity: 10, costBasis: 150, date: '2024-01-01' },
      { id: 2, quantity: 5, costBasis: 160, date: '2024-02-01' },
    ];
    vi.mocked(api.getPortfolioLots).mockResolvedValueOnce(
      mockLots as unknown as Awaited<ReturnType<typeof api.getPortfolioLots>>,
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioLots(42), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getPortfolioLots).toHaveBeenCalledWith(42);
    expect(result.current.data).toEqual(mockLots);
  });

  it('does not fetch when assetId is null (enabled: false)', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePortfolioLots(null), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(api.getPortfolioLots).not.toHaveBeenCalled();
  });
});

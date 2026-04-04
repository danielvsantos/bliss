import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { useEquityAnalysis } from './use-equity-analysis';

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

const mockData = {
  summary: { totalEquityValue: 10000, holdingsCount: 3 },
  groups: [
    {
      name: 'Technology',
      totalValue: 7000,
      holdingsCount: 2,
      weight: 0.7,
      holdings: [
        { ticker: 'AAPL', currentValue: 4000, country: 'US', sector: 'Technology' },
        { ticker: 'MSFT', currentValue: 3000, country: 'US', sector: 'Technology' },
      ],
    },
    {
      name: 'Healthcare',
      totalValue: 3000,
      holdingsCount: 1,
      weight: 0.3,
      holdings: [
        { ticker: 'JNJ', currentValue: 3000, country: 'CH', sector: 'Healthcare' },
      ],
    },
  ],
};

describe('useEquityAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches equity analysis data', async () => {
    vi.mocked(api.getEquityAnalysis).mockResolvedValueOnce(mockData as any);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useEquityAnalysis('sector'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getEquityAnalysis).toHaveBeenCalledWith({ groupBy: 'sector' });
    expect(result.current.data?.groups).toHaveLength(2);
    expect(result.current.data?.groups[0].name).toBe('Technology');
  });

  it('re-groups by country when groupBy changes (client-side)', async () => {
    vi.mocked(api.getEquityAnalysis).mockResolvedValueOnce(mockData as any);

    const { wrapper } = createWrapper();
    // First render with sector (default fetch)
    const { result, rerender } = renderHook(
      ({ groupBy }) => useEquityAnalysis(groupBy),
      { wrapper, initialProps: { groupBy: 'sector' } },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Now switch to country grouping — should NOT trigger a new API call
    rerender({ groupBy: 'country' });

    await waitFor(() => {
      expect(result.current.data?.groups).toBeDefined();
      // Should now be grouped by country: US and CH
      const groupNames = result.current.data!.groups.map(g => g.name);
      expect(groupNames).toContain('US');
      expect(groupNames).toContain('CH');
    });

    // Still only one API call (client-side regrouping, not a refetch)
    expect(api.getEquityAnalysis).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when no data', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useEquityAnalysis('sector'), { wrapper });

    // Before any data loads, data should be undefined
    expect(result.current.data).toBeUndefined();
  });
});

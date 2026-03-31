import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { useAnalytics } from './use-analytics';

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

describe('useAnalytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not fetch if required filters are missing', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAnalytics({ view: 'year', years: [] }), { wrapper });
    
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.getAnalytics).not.toHaveBeenCalled();
  });

  it('fetches data when valid filters are provided', async () => {
    vi.mocked(api.getAnalytics).mockResolvedValueOnce({
      totalInflow: 1000,
      totalOutflow: 500,
      flows: [],
      monthlyBreakdown: [],
      yearlyBreakdown: [],
      quarterlyBreakdown: [],
      groupBreakdown: [],
      typeBreakdown: [],
    } as any);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAnalytics({ view: 'year', years: [2023] }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    
    expect(api.getAnalytics).toHaveBeenCalledWith({ view: 'year', years: [2023] });
    expect(result.current.data?.totalInflow).toBe(1000);
  });
});

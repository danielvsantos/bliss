import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTickerSearch } from './use-ticker-search';

vi.mock('@/lib/api', () => {
  const mockApi = {
    searchTickers: vi.fn(),
  };
  return { default: mockApi, api: mockApi };
});

import api from '@/lib/api';

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useTickerSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('searches when query is >= 2 characters', async () => {
    const mockResults = [
      { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', country: 'US', currency: 'USD', type: 'Common Stock', mic_code: 'XNAS' },
    ];
    vi.mocked(api.searchTickers).mockResolvedValue({ results: mockResults });

    const { result } = renderHook(() => useTickerSearch('AA'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockResults);
    expect(api.searchTickers).toHaveBeenCalledWith('AA', undefined);
  });

  it('does not search when query is empty', () => {
    const { result } = renderHook(() => useTickerSearch(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(api.searchTickers).not.toHaveBeenCalled();
  });

  it('does not search when query is only 1 character', () => {
    const { result } = renderHook(() => useTickerSearch('A'), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(api.searchTickers).not.toHaveBeenCalled();
  });

  it('passes searchType to the API', async () => {
    vi.mocked(api.searchTickers).mockResolvedValue({ results: [] });

    const { result } = renderHook(() => useTickerSearch('BTC', 'crypto'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.searchTickers).toHaveBeenCalledWith('BTC', 'crypto');
  });
});

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { useCurrencyRates } from './use-currency-rates';

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

describe('useCurrencyRates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches rates for non-USD currencies', async () => {
    const mockRates = [{ currencyFrom: 'EUR', currencyTo: 'USD', rate: 1.08, date: '2024-01-15' }];
    vi.mocked(api.getCurrencyRates).mockResolvedValueOnce(mockRates);

    const { wrapper } = createWrapper();
    const testDate = new Date('2024-01-15T00:00:00Z');
    const { result } = renderHook(() => useCurrencyRates(['EUR'], testDate), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(api.getCurrencyRates).toHaveBeenCalledWith({
      currencyFrom: 'EUR',
      currencyTo: 'USD',
      year: 2024,
      month: 1,
      day: 15,
    });
    expect(result.current.data).toEqual(mockRates);
  });

  it('filters out USD from query list', async () => {
    const mockRates = [{ currencyFrom: 'GBP', currencyTo: 'USD', rate: 1.27, date: '2024-01-15' }];
    vi.mocked(api.getCurrencyRates).mockResolvedValueOnce(mockRates);

    const { wrapper } = createWrapper();
    const testDate = new Date('2024-01-15T00:00:00Z');
    const { result } = renderHook(() => useCurrencyRates(['USD', 'GBP'], testDate), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Should only call for GBP, not USD
    expect(api.getCurrencyRates).toHaveBeenCalledTimes(1);
    expect(api.getCurrencyRates).toHaveBeenCalledWith(
      expect.objectContaining({ currencyFrom: 'GBP' }),
    );
  });

  it('returns combined rates from multiple currencies', async () => {
    const eurRates = [{ currencyFrom: 'EUR', currencyTo: 'USD', rate: 1.08 }];
    const gbpRates = [{ currencyFrom: 'GBP', currencyTo: 'USD', rate: 1.27 }];
    vi.mocked(api.getCurrencyRates)
      .mockResolvedValueOnce(eurRates)
      .mockResolvedValueOnce(gbpRates);

    const { wrapper } = createWrapper();
    const testDate = new Date('2024-01-15T00:00:00Z');
    const { result } = renderHook(() => useCurrencyRates(['EUR', 'GBP'], testDate), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ currencyFrom: 'EUR' }),
      expect.objectContaining({ currencyFrom: 'GBP' }),
    ]));
  });

  it('returns isLoading while fetching', () => {
    vi.mocked(api.getCurrencyRates).mockReturnValue(new Promise(() => {})); // never resolves

    const { wrapper } = createWrapper();
    const testDate = new Date('2024-01-15T00:00:00Z');
    const { result } = renderHook(() => useCurrencyRates(['EUR'], testDate), { wrapper });

    expect(result.current.isLoading).toBe(true);
  });
});

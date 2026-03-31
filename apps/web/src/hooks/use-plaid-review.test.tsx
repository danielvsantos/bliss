import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import {
  usePlaidTransactions,
  useUpdatePlaidTransaction,
  useBulkPromotePlaidTransactions,
  usePlaidSeeds,
  useConfirmPlaidSeeds,
  plaidReviewKeys
} from './use-plaid-review';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
    queryClient
  };
};

describe('Plaid Review Hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('usePlaidTransactions', () => {
    it('fetches transactions and handles params correctly', async () => {
      vi.mocked(api.getPlaidTransactions).mockResolvedValueOnce({
        transactions: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 1
      });

      const { wrapper } = createWrapper();
      const params = { limit: 10, promotionStatus: 'PENDING' };
      
      const { result } = renderHook(() => usePlaidTransactions(params), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      
      expect(api.getPlaidTransactions).toHaveBeenCalledWith(params);
    });
  });

  describe('useUpdatePlaidTransaction', () => {
    it('calls api.updatePlaidTransaction and invalidates queries', async () => {
      vi.mocked(api.updatePlaidTransaction).mockResolvedValueOnce({ success: true });
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useUpdatePlaidTransaction(), { wrapper });

      act(() => {
        result.current.mutate({ id: 'txn-1', data: { promotionStatus: 'PROMOTED' } });
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(api.updatePlaidTransaction).toHaveBeenCalledWith('txn-1', { promotionStatus: 'PROMOTED' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: plaidReviewKeys.all });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['transactions'] });
    });
  });

  describe('useBulkPromotePlaidTransactions', () => {
    it('calls api.bulkPromotePlaidTransactions', async () => {
      vi.mocked(api.bulkPromotePlaidTransactions).mockResolvedValueOnce({ promotedCount: 5 });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useBulkPromotePlaidTransactions(), { wrapper });

      act(() => {
        result.current.mutate({ plaidItemId: '123' });
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.bulkPromotePlaidTransactions).toHaveBeenCalledWith({ plaidItemId: '123' });
    });
  });

  describe('usePlaidSeeds', () => {
    it('does not fetch when plaidItemId is null', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => usePlaidSeeds(null), { wrapper });

      expect(result.current.fetchStatus).toBe('idle');
      expect(api.getPlaidSeeds).not.toHaveBeenCalled();
    });

    it('fetches when plaidItemId is provided', async () => {
      vi.mocked(api.getPlaidSeeds).mockResolvedValueOnce([{ description: 'Target', categoryId: 1, count: 5 }]);
      const { wrapper } = createWrapper();
      
      const { result } = renderHook(() => usePlaidSeeds('pid-1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.getPlaidSeeds).toHaveBeenCalledWith('pid-1', undefined);
    });
  });

  describe('useConfirmPlaidSeeds', () => {
    it('calls api.confirmPlaidSeeds and invalidates seed queries', async () => {
      vi.mocked(api.confirmPlaidSeeds).mockResolvedValueOnce({ updatedCount: 2 });
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useConfirmPlaidSeeds(), { wrapper });

      act(() => {
        result.current.mutate({ plaidItemId: 'pid-1', seeds: [] });
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      
      expect(api.confirmPlaidSeeds).toHaveBeenCalledWith('pid-1', []);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: plaidReviewKeys.seeds('pid-1') });
    });
  });
});

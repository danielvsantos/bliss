import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import {
  useResyncPlaidItem,
  useRotatePlaidToken,
  useDisconnectPlaidItem,
  useRequeuePlaidTransaction,
  useFetchHistoricalTransactions,
  plaidItemKeys
} from './use-plaid-actions';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
    queryClient
  };
};

describe('Plaid Actions Hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useResyncPlaidItem', () => {
    it('calls api.resyncPlaidItem and invalidates queries on success', async () => {
      vi.mocked(api.resyncPlaidItem).mockResolvedValueOnce({ success: true });
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useResyncPlaidItem(), { wrapper });

      act(() => {
        result.current.mutate('plaid-123');
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(api.resyncPlaidItem).toHaveBeenCalledWith('plaid-123');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: plaidItemKeys.all });
    });
  });

  describe('useRotatePlaidToken', () => {
    it('calls api.rotatePlaidToken', async () => {
      vi.mocked(api.rotatePlaidToken).mockResolvedValueOnce({ success: true });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useRotatePlaidToken(), { wrapper });

      act(() => {
        result.current.mutate('plaid-123');
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.rotatePlaidToken).toHaveBeenCalledWith('plaid-123');
    });
  });

  describe('useDisconnectPlaidItem', () => {
    it('calls api.disconnectPlaidItem', async () => {
      vi.mocked(api.disconnectPlaidItem).mockResolvedValueOnce({ success: true });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useDisconnectPlaidItem(), { wrapper });

      act(() => {
        result.current.mutate('plaid-123');
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.disconnectPlaidItem).toHaveBeenCalledWith('plaid-123');
    });
  });

  describe('useRequeuePlaidTransaction', () => {
    it('calls api.requeuePlaidTransaction', async () => {
      vi.mocked(api.requeuePlaidTransaction).mockResolvedValueOnce({ success: true });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useRequeuePlaidTransaction(), { wrapper });

      act(() => {
        result.current.mutate('txn-123');
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.requeuePlaidTransaction).toHaveBeenCalledWith('txn-123');
    });
  });

  describe('useFetchHistoricalTransactions', () => {
    it('calls api.fetchHistoricalTransactions', async () => {
      vi.mocked(api.fetchHistoricalTransactions).mockResolvedValueOnce({ success: true });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useFetchHistoricalTransactions(), { wrapper });

      act(() => {
        result.current.mutate({ plaidItemId: 'plaid-123', fromDate: '2023-01-01' });
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.fetchHistoricalTransactions).toHaveBeenCalledWith('plaid-123', '2023-01-01');
    });
  });
});

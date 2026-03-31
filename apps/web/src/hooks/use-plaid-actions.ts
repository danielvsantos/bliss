import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { plaidReviewKeys } from './use-plaid-review';

// Query keys for plaid items (used across hooks)
export const plaidItemKeys = {
  all: ['plaid-items'] as const,
  syncLogs: (plaidItemId: string) => ['plaid-sync-logs', plaidItemId] as const,
};

// --- Resync a Plaid Item ---

export function useResyncPlaidItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plaidItemId: string) => api.resyncPlaidItem(plaidItemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plaidItemKeys.all });
    },
  });
}

// --- Rotate Plaid access token ---

export function useRotatePlaidToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plaidItemId: string) => api.rotatePlaidToken(plaidItemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plaidItemKeys.all });
    },
  });
}

// --- Disconnect a Plaid Item ---

export function useDisconnectPlaidItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plaidItemId: string) => api.disconnectPlaidItem(plaidItemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plaidItemKeys.all });
    },
  });
}

// --- Re-queue a skipped Plaid transaction ---

export function useRequeuePlaidTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (transactionId: string) => api.requeuePlaidTransaction(transactionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plaidReviewKeys.all });
    },
  });
}

// --- Fetch Historical Transactions (Backfill) ---

export function useFetchHistoricalTransactions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ plaidItemId, fromDate }: { plaidItemId: string; fromDate: string }) =>
      api.fetchHistoricalTransactions(plaidItemId, fromDate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plaidItemKeys.all });
    },
  });
}

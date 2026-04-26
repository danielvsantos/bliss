import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PlaidTransactionsResponse, SeedItem } from '@/types/api';

// Query keys
export const plaidReviewKeys = {
  all: ['plaid-review'] as const,
  transactions: (params: Record<string, unknown>) =>
    [...plaidReviewKeys.all, 'transactions', params] as const,
  seeds: (plaidItemId: string) =>
    [...plaidReviewKeys.all, 'seeds', plaidItemId] as const,
};

// --- Fetch Plaid Transactions for review ---

export function usePlaidTransactions(
  params?: {
    page?: number;
    limit?: number;
    promotionStatus?: string;
    plaidItemId?: string;
    minConfidence?: number;
    maxConfidence?: number;
    categoryId?: number;
    uncategorized?: boolean;
  },
  options?: {
    /** Override stale time (ms). Default: 30 000. Pass 0 to always refetch on mount. */
    staleTime?: number;
    /** Poll for new data every N ms. Useful for badges/counters that update in background. */
    refetchInterval?: number;
  }
) {
  return useQuery({
    queryKey: plaidReviewKeys.transactions(params ?? {}),
    queryFn: () => api.getPlaidTransactions(params),
    staleTime: options?.staleTime ?? 1000 * 30, // 30 seconds — review data changes as user works
    refetchInterval: options?.refetchInterval,
  });
}

// --- Update a single PlaidTransaction (category override / promote / skip) ---

export function useUpdatePlaidTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      id: string;
      data: { suggestedCategoryId?: number; promotionStatus?: 'PROMOTED' | 'SKIPPED' };
    }) => api.updatePlaidTransaction(params.id, params.data),
    onSuccess: () => {
      // Invalidate all plaid review queries to refresh data + counts
      queryClient.invalidateQueries({ queryKey: plaidReviewKeys.all });
      // Also invalidate transactions since promotions create new ones
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

// --- Bulk promote high-confidence transactions ---

export function useBulkPromotePlaidTransactions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { minConfidence?: number; plaidItemId?: string; categoryId?: number; transactionIds?: string[] }) =>
      api.bulkPromotePlaidTransactions(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plaidReviewKeys.all });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

// --- Quick Seed Interview (Plaid) ---

/**
 * Fetches the top LLM-classified descriptions for the seed interview.
 * Only enabled once the plaidItemId is available.
 */
export function usePlaidSeeds(plaidItemId: string | null, limit?: number) {
  return useQuery<SeedItem[]>({
    queryKey: plaidReviewKeys.seeds(plaidItemId ?? ''),
    queryFn: () => api.getPlaidSeeds(plaidItemId!, limit),
    enabled: !!plaidItemId,
    staleTime: 1000 * 60 * 5, // Seeds don't change once set — 5 min stale
  });
}

/**
 * Confirms the user's category selections from the Quick Seed interview.
 * Fires recordFeedback on the backend and bulk-updates matching PlaidTransactions.
 */
export function useConfirmPlaidSeeds() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      plaidItemId: string;
      seeds: { description: string; confirmedCategoryId: number }[];
    }) => api.confirmPlaidSeeds(params.plaidItemId, params.seeds),
    onSuccess: (_data, params) => {
      // Seeds are now stale — remove them from cache
      queryClient.invalidateQueries({ queryKey: plaidReviewKeys.seeds(params.plaidItemId) });
      // Plaid transactions have been updated with USER_OVERRIDE categories
      queryClient.invalidateQueries({ queryKey: plaidReviewKeys.all });
    },
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SubscriptionsResponse, SubscriptionsView, RecurringCadence } from '@/types/api';

export const subscriptionKeys = {
  all: ['subscriptions'] as const,
  list: (view: SubscriptionsView, categoryId: number | null) =>
    [...subscriptionKeys.all, 'list', view, categoryId] as const,
};

export function useSubscriptions(opts?: { view?: SubscriptionsView; categoryId?: number | null }) {
  const view: SubscriptionsView = opts?.view ?? 'active';
  const categoryId = opts?.categoryId ?? null;
  return useQuery<SubscriptionsResponse>({
    queryKey: subscriptionKeys.list(view, categoryId),
    queryFn: () => api.getSubscriptions({ view, ...(categoryId ? { categoryId } : {}) }),
    staleTime: 1000 * 30,
  });
}

function useInvalidateSubscriptions() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: subscriptionKeys.all });
}

export function useConfirmSubscription() {
  const invalidate = useInvalidateSubscriptions();
  return useMutation({
    mutationFn: (body: { descriptionHash?: string; transactionId?: number }) =>
      api.confirmSubscription(body),
    onSuccess: invalidate,
  });
}

export function useDismissSubscription() {
  const invalidate = useInvalidateSubscriptions();
  return useMutation({
    mutationFn: (descriptionHash: string) => api.dismissSubscription(descriptionHash),
    onSuccess: invalidate,
  });
}

export function useRestoreSubscription() {
  const invalidate = useInvalidateSubscriptions();
  return useMutation({
    mutationFn: (descriptionHash: string) => api.restoreSubscription(descriptionHash),
    onSuccess: invalidate,
  });
}

export function useSetSubscriptionCadence() {
  const invalidate = useInvalidateSubscriptions();
  return useMutation({
    mutationFn: ({ descriptionHash, cadence }: { descriptionHash: string; cadence: RecurringCadence }) =>
      api.setSubscriptionCadence(descriptionHash, cadence),
    onSuccess: invalidate,
  });
}

export function useRenameSubscription() {
  const invalidate = useInvalidateSubscriptions();
  return useMutation({
    mutationFn: ({ descriptionHash, merchantLabel }: { descriptionHash: string; merchantLabel: string }) =>
      api.renameSubscription(descriptionHash, merchantLabel),
    onSuccess: invalidate,
  });
}

export function useMergeSubscription() {
  const invalidate = useInvalidateSubscriptions();
  return useMutation({
    mutationFn: ({ sourceDescriptionHash, targetDescriptionHash }: {
      sourceDescriptionHash: string;
      targetDescriptionHash: string;
    }) => api.mergeSubscription(sourceDescriptionHash, targetDescriptionHash),
    onSuccess: invalidate,
  });
}

export function useUnmergeSubscription() {
  const invalidate = useInvalidateSubscriptions();
  return useMutation({
    mutationFn: (descriptionHash: string) => api.unmergeSubscription(descriptionHash),
    onSuccess: invalidate,
  });
}

export function useRefreshSubscriptions() {
  const invalidate = useInvalidateSubscriptions();
  return useMutation({
    mutationFn: () => api.refreshSubscriptions(),
    onSuccess: invalidate,
  });
}

export function useFullHistoryScan() {
  const invalidate = useInvalidateSubscriptions();
  return useMutation({
    mutationFn: () => api.fullHistoryScan(),
    onSuccess: invalidate,
  });
}

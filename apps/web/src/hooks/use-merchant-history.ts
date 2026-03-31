import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { MerchantHistoryTransaction } from '@/types/api';

export const merchantHistoryKeys = {
  all: ['merchant-history'] as const,
  byDescription: (description: string) =>
    ['merchant-history', description] as const,
};

export function useMerchantHistory(description: string | null | undefined, limit = 10) {
  return useQuery<MerchantHistoryTransaction[]>({
    queryKey: merchantHistoryKeys.byDescription(description ?? ''),
    queryFn: () => api.getMerchantHistory(description!, limit),
    enabled: !!description && description.length > 0,
    staleTime: 1000 * 30, // 30 seconds — refresh after promotions
  });
}

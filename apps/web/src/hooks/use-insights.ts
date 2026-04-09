import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';

export type InsightTier = 'DAILY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'PORTFOLIO';
export type InsightCategory = 'SPENDING' | 'INCOME' | 'SAVINGS' | 'PORTFOLIO' | 'DEBT' | 'NET_WORTH';

interface InsightParams {
  limit?: number;
  offset?: number;
  lens?: string;
  severity?: string;
  tier?: string;
  category?: string;
  periodKey?: string;
  includeDismissed?: boolean;
}

export function useInsights(params?: InsightParams) {
  return useQuery({
    queryKey: ['insights', params],
    queryFn: () => api.getInsights(params),
    staleTime: 5 * 60 * 1000,
  });
}

export function useDismissInsight() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ insightId, dismissed }: { insightId: string; dismissed: boolean }) =>
      api.dismissInsight(insightId, dismissed),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['insights'] });
    },
  });
}

interface GenerateOptions {
  tier?: string;
  year?: number;
  month?: number;
  quarter?: number;
  periodKey?: string;
  force?: boolean;
}

export function useGenerateInsights() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (options?: GenerateOptions) => api.generateInsights(options),
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['insights'] });
      }, 5000);
    },
  });
}

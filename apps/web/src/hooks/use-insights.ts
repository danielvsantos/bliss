import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type { InsightTier, InsightCategory } from '@/types/api';

// Re-export shared insight type unions so existing imports from '@/hooks/use-insights' still compile.
export type { InsightTier, InsightCategory };

interface InsightParams {
  limit?: number;
  offset?: number;
  lens?: string;
  severity?: string;
  tier?: InsightTier;
  category?: InsightCategory;
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
  tier: InsightTier; // required — the retired DAILY fallback was removed in v1
  year?: number;
  month?: number;
  quarter?: number;
  periodKey?: string;
  force?: boolean;
}

export function useGenerateInsights() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (options: GenerateOptions) => api.generateInsights(options),
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['insights'] });
      }, 5000);
    },
  });
}

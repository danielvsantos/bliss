import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';

interface InsightParams {
  limit?: number;
  offset?: number;
  lens?: string;
  severity?: string;
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

export function useGenerateInsights() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.generateInsights(),
    onSuccess: () => {
      // Don't invalidate immediately — the job is async.
      // The page polls via refetchInterval when generation is in progress.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['insights'] });
      }, 5000);
    },
  });
}

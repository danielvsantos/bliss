import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { usePageVisible } from '@/hooks/use-page-visible';

export function useNotificationSummary() {
  const isVisible = usePageVisible();

  return useQuery({
    queryKey: ['notification-summary'],
    queryFn: () => api.getNotificationSummary(),
    refetchInterval: isVisible ? 60_000 : false,
    staleTime: 30_000,
  });
}

export function useMarkNotificationsSeen() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.markNotificationsSeen(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-summary'] });
    },
  });
}

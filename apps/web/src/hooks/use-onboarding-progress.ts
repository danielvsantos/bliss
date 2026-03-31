import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';

export function useOnboardingProgress() {
  return useQuery({
    queryKey: ['onboarding-progress'],
    queryFn: () => api.getOnboardingProgress(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCompleteOnboardingStep() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ step, data }: { step: string; data?: any }) =>
      api.completeOnboardingStep(step, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['onboarding-progress'] });
    },
  });
}

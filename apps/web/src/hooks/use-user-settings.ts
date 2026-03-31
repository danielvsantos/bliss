import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';

const userSettingsKeys = {
  settings: () => ['user', 'settings'] as const,
};

export interface UserSettings {
  autoPromoteThreshold: number;
  reviewThreshold: number;
  portfolioCurrency: string;
}

export function useUserSettings() {
  return useQuery({
    queryKey: userSettingsKeys.settings(),
    queryFn: () => api.getUserSettings(),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUpdateUserSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<UserSettings>) => api.updateUserSettings(data),
    onSuccess: (updated) => {
      queryClient.setQueryData(userSettingsKeys.settings(), updated);
    },
  });
}

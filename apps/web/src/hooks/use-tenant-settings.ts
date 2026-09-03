import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { invalidatePortfolioQueries } from '@/lib/query-config';

const tenantSettingsKeys = {
  settings: () => ['tenant', 'settings'] as const,
};

export interface TenantSettings {
  autoPromoteThreshold: number;
  reviewThreshold: number;
  portfolioCurrency: string;
  plaidHistoryDays: number;
}

export function useTenantSettings() {
  return useQuery({
    queryKey: tenantSettingsKeys.settings(),
    queryFn: () => api.getTenantSettings(),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUpdateTenantSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<TenantSettings>) => api.updateTenantSettings(data),
    onSuccess: (updated, variables) => {
      queryClient.setQueryData(tenantSettingsKeys.settings(), updated);
      // When portfolioCurrency changes, invalidate portfolio queries so they
      // refetch with the new display currency (conversion is done server-side)
      if (variables.portfolioCurrency) {
        invalidatePortfolioQueries(queryClient);
      }
    },
  });
}

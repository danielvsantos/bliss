import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { plaidItemKeys } from './use-plaid-actions';

export function useSyncLogs(plaidItemId: string | null, limit = 10) {
  return useQuery({
    queryKey: plaidItemKeys.syncLogs(plaidItemId ?? ''),
    queryFn: () => api.getPlaidSyncLogs(plaidItemId!, limit),
    enabled: !!plaidItemId,
    staleTime: 1000 * 60, // 1 minute
  });
}

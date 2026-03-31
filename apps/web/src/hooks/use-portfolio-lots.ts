import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PortfolioLot } from '@/types/api';

export const LOTS_QUERY_KEY_PREFIX = 'portfolio-lots';

export function usePortfolioLots(assetId: number | null) {
  const query = useQuery<PortfolioLot[], Error>({
    queryKey: [LOTS_QUERY_KEY_PREFIX, assetId],
    queryFn: () => api.getPortfolioLots(assetId!),
    enabled: !!assetId, // Only run the query if assetId is not null
  });

  return query;
} 
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PortfolioHolding } from '@/types/api';

export const HOLDINGS_QUERY_KEY = 'portfolio-holdings';

export function usePortfolioHoldings(filters: { account?: string; category?: string; categoryGroup?: string; ticker?: string } = {}) {
  const query = useQuery<PortfolioHolding[], Error>({
    queryKey: [HOLDINGS_QUERY_KEY, filters],
    queryFn: () => api.getPortfolioHoldings(filters),
  });

  return query;
} 
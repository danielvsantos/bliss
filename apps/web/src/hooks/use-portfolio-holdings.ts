import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PortfolioHolding } from '@/types/api';
import { PORTFOLIO_STALE_TIME_MS } from '@/lib/query-config';

export const HOLDINGS_QUERY_KEY = 'portfolio-holdings';

export function usePortfolioHoldings(filters: {
  /** Filter by brokerage account ID */
  account?: number;
  /** Filter by account country (ISO 3166-1 alpha-3, e.g. "USA") */
  countryId?: string;
  category?: string;
  categoryGroup?: string;
  ticker?: string;
} = {}) {
  const query = useQuery<PortfolioHolding[], Error>({
    queryKey: [HOLDINGS_QUERY_KEY, filters],
    queryFn: () => api.getPortfolioHoldings(filters),
    staleTime: PORTFOLIO_STALE_TIME_MS,
  });

  return query;
} 
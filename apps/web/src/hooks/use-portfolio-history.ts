import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AggregatedPortfolioHistory } from '@/lib/api';

export const HISTORY_QUERY_KEY = 'portfolio-history';

type PortfolioHistoryResponse = {
  portfolioCurrency: string;
  /** Resolution used by the API — useful for labelling chart axes. */
  resolution: 'daily' | 'weekly' | 'monthly';
  history: AggregatedPortfolioHistory[];
};

type PortfolioHistoryFilters = {
  from?: string;
  to?: string;
  type?: string;
  group?: string;
  /**
   * Override automatic resolution selection.
   * When omitted the API auto-selects based on the date range:
   *   ≤ 90 days  → daily
   *   ≤ 365 days → weekly
   *   > 365 days → monthly
   */
  resolution?: 'daily' | 'weekly' | 'monthly';
};

export function usePortfolioHistory(filters: PortfolioHistoryFilters = {}) {
  const query = useQuery<PortfolioHistoryResponse, Error>({
    queryKey: [HISTORY_QUERY_KEY, filters],
    queryFn: () => api.getPortfolioHistory(filters),
  });

  return query;
}

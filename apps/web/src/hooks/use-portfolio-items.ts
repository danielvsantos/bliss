import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PortfolioItem } from '@/types/api';

export const PORTFOLIO_ITEMS_QUERY_KEY = 'portfolio-items';

type PortfolioItemsResponse = {
  portfolioCurrency: string;
  items: PortfolioItem[];
};

/**
 * A clean data-fetching hook that retrieves portfolio items from the API.
 * Returns { portfolioCurrency, items } — the API performs currency conversion server-side.
 * @param {object} [options] - Optional parameters for the query.
 * @param {boolean} [options.includeManualValues] - If true, the API will include the latest manual value for each item.
 */
export function usePortfolioItems(options?: { includeManualValues?: boolean }) {
  const queryKey = [PORTFOLIO_ITEMS_QUERY_KEY, options];

  return useQuery<PortfolioItemsResponse>({
    queryKey: queryKey,
    queryFn: () => api.getPortfolioItems({ include_manual_values: options?.includeManualValues }),
  });
}

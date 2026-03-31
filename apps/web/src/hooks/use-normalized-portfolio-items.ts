import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PortfolioItem } from '@/types/api';

export const PORTFOLIO_ITEMS_QUERY_KEY = 'portfolio-items';

/**
 * A clean data-fetching hook that retrieves portfolio items from the API.
 * The new API response is already in the ideal shape for the frontend,
 * so no client-side normalization or currency conversion is needed.
 */
export function usePortfolioItems() {
  return useQuery<PortfolioItem[]>({
    queryKey: [PORTFOLIO_ITEMS_QUERY_KEY],
    queryFn: async () => {
      const data = await api.getPortfolioItems({});
      return data.items;
    },
  });
}

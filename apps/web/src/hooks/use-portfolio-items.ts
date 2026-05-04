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
 *
 * @param {object} [options] - Optional parameters for the query.
 * @param {boolean} [options.includeManualValues] - Include latest manual value per item.
 * @param {number | null} [options.accountId] - Restrict to a specific brokerage account.
 *   Pass `null` explicitly to return only manually-entered assets (no account binding).
 * @param {string} [options.countryId] - Restrict to accounts in a specific country
 *   (ISO 3166-1 alpha-3, e.g. "USA", "GBR").
 */
export function usePortfolioItems(options?: {
  includeManualValues?: boolean;
  accountId?: number | null;
  countryId?: string;
}) {
  const queryKey = [PORTFOLIO_ITEMS_QUERY_KEY, options];

  return useQuery<PortfolioItemsResponse>({
    queryKey,
    queryFn: () => api.getPortfolioItems({
      include_manual_values: options?.includeManualValues,
      ...(options?.accountId !== undefined && { accountId: options.accountId }),
      ...(options?.countryId && { countryId: options.countryId }),
    }),
  });
}

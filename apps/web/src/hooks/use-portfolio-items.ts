import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PortfolioItem } from '@/types/api';
import { PORTFOLIO_STALE_TIME_MS } from '@/lib/query-config';

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
  // Canonicalize the key params so callers that pass nothing, `{}`, or
  // `{ includeManualValues: false }` all resolve to the SAME cache entry.
  // Without this, `usePortfolioItems()` (dashboard) and `usePortfolioItems({})`
  // (portfolio page) hash to different entries — `["portfolio-items", null]` vs
  // `["portfolio-items", {}]` — and drift apart once each is cached/persisted.
  // `accountId: null` is meaningful (manual-only assets) so it is kept; only
  // `undefined` / absent is dropped.
  const keyParams: {
    includeManualValues?: true;
    accountId?: number | null;
    countryId?: string;
  } = {};
  if (options?.includeManualValues) keyParams.includeManualValues = true;
  if (options?.accountId !== undefined) keyParams.accountId = options.accountId;
  if (options?.countryId) keyParams.countryId = options.countryId;

  const queryKey = [PORTFOLIO_ITEMS_QUERY_KEY, keyParams];

  return useQuery<PortfolioItemsResponse>({
    queryKey,
    queryFn: () => api.getPortfolioItems({
      include_manual_values: keyParams.includeManualValues,
      ...(keyParams.accountId !== undefined && { accountId: keyParams.accountId }),
      ...(keyParams.countryId && { countryId: keyParams.countryId }),
    }),
    staleTime: PORTFOLIO_STALE_TIME_MS,
  });
}

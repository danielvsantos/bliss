import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';

export type TickerResult = {
  symbol: string;
  name: string;
  exchange: string;
  country: string;
  currency: string;
  type: string;
  mic_code: string;
};

/**
 * Debounced ticker search hook.
 * Only fires the query when the search term is >= 2 characters.
 *
 * @param query — Search term
 * @param searchType — Optional: 'crypto' filters for digital currency results, omit for stocks/funds
 */
export function useTickerSearch(query: string, searchType?: string) {
  const trimmed = query.trim();

  return useQuery({
    queryKey: ['ticker', 'search', trimmed, searchType],
    queryFn: async () => {
      const data = await api.searchTickers(trimmed, searchType);
      return data.results;
    },
    enabled: trimmed.length >= 2,
    staleTime: 1000 * 60 * 5, // 5 minutes
    placeholderData: (prev) => prev,
  });
}

import { useQueries } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CurrencyRate } from '@/types/api';

export const CURRENCY_RATES_QUERY_KEY = 'currency-rates';

export function useCurrencyRates(currencies: string[], date: Date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1; // getUTCMonth is 0-indexed
  const day = date.getUTCDate();

  const results = useQueries({
    queries: currencies
      // Filter out 'USD' since we don't need to convert USD to USD
      .filter(currency => currency !== 'USD')
      .map(currency => {
        return {
          queryKey: [CURRENCY_RATES_QUERY_KEY, currency, year, month, day],
          queryFn: async (): Promise<CurrencyRate[]> => {
            const data = await api.getCurrencyRates({
              currencyFrom: currency,
              currencyTo: 'USD',
              year,
              month,
              day,
            });
            // The API returns an array, even for a single day's rate
            return Array.isArray(data) ? data : [];
          },
          staleTime: 1000 * 60 * 60, // 1 hour
        };
      }),
  });
  
  // We need to combine the results from the multiple queries into a single array
  // and derive a single loading state.
  const isLoading = results.some(query => query.isLoading);
  const allRates = results
    .filter(query => query.isSuccess && query.data)
    .flatMap(query => query.data); // flatMap to merge the arrays of results

  return { data: allRates, isLoading };
} 
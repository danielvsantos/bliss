import { useMutation } from '@tanstack/react-query';
import api from '@/lib/api';

/**
 * Triggers a manual SecurityMaster fundamentals refresh — re-runs the full
 * Twelve Data fetch (profile + earnings + dividends + quote) for every active
 * stock symbol across all tenants. Used to force-recompute the
 * `earningsTrusted` / `dividendTrusted` flags and unblock the equity-analysis
 * page after a Twelve Data inconsistency is fixed.
 *
 * Admin-only on the server side. The mutation resolves once the backend has
 * enqueued the job; the actual refresh runs asynchronously and may take
 * several minutes to complete depending on portfolio size.
 */
export function useRefreshFundamentals() {
  return useMutation<{ message: string; jobId: string }, Error>({
    mutationFn: () => api.refreshStockFundamentals(),
  });
}

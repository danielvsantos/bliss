import type { AggregatedPortfolioHistory } from '@/lib/api';

/**
 * Net worth of one portfolio-history day: investments + other assets
 * (Cash group included) − debt. Shared by the Dashboard hero/sparkline and the
 * Portfolio Holdings chart so every net-worth figure uses the same formula
 * as the live `useDashboardMetrics` value (#144).
 */
export function netWorthFromEntry(entry: AggregatedPortfolioHistory): number {
  return (entry.Asset?.total ?? 0) + (entry.Investments?.total ?? 0) - Math.abs(entry.Debt?.total ?? 0);
}

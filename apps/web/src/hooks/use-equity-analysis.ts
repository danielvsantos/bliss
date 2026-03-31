import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import type { EquityAnalysisResponse, EquityGroup } from '@/types/equity-analysis';

export const EQUITY_ANALYSIS_QUERY_KEY = 'equity-analysis';

/**
 * Fetches equity analysis data once (grouped by sector as default),
 * then re-groups client-side when the user switches tabs.
 * This avoids redundant API calls for each groupBy change.
 */
export function useEquityAnalysis(groupBy: string = 'sector') {
  const query = useQuery<EquityAnalysisResponse>({
    queryKey: [EQUITY_ANALYSIS_QUERY_KEY],
    queryFn: () => api.getEquityAnalysis({ groupBy: 'sector' }),
  });

  // Re-group client-side when groupBy changes (no refetch needed)
  const regrouped = useMemo<EquityAnalysisResponse | undefined>(() => {
    if (!query.data) return undefined;

    // If already grouped by the requested field, return as-is
    if (groupBy === 'sector') return query.data;

    // Flatten all holdings and re-group by the requested field
    const allHoldings = query.data.groups.flatMap((g) => g.holdings);
    const totalEquityValue = query.data.summary.totalEquityValue;

    const groupMap: Record<string, EquityGroup> = {};
    for (const h of allHoldings) {
      const key = (h[groupBy as keyof typeof h] as string) || 'Unknown';
      if (!groupMap[key]) {
        groupMap[key] = { name: key, totalValue: 0, holdingsCount: 0, weight: 0, holdings: [] };
      }
      groupMap[key].totalValue += h.currentValue;
      groupMap[key].holdingsCount += 1;
      groupMap[key].holdings.push(h);
    }

    const groups = Object.values(groupMap)
      .map((g) => ({
        ...g,
        weight: totalEquityValue > 0 ? g.totalValue / totalEquityValue : 0,
        totalValue: Math.round(g.totalValue * 100) / 100,
      }))
      .sort((a, b) => b.totalValue - a.totalValue);

    return { ...query.data, groups };
  }, [query.data, groupBy]);

  return { ...query, data: regrouped };
}

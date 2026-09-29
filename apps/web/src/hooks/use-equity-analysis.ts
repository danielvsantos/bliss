import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import type {
  AssetClass,
  EquityAnalysisResponse,
  EquityGroup,
  EquityGroupBy,
  EquityHolding,
} from '@/types/equity-analysis';
import { PORTFOLIO_STALE_TIME_MS } from '@/lib/query-config';

export const EQUITY_ANALYSIS_QUERY_KEY = 'equity-analysis';

/**
 * Fetches equity analysis data once per look-through setting, then picks the
 * requested grouping client-side. The API returns every grouping
 * (`groupings`, #79) because sector / country look through ETFs, which needs
 * the server-side composition data; older responses without `groupings` are
 * re-grouped here.
 */
export function useEquityAnalysis(groupBy: string = 'sector', { lookThrough = true }: { lookThrough?: boolean } = {}) {
  const query = useQuery<EquityAnalysisResponse>({
    queryKey: [EQUITY_ANALYSIS_QUERY_KEY, { lookThrough }],
    queryFn: () => api.getEquityAnalysis(lookThrough ? { groupBy: 'sector' } : { groupBy: 'sector', lookThrough: false }),
    staleTime: PORTFOLIO_STALE_TIME_MS,
  });

  const regrouped = useMemo<EquityAnalysisResponse | undefined>(() => {
    if (!query.data) return undefined;
    const data = query.data;
    const holdings: EquityHolding[] = data.holdings ?? data.groups.flatMap((g) => g.holdings);

    const serverGroups = data.groupings?.[groupBy as EquityGroupBy];
    if (serverGroups) return { ...data, holdings, groups: serverGroups };

    // If already grouped by the requested field, return as-is
    if (groupBy === 'sector') return { ...data, holdings };

    // Flatten all holdings and re-group by the requested field
    const totalEquityValue = data.summary.totalEquityValue;

    const groupMap: Record<string, EquityGroup> = {};
    for (const h of holdings) {
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

    return { ...data, holdings, groups };
  }, [query.data, groupBy]);

  return { ...query, data: regrouped };
}

/**
 * Set or clear (`assetClass: null`) a holding's asset class override (#79).
 * Applies to every holding of the same symbol (the page merges them) and
 * refetches Equity Analysis.
 */
export function useSetAssetClass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ portfolioItemId, assetClass }: { portfolioItemId: number; assetClass: AssetClass | null }) =>
      api.setAssetClass(portfolioItemId, assetClass, { applyToSymbol: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [EQUITY_ANALYSIS_QUERY_KEY] });
      // Manage Assets list rows and asset class modal (#81).
      queryClient.invalidateQueries({ queryKey: ['portfolio-assets'] });
    },
  });
}

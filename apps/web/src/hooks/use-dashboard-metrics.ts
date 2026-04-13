import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMemo } from 'react';
import { processAnalyticsIntoFinancialStatement } from '@/lib/financial-summary';
import { usePortfolioItems } from './use-portfolio-items';
import { getDisplayData, parseDecimal } from '@/lib/portfolio-utils';

export const DASHBOARD_METRICS_QUERY_KEY = 'dashboard-metrics';

export function useDashboardMetrics(year: string, currency?: string) {
  const { data: portfolioData, isLoading: areItemsLoading } = usePortfolioItems();
  const portfolioItems = useMemo(() => portfolioData?.items ?? [], [portfolioData?.items]);
  const portfolioCurrency = portfolioData?.portfolioCurrency ?? 'USD';

  const selectedYear = parseInt(year, 10);

  const { data: pnlData, isLoading: isPnlLoading } = useQuery({
    queryKey: ['analytics', 'pnl', selectedYear, currency],
    queryFn: () => api.getAnalytics({ view: 'year', years: [selectedYear], currency }),
  });

  const metrics = useMemo(() => {
    // Net Worth Calculation — use currency-aware display data
    let totalAssets = 0;
    let totalLiabilities = 0;

    portfolioItems.forEach(item => {
      const data = getDisplayData(item, portfolioCurrency);
      const marketValue = parseDecimal(data.marketValue);
      if (item.category?.type === 'Debt') {
        totalLiabilities += Math.abs(marketValue);
      } else if (item.category?.group !== 'Cash') {
        totalAssets += marketValue;
      }
    });

    const netWorth = totalAssets - totalLiabilities;

    // Financial Metrics
    let netIncome = 0, discretionaryIncome = 0, netSavings = 0;
    if (pnlData) {
      const { statement } = processAnalyticsIntoFinancialStatement(pnlData, [year], null);

      const incomeData = statement.types.find(t => t.name === 'Income')?.totals[selectedYear] || 0;
      netIncome = incomeData;

      const essentials = statement.types.find(t => t.name === 'Essentials')?.totals[selectedYear] || 0;
      discretionaryIncome = netIncome - Math.abs(essentials);

      const lifestyle = statement.types.find(t => t.name === 'Lifestyle')?.totals[selectedYear] || 0;
      const growth = statement.types.find(t => t.name === 'Growth')?.totals[selectedYear] || 0;
      netSavings = discretionaryIncome - Math.abs(lifestyle) - Math.abs(growth);
    }

    return {
      netWorth,
      netIncome,
      discretionaryIncome,
      netSavings,
    };
  }, [portfolioItems, pnlData, year, selectedYear, portfolioCurrency]);

  return {
    data: metrics,
    portfolioCurrency,
    isLoading: areItemsLoading || isPnlLoading,
  };
} 
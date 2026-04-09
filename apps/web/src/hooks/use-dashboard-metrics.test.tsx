import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { useDashboardMetrics } from './use-dashboard-metrics';
import * as UsePortfolio from './use-portfolio-items';
import * as PnLLib from '@/lib/pnl';
import { mockQueryResult } from '@/test/mock-helpers';

vi.mock('@/lib/api');
vi.mock('./use-portfolio-items');
vi.mock('@/lib/pnl');
vi.mock('@/lib/portfolio-utils', () => ({
  getDisplayData: (item: { currentPrice: number }) => ({ marketValue: item.currentPrice }),
  parseDecimal: (val: unknown) => Number(val) || 0,
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
  };
};

describe('useDashboardMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes netWorth and PnL metrics correctly', async () => {
    // Mock Portfolio
    vi.mocked(UsePortfolio.usePortfolioItems).mockReturnValue(
      mockQueryResult({
        portfolioCurrency: 'USD',
        items: [
          { id: 1, name: 'House', quantity: 1, currentPrice: 500000, currency: 'USD', category: { type: 'Asset' } },
          { id: 2, name: 'Mortgage', quantity: 1, currentPrice: -300000, currency: 'USD', category: { type: 'Debt' } },
        ]
      }),
    );

    // Mock API — return shape doesn't matter since PnL processor is also mocked
    vi.mocked(api.getAnalytics).mockResolvedValueOnce(
      {} as unknown as Awaited<ReturnType<typeof api.getAnalytics>>,
    );

    // Mock PnL processor heavily simplified
    vi.mocked(PnLLib.processAnalyticsIntoPnL).mockReturnValue({
      statement: {
        types: [
          { name: 'Income', totals: { '2023': 10000 } },
          { name: 'Essentials', totals: { '2023': -4000 } },
          { name: 'Lifestyle', totals: { '2023': -2000 } },
          { name: 'Growth', totals: { '2023': -1000 } },
        ]
      }
    } as unknown as ReturnType<typeof PnLLib.processAnalyticsIntoPnL>);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDashboardMetrics('2023', 'USD'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // net worth Calculation: 500,000 asset - 300,000 debt = 200,000
    // wait, the hook parses data using getDisplayData and sums absolutes for debt
    // if getDisplayData gives 500000 and -300000...
    expect(result.current.data.netWorth).toBe(200000);
    
    // PnL:
    // netIncome = 10000
    // grossProfit = 10000 - |-4000| = 6000
    // netProfit = 6000 - |-2000| - |-1000| = 3000
    expect(result.current.data.netIncome).toBe(10000);
    expect(result.current.data.grossProfit).toBe(6000);
    expect(result.current.data.netProfit).toBe(3000);
  });
});

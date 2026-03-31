import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useUserSignals } from './use-user-signals';

// Mock all internal dependency hooks
vi.mock('@/hooks/use-account-list', () => ({
  useAccountList: vi.fn(() => ({ accounts: [], isLoading: false }))
}));
vi.mock('@/hooks/use-dashboard-metrics', () => ({
  useDashboardMetrics: vi.fn(() => ({ data: null, portfolioCurrency: 'USD', isLoading: false }))
}));
vi.mock('@/hooks/use-plaid-review', () => ({
  usePlaidTransactions: vi.fn(() => ({ data: null }))
}));
vi.mock('@/hooks/use-imports', () => ({
  usePendingImports: vi.fn(() => ({ data: null }))
}));
vi.mock('@/hooks/use-onboarding-progress', () => ({
  useOnboardingProgress: vi.fn(() => ({ data: null, isLoading: false }))
}));
vi.mock('@/hooks/use-portfolio-items', () => ({
  usePortfolioItems: vi.fn(() => ({ data: null }))
}));
vi.mock('@/hooks/use-insights', () => ({
  useInsights: vi.fn(() => ({ data: null }))
}));

// Import original hooks so we can override their mocks mid-test
import { useAccountList } from '@/hooks/use-account-list';
import { usePlaidTransactions } from '@/hooks/use-plaid-review';
import { useImports } from '@/hooks/use-imports';
import { usePendingImports } from '@/hooks/use-imports';
import { useDashboardMetrics } from '@/hooks/use-dashboard-metrics';

describe('useUserSignals', () => {
  it('combines default/empty signals safely', () => {
    const { result } = renderHook(() => useUserSignals());
    
    expect(result.current.signals.accountCount).toBe(0);
    expect(result.current.signals.totalReviewCount).toBe(0);
    expect(result.current.signals.hasPortfolioData).toBe(false);
    expect(result.current.signals.onboardingComplete).toBe(false);
    expect(result.current.signals.isLoading).toBe(false);
  });

  it('aggregates Plaid and Import reviews accurately', () => {
    // Override the specific mocks for this test
    vi.mocked(usePlaidTransactions).mockReturnValue({
      data: { summary: { classified: 5 } }
    } as any);

    vi.mocked(usePendingImports).mockReturnValue({
      data: { imports: [{ pendingRowCount: 3 }, { pendingRowCount: 2 }] }
    } as any);

    const { result } = renderHook(() => useUserSignals());

    expect(result.current.signals.plaidPendingCount).toBe(5);
    expect(result.current.signals.importPendingCount).toBe(5); // 3 + 2
    expect(result.current.signals.totalReviewCount).toBe(10);  // 5 + 5
  });

  it('detects action-required accounts', () => {
    vi.mocked(useAccountList).mockReturnValue({
      accounts: [
        { status: 'action-required' },
        { status: 'synced', plaidItem: {} }
      ],
      isLoading: false
    } as any);

    const { result } = renderHook(() => useUserSignals());
    expect(result.current.signals.accountCount).toBe(2);
    expect(result.current.signals.hasActionRequired).toBe(true);
    expect(result.current.signals.hasPlaid).toBe(true);
  });

  it('returns metrics payload safely', () => {
    vi.mocked(useDashboardMetrics).mockReturnValue({
      data: { netWorth: 1000, netIncome: 50, grossProfit: 0, netProfit: 0 },
      portfolioCurrency: 'EUR',
      isLoading: false
    } as any);

    const { result } = renderHook(() => useUserSignals());
    expect(result.current.metrics?.netWorth).toBe(1000);
    expect(result.current.portfolioCurrency).toBe('EUR');
    expect(result.current.signals.hasPortfolioData).toBe(true); // Since netWorth != 0
  });
});

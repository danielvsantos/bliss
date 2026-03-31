import { useMemo } from 'react';
import { differenceInDays } from 'date-fns';
import { useAccountList } from '@/hooks/use-account-list';
import type { EnrichedAccount } from '@/hooks/use-account-list';
import { usePlaidTransactions } from '@/hooks/use-plaid-review';
import { usePendingImports } from '@/hooks/use-imports';
import { useDashboardMetrics } from '@/hooks/use-dashboard-metrics';
import { useOnboardingProgress } from '@/hooks/use-onboarding-progress';
import { usePortfolioItems } from '@/hooks/use-portfolio-items';
import { useInsights } from '@/hooks/use-insights';

// ─── User Signals ────────────────────────────────────────────────────────────

export interface UserSignals {
  // Account signals
  accountCount: number;
  hasPlaid: boolean;
  hasActionRequired: boolean;

  // Review signals
  plaidPendingCount: number;
  importPendingCount: number;
  totalReviewCount: number;

  // Portfolio signals
  hasPortfolioData: boolean;
  hasStaleManualAssets: boolean;

  // Insights signals
  insightCount: number;

  // Onboarding signals
  onboardingComplete: boolean;
  checklistDismissed: boolean;
  checklist: Record<string, { done?: boolean; skipped?: boolean }>;

  // Loading state
  isLoading: boolean;
}

export interface UseUserSignalsResult {
  signals: UserSignals;
  accounts: EnrichedAccount[];
  metrics: { netWorth: number; netIncome: number; grossProfit: number; netProfit: number } | undefined;
  portfolioCurrency: string;
  metricsLoading: boolean;
  accountsLoading: boolean;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useUserSignals(year?: string, currency?: string): UseUserSignalsResult {
  const { accounts, isLoading: accountsLoading } = useAccountList();
  const { data: metrics, portfolioCurrency, isLoading: metricsLoading } = useDashboardMetrics(year ?? new Date().getFullYear().toString(), currency);
  const { data: plaidData } = usePlaidTransactions({ limit: 1 });
  const { data: pendingImportData } = usePendingImports();
  const { data: onboardingData, isLoading: onboardingLoading } = useOnboardingProgress();
  const { data: portfolioData } = usePortfolioItems({ includeManualValues: true });
  const { data: insightData } = useInsights({ limit: 1 });

  const signals = useMemo<UserSignals>(() => {
    // Account signals
    const accountCount = accounts.length;
    const hasPlaid = accounts.some(a => a.plaidItem !== null);
    const hasActionRequired = accounts.some(
      a => a.status === 'action-required'
    );

    // Review signals
    const plaidPendingCount = plaidData?.summary?.classified ?? 0;
    const importPendingCount = (pendingImportData?.imports ?? []).reduce(
      (sum: number, imp: { pendingRowCount?: number }) => sum + (imp.pendingRowCount ?? 0),
      0
    );
    const totalReviewCount = plaidPendingCount + importPendingCount;

    // Portfolio signals
    const hasPortfolioData = (metrics?.netWorth ?? 0) !== 0;

    // Stale manual assets check
    const portfolioItems = portfolioData?.items ?? [];
    const hasStaleManualAssets = portfolioItems.some(item => {
      const hint = item.category?.processingHint;
      if (hint !== 'MANUAL' && hint !== 'API_FUND') return false;
      if ((item.quantity ?? 0) <= 0) return false;

      const manualValues = item.manualValues ?? [];
      if (manualValues.length === 0) return true; // No initial price
      const lastDate = new Date(manualValues[0].date);
      return differenceInDays(new Date(), lastDate) > 30;
    });

    // Insights signals
    const insightCount = insightData?.total ?? 0;

    // Onboarding signals
    const progress = onboardingData?.onboardingProgress;
    const checklist = progress?.checklist ?? {};
    const checklistDismissed = progress?.checklistDismissed ?? false;

    const checklistItems = Object.values(checklist) as Array<{ done?: boolean; skipped?: boolean }>;
    const onboardingComplete = checklistDismissed || (
      checklistItems.length > 0 &&
      checklistItems.every(item => item.done || item.skipped)
    );

    return {
      accountCount,
      hasPlaid,
      hasActionRequired,
      plaidPendingCount,
      importPendingCount,
      totalReviewCount,
      hasPortfolioData,
      hasStaleManualAssets,
      insightCount,
      onboardingComplete,
      checklistDismissed,
      checklist,
      isLoading: accountsLoading || metricsLoading || onboardingLoading,
    };
  }, [
    accounts, plaidData, pendingImportData, metrics,
    portfolioData, insightData, onboardingData,
    accountsLoading, metricsLoading, onboardingLoading,
  ]);

  return {
    signals,
    accounts,
    metrics: metrics ?? undefined,
    portfolioCurrency,
    metricsLoading,
    accountsLoading,
  };
}

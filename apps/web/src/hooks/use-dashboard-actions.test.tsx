import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useDashboardActions } from './use-dashboard-actions';
import type { UserSignals } from '@/hooks/use-user-signals';

vi.mock('@/lib/dashboard-actions', () => ({
  DASHBOARD_ACTIONS: [
    {
      id: 'connect-bank',
      label: 'Connect Bank',
      description: 'Link your bank account',
      icon: null,
      href: '/accounts',
      slot: 'onboarding',
      priority: 1,
      visible: (signals: UserSignals, context: string) => context === 'onboarding' && signals.accountCount === 0,
    },
    {
      id: 'review-transactions',
      label: 'Review Transactions',
      description: 'Review pending transactions',
      icon: null,
      href: '/review',
      slot: 'quickAction',
      priority: 2,
      visible: (signals: UserSignals) => signals.totalReviewCount > 0,
    },
    {
      id: 'import-csv',
      label: 'Import CSV',
      description: 'Import your transactions',
      icon: null,
      href: '/import',
      slot: 'both',
      priority: 3,
      visible: () => true,
    },
  ],
}));

const baseSignals: UserSignals = {
  accountCount: 0,
  hasPlaid: false,
  hasActionRequired: false,
  plaidPendingCount: 0,
  importPendingCount: 0,
  totalReviewCount: 0,
  hasPortfolioData: false,
  hasStaleManualAssets: false,
  insightCount: 0,
  onboardingComplete: false,
  checklistDismissed: false,
  isNewUser: true,
  daysActive: 0,
};

describe('useDashboardActions', () => {
  it('returns onboarding and quick actions', () => {
    const { result } = renderHook(() => useDashboardActions(baseSignals));

    expect(result.current.onboardingActions).toBeDefined();
    expect(result.current.quickActions).toBeDefined();
    expect(Array.isArray(result.current.onboardingActions)).toBe(true);
    expect(Array.isArray(result.current.quickActions)).toBe(true);
  });

  it('filters onboarding actions based on signals', () => {
    const { result } = renderHook(() => useDashboardActions(baseSignals));

    // connect-bank visible when accountCount === 0
    const onboardingIds = result.current.onboardingActions.map((a) => a.id);
    expect(onboardingIds).toContain('connect-bank');
  });

  it('filters quick actions based on signals', () => {
    const signals = { ...baseSignals, totalReviewCount: 5, onboardingComplete: true };
    const { result } = renderHook(() => useDashboardActions(signals));

    const quickIds = result.current.quickActions.map((a) => a.id);
    expect(quickIds).toContain('review-transactions');
  });

  it('deduplicates both-slot actions from quick actions when in onboarding', () => {
    // import-csv is slot 'both', should appear in onboarding but not quick actions
    const { result } = renderHook(() => useDashboardActions(baseSignals));

    const onboardingIds = result.current.onboardingActions.map((a) => a.id);
    const quickIds = result.current.quickActions.map((a) => a.id);

    expect(onboardingIds).toContain('import-csv');
    expect(quickIds).not.toContain('import-csv');
  });
});

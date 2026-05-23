import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subMonths, format } from 'date-fns';
import Dashboard from './dashboard';
import * as UseSignals from '@/hooks/use-user-signals';
import * as UseActions from '@/hooks/use-dashboard-actions';
import * as UsePortfolioHistory from '@/hooks/use-portfolio-history';
import * as TenantMeta from '@/utils/tenantMetaStorage';

// Mocks
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));
vi.mock('@/utils/tenantMetaStorage');

vi.mock('@/hooks/use-user-signals');
vi.mock('@/hooks/use-dashboard-actions');
vi.mock('@/hooks/use-portfolio-history');

// Capture HeroNetWorth props for assertions
let heroNetWorthProps: Record<string, unknown> = {};
vi.mock('@/components/onboarding/setup-checklist', () => ({ SetupChecklist: () => <div data-testid="setup-checklist" /> }));
vi.mock('@/components/dashboard/hero-net-worth', () => ({
  HeroNetWorth: (props: Record<string, unknown>) => {
    heroNetWorthProps = props;
    return <div data-testid="hero-net-worth" />;
  },
}));
vi.mock('@/components/dashboard/synced-accounts-card', () => ({ SyncedAccountsCard: () => <div data-testid="synced-accounts-card" /> }));
vi.mock('@/components/dashboard/expense-split-card', () => ({ ExpenseSplitCard: () => <div data-testid="expense-split-card" /> }));
vi.mock('@/components/dashboard/quick-actions-card', () => ({ QuickActionsCard: () => <div data-testid="quick-actions-card" /> }));
vi.mock('@/components/dashboard/recent-transactions-card', () => ({ RecentTransactionsCard: () => <div data-testid="recent-transactions-card" /> }));

const defaultSignals = {
  signals: {},
  accounts: [{ id: 1 }],
  metrics: { netWorth: 100000, netIncome: 5000, discretionaryIncome: 0, netSavings: 0 },
  portfolioCurrency: 'USD',
  metricsLoading: false,
  accountsLoading: false,
} as unknown as ReturnType<typeof UseSignals.useUserSignals>;

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(TenantMeta.getTenantMeta).mockReturnValue(null);
    vi.mocked(UseActions.useDashboardActions).mockReturnValue(
      { quickActions: [], onboardingActions: [] } as ReturnType<typeof UseActions.useDashboardActions>,
    );
    vi.mocked(UsePortfolioHistory.usePortfolioHistory).mockReturnValue(
      { data: { history: [] } } as unknown as ReturnType<typeof UsePortfolioHistory.usePortfolioHistory>,
    );
  });

  it('renders an empty state when metrics and accounts are zero', () => {
    vi.mocked(UseSignals.useUserSignals).mockReturnValue({
      signals: {},
      accounts: [],
      metrics: { netWorth: 0, netIncome: 0, discretionaryIncome: 0, netSavings: 0 },
      portfolioCurrency: 'USD',
      metricsLoading: false,
      accountsLoading: false,
    } as unknown as ReturnType<typeof UseSignals.useUserSignals>);

    render(<Dashboard />);

    expect(screen.getByText('pages.dashboard.title')).toBeInTheDocument();
    
    // Renders setup checklist and empty text instead of charts
    expect(screen.getByTestId('setup-checklist')).toBeInTheDocument();
    expect(screen.getByText('Your dashboard will come to life once you add some data.')).toBeInTheDocument();
    expect(screen.queryByTestId('hero-net-worth')).not.toBeInTheDocument();
  });

  it('renders full dashboard when data exists', () => {
    vi.mocked(UseSignals.useUserSignals).mockReturnValue(defaultSignals);

    render(<Dashboard />);

    // Because data exists, it should show the hero, the charts, actions
    expect(screen.getByTestId('hero-net-worth')).toBeInTheDocument();
    expect(screen.getByTestId('synced-accounts-card')).toBeInTheDocument();
    expect(screen.getByTestId('expense-split-card')).toBeInTheDocument();
    expect(screen.getByTestId('quick-actions-card')).toBeInTheDocument();
    expect(screen.getByTestId('recent-transactions-card')).toBeInTheDocument();
  });

  it('passes previousNetWorth from the history entry closest to 1 month ago', () => {
    const today = new Date();
    const oneMonthAgo = subMonths(today, 1);
    const threeMonthsAgo = subMonths(today, 3);

    // Entry exactly 1 month ago: Asset=80000, no debt/investments → netWorth 80000
    // Entry 3 months ago: Asset=50000 → netWorth 50000
    vi.mocked(UsePortfolioHistory.usePortfolioHistory).mockReturnValue({
      data: {
        history: [
          {
            date: format(threeMonthsAgo, 'yyyy-MM-dd'),
            Asset: { total: 50000, groups: {} },
          },
          {
            date: format(oneMonthAgo, 'yyyy-MM-dd'),
            Asset: { total: 80000, groups: {} },
          },
        ],
      },
    } as unknown as ReturnType<typeof UsePortfolioHistory.usePortfolioHistory>);

    vi.mocked(UseSignals.useUserSignals).mockReturnValue(defaultSignals);

    render(<Dashboard />);

    // Should pick the entry closest to 1 month ago (80000), not 3 months ago (50000)
    expect(heroNetWorthProps.previousNetWorth).toBe(80000);
  });

  it('uses last history entry as net worth and first as previousNetWorth for a historical year', () => {
    // Mock tenant meta to return a historical year as the first available year
    const historicalYear = (new Date().getFullYear() - 1).toString();
    vi.mocked(TenantMeta.getTenantMeta).mockReturnValue({
      transactionYears: [parseInt(historicalYear, 10)],
    } as unknown as ReturnType<typeof TenantMeta.getTenantMeta>);

    vi.mocked(UsePortfolioHistory.usePortfolioHistory).mockReturnValue({
      data: {
        history: [
          // First entry: start of historical year → Asset=60000
          { date: `${historicalYear}-01-15`, Asset: { total: 60000, groups: {} } },
          // Last entry: end of historical year → Asset=90000
          { date: `${historicalYear}-12-15`, Asset: { total: 90000, groups: {} } },
        ],
      },
    } as unknown as ReturnType<typeof UsePortfolioHistory.usePortfolioHistory>);

    vi.mocked(UseSignals.useUserSignals).mockReturnValue(defaultSignals);

    render(<Dashboard />);

    // Net worth should be the last history entry (90000), not metrics.netWorth (100000)
    expect(heroNetWorthProps.netWorth).toBe(90000);
    // previousNetWorth should be the first history entry (start of year: 60000)
    expect(heroNetWorthProps.previousNetWorth).toBe(60000);
  });
});

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Dashboard from './dashboard';
import * as UseSignals from '@/hooks/use-user-signals';
import * as UseActions from '@/hooks/use-dashboard-actions';
import * as UsePortfolioHistory from '@/hooks/use-portfolio-history';

// Mocks
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));

vi.mock('@/hooks/use-user-signals');
vi.mock('@/hooks/use-dashboard-actions');
vi.mock('@/hooks/use-portfolio-history');

// Mock child components
vi.mock('@/components/onboarding/setup-checklist', () => ({ SetupChecklist: () => <div data-testid="setup-checklist" /> }));
vi.mock('@/components/dashboard/hero-net-worth', () => ({ HeroNetWorth: () => <div data-testid="hero-net-worth" /> }));
vi.mock('@/components/dashboard/synced-accounts-card', () => ({ SyncedAccountsCard: () => <div data-testid="synced-accounts-card" /> }));
vi.mock('@/components/dashboard/expense-split-card', () => ({ ExpenseSplitCard: () => <div data-testid="expense-split-card" /> }));
vi.mock('@/components/dashboard/quick-actions-card', () => ({ QuickActionsCard: () => <div data-testid="quick-actions-card" /> }));
vi.mock('@/components/dashboard/recent-transactions-card', () => ({ RecentTransactionsCard: () => <div data-testid="recent-transactions-card" /> }));

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
      metrics: { netWorth: 0, netIncome: 0, grossProfit: 0, netProfit: 0 },
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
    vi.mocked(UseSignals.useUserSignals).mockReturnValue({
      signals: {},
      accounts: [{ id: 1 }],
      metrics: { netWorth: 100000, netIncome: 5000, grossProfit: 0, netProfit: 0 },
      portfolioCurrency: 'USD',
      metricsLoading: false,
      accountsLoading: false,
    } as unknown as ReturnType<typeof UseSignals.useUserSignals>);

    render(<Dashboard />);
    
    // Because data exists, it should show the hero, the charts, actions
    expect(screen.getByTestId('hero-net-worth')).toBeInTheDocument();
    expect(screen.getByTestId('synced-accounts-card')).toBeInTheDocument();
    expect(screen.getByTestId('expense-split-card')).toBeInTheDocument();
    expect(screen.getByTestId('quick-actions-card')).toBeInTheDocument();
    expect(screen.getByTestId('recent-transactions-card')).toBeInTheDocument();
  });
});

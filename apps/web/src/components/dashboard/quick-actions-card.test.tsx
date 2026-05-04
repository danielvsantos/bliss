import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QuickActionsCard } from './quick-actions-card';
import type { DashboardAction } from '@/lib/dashboard-actions';
import type { UserSignals } from '@/hooks/use-user-signals';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const makeAction = (overrides: Partial<DashboardAction> = {}): DashboardAction => ({
  id: 'action-1',
  label: 'Add Transaction',
  href: '/transactions',
  icon: <svg data-testid="icon-1" />,
  ...overrides,
});

const defaultSignals: UserSignals = {
  pendingPlaidCount: 0,
  pendingImportCount: 0,
  hasPlaidConnection: false,
  hasImports: false,
  onboardingComplete: true,
  newInsightsCount: 0,
};

const renderCard = (
  actions: DashboardAction[] = [],
  signals: UserSignals = defaultSignals,
) =>
  render(
    <MemoryRouter>
      <QuickActionsCard actions={actions} signals={signals} />
    </MemoryRouter>
  );

describe('QuickActionsCard', () => {
  it('renders card title', () => {
    renderCard();
    expect(screen.getByText('dashboard.quickActions')).toBeInTheDocument();
  });

  it('renders subtitle text', () => {
    renderCard();
    expect(screen.getByText('dashboard.commonTasks')).toBeInTheDocument();
  });

  it('renders each action label', () => {
    const actions = [
      makeAction({ id: '1', label: 'View Transactions', href: '/transactions' }),
      makeAction({ id: '2', label: 'Add Account', href: '/accounts' }),
    ];
    renderCard(actions);
    expect(screen.getByText('View Transactions')).toBeInTheDocument();
    expect(screen.getByText('Add Account')).toBeInTheDocument();
  });

  it('renders action icon', () => {
    const actions = [makeAction({ id: '1', icon: <svg data-testid="my-icon" /> })];
    renderCard(actions);
    expect(screen.getByTestId('my-icon')).toBeInTheDocument();
  });

  it('renders badge when badge fn returns > 0', () => {
    const actions = [
      makeAction({
        id: '1',
        label: 'Review',
        badge: () => 5,
      }),
    ];
    renderCard(actions);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('does not render badge when badge fn returns 0', () => {
    const actions = [
      makeAction({
        id: '1',
        label: 'Review',
        badge: () => 0,
      }),
    ];
    renderCard(actions);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('renders empty state with no actions', () => {
    renderCard([]);
    expect(screen.getByText('dashboard.quickActions')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <MemoryRouter>
        <QuickActionsCard actions={[]} signals={defaultSignals} className="custom-class" />
      </MemoryRouter>
    );
    // Custom class is on the inner card component
    expect(container.querySelector('.custom-class')).toBeInTheDocument();
  });
});

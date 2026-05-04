import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SyncedAccountsCard } from './synced-accounts-card';
import type { EnrichedAccount } from '@/hooks/use-account-list';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const makeAccount = (overrides: Partial<EnrichedAccount> = {}): EnrichedAccount => ({
  id: 1,
  accountName: 'Test Checking',
  institution: 'Test Bank',
  bankId: 1,
  mask: '•••• 1234',
  currencyCode: 'USD',
  countryId: 'US',
  status: 'synced',
  healthLabel: 'Healthy',
  healthColor: 'positive',
  lastSync: '2024-01-01T00:00:00Z',
  plaidItem: null,
  plaidAccountId: null,
  historicalSyncComplete: true,
  earliestTransactionDate: null,
  originalAccount: {} as unknown as EnrichedAccount['originalAccount'],
  ...overrides,
});

const renderCard = (props: Parameters<typeof SyncedAccountsCard>[0]) =>
  render(<MemoryRouter><SyncedAccountsCard {...props} /></MemoryRouter>);

describe('SyncedAccountsCard', () => {
  it('renders the card title translation key', () => {
    renderCard({ accounts: [], isLoading: false });
    // The component uses t('dashboard.syncedAccounts') — with our mock t returns the key
    expect(screen.getByText('dashboard.syncedAccounts')).toBeInTheDocument();
  });

  it('shows skeleton while loading', () => {
    const { container } = renderCard({ accounts: [], isLoading: true });
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('shows empty state when no accounts', () => {
    renderCard({ accounts: [], isLoading: false });
    expect(screen.getByText('dashboard.noAccountsConnected')).toBeInTheDocument();
  });

  it('renders a list of accounts by name', () => {
    const accounts = [
      makeAccount({ id: 1, accountName: 'Checking', mask: '•••• 1234' }),
      makeAccount({ id: 2, accountName: 'Savings', mask: '•••• 5678' }),
    ];
    renderCard({ accounts, isLoading: false });
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
  });

  it('shows account currency code', () => {
    const accounts = [makeAccount({ id: 1, accountName: 'Acc', mask: '•••• 9999', currencyCode: 'EUR' })];
    renderCard({ accounts, isLoading: false });
    expect(screen.getByText(/EUR/)).toBeInTheDocument();
  });

  it('renders connected count text', () => {
    const accounts = [makeAccount({ id: 1, accountName: 'Acc1' })];
    renderCard({ accounts, isLoading: false });
    expect(screen.getByText(/1.*dashboard.connected/)).toBeInTheDocument();
  });

  it('renders multiple accounts with different health statuses', () => {
    const accounts = [
      makeAccount({ id: 1, accountName: 'Good', status: 'synced', healthColor: 'positive' }),
      makeAccount({ id: 2, accountName: 'Bad', status: 'action-required', healthColor: 'warning' }),
      makeAccount({ id: 3, accountName: 'Manual', status: 'manual', healthColor: 'muted' }),
    ];
    renderCard({ accounts, isLoading: false });
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByText('Bad')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });
});

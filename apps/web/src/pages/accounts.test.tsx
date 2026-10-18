import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { EnrichedAccount } from '@/hooks/use-account-list';
import AccountsPage from './accounts';

// Mock i18n — echo the key, and fold {{name}} / {{count}} interpolation into the
// output so assertions can check that dynamic values reached the component.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      if (opts && 'name' in opts) return `${k} ${opts.name}`;
      if (opts && 'count' in opts) return `${k} ${opts.count}`;
      return k;
    },
  }),
}));

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast }),
}));

const mockRefetch = vi.fn();
const mockAccount: EnrichedAccount = {
  id: 1,
  accountName: 'Everyday Checking',
  institution: 'Chase',
  bankId: 10,
  mask: '•••• 1234',
  currencyCode: 'USD',
  countryId: 'US',
  status: 'manual',
  healthLabel: 'Manual',
  healthColor: 'muted',
  lastSync: null,
  plaidItem: null,
  plaidAccountId: null,
  historicalSyncComplete: true,
  earliestTransactionDate: null,
  originalAccount: {} as EnrichedAccount['originalAccount'],
};

vi.mock('@/hooks/use-account-list', () => ({
  useAccountList: () => ({
    accounts: [mockAccount],
    plaidItems: [],
    isLoading: false,
    refetch: mockRefetch,
  }),
  accountListKeys: {
    all: ['account-list'],
    plaidItems: () => ['plaid-items'],
  },
}));

const deleteAccount = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { deleteAccount: (...args: unknown[]) => deleteAccount(...args) },
}));

const invalidatePortfolioQueries = vi.fn();
vi.mock('@/lib/query-config', () => ({
  invalidatePortfolioQueries: (...args: unknown[]) => invalidatePortfolioQueries(...args),
}));

// List panel — expose a trigger that selects the account.
vi.mock('@/components/accounts/account-list-panel', () => ({
  AccountListPanel: ({ onSelectAccount }: { onSelectAccount: (id: number) => void }) => (
    <button data-testid="select-account" onClick={() => onSelectAccount(1)}>
      select
    </button>
  ),
}));

// Detail panel — expose the Delete trigger wired to the real onDelete prop.
vi.mock('@/components/accounts/account-detail-panel', () => ({
  AccountDetailPanel: ({ onDelete }: { onDelete: () => void }) => (
    <button data-testid="delete-trigger" onClick={onDelete}>
      delete
    </button>
  ),
}));

vi.mock('@/components/accounts/add-account-modal', () => ({
  AddAccountModal: () => null,
}));
vi.mock('@/components/plaid-connect', () => ({
  PlaidConnect: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

// Enable Banking (#132): configured or not per test; the UI pieces are stubbed.
// Status (#148): `configurable` = the viewer is an admin.
const ebEnabled = vi.fn(() => false);
const ebConfigurable = vi.fn(() => false);
vi.mock('@/hooks/use-enable-banking', () => ({
  useEnableBankingStatus: () => ({
    data: { enabled: ebEnabled(), configurable: ebConfigurable(), pausedConnections: 0 },
  }),
}));
vi.mock('@/components/enable-banking/connect-dialog', () => ({
  EnableBankingConnect: () => <button data-testid="eb-connect">eb</button>,
}));
vi.mock('@/components/enable-banking/pending-connections', () => ({
  PendingEnableBankingConnections: () => null,
}));
vi.mock('@/components/enable-banking/mapping-dialog', () => ({
  EnableBankingMappingDialog: ({ connectionId }: { connectionId: string | null }) =>
    connectionId ? <div data-testid="eb-mapping-dialog">{connectionId}</div> : null,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

const createWrapper = (initialEntry: string) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

function renderPage(initialEntry = '/accounts') {
  const Wrapper = createWrapper(initialEntry);
  return render(<AccountsPage />, { wrapper: Wrapper });
}

async function openDeleteDialog() {
  fireEvent.click(screen.getByTestId('select-account'));
  fireEvent.click(await screen.findByTestId('delete-trigger'));
  await screen.findByText('accountsPage.deleteTitle');
}

describe('AccountsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ebEnabled.mockReturnValue(false);
    ebConfigurable.mockReturnValue(false);
  });

  it('renders accounts page heading', () => {
    renderPage();
    expect(screen.getByText('accountsPage.title')).toBeInTheDocument();
    expect(screen.getByText('accountsPage.subtitle')).toBeInTheDocument();
  });

  it('opens the delete confirmation dialog naming the account', async () => {
    renderPage();
    await openDeleteDialog();

    expect(screen.getByText('accountsPage.deleteTitle')).toBeInTheDocument();
    expect(screen.getByText('accountsPage.deleteConfirm Everyday Checking')).toBeInTheDocument();
  });

  it('Cancel closes the dialog without calling the API', async () => {
    renderPage();
    await openDeleteDialog();

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    await waitFor(() =>
      expect(screen.queryByText('accountsPage.deleteTitle')).not.toBeInTheDocument(),
    );
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('confirming a successful delete clears selection, refetches, and invalidates portfolio queries', async () => {
    deleteAccount.mockResolvedValueOnce(undefined);
    renderPage();
    await openDeleteDialog();

    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith(1));
    await waitFor(() =>
      expect(screen.queryByText('accountsPage.deleteTitle')).not.toBeInTheDocument(),
    );
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'accountsPage.deleteSuccess' }),
    );
    expect(mockRefetch).toHaveBeenCalled();
    expect(invalidatePortfolioQueries).toHaveBeenCalled();
  });

  it('a 409 HAS_TRANSACTIONS keeps the dialog open with the specific reason copy', async () => {
    deleteAccount.mockRejectedValueOnce({
      response: { status: 409, data: { reason: 'HAS_TRANSACTIONS', transactionCount: 2 } },
    });
    renderPage();
    await openDeleteDialog();

    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));

    expect(await screen.findByText('accountsPage.deleteBlockedTransactions 2')).toBeInTheDocument();
    expect(screen.getByText('accountsPage.deleteTitle')).toBeInTheDocument();
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('a 409 PLAID_CONNECTED keeps the dialog open with the disconnect-first copy', async () => {
    deleteAccount.mockRejectedValueOnce({
      response: { status: 409, data: { reason: 'PLAID_CONNECTED' } },
    });
    renderPage();
    await openDeleteDialog();

    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));

    expect(await screen.findByText('accountsPage.deleteBlockedPlaid')).toBeInTheDocument();
    expect(screen.getByText('accountsPage.deleteTitle')).toBeInTheDocument();
  });

  describe('Enable Banking callback (#132)', () => {
    it('opens the mapping dialog for ?eb=map&connection=<id> and strips the params', async () => {
      ebEnabled.mockReturnValue(true);
      renderPage('/accounts?eb=map&connection=item-1');

      expect(await screen.findByTestId('eb-mapping-dialog')).toHaveTextContent('item-1');
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/accounts$/));
    });

    it('shows the reconnected toast for ?eb=reconnected', async () => {
      ebEnabled.mockReturnValue(true);
      renderPage('/accounts?eb=reconnected&connection=item-1');

      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'enableBanking.callback.reconnectedTitle' })),
      );
      expect(screen.queryByTestId('eb-mapping-dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/accounts$/));
    });

    it.each(['invalid_state', 'denied', 'exchange_failed', 'not_enabled'])(
      'shows a specific error toast for ?eb_error=%s',
      async (code) => {
        renderPage(`/accounts?eb_error=${code}`);
        await waitFor(() =>
          expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
              title: 'enableBanking.callback.errorTitle',
              description: `enableBanking.callback.${code}`,
              variant: 'destructive',
            }),
          ),
        );
        expect(toast).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/accounts$/));
      },
    );

    it('falls back to a generic message for an unknown error code', async () => {
      renderPage('/accounts?eb_error=weird');
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'enableBanking.callback.unknown' })),
      );
    });

    it('never renders the mapping dialog when Enable Banking is not configured', async () => {
      renderPage('/accounts?eb=map&connection=item-1');
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/accounts$/));
      expect(screen.queryByTestId('eb-mapping-dialog')).not.toBeInTheDocument();
    });
  });

  describe('Enable Banking setup entry point (#148)', () => {
    it('shows admins of a tenant without credentials a link to Settings → Bank sync', () => {
      ebConfigurable.mockReturnValue(true);
      renderPage();
      expect(screen.getByTestId('eb-setup-link')).toHaveAttribute('href', '/settings?tab=bank-sync');
      expect(screen.getByText('enableBanking.credentials.setupLink')).toBeInTheDocument();
    });

    it('shows members and viewers no Enable Banking entry point', () => {
      renderPage();
      expect(screen.queryByTestId('eb-setup-link')).not.toBeInTheDocument();
    });

    it('drops the setup link once the tenant has credentials', () => {
      ebEnabled.mockReturnValue(true);
      ebConfigurable.mockReturnValue(true);
      renderPage();
      expect(screen.queryByTestId('eb-setup-link')).not.toBeInTheDocument();
    });
  });
});

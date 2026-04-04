import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AccountsPage from './accounts';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Mock hooks
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mockRefetch = vi.fn();
vi.mock('@/hooks/use-account-list', () => ({
  useAccountList: () => ({
    accounts: [],
    plaidItems: [],
    isLoading: false,
    refetch: mockRefetch,
  }),
  accountListKeys: {
    all: ['account-list'],
    plaidItems: () => ['plaid-items'],
  },
}));

// Mock child components
vi.mock('@/components/accounts/account-list-panel', () => ({
  AccountListPanel: () => <div data-testid="account-list-panel" />,
}));
vi.mock('@/components/accounts/account-detail-panel', () => ({
  AccountDetailPanel: () => <div data-testid="account-detail-panel" />,
}));
vi.mock('@/components/accounts/add-account-modal', () => ({
  AddAccountModal: () => null,
}));
vi.mock('@/components/plaid-connect', () => ({
  PlaidConnect: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('AccountsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders accounts page heading', () => {
    const Wrapper = createWrapper();
    render(<AccountsPage />, { wrapper: Wrapper });

    expect(screen.getByText('Accounts')).toBeInTheDocument();
    expect(screen.getByText('Manage your bank connections and manual accounts.')).toBeInTheDocument();
  });

  it('renders the account list panel', () => {
    const Wrapper = createWrapper();
    render(<AccountsPage />, { wrapper: Wrapper });

    expect(screen.getByTestId('account-list-panel')).toBeInTheDocument();
  });

  it('shows empty state when no account is selected', () => {
    const Wrapper = createWrapper();
    render(<AccountsPage />, { wrapper: Wrapper });

    expect(screen.getByText('Select an account')).toBeInTheDocument();
  });
});

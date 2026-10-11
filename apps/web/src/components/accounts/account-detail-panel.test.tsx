import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock i18n — return the key so assertions can target translation keys directly.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mutate = vi.fn();
vi.mock('@/hooks/use-plaid-actions', () => ({
  useResyncPlaidItem: () => ({ mutate, isPending: false }),
  useRotatePlaidToken: () => ({ mutate, isPending: false }),
  useDisconnectPlaidItem: () => ({ mutate, isPending: false }),
}));

vi.mock('@/components/plaid-connect', () => ({
  PlaidConnect: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock('./connection-health', () => ({
  ConnectionHealth: () => <div data-testid="connection-health" />,
}));
vi.mock('./sync-logs-table', () => ({
  SyncLogsTable: () => <div data-testid="sync-logs-table" />,
}));
vi.mock('./bank-connection-card', () => ({
  BankConnectionCard: ({ item }: { item: { id: string } }) => <div data-testid="bank-connection-card">{item.id}</div>,
}));

import { AccountDetailPanel } from './account-detail-panel';
import type { EnrichedAccount } from '@/hooks/use-account-list';

function makeAccount(overrides: Partial<EnrichedAccount> = {}): EnrichedAccount {
  return {
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
    ...overrides,
  };
}

describe('AccountDetailPanel — delete control', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders an enabled Delete action for a manual account and calls onDelete on click', () => {
    const onDelete = vi.fn();
    render(
      <AccountDetailPanel
        account={makeAccount()}
        onEdit={vi.fn()}
        onRefetch={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: 'accountsPage.deleteAction' });
    expect(deleteBtn).toBeEnabled();
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('accountsPage.deleteBlockedPlaidHint')).not.toBeInTheDocument();
  });

  it('enables Delete for a disconnected (REVOKED) Plaid account', () => {
    const onDelete = vi.fn();
    render(
      <AccountDetailPanel
        account={makeAccount({
          status: 'disconnected',
          plaidItem: { id: 'p1', status: 'REVOKED' } as unknown as EnrichedAccount['plaidItem'],
        })}
        onEdit={vi.fn()}
        onRefetch={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: 'accountsPage.deleteAction' });
    expect(deleteBtn).toBeEnabled();
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('disables Delete and shows disconnect-first guidance for a connected Plaid account', () => {
    const onDelete = vi.fn();
    render(
      <AccountDetailPanel
        account={makeAccount({
          status: 'synced',
          plaidItem: { id: 'p1', status: 'ACTIVE' } as unknown as EnrichedAccount['plaidItem'],
        })}
        onEdit={vi.fn()}
        onRefetch={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: 'accountsPage.deleteAction' });
    expect(deleteBtn).toBeDisabled();
    expect(screen.getByText('accountsPage.deleteBlockedPlaidHint')).toBeInTheDocument();
    fireEvent.click(deleteBtn);
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('AccountDetailPanel — provider branch (#132)', () => {
  beforeEach(() => vi.clearAllMocks());

  const PLAID_ONLY_ACTIONS = [
    'accountDetail.resyncNow',
    'accountDetail.rotateToken',
    'accountDetail.relinkPlaid',
    'accountDetail.pauseSync',
    'accountDetail.reconnectBank',
  ];

  function renderWith(plaidItem: Record<string, unknown>, status: EnrichedAccount['status'] = 'synced') {
    render(
      <AccountDetailPanel
        account={makeAccount({ status, plaidItem: plaidItem as unknown as EnrichedAccount['plaidItem'] })}
        onEdit={vi.fn()}
        onRefetch={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
  }

  it('renders the bank connection card and hides every Plaid-only action for Enable Banking', () => {
    renderWith({ id: 'eb-item', status: 'ACTIVE', provider: 'ENABLE_BANKING', consentExpiration: new Date(Date.now() + 3 * 86400000).toISOString() });

    expect(screen.getByTestId('bank-connection-card')).toHaveTextContent('eb-item');
    expect(screen.getByText('enableBanking.detail.badge')).toBeInTheDocument();
    for (const key of PLAID_ONLY_ACTIONS) {
      expect(screen.queryByText(key)).not.toBeInTheDocument();
    }
    // Plaid consent banner, Plaid badge and the Plaid connection health (with its backfill) are not shown.
    expect(screen.queryByText('accountDetail.consentExpiringSoon')).not.toBeInTheDocument();
    expect(screen.queryByText('accountDetail.plaidConnected')).not.toBeInTheDocument();
    expect(screen.queryByTestId('connection-health')).not.toBeInTheDocument();
    expect(screen.queryByText(/accountDetail\.securityPlaid/)).not.toBeInTheDocument();
    // Sync logs are shared with Plaid.
    expect(screen.getByTestId('sync-logs-table')).toBeInTheDocument();
    // Still connected → delete blocked until disconnected.
    expect(screen.getByRole('button', { name: 'accountsPage.deleteAction' })).toBeDisabled();
    expect(screen.getByText('enableBanking.detail.deleteBlockedHint')).toBeInTheDocument();
    expect(screen.queryByText('accountsPage.deleteBlockedPlaidHint')).not.toBeInTheDocument();
  });

  it('a disconnected Enable Banking account offers no Plaid reconnect and can be deleted', () => {
    renderWith({ id: 'eb-item', status: 'REVOKED', provider: 'ENABLE_BANKING' }, 'disconnected');

    expect(screen.getByTestId('bank-connection-card')).toBeInTheDocument();
    expect(screen.queryByText('accountDetail.reconnectBank')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'accountsPage.deleteAction' })).toBeEnabled();
  });

  it('keeps the Plaid branch unchanged (actions present, no Enable Banking card)', () => {
    renderWith({ id: 'p1', status: 'ACTIVE', provider: 'PLAID' });

    expect(screen.queryByTestId('bank-connection-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('connection-health')).toBeInTheDocument();
    for (const key of ['accountDetail.resyncNow', 'accountDetail.rotateToken', 'accountDetail.relinkPlaid', 'accountDetail.pauseSync']) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
    expect(screen.getByText('accountDetail.plaidConnected')).toBeInTheDocument();
  });

  it('treats an item without a provider (older API) as Plaid', () => {
    renderWith({ id: 'p1', status: 'ACTIVE' });
    expect(screen.queryByTestId('bank-connection-card')).not.toBeInTheDocument();
    expect(screen.getByText('accountDetail.resyncNow')).toBeInTheDocument();
  });
});

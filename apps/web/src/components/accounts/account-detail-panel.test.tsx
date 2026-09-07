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

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AccountListPanel } from './account-list-panel';
import type { EnrichedAccount } from '@/hooks/use-account-list';

const mockAccounts: EnrichedAccount[] = [
  {
    id: 1,
    accountName: 'Everyday Checking',
    institution: 'Chase',
    bankId: 10,
    mask: '•••• 1234',
    currencyCode: 'USD',
    countryId: 'US',
    status: 'synced',
    healthLabel: 'Healthy',
    healthColor: 'positive',
    lastSync: null,
    plaidItem: { id: 'p1' } as any,
    plaidAccountId: 100,
    historicalSyncComplete: true,
    earliestTransactionDate: null,
    originalAccount: {} as any,
  },
  {
    id: 2,
    accountName: 'Travel Credit Card',
    institution: 'Amex',
    bankId: 11,
    mask: '•••• 5678',
    currencyCode: 'USD',
    countryId: 'US',
    status: 'disconnected',
    healthLabel: 'Disconnected',
    healthColor: 'muted',
    lastSync: null,
    plaidItem: { id: 'p2' } as any,
    plaidAccountId: 101,
    historicalSyncComplete: true,
    earliestTransactionDate: null,
    originalAccount: {} as any,
  },
  {
    id: 3,
    accountName: 'Cash Wallet',
    institution: 'Unknown',
    bankId: 12,
    mask: '',
    currencyCode: 'EUR',
    countryId: 'FR',
    status: 'manual',
    healthLabel: 'Manual',
    healthColor: 'muted',
    lastSync: null,
    plaidItem: null, // Manual account
    plaidAccountId: null,
    historicalSyncComplete: true,
    earliestTransactionDate: null,
    originalAccount: {} as any,
  },
];

describe('AccountListPanel Component', () => {
  it('renders loading state when isLoading is true', () => {
    const { container } = render(
      <AccountListPanel
        accounts={[]}
        selectedAccountId={null}
        onSelectAccount={vi.fn()}
        isLoading={true}
      />
    );
    // There are 3 pulse skeletons
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBe(3);
  });

  it('renders empty state when no accounts exist', () => {
    render(
      <AccountListPanel
        accounts={[]}
        selectedAccountId={null}
        onSelectAccount={vi.fn()}
        isLoading={false}
      />
    );
    expect(screen.getByText('No accounts yet.')).toBeInTheDocument();
  });

  it('groups accounts correctly block', () => {
    render(
      <AccountListPanel
        accounts={mockAccounts}
        selectedAccountId={null}
        onSelectAccount={vi.fn()}
        isLoading={false}
      />
    );
    
    // Check group headers are rendered
    expect(screen.getByText('Chase — 1')).toBeInTheDocument();
    expect(screen.getByText('Amex — 1')).toBeInTheDocument();
    expect(screen.getByText('Manual Accounts — 1')).toBeInTheDocument();

    // Check account names
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument();
    expect(screen.getByText('Travel Credit Card')).toBeInTheDocument();
    expect(screen.getByText('Cash Wallet')).toBeInTheDocument();

    // Check badges
    expect(screen.getByText('Synced')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('filters accounts by search query', () => {
    render(
      <AccountListPanel
        accounts={mockAccounts}
        selectedAccountId={null}
        onSelectAccount={vi.fn()}
        isLoading={false}
      />
    );

    const searchInput = screen.getByPlaceholderText('Search accounts...');
    
    // Type "checking"
    fireEvent.change(searchInput, { target: { value: 'checking' } });
    
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument();
    expect(screen.queryByText('Travel Credit Card')).not.toBeInTheDocument();
    expect(screen.queryByText('Cash Wallet')).not.toBeInTheDocument();

    // Empty state for no match
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
    expect(screen.getByText('No accounts match your search.')).toBeInTheDocument();
  });

  it('calls onSelectAccount when an account is clicked', () => {
    const onSelectMock = vi.fn();
    render(
      <AccountListPanel
        accounts={mockAccounts}
        selectedAccountId={1}
        onSelectAccount={onSelectMock}
        isLoading={false}
      />
    );

    const amexButton = screen.getByText('Travel Credit Card').closest('button');
    fireEvent.click(amexButton!);
    expect(onSelectMock).toHaveBeenCalledWith(2);
  });
});

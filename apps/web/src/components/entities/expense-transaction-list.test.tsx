import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExpenseTransactionList } from './expense-transaction-list';
import * as UseTransactions from '@/hooks/use-transactions';
import { mockQueryResult, mockQueryLoading, mockQueryError } from '@/test/mock-helpers';

// Mock the hook to control its return value directly without MSW here
vi.mock('@/hooks/use-transactions');

describe('ExpenseTransactionList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultProps = {
    dateRange: { from: new Date('2023-01-01'), to: new Date('2023-01-31') },
    currency: 'USD',
    categoryGroup: 'Housing'
  };

  const renderComponent = () => {
    return render(
      <MemoryRouter>
        <ExpenseTransactionList {...defaultProps} />
      </MemoryRouter>
    );
  };

  it('renders loading skeleton', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(mockQueryLoading());

    const { container } = renderComponent();
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders error state', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(mockQueryError());

    renderComponent();
    expect(screen.getByText('notifications.error.generic')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(
      mockQueryResult({ transactions: [], total: 0, page: 1, limit: 100, totalPages: 1 }),
    );

    renderComponent();
    expect(screen.getByText('pages.transactions.noTransactions')).toBeInTheDocument();
  });

  it('renders transaction rows correctly', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(
      mockQueryResult({
        transactions: [
          {
            id: 1,
            transaction_date: '2023-01-15',
            description: 'Mortgage Payment',
            debit: 1500,
            currency: 'USD',
            category: { name: 'Mortgage & Rent' }
          }
        ],
        total: 1,
        page: 1,
        limit: 100,
        totalPages: 1
      }),
    );

    renderComponent();

    // Default view is now "By Category", switch to Transactions
    fireEvent.click(screen.getByRole('button', { name: 'common.transactions' }));

    expect(screen.getByText('Mortgage Payment')).toBeInTheDocument();
    expect(screen.getByText('Mortgage & Rent')).toBeInTheDocument();
    // Currency formatting test => "$1,500.00"
    expect(screen.getByText('$1,500.00')).toBeInTheDocument();
  });
});

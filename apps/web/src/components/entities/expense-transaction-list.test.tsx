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

  it('nets a credit (refund) transaction into the displayed amount instead of showing zero', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(
      mockQueryResult({
        transactions: [
          {
            id: 2,
            transaction_date: '2023-01-20',
            description: 'Refund from Landlord',
            debit: null,
            credit: 200,
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
    fireEvent.click(screen.getByRole('button', { name: 'common.transactions' }));

    expect(screen.getByText('Refund from Landlord')).toBeInTheDocument();
    expect(screen.getByText('-$200.00')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('nets debit and credit transactions together in the category summary total', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(
      mockQueryResult({
        transactions: [
          {
            id: 3,
            transaction_date: '2023-01-05',
            description: 'Rent',
            debit: 1500,
            credit: null,
            currency: 'USD',
            category: { name: 'Mortgage & Rent' }
          },
          {
            id: 4,
            transaction_date: '2023-01-20',
            description: 'Partial Refund',
            debit: null,
            credit: 300,
            currency: 'USD',
            category: { name: 'Mortgage & Rent' }
          }
        ],
        total: 2,
        page: 1,
        limit: 100,
        totalPages: 1
      }),
    );

    renderComponent();

    // Default view is "By Category" — total should be 1500 - 300 = 1200
    expect(screen.getByText('$1,200.00')).toBeInTheDocument();
  });
});

// #140: sign-aware colouring, the "Include credits" toggle, the 1,000-row cap notice.
type ListData = NonNullable<ReturnType<typeof UseTransactions.useTransactions>['data']>;

describe('ExpenseTransactionList - net of credits (#140)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const props = {
    dateRange: { from: new Date('2023-01-01'), to: new Date('2023-01-31') },
    currency: 'USD',
    categoryGroup: 'Insurance',
  };

  const rows = {
    transactions: [
      { id: 10, transaction_date: '2023-01-05', description: 'Premium', debit: 100, credit: null, currency: 'USD', category: { name: 'Car Insurance' } },
      { id: 11, transaction_date: '2023-01-20', description: 'Claim payout', debit: null, credit: 400, currency: 'USD', category: { name: 'Car Insurance' } },
      { id: 12, transaction_date: '2023-01-21', description: 'Policy', debit: 50, credit: null, currency: 'USD', category: { name: 'Home Insurance' } },
    ],
    total: 3, page: 1, limit: 1000, totalPages: 1,
  } as unknown as ListData;

  const renderList = (extra: { includeCredits?: boolean } = {}) =>
    render(<MemoryRouter><ExpenseTransactionList {...props} {...extra} /></MemoryRouter>);

  it('renders a net-credit category and footer in positive styling with a minus', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(mockQueryResult(rows));
    renderList();
    const carCell = screen.getByText('-$300.00');
    expect(carCell).toHaveClass('text-positive');
    expect(carCell).not.toHaveClass('text-negative');
    expect(screen.getByText('$50.00')).toHaveClass('text-negative');
    // Footer: −300 + 50 = −250
    expect(screen.getByText('-$250.00')).toHaveClass('text-positive');
  });

  it('with "Include credits" off sums debits only and de-emphasises credit rows', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(mockQueryResult(rows));
    renderList({ includeCredits: false });
    expect(screen.getByText('$100.00')).toHaveClass('text-negative');
    expect(screen.getByText('$150.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common.transactions' }));
    expect(screen.getByText('Claim payout').closest('tr')).toHaveClass('opacity-60');
    expect(screen.getByText('Premium').closest('tr')).not.toHaveClass('opacity-60');
    expect(screen.getByText('-$400.00')).toHaveClass('text-positive');
  });

  it('shows the incomplete-totals notice when the summary hits the 1,000-row cap', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(mockQueryResult({ ...rows, total: 1500 }));
    renderList();
    expect(screen.getByTestId('summary-cap-notice')).toHaveTextContent('pages.expenses.breakdown.details.capNotice');
  });

  it('shows no notice when every transaction was aggregated', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(mockQueryResult(rows));
    renderList();
    expect(screen.queryByTestId('summary-cap-notice')).not.toBeInTheDocument();
  });
});

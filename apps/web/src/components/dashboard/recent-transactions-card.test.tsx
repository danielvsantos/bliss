import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RecentTransactionsCard } from './recent-transactions-card';
import { useTransactions } from '@/hooks/use-transactions';
import { mockQueryResult, mockQueryLoading } from '@/test/mock-helpers';
import type { Transaction } from '@/types/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/hooks/use-transactions');
vi.mock('@/lib/category-i18n', () => ({
  translateCategoryName: (_t: unknown, cat: { name: string }) => cat.name,
}));

const mockUseTransactions = vi.mocked(useTransactions);

const makeTransaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 1,
  description: 'Starbucks Coffee',
  transaction_date: '2025-01-15',
  credit: 0,
  debit: 5.5,
  currency: 'USD',
  accountId: 1,
  account: { name: 'Checking', currencyCode: 'USD', country: null },
  categoryId: 1,
  category: { name: 'Coffee', icon: '☕', type: 'Lifestyle', group: 'Food & Drink' },
  tags: [],
  ...overrides,
});

const renderCard = () =>
  render(<MemoryRouter><RecentTransactionsCard /></MemoryRouter>);

describe('RecentTransactionsCard', () => {
  it('shows skeleton while loading', () => {
    mockUseTransactions.mockReturnValue(mockQueryLoading());
    const { container } = renderCard();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders card title when loaded', () => {
    mockUseTransactions.mockReturnValue(
      mockQueryResult({ transactions: [], total: 0, page: 1, limit: 5, totalPages: 0 })
    );
    renderCard();
    expect(screen.getByText('dashboard.recentTransactions')).toBeInTheDocument();
  });

  it('shows empty state when no transactions', () => {
    mockUseTransactions.mockReturnValue(
      mockQueryResult({ transactions: [], total: 0, page: 1, limit: 5, totalPages: 0 })
    );
    renderCard();
    expect(screen.getByText('dashboard.noTransactionsYet')).toBeInTheDocument();
  });

  it('renders transaction descriptions', () => {
    mockUseTransactions.mockReturnValue(
      mockQueryResult({
        transactions: [
          makeTransaction({ id: 1, description: 'Starbucks', debit: 5 }),
          makeTransaction({ id: 2, description: 'Rent Payment', credit: 2000 }),
        ],
        total: 2, page: 1, limit: 5, totalPages: 1,
      })
    );
    renderCard();
    expect(screen.getByText('Starbucks')).toBeInTheDocument();
    expect(screen.getByText('Rent Payment')).toBeInTheDocument();
  });

  it('renders "view all transactions" link', () => {
    mockUseTransactions.mockReturnValue(
      mockQueryResult({ transactions: [], total: 0, page: 1, limit: 5, totalPages: 0 })
    );
    renderCard();
    expect(screen.getByText('dashboard.viewAllTransactions')).toBeInTheDocument();
  });

  it('renders category icon emoji', () => {
    mockUseTransactions.mockReturnValue(
      mockQueryResult({
        transactions: [makeTransaction({ category: { name: 'Food', icon: '🍕', type: 'Lifestyle', group: 'Food & Drink' } })],
        total: 1, page: 1, limit: 5, totalPages: 1,
      })
    );
    renderCard();
    expect(screen.getByText('🍕')).toBeInTheDocument();
  });
});

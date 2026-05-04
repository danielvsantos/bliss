import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RecentTransactionsCard } from './recent-transactions-card';
import { useTransactions } from '@/hooks/use-transactions';
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
  account: { id: 1, name: 'Checking', currencyCode: 'USD' } as any,
  category: { id: 1, name: 'Coffee', icon: '☕', type: 'Lifestyle' } as any,
  tags: [],
  ...overrides,
} as Transaction);

const renderCard = () =>
  render(<MemoryRouter><RecentTransactionsCard /></MemoryRouter>);

describe('RecentTransactionsCard', () => {
  it('shows skeleton while loading', () => {
    mockUseTransactions.mockReturnValue({
      data: undefined, isLoading: true, isError: false,
    } as any);
    const { container } = renderCard();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders card title when loaded', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [], total: 0, page: 1, limit: 5, totalPages: 0 },
      isLoading: false, isError: false,
    } as any);
    renderCard();
    expect(screen.getByText('dashboard.recentTransactions')).toBeInTheDocument();
  });

  it('shows empty state when no transactions', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [], total: 0, page: 1, limit: 5, totalPages: 0 },
      isLoading: false, isError: false,
    } as any);
    renderCard();
    expect(screen.getByText('dashboard.noTransactionsYet')).toBeInTheDocument();
  });

  it('renders transaction descriptions', () => {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [
          makeTransaction({ id: 1, description: 'Starbucks', debit: 5 }),
          makeTransaction({ id: 2, description: 'Rent Payment', credit: 2000 }),
        ],
        total: 2, page: 1, limit: 5, totalPages: 1,
      },
      isLoading: false, isError: false,
    } as any);
    renderCard();
    expect(screen.getByText('Starbucks')).toBeInTheDocument();
    expect(screen.getByText('Rent Payment')).toBeInTheDocument();
  });

  it('renders "view all transactions" link', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [], total: 0, page: 1, limit: 5, totalPages: 0 },
      isLoading: false, isError: false,
    } as any);
    renderCard();
    expect(screen.getByText('dashboard.viewAllTransactions')).toBeInTheDocument();
  });

  it('renders category icon emoji', () => {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [makeTransaction({ category: { id: 1, name: 'Food', icon: '🍕', type: 'Lifestyle' } as any })],
        total: 1, page: 1, limit: 5, totalPages: 1,
      },
      isLoading: false, isError: false,
    } as any);
    renderCard();
    expect(screen.getByText('🍕')).toBeInTheDocument();
  });
});

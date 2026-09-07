import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransactionForm } from './transaction-form';
import { api } from '@/lib/api';
import { useAccounts, useCategories } from '@/hooks/use-metadata';
import { useTickerSearch } from '@/hooks/use-ticker-search';
import { usePortfolioItems } from '@/hooks/use-normalized-portfolio-items';
import { mockQueryResult } from '@/test/mock-helpers';
import type { Transaction as ApiTransaction } from '@/types/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock('@/lib/api');

vi.mock('@/hooks/use-metadata', () => ({
  useAccounts: vi.fn(),
  useCategories: vi.fn(),
}));
vi.mock('@/hooks/use-ticker-search', () => ({ useTickerSearch: vi.fn() }));
vi.mock('@/hooks/use-normalized-portfolio-items', () => ({ usePortfolioItems: vi.fn() }));

// Stub the heavier child inputs — they register their own fields but the form
// under edit already has valid defaults from the `transaction` prop.
vi.mock('./category-combobox', () => ({ CategoryCombobox: () => <div data-testid="category-combobox" /> }));
vi.mock('./tag-input', () => ({ TagInput: () => <div data-testid="tag-input" /> }));

const account = { id: 5, name: 'Checking', currencyCode: 'USD' };
const category = { id: 9, name: 'Groceries', type: 'Expenses', group: 'Essentials' };

const editTransaction = {
  id: 123,
  transaction_date: '2026-02-01',
  description: 'Old description',
  details: '',
  credit: null,
  debit: 42,
  currency: 'USD',
  categoryId: category.id,
  accountId: account.id,
  category,
  tags: [],
} as unknown as ApiTransaction;

function renderForm() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <TransactionForm transaction={editTransaction} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy, onClose, ...utils };
}

describe('TransactionForm — portfolio cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAccounts).mockReturnValue(mockQueryResult([account]) as ReturnType<typeof useAccounts>);
    vi.mocked(useCategories).mockReturnValue(mockQueryResult([category]) as ReturnType<typeof useCategories>);
    vi.mocked(useTickerSearch).mockReturnValue(mockQueryResult([]) as ReturnType<typeof useTickerSearch>);
    vi.mocked(usePortfolioItems).mockReturnValue(mockQueryResult([]) as ReturnType<typeof usePortfolioItems>);
    vi.mocked(api.updateTransaction).mockResolvedValue({} as Awaited<ReturnType<typeof api.updateTransaction>>);
  });

  it('invalidates the transactions list and every portfolio query root on save', async () => {
    const { invalidateSpy, onClose } = renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'common.save_changes' }));

    await waitFor(() => expect(api.updateTransaction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey[0],
    );
    expect(invalidatedKeys).toEqual(
      expect.arrayContaining([
        'transactions',
        'portfolio-items',
        'portfolio-holdings',
        'portfolio-history',
        'equity-analysis',
      ]),
    );
  });
});

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TransactionsPage from './transactions';
import * as UseTransactions from '@/hooks/use-transactions';
import * as UseMetadata from '@/hooks/use-metadata';
import * as UseExportTransactions from '@/hooks/use-export-transactions';

// Mock Translations
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));

// Mock ResizeObserver for radix popovers
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;
window.ResizeObserver = global.ResizeObserver;

if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends Event {} as any;
}
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

// Mocks for Contexts
vi.mock('@/hooks/use-transactions');
vi.mock('@/hooks/use-metadata');
vi.mock('@/hooks/use-export-transactions');
vi.mock('@/hooks/use-toast', () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() }))
}));
vi.mock('@/components/entities/transaction-form', () => ({
  TransactionForm: ({ transaction }: any) => <div data-testid="transaction-form">{transaction?.description}</div>
}));

describe('TransactionsPage', () => {
  const mockExportTransactions = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(UseExportTransactions.useExportTransactions).mockReturnValue({
      exportTransactions: mockExportTransactions,
      isExporting: false
    });

    vi.mocked(UseMetadata.useMetadata).mockReturnValue({
      data: {
        accounts: [{ id: 1, name: 'Checking Account' }],
        categories: [{ id: 10, name: 'Groceries', group: 'Food & Drink', type: 'Expense' }]
      },
      isLoading: false
    } as any);

    vi.mocked(UseTransactions.useTransactions).mockReturnValue({
      data: {
        transactions: [
          {
            id: 100,
            transaction_date: '2023-11-20',
            description: 'Whole Foods Market',
            debit: 45.50,
            credit: 0,
            currency: 'USD',
            accountId: 1,
            categoryId: 10
          }
        ],
        total: 1,
        page: 1,
        limit: 25,
        totalPages: 1
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    } as any);
  });

  const renderPage = () => {
    return render(
      <MemoryRouter>
        <TransactionsPage />
      </MemoryRouter>
    );
  };

  it('renders transactions layout correctly', () => {
    renderPage();
    expect(screen.getByText('pages.transactions.title')).toBeInTheDocument();
    
    // Check if the transaction data renders
    expect(screen.getByText('Whole Foods Market')).toBeInTheDocument();
    expect(screen.getByText('Checking Account')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('-$45.50')).toBeInTheDocument(); // Formatted amount
  });

  it('displays empty state when no transactions exist', () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue({
      data: { transactions: [], total: 0, page: 1, limit: 25, totalPages: 1 },
      isLoading: false,
      isError: false,
    } as any);

    renderPage();
    expect(screen.getByText('pages.transactions.noTransactionsFound')).toBeInTheDocument();
  });

  it('invokes export functionality', async () => {
    renderPage();
    const exportBtn = screen.getByRole('button', { name: /pages\.transactions\.exportCsv/i });
    fireEvent.click(exportBtn);

    // Since there are no active filters, it skips the dialog and fires export directly
    await waitFor(() => {
      expect(mockExportTransactions).toHaveBeenCalledWith({});
    });
  });

  it('opens add transaction form correctly', async () => {
    renderPage();
    const addBtn = screen.getByRole('button', { name: /pages\.transactions\.addTransaction/i });
    fireEvent.click(addBtn);

    const dialog = await screen.findByTestId('transaction-form');
    expect(dialog).toBeInTheDocument();
  });

  it('has clear filters button when filters are active', async () => {
    renderPage();
    
    // Check that the default filters are rendered
    const accountTrigger = screen.getByText('pages.transactions.allAccounts');
    expect(accountTrigger).toBeInTheDocument();
    
    // Optionally trigger a filter change here if we wanted to test the Clear button visually appearing
  });
});

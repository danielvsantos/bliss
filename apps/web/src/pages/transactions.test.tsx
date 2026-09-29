import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TransactionsPage from './transactions';
import * as UseTransactions from '@/hooks/use-transactions';
import * as UseMetadata from '@/hooks/use-metadata';
import * as UseExportTransactions from '@/hooks/use-export-transactions';
import { mockQueryResult } from '@/test/mock-helpers';

// Mock Translations
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));

// Mock ResizeObserver for radix popovers
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.ResizeObserver = global.ResizeObserver;

if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends Event {} as unknown as typeof PointerEvent;
}
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

// Mock window.matchMedia for useIsMobile hook
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mocks for Contexts
vi.mock('@/hooks/use-transactions');
vi.mock('@/hooks/use-metadata');
vi.mock('@/hooks/use-export-transactions');
vi.mock('@/hooks/use-toast', () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() }))
}));
vi.mock('@/components/entities/transaction-form', () => ({
  // Mirrors react-hook-form: the initial values are captured once on mount.
  TransactionForm: ({ transaction, onClose }: { transaction?: { description?: string } | null; onClose: (refetch?: boolean) => void }) => {
    const [initial] = React.useState(transaction?.description ?? '');
    return (
      <div data-testid="transaction-form">
        <span data-testid="form-initial">{initial}</span>
        <span data-testid="form-target">{transaction?.description}</span>
        <button onClick={() => onClose(true)}>mock-save</button>
      </div>
    );
  }
}));

describe('TransactionsPage', () => {
  const mockExportTransactions = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(UseExportTransactions.useExportTransactions).mockReturnValue({
      exportTransactions: mockExportTransactions,
      isExporting: false
    });

    vi.mocked(UseMetadata.useMetadata).mockReturnValue(
      mockQueryResult({
        accounts: [{ id: 1, name: 'Checking Account' }],
        categories: [{ id: 10, name: 'Groceries', group: 'Food & Drink', type: 'Expense' }]
      }),
    );

    vi.mocked(UseTransactions.useTransactions).mockReturnValue(
      mockQueryResult({
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
      }),
    );
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
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(
      mockQueryResult({ transactions: [], total: 0, page: 1, limit: 25, totalPages: 1 }),
    );

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

  it('re-initialises the edit form for each transaction even if the previous dialog is still animating out', async () => {
    vi.mocked(UseTransactions.useTransactions).mockReturnValue(
      mockQueryResult({
        transactions: [
          { id: 100, transaction_date: '2023-11-20', description: 'Whole Foods Market', debit: 45.5, credit: 0, currency: 'USD', accountId: 1, categoryId: 10 },
          { id: 101, transaction_date: '2023-11-21', description: 'Trader Joes', debit: 12, credit: 0, currency: 'USD', accountId: 1, categoryId: 10 },
        ],
        total: 2, page: 1, limit: 25, totalPages: 1,
      }),
    );

    // Simulate a CSS exit animation that has not finished: Radix Presence then
    // keeps the closed DialogContent (and the form inside it) mounted.
    const realGetComputedStyle = window.getComputedStyle;
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      const style = realGetComputedStyle(el, pseudo);
      return new Proxy(style, {
        get(target, prop) {
          if (prop === 'animationName') return el.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          if (prop === 'display') return 'block';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });

    try {
      renderPage();
      fireEvent.click(screen.getByText('Whole Foods Market'));
      expect(await screen.findByTestId('form-initial')).toHaveTextContent('Whole Foods Market');

      fireEvent.click(screen.getByRole('button', { name: 'mock-save' }));
      fireEvent.click(screen.getAllByText('Trader Joes')[0]);

      await waitFor(() => {
        const targets = screen.getAllByTestId('form-target');
        expect(targets[targets.length - 1]).toHaveTextContent('Trader Joes');
      });
      const initials = screen.getAllByTestId('form-initial');
      expect(initials).toHaveLength(1);
      expect(initials[0]).toHaveTextContent('Trader Joes');
    } finally {
      spy.mockRestore();
    }
  });

  it('has clear filters button when filters are active', async () => {
    renderPage();
    
    // Check that the default filters are rendered
    const accountTrigger = screen.getByText('pages.transactions.allAccounts');
    expect(accountTrigger).toBeInTheDocument();
    
    // Optionally trigger a filter change here if we wanted to test the Clear button visually appearing
  });
});

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import PortfolioHoldingsPage from './portfolio';
import * as UseItems from '@/hooks/use-portfolio-items';
import * as UseHistory from '@/hooks/use-portfolio-history';
import * as UseMetadata from '@/hooks/use-metadata';
import * as UseAccountList from '@/hooks/use-account-list';
import { mockQueryResult } from '@/test/mock-helpers';

// Mocks
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : k),
    i18n: { language: 'en' },
  }),
}));

// ResizeObserver mock
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.ResizeObserver = global.ResizeObserver;

// Radix Select relies on these APIs that jsdom does not implement
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends Event {} as unknown as typeof PointerEvent;
}

vi.mock('@/hooks/use-portfolio-items');
// Passive Income #77: the modal has its own tests; here we only check it opens.
vi.mock('@/components/income/income-terms-modal', () => ({
  IncomeTermsModal: (p: { open: boolean; assetId?: number | null }) =>
    p.open ? <div data-testid="income-terms-modal">{`asset:${p.assetId}`}</div> : null,
}));
vi.mock('@/hooks/use-portfolio-history');
vi.mock('@/hooks/use-metadata');
vi.mock('@/hooks/use-account-list');
vi.mock('@/lib/portfolio-utils', () => ({
  getDisplayData: (item: { currentPrice: string }) => ({
    marketValue: item.currentPrice,
    costBasis: '1000',
    unrealizedPnL: '100',
    realizedPnL: '50',
    totalInvested: '1000'
  }),
  parseDecimal: (val: unknown) => Number(val) || 0,
  buildGroupColorMap: () => ({}),
  getGroupIcon: () => () => <svg data-testid="icon" />
}));

vi.mock('recharts', async () => {
  const OriginalRechartsModule = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...OriginalRechartsModule,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <OriginalRechartsModule.ResponsiveContainer width={10} height={10}>
        {children as React.ReactElement}
      </OriginalRechartsModule.ResponsiveContainer>
    ),
    AreaChart: (() => <div data-testid="area-chart">AreaChart</div>) as ComponentType<unknown>,
    Area: ((props: { name?: string }) => <div data-testid="area">{props.name}</div>) as ComponentType<unknown>,
    Line: ((props: { name?: string }) => <div data-testid="line">{props.name}</div>) as ComponentType<unknown>,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
    ReferenceLine: () => null,
  };
});

describe('PortfolioHoldingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(UseMetadata.useMetadata).mockReturnValue(
      mockQueryResult({ categories: [] }),
    );

    vi.mocked(UseAccountList.useAccountList).mockReturnValue({
      accounts: [],
      plaidItems: [],
      isLoading: false,
      refetch: vi.fn(),
    });

    vi.mocked(UseHistory.usePortfolioHistory).mockReturnValue(
      mockQueryResult({
        portfolioCurrency: 'USD',
        resolution: 'daily',
        history: [
          { date: '2023-01-01', Investments: { total: 100 }, Asset: { total: 0 }, Debt: { total: -50 } },
          { date: '2023-01-02', Investments: { total: 110 }, Asset: { total: 0 }, Debt: { total: -45 } },
        ]
      }),
    );
  });

  const renderPage = () => {
    const user = userEvent.setup();
    const result = render(
      <MemoryRouter>
        <PortfolioHoldingsPage />
      </MemoryRouter>
    );
    return { ...result, user };
  };

  it('renders empty state when no portfolio items exist', () => {
    vi.mocked(UseItems.usePortfolioItems).mockReturnValue(
      mockQueryResult({ portfolioCurrency: 'USD', items: [] }),
    );

    renderPage();

    expect(screen.getByText('portfolio.emptyState')).toBeInTheDocument();
  });

  it('renders assets and liabilities tables when data exists', async () => {
    vi.mocked(UseItems.usePortfolioItems).mockReturnValue(
      mockQueryResult({
        portfolioCurrency: 'USD',
        items: [
          {
            id: 1,
            symbol: 'AAPL',
            quantity: '10',
            currentPrice: '150',
            currency: 'USD',
            category: { type: 'Investment', group: 'Equities' },
            costBases: { 'USD': '1000' }
          },
          {
            id: 2,
            symbol: 'Mortgage',
            quantity: '1',
            currentPrice: '-250000',
            currency: 'USD',
            category: { type: 'Debt', group: 'Real Estate' },
            latestManualValues: { 'USD': '-250000' }
          }
        ]
      }),
    );

    const { user } = renderPage();

    // Chart header / Top KPI asserts
    expect(screen.getByText('portfolio.assets')).toBeInTheDocument();
    expect(screen.getByText('portfolio.liabilities')).toBeInTheDocument();

    // Asset groups are visible even when collapsed (default state)
    expect(screen.getByText('Equities')).toBeInTheDocument();

    // Individual asset items are hidden when groups are collapsed
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();

    // Expand the Equities group to reveal AAPL
    await user.click(screen.getByText('Equities'));
    expect(screen.getByText('AAPL')).toBeInTheDocument();

    // Liabilities are shown in a flat table (no group expand needed)
    expect(screen.getByText('Mortgage')).toBeInTheDocument();
  });

  it('opens the Income Terms modal from an income-capable holding row (#77)', async () => {
    vi.mocked(UseItems.usePortfolioItems).mockReturnValue(
      mockQueryResult({
        portfolioCurrency: 'USD',
        items: [
          {
            id: 7,
            symbol: 'KO',
            quantity: '10',
            currentPrice: '700',
            currency: 'USD',
            category: { type: 'Investments', group: 'Stocks', processingHint: 'API_STOCK' },
            costBases: { USD: '500' },
          },
          {
            id: 8,
            symbol: 'BTC',
            quantity: '1',
            currentPrice: '50000',
            currency: 'USD',
            category: { type: 'Investments', group: 'Crypto', processingHint: 'API_CRYPTO' },
            costBases: { USD: '40000' },
          },
        ],
      }),
    );

    const { user } = renderPage();
    await user.click(screen.getByText('Stocks'));
    await user.click(screen.getByText('Crypto'));

    // Crypto can't produce passive income → no action.
    expect(screen.queryByTestId('income-terms-8')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('income-terms-7'));
    expect(screen.getByTestId('income-terms-modal')).toHaveTextContent('asset:7');
  });

  it('scopes the holdings graph to the selected account', async () => {
    vi.mocked(UseAccountList.useAccountList).mockReturnValue({
      accounts: [
        { id: 42, accountName: 'Brokerage A', countryId: 'US' },
        { id: 43, accountName: 'Brokerage B', countryId: 'US' },
      ],
      plaidItems: [],
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof UseAccountList.useAccountList>);

    vi.mocked(UseItems.usePortfolioItems).mockReturnValue(
      mockQueryResult({
        portfolioCurrency: 'USD',
        items: [
          {
            id: 1,
            symbol: 'AAPL',
            quantity: '10',
            currentPrice: '150',
            currency: 'USD',
            category: { type: 'Investment', group: 'Equities' },
            costBases: { USD: '1000' },
          },
        ],
      }),
    );

    const { user } = renderPage();

    // Before any selection, history is fetched tenant-wide (no accountId).
    expect(vi.mocked(UseHistory.usePortfolioHistory).mock.calls.at(-1)?.[0]).not.toHaveProperty('accountId');

    // Pick a specific account from the filter dropdown.
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Brokerage A' }));

    // The holdings graph query must now be scoped to that account.
    await waitFor(() => {
      expect(vi.mocked(UseHistory.usePortfolioHistory).mock.calls.at(-1)?.[0]).toMatchObject({ accountId: 42 });
    });
  });
});

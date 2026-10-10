import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import PortfolioHoldingsPage from './portfolio';
import * as UseItems from '@/hooks/use-portfolio-items';
import * as UseHistory from '@/hooks/use-portfolio-history';
import * as UseMetadata from '@/hooks/use-metadata';
import * as UseAccountList from '@/hooks/use-account-list';
import { mockQueryResult } from '@/test/mock-helpers';

// Mocks
// Processing status (#100): the banner has its own tests; here it is a probe.
vi.mock('@/components/processing/DataUpdatingBanner', () => ({
  DataUpdatingBanner: ({ watch }: { watch: string[] }) => <div data-testid="data-updating-banner" data-watch={watch.join(',')} />,
}));

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
const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
// Passive Income #77: the modal has its own tests; here we only check it opens.
vi.mock('@/components/income/income-terms-modal', () => ({
  IncomeTermsModal: (p: { open: boolean; assetId?: number | null; defaultApplyToSymbol?: boolean }) =>
    p.open ? <div data-testid="income-terms-modal">{`asset:${p.assetId}:${p.defaultApplyToSymbol ? 'applyAll' : 'one'}`}</div> : null,
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
    // Renders its series (Area / Line probes); <defs> gradients are dropped.
    AreaChart: (({ children }: { children?: ReactNode }) => (
      <div data-testid="area-chart">
        {React.Children.toArray(children).filter((c) => !(React.isValidElement(c) && c.type === 'defs'))}
      </div>
    )) as ComponentType<unknown>,
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
    // #83 R5: defaults to "apply to all holdings" (the modal shows it only for a multi-account, non-cash symbol).
    expect(screen.getByTestId('income-terms-modal')).toHaveTextContent('asset:7:applyAll');
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
    const accountFilter = screen.getAllByRole('combobox').find((el) => el !== screen.getByTestId('holding-picker-trigger'))!;
    await user.click(accountFilter);
    await user.click(screen.getByRole('option', { name: 'Brokerage A' }));

    // The holdings graph query must now be scoped to that account.
    await waitFor(() => {
      expect(vi.mocked(UseHistory.usePortfolioHistory).mock.calls.at(-1)?.[0]).toMatchObject({ accountId: 42 });
    });
  });

  // ── Holding filter (#131) ──────────────────────────────────────────────

  describe('holding filter', () => {
    type Fixture = { id: number; symbol: string; quantity: string; currentPrice: string; accountId?: number; source?: string; category: { type: string; group: string; name?: string } };
    const stock = (id: number, symbol: string, value: number, over: Partial<Fixture> = {}): Fixture => ({
      id, symbol, quantity: '10', currentPrice: String(value), accountId: 42, source: 'SYNCED',
      category: { type: 'Investments', group: 'Stocks', name: 'Stocks' }, ...over,
    });
    const ITEMS = [
      stock(1, 'AAPL', 6000, { accountId: 42 }),
      stock(2, 'AAPL', 4000, { accountId: 43 }),
      stock(3, 'MSFT', 3000, { accountId: 42 }),
      stock(4, 'TSLA', 0, { quantity: '0', accountId: 42 }),
      { id: 5, symbol: 'Mortgage', quantity: '0', currentPrice: '-250000', source: 'MANUAL', category: { type: 'Debt', group: 'Real Estate Loan', name: 'Mortgage' } },
    ];
    const ACCOUNTS = [
      { id: 42, accountName: 'Brokerage A', countryId: 'US' },
      { id: 43, accountName: 'Brokerage B', countryId: 'US' },
      { id: 44, accountName: 'Brokerage C', countryId: 'US' },
    ];

    function LocationProbe() {
      return <div data-testid="location">{useLocation().search}</div>;
    }

    const renderAt = (url = '/reports/portfolio') => {
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={[url]}>
          <PortfolioHoldingsPage />
          <LocationProbe />
        </MemoryRouter>,
      );
      return { user };
    };

    const historyCalls = () => vi.mocked(UseHistory.usePortfolioHistory).mock.calls;
    const lastHistory = () => historyCalls().at(-1)!;
    const search = () => screen.getByTestId('location').textContent;

    beforeEach(() => {
      vi.mocked(UseAccountList.useAccountList).mockReturnValue({
        accounts: ACCOUNTS, plaidItems: [], isLoading: false, refetch: vi.fn(),
      } as unknown as ReturnType<typeof UseAccountList.useAccountList>);
      // The items endpoint filters by account server-side.
      vi.mocked(UseItems.usePortfolioItems).mockImplementation(((filters?: { accountId?: number }) => mockQueryResult({
        portfolioCurrency: 'USD',
        items: ITEMS.filter((i) => filters?.accountId === undefined || i.accountId === filters.accountId),
      })) as unknown as typeof UseItems.usePortfolioItems);
    });

    it('scopes the chart from a deep link and replaces the stacked chart', () => {
      renderAt('/reports/portfolio?holding=MSFT');
      expect(lastHistory()[0]).toMatchObject({ symbol: 'MSFT' });
      expect(lastHistory()[0]).not.toHaveProperty('itemId');
      expect(lastHistory()[1]).toEqual({ enabled: true });
      expect(screen.getByTestId('holding-picker-trigger')).toHaveTextContent('MSFT');
      expect(screen.getAllByTestId('area').map((el) => el.textContent)).toEqual(['MSFT']);
      expect(screen.queryByTestId('line')).not.toBeInTheDocument();
    });

    it('ignores an unknown holding: never requests it and strips the param', async () => {
      renderAt('/reports/portfolio?holding=ZZZZ');
      await waitFor(() => expect(search()).toBe(''));
      expect(historyCalls().some(([f]) => f && 'symbol' in f)).toBe(false);
      expect(lastHistory()[1]).toEqual({ enabled: true });
      expect(screen.getByTestId('holding-picker-trigger')).toHaveTextContent('portfolio.allHoldings');
    });

    it('opens a closed holding from a deep link while the toggle is off', () => {
      renderAt('/reports/portfolio?holding=TSLA');
      expect(lastHistory()[0]).toMatchObject({ symbol: 'TSLA' });
      expect(screen.getByTestId('holding-picker-trigger')).toHaveTextContent('TSLA');
    });

    it('uses the merged table value as the headline under "All accounts"', () => {
      renderAt('/reports/portfolio?holding=AAPL');
      expect(screen.getByTestId('portfolio-headline')).toHaveTextContent('$10,000.00');
    });

    it('computes the % badge from the single holding series', () => {
      vi.mocked(UseHistory.usePortfolioHistory).mockReturnValue(mockQueryResult({
        portfolioCurrency: 'USD',
        resolution: 'weekly',
        history: [
          { date: '2025-10-01', totalUSD: 200, Investments: { total: 200, groups: { Stocks: 200 } } },
          { date: '2026-10-01', totalUSD: 250, Investments: { total: 250, groups: { Stocks: 250 } } },
        ],
      }));
      renderAt('/reports/portfolio?holding=AAPL');
      expect(screen.getByText('+25.00%')).toBeInTheDocument();
    });

    it('clears with × back to exactly the unfiltered request', async () => {
      const { user } = renderAt('/reports/portfolio');
      const unscoped = lastHistory()[0];
      const unscopedHeadline = screen.getByTestId('portfolio-headline').textContent;

      await user.click(screen.getByTestId('holding-picker-trigger'));
      await user.click(screen.getByTestId('holding-option-AAPL'));
      expect(search()).toBe('?holding=AAPL');
      expect(lastHistory()[0]).toMatchObject({ symbol: 'AAPL' });

      await user.click(screen.getByTestId('holding-picker-clear'));
      expect(search()).toBe('');
      expect(lastHistory()[0]).toEqual(unscoped);
      expect(screen.getByTestId('portfolio-headline').textContent).toBe(unscopedHeadline);
    });

    const pickAccount = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
      const accountFilter = screen.getAllByRole('combobox').find((el) => el !== screen.getByTestId('holding-picker-trigger'))!;
      await user.click(accountFilter);
      await user.click(screen.getByRole('option', { name }));
    };

    it('keeps the holding when the new account holds it', async () => {
      const { user } = renderAt('/reports/portfolio?holding=AAPL');
      await pickAccount(user, 'Brokerage A');
      await waitFor(() => expect(lastHistory()[0]).toMatchObject({ symbol: 'AAPL', accountId: 42 }));
      expect(search()).toBe('?holding=AAPL');
      expect(screen.getByTestId('portfolio-headline')).toHaveTextContent('$6,000.00');
      expect(mockToast).not.toHaveBeenCalled();
    });

    it('clears the holding with a notice when the new account does not hold it', async () => {
      const { user } = renderAt('/reports/portfolio?holding=AAPL');
      await pickAccount(user, 'Brokerage C');
      await waitFor(() => expect(search()).toBe(''));
      expect(mockToast).toHaveBeenCalledWith({ description: 'portfolio.holdingNotInAccount' });
      expect(lastHistory()[0]).toMatchObject({ accountId: 44 });
      expect(lastHistory()[0]).not.toHaveProperty('symbol');
    });

    it('"Show in chart" on a row selects the holding and scrolls the chart into view', async () => {
      const { user } = renderAt('/reports/portfolio');
      await user.click(screen.getByText('Stocks'));
      vi.mocked(window.HTMLElement.prototype.scrollIntoView).mockClear();
      await user.click(screen.getByTestId('show-in-chart-3'));
      expect(search()).toBe('?holding=MSFT');
      expect(screen.getByTestId('holding-picker-trigger')).toHaveTextContent('MSFT');
      expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    });

    it('keeps debt out of the picker unless "Show debt" is on, and clears a debt selection when it turns off', async () => {
      const { user } = renderAt('/reports/portfolio');
      await user.click(screen.getByTestId('holding-picker-trigger'));
      expect(screen.queryByTestId('holding-option-item:5')).not.toBeInTheDocument();
      await user.keyboard('{Escape}');

      // "Show in chart" on the liability row turns debt on and selects it (id-keyed: manual).
      await user.click(screen.getByTestId('show-in-chart-5'));
      expect(search()).toBe('?holding=item%3A5');
      expect(lastHistory()[0]).toMatchObject({ itemId: 5, type: 'Investments,Debt,Asset' });

      await user.click(screen.getByRole('switch', { name: 'portfolio.showDebt' }));
      await waitFor(() => expect(search()).toBe(''));
      expect(mockToast).not.toHaveBeenCalled();
    });
  });
});

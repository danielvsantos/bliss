import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PortfolioHoldingsPage from './portfolio';
import * as UseItems from '@/hooks/use-portfolio-items';
import * as UseHistory from '@/hooks/use-portfolio-history';
import * as UseMetadata from '@/hooks/use-metadata';

// Mocks
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } })
}));

// ResizeObserver mock
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;
window.ResizeObserver = global.ResizeObserver;

vi.mock('@/hooks/use-portfolio-items');
vi.mock('@/hooks/use-portfolio-history');
vi.mock('@/hooks/use-metadata');
vi.mock('@/lib/portfolio-utils', () => ({
  getDisplayData: (item: any) => ({
    marketValue: item.currentPrice,
    costBasis: '1000',
    unrealizedPnL: '100',
    realizedPnL: '50',
    totalInvested: '1000'
  }),
  parseDecimal: (val: any) => Number(val) || 0,
  buildGroupColorMap: () => ({}),
  getGroupIcon: () => () => <svg data-testid="icon" />
}));

vi.mock('recharts', async () => {
  const OriginalRechartsModule = await vi.importActual<any>('recharts');
  return {
    ...OriginalRechartsModule,
    ResponsiveContainer: ({ children }: any) => (
      <OriginalRechartsModule.ResponsiveContainer width={10} height={10}>
        {children}
      </OriginalRechartsModule.ResponsiveContainer>
    ),
    AreaChart: (props: any) => <div data-testid="area-chart">AreaChart</div>,
    Area: (props: any) => <div data-testid="area">{props.name}</div>,
    Line: (props: any) => <div data-testid="line">{props.name}</div>,
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

    vi.mocked(UseMetadata.useMetadata).mockReturnValue({
      data: { categories: [] },
      isLoading: false,
    } as any);

    vi.mocked(UseHistory.usePortfolioHistory).mockReturnValue({
      data: {
        portfolioCurrency: 'USD',
        resolution: 'daily',
        history: [
          { date: '2023-01-01', Investments: { total: 100 }, Asset: { total: 0 }, Debt: { total: -50 } },
          { date: '2023-01-02', Investments: { total: 110 }, Asset: { total: 0 }, Debt: { total: -45 } },
        ]
      },
      isLoading: false,
    } as any);
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
    vi.mocked(UseItems.usePortfolioItems).mockReturnValue({
      data: { portfolioCurrency: 'USD', items: [] },
      isLoading: false,
    } as any);

    renderPage();

    expect(screen.getByText('No portfolio data yet. Connect a bank account or import transactions to get started.')).toBeInTheDocument();
  });

  it('renders assets and liabilities tables when data exists', async () => {
    vi.mocked(UseItems.usePortfolioItems).mockReturnValue({
      data: {
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
      },
      isLoading: false,
    } as any);

    const { user } = renderPage();

    // Chart header / Top KPI asserts
    expect(screen.getByText('Assets')).toBeInTheDocument();
    expect(screen.getByText('Liabilities')).toBeInTheDocument();

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
});

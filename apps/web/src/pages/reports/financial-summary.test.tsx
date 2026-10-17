import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import FinancialSummaryPage from './financial-summary';
import { api } from '@/lib/api';
import * as UseTenantSettings from '@/hooks/use-tenant-settings';
import { mockQueryResult } from '@/test/mock-helpers';
import type { AnalyticsResponse } from '@/types/api';

// Pure-function tests for the statement maths and the display sign live in
// src/lib/financial-summary.test.ts. This file covers the Statement tab wiring
// for the Other Activity rows (#139).

vi.mock('@/components/processing/DataUpdatingBanner', () => ({
  DataUpdatingBanner: () => <div data-testid="data-updating-banner" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : k),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/utils/tenantMetaStorage', () => ({
  getTenantMeta: () => ({
    countries: [{ id: 'US', name: 'United States', emoji: '🇺🇸' }],
    currencies: [{ id: 'USD', name: 'US Dollar', symbol: '$' }],
    transactionYears: [2025],
  }),
}));

vi.mock('@/hooks/use-tenant-settings');

vi.mock('@/lib/api', () => ({
  api: { getAnalytics: vi.fn() },
}));

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.ResizeObserver = global.ResizeObserver;

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends Event {} as unknown as typeof PointerEvent;
}

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

const buildAnalytics = (investments: Record<string, { debit: number; credit: number }>): AnalyticsResponse => ({
  currency: 'USD',
  view: 'year',
  data: {
    '2025': {
      Income: { Salary: { balance: 10000 } },
      Essentials: { Rent: { balance: -4000 } },
      Ventures: { Startup: { balance: -200 } },
      Investments: investments,
      Debt: { Loan: { debit: 500, credit: 2000 } },
    },
  },
});

const renderPage = async () => {
  render(
    <MemoryRouter>
      <FinancialSummaryPage />
    </MemoryRouter>,
  );
  return screen.findByText('financialSummary.netInvested');
};

// The section header row that holds a given label.
const rowOf = (label: string) => screen.getByText(label).closest('tr') as HTMLElement;

describe('FinancialSummaryPage — Other Activity net flows (#139)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(UseTenantSettings.useTenantSettings).mockReturnValue(
      mockQueryResult({ autoPromoteThreshold: 0.9, reviewThreshold: 0.7, portfolioCurrency: 'USD', plaidHistoryDays: 30 }),
    );
  });

  it('labels Investments "Net invested" and shows a purchase as a positive neutral amount (AC1)', async () => {
    vi.mocked(api.getAnalytics).mockResolvedValue(
      buildAnalytics({ Funds: { debit: 1000, credit: 0 }, ETFs: { debit: 0, credit: 300 } }),
    );
    await renderPage();

    expect(screen.queryByText('Investments')).not.toBeInTheDocument();
    const total = within(rowOf('financialSummary.netInvested')).getByText('$700');
    expect(total).toHaveClass('text-primary');
    expect(total).not.toHaveClass('text-destructive');

    await userEvent.click(rowOf('financialSummary.netInvested'));
    const funds = within(rowOf('Funds')).getByText('$1,000');
    expect(funds).toHaveClass('text-primary');
  });

  it('shows a net sale as a negative amount, still neutral (AC2)', async () => {
    vi.mocked(api.getAnalytics).mockResolvedValue(
      buildAnalytics({ Funds: { debit: 100, credit: 0 }, ETFs: { debit: 0, credit: 400 } }),
    );
    await renderPage();

    const total = within(rowOf('financialSummary.netInvested')).getByText('-$300');
    expect(total).toHaveClass('text-primary');
    expect(total).not.toHaveClass('text-destructive');

    await userEvent.click(rowOf('financialSummary.netInvested'));
    const etfs = within(rowOf('ETFs')).getByText('-$400');
    expect(etfs).toHaveClass('text-primary');
  });

  it('labels Debt "Net debt repaid" with payments positive and a disbursement negative (AC3)', async () => {
    vi.mocked(api.getAnalytics).mockResolvedValue(buildAnalytics({ Funds: { debit: 1000, credit: 0 } }));
    await renderPage();

    const total = within(rowOf('financialSummary.netDebtRepaid')).getByText('-$1,500');
    expect(total).toHaveClass('text-primary');
  });

  it('drops % of income on every row below the separator, keeps it above (AC4)', async () => {
    vi.mocked(api.getAnalytics).mockResolvedValue(buildAnalytics({ Funds: { debit: 1000, credit: 0 } }));
    await renderPage();

    expect(within(rowOf('Essentials')).getByText('-40%')).toBeInTheDocument();
    // Ventures keeps its sign and colour but loses the %.
    const ventures = rowOf('Ventures');
    expect(within(ventures).getByText('-$200')).toHaveClass('text-destructive');
    for (const label of ['Ventures', 'financialSummary.netInvested', 'financialSummary.netDebtRepaid']) {
      expect(within(rowOf(label)).queryByText(/%$/), label).not.toBeInTheDocument();
    }

    await userEvent.click(rowOf('financialSummary.netInvested'));
    expect(within(rowOf('Funds')).queryByText(/%$/)).not.toBeInTheDocument();
  });

  it('keeps the calculated rows unchanged (AC5)', async () => {
    vi.mocked(api.getAnalytics).mockResolvedValue(buildAnalytics({ Funds: { debit: 1000, credit: 0 } }));
    await renderPage();

    expect(within(rowOf('Net Savings')).getByText('$6,000')).toHaveClass('text-primary');
  });

  it('explains the sign in a keyboard-reachable tooltip that does not toggle the row (AC6)', async () => {
    vi.mocked(api.getAnalytics).mockResolvedValue(buildAnalytics({ Funds: { debit: 1000, credit: 0 } }));
    await renderPage();

    const info = screen.getByRole('button', { name: 'financialSummary.netInvestedTooltip' });
    expect(screen.getByRole('button', { name: 'financialSummary.netDebtRepaidTooltip' })).toBeInTheDocument();

    act(() => info.focus());
    expect((await screen.findAllByText('financialSummary.netInvestedTooltip')).length).toBeGreaterThan(0);

    await userEvent.click(info);
    expect(screen.queryByText('Funds')).not.toBeInTheDocument();
  });
});

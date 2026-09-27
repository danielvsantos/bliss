import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import PassiveIncomePage from './passive-income';
import * as Hooks from '@/hooks/use-passive-income';
import * as PortfolioHooks from '@/hooks/use-portfolio-items';
import { mockQueryResult, mockQueryError, mockMutationResult } from '@/test/mock-helpers';
import type { PassiveIncomeResponse, IncomeStreamsResponse, PassiveIncomeItem, PassiveIncomeGroup } from '@/types/passive-income';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => {
      if (o?.configured != null) return `${k}:${o.configured}/${o.total}`;
      return o?.count != null ? `${k}:${o.count}` : k;
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/hooks/use-passive-income');
vi.mock('@/hooks/use-portfolio-items');
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
// The modal has its own tests — here we only check which modal is opened.
vi.mock('@/components/income/income-terms-modal', () => ({
  IncomeTermsModal: (p: { open: boolean; mode: string; assetId?: number | null; stream?: { id: number } | null; scope?: string }) =>
    p.open ? <div data-testid="modal">{`${p.mode}:${p.assetId ?? p.stream?.id ?? 'new'}:${p.scope ?? 'single'}`}</div> : null,
}));
// Recharts needs layout; the chart has no logic worth rendering here.
vi.mock('@/components/passive-income/income-chart', () => ({
  PassiveIncomeChart: () => <div data-testid="passive-income-chart" />,
}));

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const zero = { dividend: 0, coupon: 0, rent: 0, interest: 0, other: 0, total: 0 };

function response(over: Partial<PassiveIncomeResponse> = {}): PassiveIncomeResponse {
  return {
    displayCurrency: 'USD',
    asOf: '2026-09-27',
    horizon: 12,
    kpis: {
      next12mIncome: 3000, next12mInvestmentIncome: 1800, next12mOtherIncome: 1200, monthlyAverage: 250,
      yieldOnValue: 0.036, essentialsCoveragePct: 12.5, trailingEssentials: 24000, coverage: { configured: 2, total: 3 },
    },
    actuals: [{ month: '2026-09', total: 100 }],
    projected: [{ month: '2026-10', ...zero, dividend: 50, total: 50 }],
    yearly: [{ year: 1, ...zero, dividend: 600, other: 1200, total: 1800 }],
    items: [
      {
        kind: 'ASSET', portfolioItemId: 1, streamId: null, incomeTermsId: 4, label: 'Tesouro 2025', symbol: 'Tesouro 2025',
        assetClass: 'BOND', incomeType: 'FIXED_COUPON', source: 'MANUAL', rateOrYield: 0.05, amountPerPayment: 250,
        frequency: 'SEMIANNUAL', nextPaymentDate: null, endDate: '2025-06-15', status: 'MATURED_UNREDEEMED', horizonTotal: 0, next12mTotal: 0,
      },
      {
        kind: 'STREAM', portfolioItemId: null, streamId: 12, incomeTermsId: 12, label: 'State pension', symbol: null,
        assetClass: null, incomeType: 'FIXED_AMOUNT', source: 'MANUAL', rateOrYield: null, amountPerPayment: 100,
        frequency: 'MONTHLY', nextPaymentDate: '2026-10-05', endDate: null, status: 'OK', horizonTotal: 1200, next12mTotal: 1200,
      },
    ],
    upcomingPayments: [{ date: '2026-10-05', kind: 'STREAM', refId: 12, label: 'State pension', amount: 100, source: 'other' }],
    maturityLadder: [{ year: 2027, principal: 10000, items: [1] }],
    detached: [],
    missing: [{ portfolioItemId: 3, symbol: 'VFIAX', label: 'VFIAX', assetClass: 'FUND', reason: 'NO_TERMS' }],
    ...over,
  };
}

const streams: IncomeStreamsResponse = {
  streams: [{
    id: 12, assetId: null, categoryId: 3, name: 'State pension', orphanedAt: null, orphanedLabel: null,
    incomeType: 'FIXED_AMOUNT', frequency: 'MONTHLY', currency: 'USD', anchorPaymentDate: null, startDate: '2026-01-05',
    endDate: null, isDistributing: true, amountPerPayment: 100, dividendPerUnit: null, yieldPct: null, issuerType: null,
    faceValuePerUnit: null, couponRate: null, referenceIndex: null, spread: null, assumedIndexRate: null,
    maturityDate: null, monthlyRent: null, leaseEndDate: null, annualIndexationPct: null, apyPct: null,
    categoryName: 'Government Welfare', categoryCode: 'GOVERNMENT_WELFARE',
  }],
  eligibleCategories: [{ id: 3, name: 'Government Welfare', defaultCategoryCode: 'GOVERNMENT_WELFARE' }],
};

const attach = vi.fn().mockResolvedValue({});
const discard = vi.fn().mockResolvedValue(undefined);

function setup(data: PassiveIncomeResponse = response()) {
  vi.mocked(Hooks.usePassiveIncome).mockReturnValue(mockQueryResult(data));
  vi.mocked(Hooks.useIncomeStreams).mockReturnValue(mockQueryResult(streams));
  vi.mocked(Hooks.useAttachIncomeTerms).mockReturnValue(mockMutationResult({ mutateAsync: attach } as never));
  vi.mocked(Hooks.useDiscardIncomeTerms).mockReturnValue(mockMutationResult({ mutateAsync: discard } as never));
  vi.mocked(PortfolioHooks.usePortfolioItems).mockReturnValue(mockQueryResult({
    portfolioCurrency: 'USD',
    items: [
      { id: 40, symbol: 'Tesouro 2035', quantity: 5, category: { name: 'Government Bonds', group: 'Bonds', type: 'Investments', processingHint: 'MANUAL' }, incomeTerms: null },
      { id: 41, symbol: 'BTC', quantity: 1, category: { name: 'Crypto', group: 'Crypto', type: 'Investments', processingHint: 'API_CRYPTO' }, incomeTerms: null },
    ],
  } as never));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('PassiveIncomePage', () => {
  it('renders the five KPI tiles', () => {
    setup();
    render(<PassiveIncomePage />);
    const tiles = within(screen.getByTestId('kpi-tiles'));
    expect(tiles.getByText('passiveIncome.kpi.next12m')).toBeInTheDocument();
    expect(tiles.getByText('passiveIncome.kpi.monthlyAverage')).toBeInTheDocument();
    expect(tiles.getByText('3.60%')).toBeInTheDocument();
    expect(tiles.getByText('12.5%')).toBeInTheDocument();
    expect(tiles.getByText('passiveIncome.kpi.dataCoverageValue:2/3')).toBeInTheDocument();
    expect(screen.getByTestId('passive-income-chart')).toBeInTheDocument();
  });

  it('switches the horizon', () => {
    setup();
    render(<PassiveIncomePage />);
    expect(Hooks.usePassiveIncome).toHaveBeenLastCalledWith(12);
    fireEvent.click(screen.getByRole('button', { name: 'passiveIncome.months:24' }));
    expect(Hooks.usePassiveIncome).toHaveBeenLastCalledWith(24);
  });

  it('shows status and source badges in the breakdown', () => {
    setup();
    render(<PassiveIncomePage />);
    expect(screen.getAllByText('passiveIncome.status.MATURED_UNREDEEMED').length).toBeGreaterThan(0);
    expect(screen.getAllByText('passiveIncome.source.MANUAL').length).toBeGreaterThan(0);
    expect(screen.getByTestId('maturity-ladder')).toHaveTextContent('2027');
    expect(screen.getByTestId('upcoming-payments')).toHaveTextContent('State pension');
  });

  it('missing-data prompt opens the asset modal', () => {
    setup();
    render(<PassiveIncomePage />);
    fireEvent.click(within(screen.getByTestId('missing-data')).getByRole('button', { name: 'VFIAX' }));
    expect(screen.getByTestId('modal')).toHaveTextContent('asset:3');
  });

  it('caps the missing-data prompt for large portfolios', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      portfolioItemId: 100 + i, symbol: `M${i}`, label: `Missing ${i}`, assetClass: 'FUND' as const, reason: 'NO_TERMS' as const,
    }));
    setup(response({ missing: many }));
    render(<PassiveIncomePage />);
    const prompt = within(screen.getByTestId('missing-data'));
    expect(prompt.queryByRole('button', { name: 'Missing 9' })).not.toBeInTheDocument();
    fireEvent.click(prompt.getByRole('button', { name: 'passiveIncome.missing.showAll:12' }));
    expect(prompt.getByRole('button', { name: 'Missing 11' })).toBeInTheDocument();
  });

  it('streams card: add opens a new stream, edit opens the existing one', () => {
    setup();
    render(<PassiveIncomePage />);
    const card = within(screen.getByTestId('streams-card'));
    fireEvent.click(card.getByRole('button', { name: /passiveIncome.streams.add/ }));
    expect(screen.getByTestId('modal')).toHaveTextContent('stream:new');
  });

  it('breakdown row of a stream opens that stream', () => {
    setup();
    render(<PassiveIncomePage />);
    const cards = within(screen.getByTestId('breakdown-cards'));
    fireEvent.click(cards.getByText('State pension'));
    expect(screen.getByTestId('modal')).toHaveTextContent('stream:12');
  });

  it('hides the detached section when there is nothing detached', () => {
    setup();
    render(<PassiveIncomePage />);
    expect(screen.queryByTestId('detached-terms')).not.toBeInTheDocument();
  });

  it('detached terms: discard asks for confirmation; re-attach offers only eligible assets', async () => {
    setup(response({
      detached: [{
        id: 77, orphanedLabel: 'Government Bonds - Tesouro IPCA 2053', orphanedAt: '2026-09-20T00:00:00.000Z',
        incomeType: 'FIXED_COUPON', frequency: 'SEMIANNUAL', currency: 'BRL', maturityDate: null, couponRate: 6,
        monthlyRent: null, dividendPerUnit: null, apyPct: null,
      }],
    }));
    render(<PassiveIncomePage />);
    const section = within(screen.getByTestId('detached-terms'));
    expect(section.getByText('Government Bonds - Tesouro IPCA 2053')).toBeInTheDocument();

    fireEvent.click(section.getByRole('button', { name: /passiveIncome.detached.discard/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'passiveIncome.detached.discard' }));
    await waitFor(() => expect(discard).toHaveBeenCalledWith(77));

    fireEvent.click(section.getByRole('button', { name: /passiveIncome.detached.reattach/ }));
    expect(PortfolioHooks.usePortfolioItems).toHaveBeenLastCalledWith({ enabled: true });
    expect(section.getByRole('button', { name: 'passiveIncome.detached.confirmAttach' })).toBeDisabled();
  });

  it('shows an error state', () => {
    vi.mocked(Hooks.usePassiveIncome).mockReturnValue(mockQueryError());
    vi.mocked(Hooks.useIncomeStreams).mockReturnValue(mockQueryResult(streams));
    render(<PassiveIncomePage />);
    expect(screen.getByText('passiveIncome.loadFailed')).toBeInTheDocument();
  });
});

// ─── Grouped view (#83) ─────────────────────────────────────────────────────

const holding = (id: number, account: string, over: Partial<PassiveIncomeItem> = {}): PassiveIncomeItem => ({
  kind: 'ASSET', portfolioItemId: id, streamId: null, incomeTermsId: id, label: `GOOG · ${account}`, symbol: 'GOOG',
  assetClass: 'STOCK', accountName: account, incomeType: 'DIVIDEND', source: 'AUTO', rateOrYield: 0.005, amountPerPayment: null,
  frequency: 'QUARTERLY', nextPaymentDate: '2026-12-15', endDate: null, status: 'OK', horizonTotal: 20, next12mTotal: 20,
  ...over,
});

function groupedResponse(): PassiveIncomeResponse {
  const children = [holding(11, 'IBKR'), holding(42, 'XP')];
  const goog: PassiveIncomeGroup = {
    groupKey: 'GOOG', kind: 'SECURITY', label: 'Alphabet Inc.', symbol: 'GOOG', assetClass: 'STOCK', accountCount: 2,
    portfolioItemIds: [11, 42], quantity: 35, currentValue: 6120, currency: 'USD', incomeType: 'DIVIDEND', source: 'AUTO',
    frequency: 'QUARTERLY', rateOrYield: 0.0065, rateRange: null, amountPerPayment: null, nextPaymentDate: '2026-12-15',
    endDate: null, status: 'OK', statusCount: 0, configured: true, inCoverage: true, horizonTotal: 40, next12mTotal: 40, children,
  };
  const base = response();
  return {
    ...base,
    kpis: { ...base.kpis, coverage: { configured: 1, total: 2 }, coverageByHolding: { configured: 2, total: 4 } },
    items: [...children, base.items[1]],
    groups: [goog],
    upcomingPayments: [
      { date: '2026-12-15', kind: 'ASSET', refId: 11, label: 'GOOG · IBKR', amount: 10, source: 'dividend' },
      { date: '2026-12-15', kind: 'ASSET', refId: 42, label: 'GOOG · XP', amount: 10, source: 'dividend' },
    ],
    upcomingPaymentsGrouped: [
      { date: '2026-12-15', kind: 'ASSET', groupKey: 'GOOG', refId: null, refIds: [11, 42], label: 'Alphabet Inc.', amount: 20, source: 'dividend', accounts: ['IBKR', 'XP'] },
    ],
    missing: [
      { portfolioItemId: 5, symbol: 'VTI', label: 'VTI · IBKR', assetClass: 'ETF', reason: 'NO_TERMS' },
      { portfolioItemId: 9, symbol: 'VTI', label: 'VTI · XP', assetClass: 'ETF', reason: 'NO_TERMS' },
    ],
    missingGroups: [{ groupKey: 'VTI', symbol: 'VTI', label: 'Vanguard Total', assetClass: 'ETF', portfolioItemIds: [5, 9], reason: 'NO_TERMS' }],
  };
}

describe('PassiveIncomePage — grouped view (#83)', () => {
  it('is grouped by default: merged upcoming payments and one missing-data button per symbol', () => {
    setup(groupedResponse());
    render(<PassiveIncomePage />);
    const upcoming = screen.getByTestId('upcoming-payments');
    expect(within(upcoming).getAllByRole('listitem')).toHaveLength(1);
    expect(upcoming).toHaveTextContent('Alphabet Inc.');
    expect(upcoming).toHaveTextContent('passiveIncome.breakdown.accounts:2');
    expect(within(upcoming).getByRole('listitem')).toHaveAttribute('title', 'IBKR, XP');

    const prompt = within(screen.getByTestId('missing-data'));
    expect(prompt.getByText('passiveIncome.missing.title:1')).toBeInTheDocument();
    fireEvent.click(prompt.getByRole('button', { name: 'Vanguard Total' }));
    expect(screen.getByTestId('modal')).toHaveTextContent('asset:5:symbol');
  });

  it('the group row edit opens the modal in symbol scope; a child row edits one account', () => {
    setup(groupedResponse());
    render(<PassiveIncomePage />);
    const row = screen.getByTestId('group-row-GOOG');
    fireEvent.click(within(row).getByRole('button', { name: 'passiveIncome.breakdown.editGroup' }));
    expect(screen.getByTestId('modal')).toHaveTextContent('asset:11:symbol');
  });

  it('a child row edits only that account', () => {
    setup(groupedResponse());
    render(<PassiveIncomePage />);
    fireEvent.click(screen.getByTestId('group-row-GOOG'));
    fireEvent.click(within(screen.getByTestId('child-row-42')).getByRole('button', { name: 'common.edit' }));
    expect(screen.getByTestId('modal')).toHaveTextContent('asset:42:single');
  });

  it('the data coverage tile counts groups', () => {
    setup(groupedResponse());
    render(<PassiveIncomePage />);
    // kpis.coverage (1 of 2 groups), not coverageByHolding (2 of 4 holdings).
    expect(within(screen.getByTestId('kpi-tiles')).getByText('passiveIncome.kpi.dataCoverageValue:1/2')).toBeInTheDocument();
  });

  it('"By account" shows the flat lists and is remembered after a reload', () => {
    setup(groupedResponse());
    const { unmount } = render(<PassiveIncomePage />);
    fireEvent.click(screen.getByRole('button', { name: 'passiveIncome.breakdown.view.flat' }));
    expect(window.localStorage.getItem('bliss.passiveIncome.breakdownView')).toBe('flat');
    expect(within(screen.getByTestId('upcoming-payments')).getAllByRole('listitem')).toHaveLength(2);
    expect(within(screen.getByTestId('missing-data')).getByRole('button', { name: 'VTI · XP' })).toBeInTheDocument();
    unmount();

    render(<PassiveIncomePage />);
    expect(screen.getByRole('button', { name: 'passiveIncome.breakdown.view.flat' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('group-row-GOOG')).not.toBeInTheDocument();
  });

  it('still works when browser storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    setup(groupedResponse());
    render(<PassiveIncomePage />);
    expect(screen.getByTestId('group-row-GOOG')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'passiveIncome.breakdown.view.flat' }));
    expect(screen.queryByTestId('group-row-GOOG')).not.toBeInTheDocument();
  });

  it('falls back to the flat view against an older API (no groups)', () => {
    window.localStorage.setItem('bliss.passiveIncome.breakdownView', 'grouped');
    setup();
    render(<PassiveIncomePage />);
    expect(screen.queryByTestId('breakdown-view-toggle')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('missing-data')).getByRole('button', { name: 'VFIAX' })).toBeInTheDocument();
  });
});

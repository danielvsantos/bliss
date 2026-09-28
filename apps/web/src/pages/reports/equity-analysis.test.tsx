import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import EquityAnalysisPage from './equity-analysis';
import * as Hooks from '@/hooks/use-equity-analysis';
import * as MobileHook from '@/hooks/use-mobile';
import { mockQueryResult, mockQueryError, mockMutationResult } from '@/test/mock-helpers';
import type { EquityAnalysisResponse, EquityHolding } from '@/types/equity-analysis';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${Object.values(o).join(',')}` : k),
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/hooks/use-equity-analysis');
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: vi.fn(() => false) }));
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.matchMedia = window.matchMedia || ((q: string) => ({
  matches: false, media: q, onchange: null,
  addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia;

const holding = (over: Partial<EquityHolding>): EquityHolding => ({
  symbol: 'KO', name: 'Coca-Cola', assetType: 'STOCK', assetClass: 'STOCK', assetClassSource: 'AUTO', autoAssetClass: 'STOCK',
  itemIds: [1], composition: null, quantity: 10, currentValue: 1500, currentValueUSD: 1500,
  sector: 'Consumer Defensive', industry: 'Beverages', country: 'United States',
  peRatio: 25, dividendYield: 0.03, trailingEps: 2.5, latestEpsActual: null, latestEpsSurprise: null,
  week52High: null, week52Low: null, averageVolume: null, logoUrl: null, weight: 0.5, ...over,
});

const KO = holding({});
const QQQ = holding({
  symbol: 'QQQ', name: 'Invesco QQQ', assetType: 'ETF', assetClass: 'INDEX_ETF', autoAssetClass: 'INDEX_ETF', itemIds: [2, 5],
  composition: { sectors: [{ sector: 'Technology', weight: 0.5915 }], countries: [], assetAllocation: { bonds: 0 } },
  sector: 'Diversified', industry: 'Diversified', country: 'Diversified', peRatio: null, trailingEps: null,
});

function response(over: Partial<EquityAnalysisResponse> = {}): EquityAnalysisResponse {
  return {
    portfolioCurrency: 'USD',
    lookThrough: true,
    lookThroughAvailable: true,
    summary: { totalEquityValue: 3000, holdingsCount: 2, weightedPeRatio: 25, weightedDividendYield: 0.03 },
    groups: [
      { name: 'Consumer Defensive', totalValue: 1500, weight: 0.5, holdingsCount: 1, holdings: [KO] },
      { name: 'Technology', totalValue: 887.25, weight: 0.29575, holdingsCount: 1, holdings: [QQQ] },
      { name: 'Other', totalValue: 612.75, weight: 0.20425, holdingsCount: 1, holdings: [QQQ] },
    ],
    holdings: [KO, QQQ],
    composition: [
      { assetClass: 'GOV_BOND', value: 2000, percent: 40, count: 1 },
      { assetClass: 'STOCK', value: 1500, percent: 30, count: 1 },
      { assetClass: 'INDEX_ETF', value: 1500, percent: 30, count: 1 },
    ],
    fixedIncome: { totalFace: 2000, weightedCouponPct: 6, avgYearsToMaturity: 8.3, governmentPct: 100, corporatePct: 0, count: 1 },
    ...over,
  };
}

const mutate = vi.fn();

function setup(data: EquityAnalysisResponse = response(), initialPath = '/reports/equity-analysis') {
  vi.mocked(Hooks.useEquityAnalysis).mockReturnValue(mockQueryResult(data) as never);
  vi.mocked(Hooks.useSetAssetClass).mockReturnValue(mockMutationResult({ mutate } as never) as never);
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <EquityAnalysisPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(MobileHook.useIsMobile).mockReturnValue(false);
});

describe('EquityAnalysisPage — asset classes & look-through (#79)', () => {
  it('renders the Portfolio composition and Fixed income cards', () => {
    setup();
    const comp = within(screen.getByTestId('composition-card'));
    expect(comp.getAllByText('equityAnalysis.assetClasses.GOV_BOND').length).toBeGreaterThan(0);
    expect(comp.getAllByText('40.0%').length).toBeGreaterThan(0);
    const fi = within(screen.getByTestId('fixed-income-card'));
    expect(fi.getByText('6.00%')).toBeInTheDocument();
    expect(fi.getByText('equityAnalysis.yearsValue:8.3')).toBeInTheDocument();
    expect(fi.getByText('100% / 0%')).toBeInTheDocument();
  });

  it('stacks the composition donut above the table while sharing the row with Fixed income', () => {
    setup();
    expect(screen.getByTestId('composition-layout').className).toContain('lg:flex-col');
  });

  it('keeps the composition side by side when it has the row to itself', () => {
    setup(response({ fixedIncome: null }));
    expect(screen.getByTestId('composition-layout').className).not.toContain('lg:flex-col');
  });

  it('hides the Fixed income card without bonds and shows an empty composition', () => {
    setup(response({ fixedIncome: null, composition: [] }));
    expect(screen.queryByTestId('fixed-income-card')).not.toBeInTheDocument();
    expect(screen.getByText('equityAnalysis.compositionEmpty')).toBeInTheDocument();
  });

  it('lists each holding once even when an ETF is split across groups', () => {
    setup();
    expect(screen.getAllByText('QQQ')).toHaveLength(1);
    expect(screen.getAllByText('equityAnalysis.diversified').length).toBeGreaterThan(0);
  });

  it('switches the group-by to asset class', () => {
    setup();
    expect(Hooks.useEquityAnalysis).toHaveBeenLastCalledWith('sector', { lookThrough: true });
    fireEvent.click(screen.getByRole('button', { name: 'equityAnalysis.assetClass' }));
    expect(Hooks.useEquityAnalysis).toHaveBeenLastCalledWith('assetClass', { lookThrough: true });
  });

  it('hides the look-through switch when no ETF has composition data', () => {
    setup(response({ lookThroughAvailable: false }));
    expect(screen.queryByRole('switch', { name: 'equityAnalysis.lookThrough' })).not.toBeInTheDocument();
  });

  it('toggles look-through off and reads it from the URL', () => {
    setup();
    fireEvent.click(screen.getByRole('switch', { name: 'equityAnalysis.lookThrough' }));
    expect(Hooks.useEquityAnalysis).toHaveBeenLastCalledWith('sector', { lookThrough: false });

    vi.clearAllMocks();
    setup(response(), '/reports/equity-analysis?lookThrough=0');
    expect(Hooks.useEquityAnalysis).toHaveBeenLastCalledWith('sector', { lookThrough: false });
  });

  it('sets an override from the badge popover', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'equityAnalysis.editAssetClass:QQQ' }));
    expect(screen.getByTestId('etf-breakdown')).toHaveTextContent('Technology');
    expect(screen.getByTestId('etf-breakdown')).toHaveTextContent('59.2%');
    const select = screen.getByLabelText('equityAnalysis.assetClass');
    expect(within(select).getByText('equityAnalysis.automatic:equityAnalysis.assetClasses.INDEX_ETF')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'SECTOR_ETF' } });
    fireEvent.click(screen.getByRole('button', { name: 'equityAnalysis.save' }));
    expect(mutate).toHaveBeenCalledWith({ portfolioItemId: 2, assetClass: 'SECTOR_ETF' }, expect.any(Object));

    // Success closes the popover and toasts.
    mutate.mock.calls[0][1].onSuccess();
    expect(toast).toHaveBeenCalledWith({ title: 'equityAnalysis.overrideSaved' });
  });

  it('clears an override with "Automatic"', () => {
    setup(response({ holdings: [holding({ assetClass: 'FUND', assetClassSource: 'OVERRIDE', autoAssetClass: 'STOCK' })] }));
    fireEvent.click(screen.getByRole('button', { name: 'equityAnalysis.editAssetClass:KO' }));
    const select = screen.getByLabelText('equityAnalysis.assetClass') as HTMLSelectElement;
    expect(select.value).toBe('FUND');
    fireEvent.change(select, { target: { value: 'AUTO' } });
    fireEvent.click(screen.getByRole('button', { name: 'equityAnalysis.save' }));
    expect(mutate).toHaveBeenCalledWith({ portfolioItemId: 1, assetClass: null }, expect.any(Object));
    mutate.mock.calls[0][1].onError();
    expect(toast).toHaveBeenCalledWith({ title: 'equityAnalysis.overrideFailed', variant: 'destructive' });
  });

  it('cancels without saving', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'equityAnalysis.editAssetClass:KO' }));
    fireEvent.click(screen.getByRole('button', { name: 'equityAnalysis.cancel' }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it('uses a bottom sheet and a stacked composition list on mobile (375px)', () => {
    vi.mocked(MobileHook.useIsMobile).mockReturnValue(true);
    window.innerWidth = 375;
    setup();
    const list = screen.getByTestId('composition-list');
    expect(list).toMatchSnapshot();
    fireEvent.click(screen.getByRole('button', { name: 'equityAnalysis.editAssetClass:KO' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('equityAnalysis.assetClass')).toBeInTheDocument();
  });

  it('shows the error state', () => {
    vi.mocked(Hooks.useEquityAnalysis).mockReturnValue(mockQueryError() as never);
    vi.mocked(Hooks.useSetAssetClass).mockReturnValue(mockMutationResult() as never);
    render(<MemoryRouter><EquityAnalysisPage /></MemoryRouter>);
    expect(screen.getByText('equityAnalysis.loadFailed')).toBeInTheDocument();
  });
});

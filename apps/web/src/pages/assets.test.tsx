import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import ManageAssetsPage from './assets';
import ManualUpdatesRedirect from './manual-updates-redirect';
import { api } from '@/lib/api';
import { useIsMobile } from '@/hooks/use-mobile';
import type { ManageAssetsResponse, ManagedAsset } from '@/types/manage-assets';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o?.count != null ? `${k}:${o.count}` : k),
    i18n: { language: 'en-US' },
  }),
}));

const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/api');
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: vi.fn(() => false) }));

// jsdom stubs for Radix Select / DropdownMenu / Popover and the vaul drawer
window.matchMedia = window.matchMedia || ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const NOW = new Date();
const daysAgoIso = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function makeAsset(over: Partial<ManagedAsset> = {}): ManagedAsset {
  return {
    id: 1,
    symbol: 'AAPL',
    displayName: 'Apple Inc',
    categoryName: 'Stocks',
    categoryType: 'Investments',
    group: 'Stocks',
    processingHint: 'API_STOCK',
    accountId: 10,
    accountName: 'Broker',
    currency: 'USD',
    quantity: '10',
    currentValue: '1500',
    currentValueInDisplay: 1500,
    lastManualValueDate: null,
    assetClass: 'STOCK',
    assetClassSource: 'AUTO',
    incomeAssetClass: 'STOCK',
    hasLotMismatch: false,
    hasIncomeTerms: false,
    hasDividendOverride: false,
    hasDebtTerms: false,
    isPriceStale: false,
    incomeDataStatus: 'AUTO',
    ...over,
  };
}

const FLAT = makeAsset({
  id: 3,
  symbol: 'Flat Lisbon',
  displayName: 'Flat Lisbon',
  categoryName: 'Real Estate',
  categoryType: 'Asset',
  group: 'Real Estate',
  processingHint: 'MANUAL',
  currency: 'EUR',
  quantity: '1',
  currentValue: '300000',
  currentValueInDisplay: 320000,
  lastManualValueDate: daysAgoIso(45),
  isPriceStale: true,
  assetClass: 'REAL_ESTATE',
  incomeAssetClass: 'REAL_ESTATE',
  incomeDataStatus: 'MISSING',
});

const MORTGAGE = makeAsset({
  id: 4,
  symbol: 'Mortgage',
  displayName: 'Mortgage',
  categoryName: 'Mortgage',
  categoryType: 'Debt',
  group: 'Real Estate Loan',
  processingHint: 'AMORTIZING_LOAN',
  accountName: null,
  currentValue: '-200000',
  currentValueInDisplay: -200000,
  assetClass: 'OTHER',
  incomeAssetClass: null,
  incomeDataStatus: 'NOT_APPLICABLE',
  hasDebtTerms: true,
});

const KO = makeAsset({
  id: 5,
  symbol: 'KO',
  displayName: 'Coca-Cola Co',
  hasLotMismatch: true,
  hasDividendOverride: true,
  hasIncomeTerms: true,
  incomeDataStatus: 'OVERRIDE',
  assetClass: 'FUND',
  assetClassSource: 'OVERRIDE',
});

function page(items: ManagedAsset[], over: Partial<ManageAssetsResponse> = {}): ManageAssetsResponse {
  return {
    portfolioCurrency: 'USD',
    items,
    nextCursor: null,
    totals: { count: items.length },
    detachedTermsCount: 0,
    facets: {
      groups: [{ group: 'Real Estate', count: 1 }, { group: 'Stocks', count: 2 }],
      accounts: [{ id: 10, name: 'Broker' }],
    },
    ...over,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(url = '/assets') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/assets" element={<ManageAssetsPage />} />
          <Route path="/manual-updates" element={<ManualUpdatesRedirect />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

// DebtTermsForm's labels aren't wired to its inputs; find fields by name.
const field = (root: HTMLElement, name: string) => root.querySelector(`input[name="${name}"]`);

const lastListCall = () => vi.mocked(api.getManageAssets).mock.calls.at(-1)![0];

async function openAction(user: ReturnType<typeof userEvent.setup>, assetId: number, action: string) {
  await user.click(await screen.findByTestId(`asset-actions-${assetId}`));
  await user.click(await screen.findByTestId(`action-${action}-${assetId}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useIsMobile).mockReturnValue(false);
  vi.mocked(api.getManageAssets).mockResolvedValue(page([FLAT, MORTGAGE, KO]));
});

describe('ManageAssetsPage — list', () => {
  it('renders every row from the lightweight list and never loads manual-value history', async () => {
    renderPage();
    expect(await screen.findByTestId('asset-row-3')).toBeInTheDocument();
    expect(screen.getByTestId('asset-row-4')).toBeInTheDocument();
    expect(screen.getByTestId('asset-row-5')).toBeInTheDocument();
    expect(screen.getByTestId('assets-count')).toHaveTextContent('manageAssets.count:3');

    expect(api.getManageAssets).toHaveBeenCalledTimes(1);
    expect(lastListCall()).toEqual({ cursor: null, limit: 50 });
    expect(api.getManualAssetValues).not.toHaveBeenCalled();
    expect(api.getPortfolioItems).not.toHaveBeenCalled();
  });

  it('shows status chips per row', async () => {
    renderPage();
    await screen.findByTestId('asset-row-3');
    expect(screen.getByTestId('chip-stale-3')).toHaveTextContent('manualUpdates.dOld:45 · manualUpdates.urgency.stale');
    expect(screen.getByTestId('chip-incomeMissing-3')).toBeInTheDocument();
    expect(screen.getByTestId('chip-dividendOverride-5')).toBeInTheDocument();
    expect(screen.getByTestId('chip-lotMismatch-5')).toBeInTheDocument();
    expect(screen.getByTestId('chip-assetClassOverridden-5')).toBeInTheDocument();
    expect(screen.queryByTestId('status-chips-4')).not.toBeInTheDocument();
  });

  it('flags a manual asset with no price at all', async () => {
    vi.mocked(api.getManageAssets).mockResolvedValue(page([{ ...FLAT, lastManualValueDate: null }]));
    renderPage();
    expect(await screen.findByTestId('chip-stale-3')).toHaveTextContent('manageAssets.chips.noPrice');
  });

  it('loads more pages with the next cursor', async () => {
    vi.mocked(api.getManageAssets)
      .mockResolvedValueOnce(page([FLAT], { nextCursor: 'MQ==', totals: { count: 2 } }))
      .mockResolvedValueOnce(page([KO], { nextCursor: null, totals: { count: 2 }, facets: undefined }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('asset-row-3');
    expect(screen.queryByTestId('asset-row-5')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'manageAssets.loadMore' }));
    expect(await screen.findByTestId('asset-row-5')).toBeInTheDocument();
    expect(screen.getByTestId('asset-row-3')).toBeInTheDocument();
    expect(lastListCall()).toEqual({ cursor: 'MQ==', limit: 50 });
    expect(screen.queryByRole('button', { name: 'manageAssets.loadMore' })).not.toBeInTheDocument();
  });

  it('searches on the server after a debounce', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('asset-row-3');
    await user.type(screen.getByLabelText('manageAssets.searchPlaceholder'), 'coca');
    await waitFor(() => expect(lastListCall()).toMatchObject({ search: 'coca' }));
  });

  it('filters by status chip on the server, and toggles it off', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('asset-row-3');
    const chip = screen.getByTestId('status-filter-stale');
    await user.click(chip);
    await waitFor(() => expect(lastListCall()).toMatchObject({ status: 'stale' }));
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await user.click(chip);
    await waitFor(() => expect(lastListCall()).not.toHaveProperty('status'));
  });

  it('filters by type, account and asset class on the server', async () => {
    renderPage();
    await screen.findByTestId('asset-row-3');

    fireEvent.click(screen.getByRole('combobox', { name: 'manageAssets.filters.type' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Real Estate (1)' }));
    await waitFor(() => expect(lastListCall()).toMatchObject({ type: 'Real Estate' }));

    fireEvent.click(screen.getByRole('combobox', { name: 'manageAssets.filters.account' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Broker' }));
    await waitFor(() => expect(lastListCall()).toMatchObject({ type: 'Real Estate', accountId: 10 }));

    fireEvent.click(screen.getByRole('combobox', { name: 'manageAssets.filters.assetClass' }));
    fireEvent.click(await screen.findByRole('option', { name: 'equityAnalysis.assetClasses.REAL_ESTATE' }));
    await waitFor(() => expect(lastListCall()).toMatchObject({ assetClass: 'REAL_ESTATE' }));
  });

  it('includes closed positions when asked', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('asset-row-3');
    await user.click(screen.getByLabelText('manageAssets.filters.includeClosed'));
    await waitFor(() => expect(lastListCall()).toMatchObject({ includeClosed: true }));
  });

  it('shows an empty state with a clear-filters action', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('asset-row-3');
    vi.mocked(api.getManageAssets).mockResolvedValue(page([]));
    await user.click(screen.getByTestId('status-filter-lotMismatch'));
    expect(await screen.findByText('manageAssets.empty')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'manageAssets.filters.clear' }));
    await waitFor(() => expect(lastListCall()).toEqual({ cursor: null, limit: 50 }));
  });

  it('shows an error when the list fails to load', async () => {
    vi.mocked(api.getManageAssets).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('manageAssets.loadFailed')).toBeInTheDocument();
  });

  it('offers only the actions that apply to each row', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('asset-actions-3'));
    expect(await screen.findByTestId('action-price-3')).toBeInTheDocument();
    expect(screen.getByTestId('action-history-3')).toBeInTheDocument();
    expect(screen.getByTestId('action-income-3')).toBeInTheDocument();
    expect(screen.getByTestId('action-assetClass-3')).toBeInTheDocument();
    expect(screen.queryByTestId('action-debt-3')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByTestId('asset-actions-4'));
    expect(await screen.findByTestId('action-debt-4')).toHaveTextContent('manualUpdates.editTerms');
    expect(screen.queryByTestId('action-price-4')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-income-4')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-assetClass-4')).not.toBeInTheDocument();
  });
});

describe('ManageAssetsPage — modals load their own data', () => {
  it('manual price: records a price exactly as before and updates the URL', async () => {
    vi.mocked(api.createManualAssetValue).mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderPage();
    await openAction(user, 3, 'price');

    const modal = await screen.findByTestId('manual-value-modal');
    expect(screen.getByTestId('location')).toHaveTextContent('/assets?item=3&modal=price');
    expect(within(modal).getByText('manualUpdates.updatePriceDialog — Flat Lisbon')).toBeInTheDocument();
    // Currency defaults to the asset's own currency and is locked.
    expect(within(modal).getByPlaceholderText('manualPriceForm.currencyPlaceholder')).toHaveValue('EUR');

    await user.type(within(modal).getByPlaceholderText('manualPriceForm.pricePlaceholder'), '310000');
    await user.click(within(modal).getByRole('button', { name: 'manualPriceForm.savePrice' }));

    await waitFor(() => expect(api.createManualAssetValue).toHaveBeenCalledTimes(1));
    const [id, payload] = vi.mocked(api.createManualAssetValue).mock.calls[0];
    expect(id).toBe(3);
    expect(payload).toMatchObject({ value: 310000, currency: 'EUR' });
    expect(payload.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(screen.queryByTestId('manual-value-modal')).not.toBeInTheDocument());
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/assets$/);
  });

  it('price history: fetches history only when opened', async () => {
    vi.mocked(api.getManualAssetValues).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('asset-row-3');
    expect(api.getManualAssetValues).not.toHaveBeenCalled();
    await openAction(user, 3, 'history');
    await waitFor(() => expect(api.getManualAssetValues).toHaveBeenCalledWith(3));
    expect(await screen.findByText('manualPriceHistory.emptyTitle')).toBeInTheDocument();
  });

  it('debt terms: loads the existing terms and saves through the same form', async () => {
    vi.mocked(api.getDebtTerms).mockResolvedValue({
      id: 5, assetId: 4, interestRate: 3.5, termInMonths: 360, originationDate: '2020-01-15', initialBalance: 250000,
    });
    vi.mocked(api.createOrUpdateDebtTerms).mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderPage();
    await openAction(user, 4, 'debt');

    const modal = await screen.findByTestId('debt-terms-modal');
    await waitFor(() => expect(field(modal, 'initialBalance')).toHaveValue(250000));
    expect(api.getDebtTerms).toHaveBeenCalledWith(4);
    expect(field(modal, 'interestRate')).toHaveValue(3.5);
    expect(field(modal, 'termInMonths')).toHaveValue(360);

    await user.click(within(modal).getByRole('button', { name: 'debtTermsForm.saveTerms' }));
    await waitFor(() => expect(api.createOrUpdateDebtTerms).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createOrUpdateDebtTerms).mock.calls[0]).toEqual([
      4,
      { initialBalance: 250000, interestRate: 3.5, termInMonths: 360, originationDate: '2020-01-15' },
    ]);
  });

  it('debt terms: an item without terms opens an empty form', async () => {
    vi.mocked(api.getDebtTerms).mockResolvedValue(null);
    renderPage('/assets?item=4&modal=debt');
    const modal = await screen.findByTestId('debt-terms-modal');
    await waitFor(() => expect(field(modal, 'initialBalance')).toHaveValue(null));
    expect(screen.queryByTestId('debt-terms-loading')).not.toBeInTheDocument();
  });

  it('asset class: loads the current class and saves the override for the symbol', async () => {
    vi.mocked(api.getAssetClass).mockResolvedValue({ assetClass: 'FUND', assetClassSource: 'OVERRIDE', autoAssetClass: 'STOCK' });
    vi.mocked(api.setAssetClass).mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderPage();
    await openAction(user, 5, 'assetClass');

    const modal = await screen.findByTestId('asset-class-modal');
    const select = await within(modal).findByLabelText('equityAnalysis.assetClass');
    expect(api.getAssetClass).toHaveBeenCalledWith(5);
    await waitFor(() => expect(select).toHaveValue('FUND'));

    await user.selectOptions(select, 'AUTO');
    await user.click(within(modal).getByRole('button', { name: 'equityAnalysis.save' }));
    await waitFor(() => expect(api.setAssetClass).toHaveBeenCalledWith(5, null, { applyToSymbol: true }));
    await waitFor(() => expect(screen.queryByTestId('asset-class-modal')).not.toBeInTheDocument());
  });

  it('asset class: reports a failed save', async () => {
    vi.mocked(api.getAssetClass).mockResolvedValue({ assetClass: 'STOCK', assetClassSource: 'AUTO', autoAssetClass: 'STOCK' });
    vi.mocked(api.setAssetClass).mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderPage('/assets?item=5&modal=assetClass');
    const modal = await screen.findByTestId('asset-class-modal');
    await waitFor(() => expect(within(modal).getByLabelText('equityAnalysis.assetClass')).toHaveValue('AUTO'));
    await user.selectOptions(within(modal).getByLabelText('equityAnalysis.assetClass'), 'REIT');
    await user.click(within(modal).getByRole('button', { name: 'equityAnalysis.save' }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({ title: 'equityAnalysis.overrideFailed', variant: 'destructive' }));
    expect(api.setAssetClass).toHaveBeenCalledWith(5, 'REIT', { applyToSymbol: true });
  });

  it('income terms: opens #77 modal, which fetches the asset terms', async () => {
    vi.mocked(api.getAssetIncomeTerms).mockResolvedValue({
      asset: {
        id: 3, symbol: 'Flat Lisbon', currency: 'EUR', quantity: 1, categoryName: 'Real Estate',
        assetClass: 'REAL_ESTATE', defaultIncomeType: 'RENT',
      },
      terms: null,
      auto: null,
    });
    const user = userEvent.setup();
    renderPage();
    await openAction(user, 3, 'income');
    expect(await screen.findByTestId('income-terms-modal')).toBeInTheDocument();
    await waitFor(() => expect(api.getAssetIncomeTerms).toHaveBeenCalledWith(3));
  });
});

describe('ManageAssetsPage — deep links and redirect', () => {
  it('opens the modal named in the query string', async () => {
    vi.mocked(api.getDebtTerms).mockResolvedValue(null);
    renderPage('/assets?item=4&modal=debt');
    expect(await screen.findByTestId('debt-terms-modal')).toBeInTheDocument();
    expect(api.getDebtTerms).toHaveBeenCalledWith(4);
  });

  it('fetches a deep-linked item that is not on the loaded page', async () => {
    const other = makeAsset({ id: 99, symbol: 'VWCE' });
    vi.mocked(api.getManageAssets).mockImplementation(async (params) =>
      params?.id === 99 ? page([other], { facets: undefined }) : page([FLAT]));
    vi.mocked(api.getAssetClass).mockResolvedValue({ assetClass: 'INDEX_ETF', assetClassSource: 'AUTO', autoAssetClass: 'INDEX_ETF' });
    renderPage('/assets?item=99&modal=assetClass');
    expect(await screen.findByTestId('asset-class-modal')).toBeInTheDocument();
    expect(api.getManageAssets).toHaveBeenCalledWith({ id: 99, includeClosed: true });
    expect(screen.getByText('equityAnalysis.editAssetClass')).toBeInTheDocument();
  });

  it('ignores an unknown modal name', async () => {
    renderPage('/assets?item=3&modal=bogus');
    await screen.findByTestId('asset-row-3');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('redirects /manual-updates to /assets keeping the query string', async () => {
    vi.mocked(api.getDebtTerms).mockResolvedValue(null);
    renderPage('/manual-updates?item=4&modal=debt');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/assets?item=4&modal=debt'));
    expect(await screen.findByTestId('debt-terms-modal')).toBeInTheDocument();
  });

  it('redirects a bare /manual-updates', async () => {
    renderPage('/manual-updates');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/assets$/));
  });
});

describe('ManageAssetsPage — detached income terms banner', () => {
  const DETACHED = {
    id: 42,
    orphanedLabel: 'Old bond · Broker',
    orphanedAt: '2026-09-01T00:00:00.000Z',
    incomeType: 'FIXED_COUPON',
    frequency: 'ANNUAL',
    currency: 'EUR',
    maturityDate: null,
    couponRate: 3,
    monthlyRent: null,
    dividendPerUnit: null,
    apyPct: null,
  };

  it('is hidden when nothing is detached', async () => {
    renderPage();
    await screen.findByTestId('asset-row-3');
    expect(screen.queryByTestId('detached-terms-banner')).not.toBeInTheDocument();
  });

  it('loads the detached terms on demand and discards one', async () => {
    vi.mocked(api.getManageAssets).mockResolvedValue(page([FLAT], { detachedTermsCount: 1 }));
    vi.mocked(api.getDetachedIncomeTerms).mockResolvedValue({ detached: [DETACHED] } as never);
    vi.mocked(api.discardIncomeTerms).mockResolvedValue(undefined as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('manageAssets.detached.title:1')).toBeInTheDocument();
    expect(api.getDetachedIncomeTerms).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'manageAssets.detached.review' }));
    expect(await screen.findByText('Old bond · Broker')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'passiveIncome.detached.discard' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'passiveIncome.detached.discard' }));
    await waitFor(() => expect(api.discardIncomeTerms).toHaveBeenCalledWith(42));
  });

  it('re-attaches detached terms to a holding', async () => {
    vi.mocked(api.getManageAssets).mockResolvedValue(page([FLAT], { detachedTermsCount: 1 }));
    vi.mocked(api.getDetachedIncomeTerms).mockResolvedValue({ detached: [DETACHED] } as never);
    vi.mocked(api.getPortfolioItems).mockResolvedValue({
      portfolioCurrency: 'USD',
      items: [{
        id: 77, symbol: 'PT-BOND', accountId: 10, account: { id: 10, name: 'Broker' }, hasLotMismatch: false,
        currency: 'EUR', quantity: 5,
        category: { name: 'Government Bonds', group: 'Bonds', type: 'Investments', processingHint: 'MANUAL', defaultCategoryCode: 'GOVERNMENT_BONDS' },
        native: {} as never, usd: {} as never, incomeTerms: null,
      }],
    });
    vi.mocked(api.attachIncomeTerms).mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'manageAssets.detached.review' }));
    await user.click(await screen.findByRole('button', { name: 'passiveIncome.detached.reattach' }));
    await user.click(screen.getByRole('combobox', { name: 'passiveIncome.detached.pickAsset' }));
    await user.click(await screen.findByText('PT-BOND · Broker'));
    await user.click(screen.getByRole('button', { name: 'passiveIncome.detached.confirmAttach' }));
    await waitFor(() => expect(api.attachIncomeTerms).toHaveBeenCalledWith(42, 77));
  });
});

describe('ManageAssetsPage — mobile (375px)', () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    act(() => {
      window.innerWidth = 375;
    });
  });

  it('renders cards with overflow menus instead of a table, and filters in a drawer', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByTestId('asset-card-3')).toBeInTheDocument();
    expect(screen.queryByTestId('assets-table')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('asset-card-4')).getByTestId('asset-actions-4')).toBeInTheDocument();

    // Filters live behind the drawer trigger.
    expect(screen.queryByRole('combobox', { name: 'manageAssets.filters.type' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /common.filter/ }));
    expect(await screen.findByRole('combobox', { name: 'manageAssets.filters.type' })).toBeInTheDocument();
  });

  it('opens modals as full-screen sheets', async () => {
    vi.mocked(api.getDebtTerms).mockResolvedValue(null);
    renderPage('/assets?item=4&modal=debt');
    const modal = await screen.findByTestId('debt-terms-modal');
    expect(modal.className).toContain('max-sm:w-screen');
    expect(modal.className).toContain('max-sm:h-[100dvh]');
  });
});

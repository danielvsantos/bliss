import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { IncomeTermsModal } from './income-terms-modal';
import * as Hooks from '@/hooks/use-passive-income';
import { mockQueryResult, mockMutationResult } from '@/test/mock-helpers';
import type {
  AssetIncomeTermsResponse,
  IncomeStreamsResponse,
  IncomeStream,
  IncomeTerms,
  IncomeTermsSibling,
} from '@/types/passive-income';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
vi.mock('@/hooks/use-passive-income');
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

const saveAsset = vi.fn().mockResolvedValue({});
const deleteAsset = vi.fn().mockResolvedValue(undefined);
const saveStream = vi.fn().mockResolvedValue({});
const deleteStream = vi.fn().mockResolvedValue(undefined);

function assetResponse(over: Partial<AssetIncomeTermsResponse> = {}): AssetIncomeTermsResponse {
  return {
    asset: {
      id: 5, symbol: 'Tesouro 2030', currency: 'BRL', quantity: 10, categoryName: 'Government Bonds',
      assetClass: 'BOND', defaultIncomeType: 'FIXED_COUPON',
    },
    terms: null,
    auto: null,
    ...over,
  };
}

function terms(over: Partial<IncomeTerms> = {}): IncomeTerms {
  return {
    id: 9, assetId: 5, categoryId: null, name: null, orphanedAt: null, orphanedLabel: null,
    incomeType: 'DIVIDEND', frequency: null, currency: 'USD', anchorPaymentDate: null, startDate: null, endDate: null,
    isDistributing: true, amountPerPayment: null, dividendPerUnit: null, yieldPct: null, issuerType: null,
    faceValuePerUnit: null, couponRate: null, referenceIndex: null, spread: null, assumedIndexRate: null,
    maturityDate: null, monthlyRent: null, leaseEndDate: null, annualIndexationPct: null, apyPct: null,
    ...over,
  };
}

function sibling(assetId: number, accountName: string, over: Partial<IncomeTermsSibling> = {}): IncomeTermsSibling {
  return { assetId, accountName, currency: 'USD', quantity: 10, costBasis: null, terms: null, source: 'MISSING', ...over };
}

const streams: IncomeStreamsResponse = {
  streams: [],
  eligibleCategories: [{ id: 3, name: 'Allowance', defaultCategoryCode: 'ALLOWANCE' }],
};

function setup(asset: AssetIncomeTermsResponse | undefined = assetResponse()) {
  vi.mocked(Hooks.useAssetIncomeTerms).mockReturnValue(mockQueryResult(asset as AssetIncomeTermsResponse));
  vi.mocked(Hooks.useIncomeStreams).mockReturnValue(mockQueryResult(streams));
  vi.mocked(Hooks.useSaveAssetIncomeTerms).mockReturnValue(mockMutationResult({ mutateAsync: saveAsset } as never));
  vi.mocked(Hooks.useDeleteAssetIncomeTerms).mockReturnValue(mockMutationResult({ mutateAsync: deleteAsset } as never));
  vi.mocked(Hooks.useSaveIncomeStream).mockReturnValue(mockMutationResult({ mutateAsync: saveStream } as never));
  vi.mocked(Hooks.useDeleteIncomeStream).mockReturnValue(mockMutationResult({ mutateAsync: deleteStream } as never));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IncomeTermsModal — asset mode', () => {
  it('shows validation errors for an empty bond and does not save', async () => {
    setup();
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={5} assetLabel="Tesouro 2030" />);

    expect(screen.getByLabelText('incomeTerms.fields.faceValueTotal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect((await screen.findAllByText('incomeTerms.errors.required')).length).toBeGreaterThanOrEqual(4);
    expect(saveAsset).not.toHaveBeenCalled();
  });

  it('edits existing bond terms, shows the preview and saves the numeric body', async () => {
    setup(assetResponse({
      terms: {
        id: 9, assetId: 5, categoryId: null, name: null, orphanedAt: null, orphanedLabel: null,
        incomeType: 'FIXED_COUPON', frequency: 'SEMIANNUAL', currency: 'BRL', anchorPaymentDate: null,
        startDate: null, endDate: null, isDistributing: true, amountPerPayment: null, dividendPerUnit: null,
        yieldPct: null, issuerType: 'GOVERNMENT', faceValuePerUnit: 1000, couponRate: 5, referenceIndex: null,
        spread: null, assumedIndexRate: null, maturityDate: '2030-06-15T00:00:00.000Z', monthlyRent: null,
        leaseEndDate: null, annualIndexationPct: null, apyPct: null,
      },
    }));
    const onOpenChange = vi.fn();
    render(<IncomeTermsModal open onOpenChange={onOpenChange} mode="asset" assetId={5} />);

    fireEvent.change(screen.getByLabelText('incomeTerms.fields.couponRate'), { target: { value: '6' } });
    expect(screen.getByTestId('income-preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(saveAsset).toHaveBeenCalled());
    expect(saveAsset.mock.calls[0][0]).toEqual({
      assetId: 5,
      body: expect.objectContaining({
        incomeType: 'FIXED_COUPON', couponRate: 6, faceValuePerUnit: 1000, frequency: 'SEMIANNUAL',
        maturityDate: '2030-06-15', issuerType: 'GOVERNMENT',
      }),
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('bond: defaults the TOTAL face value to what was paid and stores it per unit', async () => {
    // A manual holding without a quantity is 1 unit: the user paid 10,000.
    setup(assetResponse({ asset: { ...assetResponse().asset, quantity: 1, costBasis: 10000 } }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={5} />);

    expect(screen.getByLabelText('incomeTerms.fields.faceValueTotal')).toHaveValue(10000);
    expect(screen.getByTestId('face-value-hint')).toHaveTextContent('incomeTerms.faceValueHint');
    fireEvent.change(screen.getByLabelText('incomeTerms.fields.couponRate'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    // frequency + maturity still required
    expect((await screen.findAllByText('incomeTerms.errors.required')).length).toBe(2);
    expect(saveAsset).not.toHaveBeenCalled();
  });

  it('bond: a total face value is split across the units held', async () => {
    setup(assetResponse({
      asset: { ...assetResponse().asset, quantity: 4, costBasis: 3900 },
      terms: {
        id: 9, assetId: 5, categoryId: null, name: null, orphanedAt: null, orphanedLabel: null,
        incomeType: 'FIXED_COUPON', frequency: 'ANNUAL', currency: 'BRL', anchorPaymentDate: null,
        startDate: null, endDate: null, isDistributing: true, amountPerPayment: null, dividendPerUnit: null,
        yieldPct: null, issuerType: null, faceValuePerUnit: 1000, couponRate: 5, referenceIndex: null,
        spread: null, assumedIndexRate: null, maturityDate: '2030-06-15T00:00:00.000Z', monthlyRent: null,
        leaseEndDate: null, annualIndexationPct: null, apyPct: null,
      },
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={5} />);
    const total = screen.getByLabelText('incomeTerms.fields.faceValueTotal');
    expect(total).toHaveValue(4000);
    fireEvent.change(total, { target: { value: '6000' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(saveAsset).toHaveBeenCalled());
    expect(saveAsset.mock.calls[0][0].body.faceValuePerUnit).toBe(1500);
  });

  it('uses the app date picker (popover calendar) with a clear button', async () => {
    setup(assetResponse({
      asset: { ...assetResponse().asset, assetClass: 'REAL_ESTATE', defaultIncomeType: 'RENT' },
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={5} />);
    const trigger = screen.getByLabelText('incomeTerms.fields.leaseEndDate');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveTextContent('incomeTerms.pickDate');
    fireEvent.click(trigger);
    expect(await screen.findByRole('grid')).toBeInTheDocument();
  });

  it('removes existing terms', async () => {
    setup(assetResponse({
      asset: { ...assetResponse().asset, assetClass: 'REAL_ESTATE', defaultIncomeType: 'RENT' },
      terms: {
        id: 9, assetId: 5, categoryId: null, name: null, orphanedAt: null, orphanedLabel: null,
        incomeType: 'RENT', frequency: null, currency: 'BRL', anchorPaymentDate: null, startDate: null, endDate: null,
        isDistributing: true, amountPerPayment: null, dividendPerUnit: null, yieldPct: null, issuerType: null,
        faceValuePerUnit: null, couponRate: null, referenceIndex: null, spread: null, assumedIndexRate: null,
        maturityDate: null, monthlyRent: 1500, leaseEndDate: null, annualIndexationPct: null, apyPct: null,
      },
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={5} />);
    expect(screen.getByLabelText('incomeTerms.fields.monthlyRent')).toHaveValue(1500);
    fireEvent.click(screen.getByRole('button', { name: /incomeTerms.removeTerms/ }));
    await waitFor(() => expect(deleteAsset).toHaveBeenCalledWith(5));
  });

  it('stock: shows automatic dividends; override + apply to all holdings of the symbol', async () => {
    setup(assetResponse({
      asset: { id: 7, symbol: 'KO', currency: 'USD', quantity: 100, categoryName: 'Stocks', assetClass: 'STOCK', defaultIncomeType: 'DIVIDEND' },
      auto: {
        trusted: true, currency: 'USD', frequency: 'QUARTERLY', annualDividend: 2.06, dividendYield: 0.03,
        lastUpdated: null, recentDividends: [{ exDate: '2026-09-15', amount: 0.53 }],
      },
      siblings: [sibling(7, 'IBKR', { source: 'AUTO' }), sibling(8, 'XP', { source: 'AUTO' })],
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={7} />);

    expect(screen.getByTestId('auto-dividends')).toHaveTextContent('incomeTerms.autoSummary');
    // Without an override the per-share field is hidden (automatic data is used).
    expect(screen.queryByLabelText('incomeTerms.fields.dividendPerUnit')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch'));
    fireEvent.change(screen.getByLabelText('incomeTerms.fields.dividendPerUnit'), { target: { value: '2.2' } });
    // Not pre-ticked without defaultApplyToSymbol.
    expect(screen.getByLabelText('incomeTerms.applyToAllHoldings')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('incomeTerms.applyToAllHoldings'));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(saveAsset).toHaveBeenCalled());
    expect(saveAsset.mock.calls[0][0].body).toEqual(expect.objectContaining({
      incomeType: 'DIVIDEND', dividendPerUnit: 2.2, applyToSymbol: true,
    }));
  });

  it("stock: \"doesn't distribute\" saves a non-distributing row", async () => {
    setup(assetResponse({
      asset: { id: 7, symbol: 'VWCE', currency: 'EUR', quantity: 10, categoryName: 'ETFs', assetClass: 'ETF', defaultIncomeType: 'DIVIDEND' },
      auto: null,
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={7} />);
    expect(screen.getByText('incomeTerms.autoUnavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('incomeTerms.notDistributing'));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(saveAsset).toHaveBeenCalled());
    expect(saveAsset.mock.calls[0][0].body).toEqual({ incomeType: 'DIVIDEND', isDistributing: false });
  });

  it('cash: APY field only', () => {
    setup(assetResponse({
      asset: { id: 8, symbol: 'Cash EUR', currency: 'EUR', quantity: 5000, categoryName: 'Operating Cash', assetClass: 'CASH', defaultIncomeType: 'INTEREST' },
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={8} currentValue={5000} />);
    fireEvent.change(screen.getByLabelText('incomeTerms.fields.apyPct'), { target: { value: '3' } });
    expect(screen.getByTestId('income-preview')).toHaveTextContent('incomeTerms.previewAnnual');
  });

  it('non income-capable asset shows a message', () => {
    setup(assetResponse({ asset: { ...assetResponse().asset, assetClass: null, defaultIncomeType: null } }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={5} />);
    expect(screen.getByText('incomeTerms.notIncomeCapable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  });
});

describe('IncomeTermsModal — group editing (#83)', () => {
  const stock = (over: Partial<AssetIncomeTermsResponse> = {}) => assetResponse({
    asset: { id: 7, symbol: 'GOOG', currency: 'USD', quantity: 20, categoryName: 'Stocks', assetClass: 'STOCK', defaultIncomeType: 'DIVIDEND' },
    auto: null,
    ...over,
  });

  it('Portfolio Holdings: a multi-account symbol opens with "apply to all holdings" ticked', async () => {
    setup(stock({ siblings: [sibling(7, 'IBKR'), sibling(8, 'XP')] }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={7} defaultApplyToSymbol />);
    const box = screen.getByLabelText('incomeTerms.applyToAllHoldings');
    expect(box).toBeChecked();
    fireEvent.click(screen.getByLabelText('incomeTerms.notDistributing'));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(saveAsset).toHaveBeenCalled());
    expect(saveAsset.mock.calls[0][0].body).toEqual({ incomeType: 'DIVIDEND', isDistributing: false, applyToSymbol: true });
  });

  it('a single-account symbol, and cash, never show the apply-to-all option', () => {
    setup(stock({ siblings: [sibling(7, 'IBKR')] }));
    const { unmount } = render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={7} defaultApplyToSymbol />);
    expect(screen.queryByLabelText('incomeTerms.applyToAllHoldings')).not.toBeInTheDocument();
    unmount();

    setup(assetResponse({
      asset: { id: 8, symbol: 'Cash EUR', currency: 'EUR', quantity: 5000, categoryName: 'Cash', assetClass: 'CASH', defaultIncomeType: 'INTEREST' },
      siblings: [sibling(8, 'Bank A'), sibling(9, 'Bank B')],
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={8} scope="symbol" defaultApplyToSymbol />);
    expect(screen.queryByLabelText('incomeTerms.applyToAllHoldings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('applies-to-holdings')).not.toBeInTheDocument();
    expect(screen.getByLabelText('incomeTerms.fields.apyPct')).toBeInTheDocument();
  });

  it('symbol scope with matching holdings: goes straight to the form and saves to all', async () => {
    const rent = terms({ incomeType: 'RENT', monthlyRent: 1200 });
    setup(assetResponse({
      asset: { id: 5, symbol: 'Real Estate - Flat', currency: 'EUR', quantity: 1, categoryName: 'Real Estate', assetClass: 'REAL_ESTATE', defaultIncomeType: 'RENT' },
      terms: rent,
      siblings: [
        sibling(5, 'A', { terms: rent, source: 'MANUAL' }),
        sibling(6, 'B', { terms: { ...rent, id: 10, assetId: 6 }, source: 'MANUAL' }),
      ],
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={5} assetLabel="Flat" scope="symbol" />);
    expect(screen.queryByTestId('mixed-step')).not.toBeInTheDocument();
    expect(screen.getByText('incomeTerms.groupTitle')).toBeInTheDocument();
    expect(screen.getByTestId('applies-to-holdings')).toHaveTextContent('incomeTerms.appliesToHoldings');
    expect(screen.getByLabelText('incomeTerms.fields.monthlyRent')).toHaveValue(1200);
    fireEvent.change(screen.getByLabelText('incomeTerms.fields.monthlyRent'), { target: { value: '1300' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(saveAsset).toHaveBeenCalled());
    expect(saveAsset.mock.calls[0][0]).toEqual({
      assetId: 5,
      body: expect.objectContaining({ incomeType: 'RENT', monthlyRent: 1300, applyToSymbol: true }),
    });
  });

  it('Mixed group: shows each account\'s terms first, then "use the same terms for all" pre-fills from one', async () => {
    const override = terms({ assetId: 8, dividendPerUnit: 3, frequency: 'QUARTERLY' });
    setup(stock({
      siblings: [sibling(7, 'IBKR', { source: 'AUTO' }), sibling(8, 'XP', { terms: override, source: 'OVERRIDE' })],
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={7} assetLabel="GOOG" scope="symbol" />);

    const list = screen.getByTestId('mixed-siblings');
    expect(list).toHaveTextContent('IBKR');
    expect(list).toHaveTextContent('passiveIncome.source.AUTO');
    expect(list).toHaveTextContent('passiveIncome.source.OVERRIDE');
    expect(list).toHaveTextContent('$3.00');
    // No save until a choice is made.
    expect(screen.queryByRole('button', { name: 'common.save' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'incomeTerms.mixedUseSame' }));
    expect(screen.queryByTestId('mixed-step')).not.toBeInTheDocument();
    // Pre-filled from XP (the account with terms): override on, $3.
    expect(screen.getByLabelText('incomeTerms.fields.dividendPerUnit')).toHaveValue(3);
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(saveAsset).toHaveBeenCalled());
    expect(saveAsset.mock.calls[0][0].body).toEqual(expect.objectContaining({ dividendPerUnit: 3, applyToSymbol: true }));
  });

  it('Mixed group: "edit one account" switches to that holding only', () => {
    const override = terms({ assetId: 8, dividendPerUnit: 3 });
    setup(stock({
      siblings: [sibling(7, 'IBKR', { source: 'AUTO' }), sibling(8, 'XP', { terms: override, source: 'OVERRIDE' })],
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={7} assetLabel="GOOG" scope="symbol" />);
    fireEvent.click(screen.getByRole('button', { name: 'incomeTerms.mixedEditOne' }));
    expect(vi.mocked(Hooks.useAssetIncomeTerms)).toHaveBeenLastCalledWith(8);
    expect(screen.queryByTestId('mixed-step')).not.toBeInTheDocument();
    expect(screen.getByText('incomeTerms.title')).toBeInTheDocument();
    // Single scope: the apply-to-all option is offered, unticked.
    expect(screen.getByLabelText('incomeTerms.applyToAllHoldings')).not.toBeChecked();
  });

  it('bond in symbol scope: face value per unit, with the combined total as a hint', async () => {
    setup(assetResponse({
      siblings: [sibling(5, 'A', { quantity: 10, costBasis: 10000 }), sibling(6, 'B', { quantity: 30, costBasis: 30000 })],
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={5} scope="symbol" />);
    const perUnit = screen.getByLabelText('incomeTerms.fields.faceValuePerUnit');
    expect(perUnit).toHaveValue(1000); // 40,000 paid ÷ 40 units
    expect(screen.queryByLabelText('incomeTerms.fields.faceValueTotal')).not.toBeInTheDocument();
    expect(screen.getByTestId('face-value-hint')).toHaveTextContent('incomeTerms.faceValuePerUnitGroupHint');
    fireEvent.change(perUnit, { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('incomeTerms.fields.couponRate'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect((await screen.findAllByText('incomeTerms.errors.required')).length).toBe(2); // frequency + maturity
    expect(saveAsset).not.toHaveBeenCalled();
  });

  it('removing terms from a group asks for confirmation, then deletes from every holding', async () => {
    const rent = terms({ incomeType: 'RENT', monthlyRent: 1200 });
    setup(assetResponse({
      asset: { id: 5, symbol: 'Flat', currency: 'EUR', quantity: 1, categoryName: 'Real Estate', assetClass: 'REAL_ESTATE', defaultIncomeType: 'RENT' },
      terms: rent,
      siblings: [sibling(5, 'A', { terms: rent, source: 'MANUAL' }), sibling(6, 'B', { terms: rent, source: 'MANUAL' })],
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={5} scope="symbol" />);
    fireEvent.click(screen.getByRole('button', { name: /incomeTerms.removeTerms/ }));
    expect(deleteAsset).not.toHaveBeenCalled();
    expect(await screen.findByText('incomeTerms.removeFromAllConfirm')).toBeInTheDocument();
    const confirm = screen.getAllByRole('button', { name: 'incomeTerms.removeTerms' }).at(-1) as HTMLElement;
    fireEvent.click(confirm);
    await waitFor(() => expect(deleteAsset).toHaveBeenCalledWith({ assetId: 5, applyToSymbol: true }));
  });

  it('a stock group without an override falls back to automatic data for every holding', async () => {
    const override = terms({ assetId: 7, dividendPerUnit: 3 });
    setup(stock({
      terms: override,
      siblings: [sibling(7, 'IBKR', { terms: override, source: 'OVERRIDE' }), sibling(8, 'XP', { terms: override, source: 'OVERRIDE' })],
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={7} scope="symbol" />);
    fireEvent.click(screen.getByRole('switch')); // turn the override off
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(deleteAsset).toHaveBeenCalledWith({ assetId: 7, applyToSymbol: true }));
    expect(saveAsset).not.toHaveBeenCalled();
  });
});

describe('IncomeTermsModal — stream mode', () => {
  const existing: IncomeStream = {
    id: 12, assetId: null, categoryId: 3, name: 'Family allowance', orphanedAt: null, orphanedLabel: null,
    incomeType: 'FIXED_AMOUNT', frequency: 'MONTHLY', currency: 'EUR', anchorPaymentDate: null,
    startDate: '2026-01-05T00:00:00.000Z', endDate: null, isDistributing: true, amountPerPayment: 200,
    dividendPerUnit: null, yieldPct: null, issuerType: null, faceValuePerUnit: null, couponRate: null,
    referenceIndex: null, spread: null, assumedIndexRate: null, maturityDate: null, monthlyRent: null,
    leaseEndDate: null, annualIndexationPct: 2, apyPct: null, categoryName: 'Allowance',
  };

  it('validates a new stream', async () => {
    setup(undefined);
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="stream" defaultCurrency="EUR" />);
    expect(screen.getByLabelText('incomeTerms.fields.currency')).toHaveValue('EUR');
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect((await screen.findAllByText('incomeTerms.errors.required')).length).toBeGreaterThanOrEqual(3);
    expect(saveStream).not.toHaveBeenCalled();
  });

  it('edits and deletes an existing stream', async () => {
    setup(undefined);
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="stream" stream={existing} />);
    fireEvent.change(screen.getByLabelText('incomeTerms.fields.amountPerPayment'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(saveStream).toHaveBeenCalled());
    expect(saveStream.mock.calls[0][0]).toEqual({
      id: 12,
      body: expect.objectContaining({ incomeType: 'FIXED_AMOUNT', amountPerPayment: 250, categoryId: 3, name: 'Family allowance', annualIndexationPct: 2 }),
    });

    fireEvent.click(screen.getByRole('button', { name: /incomeTerms.deleteStream/ }));
    await waitFor(() => expect(deleteStream).toHaveBeenCalledWith(12));
  });

  it('shows an error toast when saving fails', async () => {
    setup(undefined);
    saveStream.mockRejectedValueOnce(new Error('boom'));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="stream" stream={existing} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
  });
});

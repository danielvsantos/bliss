import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { IncomeTermsModal } from './income-terms-modal';
import * as Hooks from '@/hooks/use-passive-income';
import { mockQueryResult, mockMutationResult } from '@/test/mock-helpers';
import type { AssetIncomeTermsResponse, IncomeStreamsResponse, IncomeStream } from '@/types/passive-income';

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

    expect(screen.getByLabelText('incomeTerms.fields.faceValuePerUnit')).toBeInTheDocument();
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
    }));
    render(<IncomeTermsModal open onOpenChange={vi.fn()} mode="asset" assetId={7} />);

    expect(screen.getByTestId('auto-dividends')).toHaveTextContent('incomeTerms.autoSummary');
    // Without an override the per-share field is hidden (automatic data is used).
    expect(screen.queryByLabelText('incomeTerms.fields.dividendPerUnit')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch'));
    fireEvent.change(screen.getByLabelText('incomeTerms.fields.dividendPerUnit'), { target: { value: '2.2' } });
    fireEvent.click(screen.getByLabelText('incomeTerms.applyToSymbol'));
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

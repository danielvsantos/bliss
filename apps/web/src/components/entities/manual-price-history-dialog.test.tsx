import React from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManualPriceHistoryDialog } from './manual-price-history-dialog';
import { useManualAssetValues } from '@/hooks/use-manual-asset-values';
import { api } from '@/lib/api';
import { mockQueryResult, mockQueryLoading, mockQueryError } from '@/test/mock-helpers';
import type { ManualAssetValue, PortfolioItem } from '@/types/api';
import enLocale from '@/i18n/locales/en';
import esLocale from '@/i18n/locales/es';
import frLocale from '@/i18n/locales/fr';
import ptLocale from '@/i18n/locales/pt';
import itLocale from '@/i18n/locales/it';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock('@/lib/api');

vi.mock('@/hooks/use-manual-asset-values', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-manual-asset-values')>();
  return { ...actual, useManualAssetValues: vi.fn() };
});

const asset = {
  id: 42,
  symbol: 'FLAT-LONDON',
  currency: 'USD',
  quantity: '1',
  category: { name: 'Real Estate', processingHint: 'MANUAL' },
} as unknown as PortfolioItem;

const makeRow = (over: Partial<ManualAssetValue> = {}): ManualAssetValue => ({
  id: 'v1',
  date: '2026-01-31',
  value: 1000,
  currency: 'USD',
  notes: 'Q1 statement',
  createdAt: '2026-02-02T10:00:00.000Z',
  updatedAt: '2026-02-02T10:00:00.000Z',
  ...over,
});

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ManualPriceHistoryDialog asset={asset} open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy, ...utils };
}

describe('ManualPriceHistoryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every history row newest-first with formatted price, currency and notes', () => {
    vi.mocked(useManualAssetValues).mockReturnValue(
      mockQueryResult([
        makeRow({ id: 'a', value: 1000, date: '2026-03-01', notes: 'March' }),
        makeRow({ id: 'b', value: 2000, date: '2026-02-01', notes: 'February' }),
        makeRow({ id: 'c', value: 3000, date: '2026-01-01', notes: '' }),
      ]),
    );

    renderDialog();

    expect(screen.getByText('manualPriceHistory.countLabel')).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument();
    expect(screen.getByText('$2,000.00')).toBeInTheDocument();
    expect(screen.getByText('$3,000.00')).toBeInTheDocument();
    expect(screen.getByText('March')).toBeInTheDocument();
    // empty notes render as an em-dash
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    const rows = screen.getAllByRole('row');
    // header + 3 data rows
    expect(rows).toHaveLength(4);
    expect(within(rows[1]).getByText('$1,000.00')).toBeInTheDocument();
  });

  it('paginates a long history and pages forward/back', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      makeRow({ id: `r${i}`, value: (i + 1) * 100, date: `2026-01-${String(i + 1).padStart(2, '0')}` }),
    );
    vi.mocked(useManualAssetValues).mockReturnValue(mockQueryResult(many));

    renderDialog();

    // 12 rows per page → header + 12
    expect(screen.getAllByRole('row')).toHaveLength(13);
    expect(screen.getByText('manualPriceHistory.pagination')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.queryByText('$1,300.00')).not.toBeInTheDocument();

    const prev = screen.getByRole('button', { name: 'manualPriceHistory.prev' });
    const next = screen.getByRole('button', { name: 'manualPriceHistory.next' });
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();

    fireEvent.click(next);
    expect(screen.getByText('$1,300.00')).toBeInTheDocument();
    expect(screen.queryByText('$100.00')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'manualPriceHistory.prev' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'manualPriceHistory.next' }));
    // page 3 = rows 25..30 → 6 rows, Next now disabled
    expect(screen.getAllByRole('row')).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'manualPriceHistory.next' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'manualPriceHistory.prev' }));
    expect(screen.getByText('$1,300.00')).toBeInTheDocument();
  });

  it('renders a loading skeleton', () => {
    vi.mocked(useManualAssetValues).mockReturnValue(mockQueryLoading());
    renderDialog();
    // Dialog content renders through a portal on document.body
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('shows an inline error with a retry control that calls refetch', () => {
    const refetch = vi.fn();
    vi.mocked(useManualAssetValues).mockReturnValue(mockQueryError(new Error('nope'), { refetch }));

    renderDialog();

    expect(screen.getByText('manualPriceHistory.loadError')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'manualPriceHistory.retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state that opens the create form', () => {
    vi.mocked(useManualAssetValues).mockReturnValue(mockQueryResult<ManualAssetValue[]>([]));

    renderDialog();

    expect(screen.getByText('manualPriceHistory.emptyTitle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /manualPriceHistory\.recordFirst/ }));
    // the shared ManualPriceForm renders its own labels
    expect(screen.getByText('manualPriceForm.price')).toBeInTheDocument();
  });

  it('flags a row whose currency differs from the asset currency', () => {
    vi.mocked(useManualAssetValues).mockReturnValue(
      mockQueryResult([makeRow({ id: 'eur', currency: 'GBP', value: 500 })]),
    );

    renderDialog();

    expect(screen.getByText('GBP')).toBeInTheDocument();
    expect(screen.getByText('£500.00')).toBeInTheDocument();
  });

  it('does not throw on a malformed currency code and falls back to a plain string', () => {
    vi.mocked(useManualAssetValues).mockReturnValue(
      mockQueryResult([makeRow({ id: 'bad', currency: 'ZZ', value: 500 })]),
    );

    expect(() => renderDialog()).not.toThrow();
    expect(screen.getByText('500 ZZ')).toBeInTheDocument();
  });

  it('edits a row and preserves its original currency, invalidating both query keys', async () => {
    vi.mocked(useManualAssetValues).mockReturnValue(
      mockQueryResult([makeRow({ id: 'r1', currency: 'EUR', value: 2000, notes: 'orig' })]),
    );
    vi.mocked(api.updateManualAssetValue).mockResolvedValue(makeRow({ id: 'r1', currency: 'EUR', value: 2500 }));

    const { invalidateSpy } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'manualPriceHistory.edit' }));
    expect(screen.getByText('manualPriceForm.price')).toBeInTheDocument();

    const priceInput = screen.getByRole('spinbutton');
    fireEvent.change(priceInput, { target: { value: '2500' } });
    fireEvent.click(screen.getByRole('button', { name: 'manualPriceForm.savePrice' }));

    await waitFor(() => expect(api.updateManualAssetValue).toHaveBeenCalledTimes(1));
    const [itemIdArg, valueIdArg, payload] = vi.mocked(api.updateManualAssetValue).mock.calls[0];
    expect(itemIdArg).toBe(42);
    expect(valueIdArg).toBe('r1');
    expect(payload).toMatchObject({ value: 2500, currency: 'EUR' });

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
    expect(invalidatedKeys).toContain('manual-asset-values');
    expect(invalidatedKeys).toContain('portfolio-items');
    expect(toastMock).toHaveBeenCalled();
  });

  it('deletes a row after confirmation and invalidates both query keys', async () => {
    vi.mocked(useManualAssetValues).mockReturnValue(
      mockQueryResult([makeRow({ id: 'del-me', value: 1000 })]),
    );
    vi.mocked(api.deleteManualAssetValue).mockResolvedValue(undefined);

    const { invalidateSpy } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'manualPriceHistory.delete' }));

    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText('manualPriceHistory.deleteConfirmTitle')).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'manualPriceHistory.delete' }));

    await waitFor(() => expect(api.deleteManualAssetValue).toHaveBeenCalledWith(42, 'del-me'));

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
    expect(invalidatedKeys).toContain('manual-asset-values');
    expect(invalidatedKeys).toContain('portfolio-items');
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'manualPriceHistory.deleted' }));
  });
});

describe('manualPriceHistory i18n parity', () => {
  const locales = {
    en: enLocale,
    es: esLocale,
    fr: frLocale,
    pt: ptLocale,
    it: itLocale,
  } as unknown as Record<string, Record<string, Record<string, string>>>;
  const reference = Object.keys(locales.en.manualPriceHistory).sort();

  it.each(Object.keys(locales))('locale %s has the exact same manualPriceHistory keys as en', (loc) => {
    const block = locales[loc].manualPriceHistory;
    expect(block, `${loc} is missing the manualPriceHistory block`).toBeDefined();
    expect(Object.keys(block).sort()).toEqual(reference);
  });
});

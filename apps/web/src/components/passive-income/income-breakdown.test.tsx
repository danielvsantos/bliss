import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { IncomeBreakdown, BREAKDOWN_PAGE_SIZE } from './income-breakdown';
import type { PassiveIncomeItem } from '@/types/passive-income';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const item = (i: number, over: Partial<PassiveIncomeItem> = {}): PassiveIncomeItem => ({
  kind: 'ASSET', portfolioItemId: i, streamId: null, incomeTermsId: i, label: `Holding ${i}`, symbol: `SYM${i}`,
  assetClass: 'STOCK', incomeType: 'DIVIDEND', source: 'AUTO', rateOrYield: 0.02, amountPerPayment: null,
  frequency: 'QUARTERLY', nextPaymentDate: '2026-12-01', endDate: null, status: 'OK', horizonTotal: 1000 - i, next12mTotal: 1000 - i,
  ...over,
});

// 120 holdings (a large production tenant) + 1 stream + 2 needing attention.
const items: PassiveIncomeItem[] = [
  ...Array.from({ length: 120 }, (_, i) => item(i + 1)),
  item(500, { kind: 'STREAM', portfolioItemId: null, streamId: 9, label: 'State pension', incomeType: 'FIXED_AMOUNT' }),
  item(501, { label: 'Old bond', incomeType: 'FIXED_COUPON', status: 'MATURED_UNREDEEMED' }),
  item(502, { label: 'Floater', incomeType: 'FLOATING_COUPON', status: 'STALE_RATE' }),
];

function renderIt() {
  const onEditAsset = vi.fn();
  const onEditStream = vi.fn();
  render(<IncomeBreakdown items={items} currency="USD" onEditAsset={onEditAsset} onEditStream={onEditStream} />);
  const cards = () => within(screen.getByTestId('breakdown-cards')).queryAllByRole('listitem');
  return { onEditAsset, onEditStream, cards };
}

describe('IncomeBreakdown — large portfolios', () => {
  it('paginates', () => {
    const { cards } = renderIt();
    expect(cards()).toHaveLength(BREAKDOWN_PAGE_SIZE);
    const pager = within(screen.getByTestId('breakdown-pager'));
    expect(pager.getByText('1 / 7')).toBeInTheDocument();
    fireEvent.click(pager.getByRole('button', { name: 'passiveIncome.breakdown.next' }));
    expect(pager.getByText('2 / 7')).toBeInTheDocument();
    expect(within(screen.getByTestId('breakdown-cards')).getByText('Holding 21')).toBeInTheDocument();
    expect(pager.getByRole('button', { name: 'passiveIncome.breakdown.prev' })).not.toBeDisabled();
  });

  it('searches by label/symbol and resets to page 1', () => {
    const { cards } = renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'passiveIncome.breakdown.next' }));
    fireEvent.change(screen.getByLabelText('passiveIncome.breakdown.search'), { target: { value: 'sym11' } });
    // SYM11, SYM110–SYM119
    expect(cards()).toHaveLength(11);
    expect(screen.queryByTestId('breakdown-pager')).not.toBeInTheDocument();
  });

  it('filters streams and items needing attention', () => {
    const { cards, onEditStream } = renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'passiveIncome.breakdown.filters.streams' }));
    expect(cards()).toHaveLength(1);
    fireEvent.click(within(screen.getByTestId('breakdown-cards')).getByText('State pension'));
    expect(onEditStream).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /passiveIncome.breakdown.filters.attention/ }));
    expect(cards()).toHaveLength(2);
  });

  it('shows an empty-search message', () => {
    renderIt();
    fireEvent.change(screen.getByLabelText('passiveIncome.breakdown.search'), { target: { value: 'zzz' } });
    expect(screen.getByText('passiveIncome.breakdown.noMatches')).toBeInTheDocument();
  });
});

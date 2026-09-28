import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { IncomeBreakdown, BREAKDOWN_PAGE_SIZE } from './income-breakdown';
import type { PassiveIncomeGroup, PassiveIncomeItem } from '@/types/passive-income';

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

// ─── Grouped view (#83) ─────────────────────────────────────────────────────

const child = (id: number, accountName: string, over: Partial<PassiveIncomeItem> = {}) =>
  item(id, { label: `X · ${accountName}`, accountName, horizonTotal: 100, next12mTotal: 100, ...over });

const group = (key: string, children: PassiveIncomeItem[], over: Partial<PassiveIncomeGroup> = {}): PassiveIncomeGroup => ({
  groupKey: key, kind: 'SECURITY', label: key, symbol: key, assetClass: 'STOCK',
  accountCount: children.length, portfolioItemIds: children.map((c) => c.portfolioItemId as number),
  quantity: 10, currentValue: 1000, currency: 'USD', incomeType: 'DIVIDEND', source: 'AUTO', frequency: 'QUARTERLY',
  rateOrYield: 0.02, rateRange: null, amountPerPayment: null, nextPaymentDate: '2026-12-01', endDate: null,
  status: 'OK', statusCount: 0, configured: true, inCoverage: true,
  horizonTotal: children.reduce((s, c) => s + c.horizonTotal, 0), next12mTotal: 0, children,
  ...over,
});

const goog = group('GOOG', [child(1, 'IBKR', { source: 'OVERRIDE', horizonTotal: 600 }), child(2, 'XP', { horizonTotal: 400 })], {
  label: 'Alphabet Inc.', source: 'MIXED', frequency: 'MIXED',
});
const ko = group('KO', [child(3, 'IBKR', { horizonTotal: 300 })]);
const bnd = group('BND', [child(4, 'A'), child(5, 'B', { status: 'MATURED_UNREDEEMED' })], {
  assetClass: 'BOND', incomeType: 'FIXED_COUPON', status: 'MATURED_UNREDEEMED', statusCount: 1,
});
const cashEur = group('Cash EUR', [child(6, 'Bank A', { assetClass: 'CASH', incomeType: 'INTEREST' }), child(7, 'Bank B', { assetClass: 'CASH', incomeType: 'INTEREST' })], {
  kind: 'CASH', assetClass: 'CASH', incomeType: 'INTEREST', rateOrYield: null, rateRange: [0, 0.04], currentValue: 15000, next12mTotal: 240,
});
const stream = item(500, { kind: 'STREAM', portfolioItemId: null, streamId: 9, label: 'State pension', incomeType: 'FIXED_AMOUNT', horizonTotal: 50 });
const groups = [goog, ko, bnd, cashEur];
const flatItems = [...groups.flatMap((g) => g.children), stream];

function renderGrouped(extra: Partial<Parameters<typeof IncomeBreakdown>[0]> = {}) {
  const handlers = { onEditAsset: vi.fn(), onEditStream: vi.fn(), onEditGroup: vi.fn(), onViewChange: vi.fn() };
  render(
    <IncomeBreakdown items={flatItems} groups={groups} view="grouped" currency="USD" {...handlers} {...extra} />,
  );
  const topCards = () => Array.from(screen.getByTestId('breakdown-cards').children);
  return { ...handlers, topCards };
}

describe('IncomeBreakdown — grouped view (#83)', () => {
  it('shows one row per symbol / cash currency plus streams; groups expand to their accounts', () => {
    const { topCards, onEditAsset, onEditGroup } = renderGrouped();
    expect(topCards()).toHaveLength(5);
    const row = screen.getByTestId('group-row-GOOG');
    expect(row).toHaveTextContent('Alphabet Inc.');
    expect(row).toHaveTextContent('passiveIncome.breakdown.accounts');
    expect(row).toHaveTextContent('passiveIncome.source.MIXED');
    expect(row).toHaveTextContent('passiveIncome.frequency.MIXED');
    expect(screen.queryByTestId('child-row-1')).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('child-row-1')).toHaveTextContent('IBKR');
    expect(screen.getByTestId('child-row-2')).toHaveTextContent('XP');

    // A child row edits only that holding; the group row edits every holding.
    fireEvent.click(within(screen.getByTestId('child-row-2')).getByRole('button', { name: 'common.edit' }));
    expect(onEditAsset).toHaveBeenCalledWith(expect.objectContaining({ portfolioItemId: 2 }));
    fireEvent.click(within(row).getByRole('button', { name: 'passiveIncome.breakdown.editGroup' }));
    expect(onEditGroup).toHaveBeenCalledWith(goog);
    expect(row).toHaveAttribute('aria-expanded', 'true'); // the edit click doesn't toggle the row

    fireEvent.click(within(row).getByRole('button', { name: 'passiveIncome.breakdown.hideAccounts' }));
    expect(screen.queryByTestId('child-row-1')).not.toBeInTheDocument();
  });

  it('a single-holding group is a plain row that edits its holding', () => {
    const { onEditAsset, onEditGroup } = renderGrouped();
    const row = screen.getByTestId('group-row-KO');
    expect(row).not.toHaveAttribute('aria-expanded');
    expect(row).toHaveTextContent('IBKR');
    fireEvent.click(within(row).getByRole('button', { name: 'common.edit' }));
    expect(onEditAsset).toHaveBeenCalledWith(ko.children[0]);
    expect(onEditGroup).not.toHaveBeenCalled();
  });

  it('cash groups are read-only with an APY range; each bank row is editable', () => {
    const { onEditAsset } = renderGrouped();
    const row = screen.getByTestId('group-row-Cash EUR');
    expect(row).toHaveTextContent('0.00–4.00%');
    expect(row).toHaveTextContent('passiveIncome.breakdown.cashSummary');
    expect(within(row).queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    fireEvent.click(row);
    fireEvent.click(within(screen.getByTestId('child-row-7')).getByRole('button', { name: 'common.edit' }));
    expect(onEditAsset).toHaveBeenCalledWith(expect.objectContaining({ portfolioItemId: 7 }));
  });

  it('search matches the group name and account names; an account match opens the group', () => {
    const { topCards } = renderGrouped();
    const search = screen.getByLabelText('passiveIncome.breakdown.search');
    fireEvent.change(search, { target: { value: 'alphabet' } });
    expect(topCards()).toHaveLength(1);
    expect(screen.queryByTestId('child-row-1')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'bank b' } });
    expect(topCards()).toHaveLength(1);
    expect(screen.getByTestId('child-row-7')).toBeInTheDocument();
  });

  it('"Needs attention" includes a group where only one account needs it', () => {
    const { topCards } = renderGrouped();
    fireEvent.click(screen.getByRole('button', { name: /passiveIncome.breakdown.filters.attention/ }));
    expect(topCards()).toHaveLength(1);
    expect(screen.getByTestId('group-row-BND')).toHaveTextContent('passiveIncome.status.MATURED_UNREDEEMED · 1');
  });

  it('paginates by groups', () => {
    const many = Array.from({ length: 30 }, (_, i) => group(`G${i}`, [child(100 + i, 'IBKR'), child(200 + i, 'XP')]));
    render(
      <IncomeBreakdown items={many.flatMap((g) => g.children)} groups={many} view="grouped" currency="USD"
        onEditAsset={vi.fn()} onEditStream={vi.fn()} onViewChange={vi.fn()} />,
    );
    expect(screen.getByTestId('breakdown-cards').children).toHaveLength(BREAKDOWN_PAGE_SIZE);
    expect(within(screen.getByTestId('breakdown-pager')).getByText('1 / 2')).toBeInTheDocument();
  });

  it('phone cards show the totals and a "Show N accounts" control', () => {
    renderGrouped();
    const card = screen.getByTestId('group-card-GOOG');
    expect(within(card).queryByText('IBKR')).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'passiveIncome.breakdown.showAccounts' }));
    expect(within(card).getByText('IBKR')).toBeInTheDocument();
    expect(within(card).getByText('XP')).toBeInTheDocument();
  });

  it('the view toggle switches between "By holding" and "By account"', () => {
    const { onViewChange } = renderGrouped();
    const toggle = within(screen.getByTestId('breakdown-view-toggle'));
    expect(toggle.getByRole('button', { name: 'passiveIncome.breakdown.view.grouped' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle.getByRole('button', { name: 'passiveIncome.breakdown.view.flat' }));
    expect(onViewChange).toHaveBeenCalledWith('flat');
  });

  it('the flat view lists every holding; without groups (older API) there is no toggle', () => {
    const { unmount } = render(
      <IncomeBreakdown items={flatItems} groups={groups} view="flat" currency="USD"
        onEditAsset={vi.fn()} onEditStream={vi.fn()} onViewChange={vi.fn()} />,
    );
    expect(screen.getByTestId('breakdown-cards').children).toHaveLength(flatItems.length);
    expect(screen.queryByTestId('group-row-GOOG')).not.toBeInTheDocument();
    unmount();

    render(<IncomeBreakdown items={flatItems} view="grouped" currency="USD" onEditAsset={vi.fn()} onEditStream={vi.fn()} onViewChange={vi.fn()} />);
    expect(screen.queryByTestId('breakdown-view-toggle')).not.toBeInTheDocument();
    expect(screen.getByTestId('breakdown-cards').children).toHaveLength(flatItems.length);
  });
});

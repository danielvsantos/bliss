import { describe, it, expect } from 'vitest';
import type { PortfolioItem } from '@/types/api';
import type { AggregatedPortfolioHistory } from '@/lib/api';
import {
  buildHoldingOptions,
  buildHoldingSeries,
  filterHoldingOptions,
  holdingKey,
  parseHoldingParam,
  seriesChangePercent,
  toHistoryScope,
  type HoldingOption,
} from './portfolio-holding';

const summary = (marketValue: number) => ({
  costBasis: 0, marketValue, unrealizedPnL: 0, unrealizedPnLPercent: 0, realizedPnL: 0, totalInvested: 0,
});

let nextId = 1;
function item(over: Partial<PortfolioItem> & { value?: number; group?: string; type?: string; name?: string }): PortfolioItem {
  const { value = 100, group = 'Stocks', type = 'Investments', name = 'Stocks', ...rest } = over;
  return {
    id: nextId++,
    symbol: 'X',
    accountId: 1,
    hasLotMismatch: false,
    currency: 'USD',
    quantity: 1,
    source: 'SYNCED',
    category: { name, group, type },
    native: summary(value),
    usd: summary(value),
    ...rest,
  } as PortfolioItem;
}

const build = (items: PortfolioItem[], showDebt = false) => buildHoldingOptions(items, { portfolioCurrency: 'USD', showDebt });

describe('holdingKey / parseHoldingParam / toHistoryScope', () => {
  it('keys priced items by symbol and manual items by id', () => {
    expect(holdingKey({ id: 4, symbol: 'AAPL', source: 'SYNCED' })).toBe('AAPL');
    expect(holdingKey({ id: 4, symbol: 'Flat', source: 'MANUAL' })).toBe('item:4');
  });

  it('parses the URL param', () => {
    expect(parseHoldingParam(null)).toBeNull();
    expect(parseHoldingParam('  ')).toBeNull();
    expect(parseHoldingParam(' AAPL ')).toBe('AAPL');
    expect(parseHoldingParam('item:12')).toBe('item:12');
    expect(parseHoldingParam('item:abc')).toBeNull();
    expect(parseHoldingParam('X'.repeat(61))).toBeNull();
  });

  it('maps keys to the history scope', () => {
    expect(toHistoryScope('7203')).toEqual({ symbol: '7203' });
    expect(toHistoryScope('item:9')).toEqual({ itemId: 9 });
  });
});

describe('buildHoldingOptions', () => {
  it('merges one symbol across accounts and currencies into one entry', () => {
    const opts = build([
      item({ symbol: 'AAPL', accountId: 1, value: 6000 }),
      item({ symbol: 'AAPL', accountId: 2, value: 4000, currency: 'EUR' }),
    ]);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ key: 'AAPL', value: 10000 });
    expect(opts[0].itemIds).toHaveLength(2);
  });

  it('keeps manual items sharing a placeholder symbol separate', () => {
    const a = item({ symbol: 'Property', source: 'MANUAL', group: 'Real Estate', type: 'Asset' });
    const b = item({ symbol: 'Property', source: 'MANUAL', group: 'Real Estate', type: 'Asset' });
    expect(build([a, b]).map((o) => o.key).sort()).toEqual([`item:${a.id}`, `item:${b.id}`].sort());
  });

  it('gives cash one entry per currency and never marks it closed', () => {
    const opts = build([
      item({ symbol: 'Cash USD', group: 'Cash', type: 'Asset', quantity: 0, accountId: 1 }),
      item({ symbol: 'Cash USD', group: 'Cash', type: 'Asset', accountId: 2 }),
      item({ symbol: 'Cash EUR', group: 'Cash', type: 'Asset' }),
    ]);
    expect(opts.map((o) => o.key).sort()).toEqual(['Cash EUR', 'Cash USD']);
    expect(opts.every((o) => !o.isClosed)).toBe(true);
  });

  it('flags closed positions (all merged quantities zero) and sorts them last', () => {
    const opts = build([
      item({ symbol: 'TSLA', quantity: 0, value: 0 }),
      item({ symbol: 'AAPL', value: 10 }),
    ]);
    expect(opts.map((o) => [o.key, o.isClosed])).toEqual([['AAPL', false], ['TSLA', true]]);
  });

  it('excludes debt unless showDebt, and reports it as a positive balance', () => {
    const debt = item({ symbol: 'Mortgage', source: 'MANUAL', group: 'Real Estate Loan', type: 'Debt', quantity: 0, value: -150000 });
    expect(build([debt])).toEqual([]);
    const [opt] = build([debt], true);
    expect(opt).toMatchObject({ isDebt: true, isClosed: false, value: 150000 });
  });

  it('orders groups by total value (cash then debt last), then by value', () => {
    const opts = build([
      item({ symbol: 'Cash USD', group: 'Cash', type: 'Asset', value: 1e6 }),
      item({ symbol: 'BTC', group: 'Crypto', value: 50 }),
      item({ symbol: 'MSFT', value: 300 }),
      item({ symbol: 'AAPL', value: 400 }),
      item({ symbol: 'Loan', group: 'Loans', type: 'Debt', value: -5, source: 'MANUAL' }),
    ], true);
    expect(opts.map((o) => o.symbol)).toEqual(['AAPL', 'MSFT', 'BTC', 'Cash USD', 'Loan']);
  });
});

describe('filterHoldingOptions', () => {
  const opts: HoldingOption[] = build([
    item({ symbol: 'AAPL', name: 'Stocks' }),
    item({ symbol: 'SNAP', name: 'Stocks' }),
    item({ symbol: 'APPN', quantity: 0, value: 0 }),
    item({ symbol: 'VWRL', name: 'ETFs', group: 'ETFs' }),
  ]);

  it('matches symbol case-insensitively and hides closed by default', () => {
    expect(filterHoldingOptions(opts, 'aP', { includeClosed: false }).map((o) => o.symbol)).toEqual(['AAPL', 'SNAP']);
    expect(filterHoldingOptions(opts, 'app', { includeClosed: true }).map((o) => o.symbol)).toEqual(['APPN']);
  });

  it('matches the name and the translated name', () => {
    expect(filterHoldingOptions(opts, 'etf', { includeClosed: false }).map((o) => o.symbol)).toEqual(['VWRL']);
    const translated = filterHoldingOptions(opts, 'fondos', { includeClosed: false, translateName: (o) => (o.group === 'ETFs' ? 'Fondos' : '') });
    expect(translated.map((o) => o.symbol)).toEqual(['VWRL']);
  });

  it('returns everything open for an empty query', () => {
    expect(filterHoldingOptions(opts, '  ', { includeClosed: false })).toHaveLength(3);
  });

  it('filters 1,000 options well within the 100 ms budget', () => {
    const many = build(Array.from({ length: 1000 }, (_, i) => item({ symbol: `SYM${i}`, name: i % 7 ? 'Stocks' : 'Apple-ish', value: i })));
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) filterHoldingOptions(many, 'app', { includeClosed: true, translateName: (o) => o.group });
    const perCall = (performance.now() - t0) / 10;
    expect(perCall).toBeLessThan(50);
  });
});

describe('buildHoldingSeries', () => {
  const h = (date: string, inv = 0, asset = 0, debt = 0): AggregatedPortfolioHistory => ({
    date,
    totalUSD: inv + asset + debt,
    ...(inv && { Investments: { total: inv, groups: {} } }),
    ...(asset && { Asset: { total: asset, groups: {} } }),
    ...(debt && { Debt: { total: debt, groups: {} } }),
  });

  it('sums the blocks per date and negates debt, with no leading zeros', () => {
    const series = buildHoldingSeries([h('2026-07-01', 100), h('2026-07-02', 0, 50), h('2026-07-03', 0, 0, 30)], { isClosed: false });
    expect(series).toEqual([
      { date: '2026-07-01', value: 100 },
      { date: '2026-07-02', value: 50 },
      { date: '2026-07-03', value: -30 },
    ]);
  });

  it('steps a closed position to zero after its last valuation, up to today', () => {
    const series = buildHoldingSeries([h('2026-05-01', 80), h('2026-05-02', 90)], { isClosed: true, today: new Date('2026-06-01T12:00:00Z') });
    expect(series.slice(2)).toEqual([{ date: '2026-05-03', value: 0 }, { date: '2026-06-01', value: 0 }]);
  });

  it('does not pad when history already reaches today, or for open positions', () => {
    const today = new Date('2026-05-02T08:00:00Z');
    expect(buildHoldingSeries([h('2026-05-02', 1)], { isClosed: true, today })).toHaveLength(1);
    expect(buildHoldingSeries([h('2026-04-01', 1)], { isClosed: false, today })).toHaveLength(1);
    expect(buildHoldingSeries([], { isClosed: true, today })).toEqual([]);
  });

  it('pads a single zero when the close was yesterday', () => {
    const series = buildHoldingSeries([h('2026-05-01', 5)], { isClosed: true, today: new Date('2026-05-02T08:00:00Z') });
    expect(series).toEqual([{ date: '2026-05-01', value: 5 }, { date: '2026-05-02', value: 0 }]);
  });
});

describe('seriesChangePercent', () => {
  it('is (last − first) / first', () => {
    expect(seriesChangePercent([{ value: 200 }, { value: 250 }])).toBe(25);
    expect(seriesChangePercent([{ value: 0 }, { value: 250 }])).toBe(0);
    expect(seriesChangePercent([])).toBe(0);
  });
});

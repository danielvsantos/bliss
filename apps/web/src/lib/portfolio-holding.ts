// ── Holding filter for the Portfolio performance chart (#131) ──────────────
//
// Pure helpers behind the holding picker: identity keys, the URL param, the
// picker options (merged across accounts exactly like the holdings table),
// the search filter and the single-holding chart series.
//
// Identity:
//  - Priced items (stocks, ETFs, crypto, funds, cash) are keyed by symbol, so
//    under "All accounts" one symbol is one entry — the same key the table
//    merge uses. Cash symbols are "Cash <CCY>", so cash is one entry per currency.
//  - Manual items (real estate, private assets) are keyed by item id
//    ("item:<id>"), so two manual items sharing a placeholder symbol stay apart.

import type { PortfolioItem } from "@/types/api";
import type { AggregatedPortfolioHistory } from "@/lib/api";
import { getDisplayData, parseDecimal } from "@/lib/portfolio-utils";

const ITEM_PREFIX = "item:";

/** The picker / URL identity of a portfolio item. */
export function holdingKey(item: Pick<PortfolioItem, "id" | "symbol" | "source">): string {
  return item.source === "MANUAL" ? `${ITEM_PREFIX}${item.id}` : item.symbol;
}

/** Normalises a raw `?holding=` value; returns null when absent or malformed. */
export function parseHoldingParam(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (!value || value.length > 60) return null;
  if (value.startsWith(ITEM_PREFIX)) {
    return /^\d+$/.test(value.slice(ITEM_PREFIX.length)) ? value : null;
  }
  return value;
}

/** The history endpoint scope for a key: `{ symbol }` or `{ itemId }`. */
export function toHistoryScope(key: string): { symbol: string } | { itemId: number } {
  if (key.startsWith(ITEM_PREFIX)) return { itemId: Number(key.slice(ITEM_PREFIX.length)) };
  return { symbol: key };
}

export interface HoldingOption {
  key: string;
  symbol: string;
  /** Secondary line: the category name (the items payload carries no security name). */
  name: string;
  group: string;
  categoryType: string;
  isDebt: boolean;
  isCash: boolean;
  isClosed: boolean;
  /** Current market value in the portfolio currency (debt as a positive balance). */
  value: number;
  itemIds: number[];
}

export interface BuildHoldingOptionsParams {
  portfolioCurrency: string;
  showDebt: boolean;
}

/**
 * One option per identity key, sorted for the picker: open before closed,
 * groups by total value (Cash last, Debt after assets), then value descending.
 */
export function buildHoldingOptions(items: PortfolioItem[], { portfolioCurrency, showDebt }: BuildHoldingOptionsParams): HoldingOption[] {
  const byKey = new Map<string, PortfolioItem[]>();
  for (const item of items) {
    if (!showDebt && item.category.type === "Debt") continue;
    const key = holdingKey(item);
    const list = byKey.get(key);
    if (list) list.push(item);
    else byKey.set(key, [item]);
  }

  const options: HoldingOption[] = [];
  for (const [key, group] of byKey) {
    const base = group[0];
    const isDebt = base.category.type === "Debt";
    const isCash = base.category.group === "Cash";
    const raw = group.reduce((s, i) => s + parseDecimal(getDisplayData(i, portfolioCurrency).marketValue), 0);
    const quantity = group.reduce((s, i) => s + parseDecimal(i.quantity), 0);
    options.push({
      key,
      symbol: base.symbol,
      name: base.category.name,
      group: base.category.group,
      categoryType: base.category.type,
      isDebt,
      isCash,
      isClosed: !isDebt && !isCash && quantity === 0,
      value: isDebt ? Math.abs(raw) : raw,
      itemIds: group.map((i) => i.id),
    });
  }

  const groupTotals = new Map<string, number>();
  for (const o of options) groupTotals.set(o.group, (groupTotals.get(o.group) ?? 0) + o.value);
  const rank = (o: HoldingOption) => (o.isDebt ? 2 : o.isCash ? 1 : 0);

  return options.sort((a, b) =>
    Number(a.isClosed) - Number(b.isClosed)
    || rank(a) - rank(b)
    || (groupTotals.get(b.group) ?? 0) - (groupTotals.get(a.group) ?? 0)
    || a.group.localeCompare(b.group)
    || b.value - a.value
    || a.symbol.localeCompare(b.symbol),
  );
}

/**
 * Case-insensitive substring match on symbol and name (original and translated).
 * Closed options are dropped unless `includeClosed`. Order is preserved.
 */
export function filterHoldingOptions(
  options: HoldingOption[],
  query: string,
  { includeClosed, translateName }: { includeClosed: boolean; translateName?: (o: HoldingOption) => string },
): HoldingOption[] {
  const q = query.trim().toLowerCase();
  return options.filter((o) => {
    if (o.isClosed && !includeClosed) return false;
    if (!q) return true;
    return o.symbol.toLowerCase().includes(q)
      || o.name.toLowerCase().includes(q)
      || (translateName ? translateName(o).toLowerCase().includes(q) : false);
  });
}

export interface HoldingSeriesPoint {
  date: string;
  value: number;
}

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().split("T")[0];

/**
 * The single-holding series from a holding-scoped history response: the sum of
 * every category-type block per date (debt negated, as in the stacked chart).
 * No zero is inserted before the first valuation. A closed position steps to
 * zero after its last valuation and stays there until today (valuation stops
 * writing history at the close date); nothing is padded when history already
 * reaches today.
 */
export function buildHoldingSeries(
  history: AggregatedPortfolioHistory[],
  { isClosed, today = new Date() }: { isClosed: boolean; today?: Date },
): HoldingSeriesPoint[] {
  const points = history.map((h) => {
    const assets = (h.Investments?.total ?? 0) + (h.Asset?.total ?? 0);
    const debt = h.Debt?.total ? -Math.abs(h.Debt.total) : 0;
    return { date: h.date, value: assets + debt };
  });
  if (!isClosed || points.length === 0) return points;

  const todayStr = isoDay(today);
  const last = points[points.length - 1].date;
  if (last >= todayStr) return points;
  const nextDay = isoDay(new Date(new Date(`${last}T00:00:00Z`).getTime() + DAY_MS));
  points.push({ date: nextDay, value: 0 });
  if (nextDay < todayStr) points.push({ date: todayStr, value: 0 });
  return points;
}

/** (last − first) / first, in percent; 0 when there is no usable start. */
export function seriesChangePercent(points: { value: number }[]): number {
  if (points.length === 0) return 0;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  return first === 0 ? 0 : ((last - first) / Math.abs(first)) * 100;
}

import prisma from '../prisma/prisma.js';
import {
  classifyAssetClass,
  classifyIncomeAsset,
  resolveIncomeSource,
  isValidAssetClass,
  COVERAGE_ASSET_CLASSES,
  MANUAL_PRICE_STALE_DAYS,
  MANUAL_PRICE_WARNING_DAYS,
  MANUAL_PRICE_CRITICAL_DAYS,
} from '@bliss/shared/portfolio';
import { createFxResolver } from './passiveIncome.service.js';

/**
 * Manage Assets list (#81) — `GET /api/portfolio/assets`.
 *
 * A lightweight, paginated list of every portfolio item with the flags the
 * page needs (status chips, which actions apply). No live pricing and no
 * manual-value history: stored values only, plus one aggregate for the date of
 * the last manual value.
 *
 * Two-stage load:
 *   1. One narrow `portfolioItem.findMany` over the tenant (hundreds of rows)
 *      with the SQL-expressible filters, plus one `securityMaster.findMany`.
 *   2. Classify, look up the last manual value date of every manual item (one
 *      grouped query), count statuses, filter (asset class, search, status)
 *      and sort in memory, then slice the page. FX runs only for the page.
 *
 * Default sort `attention`: most urgent first (see `urgencyRank`), then
 * (category group, symbol, id); `sort=name` is the plain A–Z order. The cursor
 * is an opaque base64 offset into that deterministic sort. If a tenant ever holds thousands of items,
 * store the asset class in a column and move to keyset pagination.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
/** Statuses that need the user to do something, in urgency order. */
export const ACTION_STATUSES = ['stale', 'debtTermsMissing', 'incomeMissing', 'lotMismatch'];
/** Informational statuses (a user choice, nothing to fix). */
export const INFO_STATUSES = ['dividendOverride', 'assetClassOverridden'];
export const STATUS_FILTERS = [...ACTION_STATUSES, ...INFO_STATUSES];
export const SORTS = ['attention', 'name'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PORTFOLIO_CATEGORY_TYPES = ['Investments', 'Asset', 'Debt'];

export class ValidationError extends Error {}

function toNumber(v) {
  if (v == null) return null;
  const n = Number(typeof v === 'object' ? v.toString() : v);
  return Number.isFinite(n) ? n : null;
}

export function encodeCursor(offset) {
  return Buffer.from(String(offset)).toString('base64');
}

export function decodeCursor(cursor) {
  if (cursor == null || cursor === '') return 0;
  const raw = Buffer.from(String(cursor), 'base64').toString('utf8');
  if (!/^\d+$/.test(raw)) throw new ValidationError('Invalid cursor');
  return parseInt(raw, 10);
}

/** Parse and validate the query string. Throws ValidationError. */
export function parseListQuery(query = {}) {
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const str = (v) => {
    const s = one(v);
    return typeof s === 'string' && s.trim() !== '' ? s.trim() : null;
  };

  let limit = DEFAULT_LIMIT;
  if (str(query.limit) != null) {
    limit = parseInt(str(query.limit), 10);
    if (!Number.isFinite(limit) || limit < 1) throw new ValidationError('limit must be a positive integer');
    limit = Math.min(limit, MAX_LIMIT);
  }

  let accountId = null;
  if (str(query.accountId) != null) {
    accountId = parseInt(str(query.accountId), 10);
    if (!Number.isFinite(accountId)) throw new ValidationError('Invalid accountId');
  }

  let id = null;
  if (str(query.id) != null) {
    id = parseInt(str(query.id), 10);
    if (!Number.isFinite(id)) throw new ValidationError('Invalid id');
  }

  const assetClass = str(query.assetClass);
  if (assetClass != null && !isValidAssetClass(assetClass)) throw new ValidationError('Invalid assetClass');

  const sort = str(query.sort) ?? 'attention';
  if (!SORTS.includes(sort)) throw new ValidationError(`Invalid sort. Must be one of: ${SORTS.join(', ')}`);

  const status = str(query.status);
  if (status != null && !STATUS_FILTERS.includes(status)) {
    throw new ValidationError(`Invalid status. Must be one of: ${STATUS_FILTERS.join(', ')}`);
  }

  return {
    id,
    type: str(query.type),
    accountId,
    assetClass,
    status,
    sort,
    search: str(query.search)?.toLowerCase() ?? null,
    includeClosed: str(query.includeClosed) === 'true',
    offset: decodeCursor(str(query.cursor)),
    limit,
  };
}

function buildWhere(tenantId, q) {
  const where = {
    tenantId,
    category: { type: { in: PORTFOLIO_CATEGORY_TYPES } },
  };
  if (q.id != null) where.id = q.id;
  if (q.accountId != null) where.accountId = q.accountId;
  // `type` is either a processingHint (API_STOCK, MANUAL, …) or a category group.
  if (q.type) {
    where.category = /^[A-Z_]+$/.test(q.type)
      ? { ...where.category, processingHint: q.type }
      : { ...where.category, group: q.type };
  }
  // Closed positions (quantity 0) are hidden unless asked for; debts always show.
  if (!q.includeClosed && q.id == null) {
    where.OR = [{ quantity: { not: 0 } }, { category: { type: 'Debt' } }];
  }
  return where;
}

async function lastManualValueDates(tenantId, ids) {
  if (ids.length === 0) return new Map();
  const rows = await prisma.manualAssetValue.groupBy({
    by: ['assetId'],
    where: { tenantId, assetId: { in: ids } },
    _max: { date: true },
  });
  return new Map(rows.map((r) => [r.assetId, r._max?.date ?? null]));
}

export function isPriceStale(row, lastDate, now = new Date()) {
  if (row.processingHint !== 'MANUAL' || !(row.quantityNumber > 0)) return false;
  if (!lastDate) return true;
  return (now.getTime() - new Date(lastDate).getTime()) / MS_PER_DAY > MANUAL_PRICE_STALE_DAYS;
}

/**
 * Urgency rank for the default "attention" sort (lower = more urgent):
 *   0 price critical (no value, or 90+ days) · 1 price warning (60+) ·
 *   2 price stale (30+) · 3 debt terms missing · 4 income terms missing ·
 *   5 lot mismatch · 6 nothing to do.
 */
export function urgencyRank(row, lastDate, now = new Date()) {
  if (row.isPriceStale) {
    if (!lastDate) return 0;
    const days = (now.getTime() - new Date(lastDate).getTime()) / MS_PER_DAY;
    if (days >= MANUAL_PRICE_CRITICAL_DAYS) return 0;
    if (days >= MANUAL_PRICE_WARNING_DAYS) return 1;
    return 2;
  }
  if (row.debtTermsMissing) return 3;
  if (row.incomeDataStatus === 'MISSING') return 4;
  if (row.hasLotMismatch) return 5;
  return 6;
}

/** Classify one item into a list row (no per-row I/O). */
function toRow(item, sm) {
  const category = item.category || {};
  const terms = item.incomeTerms || null;
  const security = sm
    ? { assetType: sm.assetType, name: sm.name, composition: sm.etfComposition }
    : null;
  const classification = classifyAssetClass({
    override: item.assetClassOverride,
    processingHint: category.processingHint,
    defaultCategoryCode: category.defaultCategoryCode,
    categoryGroup: category.group,
    security,
    incomeTerms: terms,
  });

  const quantityNumber = toNumber(item.quantity) ?? 0;
  const incomeAssetClass = classifyIncomeAsset({ ...category, securityAssetType: sm?.assetType });
  let incomeDataStatus = 'NOT_APPLICABLE';
  if (incomeAssetClass) {
    const trusted = sm?.dividendTrusted === true;
    incomeDataStatus = resolveIncomeSource({
      assetClass: incomeAssetClass,
      terms,
      recentDividends: trusted ? (Array.isArray(sm.recentDividends) ? sm.recentDividends : []) : null,
    });
    // Only holdings the projection counts toward coverage can be "missing";
    // cash and other assets without terms simply have none configured.
    if (incomeDataStatus === 'MISSING' && (!COVERAGE_ASSET_CLASSES.includes(incomeAssetClass) || !(quantityNumber > 0))) {
      incomeDataStatus = 'NONE';
    }
  }

  return {
    id: item.id,
    symbol: item.symbol,
    displayName: sm?.name || item.symbol,
    categoryName: category.name ?? null,
    categoryType: category.type ?? null,
    group: category.group ?? null,
    processingHint: category.processingHint ?? null,
    accountId: item.accountId ?? null,
    accountName: item.account?.name ?? null,
    currency: item.currency,
    quantity: item.quantity?.toString?.() ?? String(item.quantity ?? '0'),
    currentValue: item.currentValue?.toString?.() ?? null,
    currentValueInDisplay: null,
    lastManualValueDate: null,
    assetClass: classification.assetClass,
    assetClassSource: classification.source,
    incomeAssetClass,
    hasLotMismatch: item.hasLotMismatch === true,
    hasIncomeTerms: terms != null,
    hasDividendOverride: terms?.incomeType === 'DIVIDEND' && terms?.dividendPerUnit != null,
    hasDebtTerms: item.debtTerms != null,
    // Only amortizing loans use debt terms (the loan processor needs them).
    debtTermsMissing: category.type === 'Debt' && category.processingHint === 'AMORTIZING_LOAN' && item.debtTerms == null,
    isPriceStale: false,
    needsAttention: false,
    incomeDataStatus,
    // internal, stripped before responding
    quantityNumber,
    currentValueInUSD: item.currentValueInUSD,
    searchText: `${item.symbol} ${sm?.name ?? ''}`.toLowerCase(),
  };
}

function matchesStatus(row, status) {
  switch (status) {
    case 'stale': return row.isPriceStale;
    case 'debtTermsMissing': return row.debtTermsMissing;
    case 'incomeMissing': return row.incomeDataStatus === 'MISSING';
    case 'dividendOverride': return row.hasDividendOverride;
    case 'lotMismatch': return row.hasLotMismatch;
    case 'assetClassOverridden': return row.assetClassSource === 'OVERRIDE';
    default: return true;
  }
}

function compareByName(a, b) {
  return (
    (a.group ?? '').localeCompare(b.group ?? '') ||
    a.symbol.localeCompare(b.symbol) ||
    a.id - b.id
  );
}

function compareByAttention(a, b) {
  return a.urgency - b.urgency || compareByName(a, b);
}

/**
 * @returns {Promise<{ portfolioCurrency, items, nextCursor, totals, statusCounts, detachedTermsCount, facets? }>}
 */
export async function listAssets(tenantId, q, { now = new Date() } = {}) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { portfolioCurrency: true },
  });
  const portfolioCurrency = tenant?.portfolioCurrency || 'USD';

  const [items, detachedTermsCount, facetRows] = await Promise.all([
    prisma.portfolioItem.findMany({
      where: buildWhere(tenantId, q),
      select: {
        id: true,
        symbol: true,
        accountId: true,
        currency: true,
        quantity: true,
        currentValue: true,
        currentValueInUSD: true,
        hasLotMismatch: true,
        assetClassOverride: true,
        category: {
          select: { name: true, type: true, group: true, processingHint: true, defaultCategoryCode: true },
        },
        account: { select: { name: true } },
        incomeTerms: {
          select: { id: true, incomeType: true, issuerType: true, dividendPerUnit: true, isDistributing: true, yieldPct: true },
        },
        debtTerms: { select: { id: true } },
      },
    }),
    prisma.incomeTerms.count({
      where: { tenantId, assetId: null, categoryId: null, orphanedAt: { not: null } },
    }),
    // Filter options come from the unfiltered list, first page only.
    q.offset === 0 && q.id == null
      ? prisma.portfolioItem.findMany({
          where: buildWhere(tenantId, { includeClosed: q.includeClosed }),
          select: { category: { select: { group: true } }, account: { select: { id: true, name: true } } },
        })
      : Promise.resolve(null),
  ]);

  const symbols = [...new Set(items.map((i) => i.symbol))];
  const smRows = symbols.length
    ? await prisma.securityMaster.findMany({
        where: { symbol: { in: symbols } },
        select: {
          symbol: true,
          name: true,
          assetType: true,
          etfComposition: true,
          dividendTrusted: true,
          recentDividends: true,
        },
      })
    : [];
  const smMap = new Map(smRows.map((r) => [r.symbol, r]));

  let rows = items.map((item) => toRow(item, smMap.get(item.symbol)));

  if (q.assetClass) rows = rows.filter((r) => r.assetClass === q.assetClass);
  if (q.search) rows = rows.filter((r) => r.searchText.includes(q.search));

  // Stale flags, status counts and the attention sort all need the last value
  // date of every manual item in the set: one grouped max(date) query.
  const lastDates = await lastManualValueDates(
    tenantId,
    rows.filter((r) => r.processingHint === 'MANUAL').map((r) => r.id),
  );
  for (const r of rows) {
    r.isPriceStale = isPriceStale(r, lastDates.get(r.id), now);
    r.urgency = urgencyRank(r, lastDates.get(r.id), now);
    r.needsAttention = r.urgency < 6;
  }

  // Counts per status over the current filters (before the status filter), so
  // a summary card's number matches the rows its filter shows.
  const statusCounts = Object.fromEntries(STATUS_FILTERS.map((s) => [s, 0]));
  let attentionCount = 0;
  for (const r of rows) {
    for (const s of STATUS_FILTERS) if (matchesStatus(r, s)) statusCounts[s] += 1;
    if (r.needsAttention) attentionCount += 1;
  }

  if (q.status) rows = rows.filter((r) => matchesStatus(r, q.status));

  rows.sort(q.sort === 'name' ? compareByName : compareByAttention);
  const total = rows.length;
  const page = rows.slice(q.offset, q.offset + q.limit);

  // ── Per-page enrichment ──
  const fx = createFxResolver(portfolioCurrency, now);
  const usdToDisplay = await fx('USD');
  for (const r of page) {
    const last = lastDates.get(r.id) ?? null;
    r.lastManualValueDate = last ? new Date(last).toISOString() : null;
    const usd = toNumber(r.currentValueInUSD);
    const native = toNumber(r.currentValue);
    let display = null;
    if (usd != null) display = usd * usdToDisplay;
    else if (native != null) display = native * (await fx(r.currency));
    r.currentValueInDisplay = display == null ? null : Math.round(display * 100) / 100;
  }

  const nextOffset = q.offset + page.length;
  const response = {
    portfolioCurrency,
    items: page.map(({ quantityNumber, currentValueInUSD, searchText, urgency, ...rest }) => rest),
    nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
    totals: { count: total, attention: attentionCount },
    statusCounts,
    detachedTermsCount,
  };

  if (facetRows) {
    const groups = new Map();
    const accounts = new Map();
    for (const f of facetRows) {
      const g = f.category?.group;
      if (g) groups.set(g, (groups.get(g) || 0) + 1);
      if (f.account?.id != null) accounts.set(f.account.id, f.account.name);
    }
    response.facets = {
      groups: [...groups.entries()]
        .map(([group, count]) => ({ group, count }))
        .sort((a, b) => a.group.localeCompare(b.group)),
      accounts: [...accounts.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  return response;
}

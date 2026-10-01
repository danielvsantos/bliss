import { z } from 'zod';
import {
  ASSET_CLASSES,
  BOND_ISSUER_TYPES,
  INCOME_FREQUENCIES,
  INCOME_TYPES,
  REFERENCE_INDICES,
} from '@bliss/shared/portfolio';
import { defineTool, cursorField, limitField, dateString, intId, currencyCode, pathId } from '../define.js';
import { ToolInputError, ToolNotFoundError, notFoundAs } from '../errors.js';
import { LoopbackError, optional } from '../loopback.js';
import { paginate, pageArgs, pageMeta, num, money, isoDate } from '../shape.js';

/** Portfolio & passive income (#89). */

const ASSET_HINT = 'Use get_portfolio_holdings to find asset IDs.';
const DETACHED_HINT = 'Use get_passive_income (detachedTerms) to find termsId values.';
const assetId = intId('Asset (portfolio item) ID from get_portfolio_holdings.');

function shapePosition(item, portfolioCurrency) {
  const display = item.portfolio ?? item.usd;
  const displayCurrency = item.portfolio ? portfolioCurrency : 'USD';
  return {
    assetId: item.id,
    symbol: item.symbol,
    category: { name: item.category?.name, group: item.category?.group, type: item.category?.type },
    account: item.account ? { id: item.account.id, name: item.account.name } : null,
    quantity: num(item.quantity),
    marketValue: money(item.native?.marketValue, item.currency),
    costBasis: money(item.native?.costBasis, item.currency),
    unrealizedPnL: money(item.native?.unrealizedPnL, item.currency),
    unrealizedPnLPercent: num(item.native?.unrealizedPnLPercent) == null ? null : Math.round(num(item.native.unrealizedPnLPercent) * 100) / 100,
    realizedPnL: money(item.native?.realizedPnL, item.currency),
    marketValueDisplay: money(display?.marketValue, displayCurrency),
    hasIncomeTerms: item.incomeTerms != null,
    hasDebtTerms: item.debtTerms != null,
    ...(item.hasLotMismatch && { hasLotMismatch: true }),
  };
}

const getPortfolioHoldings = defineTool({
  name: 'get_portfolio_holdings',
  access: 'read',
  title: 'Get portfolio holdings',
  description:
    'view "positions" (default): current investments, assets and debts with quantity, market value, cost basis '
    + 'and P&L in the holding\'s currency plus `marketValueDisplay` in the display currency. view "attention": the '
    + 'Manage Assets list with what needs action (stale manual price, missing income or debt terms, lot mismatch). '
    + 'view "snapshots": stored daily holding snapshots (quantity/value/cost) for one ticker or account. '
    + 'Use the `assetId` in the other portfolio tools.',
  input: {
    view: z.enum(['positions', 'attention', 'snapshots']).optional(),
    accountId: intId('Only holdings in this account.').optional(),
    categoryType: z.enum(['Investments', 'Asset', 'Debt']).optional().describe('positions only.'),
    search: z.string().max(100).optional().describe('attention only: symbol/name search.'),
    status: z.enum(['stale', 'debtTermsMissing', 'incomeMissing', 'lotMismatch', 'dividendOverride', 'assetClassOverridden'])
      .optional().describe('attention only: filter by status.'),
    ticker: z.string().max(50).optional().describe('snapshots only: symbol.'),
    limit: limitField(50),
    cursor: cursorField,
  },
  wraps: [
    { method: 'GET', route: '/api/portfolio/items' },
    { method: 'GET', route: '/api/portfolio/assets' },
    { method: 'GET', route: '/api/portfolio/holdings' },
  ],
  async handler(args, { api }) {
    const view = args.view ?? 'positions';
    if (view === 'attention') {
      const data = await api.get('/api/portfolio/assets', {
        accountId: args.accountId, search: args.search, status: args.status, limit: args.limit ?? 50, cursor: args.cursor,
      });
      return {
        view,
        displayCurrency: data.portfolioCurrency,
        items: (data.items || []).map((r) => ({
          assetId: r.id,
          symbol: r.symbol,
          name: r.displayName,
          category: r.categoryName,
          group: r.group,
          account: r.accountName,
          assetClass: r.assetClass,
          quantity: num(r.quantity),
          valueDisplay: money(r.currentValueInDisplay, data.portfolioCurrency),
          lastManualValueDate: isoDate(r.lastManualValueDate),
          statuses: r.statuses ?? undefined,
          needsAttention: r.needsAttention,
          isPriceStale: r.isPriceStale,
          debtTermsMissing: r.debtTermsMissing,
          hasIncomeTerms: r.hasIncomeTerms,
        })),
        total: data.totals?.count,
        needingAttention: data.totals?.attention,
        statusCounts: data.statusCounts,
        hasMore: data.nextCursor != null,
        nextCursor: data.nextCursor,
      };
    }
    if (view === 'snapshots') {
      const p = pageArgs(args, 50);
      const data = await api.get('/api/portfolio/holdings', {
        account: args.accountId, ticker: args.ticker, page: p.page, pageSize: p.limit,
      });
      const total = data.pagination?.totalCount ?? 0;
      return {
        view,
        items: (data.data || []).map((h) => ({
          assetId: h.portfolioItemId,
          symbol: h.asset?.symbol,
          date: isoDate(h.date),
          quantity: num(h.quantity),
          value: money(h.totalValue, h.asset?.currency),
          costBasis: money(h.costBasis, h.asset?.currency),
        })),
        total,
        ...pageMeta(p, total),
      };
    }
    const data = await api.get('/api/portfolio/items', { accountId: args.accountId, assetType: args.categoryType });
    const positions = (data.items || []).map((i) => shapePosition(i, data.portfolioCurrency));
    return { view, displayCurrency: data.portfolioCurrency, ...paginate(positions, args, 50) };
  },
});

const getPortfolioHistory = defineTool({
  name: 'get_portfolio_history',
  access: 'read',
  title: 'Get portfolio value history',
  description:
    'Total portfolio value over time (net worth of investments, assets and debts) in the display currency, with '
    + 'the split per category type. Prefer resolution "monthly" or "weekly" for long ranges.',
  input: {
    from: dateString('Start date').optional(),
    to: dateString('End date').optional(),
    resolution: z.enum(['daily', 'weekly', 'monthly']).optional(),
    types: z.array(z.enum(['Investments', 'Asset', 'Debt'])).max(3).optional(),
    groups: z.array(z.string().max(100)).max(20).optional().describe('Only these category groups.'),
    accountId: intId('Only this account.').optional(),
    limit: limitField(100),
    cursor: cursorField,
  },
  wraps: [{ method: 'GET', route: '/api/portfolio/history' }],
  async handler(args, { api }) {
    const data = await api.get('/api/portfolio/history', {
      from: args.from,
      to: args.to,
      resolution: args.resolution,
      type: args.types?.join(','),
      group: args.groups?.join(','),
      accountId: args.accountId,
    });
    const useDisplay = data.portfolioCurrency && data.portfolioCurrency !== 'USD';
    const points = (data.history || []).map((h) => {
      const byType = {};
      for (const [k, v] of Object.entries(h)) {
        if (v && typeof v === 'object' && 'total' in v) byType[k] = Math.round(v.total * 100) / 100;
      }
      const total = useDisplay ? h.totalPortfolioCurrency : h.totalUSD;
      return { date: h.date, total: total == null ? null : Math.round(total * 100) / 100, byType };
    });
    return {
      currency: useDisplay ? data.portfolioCurrency : 'USD',
      resolution: data.resolution,
      ...paginate(points, args, 100),
    };
  },
});

const getEquityAnalysis = defineTool({
  name: 'get_equity_analysis',
  access: 'read',
  title: 'Get equity analysis',
  description:
    'Stock and ETF holdings grouped by sector, industry, country or asset class, with weights, weighted P/E and '
    + 'dividend yield. ETFs are looked through into their sectors/countries unless lookThrough is false.',
  input: {
    groupBy: z.enum(['sector', 'industry', 'country', 'assetClass']).optional(),
    accountId: intId('Only this account.').optional(),
    lookThrough: z.boolean().optional(),
    topHoldings: z.number().int().min(0).max(50).optional().describe('How many largest holdings to include (default 20).'),
  },
  wraps: [{ method: 'GET', route: '/api/portfolio/equity-analysis' }],
  async handler(args, { api }) {
    const data = await api.get('/api/portfolio/equity-analysis', {
      groupBy: args.groupBy ?? 'sector',
      accountId: args.accountId,
      lookThrough: args.lookThrough === false ? 'false' : undefined,
    });
    const holdings = (data.holdings || []).slice(0, args.topHoldings ?? 20).map((h) => ({
      symbol: h.symbol,
      name: h.name ?? null,
      assetClass: h.assetClass ?? null,
      sector: h.sector ?? null,
      country: h.country ?? null,
      value: money(h.currentValue, data.portfolioCurrency),
      weight: h.weight == null ? null : Math.round(h.weight * 10000) / 100,
      peRatio: h.peRatio ?? null,
      dividendYieldPct: h.dividendYield == null ? null : Math.round(h.dividendYield * 10000) / 100,
    }));
    return {
      currency: data.portfolioCurrency,
      groupBy: args.groupBy ?? 'sector',
      lookThrough: data.lookThrough,
      summary: data.summary,
      groups: (data.groups || []).slice(0, 50).map((g) => ({
        name: g.name,
        value: money(g.totalValue, data.portfolioCurrency),
        weightPct: g.weight == null ? null : Math.round(g.weight * 10000) / 100,
        holdings: g.holdingsCount,
      })),
      topHoldings: holdings,
      holdingsCount: (data.holdings || []).length,
    };
  },
});

const getPassiveIncome = defineTool({
  name: 'get_passive_income',
  access: 'read',
  title: 'Get passive income projection',
  description:
    'Projected dividends, bond coupons, rent, interest and other income streams for the next 12/24/36 months '
    + '(display currency), next to the last 12 months of actual passive income. Also lists holdings missing '
    + 'income terms, user-defined income streams and detached terms left over from re-keyed holdings. '
    + 'Every amount is in the display currency (`currency`); the monthly/yearly series are plain numbers in it. '
    + '`byHolding[].holdingCurrency` is the holding\'s own currency, for reference only.',
  input: {
    horizon: z.union([z.literal(12), z.literal(24), z.literal(36)]).optional(),
  },
  wraps: [
    { method: 'GET', route: '/api/portfolio/passive-income' },
    { method: 'GET', route: '/api/portfolio/income-terms/detached' },
    { method: 'GET', route: '/api/passive-income/streams' },
  ],
  async handler(args, { api }) {
    const [projection, detached, streams] = await Promise.all([
      api.get('/api/portfolio/passive-income', { horizon: args.horizon ?? 12 }),
      api.get('/api/portfolio/income-terms/detached'),
      api.get('/api/passive-income/streams'),
    ]);
    const cur = projection.displayCurrency;
    const kpis = projection.kpis || {};
    const pct = (ratio) => (ratio == null ? null : Math.round(ratio * 10000) / 100);
    return {
      currency: cur,
      asOf: projection.asOf,
      horizon: projection.horizon,
      kpis: {
        next12mIncome: money(kpis.next12mIncome, cur),
        next12mInvestmentIncome: money(kpis.next12mInvestmentIncome, cur),
        next12mOtherIncome: money(kpis.next12mOtherIncome, cur),
        monthlyAverage: money(kpis.monthlyAverage, cur),
        yieldOnValuePct: pct(kpis.yieldOnValue),
        essentialsCoveragePct: kpis.essentialsCoveragePct ?? null,
        trailingEssentials: money(kpis.trailingEssentials, cur),
        coverage: kpis.coverage ?? null,
      },
      projectedByMonth: projection.projected,
      yearly: projection.yearly,
      actualsLast12Months: projection.actuals,
      // One row per symbol (cash: per currency); values were converted into the
      // display currency by project(), so `currency` on the group is only the
      // holdings' own currency and must not label these amounts.
      byHolding: (projection.groups || []).slice(0, 50).map((g) => ({
        label: g.label,
        symbol: g.symbol ?? null,
        assetClass: g.assetClass ?? null,
        assetIds: g.portfolioItemIds,
        accounts: g.accountCount,
        holdingCurrency: g.currency ?? null,
        currentValue: money(g.currentValue, cur),
        next12mIncome: money(g.next12mTotal, cur),
        horizonIncome: money(g.horizonTotal, cur),
        amountPerPayment: money(g.amountPerPayment, cur),
        incomeType: g.incomeType ?? null,
        frequency: g.frequency ?? null,
        source: g.source ?? null,
        rateOrYieldPct: pct(g.rateOrYield),
        nextPaymentDate: g.nextPaymentDate ?? null,
        status: g.status,
      })),
      upcomingPayments: (projection.upcomingPaymentsGrouped || projection.upcomingPayments || [])
        .slice(0, 20)
        .map(({ amount, ...u }) => ({ ...u, amount: money(amount, cur) })),
      missingTerms: (projection.missingGroups || projection.missing || []).slice(0, 50),
      streams: (streams.streams || []).map((s) => ({
        streamId: s.id, name: s.name, categoryId: s.categoryId, category: s.categoryName,
        amountPerPayment: money(s.amountPerPayment, s.currency), frequency: s.frequency,
        startDate: isoDate(s.startDate), endDate: isoDate(s.endDate),
      })),
      eligibleStreamCategories: streams.eligibleCategories,
      detachedTerms: (detached.detached || []).map((d) => ({
        termsId: d.id, label: d.orphanedLabel, incomeType: d.incomeType, currency: d.currency, orphanedAt: isoDate(d.orphanedAt),
      })),
    };
  },
});

const getHoldingDetails = defineTool({
  name: 'get_holding_details',
  access: 'read',
  title: 'Get holding details',
  description:
    'Everything about one holding: asset class (and whether it is overridden), income terms (dividends, '
    + 'coupons, rent, interest), debt terms (loans) and the most recent manual valuations (per-unit prices).',
  input: {
    assetId,
    manualValuesLimit: z.number().int().min(0).max(100).optional().describe('Most recent manual values (default 20).'),
  },
  wraps: [
    { method: 'GET', route: '/api/portfolio/items/[assetId]/asset-class' },
    { method: 'GET', route: '/api/portfolio/items/[assetId]/income-terms' },
    { method: 'GET', route: '/api/portfolio/items/[assetId]/debt-terms' },
    { method: 'GET', route: '/api/portfolio/items/[assetId]/manual-values' },
  ],
  notFoundHint: ASSET_HINT,
  async handler(args, { api }) {
    const base = `/api/portfolio/items/${args.assetId}`;
    // asset-class is the tenant-scoped primary read: a foreign ID fails here.
    const assetClass = await api.get(`${base}/asset-class`);
    const [income, debt, values] = await Promise.all([
      optional(api.get(`${base}/income-terms`)),
      optional(api.get(`${base}/debt-terms`)),
      optional(api.get(`${base}/manual-values`), []),
    ]);
    const list = Array.isArray(values) ? values : [];
    return {
      assetId: args.assetId,
      symbol: income?.asset?.symbol ?? null,
      assetClass: assetClass.assetClass,
      assetClassSource: assetClass.assetClassSource,
      autoAssetClass: assetClass.autoAssetClass,
      incomeTerms: income?.terms ?? null,
      incomeAssetClass: income?.asset?.assetClass ?? null,
      autoDividends: income?.auto
        ? { annualDividend: income.auto.annualDividend, dividendYield: income.auto.dividendYield, frequency: income.auto.frequency, currency: income.auto.currency }
        : null,
      debtTerms: debt
        ? {
          initialBalance: num(debt.initialBalance), interestRate: num(debt.interestRate),
          termInMonths: debt.termInMonths, originationDate: isoDate(debt.originationDate),
        }
        : null,
      manualValues: list.slice(0, args.manualValuesLimit ?? 20).map((v) => ({
        valueId: v.id, date: isoDate(v.date), value: money(v.value, v.currency), notes: v.notes ?? null,
      })),
      manualValuesTotal: list.length,
    };
  },
});

const setAssetClass = defineTool({
  name: 'set_asset_class',
  access: 'write',
  title: 'Set asset class',
  description:
    'Override the automatic asset class of a holding (null restores the automatic one). applyToSymbol applies '
    + 'it to every holding of the same symbol across accounts.',
  input: {
    assetId,
    assetClass: z.enum(ASSET_CLASSES).nullable(),
    applyToSymbol: z.boolean().optional(),
  },
  wraps: [{ method: 'PUT', route: '/api/portfolio/items/[assetId]/asset-class' }],
  notFoundHint: ASSET_HINT,
  async handler(args, { api }) {
    const data = await api.put(`/api/portfolio/items/${args.assetId}/asset-class`, {
      assetClass: args.assetClass, applyToSymbol: args.applyToSymbol === true,
    });
    return { assetId: args.assetId, ...data };
  },
});

/** A written manual value plus the total it implies at the holding's current quantity. */
function shapeManualValue(v) {
  const quantity = num(v.asset?.quantity);
  const price = num(v.value);
  return {
    valueId: v.id,
    date: isoDate(v.date),
    value: money(v.value, v.currency),
    currentQuantity: quantity,
    impliedMarketValue: quantity == null || price == null ? null : money(price * quantity, v.currency),
  };
}

const manageManualValues = defineTool({
  name: 'manage_manual_values',
  access: 'write',
  destructive: true,
  title: 'Add, update or delete a manual valuation',
  description:
    'Manual valuations price holdings without market data (property, private assets, cash-like accounts). '
    + 'value is the PRICE PER UNIT, not the position total: market value = value × quantity. To enter a '
    + 'statement total, divide it by the holding quantity first (get_portfolio_holdings). '
    + 'add: date, value and currency required. update: valueId plus the fields to change. delete: valueId. '
    + 'add/update return currentQuantity and impliedMarketValue so the result can be checked. '
    + 'Each change triggers a portfolio revaluation. valueId comes from get_holding_details.',
  input: {
    assetId,
    action: z.enum(['add', 'update', 'delete']),
    valueId: pathId().optional(),
    date: dateString('Valuation date').optional(),
    value: z.number().optional().describe('Price per unit on that date (NOT the position total; market value = value × quantity).'),
    currency: currencyCode.optional(),
    notes: z.string().max(500).optional(),
  },
  wraps: [
    { method: 'POST', route: '/api/portfolio/items/[assetId]/manual-values' },
    { method: 'PUT', route: '/api/portfolio/items/[assetId]/manual-values/[valueId]' },
    { method: 'DELETE', route: '/api/portfolio/items/[assetId]/manual-values/[valueId]' },
  ],
  notFoundHint: 'Use get_holding_details to find valueId values.',
  async handler(args, { api }) {
    const base = `/api/portfolio/items/${args.assetId}/manual-values`;
    if (args.action === 'add') {
      if (!args.date || args.value == null || !args.currency) throw new ToolInputError('add requires date, value and currency.');
      const v = await api.post(base, { date: args.date, value: args.value, currency: args.currency, notes: args.notes });
      return { added: shapeManualValue(v) };
    }
    if (!args.valueId) throw new ToolInputError(`${args.action} requires valueId.`);
    const path = `${base}/${encodeURIComponent(args.valueId)}`;
    if (args.action === 'update') {
      const v = await api.put(path, { date: args.date, value: args.value, currency: args.currency, notes: args.notes });
      return { updated: shapeManualValue(v) };
    }
    await api.del(path);
    return { deleted: args.valueId };
  },
});

const termsSchema = z.object({
  incomeType: z.enum(INCOME_TYPES.filter((t) => t !== 'FIXED_AMOUNT')),
  isDistributing: z.boolean().optional().describe('false = holds this type but pays nothing (e.g. accumulating ETF).'),
  frequency: z.enum(INCOME_FREQUENCIES).optional(),
  currency: currencyCode.optional(),
  dividendPerUnit: z.number().nonnegative().optional().describe('DIVIDEND: per share per year, overrides market data.'),
  yieldPct: z.number().nonnegative().optional().describe('DIVIDEND / CUSTOM_YIELD: annual yield in percent.'),
  faceValuePerUnit: z.number().nonnegative().optional().describe('Bonds.'),
  couponRate: z.number().optional().describe('Bonds: annual coupon in percent.'),
  spread: z.number().optional(),
  assumedIndexRate: z.number().optional().describe('Floating / inflation-linked bonds: assumed index rate, percent.'),
  referenceIndex: z.enum(REFERENCE_INDICES).optional(),
  issuerType: z.enum(BOND_ISSUER_TYPES).optional(),
  maturityDate: dateString('Bond maturity').optional(),
  anchorPaymentDate: dateString('A known payment date').optional(),
  monthlyRent: z.number().nonnegative().optional().describe('RENT: net monthly rent.'),
  annualIndexationPct: z.number().optional(),
  leaseEndDate: dateString('Lease end').optional(),
  apyPct: z.number().nonnegative().optional().describe('INTEREST: annual percentage yield.'),
}).describe('Income terms (replaces the existing terms). Rates are percentages.');

const manageIncomeAndDebtTerms = defineTool({
  name: 'manage_income_and_debt_terms',
  access: 'write',
  destructive: true,
  title: 'Set or remove income / debt terms',
  description:
    'target "income": set (assetId + terms; applyToSymbol copies them to every holding of the symbol), delete '
    + '(assetId), attach (termsId of detached terms + assetId), deleteDetached (termsId). target "debt": set '
    + '(assetId + debt fields; creates or replaces the loan terms). Terms drive the passive income projection '
    + 'and loan amortisation.',
  input: {
    target: z.enum(['income', 'debt']),
    action: z.enum(['set', 'delete', 'attach', 'deleteDetached']),
    assetId: assetId.optional(),
    termsId: intId('Detached income terms ID from get_passive_income.').optional(),
    applyToSymbol: z.boolean().optional(),
    terms: termsSchema.optional(),
    initialBalance: z.number().nonnegative().optional().describe('debt: original loan amount.'),
    interestRate: z.number().nonnegative().optional().describe('debt: annual interest rate, percent.'),
    termInMonths: z.number().int().positive().optional().describe('debt: loan term.'),
    originationDate: dateString('debt: loan start').optional(),
  },
  wraps: [
    { method: 'PUT', route: '/api/portfolio/items/[assetId]/income-terms' },
    { method: 'DELETE', route: '/api/portfolio/items/[assetId]/income-terms' },
    { method: 'DELETE', route: '/api/portfolio/income-terms/[id]' },
    { method: 'POST', route: '/api/portfolio/income-terms/[id]/attach' },
    { method: 'POST', route: '/api/portfolio/items/[assetId]/debt-terms' },
    { method: 'PUT', route: '/api/portfolio/items/[assetId]/debt-terms' },
  ],
  notFoundHint: ASSET_HINT,
  async handler(args, { api }) {
    const needAsset = () => {
      if (!args.assetId) throw new ToolInputError(`${args.target} ${args.action} requires assetId.`);
      return `/api/portfolio/items/${args.assetId}`;
    };
    const needTerms = () => {
      if (!args.termsId) throw new ToolInputError(`${args.action} requires termsId.`);
      return `/api/portfolio/income-terms/${args.termsId}`;
    };

    if (args.target === 'debt') {
      if (args.action !== 'set') throw new ToolInputError('target "debt" only supports action "set".');
      const base = needAsset();
      const body = {
        initialBalance: args.initialBalance, interestRate: args.interestRate,
        termInMonths: args.termInMonths, originationDate: args.originationDate,
      };
      if (Object.values(body).some((v) => v == null)) {
        throw new ToolInputError('debt set requires initialBalance, interestRate, termInMonths and originationDate.');
      }
      try {
        const updated = await api.put(`${base}/debt-terms`, body);
        return { debtTerms: { id: updated.id, created: false } };
      } catch (err) {
        if (!(err instanceof LoopbackError && err.status === 404)) throw err;
        // No terms yet (or a foreign asset — POST checks ownership and 404s again).
        const created = await api.post(`${base}/debt-terms`, body);
        return { debtTerms: { id: created.id, created: true } };
      }
    }

    switch (args.action) {
      case 'set': {
        const base = needAsset();
        if (!args.terms) throw new ToolInputError('income set requires terms.');
        const data = await api.put(`${base}/income-terms`, { ...args.terms, applyToSymbol: args.applyToSymbol === true });
        return { assetId: args.assetId, terms: data.terms ?? null, appliedTo: data.appliedTo ?? [args.assetId] };
      }
      case 'delete': {
        const base = needAsset();
        const data = await api.del(`${base}/income-terms`, { applyToSymbol: args.applyToSymbol ? 'true' : undefined });
        return { assetId: args.assetId, deleted: data?.deleted ?? 1 };
      }
      case 'attach': {
        const path = needTerms();
        if (!args.assetId) throw new ToolInputError('attach requires assetId.');
        const data = await notFoundAs(api.post(`${path}/attach`, { assetId: args.assetId }), `${DETACHED_HINT} ${ASSET_HINT}`);
        return { attached: data.terms?.id ?? args.termsId, assetId: args.assetId };
      }
      case 'deleteDetached': {
        await notFoundAs(api.del(needTerms()), DETACHED_HINT);
        return { deleted: args.termsId };
      }
      default:
        throw new ToolNotFoundError(`action ${args.action}`);
    }
  },
});

const managePassiveIncomeStreams = defineTool({
  name: 'manage_passive_income_streams',
  access: 'write',
  destructive: true,
  title: 'Create, update or delete an income stream',
  description:
    'Income streams are recurring fixed amounts not produced by a holding (allowance, pension, government '
    + 'benefit). create: categoryId (one of eligibleStreamCategories from get_passive_income), name, '
    + 'amountPerPayment, frequency, currency and startDate. update: streamId plus fields to change. delete: streamId.',
  input: {
    action: z.enum(['create', 'update', 'delete']),
    streamId: intId('Stream ID from get_passive_income.').optional(),
    categoryId: intId('Eligible Passive Income category.').optional(),
    name: z.string().min(1).max(100).optional(),
    amountPerPayment: z.number().positive().optional(),
    frequency: z.enum(INCOME_FREQUENCIES.filter((f) => f !== 'AT_MATURITY')).optional(),
    currency: currencyCode.optional(),
    startDate: dateString('First payment').optional(),
    endDate: dateString('Last payment').nullable().optional(),
    anchorPaymentDate: dateString('A known payment date').optional(),
    annualIndexationPct: z.number().optional(),
  },
  wraps: [
    { method: 'POST', route: '/api/passive-income/streams' },
    { method: 'PUT', route: '/api/passive-income/streams/[id]' },
    { method: 'DELETE', route: '/api/passive-income/streams/[id]' },
    { method: 'GET', route: '/api/passive-income/streams' },
  ],
  notFoundHint: 'Use get_passive_income to find stream IDs.',
  async handler(args, { api }) {
    const FIELDS = ['categoryId', 'name', 'amountPerPayment', 'frequency', 'currency', 'startDate', 'endDate', 'anchorPaymentDate', 'annualIndexationPct'];
    const given = Object.fromEntries(FIELDS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
    const shape = (s) => ({
      streamId: s.id, name: s.name, category: s.categoryName, amountPerPayment: money(s.amountPerPayment, s.currency),
      frequency: s.frequency, startDate: isoDate(s.startDate), endDate: isoDate(s.endDate),
    });

    if (args.action === 'create') {
      return { created: shape(await api.post('/api/passive-income/streams', { incomeType: 'FIXED_AMOUNT', ...given })) };
    }
    if (!args.streamId) throw new ToolInputError(`${args.action} requires streamId.`);
    if (args.action === 'delete') {
      await api.del(`/api/passive-income/streams/${args.streamId}`);
      return { deleted: args.streamId };
    }
    // PUT replaces every field: merge onto the current stream.
    const { streams = [] } = await api.get('/api/passive-income/streams');
    const current = streams.find((s) => s.id === args.streamId);
    if (!current) throw new ToolNotFoundError(`income stream ${args.streamId}`);
    const merged = { ...Object.fromEntries(FIELDS.map((k) => [k, current[k]])), ...given, incomeType: 'FIXED_AMOUNT' };
    return { updated: shape(await api.put(`/api/passive-income/streams/${args.streamId}`, merged)) };
  },
});

const TOOLS = [
  getPortfolioHoldings, getPortfolioHistory, getEquityAnalysis, getPassiveIncome, getHoldingDetails,
  setAssetClass, manageManualValues, manageIncomeAndDebtTerms, managePassiveIncomeStreams,
];

export default TOOLS;

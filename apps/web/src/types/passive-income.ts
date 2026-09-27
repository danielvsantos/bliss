// Passive Income Projection (#77) — API response types.
// Rates on IncomeTerms (couponRate, spread, assumedIndexRate, yieldPct, apyPct,
// annualIndexationPct) are PERCENTAGES (5.25 = 5.25%). Yields in projection
// output (rateOrYield, yieldOnValue) are FRACTIONS (0.0525).

export type IncomeType =
  | 'DIVIDEND'
  | 'FIXED_COUPON'
  | 'FLOATING_COUPON'
  | 'INFLATION_LINKED'
  | 'RENT'
  | 'INTEREST'
  | 'CUSTOM_YIELD'
  | 'FIXED_AMOUNT'
  | 'NONE';

export type IncomeFrequency = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL' | 'AT_MATURITY';

/** Derived label for automatic dividends (plus the stored frequencies). */
export type DisplayFrequency = IncomeFrequency | 'IRREGULAR' | 'NONE';

export type IncomeAssetClass = 'STOCK' | 'ETF' | 'FUND' | 'BOND' | 'REAL_ESTATE' | 'CASH' | 'OTHER';

export type ReferenceIndex = 'SOFR' | 'EURIBOR' | 'CDI' | 'SELIC' | 'IPCA' | 'CPI' | 'OTHER';

export type BondIssuerType = 'GOVERNMENT' | 'CORPORATE';

export interface IncomeTerms {
  id: number;
  tenantId?: string;
  assetId: number | null;
  categoryId: number | null;
  name: string | null;
  orphanedAt: string | null;
  orphanedLabel: string | null;
  incomeType: IncomeType;
  frequency: IncomeFrequency | null;
  currency: string | null;
  anchorPaymentDate: string | null;
  startDate: string | null;
  endDate: string | null;
  isDistributing: boolean;
  amountPerPayment: number | null;
  dividendPerUnit: number | null;
  yieldPct: number | null;
  issuerType: BondIssuerType | null;
  faceValuePerUnit: number | null;
  couponRate: number | null;
  referenceIndex: ReferenceIndex | null;
  spread: number | null;
  assumedIndexRate: number | null;
  maturityDate: string | null;
  monthlyRent: number | null;
  leaseEndDate: string | null;
  annualIndexationPct: number | null;
  apyPct: number | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Body for PUT /api/portfolio/items/:id/income-terms and stream POST/PUT. */
export type IncomeTermsRequest = Partial<Omit<IncomeTerms, 'id' | 'tenantId' | 'assetId' | 'orphanedAt' | 'orphanedLabel'>> & {
  incomeType: IncomeType;
  applyToSymbol?: boolean;
};

export interface AutoDividendInfo {
  trusted: boolean;
  currency: string | null;
  recentDividends: { exDate: string; amount: number }[];
  frequency: DisplayFrequency;
  annualDividend: number | null;
  dividendYield: number | null;
  lastUpdated: string | null;
}

export type IncomeDataSource = 'AUTO' | 'OVERRIDE' | 'MANUAL' | 'MISSING';

/** Another holding of the same symbol and asset class (this one included) — group editing (#83). */
export interface IncomeTermsSibling {
  assetId: number;
  accountName: string | null;
  currency: string;
  quantity: number;
  costBasis: number | null;
  terms: IncomeTerms | null;
  source: IncomeDataSource;
}

export interface AssetIncomeTermsResponse {
  asset: {
    id: number;
    symbol: string;
    currency: string;
    quantity: number;
    costBasis?: number | null;
    categoryName: string;
    assetClass: IncomeAssetClass | null;
    defaultIncomeType: IncomeType | null;
  };
  terms: IncomeTerms | null;
  auto: AutoDividendInfo | null;
  /** Absent from pre-#83 APIs. */
  siblings?: IncomeTermsSibling[];
}

export interface IncomeStream extends IncomeTerms {
  categoryName?: string;
  categoryCode?: string | null;
}

export interface StreamCategory {
  id: number;
  name: string;
  defaultCategoryCode: string | null;
}

export interface IncomeStreamsResponse {
  streams: IncomeStream[];
  eligibleCategories: StreamCategory[];
}

export type IncomeSourceBucket = 'dividend' | 'coupon' | 'rent' | 'interest' | 'other';

export interface IncomeBuckets {
  dividend: number;
  coupon: number;
  rent: number;
  interest: number;
  other: number;
  total: number;
}

export type PassiveIncomeItemStatus = 'OK' | 'MATURED_UNREDEEMED' | 'ENDED' | 'STALE_RATE';

export interface PassiveIncomeItem {
  kind: 'ASSET' | 'STREAM';
  portfolioItemId: number | null;
  streamId: number | null;
  incomeTermsId: number | null;
  label: string;
  symbol: string | null;
  assetClass: IncomeAssetClass | null;
  categoryName?: string | null;
  /** #83 — per-holding fields for the grouped view (null for streams). */
  securityName?: string | null;
  accountId?: number | null;
  accountName?: string | null;
  quantity?: number | null;
  currentValue?: number | null;
  currency?: string | null;
  incomeType: IncomeType;
  source: IncomeDataSource;
  rateOrYield: number | null;
  amountPerPayment: number | null;
  frequency: DisplayFrequency | null;
  nextPaymentDate: string | null;
  endDate: string | null;
  status: PassiveIncomeItemStatus;
  horizonTotal: number;
  next12mTotal: number;
}

/** One breakdown row per symbol (securities) or cash currency, across accounts (#83). */
export interface PassiveIncomeGroup {
  groupKey: string;
  kind: 'SECURITY' | 'CASH';
  label: string;
  symbol: string | null;
  assetClass: IncomeAssetClass;
  accountCount: number;
  portfolioItemIds: number[];
  quantity: number;
  currentValue: number;
  currency: string | 'MIXED' | null;
  incomeType: IncomeType | 'MIXED';
  source: IncomeDataSource | 'MIXED';
  frequency: DisplayFrequency | 'MIXED' | null;
  rateOrYield: number | null;
  rateRange: [number, number] | null;
  amountPerPayment: number | null;
  nextPaymentDate: string | null;
  endDate: string | null;
  status: PassiveIncomeItemStatus;
  statusCount: number;
  configured: boolean;
  inCoverage: boolean;
  horizonTotal: number;
  next12mTotal: number;
  children: PassiveIncomeItem[];
}

export interface UpcomingPayment {
  date: string;
  kind: 'ASSET' | 'STREAM';
  refId: number;
  label: string;
  amount: number;
  source: IncomeSourceBucket;
}

/** Upcoming payments merged per symbol + date + source (#83). */
export interface UpcomingPaymentGrouped {
  date: string;
  kind: 'ASSET' | 'STREAM';
  groupKey: string | null;
  refId: number | null;
  refIds: number[];
  label: string;
  amount: number;
  source: IncomeSourceBucket;
  accounts: string[];
}

export interface MissingIncomeGroup {
  groupKey: string;
  symbol: string;
  label: string;
  assetClass: IncomeAssetClass;
  portfolioItemIds: number[];
  reason: 'NO_TERMS' | 'UNTRUSTED_DIVIDEND';
}

export type BreakdownView = 'grouped' | 'flat';

export interface DetachedIncomeTerms {
  id: number;
  orphanedLabel: string | null;
  orphanedAt: string;
  incomeType: IncomeType;
  frequency: IncomeFrequency | null;
  currency: string | null;
  maturityDate: string | null;
  couponRate: number | null;
  monthlyRent: number | null;
  dividendPerUnit: number | null;
  apyPct: number | null;
}

export interface PassiveIncomeResponse {
  displayCurrency: string;
  asOf: string;
  horizon: 12 | 24 | 36;
  kpis: {
    next12mIncome: number;
    next12mInvestmentIncome: number;
    next12mOtherIncome: number;
    monthlyAverage: number;
    yieldOnValue: number | null;
    essentialsCoveragePct: number | null;
    trailingEssentials: number;
    /** Counts holding groups (#83). */
    coverage: { configured: number; total: number };
    /** Counts individual holdings (pre-#83 meaning). */
    coverageByHolding?: { configured: number; total: number };
  };
  actuals: { month: string; total: number }[];
  projected: (IncomeBuckets & { month: string })[];
  yearly: (IncomeBuckets & { year: number })[];
  items: PassiveIncomeItem[];
  /** #83 — absent from older APIs (the page then falls back to the flat view). */
  groups?: PassiveIncomeGroup[];
  upcomingPayments: UpcomingPayment[];
  upcomingPaymentsGrouped?: UpcomingPaymentGrouped[];
  maturityLadder: { year: number; principal: number; items: number[] }[];
  detached: DetachedIncomeTerms[];
  missing: {
    portfolioItemId: number;
    symbol: string;
    label: string;
    assetClass: IncomeAssetClass;
    reason: 'NO_TERMS' | 'UNTRUSTED_DIVIDEND';
    accountName?: string | null;
  }[];
  missingGroups?: MissingIncomeGroup[];
}

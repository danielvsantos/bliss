import type { CopyTradeStatus } from './api';

/** Asset classes from `@bliss/shared/portfolio` (Equity Analysis #79). */
export const ASSET_CLASSES = [
  'STOCK',
  'INDEX_ETF',
  'SECTOR_ETF',
  'BOND_ETF',
  'REIT',
  'FUND',
  'GOV_BOND',
  'CORP_BOND',
  'REAL_ESTATE',
  'CRYPTO',
  'CASH',
  'OTHER',
  // eToro copy trades (#143). Last, so the other classes keep their colors.
  'COPY_TRADE',
] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

/** Classes a user can pick as an override: COPY_TRADE is automatic for linked eToro copies only. */
export const OVERRIDE_ASSET_CLASSES = ASSET_CLASSES.filter((c) => c !== 'COPY_TRADE');

export type EquityGroupBy = 'sector' | 'industry' | 'country' | 'assetClass';

/** ETF composition (fractions), from SecurityMaster.etfComposition. */
export interface EtfComposition {
  sectors: Array<{ sector: string; weight: number }>;
  countries: Array<{ country: string; weight: number }>;
  assetAllocation: Record<string, number>;
}

export interface EquityHolding {
  symbol: string;
  name: string;
  /**
   * 'ETF' holdings are bucketed as "Diversified" and never carry P/E or EPS; 'COPY_TRADE' is an eToro
   * copy kept whole (#143); 'OTHER' is crypto, cash or an unidentified position held through a copy.
   */
  assetType?: 'STOCK' | 'ETF' | 'COPY_TRADE' | 'OTHER';
  assetClass?: AssetClass;
  assetClassSource?: 'OVERRIDE' | 'AUTO';
  /** What the classifier picks without the override. */
  autoAssetClass?: AssetClass;
  /** Portfolio item ids merged into this row (same symbol across accounts). */
  itemIds?: number[];
  composition?: EtfComposition | null;
  /** null for a position held through an eToro copy. */
  quantity: number | null;
  /** Unique row key of a position held through a copy (its itemIds are empty). */
  key?: string;
  /**
   * The eToro copies that hold part of this row when looking through (#143), with the value each
   * holds. A row with no `itemIds` is held only through copies; otherwise the copies' share is
   * added to the security held directly.
   */
  viaCopies?: Array<{
    username: string;
    kind: 'SECURITY' | 'INSTRUMENT' | 'CASH' | 'UNMAPPED';
    itemIds: number[];
    currentValue: number;
  }> | null;
  currentValue: number;
  currentValueUSD: number;
  sector: string;
  industry: string;
  country: string;
  peRatio: number | null;
  dividendYield: number | null;
  trailingEps: number | null;
  latestEpsActual: number | null;
  latestEpsSurprise: number | null;
  week52High: number | null;
  week52Low: number | null;
  averageVolume: number | null;
  logoUrl: string | null;
  weight: number;
  // ── eToro copy trades only (#143) ──
  /** Share of the copy's value (0–100) its P/E / dividend yield are based on. */
  peCoverage?: number | null;
  yieldCoverage?: number | null;
  sectorCoveragePct?: number | null;
  countryCoveragePct?: number | null;
  /** Share of the copy's value in instruments Bliss can't map (0–100). */
  unmappedPct?: number | null;
  assetClassMix?: Array<{ assetClass: AssetClass; weight: number }> | null;
  copyTrade?: CopyTradeStatus;
}

export interface EquityGroup {
  name: string;
  totalValue: number;
  weight: number;
  holdingsCount: number;
  holdings: EquityHolding[];
}

export interface EquityAnalysisSummary {
  totalEquityValue: number;
  holdingsCount: number;
  weightedPeRatio: number | null;
  weightedDividendYield: number | null;
  /** Funds left out until their security data is fetched (#93). */
  pendingSecurityDataCount?: number;
  /** eToro copy trades among the holdings (#143). */
  copyTradeCount?: number;
}

export interface EquityAnalysisResponse {
  portfolioCurrency: string;
  lookThrough?: boolean;
  /** Whether any ETF has composition data; the look-through switch is hidden otherwise. */
  lookThroughAvailable?: boolean;
  summary: EquityAnalysisSummary;
  /** Groups for the requested groupBy. */
  groups: EquityGroup[];
  /** Groups for every dimension (#79). With look-through an ETF can sit in several groups. */
  groupings?: Partial<Record<EquityGroupBy, EquityGroup[]>>;
  /** Every holding once (#79) — render rows from this, not from the groups. */
  holdings?: EquityHolding[];
  /** Every eToro copy as one row (#143), also when `holdings` shows its positions instead. */
  copies?: EquityHolding[];
  /** Fund symbols left out until their SecurityMaster data arrives (#93). */
  pendingSecurityData?: string[];
}

export interface SetAssetClassResponse {
  assetClass: AssetClass;
  assetClassSource: 'OVERRIDE' | 'AUTO';
  autoAssetClass: AssetClass;
  updatedCount: number;
}

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
] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

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
  /** 'ETF' holdings are bucketed as "Diversified" and never carry P/E or EPS. */
  assetType?: 'STOCK' | 'ETF';
  assetClass?: AssetClass;
  assetClassSource?: 'OVERRIDE' | 'AUTO';
  /** What the classifier picks without the override. */
  autoAssetClass?: AssetClass;
  /** Portfolio item ids merged into this row (same symbol across accounts). */
  itemIds?: number[];
  composition?: EtfComposition | null;
  quantity: number;
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
  /** Fund symbols left out until their SecurityMaster data arrives (#93). */
  pendingSecurityData?: string[];
}

export interface SetAssetClassResponse {
  assetClass: AssetClass;
  assetClassSource: 'OVERRIDE' | 'AUTO';
  autoAssetClass: AssetClass;
  updatedCount: number;
}

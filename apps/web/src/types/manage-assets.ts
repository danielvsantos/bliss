import type { AssetClass } from './equity-analysis';

/** Manage Assets (#81) — one row of `GET /api/portfolio/assets`. */
export interface ManagedAsset {
  id: number;
  symbol: string;
  /** SecurityMaster name for listed securities, otherwise the symbol. */
  displayName: string;
  categoryName: string | null;
  /** Category.type: 'Investments' | 'Asset' | 'Debt' */
  categoryType: string | null;
  group: string | null;
  processingHint: string | null;
  accountId: number | null;
  accountName: string | null;
  currency: string;
  /** Decimal as string */
  quantity: string;
  /** Stored value in the item's currency (Decimal as string). */
  currentValue: string | null;
  /** Stored value in the tenant's portfolio currency. */
  currentValueInDisplay: number | null;
  lastManualValueDate: string | null;
  assetClass: AssetClass;
  assetClassSource: 'AUTO' | 'OVERRIDE';
  /** Passive income class; null when the asset can't hold income terms. */
  incomeAssetClass: string | null;
  hasLotMismatch: boolean;
  hasIncomeTerms: boolean;
  hasDividendOverride: boolean;
  hasDebtTerms: boolean;
  isPriceStale: boolean;
  incomeDataStatus: 'AUTO' | 'OVERRIDE' | 'MANUAL' | 'MISSING' | 'NONE' | 'NOT_APPLICABLE';
}

export const ASSET_STATUS_FILTERS = [
  'stale',
  'incomeMissing',
  'dividendOverride',
  'lotMismatch',
  'assetClassOverridden',
] as const;

export type AssetStatusFilter = (typeof ASSET_STATUS_FILTERS)[number];

export interface ManageAssetsFilters {
  type?: string;
  accountId?: number;
  assetClass?: AssetClass;
  search?: string;
  status?: AssetStatusFilter;
  includeClosed?: boolean;
}

export interface ManageAssetsResponse {
  portfolioCurrency: string;
  items: ManagedAsset[];
  nextCursor: string | null;
  totals: { count: number };
  detachedTermsCount: number;
  /** First page only. */
  facets?: {
    groups: Array<{ group: string; count: number }>;
    accounts: Array<{ id: number; name: string }>;
  };
}

export interface AssetClassInfo {
  assetClass: AssetClass;
  assetClassSource: 'AUTO' | 'OVERRIDE';
  autoAssetClass: AssetClass;
}

/** Modals the page opens via `?item=<id>&modal=<name>`. */
export const ASSET_MODALS = ['income', 'price', 'history', 'debt', 'assetClass'] as const;
export type AssetModal = (typeof ASSET_MODALS)[number];

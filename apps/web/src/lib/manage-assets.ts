import type { AssetModal, ManagedAsset } from '@/types/manage-assets';
import { ASSET_MODALS } from '@/types/manage-assets';

/**
 * Manage Assets (#81) client helpers.
 *
 * Stale-price thresholds mirror MANUAL_PRICE_* in @bliss/shared/portfolio
 * (the API flags `isPriceStale` with the same 30-day rule).
 */
export const MANUAL_PRICE_STALE_DAYS = 30;
export const MANUAL_PRICE_WARNING_DAYS = 60;
export const MANUAL_PRICE_CRITICAL_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type Urgency = 'critical' | 'warning' | 'stale';

/** Whole days since the last manual value, or null when there is none. */
export function daysSince(date: string | null | undefined, now: Date = new Date()): number | null {
  if (!date) return null;
  return Math.floor((now.getTime() - new Date(date).getTime()) / MS_PER_DAY);
}

/** Urgency of a stale manual price; no value at all counts as critical. */
export function priceUrgency(days: number | null): Urgency {
  if (days == null || days >= MANUAL_PRICE_CRITICAL_DAYS) return 'critical';
  if (days >= MANUAL_PRICE_WARNING_DAYS) return 'warning';
  return 'stale';
}

export const URGENCY_CLASSES: Record<Urgency, string> = {
  critical: 'bg-destructive/10 text-destructive border-destructive/20',
  warning: 'bg-warning/10 text-warning border-warning/20',
  stale: 'bg-brand-primary/10 text-brand-primary border-brand-primary/20',
};

export function isAssetModal(value: string | null): value is AssetModal {
  return value != null && (ASSET_MODALS as readonly string[]).includes(value);
}

/** Which modals apply to a row, in overflow-menu order. */
export function availableModals(asset: ManagedAsset): AssetModal[] {
  const out: AssetModal[] = [];
  const isDebt = asset.categoryType === 'Debt';
  if (asset.processingHint === 'MANUAL' && !isDebt) out.push('price', 'history');
  if (isDebt) out.push('debt');
  if (asset.incomeAssetClass) out.push('income');
  if (!isDebt) out.push('assetClass');
  return out;
}

/** Dialog content classes that turn a modal into a full-screen sheet below `sm`. */
export const MOBILE_SHEET_CLASSES =
  'max-sm:max-w-none max-sm:w-screen max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:rounded-none max-sm:border-0 max-sm:p-4 max-sm:overflow-y-auto';

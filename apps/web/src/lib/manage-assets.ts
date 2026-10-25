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

/**
 * The one modal that fixes a row's most urgent problem, shown as a visible
 * button (the ⋯ menu keeps the rest). Null when there is nothing to fix from
 * this page (a lot mismatch needs the missing transactions, not a modal).
 */
export function primaryAction(asset: ManagedAsset): AssetModal | null {
  if (asset.isPriceStale && asset.processingHint === 'MANUAL') return 'price';
  if (asset.debtTermsMissing) return 'debt';
  if (asset.incomeDataStatus === 'MISSING' && asset.incomeAssetClass) return 'income';
  return null;
}

/** Holdings in the Funds group, where copies are recorded today (#143); the server accepts any investment. */
export function canSwitchToCopyTrading(asset: Pick<ManagedAsset, 'categoryType' | 'processingHint' | 'group'>): boolean {
  return asset.categoryType === 'Investments' && asset.processingHint !== 'COPY_TRADING' && asset.group === 'Funds';
}

/** Which modals apply to a row, in overflow-menu order. */
export function availableModals(asset: ManagedAsset): AssetModal[] {
  const out: AssetModal[] = [];
  const isDebt = asset.categoryType === 'Debt';
  if (asset.processingHint === 'MANUAL' && !isDebt) out.push('price', 'history');
  if (isDebt) out.push('debt');
  if (asset.incomeAssetClass) out.push('income');
  if (!isDebt) out.push('assetClass');
  // eToro copy trading (#143): a copy recorded as a Fund can be switched to
  // Copy Trading in place.
  if (canSwitchToCopyTrading(asset)) out.push('copyTrading');
  return out;
}

/**
 * Dialog content classes that turn a modal into a full-screen sheet below `sm`.
 * Sized to the visible area (--vv-height, lib/pwa/visual-viewport.ts) rather
 * than 100dvh, which in the installed iOS app excludes the status bar and
 * ignores the keyboard; padded clear of the notch and home indicator (#155).
 */
export const MOBILE_SHEET_CLASSES =
  'max-sm:max-w-none max-sm:w-screen max-sm:h-[var(--vv-height,100dvh)] max-sm:max-h-[var(--vv-height,100dvh)] max-sm:rounded-none max-sm:border-0 max-sm:px-4 max-sm:pt-[calc(1rem+env(safe-area-inset-top))] max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))] max-sm:[&>button:last-child]:top-[calc(1rem+env(safe-area-inset-top))] max-sm:overflow-y-auto';

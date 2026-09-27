import { describe, it, expect } from 'vitest';
import {
  availableModals,
  daysSince,
  isAssetModal,
  priceUrgency,
  MANUAL_PRICE_STALE_DAYS,
  MANUAL_PRICE_WARNING_DAYS,
  MANUAL_PRICE_CRITICAL_DAYS,
} from './manage-assets';
import type { ManagedAsset } from '@/types/manage-assets';

const asset = (over: Partial<ManagedAsset>) => ({ categoryType: 'Investments', processingHint: 'API_STOCK', incomeAssetClass: 'STOCK', ...over }) as ManagedAsset;

describe('manage-assets helpers', () => {
  it('keeps the thresholds of the old Asset Price Updates page', () => {
    expect([MANUAL_PRICE_STALE_DAYS, MANUAL_PRICE_WARNING_DAYS, MANUAL_PRICE_CRITICAL_DAYS]).toEqual([30, 60, 90]);
  });

  it('daysSince counts whole days, null without a date', () => {
    const now = new Date('2026-09-27T12:00:00Z');
    expect(daysSince('2026-09-20T12:00:00Z', now)).toBe(7);
    expect(daysSince('2026-09-27T00:00:00Z', now)).toBe(0);
    expect(daysSince(null, now)).toBeNull();
  });

  it('priceUrgency: stale < 60 ≤ warning < 90 ≤ critical; no value is critical', () => {
    expect(priceUrgency(31)).toBe('stale');
    expect(priceUrgency(60)).toBe('warning');
    expect(priceUrgency(89)).toBe('warning');
    expect(priceUrgency(90)).toBe('critical');
    expect(priceUrgency(null)).toBe('critical');
  });

  it('isAssetModal accepts only known modal names', () => {
    expect(isAssetModal('debt')).toBe(true);
    expect(isAssetModal('assetClass')).toBe(true);
    expect(isAssetModal('nope')).toBe(false);
    expect(isAssetModal(null)).toBe(false);
  });

  it('availableModals follows the asset type', () => {
    expect(availableModals(asset({}))).toEqual(['income', 'assetClass']);
    expect(availableModals(asset({ processingHint: 'MANUAL', incomeAssetClass: 'REAL_ESTATE' })))
      .toEqual(['price', 'history', 'income', 'assetClass']);
    expect(availableModals(asset({ processingHint: 'API_CRYPTO', incomeAssetClass: null }))).toEqual(['assetClass']);
    expect(availableModals(asset({ categoryType: 'Debt', processingHint: 'AMORTIZING_LOAN', incomeAssetClass: null }))).toEqual(['debt']);
  });
});

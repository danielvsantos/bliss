import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { daysSince, priceUrgency, URGENCY_CLASSES } from '@/lib/manage-assets';
import type { ManagedAsset } from '@/types/manage-assets';

const CHIP = 'text-[0.6875rem] whitespace-nowrap border';
const ACTION = `${CHIP} font-semibold`;
const WARNING = 'bg-warning/10 text-warning border-warning/20';
/** Informational tags: a user choice, nothing to fix — deliberately quiet. */
const INFO = `${CHIP} font-medium bg-muted text-muted-foreground border-gray-200`;

/**
 * Status chips for one row. Problems that need action use warning / critical
 * tokens; informational tags (dividend override, asset class override) are
 * muted so they never compete with the problems. Renders nothing when clean.
 */
export function AssetStatusChips({ asset, now }: { asset: ManagedAsset; now?: Date }) {
  const { t } = useTranslation();
  const chips: Array<{ key: string; label: string; className: string }> = [];

  if (asset.isPriceStale) {
    const days = daysSince(asset.lastManualValueDate, now);
    const urgency = priceUrgency(days);
    chips.push({
      key: 'stale',
      label: days == null
        ? t('manageAssets.chips.noPrice')
        : `${t('manualUpdates.dOld', { count: days })} · ${t(`manualUpdates.urgency.${urgency}`)}`,
      className: `${ACTION} ${URGENCY_CLASSES[urgency]}`,
    });
  }
  if (asset.debtTermsMissing) {
    chips.push({ key: 'debtTermsMissing', label: t('manageAssets.status.debtTermsMissing'), className: `${ACTION} ${WARNING}` });
  }
  if (asset.incomeDataStatus === 'MISSING') {
    chips.push({ key: 'incomeMissing', label: t('manageAssets.status.incomeMissing'), className: `${ACTION} ${WARNING}` });
  }
  if (asset.hasLotMismatch) {
    chips.push({ key: 'lotMismatch', label: t('manageAssets.status.lotMismatch'), className: `${ACTION} ${WARNING}` });
  }
  if (asset.hasDividendOverride) {
    chips.push({ key: 'dividendOverride', label: t('manageAssets.status.dividendOverride'), className: INFO });
  }
  if (asset.assetClassSource === 'OVERRIDE') {
    chips.push({ key: 'assetClassOverridden', label: t('manageAssets.status.assetClassOverridden'), className: INFO });
  }

  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid={`status-chips-${asset.id}`}>
      {chips.map((c) => (
        <Badge key={c.key} className={c.className} data-testid={`chip-${c.key}-${asset.id}`}>
          {c.label}
        </Badge>
      ))}
    </div>
  );
}

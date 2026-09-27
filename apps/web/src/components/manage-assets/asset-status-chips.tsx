import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { daysSince, priceUrgency, URGENCY_CLASSES } from '@/lib/manage-assets';
import type { ManagedAsset } from '@/types/manage-assets';

const CHIP = 'text-[0.6875rem] font-semibold whitespace-nowrap border';
const WARNING = 'bg-warning/10 text-warning border-warning/20';
const BRAND = 'bg-brand-primary/10 text-brand-primary border-brand-primary/20';

/** Status chips for one row (R2.3). Renders nothing when the row is clean. */
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
      className: URGENCY_CLASSES[urgency],
    });
  }
  if (asset.incomeDataStatus === 'MISSING') {
    chips.push({ key: 'incomeMissing', label: t('manageAssets.status.incomeMissing'), className: WARNING });
  }
  if (asset.hasDividendOverride) {
    chips.push({ key: 'dividendOverride', label: t('manageAssets.status.dividendOverride'), className: BRAND });
  }
  if (asset.hasLotMismatch) {
    chips.push({ key: 'lotMismatch', label: t('manageAssets.status.lotMismatch'), className: WARNING });
  }
  if (asset.assetClassSource === 'OVERRIDE') {
    chips.push({ key: 'assetClassOverridden', label: t('manageAssets.status.assetClassOverridden'), className: BRAND });
  }

  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid={`status-chips-${asset.id}`}>
      {chips.map((c) => (
        <Badge key={c.key} className={`${CHIP} ${c.className}`} data-testid={`chip-${c.key}-${asset.id}`}>
          {c.label}
        </Badge>
      ))}
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { Coins, FileText, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { primaryAction } from '@/lib/manage-assets';
import type { AssetModal, ManagedAsset } from '@/types/manage-assets';

const LABELS: Partial<Record<AssetModal, string>> = {
  price: 'manageAssets.actions.price',
  debt: 'manageAssets.actions.addDebtTerms',
  income: 'manageAssets.actions.addIncomeTerms',
};
const ICONS: Partial<Record<AssetModal, typeof Pencil>> = { price: Pencil, debt: FileText, income: Coins };

/** The visible fix for a row's most urgent problem; nothing when there's none. */
export function PrimaryActionButton({
  asset,
  onOpen,
  className,
}: {
  asset: ManagedAsset;
  onOpen: (modal: AssetModal) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const action = primaryAction(asset);
  if (!action) return null;
  const Icon = ICONS[action] ?? Pencil;
  return (
    <Button
      size="sm"
      className={`h-8 gap-1.5 text-xs ${className ?? ''}`}
      onClick={() => onOpen(action)}
      data-testid={`primary-action-${asset.id}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {t(LABELS[action] as string)}
    </Button>
  );
}

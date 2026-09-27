import { useTranslation } from 'react-i18next';
import { Coins, FileText, History, MoreHorizontal, Pencil, Shapes } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { availableModals } from '@/lib/manage-assets';
import type { AssetModal, ManagedAsset } from '@/types/manage-assets';

const ICONS: Record<AssetModal, typeof Pencil> = {
  price: Pencil,
  history: History,
  debt: FileText,
  income: Coins,
  assetClass: Shapes,
};

/** Row actions in an overflow menu (desktop rows and mobile cards). */
export function AssetActionsMenu({ asset, onOpen }: { asset: ManagedAsset; onOpen: (modal: AssetModal) => void }) {
  const { t } = useTranslation();
  const modals = availableModals(asset);

  const label = (m: AssetModal) => {
    if (m === 'debt') return asset.hasDebtTerms ? t('manualUpdates.editTerms') : t('manualUpdates.addTerms');
    if (m === 'income') return asset.hasIncomeTerms ? t('incomeTerms.actionConfigured') : t('incomeTerms.action');
    return t(`manageAssets.actions.${m}`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t('manageAssets.actions.menu', { symbol: asset.symbol })}
          data-testid={`asset-actions-${asset.id}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {modals.map((m) => {
          const Icon = ICONS[m];
          return (
            <DropdownMenuItem key={m} onSelect={() => onOpen(m)} data-testid={`action-${m}-${asset.id}`}>
              <Icon className="mr-2 h-4 w-4" />
              {label(m)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

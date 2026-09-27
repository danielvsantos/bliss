import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { DebtTermsForm } from '@/components/entities/debt-terms-form';
import { useDebtTerms } from '@/hooks/use-manage-assets';
import { MOBILE_SHEET_CLASSES } from '@/lib/manage-assets';
import type { AssetRef } from '@/types/api';

interface DebtTermsModalProps {
  asset: AssetRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Debt terms (Manage Assets #81). Loads the item's terms when it opens, then
 * renders the existing `DebtTermsForm` pre-filled with them.
 */
export function DebtTermsModal({ asset, open, onOpenChange }: DebtTermsModalProps) {
  const { t } = useTranslation();
  const { data: debtTerms, isLoading, isError } = useDebtTerms(open && asset ? asset.id : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={MOBILE_SHEET_CLASSES} data-testid="debt-terms-modal" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{`${t('manualUpdates.debtTermsDialog')} — ${asset?.symbol ?? ''}`}</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <div className="space-y-3" data-testid="debt-terms-loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {isError && <p className="text-sm text-destructive">{t('manageAssets.loadFailed')}</p>}
        {open && asset && !isLoading && !isError && (
          <DebtTermsForm
            key={debtTerms?.id ?? 'new'}
            asset={{ ...asset, debtTerms: debtTerms ?? undefined }}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

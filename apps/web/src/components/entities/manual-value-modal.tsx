import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ManualPriceForm } from '@/components/entities/manual-price-form';
import { MOBILE_SHEET_CLASSES } from '@/lib/manage-assets';
import type { AssetRef } from '@/types/api';

interface ManualValueModalProps {
  asset: AssetRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Record a manual price (Manage Assets #81). The same `ManualPriceForm` flow
 * as the old Asset Price Updates page; the form saves, invalidates the
 * portfolio queries and closes.
 */
export function ManualValueModal({ asset, open, onOpenChange }: ManualValueModalProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={MOBILE_SHEET_CLASSES} data-testid="manual-value-modal" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{`${t('manualUpdates.updatePriceDialog')} — ${asset?.symbol ?? ''}`}</DialogTitle>
        </DialogHeader>
        {open && asset && <ManualPriceForm asset={asset} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useSetAssetClass } from '@/hooks/use-equity-analysis';
import { useAssetClassInfo } from '@/hooks/use-manage-assets';
import { MOBILE_SHEET_CLASSES } from '@/lib/manage-assets';
import { ASSET_CLASSES, type AssetClass } from '@/types/equity-analysis';

const AUTO = 'AUTO';

interface AssetClassModalProps {
  asset: { id: number; symbol: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Asset class override (#79's select, Manage Assets #81). Loads the current
 * and automatic class when it opens. "Automatic" clears the override; any
 * class sets it on every holding of the symbol, as Equity Analysis does.
 */
export function AssetClassModal({ asset, open, onOpenChange }: AssetClassModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { data, isLoading, isError } = useAssetClassInfo(open && asset ? asset.id : null);
  const mutation = useSetAssetClass();
  const [value, setValue] = useState<string>(AUTO);

  useEffect(() => {
    if (data) setValue(data.assetClassSource === 'OVERRIDE' ? data.assetClass : AUTO);
  }, [data]);

  const save = () => {
    if (!asset) return;
    mutation.mutate(
      { portfolioItemId: asset.id, assetClass: value === AUTO ? null : (value as AssetClass) },
      {
        onSuccess: () => {
          toast({ title: t('equityAnalysis.overrideSaved') });
          onOpenChange(false);
        },
        onError: () => toast({ title: t('equityAnalysis.overrideFailed'), variant: 'destructive' }),
      },
    );
  };

  const selectId = `manage-asset-class-${asset?.id ?? 0}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`sm:max-w-md ${MOBILE_SHEET_CLASSES}`} data-testid="asset-class-modal">
        <DialogHeader>
          <DialogTitle>{t('equityAnalysis.editAssetClass', { symbol: asset?.symbol ?? '' })}</DialogTitle>
          <DialogDescription>{t('manageAssets.assetClassHint', { symbol: asset?.symbol ?? '' })}</DialogDescription>
        </DialogHeader>
        {isLoading && <Skeleton className="h-10 w-full" data-testid="asset-class-loading" />}
        {isError && <p className="text-sm text-destructive">{t('manageAssets.loadFailed')}</p>}
        {data && (
          <div className="space-y-2">
            <label className="block text-xs text-muted-foreground" htmlFor={selectId}>
              {t('equityAnalysis.assetClass')}
            </label>
            <select
              id={selectId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value={AUTO}>
                {t('equityAnalysis.automatic', { assetClass: t(`equityAnalysis.assetClasses.${data.autoAssetClass}`) })}
              </option>
              {ASSET_CLASSES.map((c) => (
                <option key={c} value={c}>{t(`equityAnalysis.assetClasses.${c}`)}</option>
              ))}
            </select>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('equityAnalysis.cancel')}
          </Button>
          <Button type="button" onClick={save} disabled={!data || mutation.isPending}>
            {t('equityAnalysis.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

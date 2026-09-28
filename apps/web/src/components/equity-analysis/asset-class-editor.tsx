import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { useIsMobile } from '@/hooks/use-mobile';
import { useToast } from '@/hooks/use-toast';
import { useSetAssetClass } from '@/hooks/use-equity-analysis';
import { ASSET_CLASSES, type AssetClass, type EquityHolding } from '@/types/equity-analysis';
import { ASSET_CLASS_COLORS } from './asset-class-colors';

const AUTO = 'AUTO';

interface AssetClassEditorProps {
  holding: EquityHolding;
}

/**
 * Asset class badge with an edit control (#79). Tap/click opens a popover
 * (bottom sheet on mobile) with the ETF's top sectors, when known, and a
 * select: "Automatic (<class>)" clears the override, any class sets it for
 * every holding of the symbol.
 */
export function AssetClassEditor({ holding }: AssetClassEditorProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (!holding.assetClass) return null;
  const label = t(`equityAnalysis.assetClasses.${holding.assetClass}`);
  const isOverride = holding.assetClassSource === 'OVERRIDE';

  const trigger = (
    <button
      type="button"
      aria-label={t('equityAnalysis.editAssetClass', { symbol: holding.symbol })}
      className="inline-flex items-center gap-1 rounded-full border border-brand-primary/20 bg-brand-primary/10 px-1.5 py-0 text-[10px] font-medium text-brand-primary hover:bg-brand-primary/20 whitespace-nowrap"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ASSET_CLASS_COLORS[holding.assetClass] }} />
      {label}
      {isOverride && <span title={t('equityAnalysis.overrideHint')}>*</span>}
      <Pencil className="h-2.5 w-2.5" aria-hidden />
    </button>
  );

  const body = <EditorBody holding={holding} onDone={() => setOpen(false)} />;
  const title = t('equityAnalysis.editAssetClass', { symbol: holding.symbol });

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>{holding.name}</DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-6">{body}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-72" align="start">
        <p className="mb-3 text-sm font-medium text-brand-deep">{title}</p>
        {body}
      </PopoverContent>
    </Popover>
  );
}

function EditorBody({ holding, onDone }: { holding: EquityHolding; onDone: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const mutation = useSetAssetClass();
  const [value, setValue] = useState<string>(
    holding.assetClassSource === 'OVERRIDE' && holding.assetClass ? holding.assetClass : AUTO,
  );
  const auto = holding.autoAssetClass ?? holding.assetClass;
  const topSectors = holding.composition?.sectors?.slice(0, 5) ?? [];
  const itemId = holding.itemIds?.[0];

  const save = () => {
    if (itemId == null) return;
    mutation.mutate(
      { portfolioItemId: itemId, assetClass: value === AUTO ? null : (value as AssetClass) },
      {
        onSuccess: () => {
          toast({ title: t('equityAnalysis.overrideSaved') });
          onDone();
        },
        onError: () => toast({ title: t('equityAnalysis.overrideFailed'), variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-3">
      {topSectors.length > 0 && (
        <div data-testid="etf-breakdown">
          <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{t('equityAnalysis.etfBreakdown')}</p>
          <ul className="space-y-0.5 text-xs">
            {topSectors.map((s) => (
              <li key={s.sector} className="flex justify-between gap-2">
                <span className="truncate">{s.sector}</span>
                <span className="tabular-nums text-muted-foreground">{(s.weight * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="block text-xs text-muted-foreground" htmlFor={`asset-class-${holding.symbol}`}>
        {t('equityAnalysis.assetClass')}
      </label>
      <select
        id={`asset-class-${holding.symbol}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      >
        <option value={AUTO}>
          {t('equityAnalysis.automatic', { assetClass: auto ? t(`equityAnalysis.assetClasses.${auto}`) : '—' })}
        </option>
        {ASSET_CLASSES.map((c) => (
          <option key={c} value={c}>{t(`equityAnalysis.assetClasses.${c}`)}</option>
        ))}
      </select>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {t('equityAnalysis.cancel')}
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={mutation.isPending || itemId == null}>
          {t('equityAnalysis.save')}
        </Button>
      </div>
    </div>
  );
}

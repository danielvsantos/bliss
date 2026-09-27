import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DetachedTermsSection } from '@/components/passive-income/detached-terms';
import { useDetachedIncomeTerms } from '@/hooks/use-passive-income';

/**
 * Detached income terms banner (Manage Assets #81, R2.4). The list response
 * carries only the count; the terms themselves load when the user opens the
 * banner, and re-attach / discard reuse the Passive Income section.
 */
export function DetachedTermsBanner({ count }: { count: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useDetachedIncomeTerms(open && count > 0);

  if (count <= 0) return null;

  return (
    <div className="space-y-3" data-testid="detached-terms-banner">
      <div className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 min-w-0">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning mt-0.5" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-brand-deep">{t('manageAssets.detached.title', { count })}</p>
            <p className="text-xs text-muted-foreground">{t('manageAssets.detached.description')}</p>
          </div>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? t('manageAssets.detached.hide') : t('manageAssets.detached.review')}
        </Button>
      </div>
      {open && isLoading && <Skeleton className="h-24 w-full rounded-xl" />}
      {open && data && <DetachedTermsSection detached={data.detached} />}
    </div>
  );
}

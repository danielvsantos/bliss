import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Coins, FileText, Layers, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ACTION_STATUSES, type ActionStatus, type AssetStatusFilter } from '@/types/manage-assets';

const ICONS: Record<ActionStatus, typeof Pencil> = {
  stale: Pencil,
  debtTermsMissing: FileText,
  incomeMissing: Coins,
  lotMismatch: Layers,
};

interface AttentionSummaryProps {
  counts: Record<AssetStatusFilter, number>;
  attention: number;
  active: AssetStatusFilter | null;
  onSelect: (status: ActionStatus | null) => void;
}

/**
 * "Needs attention" strip at the top of Manage Assets: one card per action
 * status with rows to fix. A card filters the list to those rows (tap again
 * to clear). With nothing to fix it shows an "All caught up" state instead.
 */
export function AttentionSummary({ counts, attention, active, onSelect }: AttentionSummaryProps) {
  const { t } = useTranslation();
  const statuses = ACTION_STATUSES.filter((s) => counts[s] > 0);

  if (attention === 0 || statuses.length === 0) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-positive/20 bg-positive/10 p-3"
        data-testid="attention-all-clear"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0 text-positive" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-brand-deep">{t('manageAssets.attention.allClear')}</p>
          <p className="text-xs text-muted-foreground">{t('manageAssets.attention.allClearHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-2" aria-labelledby="attention-title" data-testid="attention-summary">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
        <h2 id="attention-title" className="text-sm font-semibold text-brand-deep">
          {t('manageAssets.attention.title', { count: attention })}
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {statuses.map((s) => {
          const Icon = ICONS[s];
          const isActive = active === s;
          const critical = s === 'stale';
          return (
            <button
              key={s}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelect(isActive ? null : s)}
              data-testid={`attention-${s}`}
              className={cn(
                'flex min-w-0 items-start gap-2 rounded-lg border p-3 text-left transition-colors',
                critical ? 'border-destructive/20 bg-destructive/10' : 'border-warning/20 bg-warning/10',
                isActive ? 'ring-2 ring-brand-primary' : 'hover:bg-accent/40',
              )}
            >
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', critical ? 'text-destructive' : 'text-warning')} aria-hidden />
              <span className="min-w-0">
                <span className="block text-xl font-semibold tabular-nums text-brand-deep">{counts[s]}</span>
                <span className="block text-xs text-muted-foreground">{t(`manageAssets.attention.${s}`)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, Clock, Hourglass, Moon, RotateCcw, WifiOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { useActivityStatus, type ActivityRow, type ChipState } from '@/hooks/use-activity';
import { activityTypeLabel, formatAgo, stageLabel } from '@/lib/activity-format';
import type { ActivityTrigger } from '@/types/activity';

/**
 * Header processing-status chip (#100, PRD R4). Hidden while everything is
 * up to date (PRD OQ1) and when status can't be read; otherwise a compact
 * label — Queued / Updating / Taking longer than usual / Update failed — whose
 * popover lists one row per activity type (coalesced, AC2).
 */

const CHIP_STYLE: Record<Exclude<ChipState, 'hidden'>, string> = {
  queued: 'bg-warning/10 text-warning border-warning/20',
  running: 'bg-warning/10 text-warning border-warning/20',
  stalled: 'bg-warning/10 text-warning border-warning/20',
  failed: 'bg-destructive/10 text-destructive border-destructive/20',
};

const TRIGGER_ICON: Partial<Record<ActivityTrigger, typeof Bot>> = {
  agent: Bot,
  nightly: Moon,
  manual_rebuild: RotateCcw,
};

function ChipIcon({ state }: { state: Exclude<ChipState, 'hidden'> }) {
  if (state === 'running') {
    return (
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-warning" />
      </span>
    );
  }
  const Icon = state === 'failed' ? AlertTriangle : state === 'stalled' ? Hourglass : Clock;
  return <Icon className="h-3.5 w-3.5" aria-hidden />;
}

function TriggerBadge({ trigger }: { trigger: ActivityTrigger | null }) {
  const { t } = useTranslation();
  if (!trigger || trigger === 'user_change') return null;
  const Icon = TRIGGER_ICON[trigger];
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-brand-primary/20 bg-brand-primary/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-brand-primary">
      {Icon && <Icon className="h-3 w-3" aria-hidden />}
      {t(`activity.triggers.${trigger}`)}
    </span>
  );
}

function ActivityRowItem({ row }: { row: ActivityRow }) {
  const { t } = useTranslation();
  const stage = row.optimistic ? t('activity.chip.pending') : stageLabel(t, row.stage);
  const failed = row.state === 'failed';
  return (
    <li className="px-4 py-3 space-y-1.5" data-testid={`activity-row-${row.type}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium truncate">{activityTypeLabel(t, row.type)}</span>
        <span className={cn('text-xs font-medium shrink-0', failed ? 'text-destructive' : 'text-warning')}>
          {t(`activity.states.${row.state}`)}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
        {stage && <span>{stage}</span>}
        {row.progress != null && !failed && <span>{row.progress}%</span>}
        {row.count > 1 && <span>· {t('activity.chip.jobs', { count: row.count })}</span>}
        <TriggerBadge trigger={row.trigger} />
      </div>
      {row.progress != null && !failed && <Progress value={row.progress} className="h-1" />}
      {failed && (
        <p className="text-xs text-destructive">{t('activity.chip.failedHint', { code: row.errorCode ?? 'INTERNAL' })}</p>
      )}
    </li>
  );
}

export function ActivityChip() {
  const { t } = useTranslation();
  const status = useActivityStatus();
  const { chipState } = status;

  if (chipState === 'hidden') return null;
  const lastUpdated = formatAgo(t, status.lastUpdatedAt);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="activity-chip"
          data-state={chipState}
          aria-label={`${t('activity.chip.ariaLabel')}: ${t(`activity.chip.${chipState}`)}`}
          className={cn(
            'inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-[0.625rem] border px-2.5 text-xs font-medium transition-colors',
            CHIP_STYLE[chipState],
          )}
        >
          <ChipIcon state={chipState} />
          <span className="hidden sm:inline whitespace-nowrap">{t(`activity.chip.${chipState}`)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="px-4 py-3 border-b">
          <h4 className="font-semibold text-sm">{t('activity.chip.title')}</h4>
        </div>
        {status.rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground text-center">{t('activity.chip.empty')}</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto divide-y">
            {status.rows.map((row) => <ActivityRowItem key={row.type} row={row} />)}
          </ul>
        )}
        {status.workerOffline && (
          <div className="flex items-start gap-2 border-t px-4 py-3 text-xs text-warning">
            <WifiOff className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
            <span>{t('activity.chip.workerOffline')}</span>
          </div>
        )}
        {lastUpdated && (
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            {t('activity.chip.lastUpdated', { time: lastUpdated })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

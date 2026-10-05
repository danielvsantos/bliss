import { useTranslation } from 'react-i18next';
import type { QueryKey } from '@tanstack/react-query';
import { AlertTriangle, Hourglass, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useActivityWatcher } from '@/hooks/use-activity';
import { activityTypeLabel, formatAgo, stageLabel } from '@/lib/activity-format';
import type { ActivityType } from '@/types/activity';

/**
 * Page-level "data is updating" banner (#100, PRD R5).
 *
 * Non-blocking. Shown while background work that will change this page's
 * numbers is queued / running / stalled, or after a recent final failure. It
 * matches an entry's `affects` (its whole chain), so e.g. Expenses lights up
 * during the cash stage of a transaction edit. When the work settles the
 * page's `invalidate` queries are refetched and the banner goes away — no
 * reload. Idle, it shows a quiet "Updated X ago" for the `primary` type.
 */

interface DataUpdatingBannerProps {
  watch: ActivityType[];
  invalidate: QueryKey[];
  /** The type whose `lastCompletedAt` drives "Updated X ago" (default: the first watched type). */
  primary?: ActivityType;
  className?: string;
}

export function DataUpdatingBanner({ watch, invalidate, primary, className }: DataUpdatingBannerProps) {
  const { t } = useTranslation();
  const view = useActivityWatcher(watch, invalidate, primary ?? watch[0]);

  if (!view.available) return null;

  if (!view.state) {
    const ago = formatAgo(t, view.lastUpdatedAt);
    if (!ago) return null;
    return (
      <p className={cn('text-xs text-muted-foreground', className)} data-testid="data-updated-at">
        {t('activity.banner.updated', { time: ago })}
      </p>
    );
  }

  const entry = view.primaryEntry;
  const type = entry?.type ?? view.failed?.type ?? watch[0];
  const label = stageLabel(t, entry?.stage) ?? activityTypeLabel(t, type);
  const variant = view.state;

  let message: string;
  if (variant === 'failed') message = t('activity.banner.failed', { label: activityTypeLabel(t, type) });
  else if (variant === 'stalled') message = t('activity.banner.stalled', { label });
  else if (variant === 'queued') message = t('activity.banner.queued', { label: activityTypeLabel(t, type) });
  else if (entry?.progress != null) message = t('activity.banner.runningProgress', { label, progress: entry.progress });
  else message = t('activity.banner.running', { label });

  const destructive = variant === 'failed';
  const Icon = destructive ? AlertTriangle : variant === 'stalled' ? Hourglass : Loader2;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="data-updating-banner"
      data-variant={variant}
      className={cn(
        'flex items-start gap-2 rounded-[0.75rem] border px-3 py-2 text-sm',
        destructive
          ? 'bg-destructive/10 text-destructive border-destructive/20'
          : 'bg-warning/10 text-warning border-warning/20',
        className,
      )}
    >
      <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', variant === 'running' && 'animate-spin')} aria-hidden />
      <span>{message}</span>
    </div>
  );
}

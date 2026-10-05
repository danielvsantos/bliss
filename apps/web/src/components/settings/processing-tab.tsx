import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, CheckCircle2, Clock, History, Hourglass, Loader2, WifiOff, XCircle } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { RebuildHistoryList } from '@/components/settings/rebuild-history-list';
import { useActivity } from '@/hooks/use-activity';
import { useRebuildStatus } from '@/hooks/use-rebuild';
import { activityTypeLabel, formatAgo, formatDuration, formatElapsed, stageLabel } from '@/lib/activity-format';
import { cn } from '@/lib/utils';
import type { ActivityInFlightEntry, ActivityRecentEntry } from '@/types/activity';

/**
 * Settings → Administration → Processing (#100, PRD R6). Admin-only.
 *
 *  - Live: every in-flight entry (stage, progress, trigger, elapsed).
 *  - Last 24 hours: every finished entry (outcome, duration, error code).
 *  - Recent rebuilds: the admin rebuild history moved out of Maintenance,
 *    still served by GET /api/admin/rebuild (30-day retention).
 */

const STATE_STYLE: Record<string, { className: string; icon: typeof Clock }> = {
  queued: { className: 'bg-warning/10 text-warning border-warning/20', icon: Clock },
  running: { className: 'bg-warning/10 text-warning border-warning/20', icon: Loader2 },
  stalled: { className: 'bg-warning/10 text-warning border-warning/20', icon: Hourglass },
  completed: { className: 'bg-positive/10 text-positive border-positive/20', icon: CheckCircle2 },
  failed: { className: 'bg-destructive/10 text-destructive border-destructive/20', icon: XCircle },
};

function StateBadge({ state }: { state: string }) {
  const { t } = useTranslation();
  const style = STATE_STYLE[state] ?? STATE_STYLE.queued;
  const Icon = style.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border', style.className)}>
      <Icon className={cn('h-3 w-3', state === 'running' && 'animate-spin')} aria-hidden />
      {t(`activity.states.${state}`)}
    </span>
  );
}

function TriggerText({ trigger }: { trigger: string }) {
  const { t } = useTranslation();
  return <span>{t(`activity.triggers.${trigger}`)}</span>;
}

function LiveRow({ entry }: { entry: ActivityInFlightEntry }) {
  const { t } = useTranslation();
  const stage = stageLabel(t, entry.stage);
  const elapsed = entry.state === 'queued'
    ? t('activity.processing.queuedFor', { time: formatElapsed(t, entry.enqueuedAt) ?? '—' })
    : t('activity.processing.elapsed', { time: formatElapsed(t, entry.startedAt) ?? '—' });
  return (
    <li className="py-3 space-y-1.5" data-testid="processing-live-row">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-sm">{activityTypeLabel(t, entry.type)}</span>
        <StateBadge state={entry.state} />
      </div>
      <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
        {stage && <span>{stage}</span>}
        {entry.progress != null && <span>· {entry.progress}%</span>}
        <span>·</span>
        <TriggerText trigger={entry.trigger} />
        <span>· {elapsed}</span>
      </div>
      {entry.progress != null && <Progress value={entry.progress} className="h-1" />}
    </li>
  );
}

function RecentRow({ entry }: { entry: ActivityRecentEntry }) {
  const { t } = useTranslation();
  const finished = formatAgo(t, entry.finishedAt);
  const took = formatDuration(t, entry.durationMs);
  return (
    <li className="py-3 flex items-start justify-between gap-3" data-testid="processing-recent-row">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{activityTypeLabel(t, entry.type)}</span>
          <StateBadge state={entry.state} />
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
          <TriggerText trigger={entry.trigger} />
          {finished && <span>· {t('activity.processing.finished', { time: finished })}</span>}
          {took && <span>· {t('activity.processing.took', { time: took })}</span>}
        </div>
        {entry.state === 'failed' && (
          <p className="text-xs text-destructive mt-1">{t('activity.processing.errorCode', { code: entry.errorCode ?? 'INTERNAL' })}</p>
        )}
      </div>
    </li>
  );
}

function SectionHeading({ icon: Icon, title }: { icon: typeof Clock; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h3 className="font-medium">{title}</h3>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />)}
    </div>
  );
}

export function ProcessingTab() {
  const { t } = useTranslation();
  const { data: activity, isLoading: activityLoading, isError: activityError } = useActivity();
  const { data: rebuilds, isLoading: rebuildsLoading } = useRebuildStatus();

  const unavailable = activityError || activity?.available === false;
  const inFlight = activity?.inFlight ?? [];
  const recent = activity?.recent ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">{t('activity.processing.title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t('activity.processing.description')}</p>
      </div>

      {unavailable && (
        <div role="status" className="flex items-start gap-2 rounded-[0.75rem] border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <span>{t('activity.processing.unavailable')}</span>
        </div>
      )}
      {activity?.workerOnline === false && (
        <div role="status" className="flex items-start gap-2 rounded-[0.75rem] border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
          <WifiOff className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <span>{t('activity.processing.workerOffline')}</span>
        </div>
      )}

      <Card className="p-6 space-y-4">
        <SectionHeading icon={Activity} title={t('activity.processing.liveTitle')} />
        <Separator />
        {activityLoading ? <LoadingRows /> : inFlight.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{t('activity.processing.liveEmpty')}</p>
        ) : (
          <ul className="divide-y">{inFlight.map((e) => <LiveRow key={e.id} entry={e} />)}</ul>
        )}
      </Card>

      <Card className="p-6 space-y-4">
        <SectionHeading icon={Clock} title={t('activity.processing.recentTitle')} />
        <Separator />
        {activityLoading ? <LoadingRows /> : recent.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{t('activity.processing.recentEmpty')}</p>
        ) : (
          <ul className="divide-y">{recent.map((e) => <RecentRow key={e.id} entry={e} />)}</ul>
        )}
      </Card>

      <Card className="p-6 space-y-4">
        <SectionHeading icon={History} title={t('activity.processing.rebuildsTitle')} />
        <Separator />
        {rebuildsLoading ? <LoadingRows /> : <RebuildHistoryList recent={rebuilds?.recent ?? []} />}
      </Card>
    </div>
  );
}

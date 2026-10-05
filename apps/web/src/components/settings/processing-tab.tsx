import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, Clock, History, Hourglass, Loader2, WifiOff, XCircle } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { RebuildHistoryList } from '@/components/settings/rebuild-history-list';
import { useActivity } from '@/hooks/use-activity';
import { useRebuildStatus } from '@/hooks/use-rebuild';
import { activityTypeLabel, formatAgo, formatDuration, formatElapsed, stageLabel } from '@/lib/activity-format';
import { cn } from '@/lib/utils';
import type { ActivityInFlightEntry, ActivityResponse, ActivityRun } from '@/types/activity';

/**
 * Settings → Administration → Processing (#100, PRD R6). Admin-only.
 *
 *  - Live: every in-flight entry (stage, progress, trigger, elapsed).
 *  - Last 24 hours: one row per run (an edit, sync, import, rebuild or nightly
 *    run groups all its jobs), with outcome, duration and expandable steps.
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

/** A run with its jobs as steps: one row per edit / sync / import / rebuild / nightly run. */
function RunRow({ run }: { run: ActivityRun }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const finished = formatAgo(t, run.finishedAt);
  const took = formatDuration(t, run.durationMs);
  const title = run.types.map((type) => activityTypeLabel(t, type)).join(' · ');
  const multiStep = run.steps.length > 1;
  return (
    <li className="py-3" data-testid="processing-run-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{title}</span>
            <StateBadge state={run.state} />
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
            <TriggerText trigger={run.trigger} />
            {finished && <span>· {t('activity.processing.finished', { time: finished })}</span>}
            {took && <span>· {t('activity.processing.took', { time: took })}</span>}
          </div>
          {run.state === 'failed' && (
            <p className="text-xs text-destructive mt-1">{t('activity.processing.errorCode', { code: run.errorCode ?? 'INTERNAL' })}</p>
          )}
        </div>
        {multiStep && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('activity.processing.steps', { count: run.steps.length })}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        )}
      </div>
      {multiStep && open && (
        <ol className="mt-2 ml-1 space-y-1 border-l border-border pl-3" data-testid="processing-run-steps">
          {run.steps.map((step) => (
            <li key={step.id} className="flex items-center justify-between gap-3 text-xs">
              <span className={cn('truncate', step.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                {stageLabel(t, step.stage) ?? activityTypeLabel(t, step.type)}
                {step.state === 'failed' && ` · ${t('activity.processing.errorCode', { code: step.errorCode ?? 'INTERNAL' })}`}
              </span>
              <span className="shrink-0 text-muted-foreground">{formatDuration(t, step.durationMs) ?? '—'}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/** Older APIs return no `runs`: show each finished job as its own run. */
function runsOf(activity: ActivityResponse | undefined): ActivityRun[] {
  if (activity?.runs) return activity.runs;
  return (activity?.recent ?? []).map((step) => ({
    id: step.id, trigger: step.trigger, types: [step.type], state: step.state, errorCode: step.errorCode,
    startedAt: step.startedAt, finishedAt: step.finishedAt, durationMs: step.durationMs, steps: [step],
  }));
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
  const runs = runsOf(activity);

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
        {activityLoading ? <LoadingRows /> : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{t('activity.processing.recentEmpty')}</p>
        ) : (
          <ul className="divide-y">{runs.map((run) => <RunRow key={run.id} run={run} />)}</ul>
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

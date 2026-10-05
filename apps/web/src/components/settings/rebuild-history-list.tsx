import { AlertTriangle, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { SCOPE_LABEL, formatRelativeTime } from '@/lib/rebuild-labels';
import type { RebuildJob } from '@/types/api';

/**
 * Admin rebuild history (BullMQ retained jobs, 30 days), moved verbatim out of
 * the Maintenance tab into Settings → Processing (#100). Data still comes from
 * `GET /api/admin/rebuild` (`useRebuildStatus`).
 */

// Human-readable label per BullMQ job name. Used in the history list
// so each subjob of a multi-step chain is distinguishable at a glance
// (e.g., a `full-portfolio` rebuild produces 4 rows — each carrying the
// same scope label but a different step label). Falls back to the raw
// name if we don't have a mapping (future-proofing against new jobs).
const STEP_LABEL: Record<string, string> = {
  'process-portfolio-changes': 'Sync transactions → portfolio items',
  'process-cash-holdings':     'Rebuild cash holdings',
  'full-rebuild-analytics':    'Rebuild analytics',
  'value-all-assets':          'Revalue all assets',
  'scoped-update-analytics':   'Rebuild analytics (scoped)',
  'value-portfolio-items':     'Revalue selected asset(s)',
  'process-amortizing-loan':   'Rebuild amortizing loans',
  'process-simple-liability':  'Rebuild simple liabilities',
  // Passive Income #77: a step of the full rebuild (missing/stale symbols) and
  // the whole of the `security-data` scope (all of this tenant's symbols).
  'refresh-tenant-securities': 'Refresh securities data',
};

function JobStateBadge({ state }: { state: RebuildJob['state'] }) {
  const config: Record<RebuildJob['state'], { label: string; className: string; icon: typeof CheckCircle2 }> = {
    completed: { label: 'Completed', className: 'bg-positive/10 text-positive border-positive/20', icon: CheckCircle2 },
    failed:    { label: 'Failed',    className: 'bg-destructive/10 text-destructive border-destructive/20', icon: XCircle },
    active:    { label: 'Running',   className: 'bg-brand-primary/10 text-brand-primary border-brand-primary/20', icon: Loader2 },
    waiting:   { label: 'Queued',    className: 'bg-warning/10 text-warning border-warning/20', icon: Clock },
    delayed:   { label: 'Delayed',   className: 'bg-warning/10 text-warning border-warning/20', icon: Clock },
    unknown:   { label: 'Unknown',   className: 'bg-muted text-muted-foreground border-border', icon: AlertTriangle },
  };
  const c = config[state] ?? config.unknown;
  const Icon = c.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border', c.className)}>
      <Icon className={cn('h-3 w-3', state === 'active' && 'animate-spin')} />
      {c.label}
    </span>
  );
}

export function RebuildHistoryList({ recent }: { recent: RebuildJob[] }) {
  if (recent.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        No recent rebuilds. Completed rebuilds are retained for 30 days.
      </p>
    );
  }
  return (
    <div className="divide-y">
      {recent.map((job) => {
        // Scope label (e.g. "Full rebuild") identifies the rebuild type;
        // step label (e.g. "Revalue all assets") identifies WHICH subjob
        // of that rebuild this row represents. For single-step scopes
        // (full-analytics, scoped-analytics, single-asset) the two
        // collapse into one, so we suppress the step suffix when it's
        // redundant.
        const scopeLabel = job.rebuildType ? SCOPE_LABEL[job.rebuildType] : job.name;
        const stepLabel = STEP_LABEL[job.name] ?? job.name;
        const showStep = job.rebuildType === 'full-portfolio' && stepLabel !== scopeLabel;
        return (
          <div key={String(job.id)} className="py-3 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{scopeLabel}</span>
                {showStep && (
                  <span className="text-xs text-muted-foreground">· {stepLabel}</span>
                )}
                <JobStateBadge state={job.state} />
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 truncate">
                {job.requestedBy ? `by ${job.requestedBy} · ` : ''}
                {job.finishedAt
                  ? `finished ${formatRelativeTime(job.finishedAt)}`
                  : job.requestedAt
                    ? `requested ${formatRelativeTime(job.requestedAt)}`
                    : ''}
                {job.attemptsMade > 1 ? ` · ${job.attemptsMade} attempts` : ''}
              </div>
              {job.failedReason && (
                <p className="text-xs text-destructive mt-1 truncate" title={job.failedReason}>
                  {job.failedReason}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

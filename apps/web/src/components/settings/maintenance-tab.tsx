import { useMemo, useState } from 'react';
import { AxiosError } from 'axios';
import {
  Check,
  ChevronsUpDown,
  Database,
  History,
  Loader2,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react';

import { useRebuildStatus, useTriggerRebuild } from '@/hooks/use-rebuild';
import { useToast } from '@/hooks/use-toast';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';

import type {
  RebuildScope,
  RebuildStatusResponse,
  RebuildJob,
  RebuildLockInfo,
  RebuildAsset,
} from '@/types/api';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTtl(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return '—';
  const then = Date.parse(isoString);
  if (Number.isNaN(then)) return '—';
  const elapsed = Math.floor((Date.now() - then) / 1000);
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  return `${Math.floor(elapsed / 86400)}d ago`;
}

function findLock(locks: RebuildLockInfo[] | undefined, scope: RebuildScope) {
  return locks?.find((l) => l.scope === scope);
}

function findCurrent(current: RebuildJob[] | undefined, scope: RebuildScope) {
  return current?.find((j) => j.rebuildType === scope);
}

const SCOPE_LABEL: Record<RebuildScope, string> = {
  'full-portfolio': 'Full portfolio',
  'full-analytics': 'Full analytics',
  'scoped-analytics': 'Scoped analytics',
  'single-asset': 'Single asset',
};

// ─── Sub-components ─────────────────────────────────────────────────────────

interface RebuildButtonProps {
  scope: RebuildScope;
  status: RebuildStatusResponse | undefined;
  isPending: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}

function RebuildButton({ scope, status, isPending, disabled, onClick, label }: RebuildButtonProps) {
  const lock = findLock(status?.locks, scope);
  const current = findCurrent(status?.current, scope);

  // Hierarchy of disable reasons — most informative first.
  if (current) {
    return (
      <Button disabled className="w-full sm:w-auto">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Running… {typeof current.progress === 'number' && current.progress > 0 ? `${current.progress}%` : ''}
      </Button>
    );
  }
  if (lock?.held) {
    return (
      <Button disabled variant="outline" className="w-full sm:w-auto">
        <Clock className="h-4 w-4 mr-2" />
        Next available in {formatTtl(lock.ttlSeconds)}
      </Button>
    );
  }
  if (isPending) {
    return (
      <Button disabled className="w-full sm:w-auto">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Starting…
      </Button>
    );
  }
  return (
    <Button onClick={onClick} disabled={disabled} className="w-full sm:w-auto">
      <RotateCcw className="h-4 w-4 mr-2" />
      {label}
    </Button>
  );
}

interface AssetPickerProps {
  items: RebuildAsset[];
  value: number | null;
  onChange: (id: number | null) => void;
}

function AssetPicker({ items, value, onChange }: AssetPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => items.find((i) => i.id === value), [items, value]);

  // Sort alphabetically by symbol. The list can be hundreds of rows for
  // power users — search + virtualized rendering via shadcn Command
  // keeps it performant.
  const sortedItems = useMemo(
    () => [...items].sort((a, b) => (a.symbol || '').localeCompare(b.symbol || '')),
    [items],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
        >
          {selected ? (
            <span className="truncate">
              <span className="font-medium">{selected.symbol}</span>
              {selected.category?.name ? (
                <span className="text-muted-foreground ml-2">· {selected.category.name}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">Select an asset…</span>
          )}
          <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(28rem,calc(100vw-2rem))] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by symbol or name…" />
          <CommandList>
            <CommandEmpty>No assets found.</CommandEmpty>
            <CommandGroup>
              {sortedItems.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.symbol} ${item.category?.name || ''}`}
                  onSelect={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === item.id ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium truncate">{item.symbol}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {item.category?.name || '—'}
                      {item.currency ? ` · ${item.currency}` : ''}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

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

function RebuildHistoryList({ recent }: { recent: RebuildJob[] }) {
  if (recent.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        No recent rebuilds. Completed rebuilds are retained for 30 days.
      </p>
    );
  }
  return (
    <div className="divide-y">
      {recent.map((job) => (
        <div key={String(job.id)} className="py-3 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">
                {job.rebuildType ? SCOPE_LABEL[job.rebuildType] : job.name}
              </span>
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
      ))}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function MaintenanceTab() {
  const { toast } = useToast();
  const { data: status, isLoading: statusLoading, isError: statusError } = useRebuildStatus();
  // Assets for the single-asset picker come from the rebuild status
  // response itself — the backend reads id/symbol/currency/category.name
  // direct from the DB, no price fetching. We deliberately do NOT call
  // `usePortfolioItems()` here because that endpoint kicks off a live
  // price fetch per asset (40+ HTTP calls to TwelveData) just to
  // populate a dropdown.
  const portfolioItems = status?.assets ?? [];
  const trigger = useTriggerRebuild();

  // Per-section local state
  const [scopedDate, setScopedDate] = useState<string>('');
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);

  const runTrigger = (scope: RebuildScope, payload?: { earliestDate?: string; portfolioItemId?: number }) => {
    trigger.mutate(
      { scope, payload },
      {
        onSuccess: () => {
          toast({ title: `${SCOPE_LABEL[scope]} rebuild started` });
        },
        onError: (err: unknown) => {
          // 409 response body carries { error, scope, ttlSeconds }
          const ax = err as AxiosError<{ error?: string; ttlSeconds?: number }>;
          const status = ax?.response?.status;
          const data = ax?.response?.data;
          if (status === 409) {
            toast({
              title: 'Rebuild already running',
              description: `Try again in ${formatTtl(data?.ttlSeconds ?? null)}.`,
              variant: 'destructive',
            });
            return;
          }
          toast({
            title: 'Failed to start rebuild',
            description: data?.error || ax?.message || 'Unknown error',
            variant: 'destructive',
          });
        },
      },
    );
  };

  if (statusError) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <h3 className="font-medium">Unable to load rebuild status</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Check your connection and refresh the page. If the problem
              persists, check that the backend is reachable.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/* ─── Intro card ────────────────────────────────────────────────── */}
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <Database className="h-5 w-5 text-brand-primary shrink-0 mt-0.5" />
          <div>
            <h3 className="font-medium">Data maintenance</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Manually trigger background rebuilds when analytics or portfolio
              data looks stale. Each scope has a 1-hour single-flight lock to
              prevent overlapping runs.
            </p>
          </div>
        </div>
      </Card>

      {/* ─── Full analytics ────────────────────────────────────────────── */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="font-medium">Rebuild all analytics</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Recomputes every <code>AnalyticsCacheMonthly</code> and
            <code> TagAnalyticsCacheMonthly</code> row from current transaction
            data. Use when cached monthly totals disagree with the transactions
            list (the classic "March expenses not updating" symptom). Does
            <strong> not</strong> touch portfolio valuations.
          </p>
        </div>
        <RebuildButton
          scope="full-analytics"
          status={status}
          isPending={trigger.isPending && trigger.variables?.scope === 'full-analytics'}
          disabled={statusLoading}
          onClick={() => runTrigger('full-analytics')}
          label="Rebuild analytics"
        />
      </Card>

      {/* ─── Full portfolio ────────────────────────────────────────────── */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="font-medium">Rebuild portfolio</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Runs the full pipeline: re-derives portfolio items from transactions,
            rebuilds cash holdings, cascades into a full analytics rebuild, then
            revalues every asset (including debt and loan processors). Heaviest
            option — expect 5-30 minutes depending on history size.
          </p>
        </div>
        <RebuildButton
          scope="full-portfolio"
          status={status}
          isPending={trigger.isPending && trigger.variables?.scope === 'full-portfolio'}
          disabled={statusLoading}
          onClick={() => runTrigger('full-portfolio')}
          label="Rebuild portfolio"
        />
      </Card>

      {/* ─── Scoped analytics ──────────────────────────────────────────── */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="font-medium">Rebuild analytics from a date</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Recompute analytics only from the given date onwards. Faster than a
            full analytics rebuild when the issue is localized to recent
            months.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 max-w-xs space-y-1.5">
            <Label htmlFor="scoped-date" className="text-xs">Earliest date</Label>
            <Input
              id="scoped-date"
              type="date"
              value={scopedDate}
              onChange={(e) => setScopedDate(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
            />
          </div>
          <RebuildButton
            scope="scoped-analytics"
            status={status}
            isPending={trigger.isPending && trigger.variables?.scope === 'scoped-analytics'}
            disabled={statusLoading || !scopedDate}
            onClick={() => {
              // Date input returns `YYYY-MM-DD`; convert to full ISO string
              // at start of day UTC so the backend's `new Date(earliestDate)`
              // gets a canonical value.
              runTrigger('scoped-analytics', {
                earliestDate: new Date(`${scopedDate}T00:00:00.000Z`).toISOString(),
              });
            }}
            label="Rebuild from date"
          />
        </div>
      </Card>

      {/* ─── Single asset ──────────────────────────────────────────────── */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="font-medium">Rebuild a single asset</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Re-value one portfolio asset's full price history and holdings.
            Useful when a corporate action, manual value edit, or source-data
            fix only affected one position.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 space-y-1.5">
            <Label className="text-xs">Asset</Label>
            {statusLoading ? (
              <div className="h-10 rounded-md border bg-muted animate-pulse" />
            ) : (
              <AssetPicker
                items={portfolioItems}
                value={selectedAssetId}
                onChange={setSelectedAssetId}
              />
            )}
          </div>
          <RebuildButton
            scope="single-asset"
            status={status}
            isPending={trigger.isPending && trigger.variables?.scope === 'single-asset'}
            disabled={statusLoading || selectedAssetId == null}
            onClick={() => {
              if (selectedAssetId == null) return;
              runTrigger('single-asset', { portfolioItemId: selectedAssetId });
            }}
            label="Rebuild asset"
          />
        </div>
      </Card>

      {/* ─── History ───────────────────────────────────────────────────── */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium">Recent rebuilds</h3>
        </div>
        <Separator />
        {statusLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
            ))}
          </div>
        ) : (
          <RebuildHistoryList recent={status?.recent ?? []} />
        )}
      </Card>

    </div>
  );
}

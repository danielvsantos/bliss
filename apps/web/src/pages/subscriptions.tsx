import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AxiosError } from 'axios';
import {
  Repeat,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Trash2,
  Info,
  GitMerge,
  Undo2,
  Pencil,
} from 'lucide-react';

import { api } from '@/lib/api';
import {
  useSubscriptions,
  useConfirmSubscription,
  useDismissSubscription,
  useRestoreSubscription,
  useSetSubscriptionCadence,
  useRenameSubscription,
  useMergeSubscription,
  useUnmergeSubscription,
  useRefreshSubscriptions,
} from '@/hooks/use-subscriptions';
import { useToast } from '@/hooks/use-toast';
import { formatCurrency } from '@/lib/utils';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  SubscriptionItem,
  SubscriptionsResponse,
  SubscriptionsView,
  RecurringCadence,
  Transaction,
} from '@/types/api';

type MergeCandidate = SubscriptionsResponse['mergeCandidates'][number];

const CADENCES: RecurringCadence[] = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'];

function formatRelative(iso: string | null, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (!iso) return '—';
  const ms = Date.parse(iso) - Date.now();
  const days = Math.round(ms / 86_400_000);
  if (days === 0) return t('subscriptions.due.today');
  if (days > 0) return t('subscriptions.due.inDays', { count: days });
  return t('subscriptions.due.agoDays', { count: Math.abs(days) });
}

function StatusBadge({ status, t }: { status: SubscriptionItem['status']; t: (k: string) => string }) {
  if (status === 'ACTIVE') {
    return (
      <Badge className="bg-positive/10 text-positive border-positive/20">
        {t('subscriptions.status.active')}
      </Badge>
    );
  }
  return (
    <Badge className="bg-warning/10 text-warning border-warning/20">
      {t('subscriptions.status.lapsed')}
    </Badge>
  );
}

function ExpandedCharges({ ids }: { ids: number[] }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['subscriptions', 'charges', ids],
    queryFn: () => api.getTransactions({ ids: ids.join(','), limit: 50, sortBy: 'transaction_date', sortOrder: 'desc' }),
    enabled: ids.length > 0,
  });

  if (isLoading) {
    return <Skeleton className="h-16 w-full" />;
  }
  const txns: Transaction[] = data?.transactions ?? [];
  if (txns.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">{t('subscriptions.noCharges')}</p>;
  }
  return (
    <div className="divide-y divide-border/50">
      {txns.map((tx) => (
        <div key={tx.id} className="flex items-center justify-between py-1.5 text-xs">
          <span className="text-muted-foreground">
            {new Date(tx.transaction_date).toLocaleDateString()}
          </span>
          <span className="truncate px-2 flex-1">{tx.description}</span>
          <span className="tabular-nums">
            {tx.debit != null ? formatCurrency(Number(tx.debit), tx.currency) : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function SubscriptionRow({
  item,
  displayCurrency,
  mergeCandidates,
}: {
  item: SubscriptionItem;
  displayCurrency: string;
  mergeCandidates: MergeCandidate[];
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [editingCadence, setEditingCadence] = useState(false);
  const [merging, setMerging] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(item.merchantLabel);

  const confirm = useConfirmSubscription();
  const dismiss = useDismissSubscription();
  const restore = useRestoreSubscription();
  const setCadence = useSetSubscriptionCadence();
  const rename = useRenameSubscription();
  const merge = useMergeSubscription();
  const unmerge = useUnmergeSubscription();

  const locale = i18n.language || 'en';
  const isMerged = item.mergedIntoHash != null;
  const isTombstone = item.state === 'DISMISSED' || isMerged;

  const handleErr = (err: unknown) => {
    const ax = err as AxiosError<{ error?: string }>;
    toast({
      title: t('subscriptions.actionFailed'),
      description: ax?.response?.data?.error || ax?.message || '',
      variant: 'destructive',
    });
  };

  const mergeOptions = mergeCandidates.filter((c) => c.descriptionHash !== item.descriptionHash);

  const runMerge = (targetDescriptionHash: string) => {
    merge.mutate(
      { sourceDescriptionHash: item.descriptionHash, targetDescriptionHash },
      {
        onSuccess: () => {
          setMerging(false);
          toast({ title: t('subscriptions.merge.merged') });
        },
        onError: handleErr,
      },
    );
  };

  const submitRename = () => {
    if (rename.isPending) return; // guard the Enter-then-blur double fire
    const next = labelDraft.trim();
    if (!next || next === item.merchantLabel) {
      setEditingLabel(false);
      setLabelDraft(item.merchantLabel);
      return;
    }
    rename.mutate(
      { descriptionHash: item.descriptionHash, merchantLabel: next },
      {
        onSuccess: () => {
          setEditingLabel(false);
          toast({ title: t('subscriptions.rename.renamed') });
        },
        onError: handleErr,
      },
    );
  };

  // A manual-merge tombstone renders as a compact, dimmed "→ target" row with an
  // Unmerge action. Only ever reached in the "All" view.
  if (isMerged) {
    return (
      <div className="flex items-center gap-3 py-3 border-b border-border/60 last:border-0 text-muted-foreground">
        <GitMerge className="h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate">
            <span className="line-through">{item.merchantLabel}</span>
            <span className="mx-1.5">→</span>
            <span className="font-medium text-foreground">
              {item.mergedIntoLabel || t('subscriptions.merge.unknownTarget')}
            </span>
          </div>
          <div className="text-xs truncate">{t('subscriptions.merge.tombstoneHint')}</div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={unmerge.isPending}
          onClick={() =>
            unmerge.mutate(item.descriptionHash, {
              onSuccess: () => toast({ title: t('subscriptions.merge.unmerged') }),
              onError: handleErr,
            })
          }
        >
          <Undo2 className="h-4 w-4 mr-1" />
          {t('subscriptions.merge.unmerge')}
        </Button>
      </div>
    );
  }

  return (
    <div className="border-b border-border/60 last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground shrink-0"
          aria-label={t('subscriptions.toggleCharges')}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <span className="text-lg shrink-0" aria-hidden>
          {item.category?.icon || '🔁'}
        </span>

        <div className="min-w-0 flex-1">
          {editingLabel ? (
            <Input
              autoFocus
              value={labelDraft}
              maxLength={140}
              disabled={rename.isPending}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename();
                if (e.key === 'Escape') {
                  setEditingLabel(false);
                  setLabelDraft(item.merchantLabel);
                }
              }}
              className="h-7 text-sm font-medium"
              aria-label={t('subscriptions.rename.label')}
            />
          ) : (
            <div className="font-medium truncate flex items-center gap-1.5 group">
              <span className="truncate">{item.merchantLabel}</span>
              <button
                type="button"
                onClick={() => {
                  setLabelDraft(item.merchantLabel);
                  setEditingLabel(true);
                }}
                className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                aria-label={t('subscriptions.rename.label')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div className="text-xs text-muted-foreground truncate">
            {item.category?.name || t('subscriptions.uncategorized')}
            {' · '}
            {t('subscriptions.occurrences', { count: item.occurrenceCount })}
            {item.userLabelLocked ? ` · ${t('subscriptions.rename.custom')}` : ''}
          </div>
        </div>

        {/* Status — kept next to the name so the amount/actions line below stays short on mobile */}
        <div className="shrink-0">
          <StatusBadge status={item.status} t={t} />
        </div>

        {/* Cadence */}
        <div className="hidden sm:block shrink-0 w-28 text-right">
          {editingCadence ? (
            <Select
              value={item.cadence ?? 'MONTHLY'}
              onValueChange={(v) => {
                setCadence.mutate(
                  { descriptionHash: item.descriptionHash, cadence: v as RecurringCadence },
                  { onSettled: () => setEditingCadence(false), onError: handleErr },
                );
              }}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCES.map((c) => (
                  <SelectItem key={c} value={c} className="text-xs">
                    {t(`subscriptions.cadence.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <button
              type="button"
              onClick={() => setEditingCadence(true)}
              className="text-xs underline decoration-dotted text-muted-foreground hover:text-foreground"
            >
              {item.cadence ? t(`subscriptions.cadence.${item.cadence}`) : t('subscriptions.cadence.unknown')}
              {item.userCadenceLocked ? ' *' : ''}
            </button>
          )}
        </div>

        {/* Amounts */}
        <div className="shrink-0 w-24 sm:w-32 text-right">
          <div className="font-medium tabular-nums">
            {item.amount != null && item.currency
              ? formatCurrency(item.amount, item.currency, locale)
              : '—'}
          </div>
          {item.fxUnavailable ? (
            <div className="text-xs text-warning">{t('subscriptions.fxUnavailable')}</div>
          ) : item.amountInDisplayCurrency != null && item.currency !== displayCurrency ? (
            <div className="text-xs text-muted-foreground tabular-nums">
              ≈ {formatCurrency(item.amountInDisplayCurrency, displayCurrency, locale)}
            </div>
          ) : null}
        </div>

        {/* Next expected */}
        <div className="hidden md:block shrink-0 w-28 text-right text-xs text-muted-foreground">
          {formatRelative(item.nextExpectedAt, t)}
        </div>

        {/* Actions */}
        <div className="shrink-0 flex items-center gap-1">
          {merging ? (
            <>
              <Select onValueChange={runMerge}>
                <SelectTrigger className="h-8 text-xs w-52">
                  <SelectValue placeholder={t('subscriptions.merge.pickTarget')} />
                </SelectTrigger>
                <SelectContent>
                  {mergeOptions.map((c) => (
                    <SelectItem key={c.descriptionHash} value={c.descriptionHash} className="text-xs">
                      {(c.categoryIcon ? `${c.categoryIcon} ` : '') + c.merchantLabel}
                      {c.status === 'LAPSED' ? ` · ${t('subscriptions.status.lapsed')}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={merge.isPending}
                onClick={() => setMerging(false)}
              >
                {t('common.cancel')}
              </Button>
            </>
          ) : isTombstone ? (
            <Button
              size="sm"
              variant="outline"
              disabled={restore.isPending}
              onClick={() =>
                restore.mutate(item.descriptionHash, {
                  onSuccess: () => toast({ title: t('subscriptions.restored') }),
                  onError: handleErr,
                })
              }
            >
              {t('subscriptions.restore')}
            </Button>
          ) : (
            <>
              {item.state === 'CONFIRMED' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground px-2 sm:px-3"
                  disabled={dismiss.isPending}
                  aria-label={t('subscriptions.remove')}
                  onClick={() =>
                    dismiss.mutate(item.descriptionHash, {
                      onSuccess: () => toast({ title: t('subscriptions.removed') }),
                      onError: handleErr,
                    })
                  }
                >
                  <Trash2 className="h-4 w-4 sm:mr-1" />
                  <span className="hidden sm:inline">{t('subscriptions.remove')}</span>
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="px-2 sm:px-3"
                    disabled={confirm.isPending}
                    aria-label={t('subscriptions.confirm')}
                    onClick={() =>
                      confirm.mutate(
                        { descriptionHash: item.descriptionHash },
                        { onSuccess: () => toast({ title: t('subscriptions.confirmed') }), onError: handleErr },
                      )
                    }
                  >
                    <Check className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">{t('subscriptions.confirm')}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground px-2 sm:px-3"
                    disabled={dismiss.isPending}
                    aria-label={t('subscriptions.notASubscription')}
                    onClick={() =>
                      dismiss.mutate(item.descriptionHash, {
                        onSuccess: () => toast({ title: t('subscriptions.dismissed') }),
                        onError: handleErr,
                      })
                    }
                  >
                    <X className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">{t('subscriptions.notASubscription')}</span>
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground px-2"
                disabled={merge.isPending || mergeOptions.length === 0}
                onClick={() => setMerging(true)}
                aria-label={t('subscriptions.merge.mergeInto')}
                title={t('subscriptions.merge.mergeInto')}
              >
                <GitMerge className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className="pl-10 pr-2 pb-3">
          <ExpandedCharges ids={item.contributingTransactionIds} />
        </div>
      )}
    </div>
  );
}

export default function SubscriptionsPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();

  const [view, setView] = useState<SubscriptionsView>('active');
  const [categoryId, setCategoryId] = useState<number | null>(null);

  const { data, isLoading, isError } = useSubscriptions({ view, categoryId });
  const refresh = useRefreshSubscriptions();

  const locale = i18n.language || 'en';
  const displayCurrency = data?.displayCurrency ?? 'USD';

  const cooldownActive = (data?.refreshCooldownSeconds ?? 0) > 0;

  const categoryOptions = useMemo(() => data?.categories ?? [], [data]);

  // Merge picker targets come from the API (view-independent) so a Lapsed row can
  // still be folded into an Active/Confirmed one that the current filter hides.
  const mergeCandidates = useMemo(() => data?.mergeCandidates ?? [], [data]);

  const handleScanNow = () => {
    refresh.mutate(undefined, {
      onSuccess: () => toast({ title: t('subscriptions.scanStarted'), description: t('subscriptions.scanStartedHint') }),
      onError: (err: unknown) => {
        const ax = err as AxiosError<{ error?: string; retryAfter?: number }>;
        if (ax?.response?.status === 429) {
          const mins = Math.ceil((ax.response.data?.retryAfter ?? 0) / 60);
          toast({
            title: t('subscriptions.scanCooldown'),
            description: t('subscriptions.scanCooldownHint', { count: mins }),
            variant: 'destructive',
          });
          return;
        }
        toast({
          title: t('subscriptions.actionFailed'),
          description: ax?.response?.data?.error || ax?.message || '',
          variant: 'destructive',
        });
      },
    });
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Repeat className="h-7 w-7 text-brand-primary" />
            {t('subscriptions.title')}
          </h1>
          <p className="text-muted-foreground">{t('subscriptions.subtitle')}</p>
        </div>
        <Button onClick={handleScanNow} disabled={refresh.isPending || cooldownActive} variant="outline">
          {refresh.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          {cooldownActive
            ? t('subscriptions.scanCooldownShort', { count: Math.ceil((data?.refreshCooldownSeconds ?? 0) / 60) })
            : t('subscriptions.scanNow')}
        </Button>
      </div>

      {/* Maintenance hint — only until the first full history scan has run */}
      {data && data.fullScanAt == null && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
          <Info className="h-4 w-4 shrink-0" />
          <span>
            {t('subscriptions.fullScanHintPrefix')}{' '}
            <Link to="/settings" className="underline">
              {t('subscriptions.fullScanHintLink')}
            </Link>
            {t('subscriptions.fullScanHintSuffix')}
          </span>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {t('subscriptions.summary.monthly')}
          </div>
          <div className="text-2xl font-bold tabular-nums mt-1">
            {isLoading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              formatCurrency(data?.summary.monthlyTotal ?? 0, displayCurrency, locale)
            )}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {t('subscriptions.summary.annual')}
          </div>
          <div className="text-2xl font-bold tabular-nums mt-1">
            {isLoading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              formatCurrency(data?.summary.annualTotal ?? 0, displayCurrency, locale)
            )}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {t('subscriptions.summary.count')}
          </div>
          <div className="text-2xl font-bold tabular-nums mt-1">
            {isLoading ? <Skeleton className="h-7 w-16" /> : data?.summary.activeCount ?? 0}
          </div>
          {(data?.summary.fxUnavailableCount ?? 0) > 0 && (
            <div className="text-xs text-warning mt-1">
              {t('subscriptions.summary.fxExcluded', { count: data?.summary.fxUnavailableCount ?? 0 })}
            </div>
          )}
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={view} onValueChange={(v) => setView(v as SubscriptionsView)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t('subscriptions.filter.active')}</SelectItem>
            <SelectItem value="lapsed">{t('subscriptions.filter.lapsed')}</SelectItem>
            <SelectItem value="all">{t('subscriptions.filter.all')}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={categoryId != null ? String(categoryId) : 'all'}
          onValueChange={(v) => setCategoryId(v === 'all' ? null : Number(v))}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder={t('subscriptions.filter.allCategories')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('subscriptions.filter.allCategories')}</SelectItem>
            {categoryOptions.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {(c.icon ? `${c.icon} ` : '') + c.name} ({c.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {view !== 'all' && (data?.summary.mergedCount ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => setView('all')}
            className="text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
          >
            {t('subscriptions.merge.mergedCountHint', { count: data?.summary.mergedCount ?? 0 })}
          </button>
        )}
      </div>

      {/* List */}
      <Card className="p-4">
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive py-8 text-center">{t('subscriptions.loadError')}</p>
        ) : (data?.items.length ?? 0) === 0 ? (
          <div className="py-12 text-center">
            <Repeat className="h-10 w-10 mx-auto text-muted-foreground/50" />
            <h3 className="mt-3 font-medium">{t('subscriptions.empty.title')}</h3>
            <p className="text-sm text-muted-foreground mt-1">{t('subscriptions.empty.body')}</p>
          </div>
        ) : (
          <div>
            {data?.items.map((item) => (
              <SubscriptionRow
                key={item.descriptionHash}
                item={item}
                displayCurrency={displayCurrency}
                mergeCandidates={mergeCandidates}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

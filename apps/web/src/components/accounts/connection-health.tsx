import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Activity, CalendarDays, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { useFetchHistoricalTransactions } from '@/hooks/use-plaid-actions';
import type { EnrichedAccount } from '@/hooks/use-account-list';

interface ConnectionHealthProps {
  account: EnrichedAccount;
  onRefetch?: () => void;
}

function MetricRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium ${valueColor ?? ''}`}>{value}</span>
    </div>
  );
}

function formatRelativeTime(dateStr: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!dateStr) return t('connectionHealth.never');
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.round(diffMs / 60000);

  if (diffMins < 1) return t('connectionHealth.justNow');
  if (diffMins < 60) return t('connectionHealth.minutesAgo', { count: diffMins });
  const diffHrs = Math.round(diffMins / 60);
  if (diffHrs < 24) return t('connectionHealth.hoursAgo', { count: diffHrs });
  const diffDays = Math.round(diffHrs / 24);
  return t('connectionHealth.daysAgo', { count: diffDays });
}

export function ConnectionHealth({ account, onRefetch }: ConnectionHealthProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const fetchHistorical = useFetchHistoricalTransactions();

  const isPlaid = account.plaidItem !== null;
  const plaidItemId = account.plaidItem?.id ?? null;
  const isActive = account.plaidItem?.status === 'ACTIVE';

  // Date bounds for the date picker
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  twoYearsAgo.setHours(0, 0, 0, 0);

  const maxSelectableDate = account.earliestTransactionDate ?? new Date();

  const handleFetchHistorical = () => {
    if (!plaidItemId || !selectedDate) return;
    const fromDate = selectedDate.toISOString().slice(0, 10);

    fetchHistorical.mutate(
      { plaidItemId, fromDate },
      {
        onSuccess: () => {
          toast({
            title: t('connectionHealth.backfillStarted'),
            description: t('connectionHealth.backfillStartedDesc', { date: format(selectedDate, 'MMM d, yyyy') }),
          });
          setPopoverOpen(false);
          setSelectedDate(undefined);
          onRefetch?.();
        },
        onError: () => {
          toast({
            title: t('connectionHealth.backfillFailed'),
            variant: 'destructive',
          });
        },
      }
    );
  };

  const statusColor = {
    positive: 'bg-positive',
    warning: 'bg-warning',
    destructive: 'bg-destructive',
    muted: 'bg-muted-foreground',
  }[account.healthColor];

  const backfillButton = isActive && plaidItemId && (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          disabled={fetchHistorical.isPending}
          title={t('connectionHealth.fetchOlderTransactions')}
        >
          {fetchHistorical.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : (
            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <div className="p-3 space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('connectionHealth.fetchOlderTransactions')}</p>
            <p className="text-xs text-muted-foreground">
              {t('connectionHealth.selectStartDate')}
            </p>
          </div>
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={setSelectedDate}
            disabled={(date) => date < twoYearsAgo || date > maxSelectableDate}
            defaultMonth={twoYearsAgo}
            captionLayout="dropdown-buttons"
            fromDate={twoYearsAgo}
            toDate={maxSelectableDate}
          />
          <Button
            size="sm"
            className="w-full"
            disabled={!selectedDate || fetchHistorical.isPending}
            onClick={handleFetchHistorical}
          >
            {fetchHistorical.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                {t('connectionHealth.fetching')}
              </>
            ) : selectedDate ? (
              t('connectionHealth.fetchFrom', { date: format(selectedDate, 'MMM d, yyyy') })
            ) : (
              t('connectionHealth.selectDate')
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );

  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('connectionHealth.title')}
          </span>
        </div>

        <div className="divide-y">
          <MetricRow
            label={t('connectionHealth.status')}
            value={account.healthLabel}
            valueColor={
              account.healthColor === 'positive' ? 'text-positive' :
              account.healthColor === 'warning' ? 'text-warning' :
              account.healthColor === 'destructive' ? 'text-destructive' :
              'text-muted-foreground'
            }
          />

          {isPlaid && (
            <>
              <MetricRow
                label={t('connectionHealth.lastSynced')}
                value={formatRelativeTime(account.lastSync, t)}
              />
              <MetricRow
                label={t('connectionHealth.nextSync')}
                value={t('connectionHealth.nextSyncValue')}
              />
              {account.earliestTransactionDate ? (
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-muted-foreground">{t('connectionHealth.historyRange')}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {format(account.earliestTransactionDate, 'MMM d, yyyy')} → {t('connectionHealth.today')}
                    </span>
                    {backfillButton}
                  </div>
                </div>
              ) : isActive && (
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-muted-foreground">{t('connectionHealth.historyRange')}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{t('connectionHealth.notYetSynced')}</span>
                    {backfillButton}
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">{t('connectionHealth.historyStatus')}</span>
                {account.historicalSyncComplete ? (
                  <Badge className="bg-positive/10 text-positive border-positive/20 text-xs">
                    {t('connectionHealth.complete')}
                  </Badge>
                ) : (
                  <Badge className="bg-warning/10 text-warning border-warning/20 text-xs">
                    {t('connectionHealth.syncingHistory')}
                  </Badge>
                )}
              </div>
              {account.plaidItem?.institutionId && (
                <MetricRow
                  label={t('connectionHealth.institutionId')}
                  value={account.plaidItem.institutionId}
                />
              )}
            </>
          )}

          {!isPlaid && (
            <MetricRow
              label={t('connectionHealth.connection')}
              value={t('connectionHealth.manualEntry')}
              valueColor="text-muted-foreground"
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

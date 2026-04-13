import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { NetWorthSparkline } from './net-worth-sparkline';
import { formatCurrency, formatDate } from '@/lib/utils';

interface HeroNetWorthProps {
  netWorth: number;
  previousNetWorth: number | null;
  netIncome: number;
  discretionaryIncome: number;
  currency: string;
  lastSyncDate: string | null;
  sparklineData: number[];
  isLoading: boolean;
}

function TrendIcon({ positive }: { positive: boolean }) {
  const color = positive ? 'hsl(var(--positive))' : 'hsl(var(--negative))';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      {positive ? (
        <>
          <path d="M1.5 10l3.5-3.5 3 2.5 4-5.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.5 3.5H13V6" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <path d="M1.5 4l3.5 3.5 3-2.5 4 5.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.5 10.5H13V8" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

export function HeroNetWorth({
  netWorth,
  previousNetWorth,
  netIncome,
  discretionaryIncome,
  currency,
  lastSyncDate,
  sparklineData,
  isLoading,
}: HeroNetWorthProps) {
  const { t } = useTranslation();

  const delta = previousNetWorth !== null ? netWorth - previousNetWorth : null;
  const deltaPercent = previousNetWorth && previousNetWorth !== 0
    ? ((netWorth - previousNetWorth) / Math.abs(previousNetWorth)) * 100
    : null;
  const isPositive = delta !== null ? delta >= 0 : true;

  if (isLoading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-4 w-32 mb-3" />
        <Skeleton className="h-10 w-64 mb-3" />
        <Skeleton className="h-4 w-48 mb-2" />
        <Skeleton className="h-3 w-40" />
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-1.5">
        {/* Label */}
        <span className="text-xs font-medium text-muted-foreground tracking-wider uppercase">
          {t('pages.dashboard.totalNetWorth', 'Total Net Worth')}
        </span>

        {/* Value */}
        <span className="text-[clamp(2rem,3.5vw,2.5rem)] font-semibold text-brand-deep tracking-tighter leading-none">
          {formatCurrency(netWorth, currency)}
        </span>

        {/* Delta row */}
        {delta !== null && (
          <div className="flex items-center gap-1.5 flex-wrap mt-1">
            <TrendIcon positive={isPositive} />
            <span className={`text-sm font-medium whitespace-nowrap ${isPositive ? 'text-positive' : 'text-negative'}`}>
              {isPositive ? '+' : ''}{formatCurrency(delta, currency)}
              {deltaPercent !== null && ` · ${isPositive ? '+' : ''}${deltaPercent.toFixed(1)}%`}
            </span>
            <span className="text-[0.8125rem] text-muted-foreground/70 whitespace-nowrap">
              vs last month
            </span>

            {/* Sparkline — hidden on mobile */}
            {sparklineData.length >= 2 && (
              <NetWorthSparkline
                dataPoints={sparklineData}
                className="hidden md:block ml-2 opacity-85 shrink-0"
              />
            )}
          </div>
        )}

        {/* Secondary metric pills */}
        <div className="flex gap-2 mt-2 flex-wrap">
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
            {t('dashboard.netIncome', 'Net Income')}: {formatCurrency(netIncome, currency)}
          </span>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
            {t('dashboard.discretionaryIncome', 'Discretionary Income')}: {formatCurrency(discretionaryIncome, currency)}
          </span>
        </div>

        {/* Last synced */}
        {lastSyncDate && (
          <span className="text-xs text-muted-foreground/70 mt-1">
            Last synced {formatDate(lastSyncDate, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
        )}
      </div>
    </Card>
  );
}

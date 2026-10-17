import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardDivider } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalytics } from '@/hooks/use-analytics';
import { startOfMonth, startOfYear, endOfMonth, subMonths, format } from 'date-fns';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { translateCategoryGroup } from '@/lib/category-i18n';
import { formatCurrency } from '@/lib/utils';
import { buildGroupColorMap } from '@/lib/portfolio-utils';
import {
  EXPENSE_TYPES,
  aggregateExpenseGroups,
  buildExpenseBreakdown,
} from '@/lib/expense-breakdown';

type ChartPeriod = 'year' | 'month' | 'prev_month' | 'quarter';

const OTHER_COLOR = 'hsl(var(--muted-foreground))';

const RADIAN = Math.PI / 180;

function renderPieLabel({
  cx, cy, midAngle, outerRadius, percent, name,
}: {
  cx: number; cy: number; midAngle: number;
  outerRadius: number; percent: number; name: string;
}) {
  if (percent < 0.05) return null;
  const radius = outerRadius + 28;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text
      x={x} y={y}
      fill="hsl(var(--muted-foreground))"
      textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central"
      style={{ fontSize: '11px', fontWeight: 400 }}
    >
      {`${name} ${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { name: string; percentage: number } }> }) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card/95 border border-border rounded-lg px-3 py-2 shadow-lg">
      <p className="text-sm font-medium text-foreground">{d.name}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{d.percentage}% {t('expenseSplit.ofSpending')}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{t('expenseSplit.basis')}</p>
    </div>
  );
}

const PERIOD_LABEL_KEYS: Record<ChartPeriod, string> = {
  year: 'expenseSplit.thisYear',
  month: 'expenseSplit.thisMonth',
  prev_month: 'expenseSplit.lastMonth',
  quarter: 'expenseSplit.last3Months',
};

interface ExpenseSplitCardProps {
  currency: string;
  year?: string;
  className?: string;
}

export function ExpenseSplitCard({ currency, year, className }: ExpenseSplitCardProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<ChartPeriod>('year');

  const { startMonth, endMonth } = useMemo(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const targetYear = year ? parseInt(year, 10) : currentYear;
    switch (period) {
      case 'year': {
        const isHistorical = targetYear < currentYear;
        return {
          startMonth: `${targetYear}-01`,
          endMonth: isHistorical ? `${targetYear}-12` : format(endOfMonth(now), 'yyyy-MM'),
        };
      }
      case 'month':
        return {
          startMonth: format(startOfMonth(now), 'yyyy-MM'),
          endMonth: format(endOfMonth(now), 'yyyy-MM'),
        };
      case 'prev_month': {
        const prevMonth = subMonths(now, 1);
        return {
          startMonth: format(startOfMonth(prevMonth), 'yyyy-MM'),
          endMonth: format(endOfMonth(prevMonth), 'yyyy-MM'),
        };
      }
      case 'quarter': {
        const lastQuarter = subMonths(now, 3);
        return {
          startMonth: format(startOfMonth(lastQuarter), 'yyyy-MM'),
          endMonth: format(endOfMonth(now), 'yyyy-MM'),
        };
      }
    }
  }, [period, year]);

  const { data: analyticsData, isLoading } = useAnalytics({
    view: 'month',
    currency,
    startMonth,
    endMonth,
    types: [...EXPENSE_TYPES],
  });

  // #140: always debits − credits (no toggle here), same helper as the Expenses page.
  const breakdown = useMemo(
    () => buildExpenseBreakdown(
      aggregateExpenseGroups(analyticsData?.data, EXPENSE_TYPES, 'net'),
      { maxSlices: 7, otherLabel: t('common.other') },
    ),
    [analyticsData, t],
  );

  const chartData = useMemo(() => {
    const colors = buildGroupColorMap(breakdown.allGroups, new Set());
    return breakdown.slices.map(d => ({
      ...d,
      color: d.isOther ? OTHER_COLOR : colors[d.name] ?? OTHER_COLOR,
      name: d.isOther ? d.name : translateCategoryGroup(t, d.name),
    }));
  }, [breakdown, t]);

  const netCreditTotal = breakdown.netCredits.reduce((sum, g) => sum + g.value, 0);

  return (
    <Card className={`h-full ${className ?? ''}`}>
      <CardHeader>
        <div className="flex items-center justify-between w-full">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-lg font-medium">{t('expenseSplit.title')}</CardTitle>
            <span className="text-[0.8125rem] text-muted-foreground">
              {t(PERIOD_LABEL_KEYS[period])}
            </span>
          </div>
          <Select value={period} onValueChange={(v) => setPeriod(v as ChartPeriod)}>
            <SelectTrigger className="w-[130px] h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="year">{t('expenseSplit.thisYear')}</SelectItem>
                <SelectItem value="month">{t('expenseSplit.thisMonth')}</SelectItem>
                <SelectItem value="prev_month">{t('expenseSplit.lastMonth')}</SelectItem>
                <SelectItem value="quarter">{t('expenseSplit.last3Months')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>

      <CardDivider />

      <div className="px-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Skeleton className="w-full aspect-[4/3] max-h-60" />
          </div>
        ) : breakdown.allGroups.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t('expenseSplit.noData')}</p>
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t('expenseSplit.noNetSpend')}</p>
          </div>
        ) : (
          <>
            {/* Chart container */}
            <div className="w-full aspect-[4/3] max-h-60 overflow-visible relative">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 18, right: 36, bottom: 18, left: 36 }}>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    outerRadius="52%"
                    innerRadius="30%"
                    paddingAngle={3}
                    dataKey="value"
                    label={renderPieLabel}
                    labelLine={false}
                    strokeWidth={0}
                  >
                    {chartData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <CardDivider />

            {/* Legend grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 py-2">
              {chartData.map((d) => (
                <div key={d.name} className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: d.color }}
                  />
                  <span className="text-xs text-muted-foreground truncate">{d.name}</span>
                  <span className="text-xs font-medium text-brand-primary ml-auto">{d.percentage}%</span>
                </div>
              ))}
            </div>
            {breakdown.netCredits.length > 0 && (
              <p className="text-xs text-muted-foreground pb-2" data-testid="expense-split-net-credits">
                {t('expenseSplit.netCredits')}:{' '}
                <span className="font-medium text-positive">{formatCurrency(netCreditTotal, currency)}</span>
              </p>
            )}
          </>
        )}
      </div>

      <div className="px-6 pb-4 pt-2">
        <Link
          to="/reports/expenses"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-primary hover:underline"
        >
          {t('expenseSplit.viewExpenses')}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </Card>
  );
}

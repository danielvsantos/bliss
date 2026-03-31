import { useState, useMemo } from 'react';
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
import { startOfMonth, endOfMonth, subMonths, format } from 'date-fns';
import type { AnalyticsResponse } from '@/types/api';

type ChartPeriod = 'month' | 'prev_month' | 'quarter';

// Design-token-aligned colors
const CHART_COLORS = ['#3A3542', '#2E8B57', '#E5989B', '#6D657A', '#E09F12', '#9A95A4'];

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

function ChartTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card/95 border border-border rounded-lg px-3 py-2 shadow-lg">
      <p className="text-sm font-medium text-foreground">{d.name}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{d.percentage}% of spending</p>
    </div>
  );
}

const processAnalyticsData = (analyticsData: AnalyticsResponse | undefined) => {
  if (!analyticsData?.data) return [];

  const expenseGroups: Record<string, number> = {};

  for (const timeKey in analyticsData.data) {
    const periodData = analyticsData.data[timeKey];
    const essentials = periodData['Essentials'] || {};
    const lifestyle = periodData['Lifestyle'] || {};
    const expenseData = { ...essentials, ...lifestyle };
    for (const groupKey in expenseData) {
      expenseGroups[groupKey] = (expenseGroups[groupKey] ?? 0) + expenseData[groupKey].debit;
    }
  }

  const total = Object.values(expenseGroups).reduce((s, v) => s + v, 0);

  return Object.entries(expenseGroups)
    .map(([name, value], index) => ({
      name,
      value,
      percentage: total > 0 ? parseFloat(((value / total) * 100).toFixed(1)) : 0,
      color: CHART_COLORS[index % CHART_COLORS.length],
    }))
    .sort((a, b) => b.value - a.value);
};

const PERIOD_LABELS: Record<ChartPeriod, string> = {
  month: 'This month',
  prev_month: 'Last month',
  quarter: 'Last 3 months',
};

interface ExpenseSplitCardProps {
  currency: string;
  className?: string;
}

export function ExpenseSplitCard({ currency, className }: ExpenseSplitCardProps) {
  const [period, setPeriod] = useState<ChartPeriod>('month');

  const { startMonth, endMonth } = useMemo(() => {
    const now = new Date();
    switch (period) {
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
  }, [period]);

  const { data: analyticsData, isLoading } = useAnalytics({
    view: 'month',
    currency,
    startMonth,
    endMonth,
    types: ['Essentials', 'Lifestyle'],
  });

  const chartData = useMemo(() => processAnalyticsData(analyticsData), [analyticsData]);

  return (
    <Card className={`h-full ${className ?? ''}`}>
      <CardHeader>
        <div className="flex items-center justify-between w-full">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-lg font-medium">Expense Split</CardTitle>
            <span className="text-[0.8125rem] text-muted-foreground">
              {PERIOD_LABELS[period]}
            </span>
          </div>
          <Select value={period} onValueChange={(v) => setPeriod(v as ChartPeriod)}>
            <SelectTrigger className="w-[120px] h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="month">This month</SelectItem>
                <SelectItem value="prev_month">Last month</SelectItem>
                <SelectItem value="quarter">Last 3 months</SelectItem>
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
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">No spending data for this period.</p>
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
          </>
        )}
      </div>

      <div className="pb-2" />
    </Card>
  );
}

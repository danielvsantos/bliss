import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { TrendingUp, ChevronUp, ChevronDown } from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { motion } from 'framer-motion';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import { useEquityAnalysis } from '@/hooks/use-equity-analysis';
import { formatCurrency, formatPercentage } from '@/lib/utils';
import type { EquityHolding } from '@/types/equity-analysis';

/* ── Dataviz palette (design tokens) ── */
const CHART_COLORS = ['#6D657A', '#2E8B57', '#E09F12', '#3A3542', '#3A8A8F', '#B8AEC8', '#7E7590', '#9A95A4'];

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4 },
};

const GROUPING_KEYS = ['sector', 'industry', 'country'] as const;

type SortField = 'symbol' | 'name' | 'currentValue' | 'weight' | 'peRatio' | 'dividendYield' | 'trailingEps' | 'week52High' | 'week52Low';

function SortChevron({ dir }: { dir: 'asc' | 'desc' | null }) {
  if (!dir) return <span className="ml-1 w-3" />;
  return dir === 'asc'
    ? <ChevronUp className="ml-1 inline h-3 w-3" />
    : <ChevronDown className="ml-1 inline h-3 w-3" />;
}

/* ── Custom Pie label ── */
const RADIAN = Math.PI / 180;

interface PieLabelProps {
  cx: number; cy: number; midAngle: number;
  innerRadius: number; outerRadius: number;
  percent: number; name: string;
}

function renderCustomLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }: PieLabelProps) {
  if (percent < 0.04) return null;
  const radius = innerRadius + (outerRadius - innerRadius) * 1.3;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="var(--brand-deep)" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" className="text-xs">
      {name} ({(percent * 100).toFixed(1)}%)
    </text>
  );
}

/* ── Custom Tooltip ── */
interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { name: string; value: number; weight: number } }>;
  currency?: string;
}

function ChartTooltip({ active, payload, currency }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  const { name, value, weight } = payload[0].payload;
  return (
    <div className="rounded-lg border bg-white px-3 py-2 shadow-sm text-sm">
      <p className="font-medium text-brand-deep">{name}</p>
      <p className="text-muted-foreground">{formatCurrency(value, currency)} ({formatPercentage(weight * 100)})</p>
    </div>
  );
}

export default function EquityAnalysisPage() {
  const { t } = useTranslation();
  const [groupBy, setGroupBy] = useState<string>('sector');
  const [sortField, setSortField] = useState<SortField>('currentValue');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const { data, isLoading, error } = useEquityAnalysis(groupBy);

  const portfolioCurrency = data?.portfolioCurrency ?? 'USD';
  const summary = data?.summary;
  const groups = useMemo(() => data?.groups ?? [], [data?.groups]);

  // Flatten all holdings for the table
  const allHoldings = useMemo(() => {
    return groups.flatMap((g) => g.holdings);
  }, [groups]);

  // Sorted holdings
  const sortedHoldings = useMemo(() => {
    return [...allHoldings].sort((a, b) => {
      const aVal = a[sortField] ?? -Infinity;
      const bVal = b[sortField] ?? -Infinity;
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortOrder === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  }, [allHoldings, sortField, sortOrder]);

  // Donut chart data
  const donutData = useMemo(() => {
    return groups.map((g) => ({
      name: g.name,
      value: g.totalValue,
      weight: g.weight,
    }));
  }, [groups]);

  // Top 10 bar chart data
  const topHoldings = useMemo(() => {
    return [...allHoldings]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10)
      .map((h) => ({
        symbol: h.symbol,
        name: h.name,
        weight: h.weight * 100,
        value: h.currentValue,
      }));
  }, [allHoldings]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const SortableHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <th
      className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-brand-deep whitespace-nowrap"
      onClick={() => handleSort(field)}
    >
      {children}
      <SortChevron dir={sortField === field ? sortOrder : null} />
    </th>
  );

  if (error) {
    return (
      <div className="p-6">
        <p className="text-destructive">{t('equityAnalysis.loadFailed')}</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col space-y-8">
      {/* ── Page Title ── */}
      <div>
        <h2 className="text-3xl font-bold tracking-tight mb-2">{t('equityAnalysis.title')}</h2>
        <p className="text-muted-foreground">{t('equityAnalysis.subtitle')}</p>
      </div>

      <div className="space-y-6">
        {/* ── Summary Cards ── */}
        <motion.div {...fadeUp} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('equityAnalysis.totalEquityValue')}</p>
              {isLoading ? (
                <Skeleton className="h-7 w-32 mt-1" />
              ) : (
                <p className="text-xl font-bold text-brand-deep mt-1">
                  {formatCurrency(summary?.totalEquityValue ?? 0, portfolioCurrency)}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('equityAnalysis.holdings')}</p>
              {isLoading ? (
                <Skeleton className="h-7 w-16 mt-1" />
              ) : (
                <p className="text-xl font-bold text-brand-deep mt-1">{summary?.holdingsCount ?? 0}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('equityAnalysis.avgPE')}</p>
              {isLoading ? (
                <Skeleton className="h-7 w-16 mt-1" />
              ) : (
                <p className="text-xl font-bold text-brand-deep mt-1">
                  {summary?.weightedPeRatio != null ? summary.weightedPeRatio.toFixed(1) : '—'}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('equityAnalysis.avgDividendYield')}</p>
              {isLoading ? (
                <Skeleton className="h-7 w-16 mt-1" />
              ) : (
                <p className="text-xl font-bold text-brand-deep mt-1">
                  {summary?.weightedDividendYield != null
                    ? `${(summary.weightedDividendYield * 100).toFixed(2)}%`
                    : '—'}
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* ── Grouping selector ── */}
        <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.05 }}>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('equityAnalysis.groupBy')}</span>
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
              {GROUPING_KEYS.map((key) => (
                <button
                  key={key}
                  onClick={() => setGroupBy(key)}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    groupBy === key
                      ? 'bg-primary text-white font-medium'
                      : 'text-muted-foreground hover:text-brand-deep'
                  }`}
                >
                  {t(`equityAnalysis.${key}`)}
                </button>
              ))}
            </div>
          </div>
        </motion.div>

        {/* ── Charts Row ── */}
        <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.1 }} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Donut Chart */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('equityAnalysis.allocationBy', { grouping: t(`equityAnalysis.${groupBy}`) })}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-[280px] w-full rounded" />
              ) : donutData.length === 0 ? (
                <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
                  {t('equityAnalysis.noStockHoldings')}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={donutData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      dataKey="value"
                      label={renderCustomLabel}
                      labelLine={false}
                    >
                      {donutData.map((_, idx) => (
                        <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip currency={portfolioCurrency} />} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Top Holdings Bar Chart */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('equityAnalysis.top10')}</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-[280px] w-full rounded" />
              ) : topHoldings.length === 0 ? (
                <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
                  {t('equityAnalysis.noStockHoldings')}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={topHoldings} layout="vertical" margin={{ left: 50, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => `${v.toFixed(0)}%`} />
                    <YAxis type="category" dataKey="symbol" width={50} tick={{ fontSize: 12 }} />
                    <Tooltip
                      formatter={(value: number) => [`${value.toFixed(1)}%`, t('equityAnalysis.weight')]}
                      labelFormatter={(label) => {
                        const h = topHoldings.find((t) => t.symbol === label);
                        return h ? `${h.name} (${h.symbol})` : label;
                      }}
                    />
                    <Bar dataKey="weight" radius={[0, 4, 4, 0]}>
                      {topHoldings.map((_, idx) => (
                        <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* ── Holdings Table ── */}
        <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.15 }}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('equityAnalysis.allHoldings')}</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {isLoading ? (
                <div className="px-4 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : sortedHoldings.length === 0 ? (
                <p className="text-center text-muted-foreground py-8 text-sm">
                  {t('equityAnalysis.noHoldingsHint')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <SortableHeader field="symbol">{t('equityAnalysis.symbol')}</SortableHeader>
                        <SortableHeader field="name">{t('equityAnalysis.name')}</SortableHeader>
                        <th className="hidden md:table-cell px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('equityAnalysis.sector')}
                        </th>
                        <th className="hidden lg:table-cell px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('equityAnalysis.industry')}
                        </th>
                        <th className="hidden sm:table-cell px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-brand-deep whitespace-nowrap" onClick={() => handleSort('peRatio')}>
                          {t('equityAnalysis.pe')}<SortChevron dir={sortField === 'peRatio' ? sortOrder : null} />
                        </th>
                        <th className="hidden md:table-cell px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-brand-deep whitespace-nowrap" onClick={() => handleSort('dividendYield')}>
                          {t('equityAnalysis.divYield')}<SortChevron dir={sortField === 'dividendYield' ? sortOrder : null} />
                        </th>
                        <th className="hidden lg:table-cell px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-brand-deep whitespace-nowrap" onClick={() => handleSort('trailingEps')}>
                          {t('equityAnalysis.eps')}<SortChevron dir={sortField === 'trailingEps' ? sortOrder : null} />
                        </th>
                        <th className="hidden lg:table-cell px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                          {t('equityAnalysis.weekRange')}
                        </th>
                        <SortableHeader field="weight">{t('equityAnalysis.weight')}</SortableHeader>
                        <SortableHeader field="currentValue">{t('equityAnalysis.value')}</SortableHeader>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedHoldings.map((h: EquityHolding) => (
                        <tr key={h.symbol} className="border-b border-gray-50 hover:bg-accent/40 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-brand-deep">{h.symbol}</td>
                          <td className="px-3 py-2.5 text-muted-foreground max-w-[120px] sm:max-w-[160px] truncate">{h.name}</td>
                          <td className="hidden md:table-cell px-3 py-2.5 text-muted-foreground text-xs">{h.sector}</td>
                          <td className="hidden lg:table-cell px-3 py-2.5 text-muted-foreground text-xs max-w-[140px] truncate">{h.industry}</td>
                          <td className="hidden sm:table-cell px-3 py-2.5 tabular-nums">
                            {h.peRatio != null ? h.peRatio.toFixed(1) : '—'}
                          </td>
                          <td className="hidden md:table-cell px-3 py-2.5 tabular-nums">
                            {h.dividendYield != null ? `${(h.dividendYield * 100).toFixed(2)}%` : '—'}
                          </td>
                          <td className="hidden lg:table-cell px-3 py-2.5 tabular-nums">
                            <span className={h.trailingEps != null && h.trailingEps > 0 ? 'text-positive' : h.trailingEps != null && h.trailingEps < 0 ? 'text-negative' : ''}>
                              {h.trailingEps != null ? h.trailingEps.toFixed(2) : '—'}
                            </span>
                          </td>
                          <td className="hidden lg:table-cell px-3 py-2.5 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                            {h.week52Low != null && h.week52High != null
                              ? `${formatCurrency(h.week52Low, portfolioCurrency, undefined, { maximumFractionDigits: 0 })} – ${formatCurrency(h.week52High, portfolioCurrency, undefined, { maximumFractionDigits: 0 })}`
                              : '—'}
                          </td>
                          <td className="px-3 py-2.5 tabular-nums font-medium">
                            {formatPercentage(h.weight * 100)}
                          </td>
                          <td className="px-3 py-2.5 tabular-nums font-medium text-brand-deep">
                            {formatCurrency(h.currentValue, portfolioCurrency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
      </div>
    </div>
  );
}

import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { TrendingUp, ChevronUp, ChevronDown, Loader2 } from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { motion } from 'framer-motion';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ASSET_CLASS_COLORS } from '@/components/equity-analysis/asset-class-colors';
import { AssetClassEditor } from '@/components/equity-analysis/asset-class-editor';

import { useEquityAnalysis } from '@/hooks/use-equity-analysis';
import { buildGroupColorMap, getGroupColor } from '@/lib/portfolio-utils';
import { formatCurrency, formatPercentage } from '@/lib/utils';
import { ASSET_CLASSES, type EquityHolding } from '@/types/equity-analysis';

/** Buckets the API uses for ETFs that can't be looked through, and for the look-through remainder (#79). */
const DIVERSIFIED = 'Diversified';
const LOOK_THROUGH_OTHER = 'Other';
const FIXED_INCOME_BUCKET = 'Fixed Income';
const ASSET_CLASS_SET = new Set<string>(ASSET_CLASSES);

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4 },
};

const GROUPING_KEYS = ['sector', 'industry', 'country', 'assetClass'] as const;

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

  // "Look through ETFs" (#79), on by default, persisted in the URL (?lookThrough=0).
  const [searchParams, setSearchParams] = useSearchParams();
  const lookThrough = searchParams.get('lookThrough') !== '0';
  const setLookThrough = (on: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (on) next.delete('lookThrough');
    else next.set('lookThrough', '0');
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, isFetching, error } = useEquityAnalysis(groupBy, { lookThrough });
  // Cached equity values are on screen and a background refetch is running.
  const isRefreshing = isFetching && !isLoading;

  const portfolioCurrency = data?.portfolioCurrency ?? 'USD';
  const summary = data?.summary;
  const groups = useMemo(() => data?.groups ?? [], [data?.groups]);

  // Every holding once (with look-through an ETF can sit in several groups)
  const allHoldings = useMemo(
    () => data?.holdings ?? groups.flatMap((g) => g.holdings),
    [data?.holdings, groups],
  );

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

  // API bucket names that need translating: "Diversified" ETFs, the
  // look-through "Other" remainder, bond ETFs and asset class keys.
  const groupLabel = useCallback(
    (name: string) => {
      if (name === DIVERSIFIED) return t('equityAnalysis.diversified');
      if (name === LOOK_THROUGH_OTHER) return t('equityAnalysis.lookThroughOther');
      if (name === FIXED_INCOME_BUCKET) return t('equityAnalysis.fixedIncomeBucket');
      if (groupBy === 'assetClass' && ASSET_CLASS_SET.has(name)) return t(`equityAnalysis.assetClasses.${name}`);
      return name;
    },
    [t, groupBy],
  );

  // Donut chart data — dataviz colors, stable per group name (asset classes
  // share the composition card's colors).
  const donutData = useMemo(() => {
    const colorMap = groupBy === 'assetClass'
      ? ASSET_CLASS_COLORS
      : buildGroupColorMap(groups.map((g) => g.name), new Set());
    return groups.map((g) => ({
      name: groupLabel(g.name),
      value: g.totalValue,
      weight: g.weight,
      color: colorMap[g.name],
    }));
  }, [groups, groupLabel, groupBy]);

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

  // O(1) lookup map for the bar chart tooltip (symbol → holding)
  const topHoldingsMap = useMemo(
    () => new Map(topHoldings.map((h) => [h.symbol, h])),
    [topHoldings],
  );

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
                <p className="flex items-center gap-2 text-xl font-bold text-brand-deep mt-1">
                  {formatCurrency(summary?.totalEquityValue ?? 0, portfolioCurrency)}
                  {isRefreshing && (
                    <Loader2
                      className="h-4 w-4 animate-spin text-muted-foreground"
                      aria-label={t('common.refreshing', 'Refreshing')}
                    />
                  )}
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

        {/* ── Grouping selector + look-through toggle ── */}
        <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.05 }}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('equityAnalysis.groupBy')}</span>
            <div className="inline-flex flex-wrap rounded-lg border border-gray-200 bg-white p-0.5">
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
          {/* Only when some ETF has composition data — otherwise the switch would do nothing. */}
          {data?.lookThroughAvailable && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground" title={t('equityAnalysis.lookThroughHint')}>
              <Switch
                checked={lookThrough}
                onCheckedChange={setLookThrough}
                aria-label={t('equityAnalysis.lookThrough')}
              />
              {t('equityAnalysis.lookThrough')}
            </label>
          )}
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
                      {donutData.map((d, idx) => (
                        <Cell key={idx} fill={d.color} />
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
                        const h = topHoldingsMap.get(label);
                        return h ? `${h.name} (${h.symbol})` : label;
                      }}
                    />
                    <Bar dataKey="weight" radius={[0, 4, 4, 0]}>
                      {topHoldings.map((h, idx) => (
                        <Cell key={h.symbol} fill={getGroupColor(h.symbol, false, idx)} />
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
                          <td className="px-3 py-2.5 font-medium text-brand-deep whitespace-nowrap">
                            <span className="inline-flex flex-col items-start gap-0.5 sm:flex-row sm:items-center sm:gap-1.5">
                            {h.symbol}
                            {h.assetClass ? (
                              <AssetClassEditor holding={h} />
                            ) : h.assetType === 'ETF' && (
                              <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px] bg-brand-primary/10 text-brand-primary border-brand-primary/20">
                                {t('equityAnalysis.etfBadge')}
                              </Badge>
                            )}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground max-w-[120px] sm:max-w-[160px] truncate">{h.name}</td>
                          <td className="hidden md:table-cell px-3 py-2.5 text-muted-foreground text-xs">{groupLabel(h.sector)}</td>
                          <td className="hidden lg:table-cell px-3 py-2.5 text-muted-foreground text-xs max-w-[140px] truncate">{groupLabel(h.industry)}</td>
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

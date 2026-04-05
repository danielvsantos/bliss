import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { Hash, GitCompareArrows } from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { motion } from 'framer-motion';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';

import { useTags } from '@/hooks/use-tags';
import { useTagAnalytics } from '@/hooks/use-tag-analytics';
import { formatCurrency } from '@/lib/utils';
import { getTenantMeta } from '@/utils/tenantMetaStorage';
import type { Tag, Currency } from '@/types/api';

const CHART_COLORS = ['#3A3542', '#2E8B57', '#E5989B', '#6D657A', '#E09F12', '#9A95A4', '#3A8A8F', '#B8AEC8'];
const RADIAN = Math.PI / 180;

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4 },
};

type TagAnalyticsData = Record<string, Record<string, Record<string, Record<string, { credit: number; debit: number; balance: number }>>>>;

function processTagData(tagData: TagAnalyticsData | undefined) {
  if (!tagData) return { categories: [], totalDebit: 0, totalCredit: 0, totalBalance: 0, highestCategory: '' };

  const categoryTotals: Record<string, number> = {};
  let totalDebit = 0;
  let totalCredit = 0;
  let totalBalance = 0;

  for (const timeMap of Object.values(tagData)) {
    for (const groupMap of Object.values(timeMap)) {
      for (const catMap of Object.values(groupMap)) {
        for (const [categoryName, values] of Object.entries(catMap)) {
          categoryTotals[categoryName] = (categoryTotals[categoryName] || 0) + values.debit;
          totalDebit += values.debit;
          totalCredit += values.credit;
          totalBalance += values.balance;
        }
      }
    }
  }

  const sorted = Object.entries(categoryTotals)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // Top 7 + Other (more categories visible now that we have granularity)
  const topN = sorted.slice(0, 7);
  const otherValue = sorted.slice(7).reduce((sum, g) => sum + g.value, 0);
  if (otherValue > 0) topN.push({ name: 'Other', value: otherValue });

  const total = topN.reduce((sum, g) => sum + g.value, 0);
  const categories = topN.map((g, i) => ({
    ...g,
    color: CHART_COLORS[i % CHART_COLORS.length],
    percentage: total > 0 ? ((g.value / total) * 100).toFixed(1) : '0',
  }));

  return {
    categories,
    totalDebit,
    totalCredit,
    totalBalance,
    highestCategory: sorted[0]?.name || '',
  };
}

function processMonthlyTimeline(tagData: TagAnalyticsData | undefined) {
  if (!tagData) return [];

  const monthlyTotals: Record<string, { month: string; balance: number }> = {};

  for (const [timeKey, typeMap] of Object.entries(tagData)) {
    if (!monthlyTotals[timeKey]) {
      monthlyTotals[timeKey] = { month: timeKey, balance: 0 };
    }
    for (const groupMap of Object.values(typeMap)) {
      for (const catMap of Object.values(groupMap)) {
        for (const values of Object.values(catMap)) {
          monthlyTotals[timeKey].balance += values.balance;
        }
      }
    }
  }

  return Object.values(monthlyTotals).sort((a, b) => a.month.localeCompare(b.month));
}

const renderPieLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }: any) => {
  if (percent < 0.05) return null;
  const radius = innerRadius + (outerRadius - innerRadius) * 1.4;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="hsl(var(--foreground))" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={11}>
      {name} ({(percent * 100).toFixed(0)}%)
    </text>
  );
};

function TagSelector({ tags, selectedId, onSelect, label }: {
  tags: Tag[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = tags.find(t => t.id === selectedId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="min-w-[200px] justify-start">
          {selected ? (
            <span className="flex items-center gap-2">
              {selected.emoji && <span>{selected.emoji}</span>}
              {selected.name}
            </span>
          ) : (
            <span className="text-muted-foreground">{label}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[250px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search tags..." />
          <CommandList>
            <CommandEmpty>No tags found.</CommandEmpty>
            <CommandGroup>
              {tags.map(tag => (
                <CommandItem
                  key={tag.id}
                  value={tag.name}
                  onSelect={() => {
                    onSelect(tag.id === selectedId ? null : tag.id);
                    setOpen(false);
                  }}
                >
                  <span className="flex items-center gap-2">
                    {tag.emoji && <span>{tag.emoji}</span>}
                    {tag.name}
                    {tag.budget && (
                      <Badge variant="secondary" className="ml-auto text-xs">
                        {formatCurrency(tag.budget)}
                      </Badge>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function TagAnalyticsPage() {
  const { t } = useTranslation();
  const { data: tags = [] } = useTags();
  const tenantMeta = getTenantMeta();
  const availableCurrencies: Currency[] = tenantMeta?.currencies || [];

  const [primaryTagId, setPrimaryTagId] = useState<number | null>(null);
  const [compareTagId, setCompareTagId] = useState<number | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [currency, setCurrency] = useState(availableCurrencies[0]?.id || 'USD');

  const primaryTag = tags.find(t => t.id === primaryTagId);
  const compareTag = tags.find(t => t.id === compareTagId);

  // Only send date range if the tag has explicit startDate/endDate
  const dateRange = useMemo(() => {
    if (primaryTag?.startDate && primaryTag?.endDate) {
      const start = new Date(primaryTag.startDate);
      const end = new Date(primaryTag.endDate);
      return {
        startMonth: format(startOfMonth(start), 'yyyy-MM'),
        endMonth: format(endOfMonth(end), 'yyyy-MM'),
      };
    }
    return { startMonth: undefined, endMonth: undefined };
  }, [primaryTag]);

  const tagIds = useMemo(() => {
    const ids: number[] = [];
    if (primaryTagId) ids.push(primaryTagId);
    if (compareMode && compareTagId) ids.push(compareTagId);
    return ids;
  }, [primaryTagId, compareTagId, compareMode]);

  const { data: analyticsData, isLoading } = useTagAnalytics({
    tagIds,
    view: 'month',
    startMonth: dateRange.startMonth,
    endMonth: dateRange.endMonth,
    currency,
  });

  const primaryData = primaryTagId ? analyticsData?.tags?.[primaryTagId.toString()] : undefined;
  const compareData = compareTagId && compareMode ? analyticsData?.tags?.[compareTagId.toString()] : undefined;

  const primaryProcessed = useMemo(() => processTagData(primaryData), [primaryData]);
  const compareProcessed = useMemo(() => processTagData(compareData), [compareData]);

  const primaryTimeline = useMemo(() => processMonthlyTimeline(primaryData), [primaryData]);
  const compareTimeline = useMemo(() => processMonthlyTimeline(compareData), [compareData]);

  const budgetProgress = primaryTag?.budget
    ? Math.min((primaryProcessed.totalDebit / primaryTag.budget) * 100, 100)
    : null;

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col space-y-8">
      {/* Header */}
      <motion.div {...fadeUp}>
        <div>
          <h2 className="text-3xl font-bold tracking-tight mb-2">Tag Analytics</h2>
          <p className="text-muted-foreground">Analyze spending by tag across all accounts and currencies</p>
        </div>
      </motion.div>

      {/* Filters */}
      <motion.div {...fadeUp} transition={{ delay: 0.1 }} className="flex flex-wrap items-center gap-3">
        <TagSelector tags={tags} selectedId={primaryTagId} onSelect={setPrimaryTagId} label="Select a tag..." />

        <Button
          variant={compareMode ? 'default' : 'outline'}
          size="sm"
          onClick={() => {
            setCompareMode(!compareMode);
            if (compareMode) setCompareTagId(null);
          }}
        >
          <GitCompareArrows size={16} className="mr-1.5" />
          Compare
        </Button>

        {compareMode && (
          <TagSelector
            tags={tags.filter(t => t.id !== primaryTagId)}
            selectedId={compareTagId}
            onSelect={setCompareTagId}
            label="Compare with..."
          />
        )}

        <Select value={currency} onValueChange={setCurrency}>
          <SelectTrigger className="w-[100px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableCurrencies.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.symbol} {c.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {primaryTag?.startDate && primaryTag?.endDate && (
          <Badge className="bg-brand-primary/10 text-brand-primary border-brand-primary/20">
            {format(new Date(primaryTag.startDate), 'MMM d')} — {format(new Date(primaryTag.endDate), 'MMM d, yyyy')}
          </Badge>
        )}
      </motion.div>

      {/* Empty state */}
      {!primaryTagId && (
        <motion.div {...fadeUp} transition={{ delay: 0.2 }}>
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Hash size={48} className="text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium text-muted-foreground">Select a tag to view analytics</h3>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Choose a tag above to see spending breakdowns, trends, and budget tracking
              </p>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Analytics content */}
      {primaryTagId && (
        <>
          {/* Summary Cards */}
          <div className={`grid gap-4 ${compareMode && compareTagId ? 'grid-cols-2' : 'grid-cols-3 lg:grid-cols-6'}`}>
            {/* Primary tag — Total Debit */}
            <motion.div {...fadeUp} transition={{ delay: 0.2 }}>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Total Debit {primaryTag?.emoji && <span className="ml-1">{primaryTag.emoji}</span>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-8 w-32" />
                  ) : (
                    <p className="text-2xl font-bold text-negative">
                      {formatCurrency(primaryProcessed.totalDebit, currency)}
                    </p>
                  )}
                </CardContent>
              </Card>
            </motion.div>

            {/* Primary tag — Total Credit */}
            <motion.div {...fadeUp} transition={{ delay: 0.25 }}>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Total Credit {primaryTag?.emoji && <span className="ml-1">{primaryTag.emoji}</span>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-8 w-32" />
                  ) : (
                    <p className="text-2xl font-bold text-positive">
                      {formatCurrency(primaryProcessed.totalCredit, currency)}
                    </p>
                  )}
                </CardContent>
              </Card>
            </motion.div>

            {/* Primary tag — Balance */}
            <motion.div {...fadeUp} transition={{ delay: 0.3 }}>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Balance {primaryTag?.emoji && <span className="ml-1">{primaryTag.emoji}</span>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-8 w-32" />
                  ) : (
                    <p className={`text-2xl font-bold ${primaryProcessed.totalBalance >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {formatCurrency(primaryProcessed.totalBalance, currency)}
                    </p>
                  )}
                </CardContent>
              </Card>
            </motion.div>

            {/* Budget progress (only when not in compare mode) */}
            {!compareMode && primaryTag?.budget && (
              <motion.div {...fadeUp} transition={{ delay: 0.35 }}>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Budget Progress</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-bold">
                      {budgetProgress !== null ? `${budgetProgress.toFixed(0)}%` : '—'}
                    </p>
                    <Progress value={budgetProgress ?? 0} className="mt-2" />
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatCurrency(primaryProcessed.totalDebit, currency)} of {formatCurrency(primaryTag.budget, currency)}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {/* Top category (only when not in compare mode) */}
            {!compareMode && (
              <motion.div {...fadeUp} transition={{ delay: 0.4 }}>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Top Category</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isLoading ? (
                      <Skeleton className="h-8 w-24" />
                    ) : (
                      <p className="text-2xl font-bold">{primaryProcessed.highestCategory || '—'}</p>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {/* Compare tag summary */}
            {compareMode && compareTagId && (
              <>
                <motion.div {...fadeUp} transition={{ delay: 0.35 }}>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Total Debit {compareTag?.emoji && <span className="ml-1">{compareTag.emoji}</span>}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {isLoading ? (
                        <Skeleton className="h-8 w-32" />
                      ) : (
                        <p className="text-2xl font-bold text-negative">
                          {formatCurrency(compareProcessed.totalDebit, currency)}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
                <motion.div {...fadeUp} transition={{ delay: 0.4 }}>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Total Credit {compareTag?.emoji && <span className="ml-1">{compareTag.emoji}</span>}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {isLoading ? (
                        <Skeleton className="h-8 w-32" />
                      ) : (
                        <p className="text-2xl font-bold text-positive">
                          {formatCurrency(compareProcessed.totalCredit, currency)}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
                <motion.div {...fadeUp} transition={{ delay: 0.45 }}>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Balance {compareTag?.emoji && <span className="ml-1">{compareTag.emoji}</span>}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {isLoading ? (
                        <Skeleton className="h-8 w-32" />
                      ) : (
                        <p className={`text-2xl font-bold ${compareProcessed.totalBalance >= 0 ? 'text-positive' : 'text-negative'}`}>
                          {formatCurrency(compareProcessed.totalBalance, currency)}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              </>
            )}
          </div>

          {/* Charts */}
          <div className={`grid gap-4 ${compareMode && compareTagId ? 'grid-cols-2' : 'grid-cols-1 lg:grid-cols-2'}`}>
            {/* Primary pie chart */}
            <motion.div {...fadeUp} transition={{ delay: 0.5 }}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="text-base">
                    {primaryTag?.name} — Category Breakdown
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-[300px] w-full" />
                  ) : primaryProcessed.categories.length === 0 ? (
                    <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">
                      No spending data for this tag
                    </div>
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height={300}>
                        <PieChart>
                          <Pie
                            data={primaryProcessed.categories}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            outerRadius="52%"
                            innerRadius="30%"
                            paddingAngle={3}
                            label={renderPieLabel}
                            labelLine={false}
                          >
                            {primaryProcessed.categories.map((entry, index) => (
                              <Cell key={index} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip
                            formatter={(value: number) => formatCurrency(value, currency)}
                            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-4">
                        {primaryProcessed.categories.map((g, i) => (
                          <div key={i} className="flex items-center gap-2 text-sm">
                            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: g.color }} />
                            <span className="truncate text-muted-foreground">{g.name}</span>
                            <span className="ml-auto font-medium">{g.percentage}%</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </motion.div>

            {/* Compare pie chart or monthly timeline */}
            {compareMode && compareTagId ? (
              <motion.div {...fadeUp} transition={{ delay: 0.6 }}>
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle className="text-base">
                      {compareTag?.name} — Category Breakdown
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isLoading ? (
                      <Skeleton className="h-[300px] w-full" />
                    ) : compareProcessed.categories.length === 0 ? (
                      <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">
                        No spending data for this tag
                      </div>
                    ) : (
                      <>
                        <ResponsiveContainer width="100%" height={300}>
                          <PieChart>
                            <Pie
                              data={compareProcessed.categories}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              outerRadius="52%"
                              innerRadius="30%"
                              paddingAngle={3}
                              label={renderPieLabel}
                              labelLine={false}
                            >
                              {compareProcessed.categories.map((entry, index) => (
                                <Cell key={index} fill={entry.color} />
                              ))}
                            </Pie>
                            <Tooltip
                              formatter={(value: number) => formatCurrency(value, currency)}
                              contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-4">
                          {compareProcessed.categories.map((g, i) => (
                            <div key={i} className="flex items-center gap-2 text-sm">
                              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: g.color }} />
                              <span className="truncate text-muted-foreground">{g.name}</span>
                              <span className="ml-auto font-medium">{g.percentage}%</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ) : (
              <motion.div {...fadeUp} transition={{ delay: 0.6 }}>
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle className="text-base">Cash Flow Timeline</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isLoading ? (
                      <Skeleton className="h-[300px] w-full" />
                    ) : primaryTimeline.length === 0 ? (
                      <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">
                        No timeline data
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height={340}>
                        <BarChart data={primaryTimeline}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                          <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => formatCurrency(v, currency, 'en-US', { notation: 'compact' })} />
                          <Tooltip
                            formatter={(value: number) => formatCurrency(value, currency)}
                            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                          />
                          <Bar dataKey="balance" name="Balance" fill="#3A3542" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            )}
          </div>

          {/* Compare mode: Side-by-side timelines */}
          {compareMode && compareTagId && (
            <div className="grid grid-cols-2 gap-4">
              <motion.div {...fadeUp} transition={{ delay: 0.7 }}>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{primaryTag?.name} — Monthly</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={250}>
                      <BarChart data={primaryTimeline}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                        <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => formatCurrency(v, currency, 'en-US', { notation: 'compact' })} />
                        <Tooltip formatter={(value: number) => formatCurrency(value, currency)} contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }} />
                        <Bar dataKey="balance" name="Balance" fill="#3A3542" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </motion.div>
              <motion.div {...fadeUp} transition={{ delay: 0.8 }}>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{compareTag?.name} — Monthly</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={250}>
                      <BarChart data={compareTimeline}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                        <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => formatCurrency(v, currency, 'en-US', { notation: 'compact' })} />
                        <Tooltip formatter={(value: number) => formatCurrency(value, currency)} contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }} />
                        <Bar dataKey="balance" name="Balance" fill="#2E8B57" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </motion.div>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}

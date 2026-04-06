import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CategoryLegendItem } from "./category-legend-item";
import { useAnalytics } from "@/hooks/use-analytics";
import { startOfMonth, endOfMonth, subMonths, format } from 'date-fns';
import { Skeleton } from "@/components/ui/skeleton";
import { translateCategoryGroup } from "@/lib/category-i18n";
import type { AnalyticsResponse } from "@/types/api";

type ChartPeriod = "month" | "prev_month" | "quarter";

const COLORS = ["#0088FE", "#00C49F", "#FFBB28", "#FF8042", "#8884d8", "#82ca9d"];

const processAnalyticsData = (analyticsData: AnalyticsResponse | undefined) => {
  if (!analyticsData?.data) {
    return { pieData: [], totalExpenses: 0 };
  }

  const expenseGroups: { [key: string]: number } = {};

  for (const timeKey in analyticsData.data) {
    const periodData = analyticsData.data[timeKey];
    const essentials = periodData["Essentials"] || {};
    const lifestyle = periodData["Lifestyle"] || {};
    const expenseData = { ...essentials, ...lifestyle };
    for (const groupKey in expenseData) {
      if (!expenseGroups[groupKey]) {
        expenseGroups[groupKey] = 0;
      }
      expenseGroups[groupKey] += expenseData[groupKey].debit;
    }
  }

  const totalExpenses = Object.values(expenseGroups).reduce((sum, value) => sum + value, 0);

  const pieData = Object.entries(expenseGroups)
    .map(([name, value], index) => ({
      name,
      value,
      percentage: totalExpenses > 0 ? parseFloat(((value / totalExpenses) * 100).toFixed(2)) : 0,
      color: COLORS[index % COLORS.length],
    }))
    .sort((a, b) => b.value - a.value);

  return { pieData, totalExpenses };
};

export function SpendingCategoryChart({ currency = 'USD' }: { currency?: string }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<ChartPeriod>("month");

  const { startMonth, endMonth } = useMemo(() => {
    const now = new Date();
    switch (period) {
      case "month":
        return {
          startMonth: format(startOfMonth(now), 'yyyy-MM'),
          endMonth: format(endOfMonth(now), 'yyyy-MM'),
        };
      case "prev_month":
        const prevMonth = subMonths(now, 1);
        return {
          startMonth: format(startOfMonth(prevMonth), 'yyyy-MM'),
          endMonth: format(endOfMonth(prevMonth), 'yyyy-MM'),
        };
      case "quarter":
        const lastQuarter = subMonths(now, 3);
        return {
          startMonth: format(startOfMonth(lastQuarter), 'yyyy-MM'),
          endMonth: format(endOfMonth(now), 'yyyy-MM'),
        };
    }
  }, [period]);

  const { data: analyticsData, isLoading } = useAnalytics({
    view: 'month',
    currency,
    startMonth,
    endMonth,
    types: ['Essentials', 'Lifestyle'],
  });

  const { pieData: chartData } = useMemo(() => {
    const { pieData, totalExpenses } = processAnalyticsData(analyticsData);
    return {
      pieData: pieData.map(d => ({ ...d, name: translateCategoryGroup(t, d.name) })),
      totalExpenses,
    };
  }, [analyticsData, t]);

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('spendingChart.title')}
          </h3>
          <div className="relative">
            <Select value={period} onValueChange={(value) => setPeriod(value as ChartPeriod)}>
              <SelectTrigger className="w-[130px] h-8 text-xs">
                <SelectValue placeholder={t('spendingChart.selectPeriod')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="month">{t('spendingChart.thisMonth')}</SelectItem>
                  <SelectItem value="prev_month">{t('spendingChart.lastMonth')}</SelectItem>
                  <SelectItem value="quarter">{t('spendingChart.last3Months')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="h-80 flex items-center justify-center">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : chartData.length === 0 ? (
            <div className="text-center text-gray-500">{t('spendingChart.noData')}</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.color}
                        strokeWidth={entry.value === 0 ? 0 : 2}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number, name: string) => [`${value}%`, name]}
                    contentStyle={{
                      backgroundColor: "hsl(var(--background))",
                      borderColor: "hsl(var(--border))",
                      borderRadius: "var(--radius)",
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="w-1/3 ml-4 space-y-2">
                {chartData.map((category) => (
                  <CategoryLegendItem
                    key={category.name}
                    color={category.color}
                    name={category.name}
                    percentage={category.value}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

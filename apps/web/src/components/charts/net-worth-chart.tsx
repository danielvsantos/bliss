import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency } from "@/lib/utils";
import { usePortfolioHistory } from "@/hooks/use-portfolio-history";
import { startOfYear, subMonths, subYears, endOfToday, format } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { AggregatedPortfolioHistory } from "@/lib/api";

type ChartPeriod = "1M" | "6M" | "1Y";

interface NetWorthChartProps {
  className?: string;
}

export function NetWorthChart({ className }: NetWorthChartProps) {
  const [period, setPeriod] = useState<ChartPeriod>("1Y");

  const historyDateFilter = useMemo(() => {
    const now = new Date();
    const to = endOfToday();
    let from;

    switch (period) {
      case "1M":
        from = subMonths(now, 1);
        break;
      case "6M":
        from = subMonths(now, 6);
        break;
      case "1Y":
        from = subYears(now, 1);
        break;
      default:
        from = subYears(now, 1);
    }
    return { from: format(from, 'yyyy-MM-dd'), to: format(to, 'yyyy-MM-dd') };
  }, [period]);

  const { data: historyResponse, isLoading } = usePortfolioHistory(historyDateFilter);
  const history = useMemo(() => historyResponse?.history ?? [], [historyResponse?.history]);

  const formattedHistoryData = useMemo(() => {
    const data = history as AggregatedPortfolioHistory[];
    if (!data || data.length === 0) return [];
    return data.map((dailyData) => {
      const assetsValue = dailyData.Investments?.total || 0;
      const liabilitiesValue = dailyData.Debt?.total || 0;
      return {
        date: dailyData.date,
        value: assetsValue - liabilitiesValue,
      };
    });
  }, [history]);

  const periodOptions: { value: ChartPeriod; label: string }[] = [
    { value: "1M", label: "1M" },
    { value: "6M", label: "6M" },
    { value: "1Y", label: "1Y" },
  ];

  return (
    <Card className={className}>
      <CardContent className="p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Asset Value Over Time
          </h3>
          <div className="flex space-x-2">
            {periodOptions.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="xs"
                variant={period === option.value ? "default" : "ghost"}
                className={
                  period === option.value
                    ? ""
                    : "text-gray-600 dark:text-gray-300"
                }
                onClick={() => setPeriod(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="h-80"> {/* Set a fixed height for the chart container */}
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={formattedHistoryData}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="colorUv" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0.3}
                    />
                    <stop
                      offset="95%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "var(--text-muted)" }}
                  dy={10}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "var(--text-muted)" }}
                  tickFormatter={(value) => `$${value / 1000}k`}
                  dx={-10}
                />
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="hsl(var(--border))"
                />
                <Tooltip
                  formatter={(value: number) => [
                    formatCurrency(value),
                    "Net Worth",
                  ]}
                  labelFormatter={(label) => `Date: ${label}`}
                  contentStyle={{
                    backgroundColor: "hsl(var(--background))",
                    borderColor: "hsl(var(--border))",
                    borderRadius: "var(--radius)",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorUv)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

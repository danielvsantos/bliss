import React, { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  HelpCircle,
  EditIcon,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  Legend as RechartsLegend,
  AreaChart,
  Area,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { startOfYear, subMonths, subYears, format as formatDate } from "date-fns";

import { usePortfolioItems } from "@/hooks/use-portfolio-items";
import { usePortfolioHistory } from "@/hooks/use-portfolio-history";
import { useMetadata } from "@/hooks/use-metadata";
import type { PortfolioItem } from "@/types/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { AggregatedPortfolioHistory } from "@/lib/api";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  parseDecimal,
  getDisplayData,
  buildGroupColorMap,
  getGroupIcon,
} from "@/lib/portfolio-utils";

// ── Constants ──────────────────────────────────────────────────────────────

const EMPTY_ARRAY: [] = [];

const TIME_RANGES = [
  { value: "1m", label: "1M" },
  { value: "6m", label: "6M" },
  { value: "1y", label: "1Y" },
  { value: "all", label: "ALL" },
] as const;

// ── Sort Chevron ───────────────────────────────────────────────────────────

function SortChevron({ dir }: { dir: "asc" | "desc" | "none" }) {
  return (
    <span className="inline-flex flex-col gap-px ml-1 align-middle" style={{ opacity: dir === "none" ? 0.38 : 1 }}>
      <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
        <path d="M1 4L4 1L7 4" stroke={dir === "asc" ? "hsl(var(--foreground))" : "hsl(var(--muted-fg))"} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
        <path d="M1 1L4 4L7 1" stroke={dir === "desc" ? "hsl(var(--foreground))" : "hsl(var(--muted-fg))"} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

// ── Asset Row ──────────────────────────────────────────────────────────────

function AssetRow({ item, currency }: { item: PortfolioItem; currency: string }) {
  const data = getDisplayData(item, currency);
  const marketValue = parseDecimal(data.marketValue);

  if (item.category.group === "Cash") {
    return (
      <TableRow className="hover:bg-accent/30">
        <TableCell className="font-medium">{item.symbol}</TableCell>
        <TableCell />
        <TableCell />
        <TableCell />
        <TableCell />
        <TableCell />
        <TableCell />
        <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(marketValue, currency)}</TableCell>
      </TableRow>
    );
  }

  const quantity = parseDecimal(item.quantity);
  const costBasis = parseDecimal(data.costBasis);
  const unrealizedPnL = parseDecimal(data.unrealizedPnL);
  const realizedPnL = parseDecimal(data.realizedPnL);
  const totalInvested = parseDecimal(data.totalInvested);
  const price = quantity > 0 ? marketValue / quantity : 0;
  const totalPnL = realizedPnL + unrealizedPnL;
  const roiPercent = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
  const isClosed = quantity === 0;

  return (
    <TableRow className={`hover:bg-accent/30 ${isClosed ? "opacity-60" : ""}`}>
      <TableCell className="font-medium">{item.symbol}</TableCell>
      <TableCell className="tabular-nums">{quantity.toFixed(2)}</TableCell>
      <TableCell className="tabular-nums">{formatCurrency(price, currency)}</TableCell>
      <TableCell className="tabular-nums">{formatCurrency(costBasis, currency)}</TableCell>
      <TableCell className={`tabular-nums ${unrealizedPnL >= 0 ? "text-positive" : "text-negative"}`}>
        {formatCurrency(unrealizedPnL, currency)}
      </TableCell>
      <TableCell className={`tabular-nums ${realizedPnL >= 0 ? "text-positive" : "text-negative"}`}>
        {formatCurrency(realizedPnL, currency)}
      </TableCell>
      <TableCell className="text-right">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold tabular-nums ${
                roiPercent >= 0
                  ? "bg-positive/10 text-positive border border-positive/20"
                  : "bg-negative/10 text-negative border border-negative/20"
              }`}>
                {totalInvested > 0 ? `${roiPercent >= 0 ? "+" : ""}${roiPercent.toFixed(2)}%` : "N/A"}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>Total ROI = (Realized + Unrealized P&L) / Total Invested</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </TableCell>
      <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(marketValue, currency)}</TableCell>
    </TableRow>
  );
}

// ── Liability Row ──────────────────────────────────────────────────────────

function LiabilityRow({ item, currency }: { item: PortfolioItem; currency: string }) {
  const data = getDisplayData(item, currency);
  const marketValue = Math.abs(parseDecimal(data.marketValue));
  const navigate = useNavigate();

  return (
    <TableRow className="hover:bg-accent/30">
      <TableCell className="font-medium">{item.symbol}</TableCell>
      <TableCell className="tabular-nums">
        {item.debtTerms?.interestRate != null ? `${item.debtTerms.interestRate}%` : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="tabular-nums">
        {item.debtTerms?.termInMonths != null ? `${item.debtTerms.termInMonths} mo` : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-right font-semibold tabular-nums text-negative">
        {formatCurrency(marketValue, currency)}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => navigate("/manual-updates")}
        >
          <EditIcon className="h-3.5 w-3.5" />
          {item.debtTerms ? "Edit" : "Add"} Terms
        </Button>
      </TableCell>
    </TableRow>
  );
}

// ── Main Page Component ────────────────────────────────────────────────────

export default function PortfolioHoldingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const userLocale = i18n.language || window.navigator.language || "en-US";

  // ── State ──
  const [sortField, setSortField] = useState("marketValue");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [closedSectionsVisible, setClosedSectionsVisible] = useState<Record<string, boolean>>({});
  const [timeRange, setTimeRange] = useState("all");
  const [showDebt, setShowDebt] = useState(false);

  // ── Data Fetching ──
  const { data: metadata, isLoading: metadataLoading, error: metadataError } = useMetadata();
  const { data: portfolioData, isLoading: itemsLoading, error: itemsError } = usePortfolioItems();
  const portfolioItems = portfolioData?.items ?? [];
  const portfolioCurrency = portfolioData?.portfolioCurrency ?? "USD";

  const historyDateFilter = useMemo(() => {
    const now = new Date();
    switch (timeRange) {
      case "1m": return { from: subMonths(now, 1).toISOString() };
      case "6m": return { from: subMonths(now, 6).toISOString() };
      case "1y": return { from: subYears(now, 1).toISOString() };
      case "ytd": return { from: startOfYear(now).toISOString() };
      default: return {};
    }
  }, [timeRange]);

  const { data: historyResponse, isLoading: historyLoading, error: historyError } = usePortfolioHistory({
    ...historyDateFilter,
    type: showDebt ? "Investments,Debt,Asset" : "Investments,Asset",
  });
  const historyData = historyResponse?.history ?? [];
  const categories = metadata?.categories ?? EMPTY_ARRAY;

  // ── Data Processing ──

  const { assetList, liabilityList } = useMemo(() => {
    const assets: PortfolioItem[] = [];
    const liabilities: PortfolioItem[] = [];
    portfolioItems.forEach((item) => {
      if (item.category.type === "Debt") {
        liabilities.push(item);
      } else {
        assets.push(item);
      }
    });
    return { assetList: assets, liabilityList: liabilities };
  }, [portfolioItems]);

  const totalAssetsValue = useMemo(
    () => assetList
      .filter((item) => item.category.group !== "Cash")
      .reduce((sum, item) => sum + parseDecimal(getDisplayData(item, portfolioCurrency).marketValue), 0),
    [assetList, portfolioCurrency]
  );

  const totalLiabilitiesValue = useMemo(
    () => liabilityList.reduce((sum, item) => sum + Math.abs(parseDecimal(getDisplayData(item, portfolioCurrency).marketValue)), 0),
    [liabilityList, portfolioCurrency]
  );

  const netWorth = totalAssetsValue - totalLiabilitiesValue;

  const totalPnL = useMemo(() => {
    return assetList
      .filter((item) => item.category.group !== "Cash")
      .reduce((sum, item) => {
        const d = getDisplayData(item, portfolioCurrency);
        return sum + parseDecimal(d.unrealizedPnL) + parseDecimal(d.realizedPnL);
      }, 0);
  }, [assetList, portfolioCurrency]);

  // Sorted & grouped assets
  const sortedAssets = useMemo(() => {
    return [...assetList].sort((a, b) => {
      const aData = getDisplayData(a, portfolioCurrency);
      const bData = getDisplayData(b, portfolioCurrency);
      const aVal = parseDecimal(aData[sortField as keyof typeof aData]);
      const bVal = parseDecimal(bData[sortField as keyof typeof bData]);
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [assetList, sortField, sortOrder, portfolioCurrency]);

  const sortedLiabilities = useMemo(() => {
    return [...liabilityList].sort((a, b) => {
      const aVal = Math.abs(parseDecimal(getDisplayData(a, portfolioCurrency).marketValue));
      const bVal = Math.abs(parseDecimal(getDisplayData(b, portfolioCurrency).marketValue));
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [liabilityList, sortOrder, portfolioCurrency]);

  const groupedAssets = useMemo(() => {
    // Build groups from sorted assets
    const groups = sortedAssets.reduce((acc, asset) => {
      const group = asset.category.group;
      if (!acc[group]) acc[group] = [];
      acc[group].push(asset);
      return acc;
    }, {} as Record<string, PortfolioItem[]>);

    // Sort entries by group total (descending), with Cash always last
    const entries = Object.entries(groups).sort(([groupA, itemsA], [groupB, itemsB]) => {
      const aIsCash = groupA === "Cash";
      const bIsCash = groupB === "Cash";
      if (aIsCash !== bIsCash) return aIsCash ? 1 : -1;
      const totalA = itemsA.reduce((s, i) => s + parseDecimal(getDisplayData(i, portfolioCurrency).marketValue), 0);
      const totalB = itemsB.reduce((s, i) => s + parseDecimal(getDisplayData(i, portfolioCurrency).marketValue), 0);
      return totalB - totalA;
    });

    return Object.fromEntries(entries);
  }, [sortedAssets, portfolioCurrency]);

  // ── Chart Data (preserved exactly from original) ──

  const { chartData, allGroups, debtGroups } = useMemo(() => {
    const data = historyData as AggregatedPortfolioHistory[];
    if (!data || data.length === 0) return { chartData: [], allGroups: [], debtGroups: new Set<string>() };

    const groups = new Set<string>();
    const debtGroupNames = new Set<string>();

    data.forEach((item) => {
      if (item.Investments?.groups) {
        Object.keys(item.Investments.groups).forEach((g) => groups.add(g));
      }
      if (item.Asset?.groups) {
        Object.keys(item.Asset.groups)
          .filter((g) => g !== "Cash")
          .forEach((g) => groups.add(g));
      }
      if (showDebt && item.Debt?.groups) {
        Object.keys(item.Debt.groups).forEach((g) => {
          groups.add(g);
          debtGroupNames.add(g);
        });
      }
    });

    const chartEntries = data.map((dailyData) => {
      const entry: { [key: string]: string | number } = { date: dailyData.date };
      // Exclude Cash from the chart — subtract it from Asset total
      const cashValue = (dailyData.Asset?.groups as Record<string, number> | undefined)?.["Cash"] || 0;
      const assetsValue = (dailyData.Investments?.total || 0) + (dailyData.Asset?.total || 0) - cashValue;
      const liabilitiesValue = dailyData.Debt?.total || 0;
      entry["Net Worth"] = assetsValue - liabilitiesValue;

      if (dailyData.Investments?.groups) {
        for (const [group, value] of Object.entries(dailyData.Investments.groups)) {
          entry[group] = ((entry[group] as number) || 0) + (value as number);
        }
      }
      if (dailyData.Asset?.groups) {
        for (const [group, value] of Object.entries(dailyData.Asset.groups)) {
          if (group === "Cash") continue;
          entry[group] = ((entry[group] as number) || 0) + (value as number);
        }
      }

      if (showDebt && dailyData.Debt?.groups) {
        for (const [group, value] of Object.entries(dailyData.Debt.groups)) {
          entry[group] = -Math.abs(value as number);
        }
      }

      return entry;
    });

    // Smooth ramp-up: for each group, insert a zero value one data point before
    // its first appearance so the area grows from zero instead of jumping.
    const allGroupNames = Array.from(groups);
    for (const group of allGroupNames) {
      for (let i = 0; i < chartEntries.length; i++) {
        if (chartEntries[i][group] !== undefined) {
          if (i > 0 && chartEntries[i - 1][group] === undefined) {
            chartEntries[i - 1][group] = 0;
          }
          break;
        }
      }
    }

    return { chartData: chartEntries, allGroups: allGroupNames, debtGroups: debtGroupNames };
  }, [historyData, showDebt]);

  const { performanceSinceStartPercent } = useMemo(() => {
    if (!chartData || chartData.length === 0) return { performanceSinceStartPercent: 0 };
    const firstValue = chartData[0]["Net Worth"] as number;
    const lastValue = chartData[chartData.length - 1]["Net Worth"] as number;
    const performance = lastValue - firstValue;
    return {
      performanceSinceStartPercent: firstValue === 0 ? 0 : (performance / firstValue) * 100,
    };
  }, [chartData]);

  // ── Dynamic color map ──

  const groupColorMap = useMemo(
    () => buildGroupColorMap(allGroups, debtGroups),
    [allGroups, debtGroups]
  );

  const getColor = (group: string) => groupColorMap[group] || "#9A95A4";

  // ── Handlers ──

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const dirFor = (field: string): "asc" | "desc" | "none" =>
    sortField === field ? sortOrder : "none";

  const toggleGroup = (group: string) =>
    setExpandedGroups((p) => ({ ...p, [group]: !p[group] }));

  // ── Tooltip ──

  const PerformanceChartTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: { name: string; color: string; value: number }[];
    label?: string;
  }) => {
    if (!active || !payload?.length) return null;

    const netWorthItem = payload.find((item) => item.name === "Net Worth");
    const groupItems = payload
      .filter((item) => item.name !== "Net Worth" && item.value !== 0)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const netWorthValue = netWorthItem?.value ?? groupItems.reduce((sum, item) => sum + item.value, 0);

    return (
      <div className="p-3 bg-background/95 backdrop-blur-sm border rounded-xl shadow-lg min-w-[210px]">
        <p className="font-semibold text-sm mb-2">{label ? formatDate(new Date(label), "PPP") : ""}</p>
        <div className="space-y-1 mb-2">
          {groupItems.map((item) => (
            <div key={item.name} className="flex justify-between items-center gap-6 text-sm">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
                {item.name}
              </span>
              <span className="tabular-nums">{formatCurrency(item.value, portfolioCurrency)}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-between items-center pt-2 border-t font-semibold text-sm">
          <span>Net Worth</span>
          <span className={`tabular-nums ${netWorthValue >= 0 ? "text-positive" : "text-negative"}`}>
            {formatCurrency(netWorthValue, portfolioCurrency)}
          </span>
        </div>
      </div>
    );
  };

  // ── Loading & Error ──

  const isLoading = itemsLoading || metadataLoading;
  const hasError = itemsError || historyError || metadataError;

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <HelpCircle className="h-4 w-4" />
          <AlertTitle>Error Loading Portfolio</AlertTitle>
          <AlertDescription>
            There was an issue fetching your portfolio data. Please try again later.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (portfolioItems.length === 0) {
    return (
      <div className="container mx-auto py-6 space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight mb-2">Portfolio Holdings</h2>
          <p className="text-muted-foreground">Track your investment portfolio performance and allocation</p>
        </div>
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-muted-foreground mb-4">No portfolio data yet. Connect a bank account or import transactions to get started.</p>
            <div className="flex gap-3 justify-center">
              <Button onClick={() => navigate("/accounts")}>Connect Account</Button>
              <Button variant="outline" onClick={() => navigate("/imports")}>Import CSV</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Render: Sortable Header Helper ──

  const SortableHeader = ({
    field,
    children,
    align = "left",
  }: {
    field: string;
    children: React.ReactNode;
    align?: "left" | "right";
  }) => (
    <TableHead
      className={`cursor-pointer select-none ${align === "right" ? "text-right" : ""}`}
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        <SortChevron dir={dirFor(field)} />
      </span>
    </TableHead>
  );

  const totalAssetPositions = assetList.length;
  const totalLiabilityPositions = liabilityList.length;

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col space-y-8">
      {/* ── Page Header ── */}
      <div>
        <h2 className="text-3xl font-bold tracking-tight mb-2">Portfolio Holdings</h2>
        <p className="text-muted-foreground">Track your investment portfolio performance and allocation</p>
      </div>

      {/* ── Performance Chart Card ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            {/* KPI Row */}
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-bold tabular-nums tracking-tight">
                {formatCurrency(netWorth, portfolioCurrency)}
              </span>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold tabular-nums ${
                  performanceSinceStartPercent >= 0
                    ? "bg-positive/10 text-positive border border-positive/20"
                    : "bg-negative/10 text-negative border border-negative/20"
                }`}
              >
                {performanceSinceStartPercent >= 0 ? "+" : ""}
                {performanceSinceStartPercent.toFixed(2)}%
              </span>
            </div>

            {/* Controls Row */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* Period Tabs (pill-shaped) */}
              <div className="inline-flex items-center rounded-xl bg-accent p-1 gap-0.5">
                {TIME_RANGES.map((range) => (
                  <button
                    key={range.value}
                    onClick={() => setTimeRange(range.value)}
                    className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
                      timeRange === range.value
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {range.label}
                  </button>
                ))}
              </div>

              {/* Show Debt Toggle */}
              <div className="flex items-center gap-2">
                <Switch id="show-debt" checked={showDebt} onCheckedChange={setShowDebt} />
                <Label htmlFor="show-debt" className="text-xs text-muted-foreground">
                  Show Debt
                </Label>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {historyLoading ? (
            <Skeleton className="h-80 w-full rounded-lg" />
          ) : chartData.length === 0 ? (
            <div className="h-80 flex items-center justify-center text-muted-foreground text-sm">
              No historical data available for this period.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={380}>
              <AreaChart data={chartData}>
                <defs>
                  {allGroups.map((group) => (
                    <linearGradient key={group} id={`color-${group.replace(/\s+/g, "")}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={getColor(group)} stopOpacity={0.75} />
                      <stop offset="95%" stopColor={getColor(group)} stopOpacity={0.05} />
                    </linearGradient>
                  ))}
                </defs>
                <XAxis
                  dataKey="date"
                  tickFormatter={(str) => formatDate(new Date(str), "MMM d")}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-fg))"
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tickFormatter={(val) => formatCurrency(val, portfolioCurrency, userLocale, { notation: "compact" })}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-fg))"
                />
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <ReferenceLine y={0} stroke="hsl(var(--muted-fg))" strokeWidth={1} />
                <RechartsTooltip content={<PerformanceChartTooltip />} />
                <RechartsLegend />

                {/* Investment asset areas — stacked above zero */}
                {allGroups
                  .filter((g) => !debtGroups.has(g))
                  .map((group) => (
                    <Area
                      key={group}
                      type="monotone"
                      dataKey={group}
                      stackId="assets"
                      stroke={getColor(group)}
                      strokeWidth={1}
                      fillOpacity={1}
                      fill={`url(#color-${group.replace(/\s+/g, "")})`}
                      name={group}
                    />
                  ))}

                {/* Debt areas — stack below zero (values are negated in chartData) */}
                {showDebt &&
                  allGroups
                    .filter((g) => debtGroups.has(g))
                    .map((group) => (
                      <Area
                        key={group}
                        type="monotone"
                        dataKey={group}
                        stackId="debt"
                        stroke={getColor(group)}
                        strokeWidth={1}
                        fillOpacity={1}
                        fill={`url(#color-${group.replace(/\s+/g, "")})`}
                        name={group}
                      />
                    ))}

                {/* Net Worth — dashed overlay line, not stacked */}
                <Line
                  type="monotone"
                  dataKey="Net Worth"
                  stroke="hsl(var(--brand-deep))"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  dot={false}
                  name="Net Worth"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Assets Card ── */}
      {totalAssetPositions > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <CardTitle>{t("Assets")}</CardTitle>
              <Badge variant="outline" className="text-xs font-medium">
                {totalAssetPositions} position{totalAssetPositions !== 1 ? "s" : ""}
              </Badge>
              <span className="ml-auto text-lg font-bold tabular-nums tracking-tight">
                {formatCurrency(totalAssetsValue, portfolioCurrency)}
              </span>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {Object.entries(groupedAssets).map(([group, groupItems]) => {
              const isCashGroup = group === "Cash";
              const openPositions = isCashGroup ? groupItems : groupItems.filter((item) => parseDecimal(item.quantity) > 0);
              const closedPositions = isCashGroup ? [] : groupItems.filter((item) => parseDecimal(item.quantity) === 0);
              const isExpanded = expandedGroups[group] === true; // default collapsed
              const groupTotal = groupItems.reduce(
                (s, i) => s + parseDecimal(getDisplayData(i, portfolioCurrency).marketValue),
                0
              );
              const GroupIcon = getGroupIcon(group, groupItems[0]?.category?.processingHint);

              return (
                <div key={group} className="mb-4 last:mb-0">
                  {/* Group Header */}
                  <button
                    className="flex items-center gap-2 w-full py-2 text-left hover:bg-accent/30 rounded-lg px-2 -mx-2 transition-colors"
                    onClick={() => toggleGroup(group)}
                  >
                    {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded" style={{ color: getColor(group) }}>
                      <GroupIcon className="h-4 w-4" />
                    </span>
                    <span className="font-medium text-sm">{group}</span>
                    <Badge variant="secondary" className="text-xs ml-1">
                      {groupItems.length}
                    </Badge>
                    <span className="ml-auto text-sm font-semibold tabular-nums">
                      {formatCurrency(groupTotal, portfolioCurrency)}
                    </span>
                  </button>

                  {isExpanded && (
                    <>
                      <div className="overflow-x-auto mt-1">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-accent/40">
                              <SortableHeader field="symbol">Symbol</SortableHeader>
                              <SortableHeader field="quantity">Qty</SortableHeader>
                              <TableHead>Price</TableHead>
                              <SortableHeader field="costBasis">Cost Basis</SortableHeader>
                              <SortableHeader field="unrealizedPnL">Unrealized P&L</SortableHeader>
                              <SortableHeader field="realizedPnL">Realized P&L</SortableHeader>
                              <TableHead className="text-right">ROI %</TableHead>
                              <SortableHeader field="marketValue" align="right">Total Value</SortableHeader>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {openPositions.map((item) => (
                              <AssetRow key={item.id} item={item} currency={portfolioCurrency} />
                            ))}
                            {closedSectionsVisible[group] &&
                              closedPositions.map((item) => (
                                <AssetRow key={item.id} item={item} currency={portfolioCurrency} />
                              ))}
                          </TableBody>
                        </Table>
                      </div>
                      {closedPositions.length > 0 && (
                        <div className="text-center mt-2">
                          <Button
                            variant="link"
                            size="sm"
                            className="text-xs"
                            onClick={() => setClosedSectionsVisible((p) => ({ ...p, [group]: !p[group] }))}
                          >
                            {closedSectionsVisible[group] ? "Hide" : "Show"} {closedPositions.length} closed position
                            {closedPositions.length !== 1 ? "s" : ""}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* ── Liabilities Card ── */}
      {totalLiabilityPositions > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <CardTitle>{t("Liabilities")}</CardTitle>
              <Badge variant="outline" className="text-xs font-medium">
                {totalLiabilityPositions}
              </Badge>
              <span className="ml-auto text-lg font-bold tabular-nums tracking-tight text-negative">
                {formatCurrency(totalLiabilitiesValue, portfolioCurrency)}
              </span>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-accent/40">
                    <TableHead>Liability</TableHead>
                    <TableHead>Interest Rate</TableHead>
                    <TableHead>Term</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedLiabilities.map((item) => (
                    <LiabilityRow key={item.id} item={item} currency={portfolioCurrency} />
                  ))}
                </TableBody>
                {sortedLiabilities.length > 1 && (
                  <tfoot>
                    <tr className="border-t">
                      <td colSpan={3} className="px-4 py-3 text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                        Total Outstanding
                      </td>
                      <td className="px-4 py-3 text-right font-bold tabular-nums text-negative">
                        {formatCurrency(totalLiabilitiesValue, portfolioCurrency)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  );
}

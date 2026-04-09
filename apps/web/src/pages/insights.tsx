import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useInsights, useDismissInsight, useGenerateInsights } from "@/hooks/use-insights";
import type { InsightTier, InsightCategory } from "@/hooks/use-insights";
import { InsightCard } from "@/components/insights/insight-card";
import {
  RefreshCw,
  Sparkles,
  Inbox,
  Receipt,
  TrendingUp,
  PiggyBank,
  LineChart,
  CreditCard,
  Landmark,
  MoreVertical,
  CalendarDays,
  CalendarRange,
  CalendarCheck,
  BarChart3,
} from "lucide-react";

// ─── Tier & Category Config ─────────────────────────────────────────────────

const TIERS: { key: InsightTier; icon: typeof CalendarDays; label: string }[] = [
  { key: "MONTHLY", icon: CalendarDays, label: "insights.tiers.monthly" },
  { key: "QUARTERLY", icon: CalendarRange, label: "insights.tiers.quarterly" },
  { key: "ANNUAL", icon: CalendarCheck, label: "insights.tiers.annual" },
  { key: "PORTFOLIO", icon: BarChart3, label: "insights.tiers.portfolio" },
];

const CATEGORIES: { key: InsightCategory; icon: typeof Receipt; label: string }[] = [
  { key: "SPENDING", icon: Receipt, label: "insights.categories.spending" },
  { key: "INCOME", icon: TrendingUp, label: "insights.categories.income" },
  { key: "SAVINGS", icon: PiggyBank, label: "insights.categories.savings" },
  { key: "PORTFOLIO", icon: LineChart, label: "insights.categories.portfolio" },
  { key: "DEBT", icon: CreditCard, label: "insights.categories.debt" },
  { key: "NET_WORTH", icon: Landmark, label: "insights.categories.netWorth" },
];

type Insight = {
  id: string;
  lens: string;
  tier: InsightTier;
  category: InsightCategory;
  periodKey: string;
  severity: string;
  priority: number;
  title: string;
  body: string;
  date: string;
  metadata?: Record<string, unknown>;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sort period keys descending (newest first). Handles all 4 formats:
 *   MONTHLY:   YYYY-MM           ("2026-03")
 *   QUARTERLY: YYYY-Qn           ("2026-Q1")
 *   ANNUAL:    YYYY              ("2025")
 *   PORTFOLIO: YYYY-Www          ("2026-W14")
 *
 * Lexical sort works for all of these because they all start with YYYY and
 * the remainder is zero-padded within each tier.
 */
function comparePeriodsDesc(a: string, b: string): number {
  return b.localeCompare(a);
}

/**
 * Format a raw periodKey into a human-readable label for the period selector.
 * Falls back to the raw key if parsing fails — insights never break on bad input.
 */
function formatPeriodLabel(tier: InsightTier, periodKey: string, t: (k: string) => string): string {
  if (!periodKey) return "";
  try {
    if (tier === "MONTHLY") {
      const [year, month] = periodKey.split("-");
      if (!year || !month) return periodKey;
      const d = new Date(Number(year), Number(month) - 1, 1);
      return d.toLocaleString(undefined, { month: "long", year: "numeric" });
    }
    if (tier === "QUARTERLY") {
      const [year, q] = periodKey.split("-");
      if (!year || !q) return periodKey;
      return `${q.replace("Q", t("insights.period.q"))} ${year}`;
    }
    if (tier === "ANNUAL") {
      return periodKey; // "2025"
    }
    if (tier === "PORTFOLIO") {
      const [year, week] = periodKey.split("-");
      if (!year || !week) return periodKey;
      return `${year} · ${week}`;
    }
    return periodKey;
  } catch {
    return periodKey;
  }
}

// ─── Page Component ──────────────────────────────────────────────────────────

export default function InsightsPage() {
  const { t } = useTranslation();

  // Tier-first navigation. MONTHLY is the landing tier because it carries
  // the primary MoM/YoY health check that users check first.
  const [activeTier, setActiveTier] = useState<InsightTier>("MONTHLY");
  const [selectedPeriodKey, setSelectedPeriodKey] = useState<string | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<Set<InsightCategory>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);

  // Fetch ALL insights for the active tier (no period filter yet) so we can
  // populate the period selector and per-category counts. Cap at 200 to keep
  // the payload small — a single tier is unlikely to exceed this in practice.
  const queryParams = useMemo(
    () => ({ limit: 200, tier: activeTier }),
    [activeTier],
  );
  const { data, isLoading, refetch } = useInsights(queryParams);
  const dismissMutation = useDismissInsight();
  const generateMutation = useGenerateInsights();

  const allTierInsights: Insight[] = data?.insights || [];
  const tierSummary = data?.tierSummary || {};

  // Distinct period keys present in this tier's insights, sorted newest-first.
  const availablePeriods = useMemo(() => {
    const keys = Array.from(
      new Set(allTierInsights.map((i) => i.periodKey).filter(Boolean)),
    );
    return keys.sort(comparePeriodsDesc);
  }, [allTierInsights]);

  // Default the selected period to the newest one whenever the tier changes
  // or the fetched data surfaces a new newest period. Users can still pick an
  // older period from the selector manually.
  useEffect(() => {
    if (availablePeriods.length === 0) {
      setSelectedPeriodKey(null);
      return;
    }
    if (!selectedPeriodKey || !availablePeriods.includes(selectedPeriodKey)) {
      setSelectedPeriodKey(availablePeriods[0]);
    }
  }, [activeTier, availablePeriods, selectedPeriodKey]);

  // Reset the category multi-select when switching tiers — each tier has a
  // different set of active categories, and carrying the filter across tiers
  // can land a user on an empty screen.
  useEffect(() => {
    setSelectedCategories(new Set());
  }, [activeTier]);

  // Filter the full tier insight set down to the selected period, then apply
  // category multi-select (empty set = show all).
  const filteredInsights = useMemo(() => {
    let filtered = allTierInsights;
    if (selectedPeriodKey) {
      filtered = filtered.filter((i) => i.periodKey === selectedPeriodKey);
    }
    if (selectedCategories.size > 0) {
      filtered = filtered.filter((i) => selectedCategories.has(i.category));
    }
    // Stable sort: priority desc, then title asc
    return [...filtered].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.title.localeCompare(b.title);
    });
  }, [allTierInsights, selectedPeriodKey, selectedCategories]);

  // Per-category counts *within the currently selected period* so the chip
  // badges match what the user will actually see after toggling.
  const periodCategoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const scope = selectedPeriodKey
      ? allTierInsights.filter((i) => i.periodKey === selectedPeriodKey)
      : allTierInsights;
    for (const insight of scope) {
      counts[insight.category] = (counts[insight.category] || 0) + 1;
    }
    return counts;
  }, [allTierInsights, selectedPeriodKey]);

  // ─── Polling (mirrors prior behavior) ─────────────────────────────────────

  useEffect(() => {
    if (!isGenerating) return;
    const interval = setInterval(() => refetch(), 10_000);
    return () => clearInterval(interval);
  }, [isGenerating, refetch]);

  useEffect(() => {
    if (!isGenerating) return;
    const timeout = setTimeout(() => setIsGenerating(false), 45_000);
    return () => clearTimeout(timeout);
  }, [isGenerating]);

  useEffect(() => {
    if (isGenerating && allTierInsights.length > 0) {
      setIsGenerating(false);
    }
  }, [allTierInsights.length, isGenerating]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const toggleCategory = useCallback((category: InsightCategory) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  /**
   * Trigger a generation run for the active tier + currently selected period.
   * For MONTHLY / QUARTERLY / ANNUAL we parse the selected periodKey back
   * into the year / month / quarter params the backend expects. For PORTFOLIO
   * we send nothing but `{ tier, force }` — the backend derives the ISO week.
   */
  const handleGenerateActive = useCallback(() => {
    setIsGenerating(true);
    const base = { tier: activeTier, force: true as const };

    if (activeTier === "PORTFOLIO" || !selectedPeriodKey) {
      generateMutation.mutate(base);
      return;
    }

    if (activeTier === "MONTHLY") {
      const [yearStr, monthStr] = selectedPeriodKey.split("-");
      generateMutation.mutate({
        ...base,
        year: Number(yearStr),
        month: Number(monthStr),
        periodKey: selectedPeriodKey,
      });
      return;
    }

    if (activeTier === "QUARTERLY") {
      const [yearStr, qStr] = selectedPeriodKey.split("-");
      generateMutation.mutate({
        ...base,
        year: Number(yearStr),
        quarter: Number(qStr.replace("Q", "")),
        periodKey: selectedPeriodKey,
      });
      return;
    }

    if (activeTier === "ANNUAL") {
      generateMutation.mutate({
        ...base,
        year: Number(selectedPeriodKey),
        periodKey: selectedPeriodKey,
      });
    }
  }, [activeTier, selectedPeriodKey, generateMutation]);

  /**
   * Fire-and-forget a generation run for every tier. Used from the overflow
   * menu to pre-warm the cache — typically after a bulk transaction import.
   */
  const handleGenerateAll = useCallback(() => {
    setIsGenerating(true);
    const now = new Date();
    const year = now.getUTCFullYear();
    const priorMonth = now.getUTCMonth(); // 0-indexed; prior month = last month (handles wrap implicitly below)
    const priorMonthYear = priorMonth === 0 ? year - 1 : year;
    const normalizedPriorMonth = priorMonth === 0 ? 12 : priorMonth;
    const priorQuarter = Math.ceil(normalizedPriorMonth / 3);
    const priorYearForAnnual = year - 1;

    generateMutation.mutate({
      tier: "MONTHLY",
      year: priorMonthYear,
      month: normalizedPriorMonth,
      force: true,
    });
    generateMutation.mutate({
      tier: "QUARTERLY",
      year: priorMonthYear,
      quarter: priorQuarter,
      force: true,
    });
    generateMutation.mutate({ tier: "ANNUAL", year: priorYearForAnnual, force: true });
    generateMutation.mutate({ tier: "PORTFOLIO", force: true });
  }, [generateMutation]);

  const handleDismiss = useCallback(
    (insightId: string) => {
      dismissMutation.mutate({ insightId, dismissed: true });
    },
    [dismissMutation],
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  const activeTierSummary = tierSummary[activeTier];

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">{t("insights.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("insights.v1Subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={handleGenerateActive}
              disabled={isGenerating || availablePeriods.length === 0}
              variant="outline"
              className="gap-2"
            >
              {isGenerating ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {isGenerating ? t("insights.generating") : t("insights.refreshTier")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t("insights.moreActions")}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleGenerateAll} disabled={isGenerating}>
                  <Sparkles className="h-4 w-4 mr-2" />
                  {t("insights.generateAll")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => refetch()}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  {t("insights.reload")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Tier tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1" role="tablist">
        {TIERS.map(({ key, icon: Icon, label }) => {
          const isActive = activeTier === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTier(key)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{t(label)}</span>
            </button>
          );
        })}
      </div>

      {/* Period selector + tier metadata */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        {availablePeriods.length > 0 ? (
          <Select
            value={selectedPeriodKey ?? undefined}
            onValueChange={(v) => setSelectedPeriodKey(v)}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder={t("insights.period.selectPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {availablePeriods.map((p) => (
                <SelectItem key={p} value={p}>
                  {formatPeriodLabel(activeTier, p, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {activeTierSummary?.latestCreatedAt && (
          <span className="text-xs text-muted-foreground">
            {t("insights.lastUpdated")}:{" "}
            {new Date(activeTierSummary.latestCreatedAt).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* Category chips — multi-select */}
      {Object.keys(periodCategoryCounts).length > 0 && (
        <div className="flex gap-2 mb-6 flex-wrap">
          {CATEGORIES.map(({ key, icon: Icon, label }) => {
            const count = periodCategoryCounts[key] || 0;
            if (count === 0) return null;
            const isActive = selectedCategories.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleCategory(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                  isActive
                    ? "bg-brand-primary text-white border-brand-primary"
                    : "bg-muted text-muted-foreground border-transparent hover:bg-accent"
                }`}
              >
                <Icon className="h-3 w-3" />
                <span>{t(label)}</span>
                <span
                  className={`rounded-full px-1.5 py-0 min-w-[18px] text-center ${
                    isActive ? "bg-white/20 text-white" : "bg-background text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
          {selectedCategories.size > 0 && (
            <button
              onClick={() => setSelectedCategories(new Set())}
              className="text-xs text-muted-foreground underline hover:text-foreground px-2"
            >
              {t("insights.clearFilters")}
            </button>
          )}
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : filteredInsights.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="h-16 w-16 rounded-full bg-brand-primary/10 flex items-center justify-center mb-4">
            <Inbox className="h-8 w-8 text-brand-primary" />
          </div>
          <h3 className="font-semibold text-lg mb-1">{t("insights.noInsightsYet")}</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            {selectedCategories.size > 0
              ? t("insights.noCategoryInsights")
              : availablePeriods.length === 0
                ? t("insights.noTierInsightsDesc")
                : t("insights.noInsightsDesc")}
          </p>
          <Button
            onClick={handleGenerateActive}
            disabled={isGenerating}
            variant="outline"
            className="mt-4 gap-2"
          >
            <Sparkles className="h-4 w-4" />
            {t("insights.generate")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <AnimatePresence mode="popLayout">
            {filteredInsights.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight as never}
                onDismiss={handleDismiss}
                showTierBadge={false}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

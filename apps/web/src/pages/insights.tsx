import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
  LayoutGrid,
} from "lucide-react";

// ─── Category Config ───���─────────────────────────────────────────────────────

const CATEGORIES = [
  { key: "ALL" as const, icon: LayoutGrid, label: "insights.categories.all" },
  { key: "SPENDING" as InsightCategory, icon: Receipt, label: "insights.categories.spending" },
  { key: "INCOME" as InsightCategory, icon: TrendingUp, label: "insights.categories.income" },
  { key: "SAVINGS" as InsightCategory, icon: PiggyBank, label: "insights.categories.savings" },
  { key: "PORTFOLIO" as InsightCategory, icon: LineChart, label: "insights.categories.portfolio" },
  { key: "DEBT" as InsightCategory, icon: CreditCard, label: "insights.categories.debt" },
  { key: "NET_WORTH" as InsightCategory, icon: Landmark, label: "insights.categories.netWorth" },
] as const;

const SEVERITY_FILTERS = ["All", "POSITIVE", "INFO", "WARNING", "CRITICAL"] as const;

const TIER_ORDER: InsightTier[] = ["ANNUAL", "QUARTERLY", "MONTHLY", "PORTFOLIO", "DAILY"];

// ─── Page Component ──────────────────────────────────────────────────────────

export default function InsightsPage() {
  const { t } = useTranslation();
  const [activeCategory, setActiveCategory] = useState<string>("ALL");
  const [severityFilter, setSeverityFilter] = useState<string>("All");
  const [isGenerating, setIsGenerating] = useState(false);

  const queryParams = {
    limit: 100,
    ...(activeCategory !== "ALL" && { category: activeCategory }),
    ...(severityFilter !== "All" && { severity: severityFilter }),
  };

  const { data, isLoading, refetch } = useInsights(queryParams);
  const dismissMutation = useDismissInsight();
  const generateMutation = useGenerateInsights();

  const insights = data?.insights || [];
  const categoryCounts = data?.categoryCounts || {};
  const tierSummary = data?.tierSummary || {};

  // Poll while generating
  useEffect(() => {
    if (!isGenerating) return;
    const interval = setInterval(() => refetch(), 10_000);
    return () => clearInterval(interval);
  }, [isGenerating, refetch]);

  // Auto-stop generating after 45s
  useEffect(() => {
    if (!isGenerating) return;
    const timeout = setTimeout(() => setIsGenerating(false), 45_000);
    return () => clearTimeout(timeout);
  }, [isGenerating]);

  // Detect new data arrival → stop generating
  useEffect(() => {
    if (isGenerating && insights.length > 0) {
      setIsGenerating(false);
    }
  }, [insights.length]);

  const handleGenerate = useCallback(
    (tier?: InsightTier) => {
      setIsGenerating(true);
      generateMutation.mutate(tier ? { tier } : undefined);
    },
    [generateMutation]
  );

  const handleDismiss = useCallback(
    (insightId: string) => {
      dismissMutation.mutate({ insightId, dismissed: true });
    },
    [dismissMutation]
  );

  // Group insights by tier for ordered display
  const groupedInsights = TIER_ORDER.reduce<Record<string, typeof insights>>((acc, tier) => {
    const tierInsights = insights.filter((i: any) => i.tier === tier);
    if (tierInsights.length > 0) acc[tier] = tierInsights;
    return acc;
  }, {});

  // Total count for active category (for the badge on category tabs)
  const totalCount = Object.values(categoryCounts).reduce((a: number, b: number) => a + b, 0);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">{t("insights.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("insights.v1Subtitle")}
            </p>
          </div>
          <Button
            onClick={() => handleGenerate()}
            disabled={isGenerating}
            variant="outline"
            className="gap-2"
          >
            {isGenerating ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {isGenerating ? t("insights.generating") : t("insights.generateNew")}
          </Button>
        </div>
      </div>

      {/* Category Tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {CATEGORIES.map(({ key, icon: Icon, label }) => {
          const count = key === "ALL" ? totalCount : (categoryCounts[key] || 0);
          const isActive = activeCategory === key;

          return (
            <button
              key={key}
              onClick={() => setActiveCategory(key)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{t(label)}</span>
              {count > 0 && (
                <span
                  className={`text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center ${
                    isActive ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Severity Filter */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {SEVERITY_FILTERS.map((filter) => (
          <button
            key={filter}
            onClick={() => setSeverityFilter(filter)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              severityFilter === filter
                ? "bg-brand-primary text-white"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {filter === "All" ? t("common.all") : t(`insights.severity.${filter}`)}
          </button>
        ))}
      </div>

      {/* Tier Summary Bar */}
      {Object.keys(tierSummary).length > 0 && (
        <div className="flex gap-3 mb-6 flex-wrap text-xs text-muted-foreground">
          {TIER_ORDER.map((tier) => {
            const summary = tierSummary[tier];
            if (!summary) return null;
            return (
              <span key={tier} className="flex items-center gap-1">
                <span className="font-medium">{tier.charAt(0) + tier.slice(1).toLowerCase()}:</span>
                {new Date(summary.latestCreatedAt).toLocaleDateString()}
              </span>
            );
          })}
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : insights.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="h-16 w-16 rounded-full bg-brand-primary/10 flex items-center justify-center mb-4">
            <Inbox className="h-8 w-8 text-brand-primary" />
          </div>
          <h3 className="font-semibold text-lg mb-1">{t("insights.noInsightsYet")}</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            {activeCategory !== "ALL"
              ? t("insights.noCategoryInsights")
              : t("insights.noInsightsDesc")}
          </p>
          <Button
            onClick={() => handleGenerate()}
            disabled={isGenerating}
            variant="outline"
            className="mt-4 gap-2"
          >
            <Sparkles className="h-4 w-4" />
            {t("insights.generate")}
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Group by tier */}
          {Object.entries(groupedInsights).map(([tier, tierInsights]) => (
            <div key={tier}>
              {/* Tier section header */}
              {Object.keys(groupedInsights).length > 1 && (
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    {tier === "DAILY" && t("insights.tiers.daily")}
                    {tier === "MONTHLY" && t("insights.tiers.monthly")}
                    {tier === "QUARTERLY" && t("insights.tiers.quarterly")}
                    {tier === "ANNUAL" && t("insights.tiers.annual")}
                    {tier === "PORTFOLIO" && t("insights.tiers.portfolio")}
                  </h3>
                  <div className="flex-1 h-px bg-border" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs text-muted-foreground"
                    onClick={() => handleGenerate(tier as InsightTier)}
                    disabled={isGenerating}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    {t("insights.refresh")}
                  </Button>
                </div>
              )}

              <div className="space-y-3">
                <AnimatePresence mode="popLayout">
                  {tierInsights.map((insight: any) => (
                    <InsightCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={handleDismiss}
                      showTierBadge={Object.keys(groupedInsights).length <= 1}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useInsights, useDismissInsight, useGenerateInsights } from "@/hooks/use-insights";
import { InsightCard } from "@/components/insights/insight-card";
import { RefreshCw, Sparkles, Inbox } from "lucide-react";

const SEVERITY_FILTERS = ["All", "POSITIVE", "INFO", "WARNING", "CRITICAL"] as const;

export default function InsightsPage() {
  const { t } = useTranslation();
  const [severityFilter, setSeverityFilter] = useState<string>("All");
  const [isGenerating, setIsGenerating] = useState(false);

  const queryParams = {
    limit: 50,
    ...(severityFilter !== "All" && { severity: severityFilter }),
  };

  const { data, isLoading, refetch } = useInsights(queryParams);
  const dismissMutation = useDismissInsight();
  const generateMutation = useGenerateInsights();

  const insights = data?.insights || [];
  const latestBatchDate = data?.latestBatchDate;

  // Poll while generating
  useEffect(() => {
    if (!isGenerating) return;
    const interval = setInterval(() => refetch(), 10_000);
    return () => clearInterval(interval);
  }, [isGenerating, refetch]);

  // Auto-stop generating after 30s
  useEffect(() => {
    if (!isGenerating) return;
    const timeout = setTimeout(() => setIsGenerating(false), 30_000);
    return () => clearTimeout(timeout);
  }, [isGenerating]);

  // Detect new batch arrival → stop generating
  useEffect(() => {
    if (isGenerating && latestBatchDate) {
      setIsGenerating(false);
    }
  }, [latestBatchDate]);

  const handleGenerate = useCallback(() => {
    setIsGenerating(true);
    generateMutation.mutate();
  }, [generateMutation]);

  const handleDismiss = useCallback(
    (insightId: string) => {
      dismissMutation.mutate({ insightId, dismissed: true });
    },
    [dismissMutation]
  );

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">{t("Insights")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {latestBatchDate
                ? `${t("Last updated")} ${new Date(latestBatchDate).toLocaleDateString()}`
                : t("AI-powered observations about your finances")}
            </p>
          </div>
          <Button
            onClick={handleGenerate}
            disabled={isGenerating}
            variant="outline"
            className="gap-2"
          >
            {isGenerating ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {isGenerating ? t("Generating...") : t("Generate New Insights")}
          </Button>
        </div>
      </div>

      {/* Filter chips */}
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
            {filter === "All" ? t("All") : filter.charAt(0) + filter.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

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
          <h3 className="font-semibold text-lg mb-1">{t("No insights yet")}</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            {t("Once you have transaction data, Bliss will analyze your finances and surface patterns that matter.")}
          </p>
          <Button
            onClick={handleGenerate}
            disabled={isGenerating}
            variant="outline"
            className="mt-4 gap-2"
          >
            <Sparkles className="h-4 w-4" />
            {t("Generate Insights")}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <AnimatePresence mode="popLayout">
            {insights.map((insight: any) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                onDismiss={handleDismiss}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

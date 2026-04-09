import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import type { InsightTier } from "@/hooks/use-insights";

interface Insight {
  id: string;
  lens: string;
  title: string;
  body: string;
  severity: string;
  priority: number;
  date: string;
  tier: InsightTier;
  category: string;
  periodKey: string;
  metadata?: {
    actionTypes?: string[];
    suggestedAction?: string;
    relatedLenses?: string[];
    dataPoints?: Record<string, any>;
  };
}

interface InsightCardProps {
  insight: Insight;
  onDismiss: (id: string) => void;
  showTierBadge?: boolean;
}

const SEVERITY_STYLES: Record<string, string> = {
  POSITIVE: "border-l-positive bg-positive/5",
  INFO: "border-l-brand-primary bg-brand-primary/5",
  WARNING: "border-l-warning bg-warning/5",
  CRITICAL: "border-l-destructive bg-destructive/5",
};

const SEVERITY_DOT: Record<string, string> = {
  POSITIVE: "bg-positive",
  INFO: "bg-brand-primary",
  WARNING: "bg-warning",
  CRITICAL: "bg-destructive",
};

const LENS_LABELS: Record<string, string> = {
  SPENDING_VELOCITY: "Spending",
  CATEGORY_CONCENTRATION: "Categories",
  UNUSUAL_SPENDING: "Anomaly",
  INCOME_STABILITY: "Income",
  INCOME_DIVERSIFICATION: "Income Sources",
  PORTFOLIO_EXPOSURE: "Portfolio",
  SECTOR_CONCENTRATION: "Sectors",
  VALUATION_RISK: "Valuation",
  DIVIDEND_OPPORTUNITY: "Dividends",
  DEBT_HEALTH: "Debt",
  DEBT_PAYOFF_TRAJECTORY: "Debt Payoff",
  NET_WORTH_TRAJECTORY: "Net Worth",
  NET_WORTH_MILESTONES: "Milestones",
  SAVINGS_RATE: "Savings",
  SAVINGS_TREND: "Savings Trend",
};

const TIER_BADGE_STYLES: Record<string, string> = {
  DAILY: "bg-muted text-muted-foreground",
  MONTHLY: "bg-brand-primary/10 text-brand-primary",
  QUARTERLY: "bg-positive/10 text-positive",
  ANNUAL: "bg-warning/10 text-warning",
  PORTFOLIO: "bg-brand-deep/10 text-brand-deep",
};

const TIER_LABELS: Record<string, string> = {
  DAILY: "Daily",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Annual",
  PORTFOLIO: "Portfolio",
};

export function InsightCard({ insight, onDismiss, showTierBadge = true }: InsightCardProps) {
  const { t } = useTranslation();
  const severityClass = SEVERITY_STYLES[insight.severity] || SEVERITY_STYLES.INFO;
  const dotClass = SEVERITY_DOT[insight.severity] || SEVERITY_DOT.INFO;
  const tierBadgeClass = TIER_BADGE_STYLES[insight.tier] || TIER_BADGE_STYLES.DAILY;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      layout
    >
      <Card className={`border-l-4 ${severityClass} overflow-hidden`}>
        <CardContent className="py-4 px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              {/* Header: lens badge + tier badge + title */}
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {LENS_LABELS[insight.lens] || insight.lens}
                </span>
                {showTierBadge && insight.tier && (
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 ${tierBadgeClass} border-0`}>
                    {TIER_LABELS[insight.tier] || insight.tier}
                  </Badge>
                )}
                {insight.periodKey && (
                  <span className="text-[10px] text-muted-foreground">
                    {insight.periodKey}
                  </span>
                )}
              </div>
              <h3 className="font-semibold text-sm mb-1">{insight.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {insight.body}
              </p>
              {/* Suggested action */}
              {insight.metadata?.suggestedAction && (
                <p className="text-xs text-brand-primary mt-2 italic">
                  {insight.metadata.suggestedAction}
                </p>
              )}
            </div>
            <button
              onClick={() => onDismiss(insight.id)}
              className="text-muted-foreground hover:text-foreground transition-colors p-1 shrink-0"
              title={t("Dismiss")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

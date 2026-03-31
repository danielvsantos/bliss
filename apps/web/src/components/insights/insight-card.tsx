import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { X } from "lucide-react";

interface Insight {
  id: string;
  lens: string;
  title: string;
  body: string;
  severity: string;
  priority: number;
  date: string;
  metadata?: any;
}

interface InsightCardProps {
  insight: Insight;
  onDismiss: (id: string) => void;
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
  INCOME_STABILITY: "Income",
  PORTFOLIO_EXPOSURE: "Portfolio",
  DEBT_HEALTH: "Debt",
  NET_WORTH_TRAJECTORY: "Net Worth",
  SAVINGS_RATE: "Savings",
};

export function InsightCard({ insight, onDismiss }: InsightCardProps) {
  const { t } = useTranslation();
  const severityClass = SEVERITY_STYLES[insight.severity] || SEVERITY_STYLES.INFO;
  const dotClass = SEVERITY_DOT[insight.severity] || SEVERITY_DOT.INFO;

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
              {/* Header: lens badge + title */}
              <div className="flex items-center gap-2 mb-2">
                <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {LENS_LABELS[insight.lens] || insight.lens}
                </span>
              </div>
              <h3 className="font-semibold text-sm mb-1">{insight.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {insight.body}
              </p>
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

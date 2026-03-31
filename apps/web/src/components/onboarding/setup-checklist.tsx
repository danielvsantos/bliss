import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Check, X, ChevronRight } from "lucide-react";
import { useOnboardingProgress, useCompleteOnboardingStep } from "@/hooks/use-onboarding-progress";
import type { DashboardAction } from "@/lib/dashboard-actions";

interface SetupChecklistProps {
  actions?: DashboardAction[];
}

export function SetupChecklist({ actions }: SetupChecklistProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading } = useOnboardingProgress();
  const completeStep = useCompleteOnboardingStep();

  if (isLoading || !data) return null;

  const progress = data.onboardingProgress;
  const checklist = progress?.checklist;

  // Don't show if dismissed or no checklist data
  if (!checklist || progress?.checklistDismissed) return null;

  // If no actions provided, don't render
  if (!actions || actions.length === 0) return null;

  // Map action IDs to checklist keys
  const actionToChecklistKey: Record<string, string> = {
    'connect-bank': 'connectBank',
    'add-account': 'connectBank', // Shares the same onboarding step
    'review-transactions': 'reviewTransactions',
    'explore-expenses': 'exploreExpenses',
    'check-pnl': 'checkPnL',
  };

  const items = actions.map(action => ({
    key: actionToChecklistKey[action.id] ?? action.id,
    label: t(action.label),
    description: t(action.description),
    href: action.href,
    icon: action.icon,
  }));

  // Deduplicate by key (connect-bank and add-account share the same checklist key)
  const seen = new Set<string>();
  const uniqueItems = items.filter(item => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });

  const completedCount = uniqueItems.filter(
    (item) => checklist[item.key]?.done || checklist[item.key]?.skipped
  ).length;

  // Don't show if all done
  if (completedCount === uniqueItems.length) return null;

  const handleDismiss = () => {
    completeStep.mutate({ step: "dismissChecklist" });
  };

  return (
    <Card className="mb-6 border-brand-primary/20 bg-brand-primary/5">
      <CardContent className="py-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-sm">{t("Get started with Bliss")}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {completedCount} {t("of")} {uniqueItems.length} {t("complete")}
            </p>
          </div>
          <button
            onClick={handleDismiss}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            title={t("Dismiss")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 bg-brand-primary/10 rounded-full mb-4 overflow-hidden">
          <motion.div
            className="h-full bg-brand-primary rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${(completedCount / uniqueItems.length) * 100}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </div>

        {/* Items */}
        <div className="space-y-1">
          {uniqueItems.map((item) => {
            const isDone = checklist[item.key]?.done || checklist[item.key]?.skipped;
            return (
              <button
                key={item.key}
                onClick={() => !isDone && navigate(item.href)}
                className={`w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-colors ${
                  isDone
                    ? "opacity-60"
                    : "hover:bg-brand-primary/10 cursor-pointer"
                }`}
                disabled={isDone}
              >
                <div
                  className={`h-6 w-6 rounded-full flex items-center justify-center shrink-0 ${
                    isDone
                      ? "bg-positive/10 text-positive"
                      : "bg-brand-primary/10 text-brand-primary"
                  }`}
                >
                  {isDone ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <span className="flex items-center justify-center w-3.5 h-3.5">{item.icon}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-sm font-medium ${
                      isDone ? "line-through text-muted-foreground" : ""
                    }`}
                  >
                    {item.label}
                  </p>
                </div>
                {!isDone && (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

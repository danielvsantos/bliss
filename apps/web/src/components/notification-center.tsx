import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useNotificationSummary,
  useMarkNotificationsSeen,
} from "@/hooks/use-notifications";
import {
  Bell,
  ClipboardCheck,
  AlertTriangle,
  ListChecks,
  Sparkles,
  Check,
  ChevronRight,
} from "lucide-react";

const SIGNAL_ICONS: Record<string, React.ReactNode> = {
  PENDING_REVIEW: <ClipboardCheck className="h-4 w-4" />,
  PLAID_ACTION_REQUIRED: <AlertTriangle className="h-4 w-4" />,
  ONBOARDING_INCOMPLETE: <ListChecks className="h-4 w-4" />,
  NEW_INSIGHTS: <Sparkles className="h-4 w-4" />,
};

const SIGNAL_COLORS: Record<string, string> = {
  positive: "text-positive bg-positive/10",
  warning: "text-warning bg-warning/10",
  info: "text-brand-primary bg-brand-primary/10",
};

export function NotificationCenter() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useNotificationSummary();
  const markSeen = useMarkNotificationsSeen();

  const totalUnseen = data?.totalUnseen || 0;
  const signals = data?.signals || [];

  const handleOpen = (open: boolean) => {
    if (open && totalUnseen > 0) {
      markSeen.mutate();
    }
  };

  return (
    <Popover onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <button
          style={{
            width: 34,
            height: 34,
            borderRadius: "0.625rem",
            border: "1px solid hsl(var(--border-color))",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "hsl(var(--brand-primary))",
            position: "relative",
            flexShrink: 0,
          }}
        >
          <Bell className="h-4 w-4" />
          {totalUnseen > 0 && (
            <span
              style={{
                position: "absolute",
                top: 6,
                right: 6,
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "hsl(var(--negative))",
                border: "1.5px solid hsl(var(--background))",
              }}
            />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="px-4 py-3 border-b">
          <h4 className="font-semibold text-sm">{t("notifications.center.title")}</h4>
        </div>

        {signals.length === 0 ? (
          <div className="flex flex-col items-center py-8 px-4 text-center">
            <div className="h-10 w-10 rounded-full bg-positive/10 flex items-center justify-center mb-2">
              <Check className="h-5 w-5 text-positive" />
            </div>
            <p className="text-sm text-muted-foreground">{t("notifications.center.allCaughtUp")}</p>
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {signals.map((signal: any, index: number) => {
              const colorClass = SIGNAL_COLORS[signal.severity] || SIGNAL_COLORS.info;
              return (
                <button
                  key={`${signal.type}-${index}`}
                  onClick={() => navigate(signal.href)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors text-left border-b last:border-b-0"
                >
                  <div
                    className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${colorClass}`}
                  >
                    {SIGNAL_ICONS[signal.type] || <Bell className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{signal.label}</p>
                  </div>
                  {signal.isNew && (
                    <span className="h-2 w-2 rounded-full bg-brand-primary shrink-0" />
                  )}
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

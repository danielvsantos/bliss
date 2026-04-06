import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardTitle, CardDivider } from '@/components/ui/card';
import type { DashboardAction } from '@/lib/dashboard-actions';
import type { UserSignals } from '@/hooks/use-user-signals';

/* ── Quick Action Button ── */

function QuickActionButton({
  icon,
  label,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 w-full h-10 px-3.5 rounded-xl border border-border bg-card/60 hover:bg-muted hover:border-muted-foreground/20 transition-all text-sm font-medium text-brand-deep text-left cursor-pointer"
    >
      <span className="text-brand-primary flex items-center shrink-0">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="bg-negative text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
          {badge}
        </span>
      )}
    </button>
  );
}

/* ── Quick Actions Card ── */

interface QuickActionsCardProps {
  actions: DashboardAction[];
  signals: UserSignals;
  className?: string;
}

export function QuickActionsCard({ actions, signals, className }: QuickActionsCardProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <Card className={`h-full ${className ?? ''}`}>
      <CardHeader>
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-lg font-medium">{t('dashboard.quickActions')}</CardTitle>
          <span className="text-[0.8125rem] text-muted-foreground">{t('dashboard.commonTasks')}</span>
        </div>
      </CardHeader>

      <CardDivider />

      <div className="flex flex-col gap-3 px-6 pb-6">
        {actions.map((action) => (
          <QuickActionButton
            key={action.id}
            icon={action.icon}
            label={action.label}
            badge={action.badge?.(signals)}
            onClick={() => navigate(action.href)}
          />
        ))}
      </div>
    </Card>
  );
}

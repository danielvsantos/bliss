import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { copyTradeBadgeState, type CopyTradeBadgeState } from '@/lib/etoro';
import type { CopyTradeStatus } from '@/types/api';

const CLASSES: Record<CopyTradeBadgeState, string> = {
  linked: 'bg-positive/10 text-positive border-positive/20',
  needsReconnect: 'bg-warning/10 text-warning border-warning/20',
  closed: 'bg-muted text-muted-foreground border-border',
  notLinked: 'bg-muted text-muted-foreground border-border',
};

/**
 * "Linked to eToro" / "eToro key needs replacing" / "Copy closed on eToro" /
 * "Not linked to eToro" on a Copy Trading holding. Renders nothing for any
 * other holding.
 */
export function CopyTradeBadge({ copyTrade, className }: { copyTrade?: CopyTradeStatus | null; className?: string }) {
  const { t } = useTranslation();
  const state = copyTradeBadgeState(copyTrade);
  if (!state) return null;
  const lastValueAt = copyTrade?.linked ? copyTrade.lastValueAt : null;
  return (
    <Badge
      variant="outline"
      className={`px-1.5 py-0 text-[10px] font-medium whitespace-nowrap ${CLASSES[state]} ${className ?? ''}`}
      title={lastValueAt ? t('etoro.badge.lastValue', { date: new Date(lastValueAt).toLocaleDateString() }) : undefined}
      data-testid="copy-trade-badge"
      data-state={state}
    >
      {t(`etoro.badge.${state}`)}
    </Badge>
  );
}

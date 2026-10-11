import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { AlertTriangle, ListChecks } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import type { PlaidItem } from '@/types/api';

interface PendingEnableBankingConnectionsProps {
  plaidItems: PlaidItem[];
  onOpenMapping: (connectionId: string) => void;
  className?: string;
}

/**
 * Enable Banking connections (#132) that were authorised but have no mapped
 * account yet (PENDING_SELECTION). They have no Bliss account to show up under,
 * so they are surfaced here until the user maps them.
 */
export function PendingEnableBankingConnections({ plaidItems, onOpenMapping, className }: PendingEnableBankingConnectionsProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (user?.role === 'viewer') return null;

  const pending = plaidItems.filter(
    (item) => item.provider === 'ENABLE_BANKING' && item.status === 'PENDING_SELECTION',
  );
  if (pending.length === 0) return null;

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      {pending.map((item) => (
        <div
          key={item.id}
          className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid={`eb-pending-${item.id}`}
        >
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>{t('enableBanking.pending.message', { bank: item.institutionName ?? '' })}</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => onOpenMapping(item.id)}>
            <ListChecks className="mr-2 h-3.5 w-3.5" />
            {t('enableBanking.card.mapAccounts')}
          </Button>
        </div>
      ))}
    </div>
  );
}

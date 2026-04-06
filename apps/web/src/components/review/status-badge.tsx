import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import type { TxStatus } from './types';

const statusStyles: Record<TxStatus, string> = {
  'ai-approved': 'bg-positive/10 text-positive border-positive/20 hover:bg-positive/10',
  'new-merchant': 'bg-brand-primary/10 text-brand-primary border-brand-primary/20 hover:bg-brand-primary/10',
  'needs-enrichment': 'bg-warning/10 text-warning border-warning/20 hover:bg-warning/10',
  'low-confidence': 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/10',
  'duplicate': 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/10',
  'potential-duplicate': 'bg-warning/10 text-warning border-warning/20 hover:bg-warning/10',
};

const statusLabelKeys: Record<TxStatus, string> = {
  'ai-approved': 'review.confident',
  'new-merchant': 'review.newMerchant',
  'needs-enrichment': 'review.actionNeeded',
  'low-confidence': 'review.uncertain',
  'duplicate': 'review.duplicate',
  'potential-duplicate': 'review.possibleDup',
};

interface StatusBadgeProps {
  status: TxStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const { t } = useTranslation();
  return (
    <Badge variant="default" className={`text-[10px] font-medium px-1.5 py-0 ${statusStyles[status]}`}>
      {t(statusLabelKeys[status])}
    </Badge>
  );
}

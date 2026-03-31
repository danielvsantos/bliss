import { Badge } from '@/components/ui/badge';
import type { TxStatus } from './types';

const statusConfig: Record<TxStatus, { label: string; className: string }> = {
  'ai-approved': {
    label: 'Confident',
    className: 'bg-positive/10 text-positive border-positive/20 hover:bg-positive/10',
  },
  'new-merchant': {
    label: 'New merchant',
    className: 'bg-brand-primary/10 text-brand-primary border-brand-primary/20 hover:bg-brand-primary/10',
  },
  'needs-enrichment': {
    label: 'Action needed',
    className: 'bg-warning/10 text-warning border-warning/20 hover:bg-warning/10',
  },
  'low-confidence': {
    label: 'Uncertain',
    className: 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/10',
  },
  'duplicate': {
    label: 'Duplicate',
    className: 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/10',
  },
  'potential-duplicate': {
    label: 'Possible dup',
    className: 'bg-warning/10 text-warning border-warning/20 hover:bg-warning/10',
  },
};

interface StatusBadgeProps {
  status: TxStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status];
  return (
    <Badge variant="default" className={`text-[10px] font-medium px-1.5 py-0 ${config.className}`}>
      {config.label}
    </Badge>
  );
}

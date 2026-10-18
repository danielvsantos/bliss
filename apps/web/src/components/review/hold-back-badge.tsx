import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { holdBackLabels } from '@/lib/import-hold-back';
import type { HoldBackReason } from '@/types/api';

interface HoldBackBadgeProps {
  reasons: readonly HoldBackReason[] | null | undefined;
}

/**
 * Why the last commit held this import row back (#142), e.g. "Missing quantity, price".
 * Renders nothing for rows without a hold-back reason.
 */
export function HoldBackBadge({ reasons }: HoldBackBadgeProps) {
  const { t } = useTranslation();
  if (!reasons || reasons.length === 0) return null;
  return (
    <>
      {holdBackLabels(t, reasons).map((label) => (
        <Badge
          key={label}
          variant="default"
          data-testid="hold-back-badge"
          className="text-[10px] font-medium px-1.5 py-0 shrink-0 bg-warning/10 text-warning border-warning/20 hover:bg-warning/10"
        >
          {label}
        </Badge>
      ))}
    </>
  );
}

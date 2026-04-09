import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ChevronDown, ChevronRight, CheckCircle2 } from 'lucide-react';
import { TxDataRow } from './tx-data-row';
import { formatCurrency } from '@/lib/utils';
import type { ReviewItem } from './types';

interface GroupCardProps {
  categoryName: string;
  items: ReviewItem[];
  total: number;
  /** Server-side total count across all pages. When provided and > items.length,
   *  the badge shows this value so groups spanning multiple pages display correctly. */
  totalCount?: number;
  onApprove: (item: ReviewItem) => void;
  onSkip: (item: ReviewItem) => void;
  onApproveAll: () => void;
  onItemClick: (item: ReviewItem) => void;
  disabled?: boolean;
  defaultExpanded?: boolean;
  /** Controlled expansion — when provided, overrides internal state. */
  isExpanded?: boolean;
  /** Called when the user toggles the card. Use with isExpanded for controlled mode. */
  onToggle?: () => void;
  /** Optional pagination node rendered inside the expanded card. */
  pagination?: React.ReactNode;
}

export function GroupCard({
  categoryName,
  items,
  total,
  totalCount,
  onApprove,
  onSkip,
  onApproveAll,
  onItemClick,
  disabled,
  defaultExpanded = true,
  isExpanded,
  onToggle,
  pagination,
}: GroupCardProps) {
  const { t } = useTranslation();
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const expanded = isExpanded !== undefined ? isExpanded : internalExpanded;

  const pendingCount = items.filter(
    (i) => i.promotionStatus !== 'PROMOTED' && i.promotionStatus !== 'CONFIRMED' && i.promotionStatus !== 'SKIPPED',
  ).length;

  return (
    <Card className="overflow-hidden">
      {/* Header — uses div instead of button to avoid button-inside-button nesting */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onToggle ? onToggle() : setInternalExpanded(!internalExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (onToggle) {
              onToggle();
            } else {
              setInternalExpanded(!internalExpanded);
            }
          }
        }}
        className="w-full flex items-center flex-wrap gap-x-3 gap-y-2 px-4 py-3 text-left hover:bg-muted/30 transition-colors cursor-pointer select-none"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}

        <Badge variant="secondary" className="text-xs px-1.5 py-0 font-mono">
          {totalCount ?? items.length}
        </Badge>

        <span className="font-semibold text-sm flex-1 truncate">
          {categoryName}
        </span>

        <span className="text-sm text-muted-foreground tabular-nums mr-2">
          {formatCurrency(total, 'USD')}
        </span>

        {pendingCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={(e) => {
              e.stopPropagation();
              onApproveAll();
            }}
            disabled={disabled}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('review.approveAll')} ({pendingCount})
          </Button>
        )}
      </div>

      {/* Rows */}
      {expanded && (
        <>
          <Separator />

          {/* Column headers (desktop) */}
          <div className="hidden md:flex items-center gap-3 px-4 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/30">
            <span className="w-[80px] shrink-0">{t('review.date')}</span>
            <span className="flex-1 min-w-0">{t('review.merchant')}</span>
            <span className="w-[100px] shrink-0">{t('review.account')}</span>
            <span className="w-[90px] shrink-0 text-right">{t('review.amount')}</span>
            <span className="w-[60px] shrink-0">{t('review.confidence')}</span>
            <span className="w-[110px] shrink-0">{t('review.status')}</span>
            <span className="w-[70px] shrink-0 text-right">{t('review.actions')}</span>
          </div>

          <div className="divide-y">
            {items.map((item) => (
              <TxDataRow
                key={item.id}
                item={item}
                onApprove={() => onApprove(item)}
                onSkip={() => onSkip(item)}
                onClick={() => onItemClick(item)}
                disabled={disabled}
              />
            ))}
          </div>
          {pagination && <div className="px-4 py-2">{pagination}</div>}
        </>
      )}
    </Card>
  );
}

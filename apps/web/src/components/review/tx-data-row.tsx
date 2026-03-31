import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, ArrowRight, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { StatusBadge } from './status-badge';
import { ConfidenceDisplay } from './confidence-display';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ReviewItem } from './types';

interface TxDataRowProps {
  item: ReviewItem;
  onApprove: () => void;
  onSkip: () => void;
  onClick: () => void;
  disabled?: boolean;
}

const DIFF_FIELD_LABELS: Record<string, string> = {
  description: 'Description',
  details: 'Details',
  debit: 'Debit',
  credit: 'Credit',
  categoryId: 'Category',
  transactionDate: 'Date',
  currency: 'Currency',
  tags: 'Tags',
  ticker: 'Ticker',
  assetQuantity: 'Quantity',
  assetPrice: 'Price',
};

function DiffDisplay({ diff }: { diff: Record<string, { old: unknown; new: unknown; oldName?: string; newName?: string }> }) {
  const entries = Object.entries(diff);
  if (entries.length === 0) return null;

  return (
    <div className="px-4 py-2 bg-muted/30 border-t border-border/40 text-xs space-y-1">
      {entries.map(([field, change]) => {
        const label = DIFF_FIELD_LABELS[field] || field;

        if (field === 'tags') {
          const oldTags = (change.old as string[]) || [];
          const newTags = (change.new as string[]) || [];
          const added = newTags.filter((t) => !oldTags.includes(t));
          const removed = oldTags.filter((t) => !newTags.includes(t));
          return (
            <div key={field} className="flex items-center gap-1.5 flex-wrap">
              <span className="text-muted-foreground w-[70px] shrink-0">{label}:</span>
              {removed.map((t) => (
                <span key={`-${t}`} className="text-destructive">-{t}</span>
              ))}
              {added.map((t) => (
                <span key={`+${t}`} className="text-positive">+{t}</span>
              ))}
            </div>
          );
        }

        if (field === 'categoryId') {
          return (
            <div key={field} className="flex items-center gap-1.5">
              <span className="text-muted-foreground w-[70px] shrink-0">{label}:</span>
              <span className="text-muted-foreground line-through">{String(change.oldName ?? change.old ?? '-')}</span>
              <span className="text-muted-foreground">&rarr;</span>
              <span className="font-medium">{String(change.newName ?? change.new ?? '-')}</span>
            </div>
          );
        }

        return (
          <div key={field} className="flex items-center gap-1.5">
            <span className="text-muted-foreground w-[70px] shrink-0">{label}:</span>
            <span className="text-muted-foreground line-through">{String(change.old ?? '-')}</span>
            <span className="text-muted-foreground">&rarr;</span>
            <span className="font-medium">{String(change.new ?? '-')}</span>
          </div>
        );
      })}
    </div>
  );
}

export function TxDataRow({ item, onApprove, onSkip, onClick, disabled }: TxDataRowProps) {
  const [showDiff, setShowDiff] = useState(false);
  const isIncome = item.amount < 0;
  const isPromoted = item.promotionStatus === 'PROMOTED' || item.promotionStatus === 'CONFIRMED';
  const isSkipped = item.promotionStatus === 'SKIPPED';
  const isDuplicate = item.promotionStatus === 'DUPLICATE' || item.promotionStatus === 'POTENTIAL_DUPLICATE';
  const isUpdate = !!item.updateTargetId;
  const hasDiff = isUpdate && item.updateDiff && Object.keys(item.updateDiff).length > 0;

  const bgClass = isPromoted
    ? 'bg-positive/5 opacity-60'
    : isSkipped
      ? 'opacity-40'
      : isDuplicate
        ? 'bg-destructive/5 opacity-70'
        : isUpdate
          ? 'bg-brand-primary/5'
          : '';

  const amountFormatted = `${isIncome ? '+' : '-'}${formatCurrency(Math.abs(item.amount), item.currency)}`;
  const amountColor = isIncome ? 'text-positive' : 'text-negative';

  const showActions = !isPromoted && !isSkipped;

  const needsEnrichment = item.requiresEnrichment && item.enrichmentType === 'INVESTMENT';
  const approveIcon = needsEnrichment ? <ArrowRight className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />;
  const approveIconMobile = needsEnrichment ? <ArrowRight className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />;
  const approveColor = needsEnrichment
    ? 'text-warning hover:text-warning hover:bg-warning/10'
    : 'text-positive hover:text-positive hover:bg-positive/10';
  const approveTitle = needsEnrichment ? 'Open drawer (enrichment required)' : 'Approve (Y)';
  const approveTitleMobile = needsEnrichment ? 'Open drawer (enrichment required)' : 'Approve';

  return (
    <>
      {/* ── Desktop row ── */}
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
        className={`
          hidden md:flex items-center gap-3 px-4 py-2.5 text-sm transition-colors cursor-pointer
          hover:bg-muted/50 ${bgClass}
        `}
      >
        <span className="w-[80px] shrink-0 text-muted-foreground whitespace-nowrap text-xs">
          {formatDate(item.date)}
        </span>
        <span className="flex-1 min-w-0 truncate font-medium flex items-center gap-1.5" title={item.description}>
          {isUpdate && <RefreshCw className="h-3.5 w-3.5 text-brand-primary shrink-0" />}
          {item.merchant}
          {isUpdate && (
            <Badge className="bg-brand-primary/10 text-brand-primary border-brand-primary/20 hover:bg-brand-primary/10 text-[10px] px-1.5 py-0">
              Update
            </Badge>
          )}
        </span>
        <span className="w-[100px] shrink-0 text-xs text-muted-foreground truncate" title={item.accountName}>
          {item.accountName || '-'}
        </span>
        <span className={`w-[90px] shrink-0 text-right font-medium tabular-nums ${amountColor}`}>
          {amountFormatted}
        </span>
        <span className="w-[60px] shrink-0">
          <ConfidenceDisplay confidence={item.confidence} source={item.classificationSource} />
        </span>
        <span className="w-[110px] shrink-0">
          <StatusBadge status={item.status} />
        </span>
        <span className="w-[70px] shrink-0 flex items-center gap-1 justify-end">
          {hasDiff && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-brand-primary hover:text-brand-primary hover:bg-brand-primary/10"
              onClick={(e) => { e.stopPropagation(); setShowDiff(!showDiff); }}
              title={showDiff ? 'Hide changes' : 'Show changes'}
            >
              {showDiff ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          )}
          {showActions && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className={`h-7 w-7 ${approveColor}`}
                onClick={(e) => { e.stopPropagation(); onApprove(); }}
                disabled={disabled}
                title={approveTitle}
              >
                {approveIcon}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={(e) => { e.stopPropagation(); onSkip(); }}
                disabled={disabled}
                title="Skip (N)"
              >
                <XCircle className="h-4 w-4" />
              </Button>
            </>
          )}
        </span>
      </div>

      {/* Desktop diff panel */}
      {showDiff && hasDiff && (
        <div className="hidden md:block">
          <DiffDisplay diff={item.updateDiff!} />
        </div>
      )}

      {/* ── Mobile card ── */}
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
        className={`
          md:hidden px-4 py-3 transition-colors cursor-pointer
          hover:bg-muted/50 ${bgClass}
        `}
      >
        {/* Line 1: merchant + amount */}
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm truncate min-w-0 flex items-center gap-1" title={item.description}>
            {isUpdate && <RefreshCw className="h-3 w-3 text-brand-primary shrink-0" />}
            {item.merchant}
          </span>
          <span className={`text-sm font-medium tabular-nums shrink-0 ${amountColor}`}>
            {amountFormatted}
          </span>
        </div>

        {/* Line 2: metadata + actions */}
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className="text-[11px] text-muted-foreground whitespace-nowrap">
            {formatDate(item.date)}
          </span>
          <span className="text-muted-foreground text-[11px]">&middot;</span>
          <span className="text-[11px] text-muted-foreground truncate max-w-[120px]" title={item.accountName}>
            {item.accountName || '-'}
          </span>
          {isUpdate && (
            <>
              <span className="text-muted-foreground text-[11px]">&middot;</span>
              <Badge className="bg-brand-primary/10 text-brand-primary border-brand-primary/20 text-[10px] px-1 py-0">Update</Badge>
            </>
          )}
          {item.confidence != null && (
            <>
              <span className="text-muted-foreground text-[11px]">&middot;</span>
              <ConfidenceDisplay confidence={item.confidence} source={item.classificationSource} />
            </>
          )}
          <span className="text-muted-foreground text-[11px]">&middot;</span>
          <StatusBadge status={item.status} />

          {showActions && (
            <span className="ml-auto flex items-center gap-0.5 shrink-0">
              {hasDiff && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-brand-primary hover:text-brand-primary hover:bg-brand-primary/10"
                  onClick={(e) => { e.stopPropagation(); setShowDiff(!showDiff); }}
                  title={showDiff ? 'Hide changes' : 'Show changes'}
                >
                  {showDiff ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 ${approveColor}`}
                onClick={(e) => { e.stopPropagation(); onApprove(); }}
                disabled={disabled}
                title={approveTitleMobile}
              >
                {approveIconMobile}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={(e) => { e.stopPropagation(); onSkip(); }}
                disabled={disabled}
                title="Skip"
              >
                <XCircle className="h-3.5 w-3.5" />
              </Button>
            </span>
          )}
        </div>
      </div>

      {/* Mobile diff panel */}
      {showDiff && hasDiff && (
        <div className="md:hidden">
          <DiffDisplay diff={item.updateDiff!} />
        </div>
      )}
    </>
  );
}

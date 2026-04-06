import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Clock } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useMerchantHistory } from '@/hooks/use-merchant-history';

interface MerchantHistoryProps {
  description: string | null | undefined;
}

export function MerchantHistory({ description }: MerchantHistoryProps) {
  const { t } = useTranslation();
  const { data: history, isLoading } = useMerchantHistory(description);

  if (!description) return null;

  return (
    <Card>
      <CardContent className="pt-4 pb-3 space-y-3">
        {/* Section header */}
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('review.merchantHistory')}
          </span>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : !history || history.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            {t('review.noMerchantHistory')}
          </p>
        ) : (
          <div className="divide-y">
            {history.map((tx, i) => {
              const amount = (Number(tx.credit) || 0) - (Number(tx.debit) || 0);
              const isIncome = amount > 0;
              return (
                <div
                  key={tx.id ?? i}
                  className={`flex items-center gap-3 py-1.5 text-xs ${
                    i % 2 === 1 ? 'bg-muted/30' : ''
                  }`}
                >
                  <span className="w-[70px] shrink-0 text-muted-foreground">
                    {formatDate(tx.transaction_date)}
                  </span>
                  <span
                    className={`w-[80px] shrink-0 text-right tabular-nums font-medium ${
                      isIncome ? 'text-positive' : 'text-negative'
                    }`}
                  >
                    {isIncome ? '+' : '-'}
                    {formatCurrency(Math.abs(amount), tx.currency || 'USD')}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-muted-foreground">
                    {tx.category?.name ?? t('review.uncategorized')}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

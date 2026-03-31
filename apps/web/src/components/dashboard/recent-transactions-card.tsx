import { useNavigate } from 'react-router-dom';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDivider } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTransactions } from '@/hooks/use-transactions';
import { formatCurrency, formatDate } from '@/lib/utils';

/* ── Background color by category type ── */
function getCategoryBg(type?: string): string {
  switch (type) {
    case 'Income':
      return 'bg-positive/10';
    case 'Essentials':
    case 'Lifestyle':
      return 'bg-brand-primary/10';
    case 'Debt':
      return 'bg-negative/10';
    default:
      return 'bg-muted';
  }
}

/* ── Transaction Row ── */

function TransactionRow({
  description,
  emoji,
  categoryType,
  categoryName,
  amount,
  date,
  currencyCode,
  accountName,
}: {
  description: string;
  emoji: string;
  categoryType?: string;
  categoryName?: string;
  amount: number;
  date: string;
  currencyCode: string;
  accountName: string;
}) {
  const bgClass = getCategoryBg(categoryType);
  const isPositive = amount >= 0;

  // Safe date formatting — transaction_date may be "YYYY-MM-DD" or ISO string
  const dateObj = date ? new Date(date + (date.length === 10 ? 'T00:00:00' : '')) : null;
  const formattedDate = dateObj && !isNaN(dateObj.getTime())
    ? formatDate(dateObj, { month: 'short', day: 'numeric', year: 'numeric' })
    : '';
  const formattedDateShort = dateObj && !isNaN(dateObj.getTime())
    ? formatDate(dateObj, { month: 'short', day: 'numeric' })
    : '';

  // Build mobile subtitle parts
  const mobileParts = [formattedDateShort, categoryName, accountName].filter(Boolean);

  return (
    <div className="flex items-center gap-3 py-3 px-4">
      {/* Category emoji */}
      <div className={`w-9 h-9 rounded-[10px] ${bgClass} flex items-center justify-center shrink-0`}>
        <span className="text-base leading-none">{emoji}</span>
      </div>

      {/* Date */}
      <span className="text-xs text-muted-foreground shrink-0 w-[88px] hidden sm:block">
        {formattedDate}
      </span>

      {/* Account */}
      <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate hidden sm:block">
        {accountName || '—'}
      </span>

      {/* Category */}
      <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate hidden md:block">
        {categoryName || '—'}
      </span>

      {/* Description + mobile subtitle */}
      <div className="flex-[2] min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{description}</p>
        <p className="text-xs text-muted-foreground truncate sm:hidden">
          {mobileParts.join(' · ')}
        </p>
      </div>

      {/* Amount */}
      <span className={`text-sm font-semibold shrink-0 tabular-nums tracking-tight ${isPositive ? 'text-positive' : 'text-negative'}`}>
        {isPositive ? '+' : ''}{formatCurrency(amount, currencyCode)}
      </span>

      {/* Actions */}
      <button className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted transition-colors cursor-pointer hidden sm:flex">
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
}

/* ── Recent Transactions Card ── */

interface RecentTransactionsCardProps {
  className?: string;
}

export function RecentTransactionsCard({ className }: RecentTransactionsCardProps) {
  const navigate = useNavigate();
  const { data: txData, isLoading } = useTransactions({ limit: 5 });

  const transactions = txData?.transactions ?? [];

  if (isLoading) {
    return (
      <Card className={`${className ?? ''}`}>
        <div className="p-6 space-y-4">
          <Skeleton className="h-5 w-44" />
          <div className="space-y-3 mt-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className={`${className ?? ''}`}>
      <CardHeader>
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-lg font-medium">Recent Transactions</CardTitle>
          <span className="text-[0.8125rem] text-muted-foreground">
            All connected accounts
          </span>
        </div>
      </CardHeader>

      <CardDivider />

      {/* Column headers */}
      <div className="flex items-center pl-16 pr-4 py-1.5 gap-3">
        <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase w-[88px] shrink-0 hidden sm:block">
          Date
        </span>
        <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase flex-1 min-w-0 hidden sm:block">
          Account
        </span>
        <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase flex-1 min-w-0 hidden md:block">
          Category
        </span>
        <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase flex-[2] min-w-0">
          Description
        </span>
        <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase shrink-0 text-right">
          Amount
        </span>
        {/* Actions spacer */}
        <span className="w-7 shrink-0 hidden sm:block" />
      </div>

      <CardDivider />

      {/* Transaction rows */}
      <div className="flex flex-col">
        {transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No transactions yet
          </p>
        ) : (
          transactions.map((tx: any, i: number) => {
            const amount = (tx.credit ?? 0) - (tx.debit ?? 0);
            return (
              <div key={tx.id}>
                <TransactionRow
                  description={tx.description}
                  emoji={tx.category?.icon || '📋'}
                  categoryType={tx.category?.type}
                  categoryName={tx.category?.name}
                  amount={amount}
                  date={tx.transaction_date}
                  currencyCode={tx.account?.currencyCode ?? tx.currency ?? 'USD'}
                  accountName={tx.account?.name ?? ''}
                />
                {i < transactions.length - 1 && (
                  <div className="h-px bg-border/60 ml-[60px] mr-4" />
                )}
              </div>
            );
          })
        )}
      </div>

      <CardDivider />

      {/* Footer */}
      <div className="px-4 py-3 flex justify-center">
        <button
          onClick={() => navigate('/transactions')}
          className="flex items-center gap-1 text-[0.8125rem] font-medium text-brand-primary hover:text-brand-deep transition-colors cursor-pointer"
        >
          View all transactions
          <ChevronRight size={14} />
        </button>
      </div>
    </Card>
  );
}

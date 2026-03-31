import { useState, useMemo } from 'react';
import { useTransactions } from '@/hooks/use-transactions';
import type { TransactionFilters } from '@/hooks/use-transactions';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { formatCurrency } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, List, LayoutGrid } from 'lucide-react';

interface ExpenseTransactionListProps {
  dateRange: { from: Date; to: Date };
  currency: string;
  categoryGroup: string;
}

const PAGE_SIZE = 50;

export function ExpenseTransactionList({ dateRange, categoryGroup, currency }: ExpenseTransactionListProps) {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<'transactions' | 'categories'>('transactions');
  const [page, setPage] = useState(1);

  // Transaction list query (paginated)
  const filters: TransactionFilters = useMemo(() => ({
    page,
    limit: PAGE_SIZE,
    sortField: 'transaction_date',
    sortDirection: 'desc' as const,
    startDate: format(dateRange.from, 'yyyy-MM-dd'),
    endDate: format(dateRange.to, 'yyyy-MM-dd'),
    group: categoryGroup,
  }), [dateRange, categoryGroup, page]);

  const { data, isLoading, isError } = useTransactions(filters);

  // Category summary query — fetch up to 1000 to aggregate
  const summaryFilters: TransactionFilters = useMemo(() => ({
    page: 1,
    limit: 1000,
    sortField: 'transaction_date',
    sortDirection: 'desc' as const,
    startDate: format(dateRange.from, 'yyyy-MM-dd'),
    endDate: format(dateRange.to, 'yyyy-MM-dd'),
    group: categoryGroup,
  }), [dateRange, categoryGroup]);

  const { data: summaryData, isLoading: summaryLoading } = useTransactions(
    viewMode === 'categories' ? summaryFilters : {} as TransactionFilters,
  );

  // Aggregate transactions by category
  const categorySummary = useMemo(() => {
    if (viewMode !== 'categories' || !summaryData?.transactions) return [];
    const totals: Record<string, { name: string; debit: number; count: number }> = {};

    for (const tx of summaryData.transactions) {
      const catName = tx.category?.name || 'Uncategorized';
      if (!totals[catName]) {
        totals[catName] = { name: catName, debit: 0, count: 0 };
      }
      totals[catName].debit += tx.debit || 0;
      totals[catName].count += 1;
    }

    return Object.values(totals).sort((a, b) => b.debit - a.debit);
  }, [summaryData, viewMode]);

  const categoryTotal = useMemo(
    () => categorySummary.reduce((sum, c) => sum + c.debit, 0),
    [categorySummary],
  );

  // Reset page when filters change
  const handleViewChange = (mode: 'transactions' | 'categories') => {
    setViewMode(mode);
    setPage(1);
  };

  if (isLoading && viewMode === 'transactions') {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (isError) {
    return <div className="text-center text-destructive">Failed to load transactions.</div>;
  }

  const isEmpty = viewMode === 'transactions'
    ? !data || data.transactions.length === 0
    : !summaryLoading && categorySummary.length === 0;

  if (isEmpty && !isLoading && !summaryLoading) {
    return <div className="text-center text-muted-foreground">No transactions found for this category in the selected period.</div>;
  }

  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;

  return (
    <div className="space-y-3">
      {/* View toggle */}
      <div className="flex items-center gap-1">
        <Button
          variant={viewMode === 'transactions' ? 'default' : 'outline'}
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => handleViewChange('transactions')}
        >
          <List className="h-3.5 w-3.5" />
          Transactions
        </Button>
        <Button
          variant={viewMode === 'categories' ? 'default' : 'outline'}
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => handleViewChange('categories')}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          By Category
        </Button>
      </div>

      {/* Category Summary View */}
      {viewMode === 'categories' && (
        summaryLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : (
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Transactions</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">% of Group</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categorySummary.map((cat) => (
                  <TableRow key={cat.name}>
                    <TableCell className="font-medium">
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
                        {cat.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {cat.count}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums text-negative">
                      {formatCurrency(cat.debit, currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {categoryTotal > 0 ? ((cat.debit / categoryTotal) * 100).toFixed(1) : '0'}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {categorySummary.length > 1 && (
                <tfoot>
                  <tr className="border-t">
                    <td className="px-4 py-3 text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                      Total
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {categorySummary.reduce((sum, c) => sum + c.count, 0)}
                    </td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums text-negative">
                      {formatCurrency(categoryTotal, currency)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </Table>
          </div>
        )
      )}

      {/* Transaction List View */}
      {viewMode === 'transactions' && data && (
        <>
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.transactions.map((transaction) => (
                  <TableRow key={transaction.id} onClick={() => navigate(`/transactions?id=${transaction.id}`)} className="cursor-pointer hover:bg-muted/50">
                    <TableCell>{format(new Date(transaction.transaction_date), 'PP')}</TableCell>
                    <TableCell className="font-medium">{transaction.description}</TableCell>
                    <TableCell>
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
                        {transaction.category?.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-negative font-semibold tabular-nums">
                      {formatCurrency(transaction.debit || 0, transaction.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-sm text-muted-foreground">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm tabular-nums px-2">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardDivider } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import {
  PlusIcon,
  MoreHorizontalIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XIcon,
  UploadIcon,
  DownloadIcon,
  CalendarIcon,
  Loader2Icon,
} from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Link } from 'react-router-dom';
import { TransactionForm } from '@/components/entities/transaction-form';
import { useToast } from '@/hooks/use-toast';
import { useTransactions, TransactionFilters } from '@/hooks/use-transactions';
import { useExportTransactions } from '@/hooks/use-export-transactions';
import { useMetadata } from '@/hooks/use-metadata';
import { api } from '@/lib/api';
import { cn, formatCurrency, formatDate } from '@/lib/utils';
import { format, parse } from 'date-fns';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { Transaction, Account, Category } from '@/types/api';

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

export default function TransactionsPage() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [showTransactionForm, setShowTransactionForm] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportScope, setExportScope] = useState<'filtered' | 'all'>('filtered');
  const [showExportProgress, setShowExportProgress] = useState(false);
  const { exportTransactions, isExporting } = useExportTransactions();

  const [filters, setFilters] = useState<TransactionFilters>({
    page: 1,
    limit: 25,
    startDate: undefined,
    endDate: undefined,
    accountId: undefined,
    group: undefined,
    categoryId: undefined,
  });

  const { data: metadata, isLoading: metadataLoading } = useMetadata();

  const {
    data: transactionsResponse,
    isLoading: transactionsLoading,
    error,
    refetch
  } = useTransactions(filters);

  const transactions = transactionsResponse?.transactions ?? [];
  const totalPages = transactionsResponse?.totalPages ?? 1;

  const accountsMap = useMemo(() =>
    metadata?.accounts
      ? new Map(metadata.accounts.map((acc: Account) => [acc.id, acc]))
      : new Map(),
    [metadata?.accounts]
  );

  const categoriesMap = useMemo(() =>
    metadata?.categories
      ? new Map(metadata.categories.map((cat: Category) => [cat.id, cat]))
      : new Map(),
    [metadata?.categories]
  );

  // Unique category groups for the group filter
  const categoryGroups = useMemo(() => {
    if (!metadata?.categories) return [];
    return Array.from(new Set(metadata.categories.map((c: Category) => c.group))).sort();
  }, [metadata?.categories]);

  // Filter categories by selected group for the category dropdown
  const filteredCategories = useMemo(() => {
    if (!metadata?.categories) return [];
    if (!filters.group) return metadata.categories;
    return metadata.categories.filter((c: Category) => c.group === filters.group);
  }, [metadata?.categories, filters.group]);

  const isLoading = transactionsLoading || metadataLoading;

  const handleFilterChange = (key: keyof TransactionFilters, value: string | number | undefined) => {
    const newFilters = { ...filters, [key]: value };
    if (key !== 'page') {
      newFilters.page = 1;
    }
    // When changing group, reset categoryId
    if (key === 'group') {
      newFilters.categoryId = undefined;
    }
    setFilters(newFilters);
  };

  const handleAddTransaction = () => {
    setSelectedTransaction(null);
    setShowTransactionForm(true);
  };

  const handleEditTransaction = (transaction: Transaction) => {
    setSelectedTransaction(transaction);
    setShowTransactionForm(true);
  };

  const handleDeleteTransactionClick = (transaction: Transaction) => {
    setSelectedTransaction(transaction);
    setShowDeleteConfirm(true);
  };

  const handleDeleteTransaction = async () => {
    if (!selectedTransaction?.id) return;
    setIsDeleting(true);
    try {
      await api.deleteTransaction(selectedTransaction.id);
      toast({
        title: t('notifications.success.deleted'),
        description: t('notifications.success.deleted'),
      });
      setShowDeleteConfirm(false);
      refetch();
    } catch (error) {
      toast({
        title: t('common.error'),
        description: t('notifications.error.general'),
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const closeTransactionForm = (refetchNeeded = false) => {
    setShowTransactionForm(false);
    setSelectedTransaction(null);
    if (refetchNeeded) {
      refetch();
    }
  };

  const runExport = async (params: Record<string, unknown>) => {
    setShowExportProgress(true);
    try {
      await exportTransactions(params);
      toast({ title: 'Export complete', description: 'CSV file downloaded.' });
    } catch {
      toast({ title: t('common.error'), description: 'Export failed.', variant: 'destructive' });
    } finally {
      setShowExportProgress(false);
    }
  };

  const handleExportClick = () => {
    if (hasActiveFilters) {
      setExportScope('filtered');
      setShowExportDialog(true);
    } else {
      runExport({});
    }
  };

  const handleExportConfirm = () => {
    setShowExportDialog(false);
    const params = exportScope === 'filtered' ? {
      startDate: filters.startDate,
      endDate: filters.endDate,
      accountId: filters.accountId,
      categoryId: filters.categoryId,
      group: filters.group,
    } : {};
    runExport(params);
  };

  const getTransactionAmount = (transaction: Transaction) => {
    if (!transaction) return formatCurrency(0, 'USD');
    const amount = (Number(transaction.credit) || 0) - (Number(transaction.debit) || 0);
    return formatCurrency(amount, transaction.currency);
  };

  const hasActiveFilters = !!(filters.startDate || filters.endDate || filters.accountId || filters.group || filters.categoryId);

  const clearFilters = () => {
    setFilters({
      page: 1,
      limit: 25,
      startDate: undefined,
      endDate: undefined,
      accountId: undefined,
      group: undefined,
      categoryId: undefined,
    });
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('pages.transactions.title')}</h1>
          <p className="text-muted-foreground">{t('pages.transactions.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExportClick} disabled={isExporting} className="flex items-center gap-1">
            <DownloadIcon className="h-4 w-4" />
            <span>{isExporting ? 'Exporting...' : 'Export CSV'}</span>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/agents/import?adapter=native" className="flex items-center gap-1">
              <UploadIcon className="h-4 w-4" />
              <span>Import CSV</span>
            </Link>
          </Button>
          <Button onClick={handleAddTransaction} className="flex items-center gap-1">
            <PlusIcon className="h-4 w-4" />
            <span>{t('pages.transactions.addTransaction')}</span>
          </Button>
        </div>
      </div>

      <div className="h-px bg-border my-6" />

      {/* ── Filter Bar ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 mb-6">
        <div className="flex flex-col md:flex-row gap-3 items-end">
          {/* Date range */}
          <div className="flex gap-2 items-end">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Start Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      'w-[150px] pl-3 text-left font-normal h-9 text-sm',
                      !filters.startDate && 'text-muted-foreground',
                    )}
                  >
                    {filters.startDate
                      ? format(parse(filters.startDate, 'yyyy-MM-dd', new Date()), 'MMM d, yyyy')
                      : 'Pick date'}
                    <CalendarIcon className="ml-auto h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    captionLayout="dropdown-buttons"
                    fromYear={2010}
                    toYear={new Date().getFullYear() + 1}
                    selected={filters.startDate ? parse(filters.startDate, 'yyyy-MM-dd', new Date()) : undefined}
                    onSelect={(date) =>
                      handleFilterChange('startDate', date ? format(date, 'yyyy-MM-dd') : undefined)
                    }
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">End Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      'w-[150px] pl-3 text-left font-normal h-9 text-sm',
                      !filters.endDate && 'text-muted-foreground',
                    )}
                  >
                    {filters.endDate
                      ? format(parse(filters.endDate, 'yyyy-MM-dd', new Date()), 'MMM d, yyyy')
                      : 'Pick date'}
                    <CalendarIcon className="ml-auto h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    captionLayout="dropdown-buttons"
                    fromYear={2010}
                    toYear={new Date().getFullYear() + 1}
                    selected={filters.endDate ? parse(filters.endDate, 'yyyy-MM-dd', new Date()) : undefined}
                    onSelect={(date) =>
                      handleFilterChange('endDate', date ? format(date, 'yyyy-MM-dd') : undefined)
                    }
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Account */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Account</Label>
            <Select
              value={filters.accountId?.toString() ?? 'all'}
              onValueChange={(value) => handleFilterChange('accountId', value === 'all' ? undefined : Number(value))}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Accounts</SelectItem>
                {metadata?.accounts?.map((account: Account) => (
                  <SelectItem key={account.id} value={String(account.id)}>{account.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Category Group */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Category Group</Label>
            <Select
              value={filters.group ?? 'all'}
              onValueChange={(value) => handleFilterChange('group', value === 'all' ? undefined : value)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Groups" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Groups</SelectItem>
                {categoryGroups.map((group: string) => (
                  <SelectItem key={group} value={group}>{group}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Category */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Category</Label>
            <Select
              value={filters.categoryId?.toString() ?? 'all'}
              onValueChange={(value) => handleFilterChange('categoryId', value === 'all' ? undefined : Number(value))}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {filteredCategories.map((category: Category) => (
                  <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Clear */}
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9">
              <XIcon className="h-4 w-4 mr-1" />
              Clear
            </Button>
          )}
        </div>
      </div>

      <Card>
        {isLoading ? (
          <div className="animate-pulse space-y-4 p-6">
            <div className="h-10 bg-muted rounded" />
            {[...Array(10)].map((_, i) => <div key={i} className="h-14 bg-muted rounded" />)}
          </div>
        ) : error ? (
          <div className="py-10 text-center">
            <h3 className="text-lg font-medium">{t('notifications.error.general')}</h3>
            <p className="text-muted-foreground mt-2">{t('notifications.error.network')}</p>
            <Button variant="outline" className="mt-4" onClick={() => refetch()}>{t('ui.retry')}</Button>
          </div>
        ) : transactions.length === 0 ? (
          <div className="py-10 text-center">
            <h3 className="text-lg font-medium">{t('pages.transactions.noTransactionsFound')}</h3>
            <p className="text-muted-foreground mt-2">{t('pages.transactions.tryDifferentFilters')}</p>
            {hasActiveFilters && (
              <Button variant="outline" className="mt-4" onClick={clearFilters}>
                <XIcon className="h-4 w-4 mr-2" /> {t('common.clearFilter')}
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Column headers — matches recent-transactions-card pattern */}
            <div className="flex items-center pl-16 pr-4 py-1.5 gap-3">
              <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase w-[88px] shrink-0 hidden sm:block">
                {t('charts.date')}
              </span>
              <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase flex-1 min-w-0 hidden sm:block">
                {t('common.account')}
              </span>
              <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase flex-1 min-w-0 hidden md:block">
                {t('charts.category')}
              </span>
              <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase flex-[2] min-w-0">
                {t('common.description')}
              </span>
              <span className="text-[0.6875rem] font-semibold text-muted-foreground/70 tracking-widest uppercase shrink-0 w-24 text-right">
                {t('charts.amount')}
              </span>
              {/* Actions spacer */}
              <span className="w-7 shrink-0 hidden sm:block" />
            </div>

            <CardDivider />

            {/* Transaction rows */}
            <div className="flex flex-col">
              {transactions.map((transaction, i) => {
                const category = categoriesMap.get(transaction.categoryId);
                const account = accountsMap.get(transaction.accountId);
                const amount = (Number(transaction.credit) || 0) - (Number(transaction.debit) || 0);
                const isPositive = amount >= 0;
                const emoji = category?.icon || '📋';
                const bgClass = getCategoryBg(category?.type);

                // Date formatting
                const dateStr = transaction.transaction_date;
                const dateObj = dateStr ? new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00' : '')) : null;
                const formattedDate = dateObj && !isNaN(dateObj.getTime())
                  ? formatDate(dateObj, { month: 'short', day: 'numeric', year: 'numeric' })
                  : '';
                const formattedDateShort = dateObj && !isNaN(dateObj.getTime())
                  ? formatDate(dateObj, { month: 'short', day: 'numeric' })
                  : '';

                const mobileParts = [formattedDateShort, category?.name, account?.name].filter(Boolean);

                return (
                  <div key={transaction.id}>
                    <div
                      className="flex items-center gap-3 py-3 px-4 cursor-pointer hover:bg-accent/50 transition-colors"
                      onClick={() => handleEditTransaction(transaction)}
                    >
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
                        {account?.name || '—'}
                      </span>

                      {/* Category */}
                      <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate hidden md:block">
                        {category?.name || '—'}
                      </span>

                      {/* Description + mobile subtitle */}
                      <div className="flex-[2] min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{transaction.description}</p>
                        <p className="text-xs text-muted-foreground truncate sm:hidden">
                          {mobileParts.join(' · ')}
                        </p>
                      </div>

                      {/* Amount */}
                      <span className={`text-sm font-semibold shrink-0 w-24 text-right tabular-nums tracking-tight ${isPositive ? 'text-positive' : 'text-negative'}`}>
                        {isPositive ? '+' : ''}{formatCurrency(amount, transaction.currency)}
                      </span>

                      {/* Actions */}
                      <div className="shrink-0 w-7 hidden sm:block" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <button className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted transition-colors cursor-pointer">
                              <MoreHorizontalIcon className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleEditTransaction(transaction)}>{t('common.edit')}</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDeleteTransactionClick(transaction)} className="text-destructive focus:text-destructive">{t('common.delete')}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    {i < transactions.length - 1 && (
                      <div className="h-px bg-border/60 ml-[60px] mr-4" />
                    )}
                  </div>
                );
              })}
            </div>

            <CardDivider />

            {/* Pagination footer */}
            <div className="flex justify-between items-center px-4 py-3">
              <p className="text-sm text-muted-foreground">Page {filters.page || 1} of {totalPages}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => handleFilterChange('page', (filters.page || 1) - 1)} disabled={(filters.page || 1) <= 1}>
                  <ChevronLeftIcon className="h-4 w-4 mr-2" /> {t('common.previous')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleFilterChange('page', (filters.page || 1) + 1)} disabled={(filters.page || 1) >= totalPages}>
                  {t('common.next')} <ChevronRightIcon className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* Dialogs */}
      <Dialog
        open={showDeleteConfirm}
        onOpenChange={(open) => {
          if (!open) { setShowDeleteConfirm(false); setSelectedTransaction(null); }
        }}
      >
        <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('pages.transactions.deleteTransaction')}</DialogTitle>
            <DialogDescription>{t('notifications.warning.deleteConfirmation')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDeleteConfirm(false); setSelectedTransaction(null); }}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={handleDeleteTransaction} disabled={isDeleting}>
              {isDeleting ? t('ui.loading') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Export Transactions</DialogTitle>
            <DialogDescription>Choose which transactions to export as CSV.</DialogDescription>
          </DialogHeader>
          <RadioGroup value={exportScope} onValueChange={(v) => setExportScope(v as 'filtered' | 'all')} className="space-y-3 py-2">
            <div className="flex items-center space-x-3">
              <RadioGroupItem value="filtered" id="export-filtered" />
              <Label htmlFor="export-filtered" className="cursor-pointer">
                Current filters ({transactionsResponse?.total ?? 0} transactions)
              </Label>
            </div>
            <div className="flex items-center space-x-3">
              <RadioGroupItem value="all" id="export-all" />
              <Label htmlFor="export-all" className="cursor-pointer">All transactions</Label>
            </div>
          </RadioGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExportDialog(false)}>Cancel</Button>
            <Button onClick={handleExportConfirm} disabled={isExporting}>
              {isExporting ? 'Exporting...' : 'Export'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showExportProgress}>
        <DialogContent onCloseAutoFocus={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()} className="sm:max-w-[360px] [&>button:last-child]:hidden">
          <div className="flex flex-col items-center gap-4 py-6">
            <Loader2Icon className="h-8 w-8 animate-spin text-brand-primary" />
            <div className="text-center">
              <p className="font-medium text-sm">Exporting transactions...</p>
              <p className="text-xs text-muted-foreground mt-1">This may take a moment for large datasets.</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showTransactionForm}
        onOpenChange={(open) => { if (!open) closeTransactionForm(); }}
      >
        <DialogContent
          className="sm:max-w-[600px]"
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{selectedTransaction ? t('pages.transactions.editTransaction') : t('pages.transactions.addTransaction')}</DialogTitle>
            <DialogDescription className="sr-only">
              {selectedTransaction ? 'Edit transaction details' : 'Create a new transaction'}
            </DialogDescription>
          </DialogHeader>
          <TransactionForm transaction={selectedTransaction} onClose={closeTransactionForm} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Trash2, AlertCircle, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import {
  MANUAL_ASSET_VALUES_QUERY_KEY,
  useManualAssetValues,
} from '@/hooks/use-manual-asset-values';
import { PORTFOLIO_ITEMS_QUERY_KEY } from '@/hooks/use-portfolio-items';
import { parseDecimal } from '@/lib/portfolio-utils';
import { formatCurrency } from '@/lib/utils';
import type { ManualAssetValue, PortfolioItem } from '@/types/api';
import { ManualPriceForm } from './manual-price-form';

type View = 'list' | 'add' | 'edit';

/** Rows per page in the history list — keeps tall histories from becoming an endless scroll. */
const PAGE_SIZE = 12;

interface ManualPriceHistoryDialogProps {
  asset: PortfolioItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Formats a manual-price row for display. `value` arrives as a serialized
 * Prisma Decimal (string), so it always goes through `parseDecimal` first.
 * Legacy / imported rows can hold a malformed ISO code that makes
 * `Intl.NumberFormat` throw — fall back to a plain "amount CODE" string.
 */
function formatManualPrice(value: ManualAssetValue['value'], currency: string): string {
  const amount = parseDecimal(value);
  try {
    return formatCurrency(amount, currency);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
}

function formatDateSafe(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

export function ManualPriceHistoryDialog({
  asset,
  open,
  onOpenChange,
}: ManualPriceHistoryDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [view, setView] = useState<View>('list');
  const [editingValue, setEditingValue] = useState<ManualAssetValue | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManualAssetValue | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useManualAssetValues(asset?.id);
  const rows = data ?? [];

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);

  // Reset the internal view whenever the dialog is (re)opened for an asset.
  useEffect(() => {
    if (open) {
      setView('list');
      setEditingValue(null);
      setDeleteTarget(null);
      setPage(1);
    }
  }, [open, asset?.id]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setView('list');
      setEditingValue(null);
      setDeleteTarget(null);
    }
    onOpenChange(next);
  };

  const backToList = () => {
    setView('list');
    setEditingValue(null);
  };

  const confirmDelete = async () => {
    if (!asset || !deleteTarget) return;
    setIsDeleting(true);
    try {
      await api.deleteManualAssetValue(asset.id, deleteTarget.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [MANUAL_ASSET_VALUES_QUERY_KEY] }),
        queryClient.invalidateQueries({ queryKey: [PORTFOLIO_ITEMS_QUERY_KEY] }),
      ]);
      toast({ title: t('manualPriceHistory.deleted') });
      setDeleteTarget(null);
    } catch {
      toast({
        title: t('common.error'),
        description: t('manualPriceHistory.deleteFailed'),
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const title =
    view === 'add'
      ? t('manualPriceHistory.addTitle', { symbol: asset?.symbol ?? '' })
      : view === 'edit'
        ? t('manualPriceHistory.editTitle', { symbol: asset?.symbol ?? '' })
        : t('manualPriceHistory.title', { symbol: asset?.symbol ?? '' });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('manualPriceHistory.dialogDescription')}</DialogDescription>
        </DialogHeader>

        {view !== 'list' ? (
          <div className="space-y-4">
            <Button variant="ghost" size="sm" className="gap-1.5 -ml-2" onClick={backToList}>
              <ArrowLeft className="h-4 w-4" />
              {t('manualPriceHistory.back')}
            </Button>
            <ManualPriceForm
              asset={asset}
              existingValue={view === 'edit' ? editingValue : undefined}
              onClose={backToList}
            />
          </div>
        ) : isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{t('common.error')}</AlertTitle>
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>{t('manualPriceHistory.loadError')}</span>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                {t('manualPriceHistory.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm font-medium">{t('manualPriceHistory.emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('manualPriceHistory.emptyBody')}</p>
            <Button size="sm" className="gap-1.5" onClick={() => setView('add')}>
              <Plus className="h-4 w-4" />
              {t('manualPriceHistory.recordFirst')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t('manualPriceHistory.countLabel', { count: rows.length })}
              </p>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setView('add')}>
                <Plus className="h-4 w-4" />
                {t('manualPriceHistory.recordPrice')}
              </Button>
            </div>
            <div className="min-w-0 overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-accent/40">
                    <TableHead className="whitespace-nowrap">
                      {t('manualPriceHistory.effectiveDate')}
                    </TableHead>
                    <TableHead className="whitespace-nowrap text-right">
                      {t('manualPriceHistory.price')}
                    </TableHead>
                    <TableHead className="whitespace-nowrap">
                      {t('manualPriceHistory.currency')}
                    </TableHead>
                    <TableHead className="hidden lg:table-cell">
                      {t('manualPriceHistory.notes')}
                    </TableHead>
                    <TableHead className="hidden whitespace-nowrap md:table-cell">
                      {t('manualPriceHistory.recordedOn')}
                    </TableHead>
                    <TableHead className="whitespace-nowrap text-right">
                      {t('manualPriceHistory.actions')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => {
                    const mixedCurrency =
                      asset?.currency != null && row.currency !== asset.currency;
                    return (
                      <TableRow key={row.id} className="hover:bg-accent/30">
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {formatDateSafe(row.date)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                          {formatManualPrice(row.value, row.currency)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {mixedCurrency ? (
                            <Badge
                              className="bg-warning/10 text-warning border-warning/20"
                              title={t('manualPriceHistory.differentCurrency')}
                            >
                              {row.currency}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">{row.currency}</span>
                          )}
                        </TableCell>
                        <TableCell
                          className="hidden max-w-[16rem] truncate text-muted-foreground lg:table-cell"
                          title={row.notes || undefined}
                        >
                          {row.notes ? row.notes : '—'}
                        </TableCell>
                        <TableCell className="hidden whitespace-nowrap tabular-nums text-muted-foreground md:table-cell">
                          {formatDateSafe(row.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={t('manualPriceHistory.edit')}
                              onClick={() => {
                                setEditingValue(row);
                                setView('edit');
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive"
                              aria-label={t('manualPriceHistory.delete')}
                              onClick={() => setDeleteTarget(row)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {rows.length > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-3 pt-1 text-sm text-muted-foreground">
                <span className="tabular-nums">
                  {t('manualPriceHistory.pagination', {
                    from: pageStart + 1,
                    to: pageStart + pageRows.length,
                    total: rows.length,
                  })}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    {t('manualPriceHistory.prev')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={safePage >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  >
                    {t('manualPriceHistory.next')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && !isDeleting && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('manualPriceHistory.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('manualPriceHistory.deleteConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('manualPriceHistory.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

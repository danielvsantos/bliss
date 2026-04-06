import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import {
  CheckCircle2,
  Loader2,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardCheck,
  Zap,
  FileUp,
  Landmark,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useCategories, useAccounts } from '@/hooks/use-metadata';
import {
  usePlaidTransactions,
  useUpdatePlaidTransaction,
  useBulkPromotePlaidTransactions,
} from '@/hooks/use-plaid-review';
import {
  usePendingImports,
  useStagedImport,
  useUpdateImportRow,
  useCommitImport,
  useCancelImport,
} from '@/hooks/use-imports';
import { formatCurrency, formatDate } from '@/lib/utils';
import { api } from '@/lib/api';
import { itemNeedsEnrichment } from '@/lib/investment-utils';
import type { PlaidTransaction, Category, StagedImportRow } from '@/types/api';

// ─── New review components ───────────────────────────────────────────
import type { ReviewItem, TxStatus } from '@/components/review/types';
import { GroupCard } from '@/components/review/group-card';
import { TxDataRow } from '@/components/review/tx-data-row';
import { ViewToggle } from '@/components/review/view-toggle';
import { DeepDiveDrawer, type DrawerSaveData } from '@/components/review/deep-dive-drawer';

// ─── ReviewItem Mappers ─────────────────────────────────────────────

function plaidTxToReviewItem(
  tx: PlaidTransaction,
  categoriesMap: Map<number, Category>,
  reviewThreshold: number,
): ReviewItem {
  const category = tx.suggestedCategoryId
    ? (tx.suggestedCategory ?? categoriesMap.get(tx.suggestedCategoryId) ?? null)
    : null;

  // Parse Plaid category hint
  let plaidHint: string | null = null;
  if (tx.category) {
    plaidHint = typeof tx.category === 'string' ? tx.category : JSON.stringify(tx.category);
  }

  // Determine review status
  let status: TxStatus = 'ai-approved';
  if (tx.requiresEnrichment) {
    status = 'needs-enrichment';
  } else if (tx.aiConfidence != null && tx.aiConfidence < reviewThreshold) {
    status = 'low-confidence';
  } else if (tx.classificationSource === 'LLM' || tx.classificationSource === 'AI_CLASSIFICATION') {
    // If it's a first-time merchant (no exact/vector match), flag as new
    status = 'ai-approved';
  }

  return {
    id: tx.id,
    source: 'plaid',
    date: tx.date,
    merchant: tx.merchantName || tx.name,
    description: tx.name,
    amount: Number(tx.amount),
    currency: tx.isoCurrencyCode ?? 'USD',
    status,
    category: category?.name ?? 'Uncategorized',
    categoryId: tx.suggestedCategoryId ?? null,
    confidence: tx.aiConfidence ?? null,
    classificationSource: tx.classificationSource ?? null,
    classificationReasoning: tx.classificationReasoning ?? null,
    plaidHint,
    accountName: tx.accountName ?? '',
    requiresEnrichment: tx.requiresEnrichment ?? false,
    enrichmentType: tx.enrichmentType ?? null,
    promotionStatus: tx.promotionStatus,
    originalPlaidTx: tx,
  };
}

function importRowToReviewItem(
  row: StagedImportRow,
  categoriesMap: Map<number, Category>,
  accountsMap: Map<number, { id: number; name: string }>,
  reviewThreshold: number,
): ReviewItem {
  const category = row.suggestedCategoryId
    ? (row.suggestedCategory ?? categoriesMap.get(row.suggestedCategoryId) ?? null)
    : null;
  // Match Plaid sign convention: positive = expense (debit), negative = income (credit)
  const amount = (Number(row.debit) || 0) - (Number(row.credit) || 0);
  const account = row.accountId ? accountsMap.get(row.accountId) : null;

  let status: TxStatus = 'ai-approved';
  if (row.requiresEnrichment) {
    status = 'needs-enrichment';
  } else if (row.confidence != null && row.confidence < reviewThreshold) {
    status = 'low-confidence';
  }

  return {
    id: row.id,
    source: 'import',
    date: row.transactionDate ?? '',
    merchant: row.description ?? '',
    description: row.description ?? '',
    amount,
    currency: row.currency ?? 'USD',
    status,
    category: category?.name ?? 'Uncategorized',
    categoryId: row.suggestedCategoryId ?? null,
    confidence: row.confidence ?? null,
    classificationSource: row.classificationSource ?? null,
    classificationReasoning: null,
    plaidHint: null,
    accountName: account?.name ?? '',
    requiresEnrichment: row.requiresEnrichment ?? false,
    enrichmentType: row.enrichmentType ?? null,
    promotionStatus: row.status,
    originalImportRow: row,
  };
}

// ─── Main Component ─────────────────────────────────────────────────
export default function TransactionReviewPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const sourceParam = searchParams.get('source');
  const plaidItemIdParam = searchParams.get('plaidItemId');
  const importIdParam = searchParams.get('importId');

  // Default tab based on URL params
  const defaultTab = sourceParam === 'plaid' ? 'plaid' : sourceParam === 'imports' ? 'imports' : 'all';
  const [activeTab, setActiveTab] = useState(defaultTab);

  // View mode: flat or grouped
  const [viewMode, setViewModeRaw] = useState<'flat' | 'grouped'>('grouped');

  // Bulk promote dialog
  const [showBulkDialog, setShowBulkDialog] = useState(false);
  const [bulkConfidenceThreshold, setBulkConfidenceThreshold] = useState('0.8');

  // Deep dive drawer
  const [selectedItem, setSelectedItem] = useState<ReviewItem | null>(null);

  // Promote-by-description dialog — holds the item whose approve icon was clicked
  const [pendingApproveItem, setPendingApproveItem] = useState<ReviewItem | null>(null);

  // Drawer promote-all dialog — holds the DrawerSaveData while user decides
  const [pendingDrawerSave, setPendingDrawerSave] = useState<DrawerSaveData | null>(null);

  // Review threshold (could come from tenant settings; default 0.7)
  const reviewThreshold = 0.7;

  // ── Plaid data ──
  const [plaidPage, setPlaidPage] = useState(1);
  const [plaidCategoryFilter, setPlaidCategoryFilter] = useState<number | null>(null);
  const { data: plaidData, isLoading: plaidLoading } = usePlaidTransactions({
    page: plaidPage,
    limit: 500,
    promotionStatus: 'CLASSIFIED',
    ...(plaidItemIdParam ? { plaidItemId: plaidItemIdParam } : {}),
    ...(plaidCategoryFilter ? { categoryId: plaidCategoryFilter } : {}),
  });
  const plaidTransactions = useMemo(() => plaidData?.transactions ?? [], [plaidData]);
  const plaidSummary = useMemo(() => plaidData?.summary, [plaidData]);
  const plaidPagination = useMemo(() => plaidData?.pagination, [plaidData]);
  // Server-side category breakdown — accurate counts across ALL pages
  const plaidCategoryBreakdown = useMemo(
    () => plaidData?.summary?.categoryBreakdown ?? [],
    [plaidData],
  );

  // ── Imports data ──
  const { data: pendingData, isLoading: pendingLoading, error: pendingError } = usePendingImports();
  const pendingImports = useMemo(() => pendingData?.imports ?? [], [pendingData]);

  if (pendingError) {
    console.error('Failed to fetch pending imports:', pendingError);
  }

  const [selectedImportId, setSelectedImportId] = useState<string | null>(importIdParam);
  const [importPage, setImportPage] = useState(1);
  const [importCategoryFilter, setImportCategoryFilter] = useState<number | null>(null);
  const { data: stagedData, isLoading: stagedLoading } = useStagedImport(
    selectedImportId,
    {
      page: importPage,
      limit: 50,
      // Show rows needing action + auto-confirmed rows not yet committed (excludes SKIPPED)
      status: 'PENDING,POTENTIAL_DUPLICATE,ERROR,DUPLICATE,CONFIRMED',
      ...(importCategoryFilter ? { categoryId: importCategoryFilter } : {}),
    },
  );
  const importRows = useMemo(() => stagedData?.rows ?? [], [stagedData]);
  const importInfo = useMemo(() => stagedData?.import, [stagedData]);
  const importPagination = useMemo(() => stagedData?.pagination, [stagedData]);
  // Server-side category breakdown — accurate counts across ALL pending rows
  const importCategorySummary = useMemo(
    () => stagedData?.categorySummary ?? [],
    [stagedData],
  );

  useEffect(() => {
    if (!selectedImportId && pendingImports.length > 0) {
      setSelectedImportId(pendingImports[0].id);
    }
  }, [pendingImports, selectedImportId]);

  // Wrapper: clear category filters when switching view modes
  const setViewMode = useCallback((mode: 'flat' | 'grouped') => {
    setViewModeRaw(mode);
    setImportCategoryFilter(null);
    setPlaidCategoryFilter(null);
  }, []);

  // Reset page when category filters change so we don't land on a non-existent page
  useEffect(() => { setPlaidPage(1); }, [plaidCategoryFilter]);
  useEffect(() => { setImportPage(1); }, [importCategoryFilter]);
  // Clear category filter when the selected import changes
  useEffect(() => { setImportCategoryFilter(null); }, [selectedImportId]);

  // ── Detect COMMITTING → COMMITTED/READY transition ──
  const prevImportStatusRef = useRef<string | undefined>();
  useEffect(() => {
    const prevStatus = prevImportStatusRef.current;
    prevImportStatusRef.current = importInfo?.status;

    if (!importInfo?.status || !prevStatus) return;

    const wasCommitting = prevStatus === 'COMMITTING';
    if (!wasCommitting) return;

    const errorDetails = importInfo.errorDetails as
      | { commitResult?: { transactionCount: number; remaining: number } }
      | null;
    const result = errorDetails?.commitResult;

    if (importInfo.status === 'COMMITTED') {
      toast({
        title: 'Import committed',
        description: `${result?.transactionCount ?? 0} transactions created.`,
      });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      // Import is fully committed — deselect it and refresh pending list
      queryClient.invalidateQueries({ queryKey: ['imports', 'pending'] });
      setSelectedImportId(null);
    } else if (importInfo.status === 'READY' && result) {
      toast({
        title: 'Partial commit complete',
        description: `${result.transactionCount} transactions created. ${result.remaining} rows remaining.`,
      });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    }
  }, [importInfo?.status, importInfo?.errorDetails, toast, queryClient]);

  // ── Metadata ──
  const { data: categories = [] } = useCategories();
  const categoriesMap = useMemo(
    () => new Map(categories.map((c: Category) => [c.id, c])),
    [categories],
  );
  const { data: accounts = [] } = useAccounts();
  const accountsMap = useMemo(
    () => new Map(accounts.map((a: { id: number; name: string }) => [a.id, a])),
    [accounts],
  );

  // ── Mutations ──
  const updatePlaidTx = useUpdatePlaidTransaction();
  const bulkPromote = useBulkPromotePlaidTransactions();
  const updateImportRow = useUpdateImportRow(selectedImportId);
  const commitImport = useCommitImport();
  const cancelImport = useCancelImport();

  // ── Map to ReviewItems ──
  const plaidReviewItems = useMemo(
    () => plaidTransactions.map((tx) => plaidTxToReviewItem(tx, categoriesMap, reviewThreshold)),
    [plaidTransactions, categoriesMap, reviewThreshold],
  );

  const importReviewItems = useMemo(
    () => importRows.map((row) => importRowToReviewItem(row, categoriesMap, accountsMap, reviewThreshold)),
    [importRows, categoriesMap, accountsMap, reviewThreshold],
  );

  // ── Grouped data — server-side summaries drive headers; current-page items fill rows ──
  //
  // Groups are ordered by server-provided count (most items first).
  // The badge on each group header shows the server-side total across ALL pages,
  // not just the items visible on the current page.

  /** Build a lookup from categoryId string key → items from the current page. */
  const buildItemsByCategory = (items: ReviewItem[]) => {
    const map = new Map<string, ReviewItem[]>();
    for (const item of items) {
      const key = item.categoryId?.toString() ?? 'uncategorized';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  };

  const groupedPlaid = useMemo(() => {
    if (viewMode !== 'grouped') return [];
    const itemsByCategory = buildItemsByCategory(plaidReviewItems);

    return plaidCategoryBreakdown.map((entry) => {
      const key = entry.categoryId?.toString() ?? 'uncategorized';
      const items = itemsByCategory.get(key) ?? [];
      return {
        key,
        categoryName: entry.category?.name ?? 'Uncategorized',
        items,
        total: items.reduce((sum, i) => sum + Math.abs(i.amount), 0),
        totalCount: entry.count,
      };
    });
  }, [plaidReviewItems, viewMode, plaidCategoryBreakdown]);

  const groupedImports = useMemo(() => {
    if (viewMode !== 'grouped') return [];
    const itemsByCategory = buildItemsByCategory(importReviewItems);

    return importCategorySummary.map((entry) => {
      const key = entry.categoryId?.toString() ?? 'uncategorized';
      const items = itemsByCategory.get(key) ?? [];
      return {
        key,
        categoryName: entry.category?.name ?? 'Uncategorized',
        items,
        total: items.reduce((sum, i) => sum + Math.abs(i.amount), 0),
        totalCount: entry.count,
      };
    });
  }, [importReviewItems, viewMode, importCategorySummary]);

  // All CLASSIFIED, non-enrichment Plaid items sharing the same description as the pending-approve item.
  // Enrichment items (investments) are excluded — they can't be bulk-promoted without extra data.
  const pendingApproveMatches = useMemo(
    () =>
      pendingApproveItem
        ? plaidReviewItems.filter(
            (i) =>
              i.description === pendingApproveItem.description &&
              i.promotionStatus === 'CLASSIFIED' &&
              !itemNeedsEnrichment(i, categoriesMap),
          )
        : [],
    [pendingApproveItem, plaidReviewItems, categoriesMap],
  );

  // Other pending items (Plaid or import) sharing the description of the drawer item.
  // Excludes the item being saved (it's handled by the drawer save itself).
  const pendingDrawerOtherMatches = useMemo(() => {
    if (!pendingDrawerSave) return [];
    const { item } = pendingDrawerSave;
    const matches: ReviewItem[] = [];

    // Plaid matches: CLASSIFIED, non-enrichment
    matches.push(
      ...plaidReviewItems.filter(
        (i) =>
          i.id !== item.id &&
          i.description === item.description &&
          i.promotionStatus === 'CLASSIFIED' &&
          !itemNeedsEnrichment(i, categoriesMap),
      ),
    );

    // Import matches: PENDING or POTENTIAL_DUPLICATE, non-enrichment
    matches.push(
      ...importReviewItems.filter(
        (i) =>
          i.id !== item.id &&
          i.description === item.description &&
          i.promotionStatus !== 'CONFIRMED' &&
          i.promotionStatus !== 'SKIPPED' &&
          i.promotionStatus !== 'DUPLICATE' &&
          !itemNeedsEnrichment(i, categoriesMap),
      ),
    );

    return matches;
  }, [pendingDrawerSave, plaidReviewItems, importReviewItems, categoriesMap]);

  // ── Plaid handlers ──
  const handlePlaidCategoryChange = useCallback(
    (id: string, categoryId: number) => {
      updatePlaidTx.mutate(
        { id, data: { suggestedCategoryId: categoryId } },
        { onError: () => toast({ title: 'Failed to update category', variant: 'destructive' }) },
      );
    },
    [updatePlaidTx, toast],
  );

  const handlePlaidSkip = useCallback(
    (id: string) => {
      // If this is the last item visible under the current category filter,
      // clear the filter before the refetch so the page doesn't show an
      // empty state while other categories still have pending items.
      if (plaidCategoryFilter != null && plaidTransactions.length <= 1) {
        setPlaidCategoryFilter(null);
      }
      updatePlaidTx.mutate(
        { id, data: { promotionStatus: 'SKIPPED' } },
        { onError: () => toast({ title: 'Failed to skip', variant: 'destructive' }) },
      );
    },
    [updatePlaidTx, toast, plaidCategoryFilter, plaidTransactions.length],
  );

  const handlePlaidPromote = useCallback(
    (tx: PlaidTransaction) => {
      // Clear category filter if this is the last item in the filtered view
      if (plaidCategoryFilter != null && plaidTransactions.length <= 1) {
        setPlaidCategoryFilter(null);
      }
      updatePlaidTx.mutate(
        { id: tx.id, data: { promotionStatus: 'PROMOTED' } },
        {
          onSuccess: () => toast({ title: 'Transaction promoted' }),
          onError: (err: any) => {
            const data = err?.response?.data;
            if (data?.requiresEnrichment) {
              toast({
                title: 'Investment enrichment required',
                description: 'Please provide ticker, quantity, and price in the detail drawer.',
                variant: 'destructive',
              });
              // Open the drawer for the failed transaction
              const reviewItem = plaidReviewItems.find((i) => i.id === tx.id);
              if (reviewItem) setSelectedItem(reviewItem);
            } else {
              toast({ title: data?.error || 'Failed', variant: 'destructive' });
            }
          },
        },
      );
    },
    [updatePlaidTx, toast, plaidReviewItems, plaidCategoryFilter, plaidTransactions.length],
  );

  const handlePromoteGroup = useCallback(
    (items: ReviewItem[]) => {
      // Plaid group promote — exclude items that need enrichment
      const promotable = items.filter(
        (i) =>
          i.source === 'plaid' &&
          i.promotionStatus === 'CLASSIFIED' &&
          i.categoryId &&
          !itemNeedsEnrichment(i, categoriesMap),
      );
      const skippedEnrichment = items.filter(
        (i) => i.source === 'plaid' && i.promotionStatus === 'CLASSIFIED' && itemNeedsEnrichment(i, categoriesMap),
      ).length;
      const plaidIds = promotable.map((i) => i.id);
      if (plaidIds.length > 0) {
        bulkPromote.mutate(
          { transactionIds: plaidIds },
          {
            onSuccess: (result) => {
              const parts = [`Promoted ${result.promoted} transactions`];
              if (result.errors > 0) parts.push(`${result.errors} failed`);
              if (skippedEnrichment > 0) parts.push(`${skippedEnrichment} need enrichment`);
              toast({
                title: parts.join('. ') + '.',
                ...(result.errors > 0 && { variant: 'destructive' as const }),
              });
            },
            onError: () => toast({ title: 'Failed to promote group', variant: 'destructive' }),
          },
        );
      } else if (skippedEnrichment > 0) {
        toast({
          title: `${skippedEnrichment} investment transaction(s) need enrichment data`,
          description: 'Open each transaction to provide ticker, quantity, and price.',
          variant: 'destructive',
        });
      }
      // Import group confirm — exclude items that need enrichment
      const importItems = items.filter(
        (i) =>
          i.source === 'import' &&
          i.promotionStatus !== 'CONFIRMED' &&
          i.promotionStatus !== 'SKIPPED' &&
          i.promotionStatus !== 'DUPLICATE' &&
          !itemNeedsEnrichment(i, categoriesMap),
      );
      const importEnrichmentSkipped = items.filter(
        (i) =>
          i.source === 'import' &&
          i.promotionStatus !== 'CONFIRMED' &&
          i.promotionStatus !== 'SKIPPED' &&
          i.promotionStatus !== 'DUPLICATE' &&
          itemNeedsEnrichment(i, categoriesMap),
      ).length;
      for (const item of importItems) {
        handleImportRowStatus(item.originalImportRow!, 'CONFIRMED');
      }
      if (importItems.length > 0) {
        const desc = importEnrichmentSkipped > 0
          ? `${importItems.length} row(s) confirmed. ${importEnrichmentSkipped} investment row(s) need enrichment first.`
          : `${importItems.length} row(s) confirmed for commit.`;
        toast({ title: desc });
      } else if (importEnrichmentSkipped > 0) {
        toast({
          title: `${importEnrichmentSkipped} investment row(s) need enrichment data`,
          description: 'Open each row to provide ticker, quantity, and price.',
          variant: 'destructive',
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleImportRowStatus defined later; stable useCallback
    [bulkPromote, toast, categoriesMap],
  );

  const handleBulkPromote = useCallback(() => {
    bulkPromote.mutate(
      { minConfidence: parseFloat(bulkConfidenceThreshold) },
      {
        onSuccess: (result) => {
          setShowBulkDialog(false);
          toast({
            title: 'Bulk Promote Complete',
            description: `${result.promoted} promoted, ${result.skipped} skipped, ${result.errors} errors.`,
          });
        },
        onError: () => {
          setShowBulkDialog(false);
          toast({ title: 'Bulk promote failed', variant: 'destructive' });
        },
      },
    );
  }, [bulkPromote, bulkConfidenceThreshold, toast]);

  // ── Import handlers ──
  const handleImportRowStatus = useCallback(
    (row: StagedImportRow, status: string) => {
      // Clear category filter if this is the last visible item to avoid blank state
      if (importCategoryFilter != null && importRows.length <= 1) {
        setImportCategoryFilter(null);
      }
      if (!selectedImportId || selectedImportId !== row.stagedImportId) {
        api.updateImportRow(row.stagedImportId, row.id, { status }).catch(() => {
          toast({ title: 'Failed to update row', variant: 'destructive' });
        });
        return;
      }
      updateImportRow.mutate({ rowId: row.id, data: { status } });
    },
    [selectedImportId, updateImportRow, toast, importCategoryFilter, importRows.length],
  );

  const handleImportRowCategory = useCallback(
    (row: StagedImportRow, categoryId: number) => {
      if (!selectedImportId || selectedImportId !== row.stagedImportId) {
        api.updateImportRow(row.stagedImportId, row.id, { suggestedCategoryId: categoryId }).catch(() => {
          toast({ title: 'Failed to update category', variant: 'destructive' });
        });
        return;
      }
      updateImportRow.mutate({ rowId: row.id, data: { suggestedCategoryId: categoryId } });
    },
    [selectedImportId, updateImportRow, toast],
  );

  const handleCommitImport = useCallback(
    (importId: string) => {
      commitImport.mutate(
        { id: importId },
        {
          onSuccess: () => {
            toast({
              title: 'Commit started',
              description: 'Your transactions are being committed in the background...',
            });
          },
          onError: () => toast({ title: 'Failed to commit', variant: 'destructive' }),
        },
      );
    },
    [commitImport, toast],
  );

  const handleCancelImport = useCallback(
    (importId: string, fileName: string) => {
      cancelImport.mutate(importId, {
        onSuccess: () => {
          toast({ title: 'Import cancelled', description: `"${fileName}" has been discarded.` });
          if (selectedImportId === importId) setSelectedImportId(null);
        },
        onError: () => toast({ title: 'Failed to cancel import', variant: 'destructive' }),
      });
    },
    [cancelImport, toast, selectedImportId],
  );

  // ── Approve / Skip via ReviewItem ──
  const handleItemApprove = useCallback(
    (item: ReviewItem) => {
      // Investment items that need mandatory enrichment MUST go through the drawer
      if (itemNeedsEnrichment(item, categoriesMap)) {
        setSelectedItem(item);
        return;
      }

      if (item.source === 'plaid' && item.originalPlaidTx) {
        // Check for other pending, non-enrichment transactions sharing the same description.
        // Enrichment items (investments) are excluded — they need the deep-dive drawer.
        const matches = plaidReviewItems.filter(
          (i) =>
            i.description === item.description &&
            i.promotionStatus === 'CLASSIFIED' &&
            !itemNeedsEnrichment(i, categoriesMap),
        );
        if (matches.length > 1) {
          // Show the promote-by-description dialog instead of promoting immediately
          setPendingApproveItem(item);
          return;
        }
        handlePlaidPromote(item.originalPlaidTx);
      } else if (item.source === 'import' && item.originalImportRow) {
        handleImportRowStatus(item.originalImportRow, 'CONFIRMED');
      }
    },
    [handlePlaidPromote, handleImportRowStatus, plaidReviewItems, categoriesMap],
  );

  const handleItemSkip = useCallback(
    (item: ReviewItem) => {
      if (item.source === 'plaid') {
        handlePlaidSkip(item.id);
      } else if (item.source === 'import' && item.originalImportRow) {
        handleImportRowStatus(item.originalImportRow, 'SKIPPED');
      }
    },
    [handlePlaidSkip, handleImportRowStatus],
  );

  // ── Drawer Save & Promote ──

  // Core save logic — executes the actual API mutation(s).
  // suppressToast: used when the caller will show its own combined toast (e.g. promote-all flow).
  const executeDrawerSave = useCallback(
    (data: DrawerSaveData, suppressToast = false) => {
      const { item, categoryId, accountId, ticker, assetQuantity, assetPrice, details, isin, exchange, assetCurrency } = data;
      const isAlreadyProcessed =
        item.promotionStatus === 'PROMOTED' ||
        item.promotionStatus === 'CONFIRMED' ||
        item.promotionStatus === 'SKIPPED';

      if (item.source === 'plaid' && item.originalPlaidTx) {
        // Clear category filter if this is the last item in the filtered group
        // (mirrors the same guard in handlePlaidPromote)
        if (!isAlreadyProcessed && plaidCategoryFilter != null && plaidTransactions.length <= 1) {
          setPlaidCategoryFilter(null);
        }

        const payload: Record<string, unknown> = {};
        if (!isAlreadyProcessed) payload.promotionStatus = 'PROMOTED';
        if (categoryId && categoryId !== item.categoryId) {
          payload.suggestedCategoryId = categoryId;
        }
        if (ticker && assetQuantity && assetPrice) {
          payload.ticker = ticker;
          payload.assetQuantity = parseFloat(assetQuantity);
          payload.assetPrice = parseFloat(assetPrice);
        }
        if (details.trim()) {
          payload.details = details.trim();
        }
        // Ticker resolution metadata (Sprint 14)
        if (isin) payload.isin = isin;
        if (exchange) payload.exchange = exchange;
        if (assetCurrency) payload.assetCurrency = assetCurrency;

        updatePlaidTx.mutate(
          { id: item.id, data: payload },
          {
            onSuccess: () => {
              if (!suppressToast) {
                toast({ title: isAlreadyProcessed ? 'Changes saved' : 'Transaction saved & promoted' });
              }
              setSelectedItem(null);
            },
            onError: () => toast({ title: 'Failed to save', variant: 'destructive' }),
          },
        );
      } else if (item.source === 'import' && item.originalImportRow) {
        const row = item.originalImportRow;
        const rowData: Record<string, unknown> = {};
        if (!isAlreadyProcessed) rowData.status = 'CONFIRMED';
        if (categoryId && categoryId !== item.categoryId) {
          rowData.suggestedCategoryId = categoryId;
        }
        if (accountId && accountId !== row.accountId) {
          rowData.accountId = accountId;
        }
        if (ticker && assetQuantity && assetPrice) {
          rowData.ticker = ticker;
          rowData.assetQuantity = parseFloat(assetQuantity);
          rowData.assetPrice = parseFloat(assetPrice);
        }
        if (details.trim()) {
          rowData.details = details.trim();
        }
        // Ticker resolution metadata (Sprint 14)
        if (isin) rowData.isin = isin;
        if (exchange) rowData.exchange = exchange;
        if (assetCurrency) rowData.assetCurrency = assetCurrency;
        if (selectedImportId && selectedImportId === row.stagedImportId) {
          updateImportRow.mutate({ rowId: row.id, data: rowData });
        } else {
          api.updateImportRow(row.stagedImportId, row.id, rowData).catch(() => {
            toast({ title: 'Failed to save', variant: 'destructive' });
          });
        }
        if (!suppressToast) {
          toast({ title: isAlreadyProcessed ? 'Changes saved' : 'Transaction saved & confirmed' });
        }
        setSelectedItem(null);
      }
    },
    [updatePlaidTx, updateImportRow, selectedImportId, toast, plaidCategoryFilter, plaidTransactions.length],
  );

  // Interceptor: before saving, check if there are other CLASSIFIED Plaid transactions
  // with the same description. If so, offer to promote them all at once.
  const handleDrawerSave = useCallback(
    (data: DrawerSaveData) => {
      const { item } = data;
      const isAlreadyProcessed =
        item.promotionStatus === 'PROMOTED' ||
        item.promotionStatus === 'CONFIRMED' ||
        item.promotionStatus === 'SKIPPED';

      if (!isAlreadyProcessed) {
        // Check for other pending items with the same description (Plaid or import)
        const otherPlaid = item.source === 'plaid'
          ? plaidReviewItems.filter(
              (i) =>
                i.id !== item.id &&
                i.description === item.description &&
                i.promotionStatus === 'CLASSIFIED' &&
                !i.requiresEnrichment,
            )
          : [];
        const otherImport = importReviewItems.filter(
          (i) =>
            i.id !== item.id &&
            i.description === item.description &&
            i.promotionStatus !== 'CONFIRMED' &&
            i.promotionStatus !== 'SKIPPED' &&
            i.promotionStatus !== 'DUPLICATE' &&
            !itemNeedsEnrichment(i, categoriesMap),
        );
        if (otherPlaid.length + otherImport.length > 0) {
          setPendingDrawerSave(data);
          return;
        }
      }

      executeDrawerSave(data);
    },
    [executeDrawerSave, plaidReviewItems, importReviewItems, categoriesMap],
  );

  const handleDrawerSkip = useCallback(() => {
    if (selectedItem) {
      handleItemSkip(selectedItem);
    }
  }, [selectedItem, handleItemSkip]);

  // ── Summary counts ──
  const plaidCount = plaidSummary?.classified ?? 0;
  const importCount = useMemo(
    () => pendingImports.reduce((sum: number, imp: { pendingRowCount: number }) => sum + imp.pendingRowCount, 0),
    [pendingImports],
  );
  const totalCount = plaidCount + importCount;

  // Progress calculation
  const promotedCount = (plaidSummary?.promoted ?? 0) + (plaidSummary?.skipped ?? 0);
  const overallTotal = promotedCount + plaidCount + importCount;
  const progressPct = overallTotal > 0 ? Math.round((promotedCount / overallTotal) * 100) : 0;

  // ── Pagination helper ──
  const renderPagination = (
    currentPage: number,
    totalPages: number,
    total: number | undefined,
    onPageChange: (page: number) => void,
    label: string,
  ) => {
    if (totalPages <= 1) return null;
    return (
      <div className="flex justify-between items-center mt-4">
        <p className="text-sm text-muted-foreground">
          {t('review.pageOf', { current: currentPage, total: totalPages })}
          {total ? ` (${total} ${label})` : ''}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onPageChange(Math.max(1, currentPage - 1))} disabled={currentPage <= 1}>
            <ChevronLeftIcon className="h-4 w-4 mr-1" /> {t('common.previous')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))} disabled={currentPage >= totalPages}>
            {t('common.next')} <ChevronRightIcon className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </div>
    );
  };

  // ── Flat view renderer ──
  const renderFlatList = (items: ReviewItem[]) => (
    <Card className="overflow-hidden">
      {/* Column headers */}
      <div className="hidden md:flex items-center gap-3 px-4 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/30">
        <span className="w-[80px] shrink-0">{t('review.date')}</span>
        <span className="flex-1 min-w-0">{t('review.merchant')}</span>
        <span className="w-[100px] shrink-0">{t('review.account')}</span>
        <span className="w-[90px] shrink-0 text-right">{t('review.amount')}</span>
        <span className="w-[60px] shrink-0">{t('review.confidence')}</span>
        <span className="w-[110px] shrink-0">{t('review.status')}</span>
        <span className="w-[70px] shrink-0 text-right">{t('review.actions')}</span>
      </div>
      <Separator />
      <div className="divide-y">
        {items.map((item) => (
          <TxDataRow
            key={item.id}
            item={item}
            onApprove={() => handleItemApprove(item)}
            onSkip={() => handleItemSkip(item)}
            onClick={() => setSelectedItem(item)}
            disabled={updatePlaidTx.isPending || updateImportRow.isPending}
          />
        ))}
      </div>
    </Card>
  );

  // ── Grouped view renderer ──
  // In grouped mode, expanding a category sets the category filter so the API
  // returns only that category's rows (properly paginated within the category).
  // Only one category can be expanded at a time.

  const renderGroupedImports = (groups: { key: string; categoryName: string; items: ReviewItem[]; total: number; totalCount?: number }[]) =>
    groups.length === 0 ? null : (
      <div className="space-y-3">
        {groups.map((group) => {
          const catId = group.key === 'uncategorized' ? null : parseInt(group.key, 10);
          const isExpanded = importCategoryFilter === catId;
          return (
            <GroupCard
              key={group.key}
              categoryName={group.categoryName}
              items={isExpanded ? group.items : []}
              total={group.total}
              totalCount={group.totalCount}
              onApprove={handleItemApprove}
              onSkip={handleItemSkip}
              onApproveAll={() => handlePromoteGroup(group.items)}
              onItemClick={setSelectedItem}
              disabled={updatePlaidTx.isPending || bulkPromote.isPending || updateImportRow.isPending}
              isExpanded={isExpanded}
              onToggle={() => {
                setImportCategoryFilter(isExpanded ? null : catId);
                setImportPage(1);
              }}
              pagination={isExpanded ? renderPagination(
                importPage,
                importPagination?.totalPages ?? 1,
                importPagination?.total,
                setImportPage,
                'rows',
              ) : undefined}
            />
          );
        })}
      </div>
    );

  const renderGroupedPlaid = (groups: { key: string; categoryName: string; items: ReviewItem[]; total: number; totalCount?: number }[]) =>
    groups.length === 0 ? null : (
      <div className="space-y-3">
        {groups.map((group) => {
          const catId = group.key === 'uncategorized' ? null : parseInt(group.key, 10);
          const isExpanded = plaidCategoryFilter === catId;
          return (
            <GroupCard
              key={group.key}
              categoryName={group.categoryName}
              items={isExpanded ? group.items : []}
              total={group.total}
              totalCount={group.totalCount}
              onApprove={handleItemApprove}
              onSkip={handleItemSkip}
              onApproveAll={() => handlePromoteGroup(group.items)}
              onItemClick={setSelectedItem}
              disabled={updatePlaidTx.isPending || bulkPromote.isPending || updateImportRow.isPending}
              isExpanded={isExpanded}
              onToggle={() => {
                setPlaidCategoryFilter(isExpanded ? null : catId);
                setPlaidPage(1);
              }}
              pagination={isExpanded ? renderPagination(
                plaidPage,
                plaidPagination?.totalPages ?? 1,
                plaidPagination?.total,
                setPlaidPage,
                'transactions',
              ) : undefined}
            />
          );
        })}
      </div>
    );

  // ── Loading skeleton ──
  const loadingSkeleton = (
    <div className="animate-pulse space-y-3">
      {[...Array(5)].map((_, i) => <div key={i} className="h-14 bg-muted rounded-lg" />)}
    </div>
  );

  // ── Empty state ──
  const emptyState = (title: string, description: string) => (
    <Card className="py-16 text-center">
      <CardContent>
        <CheckCircle2 className="h-12 w-12 mx-auto text-positive mb-4" />
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="text-muted-foreground mt-2">{description}</p>
      </CardContent>
    </Card>
  );

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* ── Page Header ────────────────────────────────────────────── */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardCheck className="h-6 w-6 text-primary" />
            {t('review.pageTitle')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('review.pageSubtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(plaidSummary?.skipped ?? 0) > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const { api } = await import('@/lib/api');
                  const result = await api.bulkRequeuePlaidTransactions();
                  toast({ title: 'Re-queued', description: `${result.updated} skipped transaction(s) moved back to review.` });
                  queryClient.invalidateQueries({ queryKey: ['plaid-transactions'] });
                } catch {
                  toast({ title: 'Failed to re-queue', variant: 'destructive' });
                }
              }}
            >
              {t('review.requeueSkipped')} ({plaidSummary?.skipped ?? 0})
            </Button>
          )}
          {plaidCount > 0 && (activeTab === 'plaid' || activeTab === 'all') && (
            <Button onClick={() => setShowBulkDialog(true)} variant="outline" size="sm">
              <Zap className="h-4 w-4 mr-1" /> {t('review.bulkPromote')}
            </Button>
          )}
        </div>
      </div>

      {/* ── Progress Bar ───────────────────────────────────────────── */}
      {overallTotal > 0 && (
        <div className="mb-6 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {t('review.reviewedProgress', { done: promotedCount, total: overallTotal })}
            </span>
            <span className="font-medium">{progressPct}%</span>
          </div>
          <Progress value={progressPct} className="h-2" />
        </div>
      )}

      {/* ── Tabs ───────────────────────────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="all">
              {t('review.allPending')}
              {totalCount > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                  {totalCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="plaid">
              {t('review.fromPlaid')}
              {plaidCount > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                  {plaidCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="imports">
              {t('review.fromImports')}
              {importCount > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                  {importCount}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <ViewToggle viewMode={viewMode} onChange={setViewMode} />
        </div>

        {/* ── All Pending Tab ── */}
        <TabsContent value="all">
          {plaidLoading || pendingLoading ? (
            loadingSkeleton
          ) : totalCount === 0 ? (
            emptyState(t('review.allCaughtUp'), t('review.noPendingTransactions'))
          ) : (
            <div className="space-y-6">
              {/* Plaid Section */}
              {plaidReviewItems.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                    <Landmark className="h-4 w-4" /> {t('review.plaidTransactions')} ({plaidCount})
                  </h3>
                  {viewMode === 'grouped'
                    ? renderGroupedPlaid(groupedPlaid)
                    : renderFlatList(plaidReviewItems)}
                </div>
              )}

              {/* Imports Section — summary cards for each pending import */}
              {importCount > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                    <FileUp className="h-4 w-4" /> {t('review.importTransactions')} ({importCount})
                  </h3>
                  <div className="space-y-2">
                    {pendingImports.map((imp: { id: string; fileName: string; pendingRowCount: number }) => (
                      <Card
                        key={imp.id}
                        className="cursor-pointer hover:border-primary/50 transition-colors"
                        onClick={() => { setSelectedImportId(imp.id); setActiveTab('imports'); }}
                      >
                        <CardContent className="py-3 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <FileUp className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium text-sm">{imp.fileName}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary">{imp.pendingRowCount} {t('review.pending')}</Badge>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              title={t('review.cancelImport')}
                              onClick={(e) => { e.stopPropagation(); handleCancelImport(imp.id, imp.fileName); }}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* ── Plaid Tab ── */}
        <TabsContent value="plaid">
          {plaidLoading ? (
            loadingSkeleton
          ) : plaidReviewItems.length === 0 ? (
            emptyState(t('review.noPlaidToReview'), t('review.allPlaidProcessed'))
          ) : (
            <>
              {viewMode === 'grouped'
                ? renderGroupedPlaid(groupedPlaid)
                : (
                  <>
                    {renderFlatList(plaidReviewItems)}
                    {renderPagination(
                      plaidPage,
                      plaidPagination?.totalPages ?? 1,
                      plaidPagination?.total,
                      setPlaidPage,
                      'transactions',
                    )}
                  </>
                )}
            </>
          )}
        </TabsContent>

        {/* ── Imports Tab ── */}
        <TabsContent value="imports">
          {pendingLoading ? (
            loadingSkeleton
          ) : pendingImports.length === 0 && !selectedImportId ? (
            emptyState(t('review.noPendingImports'), t('review.allImportsCommitted'))
          ) : (
            <div className="space-y-4">
              {/* Import selector */}
              {pendingImports.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {pendingImports.map((imp: { id: string; fileName: string; pendingRowCount: number }) => (
                    <div key={imp.id} className="flex items-center gap-0.5">
                      <Button
                        variant={selectedImportId === imp.id ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => { setSelectedImportId(imp.id); setImportPage(1); }}
                      >
                        <FileUp className="h-3.5 w-3.5 mr-1" />
                        {imp.fileName} ({imp.pendingRowCount} {t('review.pending')})
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title={t('review.cancelImport')}
                        onClick={() => handleCancelImport(imp.id, imp.fileName)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Selected import rows */}
              {selectedImportId && (
                <>
                  {/* Committing progress indicator */}
                  {importInfo?.status === 'COMMITTING' && (
                    <Card className="py-6 text-center">
                      <CardContent className="space-y-3">
                        <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
                        <p className="font-medium">{t('review.committingTransactions')}</p>
                        <Progress value={importInfo.progress ?? 0} className="w-full max-w-xs mx-auto" />
                        <p className="text-sm text-muted-foreground">
                          {importInfo.progress ?? 0}% {t('review.complete')}
                        </p>
                      </CardContent>
                    </Card>
                  )}

                  {importInfo?.status !== 'COMMITTING' && (
                    <>
                      {stagedLoading ? (
                        loadingSkeleton
                      ) : importReviewItems.length === 0 ? (
                        <Card className="py-8 text-center">
                          <CardContent>
                            <p className="text-muted-foreground">{t('review.noRowsInImport')}</p>
                          </CardContent>
                        </Card>
                      ) : (
                        <>
                          {viewMode === 'grouped'
                            ? renderGroupedImports(groupedImports)
                            : (
                              <>
                                {renderFlatList(importReviewItems)}
                                {renderPagination(
                                  importPage,
                                  importPagination?.totalPages ?? 1,
                                  importPagination?.total,
                                  setImportPage,
                                  'rows',
                                )}
                              </>
                            )}
                        </>
                      )}

                      {/* Commit bar */}
                      {importInfo?.status === 'READY' && (
                        <div className="flex justify-end pt-2">
                          <Button
                            onClick={() => handleCommitImport(selectedImportId!)}
                            disabled={commitImport.isPending}
                          >
                            {commitImport.isPending ? (
                              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('review.committing')}</>
                            ) : (
                              <><CheckCircle2 className="h-4 w-4 mr-2" /> {t('review.commitAll')}</>
                            )}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Deep Dive Drawer ─────────────────────────────────────── */}
      <DeepDiveDrawer
        item={selectedItem}
        categories={categories}
        accounts={accounts}
        onClose={() => setSelectedItem(null)}
        onSaveAndPromote={handleDrawerSave}
        onSkip={handleDrawerSkip}
        isSaving={updatePlaidTx.isPending || updateImportRow.isPending}
      />

      {/* ── Drawer Promote-All Dialog ─────────────────────────────── */}
      {(() => {
        if (!pendingDrawerSave) return null;
        const { item, categoryId } = pendingDrawerSave;
        const effectiveCategoryId = categoryId ?? item.categoryId;
        const effectiveCategoryName =
          (effectiveCategoryId
            ? categories.find((c: Category) => c.id === effectiveCategoryId)?.name
            : null) ?? item.category;
        const otherCount = pendingDrawerOtherMatches.length;
        return (
          <Dialog
            open={!!pendingDrawerSave}
            onOpenChange={(open) => !open && setPendingDrawerSave(null)}
          >
            <DialogContent onPointerDownOutside={(e) => e.preventDefault()}>
              <DialogHeader>
                <DialogTitle>{t('review.confirmMatchingTitle')}</DialogTitle>
                <DialogDescription>
                  <span dangerouslySetInnerHTML={{ __html: t('review.confirmMatchingDescription', {
                    count: otherCount,
                    verb: otherCount === 1 ? 'is' : 'are',
                    plural: otherCount !== 1 ? 's' : '',
                    description: item.description,
                    category: effectiveCategoryName,
                    interpolation: { escapeValue: false },
                  }) }} />
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  variant="outline"
                  onClick={() => {
                    const saved = pendingDrawerSave!;
                    setPendingDrawerSave(null);
                    executeDrawerSave(saved);
                  }}
                >
                  {t('review.justThisOne')}
                </Button>
                <Button
                  onClick={() => {
                    const saved = pendingDrawerSave!;
                    const catId = saved.categoryId ?? saved.item.categoryId;
                    const plaidMatches = pendingDrawerOtherMatches.filter((i) => i.source === 'plaid');
                    const importMatches = pendingDrawerOtherMatches.filter((i) => i.source === 'import');

                    // Save the current transaction immediately (suppress individual toast).
                    executeDrawerSave(saved, true);

                    // Confirm matching import rows with the same category
                    for (const match of importMatches) {
                      const row = match.originalImportRow!;
                      const rowData: Record<string, unknown> = { status: 'CONFIRMED' };
                      if (catId && catId !== match.categoryId) {
                        rowData.suggestedCategoryId = catId;
                      }
                      if (selectedImportId && selectedImportId === row.stagedImportId) {
                        updateImportRow.mutate({ rowId: row.id, data: rowData });
                      } else {
                        api.updateImportRow(row.stagedImportId, row.id, rowData).catch(() => {});
                      }
                    }

                    // Bulk promote matching Plaid transactions
                    if (plaidMatches.length > 0) {
                      const plaidIds = plaidMatches.map((i) => i.id);
                      bulkPromote.mutate(
                        {
                          transactionIds: plaidIds,
                          ...(catId && { overrideCategoryId: catId }),
                        },
                        {
                          onSuccess: (result) => {
                            setPendingDrawerSave(null);
                            const total = result.promoted + 1 + importMatches.length;
                            toast({
                              title: `Promoted ${total} transaction${total !== 1 ? 's' : ''}`,
                              description: `1 saved from drawer + ${result.promoted} Plaid + ${importMatches.length} import matching "${item.description}".`,
                            });
                          },
                          onError: () => {
                            setPendingDrawerSave(null);
                            toast({
                              title: 'Saved this transaction, but failed to promote Plaid matches',
                              variant: 'destructive',
                            });
                          },
                        },
                      );
                    } else {
                      // Only import matches, no Plaid — close dialog immediately
                      setPendingDrawerSave(null);
                      const total = 1 + importMatches.length;
                      toast({
                        title: `Confirmed ${total} transaction${total !== 1 ? 's' : ''}`,
                        description: `1 saved from drawer + ${importMatches.length} matching "${item.description}".`,
                      });
                    }
                  }}
                  disabled={bulkPromote.isPending}
                >
                  {bulkPromote.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('review.confirming')}
                    </>
                  ) : (
                    <>{t('review.confirmAllCount', { count: otherCount + 1 })}</>
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* ── Promote by Description Dialog ────────────────────────── */}
      <Dialog
        open={!!pendingApproveItem}
        onOpenChange={(open) => !open && setPendingApproveItem(null)}
      >
        <DialogContent onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('review.promoteMatchingTitle')}</DialogTitle>
            <DialogDescription>
              <span dangerouslySetInnerHTML={{ __html: t('review.promoteMatchingDescription', {
                count: pendingApproveMatches.length,
                plural: pendingApproveMatches.length !== 1 ? 's' : '',
                description: pendingApproveItem?.description,
                interpolation: { escapeValue: false },
              }) }} />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                const item = pendingApproveItem!;
                setPendingApproveItem(null);
                handlePlaidPromote(item.originalPlaidTx!);
              }}
            >
              {t('review.justThisOne')}
            </Button>
            <Button
              onClick={() => {
                const ids = pendingApproveMatches.map((i) => i.id);
                // NOTE: do NOT close dialog here — keep it open so the spinner is visible.
                // Dialog closes in onSuccess / onError below.
                bulkPromote.mutate(
                  { transactionIds: ids },
                  {
                    onSuccess: (result) => {
                      setPendingApproveItem(null);
                      toast({
                        title: `Promoted ${result.promoted} transaction${result.promoted !== 1 ? 's' : ''}`,
                      });
                    },
                    onError: () => {
                      setPendingApproveItem(null);
                      toast({ title: 'Failed to promote', variant: 'destructive' });
                    },
                  },
                );
              }}
              disabled={bulkPromote.isPending}
            >
              {bulkPromote.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('review.promoting')}
                </>
              ) : (
                <>{t('review.promoteAllCount', { count: pendingApproveMatches.length })}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Bulk Promote Dialog ──────────────────────────────────── */}
      <Dialog open={showBulkDialog} onOpenChange={setShowBulkDialog}>
        <DialogContent onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('review.bulkPromoteTitle')}</DialogTitle>
            <DialogDescription>
              {t('review.bulkPromoteDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>{t('review.minConfidenceThreshold')}</Label>
              <Select value={bulkConfidenceThreshold} onValueChange={setBulkConfidenceThreshold}>
                <SelectTrigger className="w-full mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.9">{t('review.threshold90')}</SelectItem>
                  <SelectItem value="0.8">{t('review.threshold80')}</SelectItem>
                  <SelectItem value="0.7">{t('review.threshold70')}</SelectItem>
                  <SelectItem value="0.5">{t('review.threshold50')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {t('review.thresholdHint')}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleBulkPromote} disabled={bulkPromote.isPending}>
              {bulkPromote.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('review.promoting')}</>
              ) : (
                <><Zap className="h-4 w-4 mr-2" /> {t('review.promoteAll')}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

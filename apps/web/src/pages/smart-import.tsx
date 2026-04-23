import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import {
  FileUp,
  Upload,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ChevronLeftIcon,
  ChevronRightIcon,
  Sparkles,
  Copy,
  RotateCcw,
  ArrowLeft,
  StickyNote,
  ClipboardCheck,
  LayoutList,
  FolderOpen,
  Settings2,
  Trash2,
  Pencil,
  Plus,
  Globe,
  Download,
  X,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAccounts, useCategories } from '@/hooks/use-metadata';
import {
  useDetectAdapter,
  useUploadSmartImport,
  useStagedImport,
  useUpdateImportRow,
  useCommitImport,
  useCancelImport,
  useAdapters,
  useCreateAdapter,
  useUpdateAdapter,
  useDeleteAdapter,
  useImportSeeds,
  useConfirmImportSeeds,
} from '@/hooks/use-imports';
import { formatCurrency, formatDate } from '@/lib/utils';
import { itemNeedsEnrichment } from '@/lib/investment-utils';
import type { ImportAdapter, DetectAdapterResult, StagedImportRow, Account, Category, CreateAdapterRequest, SeedItem } from '@/types/api';
import { TxDataRow } from '@/components/review/tx-data-row';
import { GroupCard } from '@/components/review/group-card';
import { DeepDiveDrawer, type DrawerSaveData } from '@/components/review/deep-dive-drawer';
import type { ReviewItem } from '@/components/review/types';

// ─── Step Constants ──────────────────────────────────────────────────
type Step = 'upload' | 'processing' | 'seed' | 'review' | 'done';

// ─── Status badge helpers ────────────────────────────────────────────
const rowStatusBadge = (status: string, t: (key: string) => string) => {
  switch (status) {
    case 'CONFIRMED':
      return <Badge className="bg-positive/10 text-positive hover:bg-positive/10">{t('smartImport.status.confirmed')}</Badge>;
    case 'PENDING':
      return <Badge variant="secondary">{t('smartImport.status.pending')}</Badge>;
    case 'DUPLICATE':
      return <Badge variant="destructive">{t('smartImport.status.duplicate')}</Badge>;
    case 'POTENTIAL_DUPLICATE':
      return <Badge className="bg-warning/10 text-warning hover:bg-warning/10">{t('smartImport.status.possibleDup')}</Badge>;
    case 'SKIPPED':
      return <Badge variant="outline">{t('smartImport.status.skipped')}</Badge>;
    case 'ERROR':
      return <Badge variant="destructive">{t('smartImport.status.error')}</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
};

const confidenceBadge = (confidence: number | null | undefined, source: string | null | undefined, t: (key: string) => string) => {
  if (confidence == null) return <span className="text-muted-foreground text-xs">-</span>;
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 80 ? 'text-positive' :
      pct >= 50 ? 'text-warning' :
        'text-destructive';
  const label =
    source === 'USER_OVERRIDE' ? t('smartImport.source.manual') :
      source === 'EXACT_MATCH' ? t('smartImport.source.exact') :
        source === 'VECTOR_MATCH' ? t('smartImport.source.vector') :
          source === 'AI_CLASSIFICATION' ? t('smartImport.source.ai') :
            source ?? '';
  return (
    <span className={`text-xs font-medium ${color}`}>
      {pct}% <span className="text-muted-foreground font-normal">({label})</span>
    </span>
  );
};

// ─── StagedImportRow → ReviewItem normalizer ─────────────────────────
function toReviewItem(
  row: StagedImportRow,
  categoriesMap: Map<number, Category>,
  accountsMap: Map<number, Account>,
): ReviewItem {
  const debit  = parseFloat(String(row.debit  || 0));
  const credit = parseFloat(String(row.credit || 0));
  const amount = credit > 0 ? -credit : debit;
  const category = row.suggestedCategoryId ? (categoriesMap.get(row.suggestedCategoryId) ?? null) : null;
  const account  = row.accountId ? (accountsMap.get(row.accountId) ?? null) : null;

  let status: ReviewItem['status'];
  if (row.status === 'DUPLICATE')
    status = 'duplicate';
  else if (row.status === 'POTENTIAL_DUPLICATE')
    status = 'potential-duplicate';
  else if ((row as StagedImportRow & { requiresEnrichment?: boolean }).requiresEnrichment)
    status = 'needs-enrichment';
  else if (!row.confidence || (row.confidence ?? 0) < 0.5)
    status = 'low-confidence';
  else if (row.classificationSource === 'LLM' && (row.confidence ?? 0) < 0.85)
    status = 'new-merchant';
  else
    status = 'ai-approved';

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
    requiresEnrichment: (row as StagedImportRow & { requiresEnrichment?: boolean }).requiresEnrichment ?? false,
    enrichmentType: (row as StagedImportRow & { enrichmentType?: string }).enrichmentType ?? null,
    promotionStatus: row.status,
    updateTargetId: row.updateTargetId ?? null,
    updateDiff: row.updateDiff ?? null,
    originalImportRow: row,
  };
}

// ─── Main Component ──────────────────────────────────────────────────
export default function SmartImportPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  // --- State ---
  const [step, setStep] = useState<Step>('upload');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [detectionResult, setDetectionResult] = useState<DetectAdapterResult | null>(null);
  const [selectedAdapterId, setSelectedAdapterId] = useState<string | null>(null);
  const [stagedImportId, setStagedImportId] = useState<string | null>(null);
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewFilter, setReviewFilter] = useState<string>('all');
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [viewMode, setViewMode] = useState<'flat' | 'grouped'>('grouped');
  const [commitResult, setCommitResult] = useState<{ committed: boolean; transactionCount: number; updateCount: number; remaining: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Seed interview state ---
  const [seedInterviewData, setSeedInterviewData] = useState<SeedItem[]>([]);
  const [localSeedCategories, setLocalSeedCategories] = useState<Record<string, number>>({});
  const [localSeedTypes, setLocalSeedTypes] = useState<Record<string, string>>({});
  const [localSeedGroups, setLocalSeedGroups] = useState<Record<string, string>>({});
  const [excludedSeeds, setExcludedSeeds] = useState<Set<string>>(new Set());
  const [isConfirmingSeeds, setIsConfirmingSeeds] = useState(false);
  const seedShownRef = useRef(false);

  // --- Deep-Dive Drawer state ---
  const [drawerItem, setDrawerItem] = useState<ReviewItem | null>(null);

  // --- Adapter Manager state ---
  const [showAdapterManager, setShowAdapterManager] = useState(false);
  const [editingAdapter, setEditingAdapter] = useState<ImportAdapter | null>(null);
  const [showAdapterForm, setShowAdapterForm] = useState(false);
  const [adapterFormData, setAdapterFormData] = useState({
    name: '',
    matchHeaders: '',
    dateColumn: '',
    descriptionColumn: '',
    amountStrategy: 'SINGLE_SIGNED' as 'SINGLE_SIGNED' | 'DEBIT_CREDIT_COLUMNS' | 'AMOUNT_WITH_TYPE',
    amountColumn: '',
    debitColumn: '',
    creditColumn: '',
    dateFormat: '',
    currencyDefault: '',
    skipRows: 0,
  });

  // --- Metadata ---
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();

  const categoriesMap = useMemo(
    () => new Map(categories.map((c: Category) => [c.id, c])),
    [categories],
  );
  const accountsMap = useMemo(
    () => new Map(accounts.map((a: Account) => [a.id, a])),
    [accounts],
  );

  // --- Mutations ---
  const detectAdapter = useDetectAdapter();
  const uploadImport = useUploadSmartImport();
  const commitImport = useCommitImport();
  const cancelImport = useCancelImport();

  // --- Adapter Manager ---
  const { data: adaptersData } = useAdapters();
  const adapters: ImportAdapter[] = useMemo(
    () => (adaptersData as { adapters?: ImportAdapter[] })?.adapters ?? (adaptersData as ImportAdapter[]) ?? [],
    [adaptersData],
  );
  const createAdapter = useCreateAdapter();
  const updateAdapterMutation = useUpdateAdapter();
  const deleteAdapterMutation = useDeleteAdapter();

  // --- Pre-select native adapter via ?adapter=native URL param ---
  useEffect(() => {
    if (searchParams.get('adapter') === 'native' && adapters.length > 0) {
      const native = adapters.find(
        (a) => (a as ImportAdapter & { matchSignature?: { isNative?: boolean } }).matchSignature?.isNative === true,
      );
      if (native) setSelectedAdapterId(String(native.id));
    }
  }, [searchParams, adapters]);

  // Derived: is the currently selected adapter the native one?
  const isNativeAdapterSelected = adapters.some(
    (a) =>
      String(a.id) === selectedAdapterId &&
      (a as ImportAdapter & { matchSignature?: { isNative?: boolean } }).matchSignature?.isNative === true,
  );

  // --- Staged import polling ---
  const {
    data: stagedData,
    isLoading: stagedLoading,
    isError: stagedError,
  } = useStagedImport(
    stagedImportId,
    { page: reviewPage, limit: 50, status: reviewFilter === 'all' ? undefined : reviewFilter },
  );

  const updateRow = useUpdateImportRow(stagedImportId);

  // --- Quick Seed Interview hooks ---
  // Only fetch seeds when seedReady is true and we're still in processing step
  const seedReady = stagedData?.import?.seedReady;
  const { data: seedItems } = useImportSeeds(
    step === 'processing' && !!seedReady && !seedShownRef.current ? stagedImportId : null,
    15,
  );
  const confirmSeedsMutation = useConfirmImportSeeds(stagedImportId);

  // --- Computed (must come before handlers that reference `rows`) ---
  const rows = useMemo(() => stagedData?.rows ?? [], [stagedData]);
  const pagination = stagedData?.pagination;
  const totalPages = pagination?.totalPages ?? 1;

  // Transition from processing → review when ready, with toast notification.
  // Guarded by !seedReady: if seeds are coming we stay in 'processing' so that
  // useImportSeeds stays enabled and the seedItems useEffect can run.
  // The seedItems effect (below) handles the review transition for the seedReady=true path.
  const importStatus = stagedData?.import?.status;
  if (step === 'processing' && importStatus && importStatus !== 'PROCESSING' && !seedReady) {
    const readyRowCount = stagedData?.import?.totalRows ?? 0;
    toast({
      title: t('smartImport.toast.importReady'),
      description: t('smartImport.toast.rowsReady', { count: readyRowCount }),
    });
    setStep('review');
  }

  // When seeds arrive, transition to seed step (or skip if 0 seeds)
  useEffect(() => {
    if (!seedItems || seedShownRef.current) return;
    if (step !== 'processing') return;
    seedShownRef.current = true;
    if (seedItems.length === 0) {
      // All top descriptions hit Tier 1/2 — no interview needed.
      // The status transition above is blocked when seedReady=true, so we
      // must trigger the review transition ourselves here.
      const readyRowCount = stagedData?.import?.totalRows ?? 0;
      toast({
        title: t('smartImport.toast.importReady'),
        description: t('smartImport.toast.rowsReady', { count: readyRowCount }),
      });
      setStep('review');
      return;
    }
    // Pre-populate with AI-suggested categories; user can override
    const initial: Record<string, number> = {};
    const initialTypes: Record<string, string> = {};
    const initialGroups: Record<string, string> = {};
    for (const s of seedItems) {
      if (s.suggestedCategoryId != null) {
        initial[s.normalizedDescription] = s.suggestedCategoryId;
        // Derive initial type/group from the suggested category (embedded or from categories list)
        const cat = s.suggestedCategory ?? categories.find((c) => c.id === s.suggestedCategoryId);
        if (cat) {
          initialTypes[s.normalizedDescription] = cat.type;
          initialGroups[s.normalizedDescription] = cat.group;
        }
      }
    }
    setLocalSeedCategories(initial);
    setLocalSeedTypes(initialTypes);
    setLocalSeedGroups(initialGroups);
    setExcludedSeeds(new Set());
    setSeedInterviewData(seedItems);
    setStep('seed');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedItems, stagedData]);

  // --- Handlers ---

  // --- Seed Interview Handlers ---

  const handleImportSeedConfirm = useCallback(async () => {
    if (!stagedImportId) return;
    setIsConfirmingSeeds(true);
    try {
      const seeds = seedInterviewData
        .filter((s) => !excludedSeeds.has(s.normalizedDescription) && localSeedCategories[s.normalizedDescription] != null)
        .map((s) => ({
          description: s.description,
          confirmedCategoryId: localSeedCategories[s.normalizedDescription],
        }));
      if (seeds.length > 0) {
        await confirmSeedsMutation.mutateAsync(seeds);
      }
      const readyRowCount = stagedData?.import?.totalRows ?? 0;
      toast({
        title: t('smartImport.toast.importReady'),
        description: t('smartImport.toast.rowsReady', { count: readyRowCount }),
      });
      setStep('review');
    } catch (err) {
      console.error('Seed confirmation failed:', err);
      toast({ title: t('common.error'), description: t('smartImport.toast.seedSaveFailed'), variant: 'destructive' });
    } finally {
      setIsConfirmingSeeds(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
  }, [stagedImportId, seedInterviewData, localSeedCategories, excludedSeeds, confirmSeedsMutation, stagedData, toast]);

  const handleImportSeedSkip = useCallback(() => {
    const readyRowCount = stagedData?.import?.totalRows ?? 0;
    toast({
      title: t('smartImport.toast.importReady'),
      description: t('smartImport.toast.rowsReady', { count: readyRowCount }),
    });
    setStep('review');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
  }, [stagedData, toast]);

  // --- Detect COMMITTING → COMMITTED/READY transition via polling ---
  //
  // `useStagedImport` only polls while status is PROCESSING or COMMITTING.
  // In the common case where the commit worker finishes in <2s we can
  // miss the COMMITTING state entirely — by the time the UI refetches,
  // status is already back to READY with a commitResult. Relying on
  // `prevStatus === 'COMMITTING'` observed via polling is therefore
  // unreliable. `commitInFlightRef` is set by `handleCommit`'s
  // `onMutate` instead — we KNOW a commit was initiated, regardless of
  // whether we ever observed the COMMITTING state.
  const prevCommitStatusRef = useRef<string | undefined>();
  const commitInFlightRef = useRef<boolean>(false);
  useEffect(() => {
    const prevStatus = prevCommitStatusRef.current;
    prevCommitStatusRef.current = importStatus;

    if (!importStatus || step !== 'review') return;

    // Extract commit result stored by the worker in errorDetails.commitResult
    const errorDetails = stagedData?.import?.errorDetails as
      | { commitResult?: { transactionCount: number; updateCount?: number; remaining: number } }
      | null;
    const result = errorDetails?.commitResult;

    if (importStatus === 'COMMITTED') {
      if (result) {
        setCommitResult({ committed: true, transactionCount: result.transactionCount, updateCount: result.updateCount ?? 0, remaining: result.remaining });
      }
      commitInFlightRef.current = false;
      setStep('done');
      const parts = [];
      if (result?.transactionCount) parts.push(t('smartImport.toast.nCreated', { count: result.transactionCount }));
      if (result?.updateCount) parts.push(t('smartImport.toast.nUpdated', { count: result.updateCount }));
      toast({
        title: t('smartImport.toast.importCommitted'),
        description: parts.length > 0 ? `${parts.join(', ')}.` : t('smartImport.toast.done'),
      });
      // Now that transactions exist, invalidate transaction queries
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    } else if (commitInFlightRef.current && importStatus === 'READY' && result) {
      // Partial commit: we initiated a commit (tracked via the ref because
      // the COMMITTING state may not be observable via polling — see the
      // ref's docstring above) and the backend has returned READY with a
      // commitResult. Some rows were committed, others remain
      // (PENDING / POTENTIAL_DUPLICATE / STAGED rows stay in READY so the
      // user can come back to review them later).
      //
      // Clicking "Commit" expresses intent to finish this batch, so treat
      // a partial commit as "done" UX-wise: show the completion page with
      // the stats block (which already has a dedicated "Remaining" counter
      // in warning color) and the "Review in Transaction Review" CTA so
      // the user can finish the leftover rows without hunting.
      setCommitResult({
        committed: true,
        transactionCount: result.transactionCount,
        updateCount: result.updateCount ?? 0,
        remaining: result.remaining,
      });
      commitInFlightRef.current = false;
      setStep('done');
      const partialParts = [];
      if (result.transactionCount) partialParts.push(t('smartImport.toast.nCreated', { count: result.transactionCount }));
      if (result.updateCount) partialParts.push(t('smartImport.toast.nUpdated', { count: result.updateCount }));
      toast({
        title: t('smartImport.toast.partialCommit'),
        description: `${partialParts.join(', ')}. ${t('smartImport.toast.rowsRemaining', { count: result.remaining })}`,
      });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    }
    // Suppress the unused-var lint for prevStatus — kept because the ref
    // still tracks observed status for potential future diagnostics.
    void prevStatus;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
  }, [importStatus, step, stagedData, toast, queryClient]);

  // --- File / Upload Handlers ---

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setDetectionResult(null);
    setSelectedAdapterId(null);

    // Run adapter detection
    detectAdapter.mutate(file, {
      onSuccess: (result) => {
        setDetectionResult(result);
        if (result.adapter) {
          setSelectedAdapterId(String(result.adapter.id));
        }
      },
      onError: () => {
        toast({
          title: t('smartImport.toast.detectionFailed'),
          description: t('smartImport.toast.detectionFailedDesc'),
          variant: 'destructive',
        });
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
  }, [detectAdapter, toast]);

  const handleUpload = useCallback(() => {
    if (!selectedFile || !selectedAdapterId) return;
    if (!isNativeAdapterSelected && !selectedAccountId) return;

    uploadImport.mutate(
      { file: selectedFile, accountId: selectedAccountId, adapterId: selectedAdapterId },
      {
        onSuccess: (data) => {
          setStagedImportId(data.stagedImportId);
          setStep('processing');
        },
        onError: () => {
          toast({
            title: t('smartImport.toast.uploadFailed'),
            description: t('smartImport.toast.uploadFailedDesc'),
            variant: 'destructive',
          });
        },
      },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t and isNativeAdapterSelected are stable; adding them would not change behavior
  }, [selectedFile, selectedAccountId, selectedAdapterId, uploadImport, toast]);

  const handleRowStatusChange = useCallback(
    (rowId: string, newStatus: string) => {
      // Prevent confirming rows that need mandatory enrichment — redirect to drawer
      if (newStatus === 'CONFIRMED') {
        const row = rows.find((r) => r.id === rowId);
        if (row?.requiresEnrichment) {
          const item = toReviewItem(row, categoriesMap, accountsMap);
          setDrawerItem(item);
          return;
        }
        // Also check category dynamically (covers UI category changes before backend sync)
        if (row?.suggestedCategoryId) {
          const cat = categoriesMap.get(row.suggestedCategoryId);
          if (cat && cat.type === 'Investments' && ['API_STOCK', 'API_CRYPTO', 'API_FUND'].includes(cat.processingHint ?? '')) {
            const item = toReviewItem(row, categoriesMap, accountsMap);
            setDrawerItem(item);
            return;
          }
        }
      }

      updateRow.mutate(
        { rowId, data: { status: newStatus } },
        {
          onSuccess: () => {
            // Auto-suggest: after confirming a row, check for others with the same category
            if (newStatus === 'CONFIRMED') {
              const confirmedRow = rows.find((r) => r.id === rowId);
              if (confirmedRow?.suggestedCategoryId) {
                const similar = rows.filter(
                  (r) =>
                    r.id !== rowId &&
                    r.suggestedCategoryId === confirmedRow.suggestedCategoryId &&
                    r.status !== 'CONFIRMED' &&
                    r.status !== 'SKIPPED' &&
                    r.status !== 'DUPLICATE' &&
                    !r.requiresEnrichment,
                );
                if (similar.length > 0) {
                  const catName = confirmedRow.suggestedCategory?.name ??
                    categoriesMap.get(confirmedRow.suggestedCategoryId)?.name ?? 'this category';
                  toast({
                    title: t('smartImport.toast.otherTransactions', { count: similar.length, category: catName }),
                    description: t('smartImport.toast.confirmAllQuestion'),
                    action: (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          similar.forEach((r) => {
                            updateRow.mutate({ rowId: r.id, data: { status: 'CONFIRMED' } });
                          });
                          // Reset the status filter so the just-confirmed
                          // rows stay visible in their groups. Without this,
                          // a `reviewFilter='PENDING'` user sees the group
                          // disappear from the grouped view after bulk
                          // confirm (the items moved to CONFIRMED). Mirrors
                          // the category-filter reset in transaction-review.
                          if (reviewFilter !== 'all') {
                            setReviewFilter('all');
                            setReviewPage(1);
                          }
                          toast({ title: t('smartImport.toast.confirmedN', { count: similar.length }) });
                        }}
                      >
                        {t('smartImport.confirmAll')}
                      </Button>
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    ) as any,
                  });
                }
              }
            }
          },
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
    [updateRow, rows, categoriesMap, accountsMap, toast],
  );

  const handleRowCategoryChange = useCallback(
    (rowId: string, categoryId: number) => {
      updateRow.mutate({ rowId, data: { suggestedCategoryId: categoryId } });
    },
    [updateRow],
  );

  const handleRowDetailsChange = useCallback(
    (rowId: string, details: string) => {
      updateRow.mutate({ rowId, data: { details: details || null } });
    },
    [updateRow],
  );

  // --- Deep-Dive Drawer handlers ---
  const handleDrawerSave = useCallback(
    (data: DrawerSaveData) => {
      const isAlreadyProcessed =
        data.item.promotionStatus === 'PROMOTED' ||
        data.item.promotionStatus === 'CONFIRMED' ||
        data.item.promotionStatus === 'SKIPPED';
      const payload: Record<string, unknown> = {};
      if (!isAlreadyProcessed) payload.status = 'CONFIRMED';
      if (data.categoryId != null)  payload.suggestedCategoryId = data.categoryId;
      if (data.accountId != null)   payload.accountId = data.accountId;
      if (data.details !== undefined) payload.details = data.details || null;
      if (data.ticker !== undefined)  payload.ticker = data.ticker || null;
      if (data.assetQuantity !== undefined) payload.assetQuantity = data.assetQuantity ? parseFloat(data.assetQuantity) : null;
      if (data.assetPrice !== undefined)    payload.assetPrice    = data.assetPrice    ? parseFloat(data.assetPrice)    : null;
      updateRow.mutate({ rowId: data.item.id, data: payload }, {
        onSuccess: () => setDrawerItem(null),
      });
    },
    [updateRow],
  );

  const handleDrawerSkip = useCallback(() => {
    if (!drawerItem) return;
    updateRow.mutate({ rowId: drawerItem.id, data: { status: 'SKIPPED' } }, {
      onSuccess: () => setDrawerItem(null),
    });
  }, [drawerItem, updateRow]);

  const handleCommit = useCallback(() => {
    if (!stagedImportId) return;
    commitImport.mutate({ id: stagedImportId }, {
      onSuccess: () => {
        setShowCommitDialog(false);
        // Signal to the status-transition effect that a commit is
        // running, so it can transition to 'done' when we next see a
        // commitResult — even if we never observe the intermediate
        // COMMITTING state via polling (fast commits finish before the
        // 2s polling interval fires).
        commitInFlightRef.current = true;
        // Invalidate the staged-import query so TanStack Query refetches
        // immediately. The refetch picks up the new COMMITTING status and
        // re-enables polling until the job completes.
        queryClient.invalidateQueries({ queryKey: ['imports', 'staged', stagedImportId] });
        toast({ title: t('smartImport.toast.commitStarted'), description: t('smartImport.toast.commitStartedDesc') });
      },
      onError: () => {
        setShowCommitDialog(false);
        // Safety: clear the ref so a subsequent poll doesn't fire a
        // stale transition from a failed attempt.
        commitInFlightRef.current = false;
        toast({ title: t('smartImport.toast.commitFailed'), description: t('smartImport.toast.commitFailedDesc'), variant: 'destructive' });
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
  }, [stagedImportId, commitImport, queryClient, toast]);

  const handleReset = useCallback(() => {
    setStep('upload');
    setSelectedFile(null);
    setSelectedAccountId(null);
    setDetectionResult(null);
    setSelectedAdapterId(null);
    setStagedImportId(null);
    setReviewPage(1);
    setReviewFilter('all');
    setCommitResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleCancel = useCallback(() => {
    if (!stagedImportId) return;
    cancelImport.mutate(stagedImportId, {
      onSuccess: () => {
        setShowCancelDialog(false);
        toast({ title: t('smartImport.toast.importCancelled') });
        handleReset();
      },
      onError: () => {
        setShowCancelDialog(false);
        toast({ title: t('smartImport.toast.cancelFailed'), variant: 'destructive' });
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
  }, [stagedImportId, cancelImport, toast, handleReset]);

  const canUpload =
    !!selectedFile &&
    !!selectedAdapterId &&
    (isNativeAdapterSelected ? true : !!selectedAccountId) &&
    !uploadImport.isPending;

  // --- Adapter Manager handlers ---
  const openCreateAdapterForm = (prefillHeaders?: string) => {
    setEditingAdapter(null);
    setAdapterFormData({ name: '', matchHeaders: prefillHeaders ?? '', dateColumn: '', descriptionColumn: '', amountStrategy: 'SINGLE_SIGNED', amountColumn: '', debitColumn: '', creditColumn: '', dateFormat: '', currencyDefault: '', skipRows: 0 });
    setShowAdapterForm(true);
  };

  const openEditAdapterForm = (adapter: ImportAdapter) => {
    setEditingAdapter(adapter);
    const sig = ((adapter as ImportAdapter & { matchSignature?: { headers?: string[] } }).matchSignature ?? {}) as { headers?: string[] };
    const col = (adapter.columnMapping ?? {}) as { date?: string; description?: string; amount?: string; debit?: string; credit?: string; };
    setAdapterFormData({
      name: adapter.name,
      matchHeaders: (sig?.headers ?? []).join(', '),
      dateColumn: col?.date ?? '',
      descriptionColumn: col?.description ?? '',
      amountStrategy: adapter.amountStrategy || 'SINGLE_SIGNED',
      amountColumn: col?.amount ?? '',
      debitColumn: col?.debit ?? '',
      creditColumn: col?.credit ?? '',
      dateFormat: adapter.dateFormat ?? '',
      currencyDefault: adapter.currencyDefault ?? '',
      skipRows: adapter.skipRows ?? 0,
    });
    setShowAdapterForm(true);
  };

  const handleSaveAdapter = () => {
    // Build a local object explicitly typed to match what createAdapter expects
    const payload: CreateAdapterRequest = {
      name: adapterFormData.name,
      matchSignature: { headers: adapterFormData.matchHeaders.split(',').map(s => s.trim()) },
      columnMapping: {
        date: adapterFormData.dateColumn || '',
        description: adapterFormData.descriptionColumn || '',
        amount: adapterFormData.amountColumn || '',
        debit: adapterFormData.debitColumn || '',
        credit: adapterFormData.creditColumn || '',
      },
      amountStrategy: adapterFormData.amountStrategy,
      dateFormat: adapterFormData.dateFormat || undefined,
      currencyDefault: adapterFormData.currencyDefault || undefined,
      skipRows: adapterFormData.skipRows,
    };

    if (editingAdapter) {
      updateAdapterMutation.mutate({ id: editingAdapter.id, data: payload as Partial<CreateAdapterRequest> }, {
        onSuccess: () => { setShowAdapterForm(false); toast({ title: t('smartImport.toast.adapterUpdated') }); },
        onError: (e: Error) => toast({ title: t('smartImport.toast.updateFailed'), description: e.message, variant: 'destructive' }),
      });
    } else {
      createAdapter.mutate(payload, {
        onSuccess: () => {
          setShowAdapterForm(false);
          toast({ title: t('smartImport.toast.adapterCreated') });
          // Auto-redetect if a file is already selected so the user can proceed immediately
          if (selectedFile) {
            detectAdapter.mutate(selectedFile, {
              onSuccess: (result) => {
                setDetectionResult(result);
                if (result.adapter) {
                  setSelectedAdapterId(String(result.adapter.id));
                  toast({ title: t('smartImport.toast.formatMatched', { name: result.adapter.name }), description: t('smartImport.toast.formatMatchedDesc') });
                }
              },
            });
          }
        },
        onError: (e: Error) => toast({ title: t('smartImport.toast.createFailed'), description: e.message, variant: 'destructive' }),
      });
    }
  };

  const handleDeleteAdapter = (id: number) => {
    deleteAdapterMutation.mutate(id, {
      onSuccess: () => toast({ title: t('smartImport.toast.adapterDeleted') }),
      onError: (e: unknown) => toast({ title: t('smartImport.toast.deleteFailed'), description: (e as Error)?.message || 'Unknown error', variant: 'destructive' }),
    });
  };

  // Row summary counts
  const importInfo = stagedData?.import;
  const rowSummary = useMemo(() => {
    if (!rows.length) return null;
    const counts: Record<string, number> = {};
    rows.forEach((r) => {
      counts[r.status] = (counts[r.status] || 0) + 1;
    });
    return counts;
  }, [rows]);

  // Normalized ReviewItem list for flat view
  const reviewItems = useMemo(
    () => rows.map((r) => toReviewItem(r, categoriesMap, accountsMap)),
    [rows, categoriesMap, accountsMap],
  );

  // Grouped view data (ReviewItems grouped by category)
  const groupedRows = useMemo(() => {
    if (viewMode !== 'grouped') return [];
    const groups = new Map<number | 'uncategorized', { category: Category | null; items: ReviewItem[]; total: number }>();

    for (const item of reviewItems) {
      const key = item.categoryId ?? 'uncategorized';
      if (!groups.has(key)) {
        const cat = item.categoryId ? (categoriesMap.get(item.categoryId) ?? null) : null;
        groups.set(key, { category: cat, items: [], total: 0 });
      }
      const g = groups.get(key)!;
      g.items.push(item);
      g.total += Math.abs(item.amount);
    }

    return Array.from(groups.entries())
      .sort(([, a], [, b]) => b.items.length - a.items.length)
      .map(([key, val]) => ({ key: String(key), ...val }));
  }, [reviewItems, viewMode, categoriesMap]);

  // ═════════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════════

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Sparkles className="h-7 w-7 text-primary" />
            {t('smartImport.title')}
          </h1>
          <p className="text-muted-foreground">
            {t('smartImport.subtitle')}
          </p>
        </div>
        {step !== 'upload' && step !== 'done' && (
          <Button variant="outline" onClick={() => setShowCancelDialog(true)}>
            <XCircle className="h-4 w-4 mr-2" /> {t('smartImport.cancelImport')}
          </Button>
        )}
      </div>

      <Separator className="my-6" />

      {/* ─── Step Indicator ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-8">
        {[
          { key: 'upload', label: `1. ${t('smartImport.steps.upload')}` },
          { key: 'processing', label: `2. ${t('smartImport.steps.processing')}` },
          { key: 'review', label: `3. ${t('smartImport.steps.review')}` },
          { key: 'done', label: `4. ${t('smartImport.steps.done')}` },
        ].map(({ key, label }, idx) => {
          const isCurrent = step === key;
          const isPast =
            ['upload', 'processing', 'review', 'done'].indexOf(step) >
            ['upload', 'processing', 'review', 'done'].indexOf(key);
          return (
            <div key={key} className="flex items-center gap-2">
              {idx > 0 && <div className={`w-8 h-0.5 ${isPast ? 'bg-primary' : 'bg-muted'}`} />}
              <div
                className={`flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-full ${isCurrent
                  ? 'bg-primary text-primary-foreground'
                  : isPast
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                  }`}
              >
                {isPast ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
                {label}
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── STEP: Upload ───────────────────────────────────────────── */}
      {step === 'upload' && (
        <div className="space-y-6">
          {/* File picker */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('smartImport.selectFile')}</CardTitle>
              <CardDescription>{t('smartImport.selectFileDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                {selectedFile ? (
                  <p className="text-sm font-medium">{selectedFile.name} <span className="text-muted-foreground">({(selectedFile.size / 1024).toFixed(1)} KB)</span></p>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('smartImport.dropzone')}</p>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </div>

              {/* Detection result */}
              {detectAdapter.isPending && (
                <div className="flex items-center gap-2 mt-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t('smartImport.detectingFormat')}
                </div>
              )}

              {detectionResult && (
                <div className="mt-4">
                  {detectionResult.adapter ? (
                    <Alert>
                      <CheckCircle2 className="h-4 w-4" />
                      <AlertTitle>{t('smartImport.formatDetected', { name: detectionResult.adapter.name })}</AlertTitle>
                      <AlertDescription>
                        {t('smartImport.formatDetectedDesc', { name: detectionResult.adapter.name })}
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>{t('smartImport.unknownFormat')}</AlertTitle>
                      <AlertDescription className="space-y-3">
                        <p>
                          {t('smartImport.unknownFormatDesc')}{' '}
                          <code className="text-xs">{detectionResult.headers?.join(', ')}</code>
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-destructive/50 hover:bg-destructive/10"
                          onClick={() => {
                            setShowAdapterManager(true);
                            openCreateAdapterForm(detectionResult.headers?.join(', '));
                          }}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          {t('smartImport.createAdapterForFormat')}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Account selection */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('smartImport.destinationAccount')}</CardTitle>
              <CardDescription>
                {isNativeAdapterSelected
                  ? t('smartImport.destinationAccountNative')
                  : t('smartImport.destinationAccountDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Select
                value={selectedAccountId?.toString() ?? ''}
                onValueChange={(v) => setSelectedAccountId(v ? Number(v) : null)}
              >
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue placeholder={isNativeAdapterSelected ? t('smartImport.optionalFromCsv') : t('smartImport.selectAccount')} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((acc: Account) => (
                    <SelectItem key={acc.id} value={String(acc.id)}>
                      {acc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isNativeAdapterSelected && (
                <p className="text-xs text-muted-foreground mt-2">
                  {t('smartImport.nativeAccountHint')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Adapter Manager — collapsible */}
          <Card>
            <CardHeader className="cursor-pointer pb-3" onClick={() => setShowAdapterManager(v => !v)}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Settings2 className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base">{t('smartImport.importAdapters')}</CardTitle>
                  <Badge variant="secondary" className="text-xs">{adapters.length}</Badge>
                </div>
                <span className="text-xs text-muted-foreground">{showAdapterManager ? t('smartImport.hide') : t('smartImport.manage')}</span>
              </div>
            </CardHeader>
            {showAdapterManager && (
              <CardContent className="pt-0">
                <div className="space-y-2 mb-4">
                  {adapters.map((adapter: ImportAdapter) => {
                    const isGlobal = (adapter as ImportAdapter & { tenantId?: string }).tenantId === null || (adapter as ImportAdapter & { tenantId?: string }).tenantId === undefined;
                    return (
                      <div key={adapter.id} className="flex items-center justify-between px-3 py-2 rounded-md border bg-muted/30">
                        <div className="flex items-center gap-2 min-w-0">
                          {isGlobal ? (
                            <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          ) : (
                            <Settings2 className="h-3.5 w-3.5 text-primary shrink-0" />
                          )}
                          <span className="text-sm font-medium truncate">{adapter.name}</span>
                          {isGlobal && <Badge variant="outline" className="text-xs shrink-0">{t('smartImport.system')}</Badge>}
                          {(adapter as ImportAdapter & { matchSignature?: { isNative?: boolean } }).matchSignature?.isNative && (
                            <a
                              href="/templates/bliss-native-template.csv"
                              download="bliss-native-template.csv"
                              className="text-xs text-brand-primary underline flex items-center gap-1 shrink-0"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Download className="h-3 w-3" />
                              {t('smartImport.template')}
                            </a>
                          )}
                        </div>
                        {!isGlobal && (
                          <div className="flex gap-1 shrink-0">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditAdapterForm(adapter)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteAdapterMutation.mutate(adapter.id, { onSuccess: () => toast({ title: t('smartImport.toast.adapterDeleted') }), onError: (e: unknown) => toast({ title: t('smartImport.toast.deleteFailed'), description: (e as Error)?.message || 'Unknown error', variant: 'destructive' }) })}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {adapters.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-2">{t('smartImport.noAdapters')}</p>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => openCreateAdapterForm()}>
                  <Plus className="h-4 w-4 mr-2" /> {t('smartImport.newAdapter')}
                </Button>
              </CardContent>
            )}
          </Card>

          {/* Adapter Create/Edit Dialog */}
          <Dialog open={showAdapterForm} onOpenChange={setShowAdapterForm}>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" onPointerDownOutside={(e) => e.preventDefault()}>
              <DialogHeader>
                <DialogTitle>{editingAdapter ? t('smartImport.editAdapter') : t('smartImport.createAdapter')}</DialogTitle>
                <DialogDescription>{t('smartImport.adapterFormDesc')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-1">
                  <Label>{t('smartImport.form.name')} *</Label>
                  <Input value={adapterFormData.name} onChange={e => setAdapterFormData(p => ({ ...p, name: e.target.value }))} placeholder={t('smartImport.form.namePlaceholder')} />
                </div>
                <div className="space-y-1">
                  <Label>{t('smartImport.form.matchHeaders')} *</Label>
                  <Input value={adapterFormData.matchHeaders} onChange={e => setAdapterFormData(p => ({ ...p, matchHeaders: e.target.value }))} placeholder={t('smartImport.form.matchHeadersPlaceholder')} />
                  <p className="text-xs text-muted-foreground">{t('smartImport.form.matchHeadersHint')}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>{t('smartImport.form.dateColumn')} *</Label>
                    <Input value={adapterFormData.dateColumn} onChange={e => setAdapterFormData(p => ({ ...p, dateColumn: e.target.value }))} placeholder={t('smartImport.form.dateColumnPlaceholder')} />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('smartImport.form.descriptionColumn')} *</Label>
                    <Input value={adapterFormData.descriptionColumn} onChange={e => setAdapterFormData(p => ({ ...p, descriptionColumn: e.target.value }))} placeholder={t('smartImport.form.descriptionColumnPlaceholder')} />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>{t('smartImport.form.amountStrategy')} *</Label>
                  <Select value={adapterFormData.amountStrategy} onValueChange={v => setAdapterFormData(p => ({ ...p, amountStrategy: v as 'SINGLE_SIGNED' | 'DEBIT_CREDIT_COLUMNS' | 'AMOUNT_WITH_TYPE' }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SINGLE_SIGNED">{t('smartImport.form.singleSigned')}</SelectItem>
                      <SelectItem value="DEBIT_CREDIT_COLUMNS">{t('smartImport.form.debitCredit')}</SelectItem>
                      <SelectItem value="AMOUNT_WITH_TYPE">{t('smartImport.form.amountWithType')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {adapterFormData.amountStrategy === 'DEBIT_CREDIT_COLUMNS' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>{t('smartImport.form.debitColumn')} *</Label>
                      <Input value={adapterFormData.debitColumn} onChange={e => setAdapterFormData(p => ({ ...p, debitColumn: e.target.value }))} placeholder={t('smartImport.form.debitColumnPlaceholder')} />
                    </div>
                    <div className="space-y-1">
                      <Label>{t('smartImport.form.creditColumn')} *</Label>
                      <Input value={adapterFormData.creditColumn} onChange={e => setAdapterFormData(p => ({ ...p, creditColumn: e.target.value }))} placeholder={t('smartImport.form.creditColumnPlaceholder')} />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label>{t('smartImport.form.amountColumn')} *</Label>
                    <Input value={adapterFormData.amountColumn} onChange={e => setAdapterFormData(p => ({ ...p, amountColumn: e.target.value }))} placeholder={t('smartImport.form.amountColumnPlaceholder')} />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>{t('smartImport.form.dateFormat')}</Label>
                    <Input value={adapterFormData.dateFormat} onChange={e => setAdapterFormData(p => ({ ...p, dateFormat: e.target.value }))} placeholder="MM/DD/YYYY" />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('smartImport.form.defaultCurrency')}</Label>
                    <Input value={adapterFormData.currencyDefault} onChange={e => setAdapterFormData(p => ({ ...p, currencyDefault: e.target.value }))} placeholder="USD" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>{t('smartImport.form.skipRows')}</Label>
                  <Input type="number" min={0} value={adapterFormData.skipRows} onChange={e => setAdapterFormData(p => ({ ...p, skipRows: parseInt(e.target.value) || 0 }))} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowAdapterForm(false)}>{t('common.cancel')}</Button>
                <Button
                  onClick={handleSaveAdapter}
                  disabled={createAdapter.isPending || updateAdapterMutation.isPending}
                >
                  {(createAdapter.isPending || updateAdapterMutation.isPending) ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  {editingAdapter ? t('common.save_changes') : t('smartImport.createAdapter')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Upload button */}
          <div className="flex justify-end">
            <Button
              size="lg"
              onClick={handleUpload}
              disabled={!canUpload}
            >
              {uploadImport.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('smartImport.uploading')}
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" /> {t('smartImport.uploadAndProcess')}
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* ─── STEP: Processing ───────────────────────────────────────── */}
      {step === 'processing' && (() => {
        const pct = stagedData?.import?.progress ?? 0;
        return (
          <Card className="max-w-lg mx-auto">
            <CardHeader className="text-center">
              <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary mb-4" />
              <CardTitle>{t('smartImport.processingTitle')}</CardTitle>
              <CardDescription>
                {t('smartImport.processingDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Progress value={pct} className="w-full" />
              <p className="text-sm font-medium text-center mt-3">{t('smartImport.percentComplete', { pct })}</p>
              <p className="text-xs text-muted-foreground text-center mt-1">
                {selectedFile?.name} &middot; {accountsMap.get(selectedAccountId!)?.name ?? t('smartImport.unknownAccount')}
              </p>
            </CardContent>
          </Card>
        );
      })()}

      {/* ─── STEP: Quick Seed Interview ─────────────────────────────── */}
      {step === 'seed' && (() => {
        // Build cascading data: Type → Group[] and (Type, Group) → Category[]
        const typeSet = new Set<string>();
        const groupsByType: Record<string, string[]> = {};
        const catsByTypeGroup: Record<string, Record<string, Category[]>> = {};
        for (const cat of categories) {
          const t = cat.type;
          const g = cat.group ?? 'Other';
          typeSet.add(t);
          if (!catsByTypeGroup[t]) catsByTypeGroup[t] = {};
          if (!catsByTypeGroup[t][g]) catsByTypeGroup[t][g] = [];
          catsByTypeGroup[t][g].push(cat);
        }
        for (const t of typeSet) {
          groupsByType[t] = Object.keys(catsByTypeGroup[t] ?? {}).sort();
        }
        const sortedTypes = Array.from(typeSet).sort();

        return (
          <div className="max-w-4xl mx-auto space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-brand-primary" />
                  <CardTitle className="text-lg">{t('smartImport.quickClassify')}</CardTitle>
                </div>
                <CardDescription>
                  {t('smartImport.quickClassifyDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="max-h-[50vh] overflow-y-auto space-y-2 pr-1">
                  {seedInterviewData.map((seed) => {
                    const isExcluded = excludedSeeds.has(seed.normalizedDescription);
                    return (
                    <div
                      key={seed.normalizedDescription}
                      className={`flex items-center gap-3 p-3 border rounded-md bg-background transition-opacity ${isExcluded ? 'opacity-40' : ''}`}
                    >
                      {/* Description + count */}
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${isExcluded ? 'line-through text-muted-foreground' : ''}`}>{seed.description}</p>
                        <p className="text-xs text-muted-foreground">{seed.count}× transaction{seed.count !== 1 ? 's' : ''}</p>
                      </div>

                      {/* Cascading category selects: Type → Group → Category */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {/* Type select */}
                        <Select
                          disabled={isExcluded}
                          value={localSeedTypes[seed.normalizedDescription] ?? ''}
                          onValueChange={(val) => {
                            const key = seed.normalizedDescription;
                            setLocalSeedTypes((prev) => ({ ...prev, [key]: val }));
                            // Reset group & category when type changes
                            setLocalSeedGroups((prev) => { const next = { ...prev }; delete next[key]; return next; });
                            setLocalSeedCategories((prev) => { const next = { ...prev }; delete next[key]; return next; });
                          }}
                        >
                          <SelectTrigger className="h-7 text-[11px] w-[120px] px-2">
                            <SelectValue placeholder="Type" />
                          </SelectTrigger>
                          <SelectContent className="max-h-60 overflow-auto">
                            {sortedTypes.map((t) => (
                              <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {/* Group select — enabled when type is selected */}
                        <Select
                          disabled={isExcluded || !localSeedTypes[seed.normalizedDescription]}
                          value={localSeedGroups[seed.normalizedDescription] ?? ''}
                          onValueChange={(val) => {
                            const key = seed.normalizedDescription;
                            setLocalSeedGroups((prev) => ({ ...prev, [key]: val }));
                            // Reset category when group changes
                            setLocalSeedCategories((prev) => { const next = { ...prev }; delete next[key]; return next; });
                          }}
                        >
                          <SelectTrigger className="h-7 text-[11px] w-[120px] px-2">
                            <SelectValue placeholder="Group" />
                          </SelectTrigger>
                          <SelectContent className="max-h-60 overflow-auto">
                            {(groupsByType[localSeedTypes[seed.normalizedDescription]] ?? []).map((g) => (
                              <SelectItem key={g} value={g} className="text-xs">{g}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {/* Category select — enabled when group is selected */}
                        <Select
                          disabled={isExcluded || !localSeedGroups[seed.normalizedDescription]}
                          value={localSeedCategories[seed.normalizedDescription]?.toString() ?? ''}
                          onValueChange={(val) =>
                            setLocalSeedCategories((prev) => ({
                              ...prev,
                              [seed.normalizedDescription]: parseInt(val, 10),
                            }))
                          }
                        >
                          <SelectTrigger className="h-7 text-[11px] w-[120px] px-2">
                            <SelectValue placeholder="Category" />
                          </SelectTrigger>
                          <SelectContent className="max-h-60 overflow-auto">
                            {(catsByTypeGroup[localSeedTypes[seed.normalizedDescription]]?.[localSeedGroups[seed.normalizedDescription]] ?? []).map((cat) => (
                              <SelectItem key={cat.id} value={cat.id.toString()} className="text-xs">
                                {cat.icon ? `${cat.icon} ` : ''}{cat.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Confidence badge */}
                      {!isExcluded && (
                        <div className="flex-shrink-0">
                          <Badge
                            variant="outline"
                            className="text-xs bg-brand-primary/10 text-brand-primary border-brand-primary/20 whitespace-nowrap"
                          >
                            {seed.classificationSource === 'VECTOR_MATCH_GLOBAL' ? t('smartImport.seed.global') : seed.classificationSource === 'VECTOR_MATCH' ? t('smartImport.seed.match') : t('smartImport.source.ai')}{seed.aiConfidence != null ? ` ${Math.round(seed.aiConfidence * 100)}%` : ''}
                          </Badge>
                        </div>
                      )}

                      {/* Skip / restore toggle */}
                      <button
                        type="button"
                        onClick={() => setExcludedSeeds(prev => {
                          const next = new Set(prev);
                          if (next.has(seed.normalizedDescription)) {
                            next.delete(seed.normalizedDescription);
                          } else {
                            next.add(seed.normalizedDescription);
                          }
                          return next;
                        })}
                        className="flex-shrink-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title={isExcluded ? t('smartImport.seed.restore') : t('smartImport.seed.skipMerchant')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    );
                  })}
                </div>

                <Separator />

                <div className="flex justify-between items-center pt-1">
                  <Button variant="ghost" size="sm" onClick={handleImportSeedSkip} disabled={isConfirmingSeeds}>
                    {t('smartImport.skipForNow')}
                  </Button>
                  <Button size="sm" onClick={handleImportSeedConfirm} disabled={isConfirmingSeeds}>
                    {isConfirmingSeeds && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('smartImport.confirmAndContinue')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        );
      })()}

      {/* ─── STEP: Review ───────────────────────────────────────────── */}
      {step === 'review' && (
        <div className="space-y-4">
          {/* Import summary bar */}
          {importInfo && (() => {
            const summary = (importInfo as { statusSummary?: Record<string, number> }).statusSummary ?? {};
            const earliest = (importInfo as { earliestTransactionDate?: string }).earliestTransactionDate;
            const autoConfirmed = (importInfo as { autoConfirmedCount?: number }).autoConfirmedCount ?? 0;
            const updateCountVal = (importInfo as { updateCount?: number }).updateCount ?? 0;
            const pendingCount = summary['PENDING'] ?? 0;
            const duplicateCount = (summary['DUPLICATE'] ?? 0) + (summary['POTENTIAL_DUPLICATE'] ?? 0);
            const errorCount = importInfo.errorCount ?? 0;
            return (
              <Card>
                <CardContent className="py-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">{t('smartImport.review.file')}:</span>{' '}
                      <span className="font-medium">{importInfo.fileName}</span>
                    </div>
                    {importInfo.accountId && (
                      <div>
                        <span className="text-muted-foreground">{t('smartImport.review.account')}:</span>{' '}
                        <span className="font-medium">{accountsMap.get(importInfo.accountId)?.name ?? '-'}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground">{t('smartImport.review.total')}:</span>{' '}
                      <span className="font-medium">{t('smartImport.review.nRows', { count: importInfo.totalRows })}</span>
                    </div>
                    {earliest && (
                      <div>
                        <span className="text-muted-foreground">{t('smartImport.review.earliest')}:</span>{' '}
                        <span className="font-medium">{formatDate(earliest)}</span>
                      </div>
                    )}
                  </div>
                  {/* Status breakdown */}
                  <div className="flex flex-wrap gap-2">
                    {autoConfirmed > 0 && (
                      <Badge className="bg-positive/10 text-positive border-positive/20 hover:bg-positive/10">
                        {t('smartImport.review.autoConfirmed', { count: autoConfirmed })}
                      </Badge>
                    )}
                    {updateCountVal > 0 && (
                      <Badge className="bg-brand-primary/10 text-brand-primary border-brand-primary/20 hover:bg-brand-primary/10">
                        {t('smartImport.review.nUpdates', { count: updateCountVal })}
                      </Badge>
                    )}
                    {pendingCount > 0 && (
                      <Badge className="bg-warning/10 text-warning border-warning/20 hover:bg-warning/10">
                        {t('smartImport.review.pendingReview', { count: pendingCount })}
                      </Badge>
                    )}
                    {duplicateCount > 0 && (
                      <Badge className="bg-warning/10 text-warning border-warning/20 hover:bg-warning/10">
                        {t('smartImport.review.nDuplicates', { count: duplicateCount })}
                      </Badge>
                    )}
                    {errorCount > 0 && (
                      <Badge className="bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/10">
                        {t('smartImport.review.nErrors', { count: errorCount })}
                      </Badge>
                    )}
                    {importInfo.status === 'ERROR' && (
                      <Badge variant="destructive">
                        {(importInfo.errorDetails as { message?: string })?.message ?? t('smartImport.processingFailed')}
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Committing progress overlay */}
          {importInfo?.status === 'COMMITTING' && (
            <Card className="max-w-lg mx-auto text-center">
              <CardHeader>
                <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary mb-4" />
                <CardTitle>{t('smartImport.committingTitle')}</CardTitle>
                <CardDescription>
                  {t('smartImport.committingDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Progress value={importInfo.progress ?? 0} className="w-full" />
                <p className="text-sm font-medium text-center mt-3 text-muted-foreground">
                  {t('smartImport.percentComplete', { pct: importInfo.progress ?? 0 })}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Filter bar — hidden while committing */}
          {importInfo?.status !== 'COMMITTING' && <div className="flex flex-wrap items-center gap-3">
            <Label className="text-sm text-muted-foreground">{t('smartImport.review.filterByStatus')}:</Label>
            <Select value={reviewFilter} onValueChange={(v) => { setReviewFilter(v); setReviewPage(1); }}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('smartImport.filter.allRows')}</SelectItem>
                <SelectItem value="PENDING">{t('smartImport.status.pending')}</SelectItem>
                <SelectItem value="CONFIRMED">{t('smartImport.status.confirmed')}</SelectItem>
                <SelectItem value="DUPLICATE">{t('smartImport.status.duplicate')}</SelectItem>
                <SelectItem value="POTENTIAL_DUPLICATE">{t('smartImport.filter.possibleDuplicate')}</SelectItem>
                <SelectItem value="SKIPPED">{t('smartImport.status.skipped')}</SelectItem>
                <SelectItem value="ERROR">{t('smartImport.status.error')}</SelectItem>
              </SelectContent>
            </Select>
            <div className="ml-auto flex gap-1">
              <Button
                variant={viewMode === 'flat' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('flat')}
              >
                <LayoutList className="h-4 w-4 mr-1" /> {t('smartImport.review.flat')}
              </Button>
              <Button
                variant={viewMode === 'grouped' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('grouped')}
              >
                <FolderOpen className="h-4 w-4 mr-1" /> {t('smartImport.review.grouped')}
              </Button>
            </div>
          </div>}

          {/* Table — hidden while committing */}
          {importInfo?.status !== 'COMMITTING' && (<>
          {/* Table */}
          {stagedLoading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-10 bg-muted rounded" />
              {[...Array(8)].map((_, i) => <div key={i} className="h-14 bg-muted rounded" />)}
            </div>
          ) : stagedError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{t('smartImport.review.errorLoadingTitle')}</AlertTitle>
              <AlertDescription>{t('smartImport.review.errorLoadingDesc')}</AlertDescription>
            </Alert>
          ) : rows.length === 0 ? (
            <div className="bg-muted py-10 rounded-lg text-center">
              <h3 className="text-lg font-medium">{t('smartImport.review.noRowsFound')}</h3>
              <p className="text-muted-foreground mt-2">
                {reviewFilter !== 'all' ? t('smartImport.review.tryDifferentFilter') : t('smartImport.review.noRowsProduced')}
              </p>
            </div>
          ) : viewMode === 'grouped' ? (
            <div className="space-y-3">
              {groupedRows.map((group) => (
                <GroupCard
                  key={group.key}
                  categoryName={group.category?.name ?? t('review.uncategorized')}
                  items={group.items}
                  total={group.total}
                  onApprove={(item) => handleRowStatusChange(item.id, 'CONFIRMED')}
                  onSkip={(item) => handleRowStatusChange(item.id, 'SKIPPED')}
                  onApproveAll={() => {
                    const toConfirm = group.items.filter((i) =>
                      i.promotionStatus !== 'CONFIRMED' &&
                      i.promotionStatus !== 'DUPLICATE' &&
                      // POTENTIAL_DUPLICATE rows must be approved one-by-one
                      // via the drawer — bulk-approving would silently commit
                      // re-imported transactions the user never examined.
                      i.promotionStatus !== 'POTENTIAL_DUPLICATE' &&
                      i.promotionStatus !== 'SKIPPED' &&
                      !itemNeedsEnrichment(i, categoriesMap),
                    );
                    toConfirm.forEach((i) => handleRowStatusChange(i.id, 'CONFIRMED'));
                    // If a status filter is active, reset it so the confirmed
                    // rows stay visible in their groups rather than dropping
                    // out of the next fetch. See the toast-action path above
                    // and transaction-review's `clearStaleCategoryFilters`.
                    if (toConfirm.length > 0 && reviewFilter !== 'all') {
                      setReviewFilter('all');
                      setReviewPage(1);
                    }
                  }}
                  onItemClick={(item) => setDrawerItem(item)}
                  disabled={updateRow.isPending}
                  defaultExpanded={true}
                />
              ))}
            </div>
          ) : (
            <>
              <div className="rounded-md border divide-y">
                {reviewItems.map((item) => (
                  <TxDataRow
                    key={item.id}
                    item={item}
                    onApprove={() => handleRowStatusChange(item.id, 'CONFIRMED')}
                    onSkip={() => handleRowStatusChange(item.id, 'SKIPPED')}
                    onClick={() => setDrawerItem(item)}
                    disabled={updateRow.isPending}
                  />
                ))}
              </div>

              {/* Pagination */}
              <div className="flex justify-between items-center mt-4">
                <p className="text-sm text-muted-foreground">
                  {t('smartImport.review.pageOf', { current: reviewPage, total: totalPages })}
                  {pagination?.total ? ` (${t('smartImport.review.nRows', { count: pagination.total })})` : ''}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setReviewPage((p) => Math.max(1, p - 1))} disabled={reviewPage <= 1}>
                    <ChevronLeftIcon className="h-4 w-4 mr-1" /> {t('common.previous')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setReviewPage((p) => Math.min(totalPages, p + 1))} disabled={reviewPage >= totalPages}>
                    {t('common.next')} <ChevronRightIcon className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* Deep-Dive Drawer */}
          <DeepDiveDrawer
            item={drawerItem}
            categories={categories}
            accounts={accounts}
            onClose={() => setDrawerItem(null)}
            onSaveAndPromote={handleDrawerSave}
            onSkip={handleDrawerSkip}
            isSaving={updateRow.isPending}
          />

          </>)}

          {/* Commit / Cancel bar */}
          {importInfo?.status === 'READY' && (
            <div className="flex justify-between items-center pt-4 border-t">
              <Button variant="outline" onClick={() => setShowCancelDialog(true)}>
                <XCircle className="h-4 w-4 mr-2" /> {t('smartImport.cancelImport')}
              </Button>
              <Button
                size="lg"
                onClick={() => setShowCommitDialog(true)}
                disabled={commitImport.isPending}
              >
                {commitImport.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('smartImport.committing')}</>
                ) : (
                  <><CheckCircle2 className="h-4 w-4 mr-2" /> {t('smartImport.commitImport')}</>
                )}
              </Button>
            </div>
          )}

          {importInfo?.status === 'ERROR' && (
            <div className="flex justify-between items-center pt-4 border-t">
              <Alert variant="destructive" className="flex-1 mr-4">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{t('smartImport.importError')}</AlertTitle>
                <AlertDescription>
                  {importInfo?.errorDetails && typeof importInfo.errorDetails === 'object' && 'message' in importInfo.errorDetails
                    ? (importInfo.errorDetails as { message: string }).message
                    : t('smartImport.processingError')}
                </AlertDescription>
              </Alert>
              <Button variant="outline" onClick={handleReset}>
                <RotateCcw className="h-4 w-4 mr-2" /> {t('smartImport.startOver')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ─── STEP: Done ─────────────────────────────────────────────── */}
      {step === 'done' && (
        <Card className="max-w-lg mx-auto text-center">
          <CardHeader>
            <CheckCircle2 className="h-16 w-16 mx-auto text-positive mb-4" />
            <CardTitle>{t('smartImport.importComplete')}</CardTitle>
            <CardDescription>{t('smartImport.importCompleteDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {commitResult && (
              <div className="flex justify-center gap-6 text-sm">
                {commitResult.transactionCount > 0 && (
                  <div>
                    <span className="text-2xl font-bold text-positive">{commitResult.transactionCount}</span>
                    <p className="text-muted-foreground">{t('smartImport.done.created')}</p>
                  </div>
                )}
                {commitResult.updateCount > 0 && (
                  <div>
                    <span className="text-2xl font-bold text-brand-primary">{commitResult.updateCount}</span>
                    <p className="text-muted-foreground">{t('smartImport.done.updated')}</p>
                  </div>
                )}
                {commitResult.remaining > 0 && (
                  <div>
                    <span className="text-2xl font-bold text-warning">{commitResult.remaining}</span>
                    <p className="text-muted-foreground">{t('smartImport.done.remaining')}</p>
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-3 justify-center mt-4">
              <Button onClick={handleReset} variant="outline">
                <RotateCcw className="h-4 w-4 mr-2" /> {t('smartImport.importAnotherFile')}
              </Button>
              <Button onClick={() => navigate('/agents/review?source=imports')}>
                <ClipboardCheck className="h-4 w-4 mr-2" /> {t('smartImport.reviewInTransactionReview')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Confirm Commit Dialog ──────────────────────────────────── */}
      <Dialog open={showCommitDialog} onOpenChange={setShowCommitDialog}>
        <DialogContent onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('smartImport.commitImport')}</DialogTitle>
            <DialogDescription>
              {t('smartImport.commitDialogDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCommitDialog(false)}>
              {t('smartImport.goBack')}
            </Button>
            <Button onClick={handleCommit} disabled={commitImport.isPending}>
              {commitImport.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('smartImport.committing')}</>
              ) : (
                t('smartImport.yesCommit')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Confirm Cancel Dialog ──────────────────────────────────── */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('smartImport.cancelImport')}</DialogTitle>
            <DialogDescription>
              {t('smartImport.cancelDialogDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>
              {t('smartImport.goBack')}
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={cancelImport.isPending}>
              {cancelImport.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('smartImport.cancelling')}</>
              ) : (
                t('smartImport.yesCancelImport')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

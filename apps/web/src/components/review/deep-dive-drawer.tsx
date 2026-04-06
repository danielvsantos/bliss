import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertTriangle } from 'lucide-react';
import { StatusBadge } from './status-badge';
import { AIAnalysisPanel } from './ai-analysis-panel';
import { InvestmentEnrichmentForm } from './investment-enrichment-form';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ReviewItem } from './types';
import type { Category } from '@/types/api';

interface DeepDiveDrawerProps {
  item: ReviewItem | null;
  categories: Category[];
  accounts?: { id: number; name: string }[];
  onClose: () => void;
  onSaveAndPromote: (data: DrawerSaveData) => void;
  onSkip: () => void;
  isSaving?: boolean;
}

export interface DrawerSaveData {
  item: ReviewItem;
  categoryId: number | null;
  accountId: number | null;
  ticker: string;
  assetQuantity: string;
  assetPrice: string;
  details: string;
  // Ticker resolution metadata (Sprint 14)
  isin?: string;
  exchange?: string;
  assetCurrency?: string;
}

export function DeepDiveDrawer({
  item,
  categories,
  accounts,
  onClose,
  onSaveAndPromote,
  onSkip,
  isSaving,
}: DeepDiveDrawerProps) {
  const { t } = useTranslation();

  // ── Local form state ─────────────────────────────────────────────────
  const [drawerCategory, setDrawerCategory] = useState<number | null>(null);
  const [drawerAccountId, setDrawerAccountId] = useState<number | null>(null);
  const [ticker, setTicker] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [details, setDetails] = useState('');
  // Ticker resolution metadata (Sprint 14)
  const [tickerIsin, setTickerIsin] = useState('');
  const [tickerExchange, setTickerExchange] = useState('');
  const [tickerAssetCurrency, setTickerAssetCurrency] = useState('');

  // Reset state when item changes
  useEffect(() => {
    if (item) {
      setDrawerCategory(item.categoryId);
      setDrawerAccountId(item.originalImportRow?.accountId ?? null);
      // Use || to catch 0, "", and null/undefined — all treated as "no value".
      // Also validate ticker contains at least one letter (pure numeric like "0" is invalid).
      const rawTicker = item.originalImportRow?.ticker || item.originalPlaidTx?.ticker || '';
      setTicker(rawTicker && /[a-zA-Z]/.test(rawTicker) ? rawTicker : '');
      // For qty/price, explicitly filter out zero values (Prisma Decimal 0 is not meaningful pre-fill)
      const rawQty = item.originalImportRow?.assetQuantity ?? item.originalPlaidTx?.assetQuantity;
      setQty(rawQty != null && Number(rawQty) !== 0 ? String(rawQty) : '');
      const rawPrice = item.originalImportRow?.assetPrice ?? item.originalPlaidTx?.assetPrice;
      setPrice(rawPrice != null && Number(rawPrice) !== 0 ? String(rawPrice) : '');
      setDetails('');
      // Pre-fill ticker resolution metadata if available
      setTickerIsin(item.originalImportRow?.isin || '');
      setTickerExchange(item.originalImportRow?.exchange || '');
      setTickerAssetCurrency(item.originalImportRow?.assetCurrency || '');
    }
  }, [item]);

  if (!item) return null;

  // Dynamic investment enrichment detection
  const INVESTMENT_HINTS_MANDATORY = new Set(['API_STOCK', 'API_CRYPTO', 'API_FUND']);
  const INVESTMENT_HINTS_OPTIONAL = new Set(['MANUAL']);
  const selectedCat = categories.find((c) => c.id === drawerCategory);
  const isInvestmentCategory = selectedCat?.type === 'Investments';
  const processingHint = selectedCat?.processingHint ?? '';

  const showEnrichment =
    item.requiresEnrichment ||
    (isInvestmentCategory && (INVESTMENT_HINTS_MANDATORY.has(processingHint) || INVESTMENT_HINTS_OPTIONAL.has(processingHint)));

  // Enrichment is mandatory for API_STOCK / API_CRYPTO, optional for MANUAL
  const enrichmentMandatory =
    showEnrichment && INVESTMENT_HINTS_MANDATORY.has(processingHint);
  const enrichmentMissing =
    enrichmentMandatory && (!ticker.trim() || !qty.trim() || !price.trim());

  // Account is missing when it's an import row with no accountId
  const accountMissing = item.source === 'import' && !drawerAccountId;

  const isOpen = item !== null;
  const isIncome = item.amount < 0;
  const isAlreadyProcessed =
    item.promotionStatus === 'PROMOTED' ||
    item.promotionStatus === 'CONFIRMED' ||
    item.promotionStatus === 'SKIPPED';

  const handleSave = () => {
    onSaveAndPromote({
      item,
      categoryId: drawerCategory,
      accountId: drawerAccountId,
      ticker,
      assetQuantity: qty,
      assetPrice: price,
      details,
      isin: tickerIsin || undefined,
      exchange: tickerExchange || undefined,
      assetCurrency: tickerAssetCurrency || undefined,
    });
  };

  // Can't promote if mandatory enrichment is missing or account is missing (for non-already-processed)
  const saveDisabled = isSaving || enrichmentMissing || (accountMissing && !isAlreadyProcessed);

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        className="w-[min(480px,92vw)] p-0 flex flex-col"
      >
        {/* Header */}
        <SheetHeader className="px-6 pt-6 pb-4 space-y-3">
          <div>
            <SheetTitle className="text-lg">{item.merchant}</SheetTitle>
            <SheetDescription className="text-sm mt-1">
              {formatDate(item.date)} &middot;{' '}
              <span className={isIncome ? 'text-positive' : 'text-negative'}>
                {isIncome ? '+' : '-'}
                {formatCurrency(Math.abs(item.amount), item.currency)}
              </span>
            </SheetDescription>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Category selector */}
            <Select
              value={drawerCategory?.toString() ?? 'none'}
              onValueChange={(v) => {
                if (v !== 'none') setDrawerCategory(Number(v));
              }}
            >
              <SelectTrigger className="w-[180px] h-8 text-xs">
                <SelectValue placeholder={t('review.selectCategoryPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" disabled>
                  {t('review.uncategorized')}
                </SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id.toString()}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <StatusBadge status={item.status} />
          </div>
        </SheetHeader>

        <Separator />

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Account selector — shown for import rows, especially when account is unresolved */}
          {item.source === 'import' && accounts && accounts.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                {t('review.account')}
                {accountMissing && (
                  <Badge variant="outline" className="text-[10px] px-1 py-0 border-warning/30 text-warning">
                    <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                    {t('review.required')}
                  </Badge>
                )}
              </label>
              <Select
                value={drawerAccountId?.toString() ?? 'none'}
                onValueChange={(v) => {
                  if (v !== 'none') setDrawerAccountId(Number(v));
                }}
              >
                <SelectTrigger className={`w-full h-8 text-xs ${accountMissing ? 'border-warning/50' : ''}`}>
                  <SelectValue placeholder={t('review.selectAccount')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" disabled>
                    {t('review.noAccount')}
                  </SelectItem>
                  {accounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id.toString()}>
                      {acc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* AI Analysis */}
          <AIAnalysisPanel item={item} />

          {/* Investment Enrichment (conditional — dynamic based on selected category) */}
          {showEnrichment && (
            <>
              {enrichmentMandatory && enrichmentMissing && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-warning/10 border border-warning/20 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {t('review.investmentEnrichmentRequired')}
                </div>
              )}
              <InvestmentEnrichmentForm
                ticker={ticker}
                qty={qty}
                price={price}
                details={details}
                amount={Math.abs(item.amount)}
                searchType={processingHint === 'API_CRYPTO' ? 'crypto' : undefined}
                onTickerChange={setTicker}
                onQtyChange={setQty}
                onPriceChange={setPrice}
                onDetailsChange={setDetails}
                onTickerSelect={(result) => {
                  const isCrypto = processingHint === 'API_CRYPTO';
                  // Capture ticker resolution metadata from search result
                  setTickerExchange(result.mic_code || result.exchange || '');
                  // For crypto, use transaction currency (price pair determined by account, e.g. BTC/EUR)
                  setTickerAssetCurrency(isCrypto ? item.currency : (result.currency || ''));
                  // ISIN is not available from symbol_search — will be resolved server-side
                  setTickerIsin('');
                }}
              />
              {/* Currency mismatch warning — non-blocking since the transaction already exists */}
              {tickerAssetCurrency && tickerAssetCurrency !== item.currency && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-warning/10 border border-warning/20 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {t('review.currencyMismatch', { assetCurrency: tickerAssetCurrency, txCurrency: item.currency })}
                </div>
              )}
            </>
          )}

          {/* Details override for non-enrichment items */}
          {!showEnrichment && (
            <div className="space-y-1.5">
              <label htmlFor="drawer-details-simple" className="text-xs font-medium text-muted-foreground">
                {t('review.detailsNotes')}
              </label>
              <textarea
                id="drawer-details-simple"
                placeholder={t('review.optionalNotes')}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                className="w-full text-sm min-h-[60px] resize-none rounded-md border border-input bg-background px-3 py-2 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          )}
        </div>

        {/* Footer — always show save button */}
        <Separator />
        <SheetFooter className="px-6 py-4 flex-row justify-end gap-2">
          {!isAlreadyProcessed && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onSkip();
                onClose();
              }}
            >
              {t('review.skip')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saveDisabled}>
            {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {isAlreadyProcessed ? t('review.saveChanges') : t('review.saveAndPromote')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

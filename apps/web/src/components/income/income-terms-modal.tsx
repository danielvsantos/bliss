import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar as CalendarIcon, Loader2, Trash2, X } from 'lucide-react';
import { format, parse } from 'date-fns';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { useToast } from '@/hooks/use-toast';
import {
  useAssetIncomeTerms,
  useDeleteAssetIncomeTerms,
  useDeleteIncomeStream,
  useIncomeStreams,
  useSaveAssetIncomeTerms,
  useSaveIncomeStream,
} from '@/hooks/use-passive-income';
import {
  BOND_FREQUENCIES,
  BOND_TYPES,
  INCOME_TYPES_BY_CLASS,
  PERIODIC_FREQUENCIES,
  REFERENCE_INDICES,
  STREAM_FREQUENCIES,
  previewIncome,
  siblingsDiffer,
} from '@/lib/passive-income';
import { translateCategoryName } from '@/lib/category-i18n';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { IncomeAssetClass, IncomeStream, IncomeTerms, IncomeTermsSibling, IncomeType } from '@/types/passive-income';
import {
  collectErrors,
  emptyFormValues,
  formValuesFromTerms,
  toRequest,
  type IncomeTermsFormValues,
  type IncomeTermsMode,
} from './income-terms-schema';

export interface IncomeTermsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: IncomeTermsMode;
  /** asset mode: the portfolio item to edit */
  assetId?: number | null;
  /** asset mode: shown in the title (e.g. symbol) */
  assetLabel?: string;
  /** asset mode: current value (terms currency) for yield/interest previews */
  currentValue?: number;
  /** stream mode: the stream to edit (omit to create) */
  stream?: IncomeStream | null;
  /** stream mode: default currency for a new stream */
  defaultCurrency?: string;
  /**
   * asset mode (#83): 'symbol' edits every holding of the asset's symbol (a
   * group row on Passive Income); 'single' (default) edits one holding.
   */
  scope?: IncomeTermsScope;
  /** asset mode, single scope: pre-tick "apply to all holdings" (symbol held in >1 account). */
  defaultApplyToSymbol?: boolean;
}

export type IncomeTermsScope = 'single' | 'symbol';

type FieldName = keyof IncomeTermsFormValues;

const roundMoney = (n: number) => Math.round(n * 100) / 100;

/**
 * Income Terms modal (Passive Income #77). One component, two modes:
 *   - `asset`: the form adapts to the asset class (bond, real estate, cash,
 *     stock/ETF dividend override, fund/other yield) with a live preview.
 *   - `stream`: Allowance / Government Welfare income streams.
 * Full-screen sheet on mobile. Saving never starts a background job — the
 * projection is computed on read.
 */
export function IncomeTermsModal(props: IncomeTermsModalProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl max-sm:max-w-none max-sm:w-screen max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:rounded-none max-sm:border-0 max-sm:p-4"
        data-testid="income-terms-modal"
      >
        {open && <IncomeTermsModalBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

/** Holds which holding / scope is being edited: the Mixed step can switch to one account. */
function IncomeTermsModalBody(props: IncomeTermsModalProps) {
  const [target, setTarget] = useState({
    assetId: props.assetId ?? null,
    scope: props.scope ?? 'single',
    label: props.assetLabel,
  });
  return (
    <IncomeTermsForm
      key={`${target.assetId}-${target.scope}`}
      {...props}
      assetId={target.assetId}
      scope={target.scope}
      assetLabel={target.label}
      onEditOne={(sibling, symbol) => setTarget({
        assetId: sibling.assetId,
        scope: 'single',
        label: sibling.accountName ? `${symbol} · ${sibling.accountName}` : symbol,
      })}
    />
  );
}

function IncomeTermsForm({
  onOpenChange,
  mode,
  assetId = null,
  assetLabel,
  currentValue,
  stream,
  defaultCurrency,
  scope = 'single',
  defaultApplyToSymbol = false,
  onEditOne,
}: IncomeTermsModalProps & { onEditOne: (sibling: IncomeTermsSibling, symbol: string) => void }) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const locale = i18n.language || 'en-US';

  const assetQuery = useAssetIncomeTerms(mode === 'asset' ? assetId : null);
  const streamsQuery = useIncomeStreams(mode === 'stream');
  const saveAsset = useSaveAssetIncomeTerms();
  const deleteAsset = useDeleteAssetIncomeTerms();
  const saveStream = useSaveIncomeStream();
  const deleteStream = useDeleteIncomeStream();

  const assetInfo = assetQuery.data?.asset;
  const assetClass: IncomeAssetClass | null = mode === 'asset' ? assetInfo?.assetClass ?? null : null;
  const isEquity = assetClass === 'STOCK' || assetClass === 'ETF';
  const existingTerms = mode === 'asset' ? assetQuery.data?.terms ?? null : stream ?? null;
  const auto = assetQuery.data?.auto ?? null;

  // Group editing (#83): every holding of this symbol and asset class. Cash
  // interest (APY) always stays per account.
  const siblings = useMemo(() => assetQuery.data?.siblings ?? [], [assetQuery.data?.siblings]);
  const groupable = mode === 'asset' && assetClass !== null && assetClass !== 'CASH' && siblings.length > 1;
  const symbolScope = scope === 'symbol' && groupable;
  const needsMixedStep = symbolScope && siblingsDiffer(siblings);
  const [mixedResolved, setMixedResolved] = useState(false);
  const [prefillFrom, setPrefillFrom] = useState<number | null>(null);
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);
  const symbol = assetInfo?.symbol ?? '';
  const groupUnits = siblings.reduce((sum, s) => sum + (s.quantity > 0 ? s.quantity : 0), 0);

  const [values, setValues] = useState<IncomeTermsFormValues | null>(null);
  // Bonds are entered as a TOTAL face value (what the user sees on their
  // statement); IncomeTerms stores it per unit so partial sells scale it.
  // Manual holdings without a quantity are 1 unit, so per-unit alone was misleading.
  const [faceTotal, setFaceTotal] = useState('');
  const unitsHeld = assetInfo?.quantity && assetInfo.quantity > 0 ? assetInfo.quantity : 1;
  const [override, setOverride] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Asset form values from stored terms (this holding's, or — in the Mixed
  // step — the account the user picked to pre-fill from).
  const initAsset = (terms: IncomeTerms | null) => {
    if (!assetQuery.data) return;
    const fallbackType: IncomeType = assetQuery.data.asset.defaultIncomeType
      ?? (assetClass ? INCOME_TYPES_BY_CLASS[assetClass][0] : 'CUSTOM_YIELD');
    const qty = assetQuery.data.asset.quantity > 0 ? assetQuery.data.asset.quantity : 1;
    const applyToSymbol = symbolScope || (groupable && defaultApplyToSymbol);
    if (terms) {
      const init = formValuesFromTerms(terms, 'asset');
      if (terms.incomeType === 'NONE') init.incomeType = fallbackType;
      init.applyToSymbol = applyToSymbol;
      setValues(init);
      setOverride(terms.incomeType === 'DIVIDEND' && terms.dividendPerUnit != null);
      if (terms.faceValuePerUnit != null) setFaceTotal(String(roundMoney(terms.faceValuePerUnit * qty)));
    } else {
      const init = emptyFormValues('asset', fallbackType);
      init.applyToSymbol = applyToSymbol;
      // Default a bond's face value to what was paid for it.
      const cost = symbolScope
        ? siblings.reduce((sum, s) => sum + (s.costBasis ?? 0), 0)
        : assetQuery.data.asset.costBasis;
      const units = symbolScope ? (groupUnits > 0 ? groupUnits : 1) : qty;
      if (assetClass === 'BOND' && cost != null && cost > 0) {
        init.faceValuePerUnit = String(cost / units);
        setFaceTotal(String(roundMoney(symbolScope ? (cost / units) * qty : cost)));
      }
      setValues(init);
    }
  };

  // Initialise once the data the form depends on is available.
  useEffect(() => {
    if (values) return;
    if (mode === 'stream') {
      const init = stream
        ? formValuesFromTerms(stream, 'stream')
        : { ...emptyFormValues('stream', 'FIXED_AMOUNT'), currency: defaultCurrency || '' };
      setValues(init);
      return;
    }
    if (!assetQuery.data) return;
    // A Mixed group asks which account's terms to start from first (R4.2).
    if (needsMixedStep && !mixedResolved) return;
    initAsset(assetQuery.data.terms);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initAsset reads the same inputs
  }, [mode, stream, defaultCurrency, assetQuery.data, assetClass, values, needsMixedStep, mixedResolved]);

  const pickedSibling = siblings.find((s) => s.assetId === prefillFrom)
    ?? siblings.find((s) => s.terms)
    ?? siblings[0];

  const useSameForAll = () => {
    setMixedResolved(true);
    initAsset(pickedSibling?.terms ?? null);
  };

  const setFaceTotalValue = (raw: string) => {
    setFaceTotal(raw);
    const n = Number(raw);
    set('faceValuePerUnit', raw === '' || !Number.isFinite(n) ? raw : String(n / unitsHeld));
  };

  const set = (field: FieldName, value: string | boolean) => {
    setValues((prev) => (prev ? { ...prev, [field]: value } : prev));
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const typeOptions: IncomeType[] = mode === 'stream'
    ? ['FIXED_AMOUNT']
    : assetClass ? INCOME_TYPES_BY_CLASS[assetClass] : [];

  const preview = useMemo(() => {
    if (!values) return null;
    if (isEquity && !override && values.isDistributing !== false) return null;
    return previewIncome(
      { ...values, incomeType: values.incomeType },
      { quantity: symbolScope ? groupUnits : assetInfo?.quantity ?? 0, currentValue },
    );
  }, [values, isEquity, override, assetInfo?.quantity, currentValue, symbolScope, groupUnits]);

  const applyAll = mode === 'asset' && groupable && values?.applyToSymbol === true;
  const anySiblingTerms = siblings.some((s) => s.terms);

  const currency = values?.currency || assetInfo?.currency || defaultCurrency || 'USD';
  const busy = saveAsset.isPending || saveStream.isPending || deleteAsset.isPending || deleteStream.isPending;

  const close = () => onOpenChange(false);

  const handleSave = async () => {
    if (!values) return;
    // Stocks/ETFs without an override and still distributing → automatic data.
    if (mode === 'asset' && isEquity && !override && values.isDistributing !== false) {
      if ((existingTerms || (applyAll && anySiblingTerms)) && assetId != null) {
        try {
          await deleteAsset.mutateAsync(applyAll ? { assetId, applyToSymbol: true } : assetId);
        } catch {
          toast({ title: t('common.error'), description: t('incomeTerms.saveFailed'), variant: 'destructive' });
          return;
        }
      }
      toast({ title: t('incomeTerms.saved') });
      close();
      return;
    }

    const found = collectErrors(values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    try {
      if (mode === 'asset' && assetId != null) {
        await saveAsset.mutateAsync({ assetId, body: toRequest(values) });
      } else if (mode === 'stream') {
        await saveStream.mutateAsync({ id: stream?.id ?? null, body: toRequest(values) });
      }
      toast({ title: t('incomeTerms.saved') });
      close();
    } catch {
      toast({ title: t('common.error'), description: t('incomeTerms.saveFailed'), variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    // Removing from every holding of the symbol asks first (R4.4).
    if (applyAll && !confirmRemoveAll) {
      setConfirmRemoveAll(true);
      return;
    }
    setConfirmRemoveAll(false);
    try {
      if (mode === 'asset' && assetId != null) {
        await deleteAsset.mutateAsync(applyAll ? { assetId, applyToSymbol: true } : assetId);
      }
      else if (mode === 'stream' && stream) await deleteStream.mutateAsync(stream.id);
      toast({ title: t('incomeTerms.deleted') });
      close();
    } catch {
      toast({ title: t('common.error'), description: t('incomeTerms.saveFailed'), variant: 'destructive' });
    }
  };

  const title = mode === 'stream'
    ? (stream ? t('incomeTerms.editStreamTitle') : t('incomeTerms.addStreamTitle'))
    : symbolScope
      ? t('incomeTerms.groupTitle', { name: assetLabel || symbol, count: siblings.length })
      : t('incomeTerms.title', { name: assetLabel || assetInfo?.symbol || '' });

  const showMixedStep = needsMixedStep && !mixedResolved;

  /** One-line summary of a holding's current terms for the Mixed step ("Override $3.00"). */
  const siblingSummary = (s: IncomeTermsSibling) => {
    const source = t(`passiveIncome.source.${s.source}`);
    const terms = s.terms;
    if (!terms) return source;
    if (terms.isDistributing === false || terms.incomeType === 'NONE') return t('passiveIncome.incomeType.NONE');
    const ccy = terms.currency || s.currency;
    const pctText = (v: number | null) => (v == null ? null : `${v}%`);
    let detail: string | null = null;
    if (terms.dividendPerUnit != null) detail = formatCurrency(terms.dividendPerUnit, ccy, locale, { maximumFractionDigits: 4 });
    else if (terms.monthlyRent != null) detail = formatCurrency(terms.monthlyRent, ccy, locale);
    else if (BOND_TYPES.includes(terms.incomeType)) detail = pctText(terms.couponRate ?? terms.assumedIndexRate);
    else detail = pctText(terms.yieldPct);
    const freqText = terms.frequency ? t(`passiveIncome.frequency.${terms.frequency}`) : null;
    return [source, detail, freqText].filter(Boolean).join(' · ');
  };

  const loading = mode === 'asset' ? assetQuery.isLoading : streamsQuery.isLoading;
  const formLoading = loading || (!values && !showMixedStep);

  // ── Field helpers ───────────────────────────────────────────────────────
  const fieldError = (field: string) =>
    errors[field] ? <p className="text-destructive text-xs mt-1">{t(errors[field])}</p> : null;

  const numberField = ({ field, label, suffix, step = 'any' }: { field: FieldName; label: string; suffix?: string; step?: string }) => (
    <div className="space-y-1.5">
      <Label htmlFor={`it-${field}`}>{label}</Label>
      <div className="relative">
        <Input
          id={`it-${field}`}
          type="number"
          inputMode="decimal"
          step={step}
          value={(values?.[field] as string) ?? ''}
          onChange={(e) => set(field, e.target.value)}
          className={suffix ? 'pr-12' : undefined}
          aria-invalid={Boolean(errors[field])}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>
        )}
      </div>
      {fieldError(field)}
    </div>
  );

  // Same Popover + Calendar picker as the rest of the app (e.g. transaction filters).
  const dateField = ({ field, label }: { field: FieldName; label: string }) => {
    const raw = (values?.[field] as string) || '';
    const selected = raw ? parse(raw, 'yyyy-MM-dd', new Date()) : undefined;
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`it-${field}`}>{label}</Label>
        <div className="flex gap-1">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                id={`it-${field}`}
                type="button"
                variant="outline"
                className="flex-1 justify-start text-left font-normal"
                aria-invalid={Boolean(errors[field])}
              >
                <CalendarIcon className="mr-2 h-4 w-4 opacity-60" />
                {selected ? format(selected, 'MMM d, yyyy') : <span className="text-muted-foreground">{t('incomeTerms.pickDate')}</span>}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                captionLayout="dropdown-buttons"
                fromYear={1990}
                toYear={new Date().getFullYear() + 50}
                selected={selected}
                defaultMonth={selected}
                onSelect={(date) => set(field, date ? format(date, 'yyyy-MM-dd') : '')}
                initialFocus
              />
            </PopoverContent>
          </Popover>
          {raw && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label={t('incomeTerms.clearDate')}
              onClick={() => set(field, '')}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        {fieldError(field)}
      </div>
    );
  };

  const selectField = ({
    field, label, options, allowEmpty = false,
  }: { field: FieldName; label: string; options: { value: string; label: string }[]; allowEmpty?: boolean }) => (
    <div className="space-y-1.5">
      <Label htmlFor={`it-${field}`}>{label}</Label>
      <Select
        value={(values?.[field] as string) || (allowEmpty ? '__none' : undefined)}
        onValueChange={(v) => set(field, v === '__none' ? '' : v)}
      >
        <SelectTrigger id={`it-${field}`} aria-invalid={Boolean(errors[field])}>
          <SelectValue placeholder={t('incomeTerms.select')} />
        </SelectTrigger>
        <SelectContent>
          {allowEmpty && <SelectItem value="__none">{t('incomeTerms.none')}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {fieldError(field)}
    </div>
  );

  const freqOptions = (list: string[]) => list.map((f) => ({ value: f, label: t(`passiveIncome.frequency.${f}`) }));

  // ── Type-specific fields ────────────────────────────────────────────────
  const renderTypeFields = () => {
    if (!values) return null;
    const type = values.incomeType;
    if (BOND_TYPES.includes(type)) {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {selectField({ field: 'issuerType', label: t('incomeTerms.fields.issuerType'), allowEmpty: true, options: [
              { value: 'GOVERNMENT', label: t('incomeTerms.issuer.GOVERNMENT') },
              { value: 'CORPORATE', label: t('incomeTerms.issuer.CORPORATE') },
            ] })}
          {symbolScope ? (
            <div className="space-y-1.5">
              <Label htmlFor="it-faceValuePerUnit">{t('incomeTerms.fields.faceValuePerUnit')}</Label>
              <div className="relative">
                <Input
                  id="it-faceValuePerUnit"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={values.faceValuePerUnit ?? ''}
                  onChange={(e) => set('faceValuePerUnit', e.target.value)}
                  className="pr-12"
                  aria-invalid={Boolean(errors.faceValuePerUnit)}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{currency}</span>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="face-value-hint">
                {t('incomeTerms.faceValuePerUnitGroupHint', {
                  count: siblings.length,
                  units: groupUnits.toLocaleString(locale, { maximumFractionDigits: 4 }),
                  total: values.faceValuePerUnit
                    ? formatCurrency(Number(values.faceValuePerUnit) * groupUnits, currency, locale, { maximumFractionDigits: 2 })
                    : '—',
                })}
              </p>
              {fieldError('faceValuePerUnit')}
            </div>
          ) : (
          <div className="space-y-1.5">
            <Label htmlFor="it-faceTotal">{t('incomeTerms.fields.faceValueTotal')}</Label>
            <div className="relative">
              <Input
                id="it-faceTotal"
                type="number"
                inputMode="decimal"
                step="any"
                value={faceTotal}
                onChange={(e) => setFaceTotalValue(e.target.value)}
                className="pr-12"
                aria-invalid={Boolean(errors.faceValuePerUnit)}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{currency}</span>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="face-value-hint">
              {t('incomeTerms.faceValueHint', {
                count: unitsHeld,
                units: unitsHeld.toLocaleString(locale, { maximumFractionDigits: 4 }),
                perUnit: values?.faceValuePerUnit
                  ? formatCurrency(Number(values.faceValuePerUnit), currency, locale, { maximumFractionDigits: 2 })
                  : '—',
              })}
            </p>
            {fieldError('faceValuePerUnit')}
          </div>
          )}
          {type !== 'FLOATING_COUPON' && (
            numberField({ field: 'couponRate', label: type === 'INFLATION_LINKED' ? t('incomeTerms.fields.realCoupon') : t('incomeTerms.fields.couponRate'), suffix: '%' })
          )}
          {type !== 'FIXED_COUPON' && (
            <>
              {selectField({ field: 'referenceIndex', label: t('incomeTerms.fields.referenceIndex'), allowEmpty: true, options: REFERENCE_INDICES.map((r) => ({ value: r, label: r === 'OTHER' ? t('incomeTerms.otherIndex') : r })) })}
              {numberField({ field: 'assumedIndexRate', label: t('incomeTerms.fields.assumedIndexRate'), suffix: '%' })}
            </>
          )}
          {type === 'FLOATING_COUPON' && numberField({ field: 'spread', label: t('incomeTerms.fields.spread'), suffix: '%' })}
          {selectField({ field: 'frequency', label: t('incomeTerms.fields.frequency'), options: freqOptions(BOND_FREQUENCIES) })}
          {dateField({ field: 'maturityDate', label: t('incomeTerms.fields.maturityDate') })}
          {dateField({ field: 'anchorPaymentDate', label: t('incomeTerms.fields.anchorPaymentDate') })}
        </div>
      );
    }
    switch (type) {
      case 'RENT':
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {numberField({ field: 'monthlyRent', label: t('incomeTerms.fields.monthlyRent'), suffix: currency })}
            {numberField({ field: 'annualIndexationPct', label: t('incomeTerms.fields.annualIndexationPct'), suffix: '%' })}
            {dateField({ field: 'startDate', label: t('incomeTerms.fields.leaseStart') })}
            {dateField({ field: 'leaseEndDate', label: t('incomeTerms.fields.leaseEndDate') })}
            <p className="sm:col-span-2 text-xs text-muted-foreground">{t('incomeTerms.netRentHint')}</p>
          </div>
        );
      case 'INTEREST':
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {numberField({ field: 'apyPct', label: t('incomeTerms.fields.apyPct'), suffix: '%' })}
          </div>
        );
      case 'CUSTOM_YIELD':
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {numberField({ field: 'yieldPct', label: t('incomeTerms.fields.yieldPct'), suffix: '%' })}
            {selectField({ field: 'frequency', label: t('incomeTerms.fields.frequency'), allowEmpty: true, options: freqOptions(PERIODIC_FREQUENCIES) })}
          </div>
        );
      case 'DIVIDEND':
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {numberField({ field: 'dividendPerUnit', label: t('incomeTerms.fields.dividendPerUnit'), suffix: currency })}
            {!isEquity && numberField({ field: 'yieldPct', label: t('incomeTerms.fields.orYieldPct'), suffix: '%' })}
            {selectField({ field: 'frequency', label: t('incomeTerms.fields.frequency'), allowEmpty: true, options: freqOptions(PERIODIC_FREQUENCIES) })}
            {dateField({ field: 'anchorPaymentDate', label: t('incomeTerms.fields.anchorPaymentDate') })}
          </div>
        );
      case 'FIXED_AMOUNT': {
        const categories = streamsQuery.data?.eligibleCategories ?? [];
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="it-name">{t('incomeTerms.fields.name')}</Label>
              <Input
                id="it-name"
                value={values.name ?? ''}
                maxLength={100}
                placeholder={t('incomeTerms.namePlaceholder')}
                onChange={(e) => set('name', e.target.value)}
                aria-invalid={Boolean(errors.name)}
              />
              {fieldError('name')}
            </div>
            {selectField({ field: 'categoryId', label: t('incomeTerms.fields.category'), options: categories.map((c) => ({
                value: String(c.id),
                label: translateCategoryName(t, { name: c.name, defaultCategoryCode: c.defaultCategoryCode }),
              })) })}
            {numberField({ field: 'amountPerPayment', label: t('incomeTerms.fields.amountPerPayment'), suffix: values.currency || '' })}
            {selectField({ field: 'frequency', label: t('incomeTerms.fields.frequency'), options: freqOptions(STREAM_FREQUENCIES) })}
            <div className="space-y-1.5">
              <Label htmlFor="it-currency">{t('incomeTerms.fields.currency')}</Label>
              <Input
                id="it-currency"
                value={values.currency ?? ''}
                maxLength={3}
                onChange={(e) => set('currency', e.target.value.toUpperCase())}
                aria-invalid={Boolean(errors.currency)}
              />
              {fieldError('currency')}
            </div>
            {dateField({ field: 'startDate', label: t('incomeTerms.fields.startDate') })}
            {dateField({ field: 'endDate', label: t('incomeTerms.fields.endDate') })}
            {dateField({ field: 'anchorPaymentDate', label: t('incomeTerms.fields.anchorPaymentDate') })}
            {numberField({ field: 'annualIndexationPct', label: t('incomeTerms.fields.annualIndexationPct'), suffix: '%' })}
          </div>
        );
      }
      default:
        return null;
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 min-h-0">
      <DialogHeader>
        <DialogTitle className="pr-8 break-words">{title}</DialogTitle>
        <DialogDescription>
          {mode === 'stream' ? t('incomeTerms.streamDescription') : t('incomeTerms.assetDescription')}
        </DialogDescription>
      </DialogHeader>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t('common.loading')} />
        </div>
      ) : showMixedStep ? (
        <div className="space-y-4" data-testid="mixed-step">
          <div className="rounded-md border border-warning/20 bg-warning/10 p-3">
            <p className="text-sm font-medium text-brand-deep">{t('incomeTerms.mixedTitle')}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t('incomeTerms.mixedDescription', { symbol })}</p>
          </div>
          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200" data-testid="mixed-siblings">
            {siblings.map((s) => (
              <li key={s.assetId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="text-brand-deep truncate">{s.accountName ?? symbol}</span>
                <span className="text-xs text-muted-foreground text-right">{siblingSummary(s)}</span>
              </li>
            ))}
          </ul>
          <div className="space-y-1.5">
            <Label htmlFor="it-mixed-account">{t('incomeTerms.mixedAccount')}</Label>
            <Select value={pickedSibling ? String(pickedSibling.assetId) : undefined} onValueChange={(v) => setPrefillFrom(Number(v))}>
              <SelectTrigger id="it-mixed-account">
                <SelectValue placeholder={t('incomeTerms.select')} />
              </SelectTrigger>
              <SelectContent>
                {siblings.map((s) => (
                  <SelectItem key={s.assetId} value={String(s.assetId)}>{s.accountName ?? symbol}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button type="button" className="flex-1" onClick={useSameForAll}>
              {t('incomeTerms.mixedUseSame')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => pickedSibling && onEditOne(pickedSibling, symbol)}
            >
              {t('incomeTerms.mixedEditOne')}
            </Button>
          </div>
        </div>
      ) : formLoading || !values ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t('common.loading')} />
        </div>
      ) : mode === 'asset' && !assetClass ? (
        <p className="text-sm text-muted-foreground">{t('incomeTerms.notIncomeCapable')}</p>
      ) : (
        <div className="space-y-4">
          {isEquity && (
            <div className="rounded-md border border-gray-200 p-3 space-y-2 bg-accent/30" data-testid="auto-dividends">
              <p className="text-sm font-medium text-brand-deep">{t('incomeTerms.autoTitle')}</p>
              {auto ? (
                auto.recentDividends.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('incomeTerms.autoNone')}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('incomeTerms.autoSummary', {
                      count: auto.recentDividends.length,
                      frequency: t(`passiveIncome.frequency.${auto.frequency}`),
                      amount: auto.annualDividend != null
                        ? formatCurrency(auto.annualDividend, auto.currency || currency, locale, { maximumFractionDigits: 4 })
                        : '—',
                      date: formatDate(auto.recentDividends[0].exDate, undefined, locale),
                    })}
                  </p>
                )
              ) : (
                <p className="text-xs text-muted-foreground">{t('incomeTerms.autoUnavailable')}</p>
              )}
              <div className="flex items-center gap-2 pt-1">
                <Switch
                  id="it-override"
                  checked={override}
                  disabled={values.isDistributing === false}
                  onCheckedChange={(v) => setOverride(v)}
                />
                <Label htmlFor="it-override" className="text-sm">{t('incomeTerms.override')}</Label>
              </div>
            </div>
          )}

          {mode === 'asset' && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="it-not-distributing"
                checked={values.isDistributing === false}
                onCheckedChange={(v) => set('isDistributing', v !== true)}
              />
              <Label htmlFor="it-not-distributing" className="text-sm">{t('incomeTerms.notDistributing')}</Label>
            </div>
          )}

          {values.isDistributing !== false && (!isEquity || override) && (
            <>
              {typeOptions.length > 1 && (
                selectField({ field: 'incomeType', label: t('incomeTerms.fields.incomeType'), options: typeOptions.map((ty) => ({ value: ty, label: t(`passiveIncome.incomeType.${ty}`) })) })
              )}
              {renderTypeFields()}
            </>
          )}

          {symbolScope ? (
            <p className="text-xs text-muted-foreground" data-testid="applies-to-holdings">
              {t('incomeTerms.appliesToHoldings', { count: siblings.length, symbol })}
            </p>
          ) : groupable && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="it-apply-symbol"
                checked={values.applyToSymbol === true}
                onCheckedChange={(v) => set('applyToSymbol', v === true)}
              />
              <Label htmlFor="it-apply-symbol" className="text-sm">
                {t('incomeTerms.applyToAllHoldings', { count: siblings.length, symbol })}
              </Label>
            </div>
          )}

          {preview && preview.annual > 0 && (
            <p className="text-sm text-brand-deep bg-brand-primary/10 border border-brand-primary/20 rounded-md px-3 py-2" data-testid="income-preview">
              {[
                t('incomeTerms.previewAnnual', { amount: formatCurrency(preview.annual, currency, locale, { maximumFractionDigits: 0 }) }),
                preview.nextPayment ? t('incomeTerms.previewNext', { date: formatDate(preview.nextPayment, { day: 'numeric', month: 'short' }, locale) }) : null,
                preview.endDate ? t('incomeTerms.previewEnds', { year: preview.endDate.slice(0, 4) }) : null,
              ].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      )}

      <DialogFooter className="gap-2 sm:gap-2 max-sm:mt-auto max-sm:flex-col-reverse">
        {!showMixedStep && (applyAll ? anySiblingTerms : existingTerms) && (
          <Button
            type="button"
            variant="outline"
            className="text-destructive sm:mr-auto"
            onClick={handleDelete}
            disabled={busy}
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            {mode === 'stream' ? t('incomeTerms.deleteStream') : t('incomeTerms.removeTerms')}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={close} disabled={busy}>{t('common.cancel')}</Button>
        {!showMixedStep && (
          <Button type="button" onClick={handleSave} disabled={busy || !values || (mode === 'asset' && !assetClass)}>
            {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {t('common.save')}
          </Button>
        )}
      </DialogFooter>

      <AlertDialog open={confirmRemoveAll} onOpenChange={setConfirmRemoveAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('incomeTerms.removeTerms')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('incomeTerms.removeFromAllConfirm', { count: siblings.length, symbol })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('incomeTerms.removeTerms')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

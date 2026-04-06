import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { AlertTriangle } from 'lucide-react';
import { useTickerSearch, type TickerResult } from '@/hooks/use-ticker-search';

interface InvestmentEnrichmentFormProps {
  ticker: string;
  qty: string;
  price: string;
  details: string;
  amount: number; // Absolute transaction amount for auto-calculating quantity
  /** 'crypto' routes ticker search to Twelve Data crypto pairs; omit for stocks/funds */
  searchType?: string;
  onTickerChange: (value: string) => void;
  onQtyChange: (value: string) => void;
  onPriceChange: (value: string) => void;
  onDetailsChange: (value: string) => void;
  onTickerSelect?: (result: TickerResult) => void;
}

export function InvestmentEnrichmentForm({
  ticker,
  qty,
  price,
  details,
  amount,
  searchType,
  onTickerChange,
  onQtyChange,
  onPriceChange,
  onDetailsChange,
  onTickerSelect,
}: InvestmentEnrichmentFormProps) {
  const { t } = useTranslation();

  // Auto-calculate quantity when price changes (same pattern as transaction-form.tsx)
  const priceNum = parseFloat(price);
  const isAutoCalc = !!(amount && priceNum && priceNum > 0);

  useEffect(() => {
    if (isAutoCalc) {
      const calculatedQty = amount / priceNum;
      // Round to 8 decimal places to avoid floating-point noise
      onQtyChange(parseFloat(calculatedQty.toFixed(8)).toString());
    }
  }, [amount, priceNum, isAutoCalc, onQtyChange]);

  // Ticker autocomplete state
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchInput, setSearchInput] = useState(ticker);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { data: results = [] } = useTickerSearch(searchInput, searchType);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleTickerInput = (value: string) => {
    const upper = value.toUpperCase();
    setSearchInput(upper);
    onTickerChange(upper);
    setShowDropdown(upper.length >= 2);
  };

  const handleSelectResult = (result: TickerResult) => {
    onTickerChange(result.symbol);
    setSearchInput(result.symbol);
    setShowDropdown(false);
    onTickerSelect?.(result);
  };

  return (
    <Card className="border-warning/20">
      <CardContent className="pt-4 pb-3 space-y-4">
        {/* Section header */}
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <span className="text-xs font-semibold uppercase tracking-wider text-warning">
            {t('review.enrichmentRequired')}
          </span>
        </div>

        <p className="text-xs text-muted-foreground">
          {t('review.enrichmentDescription')}
        </p>

        {/* Ticker with autocomplete */}
        <div className="space-y-1.5 relative" ref={dropdownRef}>
          <Label htmlFor="drawer-ticker" className="text-xs">
            {t('review.tickerSymbol')}
          </Label>
          <Input
            id="drawer-ticker"
            placeholder={t('review.tickerPlaceholder')}
            value={ticker}
            onChange={(e) => handleTickerInput(e.target.value)}
            onFocus={() => searchInput.length >= 2 && setShowDropdown(true)}
            className="h-8 text-sm"
            autoComplete="off"
          />
          {showDropdown && results.length > 0 && (
            <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
              {results.map((r) => (
                <button
                  key={`${r.symbol}-${r.mic_code}`}
                  type="button"
                  className="w-full px-3 py-2 text-left hover:bg-accent text-sm flex justify-between items-center"
                  onClick={() => handleSelectResult(r)}
                >
                  <span className="font-medium">{r.symbol}</span>
                  <span className="text-xs text-muted-foreground truncate ml-2">
                    {r.name} ({r.exchange}, {r.currency})
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Price & Quantity */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="drawer-price" className="text-xs">
              {t('review.pricePerShare')}
            </Label>
            <Input
              id="drawer-price"
              type="number"
              placeholder={t('review.pricePlaceholder')}
              value={price}
              onChange={(e) => onPriceChange(e.target.value)}
              className="h-8 text-sm"
              step="any"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="drawer-qty" className="text-xs">
              {t('review.quantity')} {isAutoCalc && <span className="text-muted-foreground font-normal">{t('review.quantityAuto')}</span>}
            </Label>
            <Input
              id="drawer-qty"
              type="number"
              placeholder={isAutoCalc ? t('review.quantityCalculated') : t('review.quantityPlaceholder')}
              value={qty}
              onChange={(e) => onQtyChange(e.target.value)}
              className="h-8 text-sm"
              step="any"
              readOnly={isAutoCalc}
            />
          </div>
        </div>

        {/* Details / Notes override */}
        <div className="space-y-1.5">
          <Label htmlFor="drawer-details" className="text-xs">
            {t('review.detailsNotes')}
          </Label>
          <Textarea
            id="drawer-details"
            placeholder={t('review.notesPlaceholder')}
            value={details}
            onChange={(e) => onDetailsChange(e.target.value)}
            className="text-sm min-h-[60px] resize-none"
          />
        </div>
      </CardContent>
    </Card>
  );
}

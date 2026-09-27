import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { PassiveIncomeItem } from '@/types/passive-income';

interface Props {
  items: PassiveIncomeItem[];
  currency: string;
  onEditAsset: (item: PassiveIncomeItem) => void;
  onEditStream: (item: PassiveIncomeItem) => void;
}

const SOURCE_CLASS: Record<PassiveIncomeItem['source'], string> = {
  AUTO: 'bg-positive/10 text-positive border-positive/20',
  OVERRIDE: 'bg-brand-primary/10 text-brand-primary border-brand-primary/20',
  MANUAL: 'bg-muted text-muted-foreground border-gray-200',
  MISSING: 'bg-warning/10 text-warning border-warning/20',
};

const STATUS_CLASS: Record<string, string> = {
  MATURED_UNREDEEMED: 'bg-warning/10 text-warning border-warning/20',
  ENDED: 'bg-muted text-muted-foreground border-gray-200',
  STALE_RATE: 'bg-warning/10 text-warning border-warning/20',
};

/**
 * Breakdown by holding or stream (R1.5). A table from `md` up, stacked cards
 * on phones. Each row opens the Income Terms modal (asset or stream mode).
 */
export function IncomeBreakdown({ items, currency, onEditAsset, onEditStream }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en-US';

  const money = (v: number | null) => (v == null ? '—' : formatCurrency(v, currency, locale));
  const date = (v: string | null) => (v ? formatDate(v, undefined, locale) : '—');
  const rate = (item: PassiveIncomeItem) => {
    if (item.rateOrYield != null) return `${(item.rateOrYield * 100).toFixed(2)}%`;
    if (item.amountPerPayment != null) return money(item.amountPerPayment);
    return '—';
  };
  const freq = (item: PassiveIncomeItem) => (item.frequency ? t(`passiveIncome.frequency.${item.frequency}`) : '—');
  const edit = (item: PassiveIncomeItem) => (item.kind === 'STREAM' ? onEditStream(item) : onEditAsset(item));

  const badges = (item: PassiveIncomeItem) => (
    <span className="inline-flex flex-wrap gap-1">
      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${SOURCE_CLASS[item.source]}`}>
        {t(`passiveIncome.source.${item.source}`)}
      </Badge>
      {item.status !== 'OK' && (
        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${STATUS_CLASS[item.status]}`}>
          {t(`passiveIncome.status.${item.status}`)}
        </Badge>
      )}
    </span>
  );

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">{t('passiveIncome.breakdown.empty')}</p>;
  }

  const key = (item: PassiveIncomeItem) => `${item.kind}-${item.portfolioItemId ?? item.streamId}`;

  return (
    <>
      {/* Desktop / tablet table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.holding')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.type')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.rateOrAmount')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.frequency')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.nextPayment')}</th>
              <th className="px-3 py-2 font-medium">{t('passiveIncome.breakdown.endDate')}</th>
              <th className="px-3 py-2 font-medium text-right">{t('passiveIncome.breakdown.horizonTotal')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={key(item)} className="border-b border-gray-50 hover:bg-accent/40">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-brand-deep">{item.label}</div>
                  <div className="mt-0.5">{badges(item)}</div>
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">{t(`passiveIncome.incomeType.${item.incomeType}`)}</td>
                <td className="px-3 py-2.5 tabular-nums">{rate(item)}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{freq(item)}</td>
                <td className="px-3 py-2.5 tabular-nums">{date(item.nextPaymentDate)}</td>
                <td className="px-3 py-2.5 tabular-nums">{date(item.endDate)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums font-medium">{money(item.horizonTotal)}</td>
                <td className="px-3 py-2.5 text-right">
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={t('common.edit')} onClick={() => edit(item)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone cards */}
      <ul className="md:hidden space-y-2" data-testid="breakdown-cards">
        {items.map((item) => (
          <li key={key(item)}>
            <button
              type="button"
              onClick={() => edit(item)}
              className="w-full text-left rounded-md border border-gray-200 p-3 hover:bg-accent/40"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-brand-deep truncate">{item.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`passiveIncome.incomeType.${item.incomeType}`)} · {freq(item)} · {rate(item)}
                  </p>
                </div>
                <p className="font-semibold tabular-nums shrink-0">{money(item.horizonTotal)}</p>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                {badges(item)}
                <span>
                  {t('passiveIncome.breakdown.nextPayment')}: {date(item.nextPaymentDate)}
                  {item.endDate ? ` · ${t('passiveIncome.breakdown.endDate')}: ${date(item.endDate)}` : ''}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

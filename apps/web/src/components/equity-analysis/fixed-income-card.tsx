import { useTranslation } from 'react-i18next';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import type { FixedIncomeSummary } from '@/types/equity-analysis';

interface FixedIncomeCardProps {
  summary: FixedIncomeSummary;
  currency: string;
}

/** Fixed income summary over direct bonds with income terms (#79). Hidden by the page when null. */
export function FixedIncomeCard({ summary, currency }: FixedIncomeCardProps) {
  const { t } = useTranslation();
  const tiles = [
    { key: 'totalFace', value: formatCurrency(summary.totalFace, currency) },
    {
      key: 'weightedCoupon',
      value: summary.weightedCouponPct != null ? `${summary.weightedCouponPct.toFixed(2)}%` : '—',
    },
    {
      key: 'avgMaturity',
      value: summary.avgYearsToMaturity != null
        ? t('equityAnalysis.yearsValue', { value: summary.avgYearsToMaturity.toFixed(1) })
        : '—',
    },
    {
      key: 'govCorpSplit',
      value: `${summary.governmentPct.toFixed(0)}% / ${summary.corporatePct.toFixed(0)}%`,
    },
    { key: 'bondsCount', value: String(summary.count) },
  ];

  return (
    <Card data-testid="fixed-income-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{t('equityAnalysis.fixedIncomeTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {tiles.map((tile) => (
            <div key={tile.key} className="rounded-lg border border-gray-100 px-3 py-2">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{t(`equityAnalysis.${tile.key}`)}</p>
              <p className="mt-1 text-lg font-bold text-brand-deep tabular-nums">{tile.value}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

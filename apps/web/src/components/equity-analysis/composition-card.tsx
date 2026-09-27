import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { buildGroupColorMap } from '@/lib/portfolio-utils';
import { formatCurrency } from '@/lib/utils';
import { ASSET_CLASSES, type AssetClassCompositionRow } from '@/types/equity-analysis';

/** Stable asset class → dataviz color, shared by the composition card and the badges. */
export const ASSET_CLASS_COLORS = buildGroupColorMap([...ASSET_CLASSES], new Set());

interface CompositionCardProps {
  rows: AssetClassCompositionRow[];
  currency: string;
  isLoading?: boolean;
}

/**
 * Portfolio composition by asset class (#79): donut + table on desktop, donut +
 * stacked list on mobile. Covers every investment (cash and debt excluded).
 */
export function CompositionCard({ rows, currency, isLoading }: CompositionCardProps) {
  const { t } = useTranslation();
  const data = useMemo(
    () => rows.map((r) => ({ ...r, name: t(`equityAnalysis.assetClasses.${r.assetClass}`) })),
    [rows, t],
  );

  return (
    <Card data-testid="composition-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{t('equityAnalysis.compositionTitle')}</CardTitle>
        <p className="text-xs text-muted-foreground">{t('equityAnalysis.compositionSubtitle')}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[220px] w-full rounded" />
        ) : data.length === 0 ? (
          <div className="h-[160px] flex items-center justify-center text-muted-foreground text-sm">
            {t('equityAnalysis.compositionEmpty')}
          </div>
        ) : (
          <div className="flex flex-col md:flex-row md:items-center gap-4">
            <div className="h-[200px] w-full md:w-[220px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={1}>
                    {data.map((r) => (
                      <Cell key={r.assetClass} fill={ASSET_CLASS_COLORS[r.assetClass]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number, name: string) => [formatCurrency(value, currency), name]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Desktop table */}
            <table className="hidden sm:table w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-medium">{t('equityAnalysis.assetClass')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('equityAnalysis.value')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('equityAnalysis.percent')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('equityAnalysis.count')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.assetClass} className="border-b border-gray-50">
                    <td className="px-2 py-1.5">
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ASSET_CLASS_COLORS[r.assetClass] }} />
                        {r.name}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(r.value, currency)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.percent.toFixed(1)}%</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile list */}
            <ul className="sm:hidden w-full divide-y divide-gray-100 text-sm" data-testid="composition-list">
              {data.map((r) => (
                <li key={r.assetClass} className="flex items-center justify-between gap-2 py-2">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: ASSET_CLASS_COLORS[r.assetClass] }} />
                    <span className="truncate">{r.name}</span>
                    <span className="text-xs text-muted-foreground">({r.count})</span>
                  </span>
                  <span className="text-right tabular-nums">
                    {formatCurrency(r.value, currency)}
                    <span className="ml-1 text-xs text-muted-foreground">{r.percent.toFixed(1)}%</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

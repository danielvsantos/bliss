import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { ACTUALS_COLOR, INCOME_BUCKETS } from '@/lib/passive-income';
import type { PassiveIncomeResponse } from '@/types/passive-income';

interface Props {
  actuals: PassiveIncomeResponse['actuals'];
  projected: PassiveIncomeResponse['projected'];
  currency: string;
}

interface Row {
  month: string;
  label: string;
  actual?: number;
  dividend?: number;
  coupon?: number;
  rent?: number;
  interest?: number;
  other?: number;
}

/**
 * Past vs future chart (R1.3): 12 monthly bars of actual "Passive Income"
 * group income, then projected months stacked by source, with a "today"
 * marker between them. For 24/36 months the chart gets a minimum width and
 * scrolls horizontally on phones.
 */
export function PassiveIncomeChart({ actuals, projected, currency }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en-US';

  const monthLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' });
    return (m: string) => fmt.format(new Date(`${m}-01T00:00:00Z`));
  }, [locale]);

  const data: Row[] = useMemo(() => [
    ...actuals.map((a) => ({ month: a.month, label: monthLabel(a.month), actual: a.total })),
    ...projected.map((p) => ({
      month: p.month,
      label: monthLabel(p.month),
      dividend: p.dividend,
      coupon: p.coupon,
      rent: p.rent,
      interest: p.interest,
      other: p.other,
    })),
  ], [actuals, projected, monthLabel]);

  const todayLabel = actuals.length ? data[actuals.length - 1].label : null;
  const minWidth = Math.max(560, data.length * 22);

  return (
    <div className="overflow-x-auto -mx-2 px-2" data-testid="passive-income-chart">
      <div style={{ minWidth }} className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={8} />
            <YAxis
              tick={{ fontSize: 11 }}
              width={64}
              tickFormatter={(v: number) => formatCurrency(v, currency, locale, { notation: 'compact', maximumFractionDigits: 1 })}
            />
            <Tooltip
              formatter={(value: number, name: string) => [formatCurrency(value, currency, locale), name]}
              labelFormatter={(label) => label}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="actual" name={t('passiveIncome.chart.actual')} fill={ACTUALS_COLOR} radius={[3, 3, 0, 0]} />
            {INCOME_BUCKETS.map((b, i) => (
              <Bar
                key={b.key}
                dataKey={b.key}
                stackId="projected"
                name={t(`passiveIncome.bucket.${b.key}`)}
                fill={b.color}
                radius={i === INCOME_BUCKETS.length - 1 ? [3, 3, 0, 0] : undefined}
              />
            ))}
            {todayLabel && (
              <ReferenceLine
                x={todayLabel}
                stroke="hsl(var(--brand-deep))"
                strokeDasharray="4 4"
                label={{ value: t('passiveIncome.chart.today'), position: 'top', fontSize: 11 }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

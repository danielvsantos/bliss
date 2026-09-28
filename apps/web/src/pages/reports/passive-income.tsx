import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePassiveIncome, useIncomeStreams } from '@/hooks/use-passive-income';
import { formatCurrency, formatDate } from '@/lib/utils';
import { INCOME_BUCKETS, readBreakdownView, writeBreakdownView } from '@/lib/passive-income';
import { IncomeTermsModal } from '@/components/income/income-terms-modal';
import { PassiveIncomeChart } from '@/components/passive-income/income-chart';
import { IncomeBreakdown } from '@/components/passive-income/income-breakdown';
import { IncomeStreamsCard } from '@/components/passive-income/streams-card';
import { DetachedTermsSection } from '@/components/passive-income/detached-terms';
import type { BreakdownView, IncomeStream, PassiveIncomeGroup, PassiveIncomeItem } from '@/types/passive-income';

type Horizon = 12 | 24 | 36;
const HORIZONS: Horizon[] = [12, 24, 36];
/** Missing-data buttons shown before "Show all" (large portfolios). */
const MISSING_PREVIEW = 8;

type ModalState =
  | { mode: 'asset'; assetId: number; label: string; scope?: 'single' | 'symbol'; currentValue?: number }
  | { mode: 'stream'; stream: IncomeStream | null }
  | null;

/**
 * Passive Income (#77) — projected dividends, coupons, rent, cash interest and
 * allowance/benefit streams for the next 12/24/36 months next to the last 12
 * months of actual "Passive Income" group income.
 */
export default function PassiveIncomePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en-US';
  const [horizon, setHorizon] = useState<Horizon>(12);
  const [modal, setModal] = useState<ModalState>(null);
  const [showAllMissing, setShowAllMissing] = useState(false);
  const [view, setViewState] = useState<BreakdownView>(readBreakdownView);
  const setView = (next: BreakdownView) => {
    setViewState(next);
    writeBreakdownView(next);
  };

  const { data, isLoading, isFetching, error } = usePassiveIncome(horizon);
  const { data: streamsData } = useIncomeStreams();
  const currency = data?.displayCurrency ?? 'USD';
  const money = (v: number | null | undefined, opts: Intl.NumberFormatOptions = {}) =>
    v == null ? '—' : formatCurrency(v, currency, locale, opts);

  const streamsById = useMemo(
    () => new Map((streamsData?.streams ?? []).map((s) => [s.id, s])),
    [streamsData?.streams],
  );

  const openAsset = (item: { portfolioItemId: number | null; label: string }) => {
    if (item.portfolioItemId != null) setModal({ mode: 'asset', assetId: item.portfolioItemId, label: item.label });
  };
  /** A symbol's group (or its missing-data button): edit every holding at once (#83 R4.1). */
  const openGroup = (group: { portfolioItemIds: number[]; symbol: string | null; label: string; currentValue?: number }) => {
    const [first] = group.portfolioItemIds;
    if (first == null) return;
    setModal({ mode: 'asset', assetId: first, label: group.symbol || group.label, scope: 'symbol', currentValue: group.currentValue });
  };
  const openStream = (item: PassiveIncomeItem) => {
    const stream = item.streamId != null ? streamsById.get(item.streamId) : undefined;
    if (stream) setModal({ mode: 'stream', stream });
  };

  if (error) {
    return (
      <div className="p-6">
        <p className="text-destructive">{t('passiveIncome.loadFailed')}</p>
      </div>
    );
  }

  const kpis = data?.kpis;
  const isRefreshing = isFetching && !isLoading;
  // Older APIs have no groups → the flat view is the only one (#83).
  const hasGroups = Array.isArray(data?.groups);
  const effectiveView: BreakdownView = hasGroups ? view : 'flat';
  const grouped = effectiveView === 'grouped';
  const missingButtons = data
    ? grouped && data.missingGroups
      ? data.missingGroups.map((m) => ({
        key: `${m.assetClass}-${m.groupKey}`,
        label: m.label,
        onClick: () => openGroup({ portfolioItemIds: m.portfolioItemIds, symbol: m.symbol, label: m.label }),
      }))
      : data.missing.map((m) => ({
        key: String(m.portfolioItemId),
        label: m.label,
        onClick: () => openAsset({ portfolioItemId: m.portfolioItemId, label: m.label }),
      }))
    : [];
  const upcoming = data
    ? grouped && data.upcomingPaymentsGrouped
      ? data.upcomingPaymentsGrouped.map((p, i) => ({ ...p, key: `${p.date}-${p.kind}-${p.groupKey ?? p.refId}-${i}` }))
      : data.upcomingPayments.map((p, i) => ({ ...p, accounts: [] as string[], key: `${p.date}-${p.kind}-${p.refId}-${i}` }))
    : [];

  const kpiTiles = [
    {
      key: 'next12m',
      label: t('passiveIncome.kpi.next12m'),
      value: money(kpis?.next12mIncome, { maximumFractionDigits: 0 }),
      sub: kpis
        ? t('passiveIncome.kpi.split', {
          investment: money(kpis.next12mInvestmentIncome, { maximumFractionDigits: 0 }),
          other: money(kpis.next12mOtherIncome, { maximumFractionDigits: 0 }),
        })
        : '',
    },
    { key: 'monthly', label: t('passiveIncome.kpi.monthlyAverage'), value: money(kpis?.monthlyAverage, { maximumFractionDigits: 0 }), sub: '' },
    {
      key: 'yield',
      label: t('passiveIncome.kpi.yieldOnValue'),
      value: kpis?.yieldOnValue != null ? `${(kpis.yieldOnValue * 100).toFixed(2)}%` : '—',
      sub: t('passiveIncome.kpi.yieldHint'),
    },
    {
      key: 'coverage',
      label: t('passiveIncome.kpi.essentialsCoverage'),
      value: kpis?.essentialsCoveragePct != null ? `${kpis.essentialsCoveragePct.toFixed(1)}%` : '—',
      sub: kpis?.trailingEssentials
        ? t('passiveIncome.kpi.essentialsHint', { amount: money(kpis.trailingEssentials, { maximumFractionDigits: 0 }) })
        : t('passiveIncome.kpi.noEssentials'),
    },
    {
      key: 'data',
      label: t('passiveIncome.kpi.dataCoverage'),
      value: kpis ? t('passiveIncome.kpi.dataCoverageValue', { configured: kpis.coverage.configured, total: kpis.coverage.total }) : '—',
      sub: t('passiveIncome.kpi.dataCoverageHint'),
    },
  ];

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col space-y-6">
        {/* ── Title + horizon ── */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1">{t('passiveIncome.title')}</h2>
            <p className="text-muted-foreground text-sm">{t('passiveIncome.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            {isRefreshing && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t('common.refreshing', 'Refreshing')} />}
            <div className="inline-flex rounded-md border border-gray-200 p-0.5" role="group" aria-label={t('passiveIncome.horizon')}>
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHorizon(h)}
                  aria-pressed={horizon === h}
                  className={`px-3 py-1 text-sm rounded transition-colors ${
                    horizon === h ? 'bg-primary text-white font-medium' : 'text-muted-foreground hover:text-brand-deep'
                  }`}
                >
                  {t('passiveIncome.months', { count: h })}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── KPI tiles ── */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3" data-testid="kpi-tiles">
          {kpiTiles.map((k, i) => (
            <Card key={k.key} className={i === 0 ? 'col-span-2 lg:col-span-1' : undefined}>
              <CardContent className="pt-4 pb-3 px-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">{k.label}</p>
                {isLoading ? (
                  <Skeleton className="h-7 w-24 mt-1" />
                ) : (
                  <>
                    <p className="text-xl font-bold text-brand-deep mt-1 tabular-nums">{k.value}</p>
                    {k.sub && <p className="text-xs text-muted-foreground mt-0.5">{k.sub}</p>}
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ── Missing data prompt ── */}
        {data && missingButtons.length > 0 && (
          <Card className="border-warning/30 bg-warning/5" data-testid="missing-data">
            <CardContent className="py-4 space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-brand-deep">{t('passiveIncome.missing.title', { count: missingButtons.length })}</p>
                  <p className="text-xs text-muted-foreground">{t('passiveIncome.missing.description')}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-6">
                {(showAllMissing ? missingButtons : missingButtons.slice(0, MISSING_PREVIEW)).map((m) => (
                  <Button
                    key={m.key}
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={m.onClick}
                  >
                    {m.label}
                  </Button>
                ))}
                {missingButtons.length > MISSING_PREVIEW && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setShowAllMissing((v) => !v)}
                  >
                    {showAllMissing
                      ? t('passiveIncome.missing.showLess')
                      : t('passiveIncome.missing.showAll', { count: missingButtons.length })}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Past vs future chart ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('passiveIncome.chart.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || !data ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <PassiveIncomeChart actuals={data.actuals} projected={data.projected} currency={currency} />
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Annual summary ── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('passiveIncome.yearly.title')}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {isLoading || !data ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <table className="w-full text-sm" data-testid="yearly-summary">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-2 py-2 text-left font-medium">{t('passiveIncome.yearly.source')}</th>
                      {data.yearly.map((y) => (
                        <th key={y.year} className="px-2 py-2 text-right font-medium">{t('passiveIncome.yearly.year', { n: y.year })}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {INCOME_BUCKETS.map((b) => (
                      <tr key={b.key} className="border-b border-gray-50">
                        <td className="px-2 py-1.5">
                          <span className="inline-block h-2 w-2 rounded-full mr-2 align-middle" style={{ backgroundColor: b.color }} />
                          {t(`passiveIncome.bucket.${b.key}`)}
                        </td>
                        {data.yearly.map((y) => (
                          <td key={y.year} className="px-2 py-1.5 text-right tabular-nums">{money(y[b.key], { maximumFractionDigits: 0 })}</td>
                        ))}
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className="px-2 py-1.5">{t('passiveIncome.yearly.total')}</td>
                      {data.yearly.map((y) => (
                        <td key={y.year} className="px-2 py-1.5 text-right tabular-nums">{money(y.total, { maximumFractionDigits: 0 })}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* ── Upcoming payments ── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('passiveIncome.upcoming.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading || !data ? (
                <Skeleton className="h-24 w-full" />
              ) : upcoming.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">{t('passiveIncome.upcoming.empty')}</p>
              ) : (
                <ul className="divide-y divide-gray-100" data-testid="upcoming-payments">
                  {upcoming.map((p) => (
                    <li
                      key={p.key}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                      title={p.accounts.length > 1 ? p.accounts.join(', ') : undefined}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-brand-deep">{p.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(p.date, undefined, locale)} · {t(`passiveIncome.bucket.${p.source}`)}
                          {p.accounts.length > 1 ? ` · ${t('passiveIncome.breakdown.accounts', { count: p.accounts.length })}` : ''}
                        </p>
                      </div>
                      <span className="tabular-nums font-medium shrink-0">{money(p.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Breakdown ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('passiveIncome.breakdown.title')}</CardTitle>
            <CardDescription>{t('passiveIncome.breakdown.description', { count: horizon })}</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading || !data ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <IncomeBreakdown
                items={data.items}
                groups={data.groups}
                view={effectiveView}
                onViewChange={setView}
                currency={currency}
                onEditAsset={openAsset}
                onEditStream={openStream}
                onEditGroup={(g: PassiveIncomeGroup) => openGroup(g)}
              />
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Other income streams ── */}
          <IncomeStreamsCard
            onAdd={() => setModal({ mode: 'stream', stream: null })}
            onEdit={(stream) => setModal({ mode: 'stream', stream })}
          />

          {/* ── Bond maturity ladder ── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('passiveIncome.ladder.title')}</CardTitle>
              <CardDescription>{t('passiveIncome.ladder.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading || !data ? (
                <Skeleton className="h-16 w-full" />
              ) : data.maturityLadder.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">{t('passiveIncome.ladder.empty')}</p>
              ) : (
                <ul className="space-y-2" data-testid="maturity-ladder">
                  {(() => {
                    const max = Math.max(...data.maturityLadder.map((l) => l.principal), 1);
                    return data.maturityLadder.map((l) => (
                      <li key={l.year} className="text-sm">
                        <div className="flex justify-between">
                          <span className="text-brand-deep font-medium">{l.year}</span>
                          <span className="tabular-nums">{money(l.principal, { maximumFractionDigits: 0 })}</span>
                        </div>
                        <div className="h-2 rounded bg-muted mt-1">
                          <div className="h-2 rounded bg-dataviz-5" style={{ width: `${(l.principal / max) * 100}%` }} />
                        </div>
                      </li>
                    ));
                  })()}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Detached terms ── */}
        {data && <DetachedTermsSection detached={data.detached} />}
      </div>

      <IncomeTermsModal
        open={modal !== null}
        onOpenChange={(open) => !open && setModal(null)}
        mode={modal?.mode ?? 'asset'}
        assetId={modal?.mode === 'asset' ? modal.assetId : null}
        assetLabel={modal?.mode === 'asset' ? modal.label : undefined}
        scope={modal?.mode === 'asset' ? modal.scope ?? 'single' : 'single'}
        currentValue={modal?.mode === 'asset' ? modal.currentValue : undefined}
        stream={modal?.mode === 'stream' ? modal.stream : null}
        defaultCurrency={currency}
      />
    </div>
  );
}

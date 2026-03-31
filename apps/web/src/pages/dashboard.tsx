import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUserSignals } from '@/hooks/use-user-signals';
import { useDashboardActions } from '@/hooks/use-dashboard-actions';
import { usePortfolioHistory } from '@/hooks/use-portfolio-history';
import { getTenantMeta } from '@/utils/tenantMetaStorage';
import { SetupChecklist } from '@/components/onboarding/setup-checklist';
import { HeroNetWorth } from '@/components/dashboard/hero-net-worth';
import { SyncedAccountsCard } from '@/components/dashboard/synced-accounts-card';
import { ExpenseSplitCard } from '@/components/dashboard/expense-split-card';
import { QuickActionsCard } from '@/components/dashboard/quick-actions-card';
import { RecentTransactionsCard } from '@/components/dashboard/recent-transactions-card';
import { subMonths, format } from 'date-fns';
import type { AggregatedPortfolioHistory } from '@/lib/api';

/* ── Animation presets ── */
const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
};

export default function Dashboard() {
  const { t } = useTranslation();

  // ── Year / Currency selectors ──
  const availableYears = useMemo(() => {
    const tenantMeta = getTenantMeta();
    if (tenantMeta?.transactionYears && tenantMeta.transactionYears.length > 0) {
      return tenantMeta.transactionYears.map(String);
    }
    return [new Date().getFullYear().toString()];
  }, []);

  const [selectedYear, setSelectedYear] = useState<string>(availableYears[0]);

  // ── User signals + dashboard actions ──
  const { signals, accounts, metrics, portfolioCurrency, metricsLoading, accountsLoading } = useUserSignals(selectedYear);
  const { quickActions, onboardingActions } = useDashboardActions(signals);

  // Portfolio history for sparkline (last 3 months)
  const historyFilters = useMemo(() => ({
    from: format(subMonths(new Date(), 3), 'yyyy-MM-dd'),
    to: format(new Date(), 'yyyy-MM-dd'),
  }), []);
  const { data: historyResponse } = usePortfolioHistory(historyFilters);

  // ── Computed values ──
  const sparklineData = useMemo(() => {
    const history = historyResponse?.history ?? [];
    if (history.length === 0) return [];

    const netWorthByDay = history.map((entry: AggregatedPortfolioHistory) => {
      const assets = entry.Asset?.total ?? 0;
      const investments = entry.Investments?.total ?? 0;
      const debt = entry.Debt?.total ?? 0;
      return assets + investments - Math.abs(debt);
    });

    // Sample to ~30 points for the sparkline
    if (netWorthByDay.length <= 30) return netWorthByDay;
    const step = (netWorthByDay.length - 1) / 29;
    return Array.from({ length: 30 }, (_, i) =>
      netWorthByDay[Math.round(i * step)]
    );
  }, [historyResponse]);

  const previousNetWorth = useMemo(() => {
    if (sparklineData.length < 2) return null;
    return sparklineData[0];
  }, [sparklineData]);

  const mostRecentSync = useMemo(() => {
    return accounts
      .map(a => a.lastSync)
      .filter((s): s is string => s !== null)
      .sort()
      .pop() ?? null;
  }, [accounts]);

  // ── Empty state detection ──
  const isLoading = metricsLoading || accountsLoading;
  const isEmpty = !isLoading &&
    (metrics?.netWorth || 0) === 0 &&
    (metrics?.netIncome || 0) === 0 &&
    accounts.length === 0;

  return (
    <div>
      {/* ── Header ── */}
      <div className="mb-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-foreground">
              {t('pages.dashboard.title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('pages.dashboard.subtitle')}
            </p>
          </div>
          {!isEmpty && (
            <div className="mt-4 md:mt-0 flex gap-2">
              <Select value={selectedYear} onValueChange={setSelectedYear}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Select year" />
                </SelectTrigger>
                <SelectContent>
                  {availableYears.map(year => (
                    <SelectItem key={year} value={year}>{year}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>

      {/* ── Empty state ── */}
      {isEmpty ? (
        <div className="space-y-6">
          <SetupChecklist actions={onboardingActions} />
          <p className="text-center text-sm text-muted-foreground">
            Your dashboard will come to life once you add some data.
          </p>
        </div>
      ) : (
        <>
          {/* Onboarding checklist (auto-hides when complete/dismissed) */}
          <SetupChecklist actions={onboardingActions} />

          {/* ── HERO: Net Worth ── */}
          <motion.div {...fadeUp} transition={{ duration: 0.4 }}>
            <HeroNetWorth
              netWorth={metrics?.netWorth ?? 0}
              previousNetWorth={previousNetWorth}
              netIncome={metrics?.netIncome ?? 0}
              grossProfit={metrics?.grossProfit ?? 0}
              currency={portfolioCurrency}
              lastSyncDate={mostRecentSync}
              sparklineData={sparklineData}
              isLoading={metricsLoading}
            />
          </motion.div>

          {/* ── 3-Column Grid ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-6">
            <motion.div {...fadeUp} transition={{ delay: 0.1, duration: 0.4 }}>
              <SyncedAccountsCard
                accounts={accounts}
                isLoading={accountsLoading}
              />
            </motion.div>
            <motion.div {...fadeUp} transition={{ delay: 0.15, duration: 0.4 }}>
              <ExpenseSplitCard currency={portfolioCurrency} />
            </motion.div>
            <motion.div {...fadeUp} transition={{ delay: 0.2, duration: 0.4 }}>
              <QuickActionsCard
                actions={quickActions}
                signals={signals}
              />
            </motion.div>
          </div>

          {/* ── Recent Transactions ── */}
          <motion.div className="mt-6" {...fadeUp} transition={{ delay: 0.25, duration: 0.4 }}>
            <RecentTransactionsCard />
          </motion.div>
        </>
      )}
    </div>
  );
}

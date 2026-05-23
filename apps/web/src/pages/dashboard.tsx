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

/* ── Helpers ── */
function netWorthFromEntry(entry: AggregatedPortfolioHistory): number {
  return (entry.Asset?.total ?? 0) + (entry.Investments?.total ?? 0) - Math.abs(entry.Debt?.total ?? 0);
}

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

  // ── Year-awareness ──
  const currentYear = new Date().getFullYear().toString();
  const isCurrentYear = selectedYear === currentYear;

  // Portfolio history — last 3 months for current year; full year for historical
  const historyFilters = useMemo(() => {
    if (isCurrentYear) {
      return {
        from: format(subMonths(new Date(), 3), 'yyyy-MM-dd'),
        to: format(new Date(), 'yyyy-MM-dd'),
      };
    }
    return {
      from: `${selectedYear}-01-01`,
      to: `${selectedYear}-12-31`,
    };
  }, [selectedYear, isCurrentYear]);
  const { data: historyResponse } = usePortfolioHistory(historyFilters);

  // ── Computed values ──
  const sparklineData = useMemo(() => {
    const history = historyResponse?.history ?? [];
    if (history.length === 0) return [];

    const netWorthByDay = history.map((entry: AggregatedPortfolioHistory) => netWorthFromEntry(entry));

    // Sample to ~30 points for the sparkline
    if (netWorthByDay.length <= 30) return netWorthByDay;
    const step = (netWorthByDay.length - 1) / 29;
    return Array.from({ length: 30 }, (_, i) =>
      netWorthByDay[Math.round(i * step)]
    );
  }, [historyResponse]);

  // For current year: live portfolio value; for historical year: last history entry
  const displayNetWorth = useMemo(() => {
    if (isCurrentYear) return metrics?.netWorth ?? 0;
    const history = historyResponse?.history ?? [];
    if (history.length === 0) return metrics?.netWorth ?? 0;
    return netWorthFromEntry(history[history.length - 1]);
  }, [isCurrentYear, metrics?.netWorth, historyResponse]);

  const previousNetWorth = useMemo(() => {
    const history = historyResponse?.history ?? [];
    if (history.length === 0) return null;

    if (isCurrentYear) {
      // Compare to entry closest to 1 month ago
      const targetTime = subMonths(new Date(), 1).getTime();
      const closest = history.reduce((best, entry) => {
        const diff = Math.abs(new Date(entry.date).getTime() - targetTime);
        const bestDiff = Math.abs(new Date(best.date).getTime() - targetTime);
        return diff < bestDiff ? entry : best;
      });
      return netWorthFromEntry(closest);
    }

    // Historical year: compare end-of-year to start-of-year
    return netWorthFromEntry(history[0]);
  }, [historyResponse, isCurrentYear]);

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
              netWorth={displayNetWorth}
              previousNetWorth={previousNetWorth}
              income={metrics?.netIncome ?? 0}
              netSavings={metrics?.netSavings ?? 0}
              currency={portfolioCurrency}
              lastSyncDate={mostRecentSync}
              sparklineData={sparklineData}
              isLoading={metricsLoading}
            />
          </motion.div>

          {/* ── 3-Column Grid ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-6">
            <motion.div {...fadeUp} transition={{ delay: 0.1, duration: 0.4 }} className="order-2 lg:order-1">
              <SyncedAccountsCard
                accounts={accounts}
                isLoading={accountsLoading}
              />
            </motion.div>
            <motion.div {...fadeUp} transition={{ delay: 0.15, duration: 0.4 }} className="order-1 lg:order-2">
              <ExpenseSplitCard currency={portfolioCurrency} year={selectedYear} />
            </motion.div>
            <motion.div {...fadeUp} transition={{ delay: 0.2, duration: 0.4 }} className="order-3 lg:order-3">
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

import type { UserSignals } from '@/hooks/use-user-signals';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DashboardAction {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  slot: 'quickAction' | 'onboarding' | 'both';
  priority: number;
  badge?: (signals: UserSignals) => number | undefined;
  visible: (signals: UserSignals, context: 'quickAction' | 'onboarding') => boolean;
}

// ─── Icons (custom SVGs from UIKit) ──────────────────────────────────────────

function IconBank() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M1.5 13h10M1.5 6.5h10M7 2L12.5 5H1.5L7 2z"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 6.5v5M7 6.5v5M10.5 6.5v5"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="M13 2.5v3M11.5 4h3"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function IconAIReview() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M7.5 1.5 L8.6 5.4 L12.5 6.5 L8.6 7.6 L7.5 11.5 L6.4 7.6 L2.5 6.5 L6.4 5.4 Z"
        stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="M12.5 11l.6 1.4.6-1.4 1.3-.5-1.3-.5-.6-1.4-.6 1.4-1.3.5 1.3.5z"
        stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

function IconUpdatePrices() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M12.5 4.5A5.5 5.5 0 0 0 2.5 7.5"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="M2.5 10.5A5.5 5.5 0 0 0 12.5 7.5"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="M10.5 2.5l2 2-2 2"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 12.5l-2-2 2-2"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 5v5M6 7.5h3"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1.5"
        stroke="currentColor" strokeWidth="1.35" />
      <rect x="8.5" y="1.5" width="5" height="5" rx="1.5"
        stroke="currentColor" strokeWidth="1.35" />
      <rect x="1.5" y="8.5" width="5" height="5" rx="1.5"
        stroke="currentColor" strokeWidth="1.35" />
      <rect x="8.5" y="8.5" width="5" height="5" rx="1.5"
        stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function IconFixConnection() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M7.5 1.5v2M7.5 11.5v2M1.5 7.5h2M11.5 7.5h2"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <circle cx="7.5" cy="7.5" r="3.5"
        stroke="currentColor" strokeWidth="1.35" />
      <path d="M7.5 6v2.5l1.5 1"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconImport() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M7.5 2v7M5 6.5l2.5 2.5L10 6.5"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 10.5v2h10v-2"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconInsights() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M7.5 1C4.7 1 2.5 3.2 2.5 6c0 1.8 1 3.4 2.5 4.2V12h5v-1.8c1.5-.8 2.5-2.4 2.5-4.2 0-2.8-2.2-5-5-5z"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 13.5h4"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="M7.5 6v2.5"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function IconPieChart() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M7.5 1.5A6 6 0 1 0 13.5 7.5H7.5V1.5z"
        stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="M10.5 1.9A6 6 0 0 1 13.1 4.5H10.5V1.9z"
        stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    </svg>
  );
}

function IconTrending() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M1.5 11.5l4-4 2.5 2.5 5.5-6.5"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 3.5h3v3"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAddAccount() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <rect x="1.5" y="3" width="10" height="9" rx="1.5"
        stroke="currentColor" strokeWidth="1.35" />
      <path d="M1.5 6.5h10"
        stroke="currentColor" strokeWidth="1.35" />
      <path d="M4 9h2M4 10.5h4"
        stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M13 5v3M11.5 6.5h3"
        stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

// ─── Action Definitions ──────────────────────────────────────────────────────

export const DASHBOARD_ACTIONS: DashboardAction[] = [
  {
    id: 'fix-connection',
    label: 'Fix Bank Connection',
    description: 'A bank connection needs your attention',
    icon: <IconFixConnection />,
    href: '/accounts',
    slot: 'quickAction',
    priority: 1,
    visible: (s) => s.hasActionRequired,
  },
  {
    id: 'review-transactions',
    label: 'Review Pending Transactions',
    description: 'Check and categorize imported transactions',
    icon: <IconAIReview />,
    href: '/agents/review',
    slot: 'both',
    priority: 2,
    badge: (s) => s.totalReviewCount > 0 ? s.totalReviewCount : undefined,
    visible: (s, ctx) => {
      if (ctx === 'onboarding') return true; // Always show in onboarding (tracked by checklist)
      return s.totalReviewCount > 0;
    },
  },
  {
    id: 'update-prices',
    label: 'Update Asset Prices',
    description: 'Some manual assets need a price refresh',
    icon: <IconUpdatePrices />,
    href: '/portfolio',
    slot: 'quickAction',
    priority: 3,
    visible: (s) => s.hasStaleManualAssets,
  },
  {
    id: 'connect-bank',
    label: 'Connect Bank',
    description: 'Link your bank for automatic sync',
    icon: <IconBank />,
    href: '/accounts',
    slot: 'both',
    priority: 4,
    visible: (s, ctx) => {
      if (ctx === 'onboarding') return !s.hasPlaid;
      return true; // Always available in quickActions
    },
  },
  {
    id: 'add-account',
    label: 'Add Manual Account',
    description: 'Manually track an account or asset',
    icon: <IconAddAccount />,
    href: '/accounts',
    slot: 'both',
    priority: 5,
    visible: (s, ctx) => {
      if (ctx === 'onboarding') return s.accountCount === 0;
      return s.accountCount === 0;
    },
  },
  {
    id: 'import-csv',
    label: 'Import Transactions',
    description: 'Upload a CSV file to import transactions',
    icon: <IconImport />,
    href: '/import',
    slot: 'quickAction',
    priority: 6,
    visible: (s) => s.accountCount > 0 && !s.hasPlaid,
  },
  {
    id: 'view-insights',
    label: 'View Insights',
    description: 'See AI-generated financial observations',
    icon: <IconInsights />,
    href: '/agents/insight',
    slot: 'quickAction',
    priority: 5,
    visible: (s) => s.insightCount > 0,
  },
  {
    id: 'explore-expenses',
    label: 'Explore Expenses',
    description: 'See how your spending breaks down',
    icon: <IconPieChart />,
    href: '/reports/expenses',
    slot: 'both',
    priority: 7,
    visible: (s, ctx) => {
      if (ctx === 'onboarding') return !(s.checklist?.exploreExpenses?.done || s.checklist?.exploreExpenses?.skipped);
      return true; // Always in quickActions
    },
  },
  {
    id: 'check-pnl',
    label: 'View P&L',
    description: 'View income vs expenses over time',
    icon: <IconTrending />,
    href: '/reports/pnl',
    slot: 'both',
    priority: 8,
    visible: (s, ctx) => {
      if (ctx === 'onboarding') return !(s.checklist?.checkPnL?.done || s.checklist?.checkPnL?.skipped);
      return true; // Always in quickActions
    },
  },
  {
    id: 'view-accounts',
    label: 'View Accounts',
    description: 'See all your connected accounts',
    icon: <IconGrid />,
    href: '/accounts',
    slot: 'quickAction',
    priority: 9,
    visible: (s) => s.accountCount > 0,
  },
];

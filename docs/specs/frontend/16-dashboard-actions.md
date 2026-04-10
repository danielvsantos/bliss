# 16. Dashboard Action Registry (Frontend)

This document covers the centralized action registry system that powers both the Quick Actions card and the onboarding Setup Checklist on the dashboard. A shared signal evaluator (`useUserSignals`) computes user state once, consumed by the action registry and extensible to the notification center (see `specs/14-notification-center.md`).

---

## 16.1. Overview

The dashboard action registry defines ~10 actions with visibility rules based on user state. Instead of hardcoding buttons in each component, both the Quick Actions card and the Setup Checklist draw from a single registry filtered by context (`quickAction` vs `onboarding`). This makes it easy to add, reorder, or conditionally show actions without touching multiple components.

---

## 16.2. Architecture

```
src/hooks/use-user-signals.ts              <- Shared signal evaluator
src/lib/dashboard-actions.tsx              <- Action definitions + visibility rules
src/hooks/use-dashboard-actions.ts         <- Evaluates actions against signals
src/components/dashboard/quick-actions-card.tsx  <- Renders top 4 quick actions
src/components/onboarding/setup-checklist.tsx    <- Renders onboarding items
```

---

## 16.3. User Signals (`src/hooks/use-user-signals.ts`)

### Interface

```ts
interface UserSignals {
  accountCount: number;
  hasPlaid: boolean;
  hasActionRequired: boolean;       // Plaid item with LOGIN_REQUIRED/ERROR
  plaidPendingCount: number;
  importPendingCount: number;
  totalReviewCount: number;
  hasPortfolioData: boolean;        // netWorth !== 0
  hasStaleManualAssets: boolean;    // Manual/API_FUND assets >30 days stale or no initial price
  insightCount: number;             // Non-dismissed insights
  onboardingComplete: boolean;
  checklistDismissed: boolean;
  checklist: Record<string, { done?: boolean; skipped?: boolean }>;
  isLoading: boolean;
}
```

### Signal Sources

| Signal | Hook | API Endpoint |
|--------|------|-------------|
| `accountCount`, `hasPlaid`, `hasActionRequired` | `useAccountList()` | `/api/metadata` + `/api/plaid/items` |
| `plaidPendingCount` | `usePlaidTransactions({ limit: 1 })` | `/api/plaid/transactions` |
| `importPendingCount` | `usePendingImports()` | `/api/imports/pending` |
| `hasPortfolioData` | `useDashboardMetrics(year)` | `/api/analytics` + `/api/portfolio/items` |
| `hasStaleManualAssets` | `usePortfolioItems({ includeManualValues: true })` | `/api/portfolio/items` |
| `insightCount` | `useInsights({ limit: 1 })` | `/api/insights` |
| `onboardingComplete`, `checklist` | `useOnboardingProgress()` | `/api/onboarding/progress` |

### Stale Manual Assets Detection

An asset is considered stale when:
- Its category `processingHint` is `'MANUAL'` or `'API_FUND'`
- It has `quantity > 0`
- Either: no `manualValues` entry exists, OR the latest one is >30 days old

This mirrors the detection logic in `src/pages/manual-updates.tsx`.

### Return Value

`useUserSignals(year?: string, currency?: string)` returns both signals AND raw data:

```ts
interface UseUserSignalsResult {
  signals: UserSignals;
  accounts: EnrichedAccount[];
  metrics: DashboardMetrics | undefined;
  portfolioCurrency: string;
  metricsLoading: boolean;
  accountsLoading: boolean;
}
```

React Query deduplicates underlying HTTP calls if components also use these hooks independently.

---

## 16.4. Action Registry (`src/lib/dashboard-actions.tsx`)

### DashboardAction Interface

```ts
interface DashboardAction {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  slot: 'quickAction' | 'onboarding' | 'both';
  priority: number;            // Lower = higher priority
  badge?: (signals: UserSignals) => number | undefined;
  visible: (signals: UserSignals, context: 'quickAction' | 'onboarding') => boolean;
}
```

### Registered Actions

| # | ID | Label | Slot | Priority | Visible When |
|---|-----|-------|------|----------|-------------|
| 1 | `fix-connection` | Fix Bank Connection | quickAction | 1 | `hasActionRequired` |
| 2 | `review-transactions` | Review Pending Transactions | both | 2 | `totalReviewCount > 0` (quick); always (onboarding) |
| 3 | `update-prices` | Update Asset Prices | quickAction | 3 | `hasStaleManualAssets` |
| 4 | `connect-bank` | Connect Bank | both | 4 | always (quick); `!hasPlaid` (onboarding) |
| 5 | `add-account` | Add Manual Account | both | 5 | `accountCount === 0` |
| 6 | `import-csv` | Import Transactions | quickAction | 6 | `accountCount > 0 && !hasPlaid` (only manual-account users) |
| 7 | `view-insights` | View Insights | quickAction | 5 | `insightCount > 0` |
| 8 | `explore-expenses` | Explore Expenses | both | 7 | always (quick); `!checklist.exploreExpenses.done` (onboarding) |
| 9 | `check-pnl` | View P&L | both | 8 | always (quick); `!checklist.checkPnL.done` (onboarding) |
| 10 | `view-accounts` | View Accounts | quickAction | 9 | `accountCount > 0` |

### Key Rules

- `fix-connection` has highest priority and only appears when there's a real Plaid issue
- `review-transactions` badge dynamically shows `totalReviewCount`
- `connect-bank` + `add-account` are separate actions for Plaid vs manual account creation
- `explore-expenses` and `check-pnl` serve dual roles: one-time onboarding steps + permanent quick action shortcuts
- `view-insights` only appears when there are undismissed insights
- `update-prices` only appears when manual assets are stale (>30 days or no initial price)

---

## 16.5. Dashboard Actions Hook (`src/hooks/use-dashboard-actions.ts`)

```ts
function useDashboardActions(signals: UserSignals): {
  quickActions: DashboardAction[];     // Top 4 visible
  onboardingActions: DashboardAction[];
}
```

**Filtering logic:**

1. **Onboarding actions**: Filter by `slot === 'onboarding' || 'both'`, evaluate `visible(signals, 'onboarding')`, sort by priority
2. **Quick actions**: Filter by `slot === 'quickAction' || 'both'`, evaluate `visible(signals, 'quickAction')`, sort by priority, take top 4
3. **Deduplication**: Actions with `slot: 'both'` that are still active in the onboarding checklist (not completed/dismissed) are excluded from quick actions to avoid showing the same action twice

---

## 16.6. Consumer Components

### QuickActionsCard

Props: `actions: DashboardAction[], signals: UserSignals`

Renders up to 4 action buttons dynamically. Each button shows the action's custom SVG icon, label, and optional badge count computed via `action.badge?.(signals)`.

### SetupChecklist

Props: `actions?: DashboardAction[]`

Maps action IDs to onboarding checklist keys for completion tracking. Deduplicates actions that share the same checklist key (e.g., `connect-bank` and `add-account` both map to `connectBank`). Keeps existing `useOnboardingProgress()` / `useCompleteOnboardingStep()` for state persistence.

---

## 16.7. How to Add a New Action

1. Define the action in `DASHBOARD_ACTIONS` array in `src/lib/dashboard-actions.tsx`
2. Inline the SVG directly as a JSX literal in the `icon` field (do **not** wrap it in a local component function — `dashboard-actions.tsx` is kept as a pure data module so Fast Refresh stays granular on the consumer components)
3. Set `slot`, `priority`, and `visible()` rule
4. If it's an onboarding action, add a mapping in `SetupChecklist`'s `actionToChecklistKey` record and ensure the corresponding key exists in the tenant's `onboardingProgress.checklist`
5. If it needs a badge, add a `badge()` function and ensure the signal is available in `UserSignals`

No changes needed to `QuickActionsCard`, `SetupChecklist`, or `dashboard.tsx` — the registry pattern handles the rest.

---

## 16.8. Future Enhancements

- **Notification center integration** — The notification center (`specs/14-notification-center.md`) computes the same signals server-side. `useUserSignals` could be adopted as the client-side signal layer for the notification center.
- **User-configurable actions** — Allow users to pin/unpin quick actions via a settings panel.
- **Action analytics** — Track which quick actions users click most to inform default ordering.
- **Insight-driven actions** — Generate dynamic actions from AI insights (e.g., "Review unusual spending in Dining").

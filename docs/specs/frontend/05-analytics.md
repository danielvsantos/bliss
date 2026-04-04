# 5. Analytics & Reporting

This document outlines the frontend implementation of the analytics and reporting features, covering the Dashboard, Expenses, and Profit & Loss (P&L) pages. These pages provide users with a comprehensive overview of their financial health.

## 5.1. Key Features

The analytics section is composed of three main pages:

- **Dashboard**: A high-level summary of key financial metrics.
- **Expenses Report**: A detailed breakdown of spending by category and over time.
- **P&L Report**: A financial statement summarizing revenues, costs, and expenses.

All analytics pages rely on data fetched from the `/api/analytics` endpoint and use a consistent set of filters, including date range, currency, and country.

## 5.2. Dashboard Page

The dashboard provides a modern, hero-driven financial overview with glass-morphism card styling and staggered entry animations.

- **File Path**: `src/pages/dashboard.tsx`
- **Components Directory**: `src/components/dashboard/`

### 5.2.1. Layout Structure

```
Header: Title + Year selector (currency from portfolioCurrency via useUserSignals)
SetupChecklist (conditional, auto-hides when complete/dismissed)
HeroNetWorth (glass card)
  - Total Net Worth (large, prominent value)
  - Trend: delta amount + percentage vs last month
  - Inline SVG sparkline (hidden on mobile)
  - Secondary pills: Net Income, Gross Profit
  - Last synced timestamp
3-Column Grid (stacks to 1 col on mobile):
  - SyncedAccountsCard: account rows with type icons + Live badge
  - ExpenseSplitCard: donut pie chart (Recharts) + 2-col legend
  - QuickActionsCard: 4 action buttons (Connect Bank, Review AI, Update Prices, View Accounts)
RecentTransactionsCard: 5 rows with emoji, date, description, category, account, amount
```

### 5.2.2. Components

| Component | File | Props |
|-----------|------|-------|
| `HeroNetWorth` | `hero-net-worth.tsx` | `netWorth, previousNetWorth, netIncome, grossProfit, currency, lastSyncDate, sparklineData, isLoading` |
| `NetWorthSparkline` | `net-worth-sparkline.tsx` | `dataPoints: number[], width?, height?` |
| `SyncedAccountsCard` | `synced-accounts-card.tsx` | `accounts: EnrichedAccount[], isLoading` |
| `ExpenseSplitCard` | `expense-split-card.tsx` | `currency: string` |
| `QuickActionsCard` | `quick-actions-card.tsx` | `actions: DashboardAction[], signals: UserSignals` |
| `RecentTransactionsCard` | `recent-transactions-card.tsx` | `className?` (self-contained, fetches own data, uses category emoji from API) |
| `SetupChecklist` | `setup-checklist.tsx` | `actions?: DashboardAction[]` (onboarding items from action registry) |

### 5.2.3. Styling Patterns

- **Glass cards**: Applied globally via `[data-slot="card"]` CSS selector in `index.css` — `background: rgba(255,255,255,0.68)`, `backdrop-filter: blur(20px) saturate(1.6)`, multi-layer shadows. Affects all Card components site-wide. Dark mode variant inverts background.
- **CardDivider**: 1px horizontal separator between card sections (added to `src/components/ui/card.tsx`).
- **Account type icons**: Custom SVGs (BankIcon, CardTypeIcon, InvestIcon, WalletIcon). Type detected from `plaidItem.accounts[0].type` — `depository`, `credit`, `investment`, or manual fallback.
- **Category emojis**: Transaction rows display the category emoji from `tx.category.icon` (returned by `/api/transactions`). Background color is type-based: Income=`bg-positive/10`, Expense=`bg-brand-primary/10`, Debt=`bg-negative/10`.
- **Responsive transaction columns**: Full desktop shows Emoji | Date | Description | Category | Account | Amount. On tablet (`sm`), Category column hides. On mobile, Date/Category/Account collapse into a subtitle line under Description (e.g. "Mar 7 · Groceries · Chase Checking").
- **Animations**: `framer-motion` staggered `fadeUp` (opacity 0→1, y 12→0) with staggered delays: 0.1s (SyncedAccountsCard), 0.15s (ExpenseSplitCard), 0.2s (QuickActionsCard), 0.25s (RecentTransactionsCard). Duration is 0.4s for all sections.

### 5.2.4. Data Hooks

| Hook | Source | Used For |
|------|--------|----------|
| `useUserSignals(year)` | Aggregates 7 hooks | User state signals (accounts, reviews, portfolio, onboarding, insights) + raw data. See `specs/16-dashboard-actions.md`. |
| `useDashboardActions(signals)` | Action registry | Filters 10 registered actions by visibility rules, returns top 4 `quickActions` + `onboardingActions` |
| `usePortfolioHistory(filters)` | `/api/portfolio/history` | Sparkline data (last 3 months, sampled to 30 points) |
| `useAnalytics(filters)` | `/api/analytics` | Expense split chart data |
| `useTransactions({limit:5})` | `/api/transactions` | Recent transactions (with category emoji via `icon` field) |

### 5.2.5. Computed Values

- **sparklineData**: Net worth per day from portfolio history — `(Asset.total + Investments.total) - abs(Debt.total)` — sampled to 30 points.
- **previousNetWorth**: First sparkline data point (value ~3 months ago). Used to compute delta and percentage change.
- **mostRecentSync**: Latest `lastSync` across all enriched accounts.
- **Quick Actions**: Dynamically selected from the centralized action registry (see `specs/16-dashboard-actions.md`). Top 4 visible actions shown based on user state signals.

### 5.2.6. Empty State

When `netWorth === 0 && netIncome === 0 && accounts.length === 0`:
- Shows `SetupChecklist` prominently
- Displays "Your dashboard will come to life once you add some data."
- Year/currency selectors hidden

## 5.3. P&L Analysis Page

This page offers a detailed P&L statement, allowing for in-depth financial analysis.

- **File Path**: `src/pages/reports/pnl.tsx`

### 5.3.1. Filtering and Views

- **Time-Based Views**: Users can view the P&L statement by `year`, `quarter`, or `month`.
- **Filtering**: Data can be filtered by `country` and `currency`.

### 5.3.2. Data Presentation

- **P&L Statement**: A collapsible table that breaks down income and expenses into their constituent categories.
- **Trend Chart**: A line chart that visualizes trends in revenue, expenses, and net profit over the selected period.

## 5.4. Expense Tracking Page

This page is dedicated to analyzing user spending habits.

- **File Path**: `src/pages/reports/expenses.tsx`

### 5.4.1. Key Metrics

- **Total Expenses**: The sum of all expenses within the selected period.
- **Average Monthly Expense**: The total expenses divided by the number of months in the selected period.
- **Highest Spending Category**: The category with the most spending.

### 5.4.2. Visualizations and Data Breakdown

- **Expense Breakdown**: A pie chart showing the distribution of expenses across different categories.
- **Monthly Trends**: A line chart to track spending in selected categories over time.
- **Detailed Transaction List**: A table listing all transactions for a selected expense category.

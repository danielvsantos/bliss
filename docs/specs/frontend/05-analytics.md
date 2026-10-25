# 5. Analytics & Reporting

This document outlines the frontend implementation of the analytics and reporting features, covering the Dashboard, Expenses, and Financial Summary pages. These pages provide users with a comprehensive overview of their financial health.

## 5.1. Key Features

The analytics section is composed of three main pages:

- **Dashboard**: A high-level summary of key financial metrics.
- **Expenses Report**: A detailed breakdown of spending by category and over time.
- **Financial Summary Report**: A financial statement summarizing revenues, costs, and expenses.

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
| `ExpenseSplitCard` | `expense-split-card.tsx` | `currency: string, year?, className?` — always **debits − credits** per group (no toggle), via `lib/expense-breakdown.ts` (see §5.4.3) |
| `QuickActionsCard` | `quick-actions-card.tsx` | `actions: DashboardAction[], signals: UserSignals` |
| `RecentTransactionsCard` | `recent-transactions-card.tsx` | `className?` (self-contained, fetches own data, uses category emoji from API) |
| `SetupChecklist` | `setup-checklist.tsx` | `actions?: DashboardAction[]` (onboarding items from action registry) |

### 5.2.3. Styling Patterns

- **Glass cards**: Applied globally via `[data-slot="card"]` CSS selector in `index.css` — `background: rgba(255,255,255,0.68)`, `backdrop-filter: blur(20px) saturate(1.6)`, multi-layer shadows. Affects all Card components site-wide. (Light only: Bliss has no dark theme.)
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

- **Expense split** (#140): `buildExpenseBreakdown(aggregateExpenseGroups(data, EXPENSE_TYPES, 'net'), { maxSlices: 7 })`. Same definition and pie rule as the Expenses page default view (§5.4.3): group values and the total match it; only the slice count differs (7 here, 5 on the page). Net-credit groups are listed in a "Net credits" footnote; when every group is a net credit the card shows `expenseSplit.noNetSpend`. Colours come from `buildGroupColorMap()`, keyed on the untranslated group name, so a group has the same colour on both surfaces. The tooltip states the basis ("Debits − credits").
- **sparklineData**: Net worth per day from portfolio history — `(Asset.total + Investments.total) - abs(Debt.total)` (`netWorthFromEntry` in `src/lib/net-worth.ts`; the `Asset` block includes the Cash group, #144) — sampled to 30 points. `useDashboardMetrics.netWorth` (live, current year) uses the same formula over portfolio items: every non-debt item, cash included, minus `abs()` of debt.
- **previousNetWorth**: First sparkline data point (value ~3 months ago). Used to compute delta and percentage change.
- **mostRecentSync**: Latest `lastSync` across all enriched accounts.
- **Quick Actions**: Dynamically selected from the centralized action registry (see `specs/16-dashboard-actions.md`). Top 4 visible actions shown based on user state signals.

### 5.2.6. Empty State

When `netWorth === 0 && netIncome === 0 && accounts.length === 0`:
- Shows `SetupChecklist` prominently
- Displays "Your dashboard will come to life once you add some data."
- Year/currency selectors hidden

## 5.3. Financial Summary Page

This page offers a detailed financial summary statement, allowing for in-depth financial analysis.

- **File Path**: `src/pages/reports/financial-summary.tsx`

### 5.3.1. Filtering and Views

- **Time-Based Views**: Users can view the financial summary by `year`, `quarter`, or `month`.
- **Filtering**: Data can be filtered by `country` and `currency`.

### 5.3.2. Data Presentation

- **Financial Summary Statement**: A collapsible table that breaks down income and expenses into their constituent categories. Key metrics include Discretionary Income, Savings Capacity, and Net Savings.
- **Trend Chart**: A line chart that visualizes trends in revenue, expenses, and net savings over the selected period.

#### Other Activity rows (#139)

Below the **Other Activity** separator (Ventures, Transfers, Investments, Debt) the rows are balance-sheet movements, not income or spending:

- **No % of income** on any of these rows, on the section total or the expanded group rows (`isOtherActivitySection()` in `src/lib/financial-summary.ts`, derived from `FINANCIAL_STRUCTURE` key order).
- **Investments → "Net invested"** and **Debt → "Net debt repaid"** (`financialSummary.netInvested` / `financialSummary.netDebtRepaid`). Both sections carry `netFlow` metadata in `FINANCIAL_STRUCTURE`, and the page shows them as `debit − credit` via `toDisplayValue()`: buying an asset or paying down debt (a debit) is positive; selling, withdrawing, or a loan disbursement deposited by the bank (a credit) is negative. The flip applies to the total and to every group row.
- Net-flow values render in the neutral `text-primary` token whatever their sign — never `text-destructive`. Ventures and Transfers keep their existing sign and colour.
- Each net-flow header has an info icon with a keyboard-reachable tooltip (`financialSummary.netInvestedTooltip` / `financialSummary.netDebtRepaidTooltip`) explaining the sign. Clicking the icon does not toggle the row.
- Display only: `processAnalyticsIntoFinancialStatement` still stores `credit − debit` for Investments and Debt, and Discretionary Income, Savings Capacity and Net Savings never read either section.

## 5.4. Expense Tracking Page

This page is dedicated to analyzing user spending habits.

- **File Path**: `src/pages/reports/expenses.tsx`
- **Shared helper**: `src/lib/expense-breakdown.ts` (also used by the Dashboard `ExpenseSplitCard`, so the two can't drift apart)

### 5.4.1. Key Metrics

- **Total Expenses**: The signed sum of every group's expense for the selected period, types, countries and currency (§5.4.3). A sub-label names the active basis: "debits − credits" or "debits only".
- **Average Monthly Expense**: The total divided by the number of months in the selected period.
- **Highest Spending Category**: The largest positive group, or `N/A` when there is none.

Totals render in `text-negative`; a net-credit total (negative) renders in `text-positive` with a leading "−", like Financial Summary.

### 5.4.2. Visualizations and Data Breakdown

- **Expense Breakdown**: A pie chart of the positive groups (top 5 + "Other"). The "Other" slice/row is not clickable. Groups whose credits exceed debits are listed under the pie as **Net credits** (signed, `text-positive`) with the caption "Total includes {{amount}} of net credits". When groups exist but none is positive, the pie is replaced by "No net spend in this period".
- **Monthly Trends**: A line chart of the selected groups over time, plus a 6-month moving average per group (`lib/trend-utils.ts`). The group picker lists **every** group with activity (`allGroups`), including net-credit ones. Negative months plot below zero: `YAxis domain={['auto','auto']}` and a `ReferenceLine y={0}` when any plotted value is negative.
- **Detailed Transaction List**: A table listing all transactions for a selected expense group (§5.4.5).

### 5.4.3. Expense definition (#140)

**Expense = Σ debit − Σ credit**, per category group, summed across the selected expense types (Essentials / Lifestyle / Growth, or one of them). Netting is at **group level**: the analytics cache (`AnalyticsCacheMonthly`) is already per group, so a group with one credit-heavy category and larger spending categories stays positive. Credits booked to expense categories (refunds, reimbursements, a flatmate's share, insurance payouts) reduce spend; credits booked to Income categories do not.

`lib/expense-breakdown.ts`:

| Function | Purpose |
|----------|---------|
| `expenseValue(cell, basis)` | `debit − credit` (`'net'`) or `debit` (`'debit'`); missing fields count as 0 |
| `aggregateExpenseGroups(data, types, basis)` | group → signed value for the whole period |
| `aggregateExpenseGroupsByMonth(data, types, basis)` | month (ascending) → group → signed value, for the trend chart |
| `buildExpenseBreakdown(groups, { maxSlices, otherLabel })` | `total`, `shareTotal`, `slices`, `netCredits`, `highest`, `allGroups` |
| `readIncludeCredits()` / `writeIncludeCredits(v)` | the persisted toggle |

**Net-negative groups or months — never clamped to 0:**

- **Totals** (KPI cards, monthly totals, moving average) include negative values as they are, so the total equals Financial Summary.
- **Pie and share-of-total**: slices and percentages come only from positive groups; `shareTotal` (sum of positive groups) is the only denominator, including for "Other", which is built only from positive groups. No negative slice, NaN or >100% value is possible.
- **Trend chart**: negative points plot below zero.
- Values with `|v| < 0.005` are treated as 0 (float residue): neither a slice nor a net credit.

### 5.4.4. "Include credits" toggle

A switch in the filter bar, labelled "Include credits", with a tooltip explaining both states.

- **On (default)**: expense = debits − credits; every rule in §5.4.3 applies.
- **Off**: expense = debits only (values are never negative, so there are no net credits).
- One switch drives every figure: KPIs, pie, group list, trends, moving average, percentages and the Details tab. No mixed state.
- Persisted per browser in `localStorage['bliss.expenses.includeCredits']` (`'false'` = off). If storage is unavailable it falls back to on. (Moving it to user preferences for cross-device persistence is a possible follow-up; only the two storage helpers would change.)
- The Dashboard Expense Split has **no** toggle and always shows debits − credits.

### 5.4.5. Details tab (`components/entities/expense-transaction-list.tsx`)

- Category summary: per category and **per native currency**, `debit − credit` when the toggle is on, `debit` when off. Cells and the footer are coloured by sign (`text-positive` with "−" for a net credit, `text-negative` otherwise).
- Transactions view: each row shows `debit − credit`, coloured by its sign. With the toggle off, net-credit rows are de-emphasised (`opacity-60`) but still listed.
- **Reconciliation caveat**: the summary aggregates up to **1,000 transactions** client-side (the API's page cap), shows native currencies (not converted), and does **not** apply the page's country or type filters. It matches the chart only when the group has ≤ 1,000 transactions in the period, a single currency, and no country/type filter excludes any of them. When `total > transactions.length`, the notice "Showing the first 1,000 transactions; totals may be incomplete" is shown above the table. Moving this aggregation server-side is a follow-up.

### 5.4.6. Parity with other surfaces

| Surface | Definition | Matches the Expenses default view? |
|---------|------------|-------------------------------------|
| Expenses page, "Include credits" on | Σ debit − Σ credit per group | — |
| Expenses page, "Include credits" off | Σ debit | No, by design (gross spend) |
| Dashboard Expense Split | same helper, `'net'` basis | Yes: total and group values (slice count 7 vs 5) |
| Expenses Details tab | per-transaction `debit − credit` | Yes, within the §5.4.5 caveat |
| Financial Summary statement | signed `balance = credit − debit` per group | Yes: expense total = −Σ balance (within 0.01) |
| Financial Summary monthly chart (`lib/financial-summary.ts`) | `Math.abs(type total)` per type per month | **Differs** in a type-month that is a net credit (the chart shows it as positive spend). Candidate follow-up |
| AI insights spending lenses (`backend/src/services/insightService.js`) | `expenses = −Σ balance`, per group signed (never `abs()`) | Yes. `SPENDING_VELOCITY`, `CATEGORY_CONCENTRATION`, `UNUSUAL_SPENDING` and `SAVINGS_RATE` all read the same signed `monthlyData`. `CATEGORY_CONCENTRATION` percentages use the signed month total as denominator (net-credit groups are not excluded as they are from the pie) |
| MCP `get_spending_summary` | exposes `in` (credit), `out` (debit), `net` (`balance`) | Yes: expense = −`net` |
| Tag Analytics | shows credits and debits explicitly | Separate, unchanged |

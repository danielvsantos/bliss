# 6. Portfolio Management (Frontend)

This document outlines the frontend implementation of the portfolio management features, which include the main portfolio dashboard and the manual updates page.

## 6.1. Key Features

The portfolio management frontend is designed to give users a comprehensive and interactive view of their assets and liabilities. The key features are:

- **Portfolio Dashboard**: A detailed breakdown of all holdings, with performance metrics and historical charts.
- **Manual Updates Page**: A dedicated interface for users to provide prices for manually-tracked assets and to manage the terms of their debts.

These features are powered by a set of hooks that interact with the `/api/portfolio/` endpoints.

## 6.2. Portfolio Dashboard

The main portfolio dashboard provides a detailed overview of the user's assets and liabilities.

- **File Path**: `src/pages/reports/portfolio.tsx`

### 6.2.1. Data Presentation and Architecture

A key architectural feature of the portfolio dashboard is its reliance on **server-side calculations**. To ensure accuracy and performance, all currency conversions and complex financial calculations (e.g., historical cost basis) are handled by the backend services. The frontend is responsible for presentation only and performs no currency conversions.

- **Portfolio Currency**: Values are shown in the tenant's configured `portfolioCurrency` (default USD). When `portfolioCurrency !== 'USD'`, an additional `portfolio` block is present in the API response with converted values.
- **Assets and Liabilities**: The page clearly separates assets from liabilities, with each section showing a total value.
- **Grouped Holdings**: Within each section, holdings are grouped by their category (e.g., "US Stocks", "Crypto", "Mortgage").
- **Detailed Metrics**: For each asset, the dashboard displays USD-denominated values for:
    - Quantity
    - Market Price
    - Total Market Value
    - Cost Basis
    - Realized P&L
    - Unrealized P&L (both absolute and percentage)
    - Total ROI %
- **Debt Information**: For liabilities, the dashboard shows the principal balance and key terms like interest rate and loan duration.

### 6.2.2. Visualizations and Interactivity

- **Performance Chart**: A "Performance" tab displays a historical area chart of the user's net worth. Users can select time ranges via `TIME_RANGES`: 1M (1 month), 6M (6 months), 1Y (1 year), and ALL (full history). These are rendered as pill-shaped toggle buttons.
- **Filtering and Sorting**: Users can filter the list of assets by their symbol and sort the holdings table by various columns.
- **Equity Analysis**: Detailed stock equity analysis (P/E ratios, dividend yields, sector breakdowns) is documented in a separate spec (`19-security-master.md`).

### 6.2.3. Symbol-Level Aggregation ("All Accounts" view)

When the user selects **"All accounts"** from the account filter, the same ticker (e.g. `AAPL`) may appear in multiple API response rows — one per brokerage account. The page merges these into a single display row via `mergePortfolioItems()` / `mergeBySymbol()` **client-side** (no extra API call):

- **Grouping key**: `item.symbol` — all items with the same symbol are merged.
- **`quantity`**: summed across all per-account rows.
- **`hasLotMismatch`**: OR'd — true if any account has a mismatch.
- **`accountId`**: set to `null` on the merged row (no single account applies when merging across accounts).
- **Financial blocks** (`native`, `usd`, `portfolio`): each block is summed field-by-field (`costBasis`, `marketValue`, `unrealizedPnL`, `realizedPnL`, `totalInvested`). `unrealizedPnLPercent` is **recalculated** from the summed `unrealizedPnL / costBasis` — it is never averaged from individual rows, which would be incorrect.
- **`portfolio` block**: included only when at least one row has a `portfolio` block. If a row has no `portfolio` block its `usd` block is used as a substitute during summation so the merge remains currency-accurate.

When a specific account is selected, no merging occurs — raw per-account rows are displayed as-is.

### 6.2.4. Data Fetching

The dashboard uses the following hooks:
- `usePortfolioItems`: Fetches the current state of all portfolio items from `/api/portfolio/items`. Accepts optional filters: `assetType`, `source`, `accountId`, `countryId`. The API response contains a structured payload with pre-calculated financial summaries in both the asset's native currency and in USD, eliminating the need for any client-side conversion. Each item includes `accountId`, `account` (resolved name), and `hasLotMismatch` (data-quality flag).
- `usePortfolioHistory`: Fetches historical data for the performance chart from `/api/portfolio/history`. Accepts optional `accountId` to scope history to a single brokerage account.
- `usePortfolioHoldings`: Fetches historical daily `PortfolioHolding` records from `/api/portfolio/holdings`. Accepts optional filters: `account`, `countryId`, `category`, `categoryGroup`, `ticker`.
- `usePortfolioLots`: Fetches FIFO lot data for an individual asset. Accepts an `assetId` parameter and is only enabled when an asset is selected.
- `useEquityAnalysis`: Fetches equity risk metrics from `/api/portfolio/equity-analysis`, grouped by sector server-side and re-grouped client-side.
- `useMetadata`: Retrieves category definitions and other metadata.

#### Client-side caching (freshness window + persistence)

The `/api/portfolio/*` and `/api/portfolio/equity-analysis` endpoints recompute
live valuations on every request, fanning out to the metered Twelve Data API.
Without a freshness window each mount / navigation triggered a full recompute
for data that only changes on the nightly 3 AM UTC price refresh. Client-side
tuning (all in `apps/web`, no API/backend change — see `src/lib/query-config.ts`):

- **`PORTFOLIO_STALE_TIME_MS = 180_000`** (3 minutes) is set as `staleTime` on
  `usePortfolioItems`, `usePortfolioHoldings`, `usePortfolioHistory`, and
  `useEquityAnalysis` (and therefore on the `usePortfolioItems` call inside
  `useDashboardMetrics`). Within the window, remounting or navigating back to a
  portfolio view issues **zero** requests. `refetchOnMount` /
  `refetchOnWindowFocus` / `refetchOnReconnect` stay at their defaults (on), so
  a mount or tab refocus *after* the window still revalidates. Nothing polls —
  no `refetchInterval` is set anywhere.
- **Persistence to `localStorage`.** `persistQueryClient` in `lib/providers.tsx`
  dehydrates the four portfolio query roots (`portfolio-items`,
  `portfolio-holdings`, `portfolio-history`, `equity-analysis`) alongside
  `metadata` and `accounts`. After the user has loaded portfolio data once in a
  browser, a hard reload paints the last-known net-worth / holdings values with
  no loading skeleton, then background-revalidates. `shouldPersistPortfolioQuery`
  gates this on `status === 'success'` and a serialized-payload size cap
  (`PORTFOLIO_PERSIST_MAX_BYTES = 1_000_000`, ~1 MB); a query over the cap is
  simply not persisted and falls back to fetch-on-load. Cached values can be up
  to `gcTime` (24 h) old on cold paint — this is accepted; the value is always
  shown with the refresh indicator + a background refetch, with no age cutoff.
- **Refresh indicator.** Where a persisted value is on screen while its query is
  refetching with data already present (`isFetching && !isLoading`), an inline
  `Loader2` spinner (`h-4 w-4 animate-spin text-muted-foreground`) is rendered
  next to the value — the dashboard net-worth figure (`HeroNetWorth`, via
  `useDashboardMetrics` → `useUserSignals` → `dashboard.tsx`), the Portfolio page
  KPI total, and the Equity Analysis total. A first-ever load with no cached data
  keeps the existing `Skeleton` treatment (`isLoading`).
- **Mutation-driven invalidation.** `invalidatePortfolioQueries(queryClient)`
  invalidates all four roots so a change reflects immediately rather than waiting
  out the window. It is called after: manual value create/update/delete, debt
  terms edit, transaction add/edit, account create/delete, Plaid account link,
  and a portfolio-currency change.

## 6.3. Manual Updates & Debt Management Page

This page provides a centralized location for users to manage assets and liabilities that require manual input.

- **File Path**: `src/pages/manual-updates.tsx`

### 6.3.1. Manual Price Updates

- **Asset Identification**: The page automatically identifies all manually-tracked assets (`processingHint: 'MANUAL'`) that have not had a price update in over 30 days. These are listed in the "Action Required: Stale Prices" card.
- **All manually-priced assets**: A second card ("All manually-priced assets") lists **every** `MANUAL` asset with a positive quantity — stale or not — sorted by symbol, so the price history is always reachable.
- **Update Mechanism**: For each asset, the user is prompted to enter a new price through the `<ManualPriceForm />` component, which opens in a dialog.

### 6.3.1.1. Price History Modal

- **Component**: `src/components/entities/manual-price-history-dialog.tsx` (`<ManualPriceHistoryDialog />`).
- **Entry points**: A "View history" button on every stale-card row (beside "Update Price") and on every "All manually-priced assets" row. Reachable in ≤2 clicks, including for non-stale assets.
- **Data**: `useManualAssetValues(itemId)` (`src/hooks/use-manual-asset-values.ts`) wraps `GET /api/portfolio/items/{assetId}/manual-values` — returns every `ManualAssetValue` for the asset, newest first. Query key: `['manual-asset-values', itemId]`; disabled until `itemId` is set.
- **List columns**: Effective date, Price (currency-formatted per row), Currency, Notes, Recorded on (`createdAt`), row actions. Notes is hidden below `lg`, Recorded on below `md`; the table scrolls horizontally inside its bordered container on narrow widths. Dialog is `sm:max-w-3xl`, capped at `90vh` with its own vertical scroll.
- **Pagination**: client-side, `PAGE_SIZE = 12` (the API returns the full array). A Previous/Next control with a "Showing X–Y of N" label appears only when there are more than 12 entries; the page resets to 1 whenever the dialog opens or the asset changes.
- **Mixed currency**: Rows whose `currency` differs from the asset's base currency are flagged with a `warning`-token badge. **No FX conversion** is performed — each row is shown in its own stored currency. Price formatting goes through a guarded helper that falls back to `"<amount> <CODE>"` if the ISO code is malformed (legacy/imported rows).
- **States**: skeleton rows while loading; inline `Alert` + "Retry" on error; empty state with a "Record first price" button that opens `<ManualPriceForm />`.
- **Edit / delete**: The dialog uses an internal `list | add | edit` view switch (no nested `Dialog`s). Editing reuses `<ManualPriceForm existingValue={row} />` — in edit mode the currency default comes from the row (not the asset) so a save round-trips the original code; the form submits via `api.updateManualAssetValue(itemId, valueId, ...)`. Delete uses a shadcn `AlertDialog` confirmation, then `api.deleteManualAssetValue(itemId, valueId)`.
- **After any mutation**: invalidates `['manual-asset-values']` and calls `invalidatePortfolioQueries(queryClient)` (all four portfolio roots), shows a toast. The backend already emits `MANUAL_PORTFOLIO_PRICE_UPDATED` on create/update/delete, so portfolio revaluation is automatic.

### 6.3.2. Debt Terms Management

- **Liability Listing**: The page displays a table of all liabilities.
- **Terms Management**: Users can add or edit the terms of their loans (e.g., interest rate, amortization schedule) using the `<DebtTermsForm />` component. This information is crucial for the backend workers that process loan payments and calculate remaining balances.

## 6.4. Ticker Search & Resolution

### 6.4.1. Ticker Search Component

Investment transaction forms include a ticker search input with debounced autocomplete (300ms). The `useTickerSearch()` hook calls `GET /api/ticker/search?q={query}` and supports a `searchType` parameter:
- Default: searches stocks/funds via Twelve Data
- `searchType: 'crypto'`: searches crypto via Twelve Data with digital currency filtering (triggered when category `processingHint === 'API_CRYPTO'`)

### 6.4.2. Resolution Flow

1. User selects a result from the autocomplete dropdown
2. Frontend stores: `ticker`, `isin`, `exchange`, `assetCurrency`
3. Fields are submitted with the transaction and propagated through Transaction → PortfolioItem

### 6.4.3. Currency Mismatch Validation

When the selected ticker's `assetCurrency` differs from the account's currency:
- **Transaction form** (`transaction-form.tsx`): Blocking error prevents submission
- **Deep-dive drawer** (`deep-dive-drawer.tsx`): Non-blocking warning banner

### 6.4.4. Ticker Validation

Tickers must contain at least one letter. The frontend pre-populates ticker fields from raw transaction data (`deep-dive-drawer.tsx`) and validates before submission.

## 6.5. Portfolio Utility Functions (`lib/portfolio-utils.ts`)

Key utility functions used across portfolio pages:

| Function | Purpose |
|----------|---------|
| `getDisplayData(item, portfolioCurrency)` | Picks the correct financial block from a `PortfolioItem` response: uses the `portfolio` block when `portfolioCurrency !== 'USD'`, otherwise falls back to the `usd` block. |
| `buildGroupColorMap(assetGroups, debtGroups)` | Builds a `Record<string, string>` mapping category group names to dataviz hex colors. Groups are sorted alphabetically for deterministic assignment. Debt groups always use negative-family colors. |
| `getGroupColor(group, isDebt, index)` | Returns the hex color for a single category group. Debt groups use negative-family palette; asset groups use `dataviz-1` through `dataviz-8` tokens. |

These functions ensure consistent color assignment and currency-aware display across all portfolio visualizations.

## 6.6. Portfolio Currency Settings

The portfolio display currency is configurable per tenant via `GET/PUT /api/tenants/settings` (`portfolioCurrency` field). The settings page allows users to select from their configured currencies. When changed, the dashboard automatically reflects values in the new currency.

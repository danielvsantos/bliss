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
- **One shared cache entry for the item list.** `usePortfolioItems` canonicalizes
  its key params so `usePortfolioItems()` (dashboard net worth, via
  `useDashboardMetrics`) and `usePortfolioItems({})` (Portfolio page) resolve to
  the **same** entry — `["portfolio-items", {}]`. Without this they hashed to
  `["portfolio-items", null]` vs `["portfolio-items", {}]` and, once each was
  cached/persisted independently, could display different net-worth numbers on
  the two pages until a revalidation trigger fired. `accountId: null` (manual-only
  assets) is still a distinct key; only `undefined` / absent params are dropped.
- **Persistence to `localStorage`.** `persistQueryClient` in `lib/providers.tsx`
  dehydrates the four portfolio query roots (`portfolio-items`,
  `portfolio-holdings`, `portfolio-history`, `equity-analysis`) alongside
  `metadata` and `accounts`. After the user has loaded portfolio data once in a
  browser, a hard reload paints the last-known net-worth / holdings values with
  no loading skeleton, then background-revalidates. `shouldPersistPortfolioQuery`
  gates this on `status === 'success'`, **non-empty content** (a transient empty
  response during app boot is not pinned — it would otherwise paint "net worth 0"
  on every reload until `staleTime` elapsed), and a serialized-payload size cap
  (`PORTFOLIO_PERSIST_MAX_BYTES = 1_000_000`, ~1 MB); a query that fails any gate
  is not persisted and falls back to fetch-on-load. Cached values can be up
  to `gcTime` (24 h) old on cold paint — this is accepted; the value is always
  shown with the refresh indicator + a background refetch, with no age cutoff.
- **Cold-load revalidation.** Once the persister finishes rehydrating on a page
  load, `markPortfolioQueriesStale(queryClient)` marks the four roots stale with
  `refetchType: 'none'` (no request fired then). The cached values paint
  instantly and the first mount does exactly one background refresh — so the
  "cold reload → background refresh" contract holds regardless of how recently
  the value was persisted. In-app navigation afterwards is governed normally by
  `staleTime` (this runs once per page load, not per route change).
- **Refresh indicator.** Where a persisted value is on screen while its query is
  refetching with data already present (`isFetching && !isLoading`), an inline
  `Loader2` spinner (`h-4 w-4 animate-spin text-muted-foreground`) is rendered
  next to the value — the dashboard net-worth figure (`HeroNetWorth`, via
  `useDashboardMetrics` → `useUserSignals` → `dashboard.tsx`), the Portfolio page
  KPI total, and the Equity Analysis total. A first-ever load with no cached data
  keeps the existing `Skeleton` treatment (`isLoading`).
- **Mutation-driven invalidation.** `invalidatePortfolioQueries(queryClient)`
  invalidates all four roots (plus the non-persisted Manage Assets list,
  `portfolio-assets`) so a change reflects immediately rather than waiting
  out the window. It is called after: manual value create/update/delete, debt
  terms edit, transaction add/edit, account create/delete, Plaid account link,
  and a portfolio-currency change.

## 6.3. Manage Assets Page (#81)

One page for every asset and liability and every piece of asset data the user edits by hand: manual prices (and their history), debt terms, income terms (#77) and the asset class override (#79). It replaces **Asset Price Updates** (`/manual-updates`).

- **Route**: `/assets` — `src/pages/assets.tsx` (`ManageAssetsPage`). Sidebar / Header label `nav.manageAssets`.
- **Redirect**: `/manual-updates` renders `src/pages/manual-updates-redirect.tsx` → `<Navigate to={`/assets${location.search}`} replace />`, so old bookmarks and deep links keep working.
- **Deep links**: `?item=<portfolioItemId>&modal=income|price|history|debt|assetClass` opens that modal. Opening a modal from the list writes these params; closing removes them (`replace`). The Portfolio holdings liability row's "Add/Edit terms" navigates to `/assets?item=<id>&modal=debt`; the holdings "Income terms" action still opens the Income Terms modal in place.

### 6.3.1. List

- **Needs attention first.** `AttentionSummary` (`components/manage-assets/attention-summary.tsx`) sits above the list: "N items need your attention" with one card per action status that has rows (Prices to update · Loans without terms · Missing income terms · Lot mismatches to review) and its count from `statusCounts`. Tapping a card sets that status filter (tap again to clear); the price card uses the destructive tone, the others warning. With nothing to fix it shows a positive "All caught up" state. The last counts are kept while a new filter loads. The list defaults to `sort=attention` (critical → warning → stale prices, then debt terms, income terms, lot mismatch, then A–Z); a Sort select offers "A–Z". Rows with `needsAttention` get a `border-l-warning` accent. Each problem row shows its fix as a visible button (`PrimaryActionButton`, from `primaryAction()` in `lib/manage-assets.ts`): Update price · Add debt terms · Add income terms. A lot mismatch has no button (it needs the missing transactions). The ⋯ menu keeps every action.

- **Data**: `useManageAssets(filters)` (`src/hooks/use-manage-assets.ts`) — a `useInfiniteQuery` over `GET /api/portfolio/assets` (50 rows per page, `nextCursor`). Query key root `portfolio-assets`: invalidated by `invalidatePortfolioQueries()` (via `PORTFOLIO_INVALIDATE_ONLY_ROOTS`), the Passive Income mutations and `useSetAssetClass`, but **never persisted** to `localStorage`.
- **First load**: one request for list rows only. No manual-value history, no live pricing (values are the stored `currentValue`, converted to the portfolio currency by the API).
- **Filters (all server-side)**: search (symbol or SecurityMaster name, 300 ms debounce), type (category group, options from `facets.groups`), account (`facets.accounts`), asset class (the 12 `ASSET_CLASSES`), "Show closed positions" (`includeClosed`; debts always show). Status filter chips with counts: action statuses first (Price stale · Debt terms missing · Income terms missing · Lot mismatch), a divider, then the muted informational ones (Dividend override · Asset class overridden). Single-select, `aria-pressed`.
- **Row**: symbol, SecurityMaster name / category / account, asset class badge (not on debts), status chips, value in the portfolio currency (negative in `text-negative`), and an overflow menu (`AssetActionsMenu`) with the actions that apply (`availableModals()` in `src/lib/manage-assets.ts`):
  - `MANUAL` non-debt → Update price, Price history
  - `Category.type === 'Debt'` → Add/Edit terms
  - income-capable (`incomeAssetClass != null`) → Income terms
  - every non-debt → Asset class
- **Status chips (per row, `AssetStatusChips`)**: stale price (`Nd old · Stale|Warning|Critical`, or "No price yet"; thresholds 30/60/90 days — `MANUAL_PRICE_*` in `lib/manage-assets.ts`, mirrored from `@bliss/shared/portfolio`), debt terms missing (amortizing loan without terms), income terms missing (`incomeDataStatus === 'MISSING'`), lot mismatch — all warning / destructive tokens. Dividend override and asset class overridden are informational and rendered as muted tags (`bg-muted text-muted-foreground`) so they never compete with problems. Design tokens only.
- **Pagination**: "Load more" button (chosen over infinite scroll: simpler, screen-reader friendly).
- **Detached income terms banner** (`components/manage-assets/detached-terms-banner.tsx`): shown when `detachedTermsCount > 0`. "Review" loads `GET /api/portfolio/income-terms/detached` (`useDetachedIncomeTerms`) and renders the Passive Income page's `DetachedTermsSection` (re-attach to a holding / discard).
- **Mobile (< 768 px, `useIsMobile`)**: cards instead of the table, the same overflow menu per card, filters behind `MobileFilterDrawer` (search and status chips stay visible; chips scroll horizontally inside their own row), every modal is a full-screen sheet (`MOBILE_SHEET_CLASSES`). No horizontal page scroll at 375 px.

### 6.3.2. Modals (each loads its own data)

| Modal | Component | Loads | Saves |
|-------|-----------|-------|-------|
| Update price | `components/entities/manual-value-modal.tsx` → `<ManualPriceForm />` | — (asset id/symbol/currency from the row) | `POST /api/portfolio/items/{id}/manual-values` (unchanged) |
| Price history | `<ManualPriceHistoryDialog />` (§6.3.4) | `GET …/manual-values` | `PUT`/`DELETE …/manual-values/{valueId}` (unchanged) |
| Debt terms | `components/entities/debt-terms-modal.tsx` → `<DebtTermsForm />` | `GET …/debt-terms` (`useDebtTerms`; 404 → empty form) | `POST …/debt-terms` (unchanged) |
| Income terms | `<IncomeTermsModal mode="asset" />` (#77) | `GET …/income-terms` | `PUT`/`DELETE …/income-terms` |
| Asset class | `components/entities/asset-class-modal.tsx` | `GET …/asset-class` (`useAssetClassInfo`) | `PUT …/asset-class` with `applyToSymbol: true` (same as Equity Analysis) |

The forms take an `AssetRef` (`Pick<PortfolioItem, 'id' | 'symbol' | 'currency'>` + optional `debtTerms`) so a list row or a full `PortfolioItem` both work. A deep link to an item that is not in the loaded pages (or outside the current filters) is resolved with `GET /api/portfolio/assets?id=<id>&includeClosed=true` (`useManagedAsset`).

### 6.3.3. Manual price and debt terms behaviour

Unchanged from Asset Price Updates: the manual price form defaults to the asset's currency (locked), saves `YYYY-MM-DD`, invalidates `['manual-asset-values']` and all portfolio roots; the debt terms form validates balance / rate / term / origination date and posts to `debt-terms`. The backend emits `MANUAL_PORTFOLIO_PRICE_UPDATED` / the debt-terms events exactly as before.

### 6.3.4. Price History Modal

- **Component**: `src/components/entities/manual-price-history-dialog.tsx` (`<ManualPriceHistoryDialog />`).
- **Entry point**: the "Price history" item in the row overflow menu of every `MANUAL` asset (`?modal=history`). Reachable in 2 clicks, stale or not.
- **Data**: `useManualAssetValues(itemId)` (`src/hooks/use-manual-asset-values.ts`) wraps `GET /api/portfolio/items/{assetId}/manual-values` — returns every `ManualAssetValue` for the asset, newest first. Query key: `['manual-asset-values', itemId]`; disabled until `itemId` is set.
- **List columns**: Effective date, Price (currency-formatted per row), Currency, Notes, Recorded on (`createdAt`), row actions. Notes is hidden below `lg`, Recorded on below `md`; the table scrolls horizontally inside its bordered container on narrow widths. Dialog is `sm:max-w-3xl`, capped at `90vh` with its own vertical scroll; a full-screen sheet below `sm`.
- **Pagination**: client-side, `PAGE_SIZE = 12` (the API returns the full array). A Previous/Next control with a "Showing X–Y of N" label appears only when there are more than 12 entries; the page resets to 1 whenever the dialog opens or the asset changes.
- **Mixed currency**: Rows whose `currency` differs from the asset's base currency are flagged with a `warning`-token badge. **No FX conversion** is performed — each row is shown in its own stored currency. Price formatting goes through a guarded helper that falls back to `"<amount> <CODE>"` if the ISO code is malformed (legacy/imported rows).
- **States**: skeleton rows while loading; inline `Alert` + "Retry" on error; empty state with a "Record first price" button that opens `<ManualPriceForm />`.
- **Edit / delete**: The dialog uses an internal `list | add | edit` view switch (no nested `Dialog`s). Editing reuses `<ManualPriceForm existingValue={row} />` — in edit mode the currency default comes from the row (not the asset) so a save round-trips the original code; the form submits via `api.updateManualAssetValue(itemId, valueId, ...)`. Delete uses a shadcn `AlertDialog` confirmation, then `api.deleteManualAssetValue(itemId, valueId)`.
- **After any mutation**: invalidates `['manual-asset-values']` and calls `invalidatePortfolioQueries(queryClient)` (all four portfolio roots), shows a toast. The backend already emits `MANUAL_PORTFOLIO_PRICE_UPDATED` on create/update/delete, so portfolio revaluation is automatic.

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

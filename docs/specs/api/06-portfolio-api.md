# 6. Portfolio API Endpoints

This document provides the specifications for the Portfolio API endpoints, which are responsible for serving portfolio data to the frontend.

## 6.1. General Principles

The Portfolio API is divided into four main endpoints, each serving a distinct purpose:

-   **`GET /api/portfolio/items`**: Fetches the current, real-time state of all portfolio items.
-   **`GET /api/portfolio/holdings`**: Retrieves historical, daily snapshots of portfolio holdings.
-   **`GET /api/portfolio/history`**: Provides aggregated historical data for performance charting.
-   **`GET /api/portfolio/equity-analysis`**: Returns stock and ETF holdings grouped by sector, industry, country or asset class (sector/country look through ETFs), enriched with SecurityMaster fundamentals, plus the Portfolio composition by asset class and the Fixed income summary.
-   **`PUT /api/portfolio/items/{assetId}/asset-class`**: Sets or clears a holding's asset class override.

All endpoints are authenticated and tenant-aware.

## 6.2. Get Portfolio Items

This is the primary endpoint for the portfolio dashboard, providing a real-time view of all assets and liabilities.

-   **Endpoint**: `/api/portfolio/items`
-   **Method**: `GET`

### 6.2.1. Logic

This endpoint fetches all `PortfolioItem` records for the user and enriches them with real-time data. A key aspect of its logic is how it determines the current value of an asset:

-   For assets with a `processingHint` of `API_STOCK`, `API_FUND`, or `API_CRYPTO`, it calls the `calculateAssetCurrentValue` service to get a live, up-to-the-minute price.
-   For all other assets (e.g., `MANUAL`), it trusts the `currentValue` field on the `PortfolioItem` model, which is calculated and updated by the backend valuation worker.

The API performs a final set of calculations to derive unrealized P&L and then restructures the data for the frontend.

**MANUAL-source skip**: When `asset.source === 'MANUAL'` (e.g., manually-tracked funds without real tickers), live price fetching is skipped entirely. The stored `currentValue` from the valuation worker is used as-is.

**Within-request live-price deduplication**: Per-account portfolio items mean the same ticker (e.g. `AAPL`) can appear in multiple rows — one per brokerage account. Without deduplication each row would fire its own request to the backend pricing endpoint, wasting TwelveData API credits and slowing the response. Before the enrichment loop, the endpoint performs a single **prefetch phase**:

1. Filter to API-priced assets (`API_STOCK`, `API_FUND`, `API_CRYPTO`) with `quantity > 0` and `source !== 'MANUAL'`.
2. Deduplicate by cache key: `${symbol}::${processingHint}::${assetCurrency||currency}::${exchange||''}`.
3. Fire one `calculateAssetCurrentValue()` call per unique key via `Promise.all`.
4. Store results in a `Map<cacheKey, Decimal|null>`.

The enrichment loop then reads from this map instead of making individual calls per item. Two items sharing the same (symbol, hint, currency, exchange) tuple receive the same live price — which is correct, since they track the same instrument.

**Cross-currency price handling**: When the live price comes back in a currency different from the account currency (e.g., AAPL trades in USD but account is EUR), the endpoint converts directly from price currency to avoid double-conversion:

```
priceCurrency = asset.assetCurrency || asset.currency

native block:  convert(marketValue, priceCurrency → asset.currency)
usd block:     convert(marketValue, priceCurrency → 'USD')
```

### 6.2.1a. Real-Time Pricing (`services/valuation.service.js`)

`calculateAssetCurrentValue(asset)` fetches live prices from the backend for portfolio page loads:

1. Builds URL: `GET /api/pricing/prices?symbol={symbol}&assetType={hint}&currency={currency}&exchange={exchange}`
2. Currency param: `asset.assetCurrency || asset.currency` (falls back to account currency for crypto)
3. Exchange param: `asset.exchange` (ISO-10383 MIC code, e.g. `XPAR`). Sent when available to disambiguate multi-listed symbols. The `exchange` field is selected from the `PortfolioItem` alongside `assetCurrency`.
4. Returns `Decimal` price per unit, or falls back to cost-basis on failure

### 6.2.2. Query Parameters

| Parameter               | Type     | Description                                              | Default |
|-------------------------|----------|----------------------------------------------------------|---------|
| `assetType`             | `string` | Filters items by the category `type`.                    |         |
| `source`                | `string` | Filters items by their data source.                      |         |
| `include_manual_values` | `string` | When `'true'`, includes the most recent `ManualAssetValue` record for each item. |         |
| `accountId`             | `string` | Filters by brokerage account ID. |         |
| `countryId`             | `string` | Filters by the ISO country code of the brokerage account (e.g. `"US"`, `"GB"`). Based on `Account.countryId`, not the equity's listed country. |         |

### 6.2.3. Response Format

The endpoint returns a wrapped object: `{ portfolioCurrency: string, items: PortfolioItem[] }`. Each item is structured with nested `native`, `usd`, and optional `portfolio` blocks. The `portfolio` block contains values converted to the tenant's `portfolioCurrency` (only present when `portfolioCurrency !== 'USD'`). This format eliminates the need for any currency conversion on the client side.

**Example `PortfolioItem` Response Object:**

```json
{
  "id": 123,
  "symbol": "AAPL",
  "currency": "USD",
  "quantity": 10,
  "accountId": 7,
  "hasLotMismatch": false,
  "category": {
    "name": "US Stocks",
    "group": "Stocks",
    "type": "Investments",
    "icon": "..."
  },
  "native": {
    "costBasis": 1500.00,
    "marketValue": 1800.00,
    "unrealizedPnL": 300.00,
    "unrealizedPnLPercent": 20.00,
    "realizedPnL": 50.00,
    "totalInvested": 1450.00
  },
  "usd": {
    "costBasis": 1500.00,
    "marketValue": 1800.00,
    "unrealizedPnL": 300.00,
    "unrealizedPnLPercent": 20.00,
    "realizedPnL": 50.00,
    "totalInvested": 1450.00
  }
}
```

The fields within the `native` and `usd` blocks are derived from the new `costBasisInUSD`, `currentValueInUSD`, `realizedPnLInUSD`, and `totalInvestedInUSD` fields on the `PortfolioItem` model, which are maintained by the backend workers.

## 6.3. Get Portfolio Holdings

This endpoint provides a paginated list of historical, daily `PortfolioHolding` records.

-   **Endpoint**: `/api/portfolio/holdings`
-   **Method**: `GET`

### 6.3.1. Query Parameters

| Parameter       | Type     | Description                                | Default |
|-----------------|----------|--------------------------------------------|---------|
| `ticker`        | `string` | Filters by the asset's symbol.             |         |
| `category`      | `string` | Filters by the category `name`.            |         |
| `categoryGroup` | `string` | Filters by the category `group`.           |         |
| `account`       | `number` | Filters by brokerage account ID.           |         |
| `countryId`     | `string` | Filters by the ISO country code of the brokerage account. |         |
| `page`          | `number` | The page number for pagination.            | `1`     |
| `pageSize`      | `number` | The number of items per page.              | `100`   |

## 6.4. Get Portfolio History

This endpoint provides aggregated historical data, primarily for use in the performance chart.

-   **Endpoint**: `/api/portfolio/history`
-   **Method**: `GET`
### 6.4.1. Logic

The endpoint fetches daily records from the `PortfolioValueHistory` table, aggregates the `valueInUSD` for each day based on the asset's category `type`, and returns a time-series array.

#### Staleness Check (Background Revaluation Trigger)

Before processing the main query, the endpoint checks if the most recent `PortfolioValueHistory` record for the tenant is before today's date. If stale, it fires a `PORTFOLIO_STALE_REVALUATION` event (via `produceEvent()`) in a fire-and-forget fashion. The response returns existing data immediately without waiting for revaluation; the next page load/refetch will have fresh data.

This check is non-blocking: errors are caught silently and never delay the GET response. The backend debounces the event at 30 minutes per tenant to prevent rapid re-triggers from multiple page refreshes.

**Purpose:** This serves as a fallback for self-hosters who may not have the nightly cron job running reliably. In typical deployments, the nightly `revalue-all-tenants` job (4 AM UTC) keeps history current and this check is a no-op.

### 6.4.2. Query Parameters

| Parameter    | Type     | Description                                                                 | Default                |
|--------------|----------|-----------------------------------------------------------------------------|------------------------|
| `from`       | `string` | The start date in ISO 8601 format.                                          | Earliest history record |
| `to`         | `string` | The end date in ISO 8601 format.                                            | Today                  |
| `type`       | `string` | Comma-separated category types to filter by (e.g., `Investments,Asset`).    |                        |
| `group`      | `string` | Comma-separated category groups to filter by.                               |                        |
| `accountId`  | `number` | Restricts history to a single brokerage account.                            |                        |
| `resolution` | `string` | Data resolution: `daily`, `weekly`, or `monthly`. Overrides auto-detection. |                        |

### 6.4.3. Auto-Resolution System

When `resolution` is not explicitly provided, it is auto-detected based on the date range:

- **Daily** for ranges <= 90 days (all dates returned).
- **Weekly** for ranges <= 365 days (Saturdays sampled, ~52 data points).
- **Monthly** for ranges > 365 days (last calendar day of each month).

This keeps Prisma query row counts bounded regardless of portfolio size.

### 6.4.4. Response Format

The endpoint returns a wrapped object: `{ portfolioCurrency: string, resolution: string, history: AggregatedPortfolioHistory[] }`. The `resolution` field indicates the effective resolution used (e.g., `'daily'`, `'weekly'`, `'monthly'`). Each history entry includes `totalUSD` and optional `totalPortfolioCurrency` (when `portfolioCurrency !== 'USD'`).

---

## 6.5. Manual Value Management

### `GET /api/portfolio/items/{assetId}/manual-values`
- **Responsibility**: Returns **all** `ManualAssetValue` records for a specific asset, ordered by `date` descending (newest first).
- **Response shape**: Each row is the full model — `id` (cuid string), `date`, `value` (serialized Decimal → string), `currency` (ISO 4217, stored per row), `notes` (nullable), `createdAt`, `updatedAt`. `createdAt` reflects when the row was keyed in and can differ from the backdated `date`. The frontend "Price history" modal consumes this endpoint directly.

### `POST /api/portfolio/items/{assetId}/manual-values`
- **Responsibility**: Adds a new manual price point for a specific asset. Accepts `date`, `value`, `currency`, and optional `notes`.
- **Event Emission**: After successfully creating the `ManualAssetValue` record, it dispatches a `MANUAL_PORTFOLIO_PRICE_UPDATED` event to the backend. This event contains the `portfolioItemId`, which allows the `portfolioWorker` to efficiently target and recalculate only the affected item.

### `PUT /api/portfolio/items/{assetId}/manual-values/{valueId}`
- **Responsibility**: Updates an existing manual price point. `{valueId}` is the row's **cuid string** (not an integer). Any subset of `date`, `value`, `currency`, `notes` may be supplied.
- **Event Emission**: Dispatches `MANUAL_PORTFOLIO_PRICE_UPDATED` after update.

### `DELETE /api/portfolio/items/{assetId}/manual-values/{valueId}`
- **Responsibility**: Removes a manual price point. `{valueId}` is the row's **cuid string**. Returns `204 No Content` on success.
- **Event Emission**: Dispatches `MANUAL_PORTFOLIO_PRICE_UPDATED` after deletion.

---

## 6.6. Debt Terms Management

### `GET /api/portfolio/items/{assetId}/debt-terms`
- **Responsibility**: Returns the `DebtTerms` record for a liability portfolio item (interest rate, principal, term, origination date).

### `POST /api/portfolio/items/{assetId}/debt-terms`
- **Responsibility**: Creates or upserts debt terms for a liability. Fields: `initialBalance`, `interestRate`, `termInMonths`, `originationDate`.
- **Validation**: All four fields are required. The asset must be of type `Debt`.

### `PUT /api/portfolio/items/{assetId}/debt-terms`
- **Responsibility**: Updates existing debt terms for a liability. Accepts partial updates (only changed fields).

---

## 6.7. Equity Analysis

### `GET /api/portfolio/equity-analysis`

Provides a breakdown of the user's stock holdings grouped by a configurable dimension, enriched with live prices and SecurityMaster fundamentals (P/E ratio, dividend yield, EPS, 52-week range).

- **Auth**: JWT (cookie-based), rate limited via `rateLimiters.portfolio`.
- **Query Parameters**:

| Parameter   | Type     | Description                                        | Default  |
|-------------|----------|----------------------------------------------------|----------|
| `groupBy`     | `string` | Grouping returned in `groups`: `sector`, `industry`, `country`, or `assetClass`. | `sector` |
| `lookThrough` | `string` | `false` shows every ETF as one `Diversified` bucket (pre-#79 behaviour). | `true` |
| `accountId`   | `number` | Restricts analysis to a single brokerage account.  |          |

- **Response**: `{ portfolioCurrency, lookThrough, summary: { totalEquityValue, holdingsCount, weightedPeRatio, weightedDividendYield }, groups, groupings: { sector, industry, country, assetClass }, holdings, composition, fixedIncome }`.
  - Each group contains `name`, `totalValue`, `holdingsCount`, `weight`, and the `holdings` contributing to it. `groupings` carries every dimension so the client switches tabs without refetching.
  - `holdings` lists every equity holding **once** (largest first) — render rows from it, because with look-through an ETF sits in several groups. Each holding carries `assetClass`, `assetClassSource` (`OVERRIDE` | `AUTO`), `autoAssetClass`, `itemIds` (merged portfolio item ids) and, for ETFs, the normalized `composition`.
  - `composition`: `[{ assetClass, value, percent (0–100), count }]` across **every** investment item with a positive quantity (stocks, ETFs, funds, bonds, real estate, crypto, …; cash and debt excluded, matching net worth). Equity holdings use their live value; everything else the stored valuation converted to the portfolio currency.
  - `fixedIncome`: `{ totalFace, weightedCouponPct, avgYearsToMaturity, governmentPct, corporatePct, count }` over `GOV_BOND` / `CORP_BOND` items with `IncomeTerms.faceValuePerUnit`, face-weighted; `null` without bonds.
- **Scope (equity views)**: `API_STOCK` items plus `API_FUND` items that SecurityMaster identifies as ETFs, with positive quantity. Mutual funds, crypto and manual assets are excluded from the equity views (they still count in `composition`).
- **Asset classes (#79)**: every item is classified by the shared `classifyAssetClass()` in `@bliss/shared/portfolio` — the same function the backend uses — so the API and insights never disagree. Order (first match wins): user override → bond issuer type from `IncomeTerms` / government or corporate bond category → real estate, crypto, cash categories → SecurityMaster `REIT` → SecurityMaster `ETF` (`BOND_ETF` when composition bonds ≥ 50% or, without composition, a bond-like name; `SECTOR_ETF` when the largest sector ≥ 75%; else `INDEX_ETF`) → `API_STOCK` → `STOCK` → `API_FUND` → `FUND` → `OTHER`. Commodities (API_STOCK hint) are `OTHER`.
- **ETF look-through (#79)**: for `sector` and `country`, `lookThrough()` from `@bliss/shared/portfolio` spreads each `INDEX_ETF` / `SECTOR_ETF` value by its `SecurityMaster.etfComposition` weights; `1 − Σweights` goes to `Other`. No composition (or an empty country list, e.g. QQQ) → `Diversified`. Bond ETFs go to `Fixed Income` so they never inflate an equity sector. `industry` is never looked through. Weighted P/E and dividend yield are unchanged.
- **Cross-account dedup**: When the same ticker is held in multiple brokerage accounts, the API merges those rows by symbol before grouping — quantities and market values are summed. SecurityMaster data (sector, P/E, etc.) is per-symbol and is therefore identical across accounts. An `OVERRIDE` asset class wins the merge. This ensures each ticker appears exactly once in `holdings` regardless of how many accounts hold it.

### `GET /api/portfolio/items/{assetId}/asset-class`

- **Responsibility**: The current classification of one item, for the Manage Assets asset class modal (#81): `{ assetClass, assetClassSource, autoAssetClass }`. Same inputs as `PUT` (category, SecurityMaster type/name/composition, income terms issuer type); 404 outside the tenant.

### `PUT /api/portfolio/items/{assetId}/asset-class`

- **Responsibility**: Sets or clears (`assetClass: null`) `PortfolioItem.assetClassOverride` (#79). Validated against `ASSET_CLASSES`; the item must belong to the tenant (404 otherwise). `applyToSymbol: true` updates every holding of the same symbol in the tenant (the web always sends it, since Equity Analysis merges them).
- **Response**: `{ assetClass, assetClassSource, autoAssetClass, updatedCount }`.
- **No background job**: Equity Analysis classifies on read. A portfolio rebuild that re-keys the item carries the override to the replacement (`income-terms-preserver.js`).

---

## 6.8. Ticker Resolution

### `GET /api/ticker/search?q={query}&type={type}`
- **Responsibility**: Proxies ticker search to the backend service. All searches route to Twelve Data; `type=crypto` filters and deduplicates for digital currency symbols.
- **Auth**: JWT (cookie-based)
- **Response**: `{ results: [{ symbol, name, exchange, country, currency, type, mic_code }] }`

### Ticker Resolution Flow

1. User types in ticker input → frontend calls `GET /api/ticker/search?q={query}` (debounced 300ms)
2. Finance-API proxies to backend `GET /api/ticker/search?q={query}` (API key auth)
3. User selects from autocomplete → frontend stores `ticker`, `isin`, `exchange`, `assetCurrency`
4. Fields propagated through Transaction → PortfolioItem on upsert

### Ticker Validation

Multi-layer `/[a-zA-Z]/` regex validation — tickers must contain at least one letter.

**Validation points**:

| Layer | File |
|-------|------|
| Row override | `pages/api/imports/[id]/rows/[rowId].js` |
| Import commit | `pages/api/imports/[id].js` |
| Plaid promote | `pages/api/plaid/transactions/[id].js` |
| Transaction API | `pages/api/transactions/index.js` |

### Currency Mismatch Validation

Three-layer validation prevents asset currency from differing from account currency:
1. **Form-level blocking** (`transaction-form.tsx`): Error message prevents submission
2. **Drawer warning** (`deep-dive-drawer.tsx`): Non-blocking banner
3. **API defensive conversion** (`portfolio/items.js`): Server-side handling

---

## 6.9. Portfolio Currency

### Settings API

`GET /api/tenants/settings` returns `portfolioCurrency` (default `'USD'`).
`PUT /api/tenants/settings` accepts `portfolioCurrency` — validated against tenant's `TenantCurrency` list.

### On-the-fly Conversion (`utils/currencyConversion.js`)

Portfolio values are stored in USD. Conversion happens at query time:

**`convertCurrency(amount, fromCurrency, toCurrency, date?)`** — Returns `Decimal` or `null`. Queries `CurrencyRate` table for direct rate, then inverse. Forward-fill: searches up to 7 days before the target date. Same-currency returns amount as-is.

**`batchFetchRates(fromCurrency, toCurrency, dateStrings)`** — Returns `Map<string, Decimal>` (date → rate). Efficient bulk lookup for the history endpoint. Same-currency returns `Decimal(1)` for all dates.

---

## 6.10. Schema: Multi-Market Fields

| Table | Field | Type | Purpose |
|-------|-------|------|---------|
| `Tenant` | `portfolioCurrency` | String (default `'USD'`) | Display currency for portfolio views |
| `Transaction` | `isin` | String? | System-resolved ISIN |
| `Transaction` | `exchange` | String? | ISO-10383 MIC code |
| `Transaction` | `assetCurrency` | String? | Asset's trading currency |
| `PortfolioItem` | `accountId` | Int? | FK to the brokerage account; set for all transaction-derived items |
| `PortfolioItem` | `hasLotMismatch` | Boolean | `true` when FIFO lot processing produces a negative quantity (sell with no matching buy in this account). Surfaced as a data-quality warning. |
| `PortfolioItem` | `isin` | String? | Propagated from first transaction |
| `PortfolioItem` | `exchange` | String? | Propagated from first transaction |
| `PortfolioItem` | `assetCurrency` | String? | Propagated from first transaction |

---

## 6.11. Default Categories

| Code | Name | Group | Type | ProcessingHint |
|------|------|-------|------|---------------|
| `FUNDS` | Funds | Funds | Investments | `API_FUND` (changed from `MANUAL`) |
| `ETFS` | ETFs | Equities | Investments | `API_FUND` |
| `COMMODITIES` | Commodities | Commodities | Investments | `API_STOCK` |

The `Funds` hint change from `MANUAL` to `API_FUND` enables automatic pricing via Twelve Data. The `API_FUND` strategy has a graceful manual fallback for funds without resolvable tickers.

---

## 6.12. Investment Enrichment Flow

### INVESTMENT_HINTS Constants

`API_FUND` is included in investment detection sets across:
- `plaidProcessorWorker.js` (backend) — flags transactions as `requiresEnrichment: true`
- `pages/api/plaid/transactions/[id].js` (promote endpoint) — validates investment metadata
- `deep-dive-drawer.tsx` (frontend) — shows enrichment form

### Crypto Asset Currency

For crypto categories (`processingHint === 'API_CRYPTO'`), `assetCurrency` is set from the **account/transaction currency** (not the search result). This ensures:
- Ticker search returns base symbols (e.g., `BTC`) without currency
- Price pair is constructed at fetch time using account currency (e.g., `BTC/EUR`)
- No currency mismatch between asset and account

---

## 6.13. Portfolio API Tests

| Suite | File | Tests | Coverage |
|-------|------|-------|----------|
| Unit | `tenant-settings.test.ts` | 8 | GET/PUT portfolioCurrency, validation, RBAC |
| Unit | `currencyConversion.test.ts` | 7 | Direct/inverse rates, forward-fill, batch |
| Integration | `ticker-search.test.ts` | 6 | Proxy auth, validation, response |

---

## 6.14. Manage Assets List (#81)

### `GET /api/portfolio/assets`

- **Handler**: `pages/api/portfolio/assets.js` → `listAssets()` in `services/manageAssets.service.js`.
- **Responsibility**: A lightweight, paginated list of **every** portfolio item (category type `Investments`, `Asset` or `Debt`) for the Manage Assets page, with the flags the page needs. **No live pricing and no manual-value history** — values are the stored `currentValue` / `currentValueInUSD`; the only manual-value read is one `manualAssetValue.groupBy({ by: ['assetId'], _max: { date } })` over the page's `MANUAL` items.
- **Query parameters** (all optional; invalid values → `400`):

| Param | Meaning |
|-------|---------|
| `type` | A `processingHint` when it is upper snake case (`API_STOCK`, `MANUAL`, …), otherwise a `Category.group` (`Stocks`, `Real Estate`, …). SQL filter. |
| `accountId` | Integer. SQL filter. |
| `assetClass` | One of the 12 `ASSET_CLASSES` (#79). In-memory filter after classification. |
| `search` | Case-insensitive substring of the symbol or `SecurityMaster.name`. In memory. |
| `status` | `stale` \| `incomeMissing` \| `dividendOverride` \| `lotMismatch` \| `assetClassOverridden`. In memory; `stale` loads the last manual value date of every candidate `MANUAL` item instead of only the page's. |
| `includeClosed` | `true` to include items with quantity 0. By default they are hidden, except debts. |
| `id` | One item (deep links). Skips the closed filter and facets. |
| `cursor` | Opaque; base64 of an offset into the sorted list. |
| `limit` | Default 50, capped at 100; `< 1` or non-numeric → 400. |

- **Algorithm (two-stage)**: (1) one narrow `portfolioItem.findMany` (list fields + `incomeTerms { id, incomeType, issuerType, dividendPerUnit, isDistributing, yieldPct }` + `debtTerms { id }` + category + account name) with the SQL filters, one `securityMaster.findMany` for those symbols, `incomeTerms.count` of detached terms, and (first page only) a facet query over the unfiltered list; (2) classify every row with `classifyAssetClass` / `classifyIncomeAsset` / `incomeDataSource` from `@bliss/shared/portfolio`, apply `assetClass`, `search` and `status`, sort by `(category.group, symbol, id)`, slice the page, then enrich only the page (last manual value date, FX to the portfolio currency via `createFxResolver`). Deterministic sort + offset cursor → no duplicates or gaps across pages. If a tenant ever holds thousands of items, store the class in a column and move to keyset pagination.
- **Row fields**: `id, symbol, displayName (SecurityMaster name or symbol), categoryName, categoryType, group, processingHint, accountId, accountName, currency, quantity, currentValue, currentValueInDisplay, lastManualValueDate, assetClass, assetClassSource (AUTO|OVERRIDE), incomeAssetClass (null = can't hold income terms), hasLotMismatch, hasIncomeTerms, hasDividendOverride, hasDebtTerms, isPriceStale, incomeDataStatus`.
  - `isPriceStale`: `MANUAL`, quantity > 0 and no manual value in more than `MANUAL_PRICE_STALE_DAYS` (30) days, or none at all. Thresholds live in `@bliss/shared/portfolio` (`MANUAL_PRICE_STALE_DAYS / _WARNING_DAYS / _CRITICAL_DAYS` = 30 / 60 / 90).
  - `incomeDataStatus`: `NOT_APPLICABLE` when the item can't hold income terms; otherwise the projection's own source (`incomeDataSource()`): `AUTO` (trusted SecurityMaster dividends), `OVERRIDE` (stock/ETF dividend override), `MANUAL` (any other terms), `MISSING` (stock/ETF/fund/bond/real estate with quantity > 0 and nothing to project from), or `NONE` (cash/other without terms, or a closed position).
- **Response**: `{ portfolioCurrency, items, nextCursor (null on the last page), totals: { count }, detachedTermsCount, facets? }` — `facets: { groups: [{ group, count }], accounts: [{ id, name }] }` on the first page only.
- **Tenant isolation**: every query is scoped by `req.user.tenantId`.
- **Tests**: `__tests__/unit/api/portfolio-assets.test.ts` (filters alone and combined, search, stable pagination, no history in the payload, `lastManualValueDate` / `isPriceStale`, asset class and its filter, `detachedTermsCount`, tenant scoping, limit bounds).

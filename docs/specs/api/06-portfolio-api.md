# 6. Portfolio API Endpoints

This document provides the specifications for the Portfolio API endpoints, which are responsible for serving portfolio data to the frontend.

## 6.1. General Principles

The Portfolio API is divided into three main endpoints, each serving a distinct purpose:

-   **`GET /api/portfolio/items`**: Fetches the current, real-time state of all portfolio items.
-   **`GET /api/portfolio/holdings`**: Retrieves historical, daily snapshots of portfolio holdings.
-   **`GET /api/portfolio/history`**: Provides aggregated historical data for performance charting.

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

| Parameter   | Type     | Description                                | Default |
|-------------|----------|--------------------------------------------|---------|
| `assetType` | `string` | Filters items by the category `type`.      |         |
| `source`    | `string` | Filters items by their data source.        |         |

### 6.2.3. Response Format

The endpoint returns a wrapped object: `{ portfolioCurrency: string, items: PortfolioItem[] }`. Each item is structured with nested `native`, `usd`, and optional `portfolio` blocks. The `portfolio` block contains values converted to the tenant's `portfolioCurrency` (only present when `portfolioCurrency !== 'USD'`). This format eliminates the need for any currency conversion on the client side.

**Example `PortfolioItem` Response Object:**

```json
{
  "id": 123,
  "symbol": "AAPL",
  "currency": "USD",
  "quantity": 10,
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

| Parameter | Type     | Description                           | Default          |
|-----------|----------|---------------------------------------|------------------|
| `from`    | `string` | The start date in ISO 8601 format.    | The beginning of time |
| `to`      | `string` | The end date in ISO 8601 format.      | Today            |

### 6.4.3. Response Format

The endpoint returns a wrapped object: `{ portfolioCurrency: string, history: AggregatedPortfolioHistory[] }`. Each history entry includes `totalUSD` and optional `totalPortfolioCurrency` (when `portfolioCurrency !== 'USD'`).

---

## 6.5. Manual Value Management

### `GET /api/portfolio/items/{assetId}/manual-values`
- **Responsibility**: Returns all `ManualAssetValue` records for a specific asset, ordered by date descending.

### `POST /api/portfolio/items/{assetId}/manual-values`
- **Responsibility**: Adds a new manual price point for a specific asset.
- **Event Emission**: After successfully creating the `ManualAssetValue` record, it dispatches a `MANUAL_PORTFOLIO_PRICE_UPDATED` event to the backend. This event contains the `portfolioItemId`, which allows the `portfolioWorker` to efficiently target and recalculate only the affected item.

### `PUT /api/portfolio/items/{assetId}/manual-values/{valueId}`
- **Responsibility**: Updates an existing manual price point (date and/or value).
- **Event Emission**: Dispatches `MANUAL_PORTFOLIO_PRICE_UPDATED` after update.

### `DELETE /api/portfolio/items/{assetId}/manual-values/{valueId}`
- **Responsibility**: Removes a manual price point.
- **Event Emission**: Dispatches `MANUAL_PORTFOLIO_PRICE_UPDATED` after deletion.

---

## 6.6. Debt Terms Management

### `GET /api/portfolio/items/{assetId}/debt-terms`
- **Responsibility**: Returns the `DebtTerms` record for a liability portfolio item (interest rate, principal, term, origination date).

### `POST /api/portfolio/items/{assetId}/debt-terms`
- **Responsibility**: Creates or upserts debt terms for a liability. Fields: `initialBalance`, `interestRate`, `loanTermMonths`, `originationDate`, `paymentFrequency`.
- **Audit Logging**: Creates an `AuditLog` entry on changes.

### `PUT /api/portfolio/items/{assetId}/debt-terms`
- **Responsibility**: Updates existing debt terms for a liability.
- **Audit Logging**: Creates an `AuditLog` entry on changes.

---

## 6.7. Ticker Resolution

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

## 6.8. Portfolio Currency

### Settings API

`GET /api/tenants/settings` returns `portfolioCurrency` (default `'USD'`).
`PUT /api/tenants/settings` accepts `portfolioCurrency` — validated against tenant's `TenantCurrency` list.

### On-the-fly Conversion (`utils/currencyConversion.js`)

Portfolio values are stored in USD. Conversion happens at query time:

**`convertCurrency(amount, fromCurrency, toCurrency, date?)`** — Returns `Decimal` or `null`. Queries `CurrencyRate` table for direct rate, then inverse. Forward-fill: searches up to 7 days before the target date. Same-currency returns amount as-is.

**`batchFetchRates(fromCurrency, toCurrency, dateStrings)`** — Returns `Map<string, Decimal>` (date → rate). Efficient bulk lookup for the history endpoint. Same-currency returns `Decimal(1)` for all dates.

---

## 6.9. Schema: Multi-Market Fields

| Table | Field | Type | Purpose |
|-------|-------|------|---------|
| `Tenant` | `portfolioCurrency` | String (default `'USD'`) | Display currency for portfolio views |
| `Transaction` | `isin` | String? | System-resolved ISIN |
| `Transaction` | `exchange` | String? | ISO-10383 MIC code |
| `Transaction` | `assetCurrency` | String? | Asset's trading currency |
| `PortfolioItem` | `isin` | String? | Propagated from first transaction |
| `PortfolioItem` | `exchange` | String? | Propagated from first transaction |
| `PortfolioItem` | `assetCurrency` | String? | Propagated from first transaction |

---

## 6.10. Default Categories

| Code | Name | Group | Type | ProcessingHint |
|------|------|-------|------|---------------|
| `FUNDS` | Funds | Funds | Investments | `API_FUND` (changed from `MANUAL`) |
| `ETFS` | ETFs | Equities | Investments | `API_FUND` |
| `COMMODITIES` | Commodities | Commodities | Investments | `API_STOCK` |

The `Funds` hint change from `MANUAL` to `API_FUND` enables automatic pricing via Twelve Data. The `API_FUND` strategy has a graceful manual fallback for funds without resolvable tickers.

---

## 6.11. Investment Enrichment Flow

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

## 6.12. Portfolio API Tests

| Suite | File | Tests | Coverage |
|-------|------|-------|----------|
| Unit | `tenant-settings.test.ts` | 8 | GET/PUT portfolioCurrency, validation, RBAC |
| Unit | `currencyConversion.test.ts` | 7 | Direct/inverse rates, forward-fill, batch |
| Integration | `ticker-search.test.ts` | 6 | Proxy auth, validation, response |
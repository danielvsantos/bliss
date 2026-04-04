# 6. Portfolio Processing Pipeline (Backend)

This document provides a detailed specification of the backend portfolio processing pipeline. This system is responsible for creating and maintaining `PortfolioItem` records, calculating their daily historical values, and keeping their current state up-to-date.

## 6.1. High-Level Architecture

The portfolio processing system is a multi-stage, event-driven pipeline that runs asynchronously in the background. It is designed for robustness, performance, and extensibility. The architecture is centered around two main concepts:

1.  **Portfolio Initialization (`process-portfolio-changes.js`)**: The "what." This initial stage is responsible for creating and pruning `PortfolioItem` records so that they accurately reflect the assets and liabilities represented in the user's transaction history.
2.  **Cash Holdings, Analytics & Valuation (`cash-processor.js`, `analyticsWorker.js` & `valuation/index.js`)**: The "how much." This second stage is a multi-step process involving several workers to calculate the historical holdings and value of each `PortfolioItem`.

The entire process is orchestrated by the `eventSchedulerWorker`, which listens for events and enqueues the appropriate jobs in the `portfolioQueue` and `analyticsQueue`. **Key architectural change**: Cash holdings processing now occurs before analytics to ensure clean separation of concerns.

### Key Event Flows

#### Full Rebuild
Triggered by a bulk transaction import (`TRANSACTIONS_IMPORTED` event).
1.  **`process-portfolio-changes`**: Initializes/updates all `PortfolioItem` records.
2.  **`process-cash-holdings`**: Generates authoritative holdings for all CASH items (transaction-date-only strategy).
3.  **`full-rebuild-analytics`**: Rebuilds all analytics data for cross-currency reporting.
4.  **`value-all-assets` & Debt Processors**: The valuation engine and specialized debt processors run in parallel to generate history for all non-cash items and value history for cash items.

#### Scoped Update
Triggered by a manual transaction change (e.g., `MANUAL_TRANSACTION_MODIFIED` event).

**For Investment/Debt Transactions:**
1.  **`process-portfolio-changes`**: Links transaction to portfolio item
2.  **`process-cash-holdings`**: Processes cash impact (scoped)
3.  **`scoped-update-analytics`**: Recalculates analytics
4.  **`value-portfolio-items`**: Updates valuations

**For Simple Transactions (Expenses, Income, etc.):**
1.  **`process-cash-holdings`**: Direct cash processing (scoped)
2.  **`scoped-update-analytics`**: Recalculates analytics
3.  **`value-portfolio-items`**: Updates valuations if needed


#### Nightly Revaluation (Scheduled)
Triggered by the `revalue-all-tenants` BullMQ repeatable job at **4 AM UTC daily**.

This ensures portfolio history has no gaps even when no transactions occur for days. Without it, the history chart would show a cliff/drop because the last few days would have no `PortfolioValueHistory` records.

1.  **Orchestrator**: The `revalue-all-tenants` job queries all tenants with portfolio items and enqueues per-tenant valuation jobs with a 1-second delay between tenants.
2.  **Per-tenant jobs**: For each tenant, 3 jobs are enqueued:
    - `value-all-assets` (investments, assets, and cash — via forward-fill in the valuation engine)
    - `process-simple-liability` (simple debts)
    - `process-amortizing-loan` (amortizing loans)

**Important:** `process-cash-holdings` is intentionally excluded. Cash holdings haven't changed (no new transactions), and that job emits `CASH_HOLDINGS_PROCESSED` which cascades into a full analytics rebuild + a second valuation run. The `value-all-assets` job already handles cash assets via its forward-fill logic.
3.  **Idempotency**: The valuation engine deletes and rebuilds all history, so running it multiple times is safe.

**Schedule chain**: securityMasterWorker (3 AM, refreshes prices) -> portfolioWorker (4 AM, revaluation) -> insightGeneratorWorker (6 AM, AI insights).

#### On-Access Staleness Check (Fallback)
The `GET /api/portfolio/history` endpoint checks if the most recent `PortfolioValueHistory` record is before today. If stale, it fires a `PORTFOLIO_STALE_REVALUATION` event (debounced at 30 minutes per tenant) to trigger revaluation. The response returns existing data immediately; the next fetch gets fresh data. This covers self-hosters where the nightly cron may not be running reliably.


## 6.2. Data Integrity Constraints

The following unique constraints protect against duplicate records from concurrent job execution (the portfolio worker runs with `concurrency: 5`):

- **`PortfolioHolding`**: `@@unique([portfolioItemId, date])` — prevents duplicate holdings for the same asset on the same date. The `createMany({ skipDuplicates: true })` calls in the cash processor and valuation engine rely on this constraint.
- **`PortfolioValueHistory`**: `@@unique([assetId, date, source])` — prevents duplicate value history records. The forward-fill logic in the valuation engine creates daily records; this constraint ensures idempotency.

## 6.3. Core Principle: Server-Side State and Currency Conversion

A foundational principle of the pipeline is that **all currency conversions and state calculations are performed by the backend workers**. To support this, the `PortfolioItem` model contains a set of nullable fields to store USD-denominated equivalents of its primary financial metrics:

- `costBasisInUSD`
- `currentValueInUSD`
- `realizedPnLInUSD`
- `totalInvestedInUSD`

These fields are calculated and maintained exclusively by the backend workers, providing a single source of truth for all valuations and ensuring high performance and accuracy for the frontend.

### 6.3.2. Schema: Multi-Market & Currency Fields

The `PortfolioItem` and `Transaction` models carry additional fields for multi-market support:

| Table | Field | Type | Purpose |
|-------|-------|------|---------|
| `PortfolioItem` | `isin` | String? | ISIN code (e.g. `IE00BK5BQT80`), propagated from first transaction |
| `PortfolioItem` | `exchange` | String? | ISO-10383 MIC code (e.g. `XETR`) |
| `PortfolioItem` | `assetCurrency` | String? | Currency the asset trades in |
| `Transaction` | `isin` | String? | System-resolved ISIN |
| `Transaction` | `exchange` | String? | ISO-10383 MIC code |
| `Transaction` | `assetCurrency` | String? | Asset's trading currency |
| `AssetPrice` | `exchange` | String | Disambiguates prices across markets |

**AssetPrice unique constraint**: `@@unique([symbol, assetType, day, currency, exchange])`

**`AssetPrice.noData` flag**: When `getHistoricalPrice()` returns `null` for a date (holiday, market closure, data gap), the strategy files (`API_STOCK.js`, `API_CRYPTO.js`) upsert an `AssetPrice` record with `noData: true`. On subsequent valuation runs, Stage 1 of the pricing strategy detects this sentinel and returns `null` immediately without making an API call. The 7-day lookback (Stage 3) also skips `noData` records to avoid using them as forward-fill sources. This eliminates repeated failed API calls for the same known-bad dates across daily runs.

`process-portfolio-changes.js` propagates `isin`, `exchange`, and `assetCurrency` from the first transaction when creating new PortfolioItem records.

## 6.3. Stage 1: Portfolio Initialization (`process-portfolio-changes.js`)

This stage is handled by the `process-portfolio-changes.js` worker. Its primary responsibility is to ensure that there is a one-to-one correspondence between a unique asset (like a stock or a loan) and a `PortfolioItem` record in the database.

### 6.3.1. Logic

1.  **Asset Key Generation**: It uses the `asset-aggregator.js` utility to generate a consistent, unique key for each asset (e.g., the ticker `AAPL` for Apple stock).
2.  **Transaction Grouping**: It groups all investment and debt transactions by this asset key.
3.  **Upsert Logic**: It performs a non-destructive "upsert." If a `PortfolioItem` for a given key does not exist, it is created. A key piece of business logic is the **Origination Transaction Rule**: an item is only created if there is at least one "buy" (debit) or "origination" (credit) transaction. This prevents erroneous items from being created from sell-only transactions.
4.  **Initial State Calculation**: Upon creation, it calls the `calculatePortfolioItemState` utility (`src/utils/portfolioItemStateCalculator.js`) to compute the complete initial state of the new item from its transaction history. This utility uses the same transaction normalization logic as the valuation engine to handle BUY/SELL transactions with missing quantities, ensuring consistent calculations across all pipeline stages. The calculation includes all native and USD-denominated fields (`costBasis`, `costBasisInUSD`, etc.). Critically, the USD-denominated `realizedPnLInUSD` is computed using **proper FIFO lot-matching with historical FX rates**: each buy lot records the BRL→USD (or other currency→USD) rate at the buy date, and each sell converts proceeds at the sell-date rate. The per-lot PnL in USD is `(salePrice × qty × sellRate) − (lotPrice × qty × buyRate)`, summed across all FIFO-consumed lots. This ensures accurate USD PnL even when the exchange rate fluctuates between buy and sell dates.
5.  **Transaction Linking**: It ensures every transaction is linked via the `portfolioItemId` to its parent `PortfolioItem`.
6.  **Pruning**: It cleans up any "orphan" `PortfolioItem` records that are no longer referenced by any transactions.
7.  **Event Emission**: Upon completion, it emits a `PORTFOLIO_CHANGES_PROCESSED` event, which triggers the next stage of the pipeline.

## 6.4. Stage 2: Analytics, Valuation, and Specialized Processing

Once a `PortfolioItem` exists, its ongoing valuation is handled by a set of workers. This stage is complex and has several distinct parts that run in sequence and in parallel.

### 6.4.1. Cash Holdings Processor (`cash-processor.js`)

This worker is the **authoritative source of truth for CASH asset holdings**. It implements a transaction-date-only strategy, creating `PortfolioHolding` records only on dates with actual cash flow changes. (See `07-cash-holdings.md` for detailed specification).

### 6.4.2. Analytics Worker (`analyticsWorker.js`)

This worker handles cross-currency reporting and aggregation. It pre-calculates monthly analytics data and stores it in `AnalyticsCacheMonthly` for fast dashboard performance. (See `05-analytics.md` for more detail).

### 6.4.3. Valuation Engine (`valuation/index.js`)

This worker handles all `Investment` and `Asset` types via the `value-all-assets` job (alias: `generate-portfolio-valuation`). It is built on a "fetch once, process in memory" pattern. [[memory:3474704]]

1.  **Global Currency Pre-Fetching**: To avoid N+1 queries, the worker determines the global date range for all assets in the job and pre-fetches all required currency rates in a single, consolidated step.
2.  **Smart Deletion**: The worker partitions incoming assets into `cashAssets` and `nonCashAssets`.
    -   For `cashAssets`, it **only deletes `PortfolioValueHistory`**, preserving the holdings created by the cash processor.
    -   For `nonCashAssets`, it **deletes both `PortfolioHolding` and `PortfolioValueHistory`** for an idempotent rebuild.
3.  **Dual-Role Processing**:
    -   **For Cash**: It reads the existing `PortfolioHolding`s and transforms them into `PortfolioValueHistory` records with intelligent forward-filling to present day. The system skips days with zero balance and no activity for performance optimization, consistent with investment asset processing.
    -   **For Investments/Assets**: It orchestrates a full rebuild of both holdings and history.
4.  **Stateful, In-Memory Helpers**: It uses `holdings-calculator.js` and `price-fetcher.js`.
5.  **Event Timeline & Forward-Filling**: It constructs an "event timeline" of all dates with transactions or known prices. After processing the timeline, it intelligently forward-fills the asset's value up to the present day using the last known quantity.
6.  **Robust Date Iteration**: The worker uses a **UTC-based date iterator** to prevent bugs related to Daylight Saving Time. The date advancement occurs before any skip logic to prevent infinite loops when processing assets with zero quantities.
7.  **Date range capping for closed positions**: When `getHoldings(lastTxDate).quantity.isZero()`, the loop's `effectiveEndDate` is capped at `lastTxDate` rather than running to today. This prevents unnecessary processing for fully-sold/closed positions.
8.  **Price backfill for market-priced assets**: For `API_STOCK`, `API_CRYPTO`, and `API_FUND` (non-MANUAL) assets, a `lastKnownPrice` value is tracked. When `getPrice()` returns `null` (holiday, exchange closure, data gap) **and a real market price has been seen before**, the value is forward-filled from `lastKnownPrice` with `source = '<original>:BACKFILLED'`.
9.  **Pre-market cost basis fallback**: For backfillable assets where no real market price has been seen yet (e.g. pre-IPO stocks), the asset is valued at its running `costBasis` with `source = 'COST_BASIS_FALLBACK'`. This ensures valuations track what was actually paid rather than extrapolating a stale per-share price across additional purchases at different prices. Once TwelveData returns the first real price, `lastKnownPrice` is set and normal market pricing / backfill takes over.
10. **BullMQ lock duration**: The portfolio worker is configured with `lockDuration: 300_000` (5 minutes) to prevent `process-cash-holdings` jobs from losing their lock during long-running year-by-year rebuilds. BullMQ auto-renews the lock every `lockDuration / 2` (150 seconds).
7.  **Bulk Operations**: All new records are created using `createMany`. [[memory:3474701]]

### 6.4.4. Price Fetching (The Strategy Pattern)

The `price-fetcher.js` uses a dynamic **Strategy Pattern** to determine how to price an asset based on the `processingHint` on its category. Strategy files live in `valuation/strategies/` and are auto-discovered by the dynamic loader.

**Exchange-aware pre-fetch**: `createPriceFinder()` pre-fetches `AssetPrice` records into an in-memory map. When a `PortfolioItem` has an `exchange` set (e.g., `XPAR`), the query filters by that exchange, preventing price mixing for multi-listed symbols. When `exchange` is null, all prices for the symbol are loaded (backward compatible).

-   **`API_STOCK`**: Uses the stock pricing provider (Twelve Data or Alpha Vantage, controlled by `STOCK_PROVIDER` env var) with caching and 7-day look-back. Passes `portfolioItem.exchange` to the stock service for exchange disambiguation. Saves `AssetPrice` records with the exchange MIC code.
-   **`API_FUND`**: Follows the same 3-stage pricing as `API_STOCK`, plus a **Stage 4 manual fallback** — checks `manualValueMap` when API/DB lookups fail. Also passes exchange for disambiguation and saves it on `AssetPrice` records.
-   **`API_CRYPTO`**: Uses Twelve Data via `cryptoService.js` (currency pairs like `BTC/EUR`) with caching and 7-day look-back. The pair is constructed from the asset symbol + account currency. Does not use exchange disambiguation.
-   **`MANUAL`**: Exclusively uses user-provided prices and will never fall back to an API.

### 6.4.4a. Stock Pricing Provider Dispatch (`stockService.js`)

The `STOCK_PROVIDER` environment variable controls which provider is used for `API_STOCK` and `API_FUND` assets:

| Value | Provider | Notes |
|-------|----------|-------|
| `TWELVE_DATA` | Twelve Data (`twelveDataService.js`) | Recommended — better international coverage |
| `ALPHA_VANTAGE` | Alpha Vantage (legacy) | Default if unset |

Both `getHistoricalStockPrice(symbol, date, { exchange })` and `getLatestStockPrice(symbol, { exchange })` accept an optional `exchange` parameter (ISO-10383 MIC code). When using Twelve Data, this is forwarded as `micCode` to disambiguate multi-listed symbols. Alpha Vantage does not support exchange disambiguation.

To revert to Alpha Vantage: set `STOCK_PROVIDER=ALPHA_VANTAGE` or unset it. No code changes needed.

### 6.4.4b. Twelve Data Service (`twelveDataService.js`)

A dedicated API client providing four methods:

| Method | Twelve Data Endpoint | Return Type |
|--------|---------------------|-------------|
| `getHistoricalPrice(symbol, date, { micCode })` | `GET /time_series` | `{ price: Decimal, source: 'API:TwelveData' }` or `null` |
| `getLatestPrice(symbol, { micCode })` | `GET /quote` | `number` or `null` |
| `searchSymbol(query)` | `GET /symbol_search` | `Array<{ symbol, name, exchange, country, currency, type, mic_code }>` |
| `getSymbolProfile(symbol, { micCode })` | `GET /profile` | `{ isin, exchange, name, currency, sector, type }` or `null` |

**Exchange disambiguation**: All price-fetching methods accept an optional `{ micCode }` parameter (ISO-10383 MIC code, e.g. `XPAR`, `XETR`). When provided, it is passed as `mic_code` to the Twelve Data API, ensuring the correct exchange's price is returned for multi-listed symbols like `AIR` (Airbus on Euronext vs. NYSE). When omitted, Twelve Data's default resolution applies (backward compatible).

**Rate limiting**: Two independent rate-limit slot queues prevent import bursts from blocking valuation and vice versa:

| Queue | Functions | Budget | Slot interval |
|-------|-----------|--------|--------------|
| `acquireImportSlot` | `searchSymbol()`, `getSymbolProfile()` | 150 calls/min | ~400ms |
| `acquireValuationSlot` | `getHistoricalPrice()`, `getLatestPrice()` | 200 calls/min | ~300ms |

Combined worst-case: 350 calls/min — safely below the Grow plan's 377 credit/min cap.

**Error handling**: All methods return `null` (or `[]` for search) on API errors. Errors are logged but do not throw.

**Environment variables**:

| Variable | Required | Description |
|----------|----------|-------------|
| `TWELVE_DATA_API_KEY` | Yes (if `STOCK_PROVIDER=TWELVE_DATA`) | API key |
| `STOCK_PROVIDER` | No | `TWELVE_DATA` or `ALPHA_VANTAGE` (default) |

### 6.4.4c. Crypto Pricing (`cryptoService.js`)

A thin delegation layer over `twelveDataService.js` that constructs crypto currency pairs:

| Function | Delegates To | Pair Construction |
|----------|-------------|-------------------|
| `getHistoricalCryptoPrice(symbol, date, currency='USD')` | `twelveDataService.getHistoricalPrice(pair, date)` | `{symbol}/{currency}` e.g. `BTC/EUR` |
| `getLatestCryptoPrice(symbol, currency='USD')` | `twelveDataService.getLatestPrice(pair)` | `{symbol}/{currency}` e.g. `BTC/USD` |
| `searchCrypto(query, limit=10)` | `twelveDataService.searchSymbol(query)` | Filters for `type: 'Digital Currency'`, deduplicates by base symbol |

**Currency resolution**: The `currency` parameter comes from `portfolioItem.assetCurrency || portfolioItem.currency`, which for crypto assets is set to the account's currency when the user selects a ticker. This means prices are fetched directly in the user's account currency (e.g. `BTC/EUR` for a EUR account), avoiding extra FX conversion.

**End-to-end currency flow**:
1. **Frontend**: When user selects a crypto ticker, `assetCurrency` is set from the account's `currencyCode` (not from the search result)
2. **PortfolioItem**: `assetCurrency` stored on the item (e.g., `'EUR'`)
3. **Valuation worker** (`API_CRYPTO.js`): reads `portfolioItem.assetCurrency || portfolioItem.currency || 'USD'`
4. **Page-load live price** (`valuation.service.js`): sends `asset.assetCurrency || asset.currency` as `currency` query param

### 6.4.4d. Ticker Search Route (`src/routes/ticker.js`)

**`GET /api/ticker/search?q={query}&type={type}`**
- Auth: `apiKeyAuth` middleware
- When `type=crypto`: delegates to `cryptoService.searchCrypto()` which filters and deduplicates Twelve Data results for digital currencies
- Otherwise: delegates to `twelveDataService.searchSymbol()`
- Response: `{ results: [{ symbol, name, exchange, country, currency, type, mic_code }] }`

**`GET /api/ticker/profile?symbol={symbol}`**
- Auth: `apiKeyAuth` middleware
- Delegates to `twelveDataService.getSymbolProfile()`
- Response: `{ isin, exchange, name, currency, sector, type }` or 404

### 6.4.4e. Ticker Validation

Tickers must contain at least one letter (`/[a-zA-Z]/` regex). Pure numeric values are rejected to prevent phantom PortfolioItems and infinite price-fetch loops.

**Validation points** (7 layers):
1. `adapterEngine.js` — CSV parsing
2. `smartImportWorker.js` — native adapter
3. `asset-aggregator.js` — `generateAssetKey()` TICKER strategy
4. `pages/api/transactions/index.js` — POST/PUT
5. `pages/api/plaid/transactions/[id].js` — promote
6. `pages/api/imports/[id].js` — commit
7. `deep-dive-drawer.tsx` — pre-fill filtering

### 6.4.4f. Fund TICKER Fallback (`asset-aggregator.js`)

When `portfolioItemKeyStrategy: 'TICKER'` yields null for an Investment-type transaction that has a description (e.g., funds not on Twelve Data), the system falls back to `CATEGORY_NAME_PLUS_DESCRIPTION` grouping. This preserves backward compatibility.

### 6.4.4g. API_FUND Strategy (`strategies/API_FUND.js`)

A pricing strategy for funds and ETFs. Mirrors `API_STOCK.js` with two additional stages:

**Pricing stages**:
1. **Cache hit**: Check `forwardPriceCache` and `dbPriceMap`
2. **Live API call**: Call `getHistoricalStockPrice()` via Twelve Data — **skipped when `portfolioItem.source === 'MANUAL'`** (composite keys are not valid Twelve Data symbols)
3. **7-day DB lookback**: Scan `dbPriceMap` for prices within 7 days before target date
4. **Manual value fallback**: Check `manualValueMap` with unlimited lookback (not 7-day). Uses `mv.value` field. Forward-fills via `forwardPriceCache`

**MANUAL-source fund handling**: Funds without a ticker (e.g., Brazilian mutual funds) use the `TICKER` key strategy fallback, producing composite keys like `Funds:PIC 33/60`. These items get `source: 'MANUAL'` on the PortfolioItem. The cost-basis fallback in `valuation/index.js` is extended to cover `API_FUND` items with `source === 'MANUAL'`.

**Auto-seeding `ManualAssetValue`** (`process-portfolio-changes.js`): When a MANUAL-source PortfolioItem is created or updated with new deposits, `seedManualAssetValues()` creates records using running weighted-average pricing. On scoped updates, existing auto-seeded records (identified by `notes: 'Auto-seeded from purchase transaction'`) are deleted and re-created with updated averages.

### 6.4.4h. Price Service (`priceService.js`)

`getLatestPrice(symbol, assetType, currency, { exchange })` provides live pricing for portfolio page loads:

- Routes `API_FUND` to `getLatestStockPrice()` (same as `API_STOCK`), passing `{ exchange }` for disambiguation
- Passes `currency` to `getLatestCryptoPrice()` for `API_CRYPTO`
- DB fallback (`AssetPrice.findFirst`): filters by `exchange` when provided, ensuring the correct exchange's cached price is returned
- Source string: `'API:TwelveData'` for both stocks/funds and crypto

### 6.4.5. Transaction Normalization (`transactionNormalizer.js`)

Before any holdings calculations can occur, the system normalizes transactions to handle common business scenarios where quantity information may be missing or incomplete. This normalization is critical for the proper functioning of all portfolio calculations.

**Business Rules:**
- **BUY Transactions with Zero Quantity**: When a BUY transaction (debit > 0) has `assetQuantity: 0`, it is normalized to `assetQuantity: 1`. This is common for fixed-amount fund purchases where the user specifies the dollar amount but not the number of shares.
- **SELL Transactions with Zero Quantity**: When a SELL transaction (credit > 0) has `assetQuantity: 0`, it is normalized to `assetQuantity: 1` and marked with `_isSellAll: true`. This flag signals a "unit-proxy sell" — the downstream calculators determine the actual quantity to sell using a **pro-rata** formula.

**Pro-Rata Sell Quantity (Unit-Proxy Model):**

When the `_isSellAll` flag is set, the system does NOT simply liquidate the entire position. Instead, it computes the sell quantity proportional to the withdrawal amount relative to the current cost basis:

```
quantityToSell = totalQuantity × (credit / currentCostBasis)
```

This correctly handles **multiple partial withdrawals** from pension plans, manually-tracked funds, and similar investments where quantity information is unavailable. The formula ensures:
- Each partial withdrawal sells a proportional fraction of units
- The final withdrawal (where `credit ≥ remaining costBasis`) closes the position completely
- Total realized PnL = total withdrawals − total deposits (as expected)

**Edge cases:**
- `currentCostBasis ≤ 0`: falls back to selling all remaining units (prevents division by zero)
- `credit ≥ currentCostBasis`: caps at `totalQuantity` (closes the position)
- Single full redemption: behaves identically to the original "sell all" logic

**Common Scenarios:**
- Mutual fund purchases: User invests $1,000 without knowing the exact share count
- Fund redemptions: User redeems part or all of their position without specifying the share count
- Pension plan withdrawals: Multiple partial redemptions over time
- Legacy transaction imports: Historical data may lack precise quantity information

**System Conventions:**
- All quantities in the system remain positive (the `_isSellAll` flag signals pro-rata sell behavior)
- The normalization occurs early in the pipeline and is used consistently by both the `holdings-calculator.js` and `portfolioItemStateCalculator.js`
- The system prevents infinite processing loops through proper date advancement in the valuation engine, regardless of transaction normalization scenarios

### 6.4.5b. Cross-Currency Conversion

When a portfolio item contains transactions in multiple currencies (e.g., an EUR-denominated fund with a BRL deposit), the system converts foreign-currency amounts to the portfolio item's currency before FIFO processing.

**Conversion formula** (using USD as intermediary):
```
crossRate = foreignCurrency→USD / itemCurrency→USD
convertedAmount = amount × crossRate
```

This applies to `debit`, `credit`, and `assetPrice` fields. The `assetQuantity` is preserved (it represents real units, not money). The conversion happens in:
- `calculatePortfolioItemState()` — pre-converts all transactions before passing to `calculateInvestmentState()` and the USD FIFO block
- `holdings-calculator.js` — converts the `amount` inline when `tx.currency !== asset.currency`

Both use the same `currencyRateCache` (keyed as `{date}_{currency}_USD`) that is pre-populated by `process-portfolio-changes.js` for all unique transaction currencies.

### 6.4.6. Holdings Calculation (Business Logic)

The `holdings-calculator.js` infers the transaction type from its financial properties. [[memory:3474697]] It uses an **Average Cost Basis** method and relies on the normalized transaction data from `transactionNormalizer.js`. 

**Key Processing Logic:**
- **BUY transactions**: Add to running quantity and cost basis
- **SELL transactions**: 
  - Regular sells use the normalized quantity
  - Unit-proxy sells (marked with `_isSellAll: true`) use the pro-rata formula: `soldQuantity = runningQuantity × (credit / runningCostBasis)`, capped at `runningQuantity`
  - Uses Average Cost Basis calculation for realized gains/losses
- **Performance Optimization**: The calculator is stateful and processes all transactions for an asset in memory to avoid N+1 database queries

### 6.4.7. Simple Liability Processor (`simple-liability-processor.js`)

- **Responsibility**: This worker is the **authoritative source of truth** for `Simple Liability` assets. It is responsible for generating their daily value history and updating their final state.
- **Logic**: It is self-sufficient. It calculates the initial balance by finding the first credit transaction and then generates a daily running balance by subtracting payments. It contains its own currency pre-fetching and conversion logic to accurately maintain the `costBasisInUSD` and `currentValueInUSD` fields.

### 6.4.8. Amortizing Loan Processor (`amortizing-loan-processor.js`)

- **Responsibility**: This worker is the **authoritative source of truth** for `Amortizing Loan` assets.
- **Business Logic**: This processor contains critical, specialized business logic. It is self-sufficient and prioritizes data from the **`DebtTerms` table** as the definitive source for a loan's `initialBalance` and `originationDate`. If no `DebtTerms` record exists, it gracefully falls back to using the first credit transaction.
- **Currency Logic**: Its currency pre-fetching logic is robust. It determines the true earliest date for its rate query by comparing the `originationDate` from `DebtTerms` with the date of the earliest transaction, ensuring the rate for the origination date is always available.

## 6.5. Recalculate Portfolio Items (`recalculate-portfolio-items`)

This job is dispatched by the `eventSchedulerWorker` when individual portfolio items need recalculation (e.g., after a manual transaction modification). It groups the provided `portfolioItemIds` by their processing type and dispatches them to the correct processors:

- **Investments** (default): sent to `generatePortfolioValuation`.
- **Simple Liabilities** (`processingHint === 'SIMPLE_LIABILITY'`): sent to `simpleLiabilityProcessor`.
- **Amortizing Loans** (`processingHint === 'AMORTIZING_LOAN'`): sent to `processAmortizingLoan`.

All three types are processed in parallel via `Promise.all`.

## 6.6. Debounced Job Scheduling

The `eventSchedulerWorker` uses `scheduleDebouncedJob()` from `debounceService.js` to consolidate rapid-fire events into a single job. This is used for all major job dispatches (portfolio changes, cash processing, analytics, revaluation). The debounce window is 5 seconds. During the window, array-type fields (e.g., `portfolioItemIds`, `scopes`, `needsCashRebuild`) are aggregated across events.

## 6.7. TAG_ASSIGNMENT_MODIFIED Event Routing

When tags are added to or removed from transactions, the API emits a `TAG_ASSIGNMENT_MODIFIED` event containing `tenantId` and `transactionScopes`. The `eventSchedulerWorker` routes this directly to `scoped-update-analytics` on the analytics queue, bypassing the portfolio pipeline. The analytics worker populates both regular and tag analytics in a single pass.

## 6.8. Supporting Workers

### 6.8.1. Transaction Import Worker (`importWorker`)

Before the portfolio can be processed, transactions must be present in the system. The `importWorker` is a specialized worker responsible for handling bulk CSV transaction imports. It uses a robust two-pass (validate, then write) streaming architecture and enqueues a `TRANSACTIONS_IMPORTED` event on success, which triggers the portfolio sync.

### 6.8.2. On-Demand Recalculation (`recalculate-portfolio-item.js`)

This is a lightweight worker triggered when a transaction is manually updated or deleted. Its role is nuanced and respects the separation of concerns.

- **For Investments**: It performs a full state recalculation by calling the `calculatePortfolioItemState` utility.
- **For Debt**: It does **not** perform any state calculations. For `Debt` items, it logs that it is skipping the asset and exits. This is critical because the authoritative calculation for `Debt` must be performed by the specialized processors, which are triggered by separate events. This prevents this worker from overwriting the correct state with a simplified calculation.

## 6.9. Default Categories

| Code | Name | Group | Type | ProcessingHint | Key Strategy |
|------|------|-------|------|---------------|--------------|
| `FUNDS` | Funds | Funds | Investments | `API_FUND` (changed from `MANUAL`) | `TICKER` |
| `ETFS` | ETFs | Equities | Investments | `API_FUND` | `TICKER` |
| `COMMODITIES` | Commodities | Commodities | Investments | `API_STOCK` | `TICKER` |

The `Funds` hint change from `MANUAL` to `API_FUND` enables automatic pricing via Twelve Data. The `API_FUND` strategy has a graceful manual fallback for funds without resolvable tickers.

## 6.10. Portfolio Engine Tests

| Suite | File | Tests | What it covers |
|-------|------|-------|----------------|
| Unit | `cryptoService.test.js` | 11 | Twelve Data delegation, pair construction (`BTC/EUR`), dedup, search filtering |
| Unit | `API_CRYPTO.test.js` | 8 | 3-stage pricing, currency fallback chain, TwelveData source |
| Unit | `API_FUND.test.js` | 10 | Cache/API/lookback/manual stages, MANUAL source skip |
| Unit | `API_STOCK.test.js` | 6 | 3-stage pricing: cache → API → lookback |
| Unit | `priceService.test.js` | 9 | API_FUND routing, crypto currency threading |
| Unit | `twelveDataService.test.js` | 12 | All 4 API methods, weekend backtrack, error handling |
| Unit | `stockService.test.js` | 8 | Provider dispatch (TWELVE_DATA vs ALPHA_VANTAGE) |
| Unit | `portfolioItemStateCalculator.test.js` | 20 | Default assetQuantity=1, FIFO, pro-rata unit-proxy sells, multi-withdrawal, cross-currency conversion, non-USD FIFO realizedPnLInUSD with historical FX rates |
| Integration | `ticker.test.js` | 7 | Route auth, validation, response |
| Integration | `pricing.test.js` | 6 | API_FUND routing, price not found |

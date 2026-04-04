# 5. Analytics Pipeline (Backend)

## 5.1. Overview & Architecture

The backend analytics system is a multi-stage, event-driven pipeline. Its primary purpose is to pre-calculate and cache aggregated financial data in the `AnalyticsCacheMonthly` table to ensure the reporting dashboards in the frontend are fast and responsive.

**Note**: As of the cash worker implementation, cash holdings are now managed by a dedicated `cash-processor.js` worker. The analytics system focuses purely on cross-currency reporting and aggregation.

### 5.2. The Event Scheduler (`eventSchedulerWorker.js`)

The `eventSchedulerWorker` orchestrates the pipeline by listening for business events and dispatching jobs to the `analyticsQueue`.

#### Key Events Triggering Analytics:

-   `CASH_HOLDINGS_PROCESSED`: The primary trigger, fired after cash holdings have been processed. This event differentiates between a full rebuild and a scoped update.
-   `MANUAL_TRANSACTION_MODIFIED` / `CREATED`: For non-investment transactions, this may trigger cash processing first, then analytics.
-   `TENANT_CURRENCY_SETTINGS_UPDATED`: Triggers a full portfolio, cash, and analytics rebuild.

## 5.3. The Analytics Worker (`analyticsWorker.js`)

The worker is responsible for the core analytics calculation and cross-currency reporting. It can run in two distinct modes depending on the job name. Cash holdings are now handled by the dedicated cash processor.

### 5.3.1. Worker Configuration

- **Concurrency**: 1 (single-threaded to avoid race conditions on shared analytics tables).
- **Lock Duration**: 300,000ms (5 minutes).

### 5.3.2. Job Modes

1.  **Full Rebuild (`full-rebuild-analytics`)**: Triggered after a bulk import. This job runs on the tenant's entire transaction history. Before recalculating, the worker deletes ALL existing `AnalyticsCacheMonthly` AND `TagAnalyticsCacheMonthly` records for the tenant within a `$transaction`. This prevents stale rows (e.g., tag analytics for tags that were removed from transactions) from persisting.
2.  **Scoped Update (`scoped-update-analytics`)**: Triggered by manual transaction changes or tag modifications. This job accepts a `scopes` array (multiple scopes) and iterates over each scope, running `calculateAnalytics` per scope. Results are deduplicated by their composite key to handle overlapping scopes.
3.  **Legacy Fallback (`recalculate-analytics`)**: A legacy job name still handled by the worker. When called without a scope (or with an empty scope) and without `scopes`, it behaves as a full rebuild (deletes all existing analytics before recalculating). Otherwise, it runs `calculateAnalytics` with the provided scope.

### 5.3.3. Core Logic (`calculateAnalytics`)

This function performs a two-pass calculation:

1.  **Pass 1 (Date Range Discovery)**: It scans all transactions within the job's scope to find the complete date range and all required currency pairs. It then pre-fetches all necessary currency rates in a single bulk operation.
2.  **Pass 2 (Aggregation)**: It processes the transactions, converting them to the tenant's configured currencies using the in-memory rate cache. The data is then aggregated into monthly totals, grouped by a multi-dimensional key (`year`, `month`, `currency`, `country`, `type`, `group`). In parallel during Pass 2, **tag analytics** are computed into `TagAnalyticsCacheMonthly`. Multi-tagged transactions create one entry per tag, keyed by `(tagId, year, month, currency, country, type, group, categoryId)`. Both full-rebuild and scoped-update modes populate both tables.

    The results are `upserted` into their respective tables in batches of 500 within `$transaction` blocks, to avoid overwhelming the Prisma Accelerate proxy (10s per-query timeout).

### 5.3.4. Cross-Currency Reporting

The analytics worker focuses on creating aggregated financial data across multiple currencies for reporting purposes. It converts all transactions to the tenant's configured target currencies and stores monthly aggregates.

**Cash Holdings**: Cash holdings are now managed by the dedicated `cash-processor.js` worker (see `07-cash-holdings.md`). The analytics worker no longer handles cash portfolio holdings.

## 5.4. Event Emission

Upon successful completion, the `analyticsWorker` emits an `ANALYTICS_RECALCULATION_COMPLETE` event.

-   For a **full rebuild**, it includes an `isFullRebuild: true` flag.
-   For a **scoped update**, it includes a list of the specific `portfolioItemIds` that were affected by the analytics calculation.

This event and its payload are critical for the `eventSchedulerWorker` to correctly trigger the next stage of the main portfolio pipeline (the valuation engine).

## 5.5. Critical: `originalScope` Propagation

For scoped updates to reach analytics, `originalScope` and `portfolioItemIds` **must be threaded through the entire chain** from `PORTFOLIO_CHANGES_PROCESSED` all the way to `CASH_HOLDINGS_PROCESSED`.

### The Chain

```
PORTFOLIO_CHANGES_PROCESSED (originalScope, portfolioItemIds as top-level fields)
  → eventSchedulerWorker adds them to process-cash-holdings job data
    → portfolioWorker.js merges them into scope before calling processCashHoldings()
      → cash-processor.js reads scope.originalScope + scope.portfolioItemIds
        → CASH_HOLDINGS_PROCESSED (originalScope, portfolioItemIds now present)
          → eventSchedulerWorker triggers scoped-update-analytics
```

### Key Implementation Detail

`portfolioWorker.js` (`process-cash-holdings` job handler) must merge `originalScope` and `portfolioItemIds` from the job data into the `scope` object before passing it to `processCashHoldings()`:

```js
const { tenantId, scope, originalScope, portfolioItemIds } = data;
const enrichedScope = {
  ...scope,
  ...(originalScope !== undefined && { originalScope }),
  ...(portfolioItemIds !== undefined && { portfolioItemIds }),
};
return await processCashHoldings(tenantId, enrichedScope);
```

If `originalScope` is missing when `CASH_HOLDINGS_PROCESSED` is emitted, the event scheduler skips the analytics update entirely (neither scoped nor full rebuild fires). This would silently break analytics for all Plaid promotes and smart import commits. 
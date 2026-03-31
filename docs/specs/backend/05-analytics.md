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

### 5.3.1. Job Modes

1.  **Full Rebuild (`full-rebuild-analytics`)**: Triggered after a bulk import. This job runs on the tenant's entire transaction history.
2.  **Scoped Update (`scoped-update-analytics`)**: Triggered by manual transaction changes. This job runs on a specific, narrow scope (e.g., a single month), making it fast and efficient.

### 5.3.2. Core Logic (`calculateAnalytics`)

This function performs a two-pass calculation:

1.  **Pass 1 (Date Range Discovery)**: It scans all transactions within the job's scope to find the complete date range and all required currency pairs. It then pre-fetches all necessary currency rates in a single bulk operation.
2.  **Pass 2 (Aggregation)**: It processes the transactions, converting them to the tenant's configured currencies using the in-memory rate cache. The data is then aggregated into monthly totals, grouped by a multi-dimensional key (`year`, `month`, `currency`, `country`, `type`, `group`). The results are `upserted` into the `AnalyticsCacheMonthly` table.

### 5.3.3. Cross-Currency Reporting

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
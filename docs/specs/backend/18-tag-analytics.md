# 18. Tag Analytics Pipeline (Backend)

This document specifies the backend changes to support per-tag financial analytics, extending the existing analytics worker and event routing.

## 18.1. Overview

Tag analytics are computed alongside regular analytics in the same worker pass. There is no separate worker or queue — the existing `analyticsWorker.js` populates both `AnalyticsCacheMonthly` and `TagAnalyticsCacheMonthly` in a single two-pass calculation. This ensures tag analytics are always perfectly in sync with regular analytics.

## 18.2. Analytics Worker Extensions

- **File**: `src/workers/analyticsWorker.js`
- **Function**: `calculateAnalytics()` (exported for unit testing)

### 18.2.1. Pass 2 Changes

The transaction select in Pass 2 includes `tags: { select: { tagId: true } }` alongside the existing `account` and `category` includes. Category `id` and `name` are also selected for per-category granularity.

For each transaction with tags, the worker:

1. Extracts `category.id` and `category.name` (defaulting to `0` / `"Uncategorized"` when null)
2. For each `tagId` in `transaction.tags`, builds an aggregation key: `${tagId}-${year}-${month}-${currency}-${country}-${type}-${group}-${categoryId}`
3. Aggregates credit, debit, and balance into a parallel `tagAnalyticsMap`
4. Transactions with no tags are skipped for the tag map
5. Transactions with multiple tags create entries for each tag (intentional per-tag counting)

### 18.2.2. Upsert

After the existing `AnalyticsCacheMonthly` upserts:

1. Deduplicate `tagAnalyticsMap` entries using the same key pattern
2. Build upsert promises for `prisma.tagAnalyticsCacheMonthly.upsert()` using the `tag_tenant_year_month_currency_country_type_group_cat` unique constraint
3. Execute in a `prisma.$transaction()` batch
4. Log created/updated counts

### 18.2.3. Return Shape

`calculateAnalytics()` returns `{ analytics: [...], tagAnalytics: [...] }` where `tagAnalytics` entries include:

```js
{
  tagId, year, month, currency, country, type, group,
  categoryId, categoryName,
  credit: Decimal, debit: Decimal, balance: Decimal
}
```

### 18.2.4. Job Compatibility

Both `full-rebuild-analytics` and `scoped-update-analytics` jobs automatically populate both tables since they share the same calculation pass. No changes to job types required.

## 18.3. Event Routing

- **File**: `src/workers/eventSchedulerWorker.js`

### 18.3.1. TAG_ASSIGNMENT_MODIFIED Event

A new event case routes tag assignment changes through the existing analytics queue:

```javascript
case 'TAG_ASSIGNMENT_MODIFIED': {
    const { tenantId, transactionScopes } = data;
    if (!tenantId) {
        logger.warn('TAG_ASSIGNMENT_MODIFIED missing tenantId, skipping');
        break;
    }
    await scheduleDebouncedJob(
        getAnalyticsQueue(),
        'scoped-update-analytics',
        { tenantId, scopes: transactionScopes || [] },
        'scopes',
        DEBOUNCE_DELAY_SECONDS
    );
    break;
}
```

This reuses the existing analytics queue and debouncing infrastructure. No new queue or worker registration required.

### 18.3.2. Why a Separate Event?

Tag changes alone don't modify a transaction's financial data, so they may not trigger the `MANUAL_TRANSACTION_MODIFIED` → cash → analytics pipeline. `TAG_ASSIGNMENT_MODIFIED` ensures tag-only edits still recalculate the tag analytics cache via a scoped analytics update.

## 18.4. Schema

The `TagAnalyticsCacheMonthly` model is defined in the shared Prisma schema (`prisma/schema.prisma`). See `docs/specs/api/18-tag-analytics.md` section 18.2 for the full model definition.

Key points:
- Per-category granularity via `categoryId` + `categoryName` (not present in regular `AnalyticsCacheMonthly`)
- Unique constraint includes `categoryId` for the upsert key
- Cascade deletes on tag, tenant, and category FKs

## 18.5. Tests

### Unit Tests

- **File**: `src/__tests__/unit/workers/analyticsWorker.test.js` — 5 tests:
  - Populates tagAnalyticsMap with categoryId/categoryName
  - Creates separate entries for multi-tagged transactions
  - Skips untagged transactions
  - Aggregates same tag + category across multiple transactions
  - Returns correct result shape with both `analytics` and `tagAnalytics`

- **File**: `src/__tests__/unit/workers/eventSchedulerWorker.test.js` — 3 additional tests:
  - Routes TAG_ASSIGNMENT_MODIFIED to analytics queue
  - Handles empty scopes fallback
  - Warns on missing tenantId

### Test Pattern

Analytics worker tests mock Prisma, currency service, category cache, Redis, and BullMQ. The `calculateAnalytics` function is tested directly via the exported module.

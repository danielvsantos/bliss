# 18. Tag Analytics API

This document specifies the Tag Analytics API endpoint and related schema changes for per-tag financial analysis.

## 18.1. Overview

Tags in Bliss are cross-cutting labels that span categories, accounts, and currencies. A single tag (e.g., "Japan 2026") can collect transactions across flights (USD), hotels (JPY), food (JPY), and souvenirs (JPY) — no single category or account captures the full picture.

Tag Analytics provides pre-aggregated, per-category financial data for tagged transactions via the `TagAnalyticsCacheMonthly` table, queried through a dedicated API endpoint.

**Why a separate table from `AnalyticsCacheMonthly`?** Untagged transactions would disappear from existing dashboards, and multi-tagged transactions would be double-counted. The two tables serve fundamentally different counting semantics. Additionally, `TagAnalyticsCacheMonthly` includes per-category granularity (`categoryId` + `categoryName`) that the regular cache does not.

## 18.2. Schema Changes

### 18.2.1. Tag Model Extensions

Three optional fields added to the `Tag` model:

| Field | Type | Description |
|-------|------|-------------|
| `budget` | `Decimal(18,2)?` | Optional spending budget for the tag |
| `startDate` | `DateTime?` | Optional start date (e.g., trip departure) |
| `endDate` | `DateTime?` | Optional end date (e.g., trip return) |

### 18.2.2. TagAnalyticsCacheMonthly Model

```prisma
model TagAnalyticsCacheMonthly {
  id           Int      @id @default(autoincrement())
  tagId        Int
  year         Int
  month        Int
  currency     String
  country      String
  type         String
  group        String
  categoryId   Int
  categoryName String
  credit       Decimal  @db.Decimal(18, 2)
  debit        Decimal  @db.Decimal(18, 2)
  balance      Decimal  @db.Decimal(18, 2)
  tenantId     String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  tag      Tag      @relation(fields: [tagId], references: [id], onDelete: Cascade)
  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  category Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  @@unique([tagId, tenantId, year, month, currency, country, type, group, categoryId],
           name: "tag_tenant_year_month_currency_country_type_group_cat")
  @@index([tenantId])
  @@index([tagId])
}
```

Reverse relations added to `Tag`, `Tenant`, and `Category` models.

### 18.2.3. Migrations

1. **`20260311000000_tag_analytics_cache`** — Creates the `TagAnalyticsCacheMonthly` table (without category columns) and adds `budget`, `startDate`, `endDate` to `Tag`.
2. **`20260311100000_tag_analytics_add_category`** — Adds `categoryId` and `categoryName` columns, replaces the unique index to include `categoryId`, adds the `Category` FK. Truncates the cache table first (rebuilt by the analytics worker).

## 18.3. Tag Analytics Endpoint

- **File**: `pages/api/analytics/tags.js`
- **Endpoint**: `GET /api/analytics/tags`
- **Authentication**: JWT via `withAuth`
- **Rate Limiting**: `rateLimiters.analytics`

### 18.3.1. Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tagIds[]` | `int[]` | Yes | Tag IDs to fetch analytics for (supports both `tagIds[]=1&tagIds[]=2` and `tagIds=1`) |
| `view` | `string` | No (default: `month`) | `year`, `quarter`, or `month` |
| `currency` | `string` | No (default: `USD`) | Reporting currency |
| `startMonth` / `endMonth` | `string` | No | `YYYY-MM` format. Optional for month view — when omitted, returns all data |
| `startQuarter` / `endQuarter` | `string` | Yes (quarter view) | `YYYY-Q#` format |
| `years[]` | `int[]` | No | For `view=year` |

### 18.3.2. Response Format

Data is nested as: `tag → timePeriod → type → group → categoryName → {credit, debit, balance}`.

```json
{
  "currency": "BRL",
  "view": "month",
  "tags": {
    "317": {
      "2018-07": {
        "Growth": {
          "Travel": {
            "Accommodation": {
              "credit": 4332,
              "debit": 5200,
              "balance": -868
            }
          }
        }
      }
    }
  }
}
```

Multiple `tagIds[]` are supported for comparison mode — each tag's data is keyed separately.

### 18.3.3. Error Responses

| Status | Condition |
|--------|-----------|
| 400 | No valid `tagIds` provided |
| 400 | Quarter view missing `startQuarter`/`endQuarter` |
| 405 | Non-GET method |
| 500 | Server error |

## 18.4. Tags API Extensions

- **File**: `pages/api/tags.js`

POST and PUT handlers accept `budget` (Decimal), `startDate` (ISO string), and `endDate` (ISO string). These are persisted on the `Tag` model and returned in GET responses.

## 18.5. Transaction Tag Events

- **File**: `pages/api/transactions/index.js`

When tag assignments change on a transaction (via PUT), the API emits a `TAG_ASSIGNMENT_MODIFIED` event to the backend service. This triggers a scoped analytics recalculation that repopulates both `AnalyticsCacheMonthly` and `TagAnalyticsCacheMonthly`.

Event payload:
```json
{
  "type": "TAG_ASSIGNMENT_MODIFIED",
  "data": {
    "tenantId": "...",
    "transactionScopes": [{ "year": 2026, "month": 3, "currency": "USD", "country": "US" }]
  }
}
```

## 18.6. Tests

- **File**: `__tests__/unit/api/analytics-tags.test.ts` — 11 tests covering method validation, query parsing, all three view modes, comparison mode, single tagId normalization.
- **File**: `__tests__/integration/api/tags.test.ts` — 6 additional tests for budget/startDate/endDate in POST and PUT.

Test pattern: mocked-handler approach (vi.mock for withAuth, prisma, rateLimit, cors, Sentry).

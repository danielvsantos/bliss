# 19. SecurityMaster & Equity Analysis API

This document specifies the API layer changes for the SecurityMaster schema and the equity analysis endpoint.

## 19.1. Overview

The SecurityMaster table is a global reference table storing stock fundamental data. The finance API adds:
- The Prisma model and migration for the SecurityMaster table
- An equity analysis endpoint that enriches stock holdings with SecurityMaster data

## 19.2. Schema Changes

### SecurityMaster Model

A global (not per-tenant) table storing stock fundamentals. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | `String @unique` | Ticker symbol (e.g. AAPL) |
| `name` | `String?` | Company name |
| `sector` | `String?` | GICS sector |
| `industry` | `String?` | GICS industry |
| `country` | `String?` | Country of incorporation |
| `exchange` | `String?` | Primary exchange (ISO-10383 MIC code, e.g. XNYS) |
| `currency` | `String?` | Trading currency (e.g. USD, EUR) |
| `isin` | `String?` | International Securities Identification Number |
| `description` | `String? @db.Text` | Company description |
| `logoUrl` | `String?` | Company logo URL (from Twelve Data) |
| `assetType` | `String?` | Asset type (e.g. "Common Stock", "ETF") |
| `ceo` | `String?` | Chief executive officer |
| `employees` | `Int?` | Number of employees |
| `website` | `String?` | Company website URL |
| `trailingEps` | `Decimal(12,4)?` | Trailing 4-quarter EPS |
| `peRatio` | `Decimal(12,4)?` | Price / trailing EPS |
| `annualizedDividend` | `Decimal(12,4)?` | 12-month dividend sum |
| `dividendYield` | `Decimal(8,6)?` | Annualized dividend / price |
| `latestEpsActual` | `Decimal(12,4)?` | Most recent quarter EPS actual |
| `latestEpsSurprise` | `Decimal(8,4)?` | Most recent quarter EPS surprise percentage |
| `week52High` | `Decimal(18,4)?` | 52-week high price |
| `week52Low` | `Decimal(18,4)?` | 52-week low price |
| `averageVolume` | `Decimal(18,0)?` | Average daily volume |
| `earningsTrusted` | `Boolean` (default `false`) | Trust gate for `peRatio`, `trailingEps`, `latestEpsActual`, `latestEpsSurprise`. See **19.6** below. |
| `dividendTrusted` | `Boolean` (default `false`) | Trust gate for `dividendYield`. See **19.6** below. |
| `lastProfileUpdate` | `DateTime?` | Last time profile fields were refreshed |
| `lastFundamentalsUpdate` | `DateTime?` | Last time earnings/dividends/quote were refreshed |
| `createdAt` | `DateTime` | Record creation timestamp |
| `updatedAt` | `DateTime` | Last modification timestamp (auto-updated) |

Indexes: `sector`, `industry`, `country`, `assetType`.

### Migrations

- **File**: `prisma/migrations/20260313000000_add_security_master/migration.sql`
  Creates the `SecurityMaster` table with all columns and indexes.
- **File**: `prisma/migrations/20260427000000_add_security_master_trust_flags/migration.sql`
  Adds the `earningsTrusted` and `dividendTrusted` boolean columns (`NOT NULL DEFAULT false`). Existing rows default to untrusted until the next fundamentals refresh recomputes the flags — see the operator note in **19.7** about triggering an immediate refresh after deploying this migration so consumers don't see `—` for every stock until the 3 AM cron runs.

## 19.3. Equity Analysis Endpoint

- **File**: `pages/api/portfolio/equity-analysis.js`
- **Auth**: JWT via `withAuth`
- **Rate limit**: `rateLimiters.portfolio`

### `GET /api/portfolio/equity-analysis`

Returns equity portfolio composition enriched with fundamental data.

#### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `groupBy` | `string` | `sector` | Grouping field: `sector`, `industry`, or `country` |

#### Response (200)

```json
{
  "portfolioCurrency": "USD",
  "summary": {
    "totalEquityValue": 150000.00,
    "holdingsCount": 12,
    "weightedPeRatio": 22.5,
    "weightedDividendYield": 0.018
  },
  "groups": [
    {
      "name": "Technology",
      "totalValue": 75000.00,
      "weight": 0.50,
      "holdingsCount": 5,
      "holdings": [
        {
          "symbol": "AAPL",
          "name": "Apple Inc.",
          "quantity": 50,
          "currentValue": 8750.00,
          "currentValueUSD": 8750.00,
          "sector": "Technology",
          "industry": "Consumer Electronics",
          "country": "United States",
          "peRatio": 28.5,
          "dividendYield": 0.0055,
          "trailingEps": 6.14,
          "latestEpsActual": 1.53,
          "latestEpsSurprise": 4.2,
          "week52High": 199.62,
          "week52Low": 155.98,
          "averageVolume": 54320000,
          "logoUrl": "https://api.twelvedata.com/logo/apple.com",
          "weight": 0.058
        }
      ]
    }
  ]
}
```

#### Error Responses

| Status | Description |
|--------|-------------|
| 400 | Invalid `groupBy` value |
| 405 | Method not allowed (only GET) |
| 500 | Server error |

#### Implementation Notes

- Fetches tenant's stock holdings where `category.processingHint = 'API_STOCK'` and `quantity > 0`
- Enriches with live prices via `calculateAssetCurrentValue()` (same as portfolio items endpoint)
- SecurityMaster data is fetched via direct Prisma query (same database, no backend HTTP call)
- Weighted P/E and dividend yield are computed using holdings weights, normalized to exclude holdings without data
- Portfolio currency conversion applied when tenant's currency differs from USD
- **Trust gate**: when `sm.earningsTrusted === false`, the response sets `peRatio`, `trailingEps`, `latestEpsActual`, and `latestEpsSurprise` to `null` even if the underlying columns hold values. Same rule for `dividendYield` against `sm.dividendTrusted`. Quote-derived fields (`week52High`, `week52Low`, `averageVolume`) are **not** gated — they come from `/quote`, not from the inconsistent `/earnings` or `/dividends` paths. See **19.6**.

## 19.4. Ticker Profile Cache Integration

The finance API's ticker search proxy (`/api/ticker/search`) is unaffected. The backend handles cache-first profile lookups transparently via SecurityMaster. The finance API benefits indirectly through faster profile responses from the backend.

## 19.5. Tests

- Mocked-handler unit tests for `equity-analysis.js`:
  - Mock `withAuth` to inject `req.user`
  - Mock `prisma.portfolioItem.findMany`, `prisma.securityMaster.findMany`, `prisma.tenant.findUnique`
  - Test groupBy parameter validation (400 for invalid values)
  - Test empty portfolio response
  - Test weighted P/E and dividend yield computation
  - Test method not allowed (POST → 405)
  - **Test the trust gate**: when fixture sets `earningsTrusted: false` / `dividendTrusted: false`, the response must null-out `peRatio`, `trailingEps`, `latestEpsActual`, `latestEpsSurprise`, `dividendYield` while preserving `week52High` / `week52Low`. The summary's `weightedPeRatio` / `weightedDividendYield` must fall through to `null` when no trusted holding exists.

## 19.6. Trust Gate (consumer contract)

Twelve Data's `/earnings` and `/dividends` responses are inconsistent across symbols (timezone skew on the latest quarter, sparse history, future-only entries, malformed rows). The backend's `securityMasterService.upsertFundamentals()` decides each refresh whether the recomputed values for a symbol are usable, and writes the decision to `earningsTrusted` / `dividendTrusted`.

**Consumer rule**: any code that returns `peRatio`, `trailingEps`, `latestEpsActual`, `latestEpsSurprise`, or `dividendYield` to a downstream client (UI, LLM context, public API) **must** check the corresponding trust flag and substitute `null` when false. The frontend already renders `null` as `—`, and the insights LLM treats null fundamentals as "no data, skip the analysis" — both are correct fallbacks.

The full trust criteria (4 quarters spanning ≤450 days, latest ≤180 days old, etc.) live in the backend service and are documented in **backend spec 19**, section 19.6. The API layer just consumes the booleans.

## 19.7. Manual Fundamentals Refresh (admin)

`POST /api/admin/refresh-fundamentals` triggers an immediate run of the same job the 3 AM cron fires, refreshing all active stock symbols and recomputing trust flags. Endpoint contract is documented in [api spec 03, section 3.5](./03-reference-data-management.md#35-security-master-fundamentals-refresh). Surfaced in the UI via the **Settings → Maintenance** tab's "Refresh stock fundamentals" panel.

**When to use it**:
- Right after deploying the trust-flag migration — every existing row defaults to `earningsTrusted: false`, so the equity analysis page shows `—` for every holding until a refresh recomputes the flags.
- After a Twelve Data data fix lands and a previously-untrusted symbol should now be trusted.
- Diagnostic purposes when investigating a single stale stock.

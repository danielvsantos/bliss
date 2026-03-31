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
| `exchange` | `String?` | Primary exchange |
| `trailingEps` | `Decimal(12,4)?` | Trailing 4-quarter EPS |
| `peRatio` | `Decimal(12,4)?` | Price / trailing EPS |
| `annualizedDividend` | `Decimal(12,4)?` | 12-month dividend sum |
| `dividendYield` | `Decimal(8,6)?` | Annualized dividend / price |
| `week52High` | `Decimal(18,4)?` | 52-week high price |
| `week52Low` | `Decimal(18,4)?` | 52-week low price |
| `averageVolume` | `Decimal(18,0)?` | Average daily volume |

Indexes: `sector`, `industry`, `country`, `assetType`.

### Migration

- **File**: `prisma/migrations/20260313000000_add_security_master/migration.sql`
- Creates the `SecurityMaster` table with all columns and indexes

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

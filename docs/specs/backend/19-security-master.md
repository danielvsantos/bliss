# 19. SecurityMaster & Nightly Refresh (Backend)

This document specifies the backend service changes for the global SecurityMaster reference table and its nightly refresh pipeline.

## 19.1. Overview

The SecurityMaster table stores global (non-tenant) stock fundamental data sourced from Twelve Data APIs. This enables equity-specific analysis like sector allocation, industry breakdown, and fundamental screening.

**Scope**: Stocks only (Common Stock). ETFs and funds are deferred to a future sprint.

**Data sources (available on our Grow plan):**
- Twelve Data `/profile` (10 credits) — sector, industry, country, CEO, employees, description, website, exchange, ISIN
- Twelve Data `/earnings` (10 credits) — historical EPS (eps_estimate, eps_actual, surprise_prc)
- Twelve Data `/dividends` (20 credits) — historical dividend payments (ex_date, amount)
- Twelve Data `/quote` (1 credit, already used) — 52-week high/low, average volume

**NOT available on our plan**: `/statistics` (50 credits, requires higher plan). P/E ratio and dividend yield are computed from earnings + dividends + quote data.

**Cost per symbol (nightly refresh)**: 10 + 10 + 20 + 1 = **41 credits**

## 19.2. SecurityMaster Service

- **File**: `src/services/securityMasterService.js`

### Functions

| Function | Description |
|----------|-------------|
| `getBySymbol(symbol)` | Fetch a single SecurityMaster record by symbol |
| `getBySymbols(symbols)` | Fetch multiple records by symbol array |
| `upsertFromProfile(symbol, profileData)` | Upsert profile fields + `lastProfileUpdate` |
| `upsertFundamentals(symbol, { earnings, dividends, quote })` | Compute and upsert fundamental fields |
| `getAllActiveStockSymbols()` | Distinct symbols from PortfolioItem where `processingHint = 'API_STOCK'` and `quantity > 0` |

### Computation Logic (`upsertFundamentals`)

- **trailingEps**: Sum of last 4 quarters `eps_actual` (skipping nulls)
- **peRatio**: `currentPrice / trailingEps` (null if trailingEps <= 0 or no price)
- **annualizedDividend**: Sum of dividends with `ex_date` in last 12 months
- **dividendYield**: `annualizedDividend / currentPrice` (null if no price)
- **latestEpsActual**: Most recent non-null `eps_actual`
- **latestEpsSurprise**: Corresponding `surprise_prc`
- **week52High / week52Low / averageVolume**: From extended quote data

## 19.3. Twelve Data API Extensions

- **File**: `src/services/twelveDataService.js`

### New Rate Limiter

A third rate limiter for nightly fundamentals batch:
- `FUNDAMENTALS_THROTTLE_MS = Math.ceil(60_000 / 30)` (~2000ms, ~30 calls/min)
- `acquireFundamentalsSlot()` follows the existing `acquireImportSlot()` pattern

### New Functions

| Function | Endpoint | Credits | Returns |
|----------|----------|---------|---------|
| `getEarnings(symbol)` | `/earnings` | 10 | `{ meta, earnings: [{ date, epsEstimate, epsActual, difference, surprisePrc }] }` |
| `getDividends(symbol)` | `/dividends` | 20 | `{ meta, dividends: [{ exDate, amount }] }` |

### Enhanced Functions

- **`getSymbolProfile(symbol)`**: Now also returns `industry`, `country`, `description`, `logoUrl`, `ceo`, `employees`, `website`
- **`getLatestPrice(symbol, { extended: true })`**: Returns `{ close, week52High, week52Low, averageVolume }` instead of a plain number

## 19.4. Cache Layer

- **File**: `src/routes/ticker.js`

### Profile Endpoint Cache-First Logic

`GET /api/ticker/profile?symbol=X`:

1. Check `securityMasterService.getBySymbol(symbol)`
2. If found AND `lastProfileUpdate` within 7 days → return cached profile data
3. Otherwise → call `twelveDataService.getSymbolProfile(symbol)` → fire-and-forget `securityMasterService.upsertFromProfile()` → return

### Population Triggers

Profile data is populated on-demand via fire-and-forget `upsertFromProfile()` calls from:
- `smartImportWorker.js` — after ticker resolution for investment rows
- `plaidProcessorWorker.js` — during Plaid investment enrichment

Fundamentals data is NOT fetched eagerly; the nightly job handles it.

## 19.5. SecurityMaster API Routes

- **File**: `src/routes/securityMaster.js`
- **Auth**: `apiKeyAuth` (internal service-to-service)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/security-master?symbol=` | Single symbol lookup |
| `GET` | `/api/security-master/bulk?symbols=` | Batch lookup (comma-separated) |
| `POST` | `/api/security-master/refresh` | Enqueue on-demand refresh for a symbol |

### Route Registration

- **File**: `src/app.js`
- Added: `app.use('/api/security-master', require('./routes/securityMaster'));`

## 19.6. Nightly Refresh Worker

### Queue

- **File**: `src/queues/securityMasterQueue.js`
- Queue name: `'security-master'`
- Default job options: 2 attempts, exponential backoff (5s), removeOnComplete 24h, removeOnFail 7d

### Worker

- **File**: `src/workers/securityMasterWorker.js`
- Concurrency: 1
- Lock duration: 1,800,000ms (30 minutes for large portfolios)

### Job Types

| Job Name | Trigger | Description |
|----------|---------|-------------|
| `refresh-all-fundamentals` | Daily cron `0 3 * * *` (3 AM UTC) | Refreshes all active stock symbols |
| `refresh-single-symbol` | On-demand via `POST /api/security-master/refresh` | Refreshes one symbol (profile + fundamentals) |

### `refresh-all-fundamentals` Flow

1. `getAllActiveStockSymbols()` — all distinct stock symbols across tenants
2. For each symbol:
   - `getEarnings(symbol)` → last 4 quarters
   - `getDividends(symbol)` → last 12 months
   - `getLatestPrice(symbol, { extended: true })` → price + 52W data
   - `upsertFundamentals(symbol, { earnings, dividends, quote })`
   - If `lastProfileUpdate` > 7 days: also refresh profile
3. Reports progress via `job.updateProgress()`
4. Returns: `{ totalSymbols, refreshed, profilesRefreshed, errors, duration }`

### Worker Registration

- **File**: `src/index.js`
- Added: `workers.push(startSecurityMasterWorker());`

### Cost Math

200 stocks x 41 credits = 8,200 credits. At ~30 fundamentals calls/min + quote reuse, total runtime is approximately 20-30 minutes overnight.

## 19.7. Schema

The SecurityMaster model is defined in `prisma/schema.prisma` (synced from `bliss-finance-api`). See the migration at `bliss-finance-api/prisma/migrations/20260313000000_add_security_master/migration.sql`.

Key design decisions:
- Global table (not per-tenant) — stock fundamentals are universal
- `Decimal` types for all numeric fields to match existing Prisma patterns
- Indexes on `sector`, `industry`, `country`, `assetType` for equity analysis grouping queries

## 19.8. Seed Script

- **File**: `scripts/seed-security-master.js`
- Pre-populates SecurityMaster with top ~50 US stocks
- Run: `node scripts/seed-security-master.js`

## 19.9. Tests

- Unit tests for `securityMasterService` — computation logic (trailingEps, peRatio, dividendYield)
- Unit tests for `securityMasterWorker` — job routing, error handling
- Unit tests for `ticker.js` cache-first logic — cache hit vs miss scenarios

# 19. SecurityMaster & Nightly Refresh (Backend)

This document specifies the backend service changes for the global SecurityMaster reference table and its nightly refresh pipeline.

## 19.1. Overview

The SecurityMaster table stores global (non-tenant) stock fundamental data sourced from Twelve Data APIs. This enables equity-specific analysis like sector allocation, industry breakdown, and fundamental screening.

**Scope**: Stocks (`API_STOCK`) and, since #77 (Passive Income), ETFs — `API_FUND` holdings whose SecurityMaster `assetType` is `ETF`, or which have no row yet (the first profile fetch resolves the type). Mutual funds (`API_FUND` with a non-ETF row) are skipped. Holdings with `source: MANUAL` are always skipped: they were created without a ticker (e.g. private / unlisted funds), so their symbol is the TICKER-strategy fallback `<category>:<description>`, which Twelve Data cannot resolve. For ETFs the refresh **never calls `/earnings`** (Twelve Data returns meaningless EPS for funds) and `upsertFromProfile` **stores no sector, industry or country** (empty for US ETFs, misleading for UCITS ETFs — VWCE came back as "Basic Materials / Netherlands").

**Data sources (available on our Grow plan):**
- Twelve Data `/profile` (10 credits) — sector, industry, country, CEO, employees, description, website, exchange, ISIN
- Twelve Data `/earnings` (10 credits) — historical EPS (eps_estimate, eps_actual, surprise_prc)
- Twelve Data `/dividends` (20 credits) — historical dividend payments (ex_date, amount)
- Twelve Data `/quote` (1 credit, already used) — 52-week high/low, average volume

**NOT available on our plan**: `/statistics` (50 credits, requires higher plan). P/E ratio and dividend yield are computed from earnings + dividends + quote data.

- Twelve Data `/etfs/world/composition` (ETFs only, weekly, #79) — sector weights, country allocation, asset allocation (`top_holdings` dropped). Estimated ~1 credit; each fetch logs the `api-credits-used` header to confirm it.

**Cost per symbol (nightly refresh)**: stock 1 + 20 + 20 = **41 credits**, ETF 1 + 20 = **21 credits** (no `/earnings`); +10 when the weekly profile refresh is due; ETFs +~1 when the weekly composition refresh is due.

## 19.2. SecurityMaster Service

- **File**: `src/services/securityMasterService.js`

### Functions

| Function | Description |
|----------|-------------|
| `getBySymbol(symbol)` | Fetch a single SecurityMaster record by symbol |
| `getBySymbols(symbols)` | Fetch multiple records by symbol array |
| `upsertFromProfile(symbol, profileData)` | Upsert profile fields + `lastProfileUpdate` |
| `upsertFundamentals(symbol, { earnings, dividends, quote })` | Compute and upsert fundamental fields |
| `upsertEtfComposition(symbol, composition)` | Store `etfComposition` (normalized to fractions by `normalizeEtfComposition` from `@bliss/shared/portfolio`) + `lastCompositionUpdate` (#79) |
| `getAllActiveSecuritySymbols()` | Distinct `{ symbol, exchange }` pairs from PortfolioItem with `quantity > 0`: `API_STOCK`, plus `API_FUND` whose SecurityMaster `assetType` is `ETF` or which has no row yet (replaced `getAllActiveStockSymbols` in #77). Excludes `source: MANUAL` (ticker-less) items |
| `getTenantSecuritySymbols(tenantId, { force, staleDays = 7 })` | Same selection for one tenant. `force: false` keeps only symbols with no row or `lastFundamentalsUpdate` older than `staleDays` |
| `isEtfAssetType(type)` | `true` for the Twelve Data profile type `ETF` |
| `getAllSecurityMasterSymbols()` | All `{ symbol, exchange }` pairs from the SecurityMaster table, ordered by symbol. Used for full-table refresh |

### Computation Logic (`upsertFundamentals`)

- **trailingEps**: Sum of last 4 quarters `eps_actual` (skipping nulls). The function defensively re-sorts `withActual` newest-first before slicing — the upstream service is supposed to sort, but this is the load-bearing slice so we don't trust the input.
- **peRatio**: `currentPrice / trailingEps`. **Omitted from the update payload** (not set to `null`) when `trailingEps <= 0` or no current price — preserves any previous good value on the row, while the trust flag (see 19.10) marks the row as untrusted so consumers ignore it. A previous version unconditionally wrote `null` here, which silently wiped a prior good value when a single bad refresh hit a transient API quirk.
- **annualizedDividend**: Sum of dividends with `ex_date` in last 12 months
- **recentDividends** (JSON, #77): the same last-12-month list, stored as `[{ exDate, amount }]` newest first. Written only when the dividend fetch succeeded (a failed fetch preserves the previous value); an empty list with `dividendTrusted = true` is a trusted zero (accumulating ETFs, non-payers). Replayed by the passive income projection — see `22-passive-income.md`.
- **dividendYield**: `annualizedDividend / currentPrice`. Set to `Decimal('0')` when `annualizedDividend === 0` (the correct answer for a non-dividend stock); omitted from the update when `annualizedDividend > 0` but no current price (preserves previous value, trust flag handles the rest).
- **latestEpsActual**: Most recent non-null `eps_actual`
- **latestEpsSurprise**: Corresponding `surprise_prc`
- **week52High / week52Low / averageVolume**: From extended quote data
- **earningsTrusted / dividendTrusted**: Always written, see section 19.10.

### Date Filtering (24-hour grace window)

Twelve Data returns earnings dates in the **stock's exchange timezone**, not UTC. A 4:30 PM ET earnings call dated `today` (in ET) can appear as a date string equal to `tomorrow` when the refresh job runs at midnight UTC the previous day, eight hours earlier. Comparing strictly against UTC `today` (`e.date <= todayStr`) caused same-day earnings to be silently filtered out for non-US listings and East-coast US listings reported after market close.

Fix: filter with a 24-hour forward grace window — `e.date <= tomorrowStr`. This absorbs the timezone skew without requiring per-stock timezone resolution. The trust gate's age check (≤180 days from "now") still rejects anything genuinely future-dated.

## 19.3. Twelve Data API Extensions

- **File**: `src/services/twelveDataService.js`

### New Rate Limiter

A third rate limiter for nightly fundamentals batch:
- `FUNDAMENTALS_THROTTLE_MS = Math.ceil(60_000 / 30)` (~2000ms, ~30 calls/min)
- `acquireFundamentalsSlot()` follows the existing `acquireImportSlot()` pattern

### New Functions

| Function | Endpoint | Credits | Returns |
|----------|----------|---------|---------|
| `getEarnings(symbol)` | `/earnings` | 10 | `{ meta, earnings: [{ date, epsEstimate, epsActual, difference, surprisePrc }] }` — sorted newest-first, sanity-bounded |
| `getDividends(symbol)` | `/dividends` | 20 | `{ meta, dividends: [{ exDate, amount }] }` |

### `getEarnings` Sanity Bounds + Sort

The Twelve Data `/earnings` response is documented as sorted but is not in practice — entries can come back in any order, and the array occasionally includes malformed dates or rows wildly out of range. The service normalizes the response before returning:

1. **Sort newest-first** so consumers can rely on `slice(0, 4)` to grab the trailing 4 quarters.
2. **Drop entries older than 5 years** — useless for trailing-EPS computation.
3. **Drop entries more than 1 year in the future** — data noise, not a scheduled report.
4. **Keep near-future entries (≤1 year ahead)** — the upstream service applies its own 24-hour grace window when deciding which entries can contribute to `trailingEps`. This is the correct division of concerns: API layer cleans obvious garbage, service layer applies timezone-aware business logic.
5. **Drop entries with malformed dates** (`null`, non-parseable strings).

The previous version ran a strict `e.date <= todayStr` UTC filter at the API layer, which masked the timezone skew bug now handled at the service layer (see 19.2 *Date Filtering*).

### Enhanced Functions

- **`getSymbolProfile(symbol)`**: Now also returns `industry`, `country`, `description`, `logoUrl`, `ceo`, `employees`, `website`
- **`getLatestPrice(symbol, { extended: true })`**: Returns `{ close, currency, week52High, week52Low, averageVolume }` instead of a plain number

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
| `POST` | `/api/security-master/refresh` | Enqueue on-demand refresh for a single symbol |
| `POST` | `/api/security-master/refresh-all` | Enqueue full nightly refresh (all active stock symbols) |
| `POST` | `/api/security-master/refresh-table` | Refresh ALL SecurityMaster records (forces profile refresh) |

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
| `refresh-all-from-table` | On-demand via `POST /api/security-master/refresh-table` | Refreshes ALL SecurityMaster records (forces profile refresh). Uses `getAllSecurityMasterSymbols()` instead of active portfolio items |

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

## 19.7. Exchange Disambiguation

The worker includes logic to handle the difference between ISO-10383 MIC codes (e.g. `XNYS`, `BVMF`, `XNAS`) and display-name exchanges (e.g. `NYSE`, `NASDAQ`, `BOVESPA`). Twelve Data requires MIC codes for API calls.

### `isLikelyMicCode(exchange)`

Returns `true` if the value looks like a valid 4-character MIC code, `false` if it matches a known display name or is longer than 4 characters.

### `DISPLAY_NAME_EXCHANGES`

A `Set` of known display-name exchange strings that should NOT be passed as `mic_code` to Twelve Data: `NYSE`, `NASDAQ`, `BOVESPA`, `AMEX`, `OTC`, `LSE`, `TSE`, `SSE`, `HKSE`, `NSE`, `BSE`, `KRX`, `JPX`, `ASX`, `TSX`, `SIX`, `MOEX`, `SGX`.

### Self-healing exchange codes

During profile refresh, the worker compares the MIC code returned by Twelve Data with the exchange stored on portfolio items. If they differ, it runs `prisma.portfolioItem.updateMany()` to correct portfolio items that were created with display names instead of MIC codes. This ensures future API calls use the correct exchange identifier.

## 19.8. Schema

The SecurityMaster model is defined in `prisma/schema.prisma`. See the migration at `prisma/migrations/20260313000000_add_security_master/migration.sql`.

Key design decisions:
- Global table (not per-tenant) — stock fundamentals are universal
- `Decimal` types for all numeric fields to match existing Prisma patterns
- Indexes on `sector`, `industry`, `country`, `assetType` for equity analysis grouping queries

## 19.9. Tests

- Unit tests for `securityMasterService` — computation logic (trailingEps, peRatio, dividendYield)
- Unit tests for `securityMasterService` trust gate — flag transitions across the full matrix (4 fresh quarters, fewer than 4, stale newest, sparse span >450 days, no earnings data, dividend variants), plus the 24-hour grace window
- Unit tests for `twelveDataService.getEarnings` — sort newest-first, sanity bounds (drop >5y past, >1y future, malformed dates), keep near-future entries
- Unit tests for `securityMasterWorker` — job routing, error handling
- Unit tests for `ticker.js` cache-first logic — cache hit vs miss scenarios

## 19.10. Trust Gate

Twelve Data's `/earnings` and `/dividends` responses are inconsistent across symbols. Some symbols have sparse history, some report on exchange-local dates that off-by-one a UTC filter, some return only future-scheduled rows. Before the trust gate, the service either silently wiped good fields (writing `null` on a temporary glitch) or wrote technically-correct-but-misleading values that downstream insights and the equity analysis page would happily display.

The gate decides each refresh whether the recomputed values for a symbol are usable, and persists the decision on the row. Consumers (insights LLM context, equity analysis API, anything else surfacing P/E or yield) MUST treat the corresponding fields as `null` when the flag is `false`.

### Schema

Two booleans on `SecurityMaster`, both `NOT NULL DEFAULT false`:

- `earningsTrusted` — gates `peRatio`, `trailingEps`, `latestEpsActual`, `latestEpsSurprise`.
- `dividendTrusted` — gates `dividendYield`.

Migration: `prisma/migrations/20260427000000_add_security_master_trust_flags/migration.sql`.

### Trust Criteria

**`earningsTrusted = true`** requires all of:

1. At least 4 quarters of `eps_actual` survive the 24-hour grace filter.
2. The 4 newest quarters span ≤450 days (roughly: 4 quarterly reports plus a 30-day buffer; a wider span means missing data, not a real reporting cadence).
3. The most recent quarter is ≤180 days old (otherwise trailing EPS combined with the current price is too stale to be meaningful).
4. `peRatio` was successfully computed (current price > 0 AND trailingEps > 0).

**`dividendTrusted` = true** for any of:

1. **Non-dividend stock** — the response contains zero dividend rows. Zero IS the correct answer here, so we trust it.
2. **Active dividend payer with fresh data** — recent dividend rows exist, current price is available, and the most recent ex-date is ≤180 days old.

`dividendTrusted = false` covers:
- API returned no response (`dividends` is null).
- Historical dividends exist but nothing in the last 12 months OR nothing in the last 180 days (likely a stopped payer or stale data — we don't know which, conservative choice is to mark untrusted).
- Recent dividends exist but no current price for the yield computation.

### Constants (`securityMasterService.js`)

```js
const EARNINGS_TRUST_MAX_SPAN_DAYS = 450;  // 4 quarters + buffer
const EARNINGS_TRUST_MAX_AGE_DAYS = 180;   // staleness ceiling for trailing EPS
const DIVIDEND_TRUST_MAX_AGE_DAYS = 180;   // staleness ceiling for last ex-date
```

These can be tuned globally if calibration data shows the gate is too strict or too loose. The thresholds were chosen to balance: higher-than-typical-quarterly cadence for safety (450 not 365, 180 not 90), but tight enough that genuinely stale or sparse data is excluded.

### Preservation Rule

When this run **cannot recompute** a derived field (e.g., the earnings filter yielded zero past quarters), the field is **omitted from the Prisma update payload** rather than written as `null`. Prisma's partial-update semantics preserve the previous value on the row, while the trust flag — always written — flips to `false` so consumers stop surfacing the (possibly-stale) value.

This is the deliberate inverse of the previous failure mode where a single bad refresh would silently wipe a previously-good value.

### Operator Note

Because both flags default to `false` for existing rows after the migration, the equity analysis page will show `—` for every holding's P/E / EPS / yield until a fundamentals refresh recomputes the flags. Operators should manually trigger `POST /api/admin/refresh-fundamentals` (UI: Settings → Maintenance → "Refresh stock fundamentals") immediately after deploying — don't wait for the 3 AM cron. Users will see correct numbers within a few minutes once the refresh completes.

### Manual Refresh Trigger

A new admin endpoint, `POST /api/admin/refresh-fundamentals`, proxies to the existing internal `POST /api/security-master/refresh-all` and enqueues the same `refresh-all-fundamentals` job the nightly cron uses. The frontend exposes this as a "Refresh stock fundamentals" panel in the Maintenance tab. See `docs/specs/api/03-reference-data-management.md` section 3.5 for the API contract.


## 19.12. ETFs and the tenant-scoped refresh (#77)

- **`refresh-all-fundamentals`** (nightly 3 AM UTC) now iterates `getAllActiveSecuritySymbols()` (stocks + ETFs). In `refreshSymbol()` the asset type comes from the stored row, overridden by a fresh profile; ETFs skip `/earnings` and are upserted with `earnings: null`, so `earningsTrusted` stays `false`. One symbol failing is logged and skipped, as before.
- **`refresh-tenant-securities`** (new, same queue): data `{ tenantId, force?: boolean, _rebuildMeta? }`. Refreshes `getTenantSecuritySymbols(tenantId, { force })` with the existing `refreshSymbol()`. Enqueued through `enqueueTenantSecuritiesRefresh()` in `queues/securityMasterQueue.js`, which applies BullMQ `deduplication: { id: 'tenant-securities-<tenantId>' }` (not a fixed `jobId` — completed jobs are kept 24h). Triggers:
  - `PORTFOLIO_CHANGES_PROCESSED` carrying a non-empty `newSecuritySymbols` (new stock/ETF items from any transaction path) → `force: false`.
  - The same event carrying `_rebuildMeta.rebuildType = 'full-portfolio'` → `force: false` + `_rebuildMeta`, shown as the "Refresh securities data" step in Maintenance history.
  - `MANUAL_REBUILD_REQUESTED` scope `security-data` → `force: true` + `_rebuildMeta`. `refresh-tenant-securities` is that scope's terminal job (`utils/rebuildLock.js`); the worker's `completed` handler releases the lock.
- The rebuild status endpoint also reads the `security-master` queue so these jobs appear under "Recent rebuilds".

## 19.13. ETF composition (#79)

- **Fetch**: `twelveDataService.getEtfComposition(symbol, { micCode })` → `GET /etfs/world/composition`, on the fundamentals throttle slot. Maps `major_market_sectors` → `sectors: [{ sector, weight }]`, `country_allocation` → `countries: [{ country, weight }]`, `asset_allocation` → `assetAllocation`, plus `creditsUsed` from the response header (logged, not stored). Returns `null` on an error payload, an empty payload, a network error or a missing API key.
- **When**: inside `refreshSymbol()`, after fundamentals, only when the symbol is an ETF and `lastCompositionUpdate` is missing or older than `COMPOSITION_STALE_DAYS` (7, same cadence as the profile). The stored row is read for the staleness check even on a forced profile refresh. Both `refresh-all-fundamentals` and `refresh-tenant-securities` pick it up; no new job or cron.
- **Failure isolation**: a fetch or storage failure is logged and skipped (`result.composition = false`); the previous composition is kept and the symbol's fundamentals result is unaffected.
- **Refused requests**: when Twelve Data refuses the call outright (HTTP or body code 401 / 403 / 404 — typically `/etfs/world/composition` not being included in the API plan, or an uncovered symbol), `getEtfComposition` returns `{ unavailable: true, status, message }` and logs Twelve Data's own message. The worker then calls `markEtfCompositionAttempt()`, which stamps `lastCompositionUpdate` without touching `etfComposition`, so the symbol is retried after 7 days instead of every night. Transient failures (5xx, timeouts) don't stamp and are retried on the next run. Without composition, ETFs are classified by name (bond-like → `BOND_ETF`, otherwise `INDEX_ETF`) and stay "Diversified" in the look-through views.
- **ETF earnings**: `upsertFundamentals` receives `isEtf` and no longer logs "no earnings data available" for ETFs, which never fetch `/earnings`.
- **Storage**: `SecurityMaster.etfComposition` (JSONB, fractions) + `lastCompositionUpdate`, added by the hand-written migration `20260928120000_asset_class_override_etf_composition` (apply with `prisma migrate deploy`).
- **Consumers**: `classifyAssetClass()` (BOND_ETF when bonds ≥ 50%, SECTOR_ETF when the largest sector ≥ 75%) and `lookThrough()` in `@bliss/shared/portfolio`, used by Equity Analysis (API) and, from #80, the insights pipeline. An ETF with no composition yet stays "Diversified".
- **Rollout**: after deploy, run the global "Refresh fundamentals" once (or wait for the nightly job) so every ETF gets its composition, and check the `creditsUsed` log lines to confirm the per-call cost.


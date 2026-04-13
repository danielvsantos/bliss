# 15. Insights Engine (Backend)

This document specifies the backend architecture of the Bliss Insights engine — a tiered AI pipeline that generates structured financial insights across four cadences (monthly / quarterly / annual / portfolio), gated by data completeness, persisted additively, and retained on a per-tier TTL.

## 15.1. Overview

The insights engine replaces the v0 single-tier architecture (one daily cron over 6 months of data, 7 lenses, atomic batch replacement) with a four-tier model that separates cadence from depth. Each tier uses the prompt, model, data window, and LLM temperature appropriate to its purpose.

> **Note — DAILY tier retired.** A fifth DAILY tier (Gemini Flash, 30-day window) shipped briefly in v1 but was removed in the insights-v1.1 refactor. Daily deltas were too noisy to produce signal — single-transaction swings inflated into dramatic percentage changes, and MONTHLY insights already covered the same observations with a full-period comparison. The Flash model path, the `generate-daily-pulse` job, and the `INSIGHT_MODEL_FAST` environment variable have all been removed.

The pipeline is event-driven and calendar-aware:

1. A daily cron (`generate-all-insights`, 06:00 UTC) scans every tenant and checks whether MONTHLY / QUARTERLY / ANNUAL are due today under the calendar rules in 15.6.3. On a non-trigger day the cron is a no-op.
2. A weekly cron (`generate-portfolio-intel`, Mondays 05:00 UTC) runs the PORTFOLIO tier for tenants with any portfolio items (completeness gating inside `generateTieredInsights` handles tenants without meaningful data).
3. Any tier can be triggered on-demand via `POST /api/insights/generate` with `{ tier, year?, month?, quarter?, force? }`. `tier` is **required** — there is no DAILY fallback.

All runs pass through a completeness gate, a data-hash dedup, and a dismissed-state preservation step before persisting insights. Old insights are **never** deleted by new runs — only by the TTL cleanup job.

| Tier      | Cadence             | Model       | Data Window                                    | Purpose                                      |
|-----------|---------------------|-------------|------------------------------------------------|----------------------------------------------|
| MONTHLY   | 2nd of month        | Pro         | Full month vs prior month + same month YoY    | Monthly health check                         |
| QUARTERLY | 3 days after Q close| Pro         | Full quarter vs prior quarter + same quarter YoY | Seasonal trends, deep analysis              |
| ANNUAL    | Jan 3rd             | Pro         | Full year vs 1–2 prior years                   | Comprehensive year-in-review                 |
| PORTFOLIO | Weekly Mon 05:00 UTC| Pro         | Current holdings + SecurityMaster fundamentals | Equity-specific intelligence                 |

Critical files:

- `src/services/insightService.js` — Tiered data gathering, prompt templates, orchestration
- `src/services/dataCompletenessService.js` — Per-tier completeness gate
- `src/services/insightRetentionService.js` — TTL cleanup + retention stats
- `src/services/geminiService.js` — Dual-model wrapper (`generateInsightContent`)
- `src/workers/insightGeneratorWorker.js` — BullMQ worker + cron registration
- `src/routes/insights.js` — Internal HTTP endpoints
- `prisma/schema.prisma` — `Insight` model with tier/category/periodKey/expiresAt

## 15.2. Lens Inventory

Fifteen lenses grouped into six categories. Each lens is active in a subset of tiers defined by `TIER_LENSES`.

| Category   | Lens                     | Source Tiers                       |
|------------|--------------------------|-------------------------------------|
| SPENDING   | SPENDING_VELOCITY        | MONTHLY, QUARTERLY, ANNUAL         |
| SPENDING   | CATEGORY_CONCENTRATION   | MONTHLY, QUARTERLY, ANNUAL         |
| SPENDING   | UNUSUAL_SPENDING         | MONTHLY                            |
| INCOME     | INCOME_STABILITY         | MONTHLY, QUARTERLY, ANNUAL         |
| INCOME     | INCOME_DIVERSIFICATION   | QUARTERLY, ANNUAL                  |
| SAVINGS    | SAVINGS_RATE             | MONTHLY, QUARTERLY, ANNUAL         |
| SAVINGS    | SAVINGS_TREND            | QUARTERLY, ANNUAL                  |
| PORTFOLIO  | PORTFOLIO_EXPOSURE       | PORTFOLIO                          |
| PORTFOLIO  | SECTOR_CONCENTRATION     | PORTFOLIO                          |
| PORTFOLIO  | VALUATION_RISK           | PORTFOLIO                          |
| PORTFOLIO  | DIVIDEND_OPPORTUNITY     | PORTFOLIO                          |
| DEBT       | DEBT_HEALTH              | MONTHLY, QUARTERLY, ANNUAL         |
| DEBT       | DEBT_PAYOFF_TRAJECTORY   | QUARTERLY, ANNUAL                  |
| NET_WORTH  | NET_WORTH_TRAJECTORY     | MONTHLY, QUARTERLY, ANNUAL         |
| NET_WORTH  | NET_WORTH_MILESTONES     | MONTHLY, QUARTERLY, ANNUAL         |

The `LENS_CATEGORY_MAP` and `TIER_LENSES` constants are exported from `insightService.js` and must stay in sync with the Prisma `Insight.category` column defaults and the API/frontend `VALID_CATEGORIES` lists.

## 15.3. Data Completeness Service

- **File**: `src/services/dataCompletenessService.js`
- **Purpose**: Gate every tier run so the LLM never compares partial periods to complete ones.

### 15.3.1. Entry Point

```javascript
checkTierCompleteness(tenantId, tier, { year, month, quarter, force })
// → { canRun, details, comparisonAvailable }
// → { canRun: true, forced: true, details: null }  when force === true
```

Delegates to tier-specific checks:

| Function                                      | Rule                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------|
| `checkMonthCompleteness(tenantId, y, m)`      | Month is closed + transactions present on ≥ 80% of weekdays          |
| `checkQuarterCompleteness(tenantId, y, q)`    | Quarter is closed + all 3 months pass `checkMonthCompleteness`       |
| `checkYearCompleteness(tenantId, y)`          | Year is closed + ≥ 10 months pass `checkMonthCompleteness`           |
| `checkPortfolioTierCompleteness(tenantId)`    | ≥ 1 priced holding with a ticker and SecurityMaster fundamentals     |

When a tier run is gated, the caller returns `{ skipped: true, reason }` instead of proceeding to the LLM. `force: true` bypasses the gate.

### 15.3.2. Comparison-Period Awareness

For MONTHLY/QUARTERLY/ANNUAL, completeness is also computed for the comparison periods (prior period, same-period-last-year). The result is returned as `comparisonAvailable: { prior: boolean, yoy: boolean }` and threaded into the prompt — when `false`, the LLM is instructed to produce standalone observations instead of comparisons.

### 15.3.3. Period Keys

`getPeriodKey(tier, date)` produces the canonical `Insight.periodKey` per tier:

| Tier      | Format        | Example       |
|-----------|--------------|---------------|
| MONTHLY   | `YYYY-MM`    | `2026-03`     |
| QUARTERLY | `YYYY-Q#`    | `2026-Q1`     |
| ANNUAL    | `YYYY`       | `2025`        |
| PORTFOLIO | `YYYY-W##`   | `2026-W15`    |

Helpers `getPreviousPeriod`, `getYoYPeriod`, `getQuarterMonths`, `getQuarterFromMonth`, and `countWeekdays` support the prompt builders and the completeness checks.

## 15.4. Tier-Specific Data Gatherers

Each tier has a dedicated gatherer in `insightService.js`. All gatherers return a `tenantData` object consumed by `buildTieredPrompt()` and hashed by `dataHash` for dedup.

| Function                                                       | Primary Sources                                                   |
|----------------------------------------------------------------|-------------------------------------------------------------------|
| `gatherMonthlyData(tenantId, year, month, comparisonAvailable)`| `AnalyticsCacheMonthly` (target + prior + YoY month)              |
| `gatherQuarterlyData(tenantId, year, quarter, comparisonAvailable)` | `AnalyticsCacheMonthly` (3 months × target + prior Q + YoY Q) |
| `gatherAnnualData(tenantId, year, comparisonAvailable)`        | `AnalyticsCacheMonthly` (12 months × target + 1–2 prior years)    |
| `gatherPortfolioIntelligenceData(tenantId)`                    | `PortfolioItem`, `SecurityMaster` (sector, P/E, yield, 52W)       |
| `gatherEquityFundamentals(tenantId)`                           | `PortfolioItem` ⋈ `SecurityMaster` (trailing EPS, dividend yield) |

All monetary values are converted to the tenant's portfolio currency before being passed to the LLM. Currency rate access is **strictly read-only** — see 15.4.1 below for the planner pattern that enforces this. Currency symbols used in prompts are looked up from the `CURRENCY_SYMBOLS` map.

### 15.4.1. Currency Rate Access — Read-Only Policy

The insights engine is a **pure read consumer** of the `CurrencyRate` table. It must never populate it. This invariant was introduced in the insights-v2 refactor after a regression where the daily insights cron was calling `getOrCreateCurrencyRate()` (a write-through cache in `currencyService.js`) and triggering CurrencyLayer billing alerts every morning — the script was inserting fresh rate rows on every run instead of consuming rates that had already been populated by the valuation pipeline.

**Who is allowed to write to `CurrencyRate`:**

- `portfolioWorker` (valuation, cash processing, liability processing)
- `priceService` / `priceFetcher` (portfolio asset valuation strategies)

Both call `getOrCreateCurrencyRate()` from `currencyService.js`, which checks the cache, then the DB, then CurrencyLayer, and `INSERT`s a row on a miss. That helper carries a prominent `⚠️ WRITE-THROUGH CACHE` JSDoc banner listing its authorized callers.

**Who must only read from `CurrencyRate`:**

- `insightService.js` (every tier)
- Any future read-only consumer (analytics exports, report generation, etc.)

**Planner pattern (`prefetchRatesForTier`):**

Every tier run starts by pre-fetching all currency rates it will need in a bounded number of bulk range queries — one per `(currencyFrom, currencyTo)` pair covering the full tier window:

```javascript
async function prefetchRatesForTier({ tenantId, portfolioCurrency, startDate, endDate, rateCache }) {
  // 1. Discover distinct currencies in the tenant's portfolio
  const positions = await prisma.portfolioItem.findMany({
    where: { tenantId, currency: { not: null } },
    select: { currency: true },
    distinct: ['currency'],
  });

  // 2. Build the pair set: { USD → portfolioCurrency, + each holding currency → portfolioCurrency }
  //    USD is always included because PortfolioValueHistory stores valueInUSD
  const pairs = buildPairSet(positions, portfolioCurrency);

  // 3. Apply a 30-day floor on the fetch window so PORTFOLIO (which passes today..today)
  //    still has weekend/holiday fallback candidates in the cache
  const effectiveStart = applyThirtyDayFloor(startDate, endDate);

  // 4. Fire one getRatesForDateRange() per pair in parallel
  await Promise.all([...pairs].map(async (pair) => {
    const rates = await getRatesForDateRange(effectiveStart, endDate, pair.from, pair.to);
    for (const [dateStr, rate] of rates.entries()) {
      rateCache[`${dateStr}_${pair.from}_${pair.to}`] = rate;
    }
  }));
}
```

After `prefetchRatesForTier` returns, every downstream `convertAmount()` call is a **synchronous, pure, in-memory lookup** via `lookupCurrencyRate()`:

```javascript
function lookupCurrencyRate(dateObj, currencyFrom, currencyTo, rateCache) {
  if (!currencyFrom || currencyFrom === currencyTo) return 1;

  const dateStr = dateObj.toISOString().slice(0, 10);
  const exactKey = `${dateStr}_${currencyFrom}_${currencyTo}`;
  if (rateCache[exactKey] != null) return Number(rateCache[exactKey]);

  // Nearest-prior fallback for weekends, holidays, and market closures —
  // standard financial practice when a specific date is missing
  return scanNearestPrior(dateStr, currencyFrom, currencyTo, rateCache);
}
```

On a true cache miss (no exact date **and** no prior date for the pair in the window), `convertAmount()` returns the unconverted amount — the same graceful degradation as the pre-v2 implementation. It never falls back to the DB or to an external API from within an insights tier run.

**Per-tier prefetch windows:**

| Tier      | `startDate`                  | Rationale                                              |
|-----------|------------------------------|--------------------------------------------------------|
| MONTHLY   | 6 months before target month | Covers the net-worth history window used by `gatherNetWorthHistory` |
| QUARTERLY | 12 months before target quarter | Covers the 12-month net-worth lookback                |
| ANNUAL    | Start of (year − 2)          | Covers the 3-year net-worth lookback                  |
| PORTFOLIO | Today (expanded by 30-day floor) | Reads current state only; floor covers holidays    |

**Structural invariant (hygiene test):**

`src/__tests__/unit/services/insightService.hygiene.test.js` enforces the read-only policy at CI time. It mocks:

- Every write method on `prisma.currencyRate` (`create`, `createMany`, `upsert`, `update`, `updateMany`, `delete`, `deleteMany`, plus `findUnique` / `findFirst` which are the individual-row lookup path) to throw on invocation.
- `getOrCreateCurrencyRate` and `fetchHistoricalRate` from `currencyService.js` to throw.
- `axios.get` / `axios.post` to throw.

It then runs all five tiers with `force: true` and asserts none of the forbidden operations fired. It also does two static source checks against `insightService.js`:

```javascript
expect(src).not.toMatch(/\bgetOrCreateCurrencyRate\s*[,}]/); // destructuring imports
expect(src).not.toMatch(/\bgetOrCreateCurrencyRate\s*\(/);   // call sites
expect(src).not.toMatch(/require\(['"]axios['"]\)/);          // axios imports
```

Comment mentions are stripped before the static check so the warning banner at the top of `insightService.js` (which legitimately names the forbidden symbol to explain the policy) doesn't false-positive.

If a future refactor reintroduces the write-through path — directly, transitively via a new service import, or via `axios` — CI fails immediately instead of letting the regression land silently and get discovered by CurrencyLayer billing alerts.

## 15.5. Prompt Architecture

- **Entry point**: `buildTieredPrompt(tier, tenantData, activeLenses)`
- **Helper**: `filterActiveLenses(tier, tenantData)` — prunes lenses that have no data (e.g. PORTFOLIO lenses when a tenant has no equity holdings)

All tiers share a base voice contract: financial concierge, no exclamation points, precise numbers (with currency symbol), one paragraph per insight, no explicit advice. All tiers return the same JSON schema:

```json
[
  {
    "lens": "SPENDING_VELOCITY",
    "title": "Short headline",
    "body": "2–6 sentence observation",
    "severity": "POSITIVE | INFO | WARNING | CRITICAL",
    "priority": 1,
    "category": "SPENDING",
    "metadata": {
      "dataPoints": { },
      "actionTypes": ["BUDGET_OPTIMIZATION"],
      "relatedLenses": ["SAVINGS_RATE"],
      "suggestedAction": "Optional single-sentence CTA"
    }
  }
]
```

Tier-specific rules:

| Tier      | Title cap | Body length | Output volume                                  |
|-----------|-----------|-------------|------------------------------------------------|
| MONTHLY   | 8 words   | 2–4 sent.   | 1 insight per active lens                      |
| QUARTERLY | 10 words  | 3–5 sent.   | 1–2 insights per active lens                   |
| ANNUAL    | 12 words  | 4–6 sent.   | 2–3 insights per category (not per lens)       |
| PORTFOLIO | 8 words   | 2–4 sent.   | 1 insight per active portfolio lens            |

## 15.6. Generation Orchestration

The service exposes three public entry points:

### 15.6.1. `generateTieredInsights(tenantId, tier, params)`

Full flow for one (tenant, tier) pair:

1. **Validate tier** against `VALID_TIERS`. Unknown tiers throw. There is no default — callers must pass a tier.
2. **Completeness gate** via `checkTierCompleteness(...)`. If blocked and `force !== true`, return `{ skipped: true, reason: details }` without touching Gemini.
3. **Gather tier data** via the matching `gather*Data` function.
4. **Compute `dataHash`** (SHA-256 of `tenantData` + active lenses).
5. **Dedup check**: `prisma.insight.findFirst({ where: { tenantId, tier, periodKey, dataHash } })`. If a row exists and `force !== true`, return `{ skipped: true, reason: 'DEDUP' }`.
6. **Filter active lenses** via `filterActiveLenses(tier, tenantData)` — drops PORTFOLIO lenses when no equity, etc.
7. **Build prompt** via `buildTieredPrompt(tier, tenantData, activeLenses)`.
8. **LLM call** via `generateInsightContent(prompt)` — always uses the Pro model (no fast-model path in v1.1).
9. **Validate response**: each insight must carry a known `lens`, `severity ∈ VALID_SEVERITIES`, `priority ∈ [1, 100]`, `actionTypes ⊆ VALID_ACTION_TYPES`. Invalid insights are dropped with a warning log.
10. **Dismissed state preservation**: for any returned insight whose `(tenantId, lens, periodKey)` already has a dismissed row, inherit `dismissed: true`.
11. **Compute `expiresAt`** from `TIER_TTL_DAYS[tier]` (null for ANNUAL).
12. **Persist** via `prisma.insight.createMany(...)` (additive — no deletion of prior batches).
13. Return `{ insights, skipped: false, dataHash, periodKey, tier }`.

### 15.6.2. `generateInsights(tenantId)` — Removed

The v0 legacy wrapper has been removed along with the DAILY tier. Any remaining caller that imports `generateInsights` will fail at require-time. All entry points — the worker, the API route, the force-generate script — now call `generateTieredInsights(tenantId, tier, options)` directly with an explicit tier.

### 15.6.3. `generateAllDueTiers(tenantId)`

Calendar-driven fan-out used by `generate-all-insights`:

- **MONTHLY**: runs only on calendar days 1–3 (prior month)
- **QUARTERLY**: runs only on days 1–5 of Jan/Apr/Jul/Oct (prior quarter)
- **ANNUAL**: runs only on Jan 1–5 (prior year)

Returns `{ MONTHLY?, QUARTERLY?, ANNUAL? }` where each value is the result object from `generateTieredInsights(...)`. Tiers that aren't due today are omitted (not marked skipped). On a non-trigger day the return value is the empty object `{}` and the daily cron logs a no-op summary.

## 15.7. Persistence Model

The `Insight` model carries four v1-specific fields:

| Field       | Type        | Notes                                                                 |
|-------------|-------------|-----------------------------------------------------------------------|
| `tier`      | String      | `MONTHLY` \| `QUARTERLY` \| `ANNUAL` \| `PORTFOLIO`                    |
| `category`  | String      | `SPENDING` \| `INCOME` \| `SAVINGS` \| `PORTFOLIO` \| `DEBT` \| `NET_WORTH` |
| `periodKey` | String      | See 15.3.3 for per-tier format                                        |
| `expiresAt` | DateTime?   | `null` for ANNUAL; otherwise `createdAt + TIER_TTL_DAYS[tier]`        |

> Historical DAILY rows from the v1 → v1.1 window are pruned manually by the operator (there is no bundled cleanup script). The `tier` enum is stored as a plain string column so removing a value does not require a schema migration — and no new DAILY rows can be produced by the runtime because every write path now requires a tier from `VALID_TIERS = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'PORTFOLIO']`.

Indexes:

```
@@index([tenantId, date])
@@index([tenantId, batchId])
@@index([tenantId, tier, periodKey])
@@index([tenantId, category])
@@index([expiresAt])
```

### 15.7.1. Additive Persistence

Previous batches are never deleted by new runs. Dedup is handled by the `(tenantId, tier, periodKey, dataHash)` check described in 15.6.1 step 5. This preserves full historical insight data for trend tracking.

### 15.7.2. Dismissed State Preservation

When a tenant dismisses an insight and a later run regenerates the same `(tenantId, lens, periodKey)` pair, the new row inherits `dismissed: true`. This prevents users from having to re-dismiss the same insight after a `force: true` regeneration.

## 15.8. Retention Service

- **File**: `src/services/insightRetentionService.js`

### 15.8.1. `cleanupExpiredInsights()`

Deletes all rows where `expiresAt < now()` and returns the deleted count. Exposed via `POST /api/insights/cleanup` for scheduled external invocation (or operator tooling).

TTL map:

```javascript
const TIER_TTL_DAYS = {
  MONTHLY: 730,      // ~2 years
  QUARTERLY: 1825,   // ~5 years
  ANNUAL: null,      // never expires
  PORTFOLIO: 365,    // 1 year
};
```

### 15.8.2. `getRetentionStats(tenantId)`

Returns per-tier counts + oldest/newest timestamps, plus the total number of currently-expired rows. Used by operator tooling to audit retention behavior.

## 15.9. Worker & Cron Registration

- **File**: `src/workers/insightGeneratorWorker.js`
- **Queue**: `insights` (BullMQ)
- **Concurrency**: `1`
- **Lock duration**: `600000ms` (10 min — LLM calls can be slow)

### 15.9.1. Job Types

| Job name                     | Trigger                         | Handler                                                                 |
|------------------------------|---------------------------------|-------------------------------------------------------------------------|
| `generate-tenant-insights`   | On-demand (POST `/generate`)    | Routes to `generateTieredInsights(tenantId, tier, options)` — `tier` is required |
| `generate-all-insights`      | Daily cron 06:00 UTC            | Loops tenants with transactions, calls `generateAllDueTiers` (no-op on non-trigger days) |
| `generate-portfolio-intel`   | Weekly cron Mon 05:00 UTC       | Loops tenants with portfolio items, calls `generateTieredInsights(PORTFOLIO)` |

> The `generate-daily-pulse` job type was removed in v1.1. Enqueuing it now throws from the worker handler as an unknown job name.

### 15.9.2. Cron Registration

At startup, `startInsightGeneratorWorker()` registers two repeatable jobs on the insights queue:

```javascript
queue.add('generate-all-insights', {}, {
  repeat: { pattern: '0 6 * * *' },
  jobId: 'daily-insight-generation',
});

queue.add('generate-portfolio-intel', {}, {
  repeat: { pattern: '0 5 * * 1' },
  jobId: 'weekly-portfolio-intel',
});
```

### 15.9.3. Per-Tenant Error Handling

Both `generate-all-insights` and `generate-portfolio-intel` loop over tenants serially with a 1-second delay between iterations (rate-limit protection). Per-tenant failures are caught inline, the `errors` counter is incremented, and the error is reported via `Sentry.withScope(...)` + `Sentry.captureException(...)`. The loop continues on to the next tenant.

Per-record inline Sentry calls are intentional here — these are per-tenant failures the worker decided to keep processing past, not the job-level retry signal.

### 15.9.4. `worker.on('failed')` — Retry-Aware Reporting

Job-level failures route through `reportWorkerFailure` from `src/utils/workerFailureReporter.js`:

```javascript
worker.on('failed', (job, error) => {
  reportWorkerFailure({
    workerName: 'insightGenerator',
    job,
    error,
    extra: {
      tier: job?.data?.tier,
      periodKey: job?.data?.periodKey,
    },
  });
});
```

The helper downgrades intermediate retries to `warn` and only calls `Sentry.captureException` on the final exhausted attempt. Never call `Sentry.captureException` directly from `worker.on('failed')` — BullMQ fires it on every attempt, which would produce false alarms for transient errors (Prisma Accelerate cold starts, Gemini 429s, Redis blips).

## 15.10. Gemini Integration

- **File**: `src/services/geminiService.js`
- **Insight entry point**: `generateInsightContent(prompt, options)`

### 15.10.1. Single-Model Selection

```javascript
const INSIGHT_MODEL = process.env.INSIGHT_MODEL || 'gemini-3.1-pro-preview';

function generateInsightContent(prompt, { temperature = 0.4 } = {}) {
  const model   = INSIGHT_MODEL;
  const timeout = 60_000;
  // …
}
```

All tiers use the Pro model. The Flash-model path (`useFastModel`) was removed in v1.1 along with the DAILY tier — the only caller that used Flash.

### 15.10.2. Retry & Backoff

`MAX_RETRIES = 5`. Non-429 errors back off 1s → 2s → 4s. Rate-limit (429) errors back off 60s → 120s → 180s. `isRateLimitError(error)` classifies errors by status code and message pattern.

## 15.11. Environment Variables

| Variable             | Default                    | Purpose                                          |
|----------------------|----------------------------|--------------------------------------------------|
| `INSIGHT_MODEL`      | `gemini-3.1-pro-preview`   | Model for every tier                             |
| `GEMINI_API_KEY`     | —                          | Required for any insight generation              |

> `INSIGHT_MODEL_FAST` was removed in v1.1. If present in an old `.env` file it is ignored.

When `GEMINI_API_KEY` is unset the service logs a warning and returns `{ skipped: true, reason: 'NO_API_KEY' }` rather than throwing.

## 15.12. Observability

- **Structured logs**: every tier run logs `{ jobId, tenantId, tier, periodKey, duration, insightCount, skipped }` at `info` level
- **Breadcrumbs**: `Sentry` breadcrumbs per tier + per tenant during cron fan-out
- **Inline failures**: per-tenant errors in the loop use `Sentry.withScope` with `tier` + `tenantId` tags
- **Job-level failures**: routed through `reportWorkerFailure` (retry-aware, see 15.9.4)

## 15.13. Tests

### Unit Tests

- **File**: `src/__tests__/unit/services/insightService.test.js`
  - Tier validation (`VALID_TIERS`, `VALID_CATEGORIES`) — enforces no DAILY member
  - `filterActiveLenses` per tier
  - `generateTieredInsights` happy-path per tier
  - Completeness gating + `force: true` bypass
  - Dedup via `(tenantId, tier, periodKey, dataHash)`
  - Dismissed state preservation across regeneration
  - Severity/priority validation (drops invalid insights)
  - `generateAllDueTiers` calendar gating (MONTHLY/QUARTERLY/ANNUAL only on trigger days) — explicitly asserts no DAILY key in the result

- **File**: `src/__tests__/unit/services/insightService.hygiene.test.js`
  - Structural invariant — enforces the read-only currency rate policy (15.4.1)
  - Forbids `prisma.currencyRate.{create,createMany,upsert,update,delete,findUnique,findFirst,...}` during any tier run
  - Forbids `currencyService.getOrCreateCurrencyRate` and `currencyService.fetchHistoricalRate`
  - Forbids any `axios.get` / `axios.post` egress
  - Static source check: no destructuring import or call site for `getOrCreateCurrencyRate` in `insightService.js`
  - Static source check: no `require('axios')` in `insightService.js`
  - Runs all four tiers with `force: true` so the completeness gate doesn't short-circuit the assertions

- **File**: `src/__tests__/unit/workers/insightGeneratorWorker.test.js`
  - Startup wiring (daily cron + weekly portfolio-intel cron + `worker.on('failed')` → `reportWorkerFailure`)
  - `generate-tenant-insights` tiered path — asserts `tier` is required
  - `generate-tenant-insights` skipped-result handling
  - `generate-all-insights` per-tier aggregation + skipped counting + error continuation (MONTHLY/QUARTERLY/ANNUAL only)
  - `generate-portfolio-intel` portfolio-items query shape + error continuation
  - Unknown job name throws (including the retired `generate-daily-pulse`)

### Integration Tests

- **File**: `src/__tests__/integration/routes/insights.test.js`
  - `POST /api/insights/generate` validation (tier, tier-specific params)
  - Enqueue contract (job name + payload)
  - `POST /api/insights/cleanup` auth + happy-path + error path

Tests mock BullMQ, Prisma, Gemini, and the retention service. The `dataCompletenessService` date helpers (`getPeriodKey`, `getQuarterMonths`, `getQuarterFromMonth`) are kept as real implementations via `jest.requireActual` so period-key assertions exercise real logic.

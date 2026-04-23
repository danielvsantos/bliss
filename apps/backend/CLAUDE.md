# Bliss Backend (Express + BullMQ)

This is the internal service that handles all async processing: AI classification, portfolio valuation, Plaid sync, analytics aggregation, and insights generation. It is not publicly accessible -- all requests come from the API layer via `INTERNAL_API_KEY`.

## Module system: CommonJS

All files use `require()` / `module.exports`. **Never use `import` / `export` in this app.** This is the most common mistake when switching between apps.

## Directory structure

```
apps/backend/src/
  index.js              # Entry point: Redis init, worker startup, Express server, graceful shutdown
  app.js                # Express app: Helmet, CORS, routes, Sentry error handler
  config/
    classificationConfig.js   # All AI classification tuning constants (single source of truth)
  middleware/
    apiKeyAuth.js       # X-API-KEY header validation against INTERNAL_API_KEY
  routes/               # Express route handlers (all require apiKeyAuth)
    events.js           # POST /api/events -- event ingestion from API layer
    feedback.js         # POST /api/feedback -- user classification corrections
    similar.js          # GET /api/similar -- pgvector similarity search
    ticker.js           # GET /api/ticker/search, /api/ticker/profile -- symbol lookup
    pricing.js          # GET /api/pricing -- asset price lookup
    insights.js         # GET /api/insights -- financial insights
    securityMaster.js   # GET /api/security-master -- stock fundamentals
    adminRoutes.js      # POST /api/admin -- embedding regeneration
  services/             # Business logic
  workers/              # BullMQ job processors (8 workers + commitWorker helper)
  queues/               # BullMQ queue definitions (8 queues)
  utils/                # Logging, caching, hashing, encryption, Redis
  __tests__/
    unit/               # Jest unit tests (mocked dependencies)
    integration/routes/ # Jest + supertest (real Express + real Postgres, mocked queues)
    helpers/            # Tenant factory for test isolation
    setup/              # env.js (loads .env.test), sentry.js (mocks Sentry)
```

## Startup (`index.js`)

Controlled by `START_MODE` environment variable:

| Mode | What starts | Use case |
|------|-------------|----------|
| `all` (default) | Express server + all workers | Local development |
| `web` | Express server only | Production API instance (lightweight) |
| `worker` | All workers only | Production worker instance (high CPU/RAM) |

Startup sequence: validate env -> init Redis -> start workers (if applicable) -> start Express (if applicable). Shutdown: close workers -> disconnect Redis -> exit.

## Event-driven architecture

The API layer dispatches events via `POST /api/events`. The `eventSchedulerWorker` routes them to the appropriate queue:

| Event type | Target queue | Worker |
|------------|-------------|--------|
| `SMART_IMPORT_REQUESTED` | smart-import | smartImportWorker |
| `SMART_IMPORT_COMMIT` | smart-import | smartImportWorker (commit path) |
| `PLAID_INITIAL_SYNC`, `PLAID_SYNC_UPDATES` | plaid-sync | plaidSyncWorker |
| `PLAID_HISTORICAL_BACKFILL` | plaid-sync | plaidSyncWorker |
| `MANUAL_PORTFOLIO_PRICE_UPDATED` | portfolio | portfolioWorker |
| `MANUAL_TRANSACTION_MODIFIED`, `MANUAL_TRANSACTION_CREATED` | portfolio | portfolioWorker |
| `TRANSACTIONS_IMPORTED` | portfolio | portfolioWorker |
| `PORTFOLIO_CHANGES_PROCESSED` | analytics | analyticsWorker |
| `CASH_HOLDINGS_PROCESSED` | analytics | analyticsWorker |
| `ANALYTICS_RECALCULATION_COMPLETE` | insights | insightGeneratorWorker |
| `TAG_ASSIGNMENT_MODIFIED` | analytics | analyticsWorker |
| `PORTFOLIO_STALE_REVALUATION` | portfolio | portfolioWorker (debounced 30min) |
| `TENANT_CURRENCY_SETTINGS_UPDATED` | portfolio | portfolioWorker |

**Critical:** `originalScope` and `portfolioItemIds` must be threaded through the entire pipeline from event source to final worker. Dropping these breaks scoped (incremental) updates.

## Workers reference

| Worker | Queue | Concurrency | Lock duration | Key job types |
|--------|-------|-------------|---------------|---------------|
| `eventSchedulerWorker` | event-scheduler | 1 | default | Routes events to queues |
| `smartImportWorker` | smart-import | 1 | 600s | `process-smart-import`, `commit-smart-import` (commit logic in `commitWorker.js`, loaded lazily) |
| `plaidSyncWorker` | plaid-sync | default | default | `plaid-sync-job` |
| `plaidProcessorWorker` | plaid-processor | 1 | 600s | `process-plaid-transactions` |
| `portfolioWorker` | portfolio | 5 | 300s | `process-portfolio-changes`, `process-cash-holdings`, `recalculate-portfolio-item`, `recalculate-portfolio-items`, `process-simple-liability`, `process-amortizing-loan`, `value-portfolio-items`, `value-all-assets`, `generate-portfolio-valuation`, `revalue-all-tenants` (cron 4AM UTC) |
| `analyticsWorker` | analytics | 1 | 300s | `full-rebuild-analytics`, `scoped-update-analytics` |
| `insightGeneratorWorker` | insights | 1 | 600s | `generate-all-insights` (cron 6AM UTC), `generate-tenant-insights` |
| `securityMasterWorker` | security-master | 1 | 1800s | `refresh-all-fundamentals` (cron 3AM UTC), `refresh-single-symbol` |

## Worker implementation pattern

All workers follow this structure:

```javascript
const { Worker } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');

const processJob = async (job) => {
  const { name, data } = job;
  switch (name) {
    case 'job-type-1': return await handleJobType1(data);
    case 'job-type-2': return await handleJobType2(data);
    default: throw new Error(`Unknown job: ${name}`);
  }
};

const startWorker = () => {
  const worker = new Worker(QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency: N,
  });
  // Retry-aware failure reporting: `worker.on('failed', ...)` fires on EVERY
  // failed attempt. The helper downgrades intermediate retries to `warn` and
  // only reports to Sentry on the final exhausted attempt. Bypassing this
  // helper (calling `Sentry.captureException` directly in `on('failed')`)
  // causes false alarms whenever BullMQ recovers from a transient error.
  worker.on('failed', (job, err) => {
    reportWorkerFailure({
      workerName: WORKER_NAME,
      job,
      error: err,
      extra: { /* worker-specific context */ },
    });
  });
  return worker; // returned for graceful shutdown
};
```

### Failure reporting — MANDATORY pattern

All workers **must** use `reportWorkerFailure` from `src/utils/workerFailureReporter.js`
inside their `worker.on('failed', ...)` handler. Never call `Sentry.captureException`
directly from that event — BullMQ fires `failed` on every retry, which produces false
alarms for transient errors (Prisma Accelerate P6008 cold starts, P6004 query timeouts,
Redis blips, Plaid race conditions).

The helper:
- Logs every attempt (intermediate attempts at `warn`, final at `error`)
- Only calls `Sentry.captureException` when `attemptsMade >= opts.attempts`
- Threads standard context (worker name, jobId, tenantId, attemptsMade) automatically
- Accepts a `extra` object for worker-specific Sentry context

Direct inline `Sentry.captureException` calls inside a worker's business logic
(e.g. for per-record failures that don't bubble to the `failed` event) are fine and
don't need the helper — those are real failures the caller decided to keep processing
past.

## Services reference

**AI classification:**

| Service | Purpose |
|---------|---------|
| `categorizationService.js` | 4-tier waterfall: exact match -> vector match (tenant) -> vector match (global) -> LLM |
| `services/llm/` | Provider-agnostic LLM factory. Resolves primary + embedding adapters at module load based on `LLM_PROVIDER` / `EMBEDDING_PROVIDER`. Public API: `generateEmbedding()`, `classifyTransaction()`, `generateInsightContent()`, `isRateLimitError()`. Contains `geminiAdapter.js`, `openaiAdapter.js`, `anthropicAdapter.js`, plus `baseAdapter.js` (shared retry/timeout) and `jsonExtractor.js` (robust parsing for Anthropic). See `docs/specs/backend/20-llm-provider-abstraction.md`. |

**Market data:**

| Service | Purpose |
|---------|---------|
| `twelveDataService.js` | Twelve Data API: stock/fund/crypto prices, profiles, earnings, dividends. 3 independent rate limiters |
| `stockService.js` | Stock/ETF price dispatch |
| `cryptoService.js` | Crypto pair prices (e.g., `BTC/EUR`) |
| `currencyService.js` | Exchange rate lookups |
| `priceService.js` | Unified price fetching (delegates to appropriate provider) |
| `securityMasterService.js` | SecurityMaster table: upsert profile, compute fundamentals (P/E, dividend yield) |

**Import & processing:**

| Service | Purpose |
|---------|---------|
| `adapterEngine.js` | CSV/XLSX adapter detection by header intersection, amount strategy dispatch |
| `debounceService.js` | 5-second debounce window for job consolidation |
| `insightService.js` | 7-lens financial analysis: data gathering, LLM prompt, validation |
| `plaid.js` | Pre-configured Plaid client |

## Classification config (`config/classificationConfig.js`)

Single source of truth for all AI tuning constants:

| Constant | Value | Purpose |
|----------|-------|---------|
| `EXACT_MATCH_CONFIDENCE` | 1.0 | Fixed score for description cache hits |
| `GLOBAL_VECTOR_DISCOUNT` | 0.92 | Discount on cross-tenant vector matches |
| `EMBEDDING_DIMENSIONS` | 768 | Embedding output dimension (all providers project/configure to 768 for pgvector compatibility) |
| `DEFAULT_AUTO_PROMOTE_THRESHOLD` | 0.90 | Auto-confirm above this confidence |
| `DEFAULT_REVIEW_THRESHOLD` | 0.70 | Hold for review below this confidence |
| `TOP_N_SEEDS` | 10 | Phase 1 seed interview size |
| `PHASE2_CONCURRENCY` | 5 | Max concurrent LLM calls |

**LLM provider defaults** (adapters in `services/llm/`):

| Provider | Embedding | Classification | Insights |
|---|---|---|---|
| Gemini   | `gemini-embedding-001` (projected to 768-dim) | `gemini-3-flash-preview` | `gemini-3.1-pro-preview` |
| OpenAI   | `text-embedding-3-small` (projected to 768-dim) | `gpt-4.1-mini` | `gpt-4.1` |
| Anthropic | *(not supported — use Gemini or OpenAI via `EMBEDDING_PROVIDER`)* | `claude-sonnet-4-6` | `claude-sonnet-4-6` |

Each slot is overridable via `EMBEDDING_MODEL` / `CLASSIFICATION_MODEL` / `INSIGHT_MODEL` env vars. Provider selection is controlled by `LLM_PROVIDER` and (for Anthropic users) `EMBEDDING_PROVIDER`. See `docs/specs/backend/20-llm-provider-abstraction.md`.

These defaults must stay in sync with `Tenant.autoPromoteThreshold` and `Tenant.reviewThreshold` in `prisma/schema.prisma`.

## Caching utilities

| Utility | Strategy | Key details |
|---------|----------|-------------|
| `descriptionCache.js` | In-memory + DB write-through, O(1) | Per-tenant map of SHA-256(description) -> categoryId, backed by `DescriptionMapping` table. 10-min refresh, 25k entries cap |
| `categoryCache.js` | In-memory | Per-tenant category list. 5-min refresh, 500 tenants cap |
| Adapter cache | Redis | 5-min TTL, invalidated on adapter changes |

## Portfolio processing (`workers/portfolio-handlers/`)

Strategy pattern for asset valuation:

```
portfolioWorker
  -> process-portfolio-changes.js    # FIFO lot calculation, USD PnL with historical FX
  -> recalculate-portfolio-item.js   # Re-derive lots/PnL for a single portfolio item
  -> cash-processor.js               # Transaction-date-only cash holdings
  -> simple-liability-processor.js   # Simple debt tracking
  -> amortizing-loan-processor.js    # Amortizing loan tracking
  -> asset-aggregator.js             # Aggregates asset-level summaries
  -> valuation/
      -> index.js                    # Orchestrator: fetch-once, process-in-memory
      -> price-fetcher.js            # 4-stage waterfall: cache -> API -> DB lookback -> manual
      -> holdings-calculator.js      # Compute holdings and gains
      -> strategies/
          -> API_STOCK.js            # Twelve Data stock prices
          -> API_CRYPTO.js           # Twelve Data crypto pairs
          -> API_FUND.js             # Twelve Data fund prices
          -> MANUAL.js               # User-supplied manual values
```

## Logging

Winston-based structured logging:

```javascript
const logger = require('./utils/logger');
logger.info('Event enqueued', { tenantId, jobName });
logger.warn('Falling back to next classification tier', { description });
logger.error('Classification failed', { error: err.message, stack: err.stack });
```

JSON format with timestamps. Console transport in dev, file transport in production. Level configurable via `LOG_LEVEL` env var.

## Testing

**Framework:** Jest (CJS) with supertest for integration.

**Run tests:**
```bash
pnpm test:backend       # all tests
pnpm test:coverage      # with coverage report
```

**Coverage:** 70% lines/functions, 60% branches. Excludes `index.js` and `app.js`.

**Unit tests** mock all external dependencies (Prisma, Redis, BullMQ, Gemini, Twelve Data). Declare `jest.mock()` calls **before** `require()` imports. Use `jest.clearAllMocks()` in `beforeEach`.

**Integration tests** use real Express (via supertest) + real Postgres (`bliss_test` DB). BullMQ queues and external APIs are mocked. Tests use `createIsolatedTenant()` with cascade teardown.

**Test setup:** `env.js` loads `.env.test` first (overrides), then `.env`. `sentry.js` globally mocks `@sentry/node`.

## Prisma client (`prisma/prisma.js`)

Same pattern as the API app: Prisma 6 `$extends` with encrypt -> validate -> execute -> decrypt pipeline. The encryption config comes from `@bliss/shared/encryption`.

## Health endpoints

- `GET /health` -- Redis ping + uptime (no auth required)
- `GET /health/metrics` -- Cache statistics (no auth required)

All other routes require `apiKeyAuth` middleware (checks `X-API-KEY` header against `INTERNAL_API_KEY`).

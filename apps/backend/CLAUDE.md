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
  workers/              # BullMQ job processors (10 workers)
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
| `SMART_IMPORT_COMMIT` | smart-import | commitWorker |
| `PLAID_INITIAL_SYNC`, `PLAID_SYNC_UPDATES` | plaid-sync | plaidSyncWorker |
| `PLAID_SYNC_COMPLETE` | plaid-processor | plaidProcessorWorker |
| `TRANSACTIONS_IMPORTED`, `MANUAL_TRANSACTION_MODIFIED` | portfolio | portfolioWorker |
| `PORTFOLIO_CHANGES_PROCESSED` | analytics | analyticsWorker |
| `TAG_ASSIGNMENT_MODIFIED` | analytics | analyticsWorker |

**Critical:** `originalScope` and `portfolioItemIds` must be threaded through the entire pipeline from event source to final worker. Dropping these breaks scoped (incremental) updates.

## Workers reference

| Worker | Queue | Concurrency | Lock duration | Key job types |
|--------|-------|-------------|---------------|---------------|
| `eventSchedulerWorker` | event-scheduler | 3 | default | Routes events to queues |
| `smartImportWorker` | smart-import | 1 | default | `process-smart-import` |
| `commitWorker` | smart-import | 1 | default | `commit-smart-import` |
| `plaidSyncWorker` | plaid-sync | 3 | default | `plaid-sync-job` |
| `plaidProcessorWorker` | plaid-processor | 5 | default | `process-plaid-transactions` |
| `portfolioWorker` | portfolio | 1 | default | `process-portfolio-changes`, `recalculate-portfolio-items`, `value-portfolio-items`, `value-all-assets` |
| `analyticsWorker` | analytics | 1 | default | `full-rebuild-analytics`, `scoped-update-analytics` |
| `insightGeneratorWorker` | insights | 1 | 600s | `generate-all-insights` (cron 6AM UTC), `generate-tenant-insights` |
| `securityMasterWorker` | security-master | 1 | 1800s | `refresh-all-fundamentals` (cron 3AM UTC), `refresh-single-symbol` |

## Worker implementation pattern

All workers follow this structure:

```javascript
const { Worker } = require('bullmq');
const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');

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
  worker.on('failed', (job, err) => {
    Sentry.withScope((scope) => {
      scope.setTag('worker', WORKER_NAME);
      scope.setContext('job', { name: job.name, tenantId: job.data.tenantId, attempt: job.attemptsMade });
      Sentry.captureException(err);
    });
  });
  return worker; // returned for graceful shutdown
};
```

## Services reference

**AI classification:**

| Service | Purpose |
|---------|---------|
| `categorizationService.js` | 4-tier waterfall: exact match -> vector match (tenant) -> vector match (global) -> LLM |
| `geminiService.js` | Gemini API wrapper: `classifyTransaction()` (Flash, temp 0.1), `generateEmbedding()` (768-dim) |

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
| `EMBEDDING_DIMENSIONS` | 768 | Gemini output projection (from 3072) |
| `DEFAULT_AUTO_PROMOTE_THRESHOLD` | 0.90 | Auto-confirm above this confidence |
| `DEFAULT_REVIEW_THRESHOLD` | 0.70 | Hold for review below this confidence |
| `TOP_N_SEEDS` | 15 | Phase 1 seed interview size |
| `PHASE2_CONCURRENCY` | 5 | Max concurrent Gemini LLM calls |

These defaults must stay in sync with `Tenant.autoPromoteThreshold` and `Tenant.reviewThreshold` in `prisma/schema.prisma`.

## Caching utilities

| Utility | Strategy | Key details |
|---------|----------|-------------|
| `descriptionCache.js` | In-memory, O(1) | Per-tenant map of normalized description -> categoryId. 10-min refresh, 25k entries cap |
| `categoryCache.js` | In-memory | Per-tenant category list. 5-min refresh, 500 tenants cap |
| Adapter cache | Redis | 5-min TTL, invalidated on adapter changes |

## Portfolio processing (`workers/portfolio-handlers/`)

Strategy pattern for asset valuation:

```
portfolioWorker
  -> process-portfolio-changes.js    # FIFO lot calculation, USD PnL with historical FX
  -> cash-processor.js               # Transaction-date-only cash holdings
  -> simple-liability-processor.js   # Simple debt tracking
  -> amortizing-loan-processor.js    # Amortizing loan tracking
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

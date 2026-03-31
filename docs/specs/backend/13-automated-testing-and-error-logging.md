# 13. Automated Testing & Error Logging

## 13.1 Overview

This specification covers the testing infrastructure and error-logging strategy for the bliss-backend-service. The goals are:

1. **Prevent regressions** — a repeatable test suite that runs locally and in CI before every merge.
2. **Verify contracts** — integration tests that exercise the real Express routes and Prisma layer end-to-end, catching issues that unit tests cannot (middleware order, query correctness, auth enforcement).
3. **Surface production errors** — structured Sentry integration that captures every unhandled worker failure with full context, while filtering known-safe non-errors.

The backend uses a **two-layer test pyramid**:

```
         ┌──────────────────────────┐
         │   Integration Tests       │  supertest + real Express + real Prisma
         │   (fewer, slower)         │  37 tests across 5 suites
         └──────────────────────────┘
      ┌────────────────────────────────┐
      │      Unit Tests                │  Jest + full mocks, no I/O
      │      (more, fast)              │  211 tests across 23 suites
      └────────────────────────────────┘
```

E2E tests (Playwright, across all services) live in the `bliss-frontend` repository at `e2e/` — see `bliss-frontend/specs/13-automated-testing-and-error-logging.md §13.5`.

---

## 13.2 Unit Test Architecture

### Framework

Jest (CommonJS) is used throughout because the service runs as CJS (`require()`). Vitest is used by the `bliss-finance-api` (ESM) — the two frameworks are intentionally not mixed.

### Configuration (`jest.config.js`)

```js
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/*.test.js'],
  setupFiles: [
    '<rootDir>/src/__tests__/setup/env.js',    // loads .env.test before module imports
    '<rootDir>/src/__tests__/setup/sentry.js', // mocks @sentry/node globally
  ],
  coverageThreshold: {
    global: { branches: 60, functions: 70, lines: 70 },
  },
};
```

### Setup Files

**`setup/env.js`** — calls `dotenv.config({ path: '.env.test' })` before any module is resolved, ensuring environment-sensitive module-level code (e.g., Prisma URL, encryption keys) sees the test values.

**`setup/sentry.js`** — replaces `@sentry/node` with a jest mock so that `captureException`, `withScope`, and `init` are no-ops in every test. This prevents accidental Sentry traffic and avoids initialisation errors when `SENTRY_DSN` is absent.

### Mocking Strategy

All unit tests follow this pattern:

```js
// 1. Declare mocks BEFORE importing the module under test
jest.mock('../../../services/geminiService', () => ({
  generateEmbedding: jest.fn(),
  classifyTransaction: jest.fn(),
}));

// 2. Import the module under test after mocks are in place
const { classify } = require('../../../services/categorizationService');

// 3. Reset state between tests to prevent cross-test pollution
beforeEach(() => jest.clearAllMocks());
```

Pure utilities (encryption, hash functions, calculator logic) are tested without any mocking.

### Test Suites

| File | Tests | Covers | Key Mocks |
|------|-------|--------|-----------|
| `unit/utils/descriptionCache.test.js` | 10 | In-memory LRU cache lookup/insert, tenant isolation | none |
| `unit/utils/transactionNormalizer.test.js` | 10 | Amount/date normalization, `_isSellAll` flag | none |
| `unit/utils/portfolioItemStateCalculator.test.js` | 11 | FIFO lot tracking, invest/debt state, realized PnL | `currencyService` |
| `unit/utils/encryption.test.js` | 10 | AES-256-GCM encrypt/decrypt, searchable vs non-searchable | none |
| `unit/utils/categoryCache.test.js` | 10 | Tenant cache TTL, invalidation, stale-on-error fallback | Prisma, logger, `jest.useFakeTimers()` |
| `unit/services/adapterEngine.test.js` | 11 | `parseDate`, `parseDecimal`, `sortAdaptersBySpecificity`, `detectAdapter` | Redis, Prisma, logger |
| `unit/services/categorizationService.test.js` | 11 | 3-tier waterfall classify(), recordFeedback() fire-and-forget | descriptionCache, geminiService, Prisma, logger |
| `unit/services/geminiService.test.js` | 12 | `generateEmbedding()` retry logic, `classifyTransaction()` parsing + clamping | `@google/generative-ai`, logger |
| `unit/services/priceService.test.js` | 8 | `getLatestPrice()` routing by asset type, DB fallback | stockService, cryptoService, Prisma, logger |
| `unit/services/cryptoService.test.js` | 11 | `searchCrypto()`, `getHistoricalCryptoPrice()`, `getLatestCryptoPrice()` — TwelveData delegation, pair construction, dedup | twelveDataService, logger |
| `unit/services/currencyService.test.js` | 10 | `fetchHistoricalRate()`, `getOrCreateCurrencyRate()` cache/DB/API flow | axios, `@prisma/client`, logger |
| `unit/services/debounceService.test.js` | 6 | Redis key aggregation, job replacement, TTL, error handling | redis, queue mock |
| `unit/services/stockService.test.js` | 8 | Provider delegation (TWELVE_DATA vs ALPHA_VANTAGE) | twelveDataService, axios |
| `unit/services/twelveDataService.test.js` | 12 | Historical/latest price, symbol search, weekend backtrack | axios |
| `unit/middleware/apiKeyAuth.test.js` | 6 | X-API-KEY validation, env-based key lookup | none (pure middleware) |
| `unit/strategies/API_FUND.test.js` | 8 | 3-stage pricing: cache → API → 7-day lookback, manual fallback | stockService, Prisma, logger |
| `unit/strategies/API_STOCK.test.js` | 6 | 3-stage pricing: cache → API → 7-day lookback | stockService, Prisma, logger |
| `unit/strategies/API_CRYPTO.test.js` | 8 | 3-stage pricing: cache → TwelveData (via cryptoService) → 7-day lookback, currency fallback | cryptoService, Prisma, logger |
| `unit/strategies/MANUAL.test.js` | 5 | Exact match, forward-fill, future value rejection | Prisma, logger |
| `unit/workers/eventSchedulerWorker.test.js` | 10 | Event routing for all event types (incl. SMART_IMPORT_COMMIT), missing data warnings | all queue modules, debounceService, redis, bullmq |
| `unit/workers/commitWorker.test.js` | 11 | Commit job validation, batch transaction creation, enrichment skip, tag linking, LLM/USER_OVERRIDE feedback, COMMITTED/READY status, error handling | prisma, tagUtils, categorizationService, eventsQueue, transactionHash, Sentry |
| `unit/workers/smartImportHelpers.test.js` | 6 | `computeTransactionHash()` SHA-256 consistency, normalization | all smartImportWorker dependencies |
| `unit/workers/plaidProcessorWorker.test.js` | 13 | Auto-promote threshold logic, hash-based dedup, investment detection, seedHeld behaviour, rate-limit deferral | categorizationService, geminiService, Prisma, logger |

### Running Unit Tests

```bash
npm run test:unit       # run once
npm run test:watch      # watch mode during development
npm run test:coverage   # with v8 coverage report
```

---

## 13.3 Integration Test Architecture

### Philosophy

Integration tests verify the **HTTP contract** of each Express route end-to-end: routing, middleware execution order, request parsing, auth enforcement, and response serialisation. They use:

- **supertest** — sends real HTTP requests against the in-process Express app
- **Real Prisma** — connected to the `bliss_test` local database
- **Mocked queues / external APIs** — BullMQ queues and Gemini API are mocked to keep tests fast and hermetic

### Test Database

```
DATABASE_URL=postgresql://<user>@localhost:5432/bliss_test
```

Create the database and apply all migrations once before running integration tests:

```bash
createdb bliss_test
npx prisma migrate deploy --schema prisma/schema.prisma
```

CI uses a `pgvector/pgvector:pg16` service container with the same `bliss_test` database name (see §13.6).

### Tenant Isolation

Each integration test file creates an isolated tenant and tears it down completely after the suite. The `src/__tests__/helpers/tenant.js` utility provides:

```js
// Creates: Tenant + admin User + default Category
const { tenantId, categoryId } = await createIsolatedTenant({ suffix: 'feedback' });

// Cascade-deletes everything linked to the tenant
await teardownTenant(tenantId);
```

Cascade deletion relies on the `onDelete: Cascade` rules in the Prisma schema: deleting a `Tenant` removes all linked users, accounts, categories, transactions, and embeddings automatically.

### Test Files

| File | Tests | Route | Key Mocks |
|------|-------|-------|-----------|
| `integration/routes/feedback.test.js` | 7 | `POST /api/feedback` | geminiService (fire-and-forget embedding) |
| `integration/routes/events.test.js` | 5 | `POST /api/events` | eventsQueue.enqueueEvent |
| `integration/routes/ticker.test.js` | 12 | `GET /api/ticker/search`, `GET /api/ticker/profile` | stockService, cryptoService |
| `integration/routes/similar.test.js` | 7 | `GET /api/similar` | geminiService.generateEmbedding, Prisma.$queryRaw |
| `integration/routes/adminRoutes.test.js` | 6 | `POST /api/admin/regenerate-embedding` | geminiService, categorizationService |

All integration tests verify API key authentication (401 for missing/wrong key), request validation (400 for missing fields), and success responses. Tests use `supertest` against the real Express app with mocked external services.

### Running Integration Tests

```bash
npm run test:integration
```

Both unit and integration tests run with `npm test` (Jest picks up all `*.test.js` files under `src/__tests__/`). Use `test:unit` or `test:integration` to run only one layer.

---

## 13.4 Error Logging Strategy (Sentry)

### The Problem with Express-Only Sentry

`Sentry.setupExpressErrorHandler(app)` captures errors that flow through the Express middleware chain — i.e. exceptions thrown inside route handlers. BullMQ workers run in a completely separate process (or at least outside the Express request cycle). Worker failures are reported to BullMQ's internal event system, not to Express. As a result, no worker error would ever reach the Express Sentry handler.

### Solution: `worker.on('failed')` + `withScope`

Every BullMQ worker in `src/workers/` registers a `failed` event listener:

```js
worker.on('failed', (job, err) => {
  logger.error(`Worker job failed ${job?.id}: ${err.message}`);

  // (Optional) Filter known transient errors before sending to Sentry
  if (err.message?.includes('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION')) return;

  Sentry.withScope((scope) => {
    scope.setTag('worker', 'plaidSyncWorker');   // which worker
    scope.setTag('jobName', job?.name);          // which job type
    scope.setExtra('jobId', job?.id);
    scope.setExtra('tenantId', job?.data?.tenantId);
    scope.setExtra('attemptsMade', job?.attemptsMade);
    Sentry.captureException(err);
  });
});
```

`withScope` creates a temporary scope for one event, attaching structured context without polluting the global scope. This means every Sentry event for a worker failure includes the exact job, tenant, and retry count — sufficient to reproduce and diagnose the issue without reading logs.

### What Gets Sent to Sentry

| Situation | Sent to Sentry? | Reason |
|-----------|-----------------|--------|
| Worker job throws unhandled exception | ✅ Yes | `worker.on('failed')` fires, `captureException` called |
| Route handler throws 500 | ✅ Yes | Express error handler catches it |
| Route returns 400 (validation failure) | ❌ No | Intentional return, no exception thrown |
| Route returns 401/403 (auth failure) | ❌ No | Intentional return, no exception thrown |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` | ❌ Filtered | Known Plaid transient race, not actionable |

### Workers Instrumented

All 6 BullMQ workers have `worker.on('failed')` Sentry handlers:

| Worker | Extra context fields |
|--------|---------------------|
| `plaidSyncWorker` | `plaidItemId`, `attemptsMade` |
| `plaidProcessorWorker` | `plaidItemId`, `attemptsMade` |
| `smartImportWorker` | `tenantId`, `stagedImportId`, `adapterId` |
| `portfolioWorker` | `tenantId`, `jobName`, `jobData` |
| `analyticsWorker` | `tenantId`, `jobName`, `scope` |
| `eventSchedulerWorker` | `tenantId`, `jobName`, `jobData` |

---

## 13.5 Observability Instrumentation

### OpenTelemetry (OTEL)

The service is instrumented with `@opentelemetry/sdk-node` via `src/instrumentation.js`, which is loaded before the application code using Node's `--require` flag. This provides:

- **Automatic spans** for Prisma queries (via Prisma's OTEL integration)
- **BullMQ job spans** for each worker process cycle
- **HTTP request spans** for the Express routes

### Sentry Prisma Integration

`Sentry.init({ integrations: [Sentry.prismaIntegration()] })` is called in `app.js` before any routes are registered. This automatically creates Sentry performance spans for every Prisma query, making slow queries visible in the Sentry performance dashboard without any manual instrumentation.

---

## 13.6 CI/CD

Integration tests run in GitHub Actions with real service containers. See `.github/workflows/ci.yml` for the full configuration.

Key environment variables required for the integration test job:

| Variable | Value in CI |
|----------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/bliss_test` |
| `REDIS_URL` | `redis://localhost:6379` |
| `INTERNAL_API_KEY` | Any fixed test value |
| `ENCRYPTION_SECRET` | Any 32-byte base64 test value |

The CI job runs `npx prisma migrate deploy` before executing tests to ensure the `bliss_test` schema is current.

---

## 13.7 E2E Scaffolding (Phase 4)

E2E tests live in the **`bliss-frontend` repository** at `bliss-frontend/e2e/`. They are owned by the frontend CI workflow (`bliss-frontend/.github/workflows/ci.yml`) and run only on merges to `main`.

The E2E suite tests user-facing flows that span all three services (backend + finance-api + frontend), so it belongs in the repo closest to the user: `bliss-frontend`.

Full documentation for the E2E scaffolding, spec files, Playwright config, and next steps is in:

```
bliss-frontend/specs/13-automated-testing-and-error-logging.md §13.5
```

### Current Status

All 13 test cases are `test.skip` stubs — they pass in CI (exit 0, all skipped). The structure is in place; implementation begins when real E2E tests are written.

---

## 13.8 Frontend Test Infrastructure (Phase 5)

The `bliss-frontend` package has a complete test infrastructure ready — no test files exist yet, but all tooling and configuration are in place.

Full documentation for the frontend test stack, MSW handlers, CI workflow, untested features, and recommended starting points is in:

```
bliss-frontend/specs/13-automated-testing-and-error-logging.md
```

### Summary

- **Runner**: Vitest 2.x + `@vitejs/plugin-react-swc` + jsdom
- **Component testing**: `@testing-library/react` + `@testing-library/jest-dom`
- **API mocking**: MSW v2 (node server via `setupServer`)
- **Status**: 0 test files written; all config in place; `npm run test:unit` passes with exit 0

```bash
cd bliss-frontend
npm run test:unit     # passes with 0 tests (passWithNoTests: true)
npm run test:watch    # TDD watch mode
npm run test:coverage # v8 coverage (60% threshold on src/components + src/hooks)
```

---

## 13.9 Untested Features & Next Steps

### Features Without Test Coverage

The table below tracks major feature areas and their current test status:

#### Backend (`bliss-backend-service`)

| Feature | Unit Tests | Integration Tests | Notes |
|---------|-----------|------------------|-------|
| `feedback.js` route | ✅ (indirect) | ✅ 7 tests | Complete |
| `events.js` route | ✅ (indirect) | ✅ 5 tests | Complete |
| `ticker.js` route | ✅ (via stockService) | ✅ 12 tests | Complete |
| `similar.js` route | ❌ | ✅ 7 tests | Vector search endpoint |
| `adminRoutes.js` route | ❌ | ✅ 6 tests | Embedding regeneration |
| `categorizationService` | ✅ 11 tests | ❌ | Full 3-tier waterfall + recordFeedback |
| `geminiService` | ✅ 12 tests | ❌ | Embedding + classification + retry logic |
| `priceService` | ✅ 8 tests | ❌ | Asset type routing + DB fallback |
| `cryptoService` | ✅ 11 tests | ❌ | Twelve Data crypto delegation (pair construction, dedup, search) |
| `currencyService` | ✅ 10 tests | ❌ | CurrencyLayer API wrapper + cache |
| `debounceService` | ✅ 6 tests | ❌ | Redis key aggregation |
| `stockService` | ✅ 8 tests | ❌ | Provider delegation |
| `twelveDataService` | ✅ 12 tests | ❌ | Historical/latest price + search |
| `apiKeyAuth` middleware | ✅ 6 tests | ❌ (tested via integration routes) | X-API-KEY validation |
| `categoryCache` | ✅ 10 tests | ❌ | TTL, invalidation, stale fallback |
| Valuation strategies | ✅ 26 tests | ❌ | API_FUND (8), API_STOCK (6), API_CRYPTO (7), MANUAL (5) |
| `eventSchedulerWorker` | ✅ 10 tests | ❌ | All event types routed correctly (incl. SMART_IMPORT_COMMIT) |
| `commitWorker` | ✅ 11 tests | ❌ | Batch commit, tag linking, enrichment skip, feedback, error handling |
| `smartImportWorker` | ✅ 6 tests (hash only) | ❌ | `computeTransactionHash()` tested; full pipeline untested |
| `adapterEngine.js` | ✅ 11 tests | ❌ | Parsing, sorting, detection |
| Encryption middleware | ✅ 10 tests | ❌ | AES-256-GCM both modes |
| `plaidSyncWorker` | ❌ | ❌ | Complex Plaid API flow |
| `plaidProcessorWorker` | ✅ 13 tests | ❌ | Auto-promote logic, threshold behaviour, hash dedup, investment detection |
| `portfolioWorker` | ❌ | ❌ | FIFO lots, PnL calculation |
| `analyticsWorker` | ❌ | ❌ | Aggregation correctness |

#### Finance-API (`bliss-finance-api`)

| Feature | Unit Tests | Integration Tests | Notes |
|---------|-----------|------------------|-------|
| `auth/signup.ts` | ❌ | ✅ 5 tests | Complete |
| `accounts.ts` | ❌ | ✅ 4 tests | Complete |
| `categories.ts` | ❌ | ✅ 2 tests | Complete |
| `auth/signin.ts` | ❌ | ❌ | JWT issuance + Set-Cookie |
| `auth/signout.ts` | ❌ | ❌ | Token denylist write |
| `auth/refresh.ts` | ❌ | ❌ | Token rotation |
| `transactions/import.ts` | ❌ | ❌ | Old "dumb" import path |
| `imports/upload.ts` | ❌ | ❌ | Multipart form + GCS |
| `imports/[id].ts` (commit) | ❌ | ✅ 11 tests | Async commit dispatch (202), cancel, produceEvent revert |
| `imports/detect-adapter.ts` | ❌ | ❌ | Header analysis |
| `imports/adapters.ts` | ❌ | ❌ | CRUD |
| `users/settings.ts` | ❌ | ❌ | Threshold persistence |
| `plaid/` routes | ❌ | ❌ | Requires Plaid sandbox credentials |
| `portfolio/` routes | ❌ | ❌ | Aggregation endpoints |
| `analytics/` routes | ❌ | ❌ | Analytics aggregation endpoints |

### Recommended Next Steps

#### Backend: Full Worker Pipeline Tests (high ROI)

The `eventSchedulerWorker` routing and `smartImportWorker` hash function are now tested. The remaining untested workers contain critical business logic:

1. **`plaidProcessorWorker`** — Auto-promote threshold logic is a regression risk. `normalizeDescription` and `buildFrequencyMap` are currently unexported; exporting them would enable targeted unit tests.
2. **`portfolioWorker`** — FIFO lot calculation and PnL are exercised indirectly via `portfolioItemStateCalculator` unit tests, but the full worker pipeline (fetching prices, building snapshots) is untested.
3. **`plaidSyncWorker`** — Complex Plaid API pagination flow. Would require heavy Plaid SDK mocking.

#### Frontend: Custom Hooks (lowest barrier, highest confidence)

The MSW infrastructure is already wired up. See `bliss-frontend/specs/13-automated-testing-and-error-logging.md` for detailed frontend test recommendations.

# Bliss Backend Service

This service is the asynchronous processing engine for the Bliss Finance platform. It handles all the heavy lifting, complex calculations, and third-party API interactions that would be too slow or unreliable to run in a synchronous web request. It operates independently from the other services and communicates via a shared Redis instance and PostgreSQL database.

## Core Purpose

The backend service is designed as a robust, event-driven system with a clear separation of concerns from the user-facing API.

-   **Asynchronous Job Processing**: It uses a powerful queueing system to manage and process background jobs, ensuring that long-running tasks do not block the main application thread or degrade the user experience.
-   **Smart Import**: Processes adapter-driven CSV/XLSX imports with AI classification, deduplication, and staging for user review. The "Bliss Native CSV" system adapter supports direct import without AI — resolving account/category by name or ID from CSV columns.
-   **Portfolio Valuation**: Runs the entire multi-step pipeline to calculate the daily historical value of all user assets. This includes fetching prices from third-party financial data providers, calculating cost basis, and tracking realized/unrealized gains.
-   **Analytics Processing**: Aggregates raw transaction data into a denormalized, pre-calculated format stored in the `AnalyticsCacheMonthly` table, allowing the frontend analytics dashboards to load quickly without on-the-fly calculations.
-   **AI Classification**: Classifies imported transactions into categories using a four-tier waterfall: (1) O(1) exact-match description cache — returns instantly when the description was seen before; (2) pgvector cosine similarity against `TransactionEmbedding` (tenant-scoped); (3) pgvector cosine similarity against `GlobalEmbedding` (cross-tenant, `× 0.92` discount) — catches semantically similar transactions from other tenants; (4) Google Gemini LLM fallback for novel descriptions. User overrides feed back into both the in-memory cache and the vector index immediately via the feedback loop (`POST /api/feedback`). All classification tuning constants are centralised in `src/config/classificationConfig.js`. High-confidence classifications (above the tenant's `autoPromoteThreshold`) are promoted or confirmed automatically, bypassing the review queue.
-   **Plaid Sync**: Two-worker pipeline for Plaid bank data — `plaidSyncWorker` (ingestion: cursor-based `transactionsSync`, sync logs, Plaid error code detection, status updates) and `plaidProcessorWorker` (classification + promotion: Plaid category hint to LLM, investment detection and flagging, auto-promote). High-confidence non-investment transactions (above the tenant's `autoPromoteThreshold`) are promoted to the `Transaction` table automatically, bypassing the review queue.
-   **AI Insights**: Generates daily financial insights per tenant via a scheduled BullMQ cron job (6 AM UTC). Analyzes 7 lenses (spending velocity, category concentration, income stability, portfolio exposure, debt health, net worth trajectory, savings rate) using Google Gemini with currency-aware data gathering and SHA-256 deduplication to skip regeneration when data is unchanged.
-   **SecurityMaster & Nightly Refresh**: Maintains a global `SecurityMaster` table with stock fundamental data (sector, industry, P/E, dividend yield, EPS, 52-week range) derived from Twelve Data Profile, Earnings, and Dividends APIs. A nightly BullMQ cron job (3 AM UTC) refreshes fundamentals for all active stock holdings with conservative rate limiting (41 credits/symbol). Profile data for new tickers is populated on-demand via a cache-first pattern in the ticker profile route.
-   **Event-Driven Architecture**: The service exposes a minimal Express API at `/api/events` that the `bliss-finance-api` calls to dispatch work. The `eventSchedulerWorker` routes each event type to the appropriate BullMQ queue and job.

## Technology Stack

### Core Technologies
-   **Runtime**: [Node.js](https://nodejs.org/) (CommonJS / `require()`)
-   **Framework**: [Express.js](https://expressjs.com/). Exposes a minimal internal API for receiving events from the `bliss-finance-api`.
-   **Database**: [PostgreSQL](https://www.postgresql.org/) with the [Prisma](https://www.prisma.io/) client for type-safe database access.

### Job Queue & Caching
-   **[BullMQ](https://bullmq.io/)**: A robust and performant job queue system built on top of Redis. It is the backbone of the service, used to define, process, and monitor all background jobs.
-   **[Redis](https://redis.io/)**: An in-memory data store used by BullMQ for queue management and by the application for description-match caching and adapter caching.

### Third-Party Integrations
-   **Stock & Fund Prices**: [Twelve Data](https://twelvedata.com/) is the primary provider for historical and real-time stock/ETF/fund price data, covering 27+ markets including XETRA, Euronext, LSE, and Borsa Italiana. The `STOCK_PROVIDER` env var controls provider selection (`TWELVE_DATA` or `ALPHA_VANTAGE` for rollback). [Alpha Vantage](https://www.alphavantage.co/) is retained as a fallback. The `/earnings` (10 credits) and `/dividends` (20 credits) endpoints provide EPS and dividend history used to compute P/E ratio and dividend yield for the SecurityMaster reference table, refreshed nightly.
-   **Cryptocurrency Prices**: [Twelve Data](https://twelvedata.com/) is also used for crypto pricing via currency pairs (e.g. `BTC/EUR`, `ETH/USD`). The `cryptoService.js` delegates to `twelveDataService.js`, constructing pairs from the asset symbol and account currency. Crypto search deduplicates Twelve Data results to return base symbols (e.g. `BTC`, not `BTC/USD`).
-   **Bank Data**: [Plaid](https://plaid.com/) is used to connect user bank accounts and sync transactions.
-   **AI Classification**: [Google Gemini API](https://ai.google.dev/) is used for transaction categorization when no exact match is found in the description cache.

## Deployment & Scaling

The backend service is designed to be horizontally scalable by separating the lightweight web API from the heavy background workers. This avoids resource contention and allows you to scale worker instances independently when queue volumes grow.

### Process Separation (`START_MODE`)

You can control which parts of the application boot using the `START_MODE` environment variable:

- `START_MODE=web`: Starts **only** the Express server. Use this for the instance that receives incoming webhooks and events from the Finance API. It requires very little CPU.
- `START_MODE=worker`: Starts **only** the BullMQ background workers. Use this for the instances that pull from the Redis queues and process data. You can run multiple replicas of this service to scale your processing power horizontally.
- `START_MODE=all` (or undefined): Starts **both** the Express server and the workers in the same single Node.js process. This is the default behavior and is recommended for local development (`npm run dev`).

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `INTERNAL_API_KEY` | API key for inter-service authentication. Startup validation rejects the default/placeholder value. |
| `DATABASE_URL` | PostgreSQL connection string (e.g. `postgresql://user:pass@localhost:5432/bliss`). |
| `REDIS_URL` | Redis connection string for BullMQ queues (e.g. `redis://localhost:6379`). |
| `GEMINI_API_KEY` | Google Gemini API key for AI classification (4-tier waterfall). |

### Optional

| Variable | Description |
|----------|-------------|
| `PLAID_CLIENT_ID` | Plaid client ID (required only if Plaid features are used). |
| `PLAID_SECRET` | Plaid secret key (required only if Plaid features are used). |
| `PLAID_ENV` | Plaid environment — `sandbox`, `development`, or `production` (required only if Plaid features are used). |
| `TWELVE_DATA_API_KEY` | TwelveData API key for stock, fund, and crypto market data. |
| `SENTRY_DSN` | Sentry DSN for error tracking and observability. |
| `GCS_BUCKET` | Google Cloud Storage bucket name for file uploads. |
| `START_MODE` | Controls which processes boot — `web`, `worker`, or `all` (default). See [Deployment & Scaling](#deployment--scaling). |

### Startup Validation

The service validates environment variables at startup via `utils/validateEnv.js`. In production, missing required variables cause the process to exit with a non-zero code. In development, warnings are logged to the console instead.

## Health Endpoints

- **`GET /health`** — Returns `200 { status: 'ok', redis: 'connected', uptime }` when Redis is reachable, or `503 { status: 'degraded', redis: 'disconnected' }` when it is not. Pings Redis on every call to verify connectivity.
- **`GET /health/metrics`** — Returns in-memory cache statistics: `{ descriptionCache: { tenantCount, totalEntries }, categoryCache: { tenantCount } }`. Useful for monitoring cache warm-up and memory footprint.

## Setup and Running Locally

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Setup Environment Variables**:
    Create a `.env` file in the root of the project. It is critical to configure the connection to Redis and the database, and to provide API keys for the financial data providers.
    ```
    DATABASE_URL=postgresql://...
    REDIS_HOST=localhost
    REDIS_PORT=6379
    STOCK_PROVIDER=TWELVE_DATA
    TWELVE_DATA_API_KEY=...
    ALPHA_VANTAGE_API_KEY=...    # fallback provider
    PLAID_CLIENT_ID=...
    PLAID_SECRET=...
    GEMINI_API_KEY=...
    ```

3.  **Run the Worker**:
    ```bash
    npm run start:dev
    ```
    This will start the service using `nodemon`, which automatically restarts on file changes. All workers connect to Redis immediately and begin processing any queued jobs.

## Project Structure

The project is organized with a clear separation of concerns:

-   **/src/queues**: BullMQ queue singleton definitions (e.g., `smartImportQueue`, `analyticsQueue`, `portfolioQueue`, `eventsQueue`, `insightQueue`).
-   **/src/workers**: BullMQ worker implementations that listen to the queues and process jobs. Core business logic lives here.
    -   `eventSchedulerWorker.js` — Routes incoming events to the appropriate queues.
    -   `smartImportWorker.js` — Adapter-driven smart import with AI classification and staging (includes native adapter path).
    -   `analyticsWorker.js` — Aggregates transactions into the analytics cache.
    -   `portfolioWorker.js` — Orchestrates the portfolio valuation pipeline.
    -   `plaidSyncWorker.js` — Ingests transactions from Plaid via cursor-based `transactionsSync`. Checks `PlaidItem.status === 'ACTIVE'` before every job (skips gracefully for REVOKED/LOGIN_REQUIRED items). Writes `PlaidSyncLog` records on completion. Detects Plaid error codes in catch block and updates `PlaidItem.status` accordingly. Emits `PLAID_SYNC_COMPLETE` to trigger the processor.
    -   `plaidProcessorWorker.js` — Classifies staged `PlaidTransaction` rows using the 4-tier waterfall, passes Plaid `personal_finance_category` as an LLM hint, detects investment transactions and flags them with `requiresEnrichment: true`, sets `seedHeld=true` on LLM/VECTOR_MATCH/VECTOR_MATCH_GLOBAL results below `autoPromoteThreshold` (Quick Seed interview), and auto-promotes high-confidence non-investment rows.
    -   `insightGeneratorWorker.js` — Daily cron (`0 6 * * *`) + on-demand insight generation. Iterates all tenants, gathers currency-aware financial data, calls Gemini LLM across 7 analysis lenses, and stores results in the `Insight` table with SHA-256 deduplication.
-   **/src/workers/portfolio-handlers**: Modular handlers for each step of the portfolio pipeline (asset aggregation, holdings calculation, price fetching, etc.).
-   **/src/config**: Configuration constants.
    -   `classificationConfig.js` — Single source of truth for all AI classification tuning constants (thresholds, embedding dimensions, concurrency limits). Values are read by workers per-job so changes take effect without a restart. Tenant-level overrides (`autoPromoteThreshold`, `reviewThreshold`) stored in the `Tenant` model default to the values in this file.
-   **/src/services**: Shared services for third-party API access (`stockService.js`, `twelveDataService.js`, `cryptoService.js`, `categorizationService.js`, `priceService.js`, `insightService.js`) and other business logic.
-   **/src/routes**: Express route definitions for the internal API.
    -   `events.js` — Receives business events from `bliss-finance-api` and enqueues them.
    -   `feedback.js` — Internal `POST /api/feedback` endpoint. Receives category corrections from the finance-api, updates the in-memory description cache immediately, and fire-and-forgets an embedding upsert to the `TransactionEmbedding` vector index.
    -   `similar.js` — Internal `GET /api/similar` endpoint. Accepts a description, generates an embedding via Gemini, and returns the top-N most similar previously-classified transactions from `TransactionEmbedding`.
    -   `ticker.js` — Internal `GET /api/ticker/search` and `GET /api/ticker/profile` endpoints. All searches route to Twelve Data; `?type=crypto` filters and deduplicates for digital currency symbols. Provides symbol search and ISIN/exchange resolution.
    -   `insights.js` — Internal `POST /api/insights/generate` endpoint. Receives tenant ID from finance-api and enqueues a `generate-tenant-insights` job on the insights queue.
-   **/src/workers/portfolio-handlers/valuation/strategies**: Pluggable pricing strategies auto-discovered by the portfolio pipeline. Includes `API_STOCK.js`, `API_CRYPTO.js`, `API_FUND.js` (with graceful manual fallback), `MANUAL.js`, `CASH.js`, `AMORTIZING_LOAN.js`, and `SIMPLE_LIABILITY.js`.
-   **/src/workers/portfolio-handlers/asset-aggregator.js**: Generates unique asset keys from transactions. The TICKER strategy validates tickers with `/[a-zA-Z]/` and falls back to `CATEGORY_NAME_PLUS_DESCRIPTION` for Investment-type transactions that lack a ticker (e.g., manually-tracked Brazilian funds).
-   **/specs**: Detailed markdown documentation for each backend processing pipeline.

## Testing

| Suite | Command | Runner | Tests |
|-------|---------|--------|-------|
| Unit | `npm test` or `npm run test:unit` | Jest | 193 |
| Integration | `npm run test:integration` | Jest + supertest | requires `bliss_test` DB + Redis |
| Coverage | `npm run test:coverage` | Jest v8 | 70% line/fn threshold |

Unit tests are fully mocked — no database or network required. Integration tests use supertest against the real Express app and a local `bliss_test` Postgres database.

**Setup for integration tests**: ensure `.env.test` has `DATABASE_URL` pointing to `bliss_test` and `INTERNAL_API_KEY` set, then run `npx prisma migrate deploy --schema prisma/schema.prisma` once against that database.

Test files live under `src/__tests__/unit/` (Jest mocks all deps) and `src/__tests__/integration/` (real Express + Prisma, mocked queues and external APIs).

## Observability

All 7 BullMQ workers report failed jobs to Sentry via `worker.on('failed')` with `Sentry.withScope()`. Each error is enriched with structured context: worker name, job name, job ID, tenant ID, and `attemptsMade`.

Key design decisions:
- **Intentional 4xx responses** (auth failures, missing fields, rate limits) are returned directly and do **not** trigger Sentry — they represent expected application behaviour, not bugs.
- **Known transient Plaid errors** (`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`) are filtered from Sentry to prevent noise from a race condition outside our control.
- **Worker failures** are captured at `worker.on('failed')` rather than per-catch-block, giving one consistent location per worker with full job context.

See [13. Automated Testing & Error Logging](./specs/13-automated-testing-and-error-logging.md) for the full observability strategy.

## System Documentation

This `README.md` provides a high-level architectural overview. For detailed information on the specific processing logic, please refer to the specification documents in the `/specs` directory.

-   **[5. Analytics Processing](./specs/05-analytics.md)**
-   **[6. Portfolio Processing Pipeline](./specs/06-portfolio-processing.md)**
-   **[7. Cash Holdings Management](./specs/07-cash-holdings.md)**
-   **[8. Plaid Integration & Sync](./specs/08-plaid-integration.md)**
-   **[9. Smart Import Pipeline & Dumb Import Worker](./specs/09-smart-import.md)**
-   **[10. AI Classification Pipeline](./specs/10-ai-classification-and-review.md)**
-   **[11. Admin API & Default Category Management](./specs/11-admin-api.md)**
-   **[11. Deployment Architecture & Scaling](./specs/11-deployment-architecture.md)**
-   **[13. Automated Testing & Error Logging](./specs/13-automated-testing-and-error-logging.md)**
-   **[15. Insights Engine](./specs/15-insights-engine.md)**
-   **[19. SecurityMaster & Nightly Refresh](./specs/19-security-master.md)**

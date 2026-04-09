# Bliss

Bliss is a multi-tenant personal finance platform. It ingests bank transactions (Plaid or CSV), classifies them with a 4-tier AI pipeline, tracks investment portfolios with real-time pricing, and generates AI-powered financial insights.

## Architecture overview

Monorepo with four services behind a single `.env` file:

| Service | Stack | Port | Module system | Role |
|---------|-------|------|---------------|------|
| `apps/api` | Next.js 15 (Pages Router) | 3000 | ESM | Auth (NextAuth), REST API routes, Prisma ORM |
| `apps/backend` | Express + BullMQ | 3001 | **CJS** | Workers, async pipelines, internal API |
| `apps/web` | React 18 + Vite | 8080 | ESM | SPA with shadcn/ui, TanStack Query, Tailwind, react-i18next (5 locales: en/es/fr/pt/it) |
| `apps/docs` | Next.js 15 + Nextra | 3002 | ESM | Documentation site |
| `packages/shared` | tsup (dual ESM/CJS) | -- | Dual | Encryption (AES-256-GCM), storage adapters |

**Communication flow:** Browser -> API (JWT in httpOnly cookies) -> Backend (via `INTERNAL_API_KEY` header). Backend workers process async jobs via Redis/BullMQ queues.

**Database:** PostgreSQL 16 with pgvector extension. Single Prisma schema at `prisma/schema.prisma` shared by API and backend. 50+ migrations.

**Multi-tenancy:** Query-level isolation. Every Prisma query must include `tenantId`. No RLS.

## Critical rules

### Module systems -- never mix

- `apps/api` -- ESM: `import` / `export`
- `apps/backend` -- **CJS: `require()` / `module.exports`**
- `apps/web` -- ESM: `import` / `export`
- `packages/shared` -- Dual (built via tsup)

This is the single most common mistake. Check the app you are editing before writing any import/export.

### Design tokens -- never use raw Tailwind colors

All semantic colors in `apps/web` must use design tokens from `src/index.css`. **Never** use `green-500`, `red-600`, `amber-100`, `blue-700`, etc. in JSX.

| Token | Hex | Use for |
|-------|-----|---------|
| `positive` | #2E8B57 | Success, gains, synced |
| `negative` | #E5989B | Losses, negative amounts |
| `warning` | #E09F12 | Caution, pending |
| `destructive` | #E5989B | Errors, delete actions |
| `brand-primary` | #6D657A | Brand accents |
| `brand-deep` | #3A3542 | Primary text |

Badge pattern: `bg-positive/10 text-positive border-positive/20`. Allowed raw Tailwind: only gray scale, white, black.

Charts use `dataviz-1` through `dataviz-8` tokens via `buildGroupColorMap()` and `getGroupColor()` from `src/lib/portfolio-utils.ts`. Debt groups always use negative-family colors. Never hardcode hex in charts.

### Database changes require migrations

```bash
pnpm exec prisma migrate dev --schema=prisma/schema.prisma --name your_migration_name
```

Never modify the schema without creating a migration. Both API and backend reference the schema via relative path.

### Heavy work goes in workers, not route handlers

Use BullMQ queues for any CPU-intensive or long-running operation. API routes should validate, enqueue, and return `202 Accepted`.

### Encryption

Sensitive fields (transaction descriptions, account numbers, Plaid access tokens) are encrypted at rest with AES-256-GCM. Prisma middleware handles encrypt/decrypt transparently. The `@bliss/shared` encryption module is the single implementation.

## Quick start

```bash
# Docker (recommended)
./scripts/setup.sh          # generates secrets, creates .env
docker compose up --build   # postgres, redis, api, backend, web

# Local development
cp .env.example .env
./scripts/setup.sh
pnpm install
createdb bliss && psql bliss -c 'CREATE EXTENSION IF NOT EXISTS vector;'
pnpm exec prisma migrate deploy --schema=prisma/schema.prisma
pnpm exec prisma db seed
pnpm dev                    # starts all 3 services
```

Open http://localhost:8080. Plaid, Gemini, and Twelve Data API keys are optional -- the app degrades gracefully without them.

## Testing

| Scope | Command | Framework | Notes |
|-------|---------|-----------|-------|
| All | `pnpm test` | -- | 1,076 tests across 152 files |
| API | `pnpm test:api` | Vitest (ESM) | 46 unit files (288 tests) + 14 integration files (121 tests) |
| Backend | `pnpm test:backend` | Jest (CJS) | 39 unit files (395 tests) + 8 integration files (66 tests) |
| Frontend | `pnpm test:web` | Vitest + RTL | 45 files (206 tests) |

Coverage thresholds: 70% lines, 70% functions, 60% branches.

**Integration tests** use `createIsolatedTenant()` for tenant isolation with cascade teardown. External APIs (Gemini, Twelve Data, Plaid) are mocked; Postgres and Redis are real.

**Backend mocking convention:** Declare `jest.mock()` calls before `require()` imports. Use `jest.clearAllMocks()` in `beforeEach`.

## Project structure

```
bliss/
  apps/
    api/                  # Next.js API + auth
      pages/api/          # Route handlers (auth, accounts, transactions, plaid, portfolio, ...)
      lib/                # Shared API logic
      utils/              # Helpers (14+ files)
      __tests__/          # Vitest tests (unit + integration)
    backend/              # Express workers
      src/
        routes/           # Internal REST endpoints
        services/         # Business logic (classification, pricing, portfolio, analytics)
        workers/          # BullMQ consumers (9 worker files)
        queues/           # Queue definitions
        config/           # Classification thresholds, constants
        middleware/       # apiKeyAuth
        utils/            # Encryption, logger, Redis, portfolio calculator
        __tests__/        # Jest tests
    web/                  # React SPA
      src/
        pages/            # Route pages (dashboard, accounts, transactions, ...)
        components/       # UI components (shadcn/ui in components/ui/)
        hooks/            # 40+ custom React hooks (use-*.ts)
        contexts/         # AuthContext
        lib/              # Utility modules (portfolio-utils, etc.)
    docs/                 # Nextra documentation site
      content/            # MDX/Markdown pages, guides
      public/openapi/     # OpenAPI YAML specs
  packages/shared/        # Encryption + storage adapters
  prisma/                 # Schema + 50+ migrations + seed
  docker/                 # Dockerfiles + nginx config
  scripts/                # setup.sh
  docs/                   # Architecture, config, specs, OpenAPI
```

## Key subsystems

### AI classification pipeline (4-tier waterfall)

Transaction classification flows through tiers until one succeeds:

1. **Exact Match** -- O(1) in-memory cache per tenant, backed by the `DescriptionMapping` table (SHA-256 hash → categoryId). Confidence: `1.0`
2. **Vector Match (tenant)** -- pgvector cosine similarity on `TransactionEmbedding` (768-dim, Gemini embeddings). Threshold: `reviewThreshold` (default 0.70)
3. **Vector Match (global)** -- Cross-tenant `GlobalEmbedding` table, discounted by `0.92x`
4. **LLM** -- Gemini (`gemini-3-flash-preview`), temperature 0.1, confidence hard-capped at `0.85`

Thresholds are per-tenant (`Tenant.autoPromoteThreshold`, `Tenant.reviewThreshold`). Config constants live in `apps/backend/src/config/classificationConfig.js` and must stay in sync with Prisma schema defaults.

**Feedback loop:** User corrections update the in-memory cache + `DescriptionMapping` table immediately (via `addDescriptionEntry()` write-through), then asynchronously generate/upsert embeddings.

### Portfolio processing pipeline

Event-driven multi-stage pipeline:

```
Transaction change -> eventSchedulerWorker -> portfolioWorker
  -> Stage 1: Portfolio initialization, FIFO lot calculation, USD PnL with historical FX
  -> Stage 2 (parallel): cashProcessor, analyticsWorker, valuationEngine
```

Key patterns:
- `originalScope` and `portfolioItemIds` must thread through the entire pipeline
- USD is the intermediary currency for all cross-rate conversions
- FIFO with historical FX rates: each buy lot records the buy-date rate
- Price fetching uses a 4-stage waterfall: memory cache -> live API -> 7-day DB lookback -> manual value fallback

**Nightly revaluation:** A `revalue-all-tenants` BullMQ cron runs at 4 AM UTC (after securityMaster refreshes prices at 3 AM). It enqueues per-tenant `value-all-assets`, `process-simple-liability`, and `process-amortizing-loan` jobs. `process-cash-holdings` is intentionally excluded — it would cascade into a full analytics rebuild via `CASH_HOLDINGS_PROCESSED`, and `value-all-assets` already handles cash via forward-fill. This prevents history gaps when no transactions occur for days. The `GET /api/portfolio/history` endpoint also has an on-access staleness check that fires a `PORTFOLIO_STALE_REVALUATION` event as a fallback for self-hosters.

### Smart import (CSV/XLSX)

Adapter-driven pipeline: detect format -> stage rows -> AI classify -> user review -> commit.

- Adapters matched by header intersection against `matchSignature`
- Deduplication via SHA-256 hash of `(date + description + amount + accountId)`
- Bliss Native CSV adapter enables direct import without AI classification
- Batch commit (200 rows/batch) with tag resolution via `resolveTagsByName()`

### Plaid integration

Two-worker system: `plaidSyncWorker` (IO-bound fetch) -> `plaidProcessorWorker` (CPU-bound classification).

- Incremental sync via cursor-based pagination
- Hash-based dedup catches manual-entry duplicates
- Raw payloads encrypted with AES-256-GCM in `PlaidTransaction.rawJson`
- Plaid category hints are passed to Gemini as additional context

### Analytics pipeline

Event-driven aggregation into `AnalyticsCacheMonthly` and `TagAnalyticsCacheMonthly`:

- Two job modes: `full-rebuild-analytics` (bulk) and `scoped-update-analytics` (incremental)
- Pass 1: Date range discovery + currency rate pre-fetching
- Pass 2: Transaction processing with multi-dimensional aggregation (year, month, currency, country, type, group)
- Tag analytics computed in parallel -- multi-tagged transactions create one entry per tag

### Insights engine (v1 — tiered architecture)

AI-generated financial insights with 5 cadence tiers:

| Tier | Cadence | Model | Purpose |
|------|---------|-------|---------|
| DAILY | 6 AM UTC | Flash (`INSIGHT_MODEL_FAST`) | Anomaly detection, quick alerts |
| MONTHLY | 2nd of month | Pro (`INSIGHT_MODEL`) | Monthly health check with MoM + YoY |
| QUARTERLY | 3rd day after Q close | Pro | Seasonal trends, deep analysis |
| ANNUAL | Jan 3rd | Pro | Comprehensive year-in-review |
| PORTFOLIO | Weekly Mon 5 AM | Pro | Equity analysis via SecurityMaster |

- 15 financial lenses across 6 categories (SPENDING, INCOME, SAVINGS, PORTFOLIO, DEBT, NET_WORTH)
- Data completeness gating: each tier checks period coverage before generation
- Additive persistence: old insights preserved, not replaced. Dedup by `(tenantId, tier, periodKey, dataHash)`
- TTL retention: DAILY=90d, MONTHLY=2y, QUARTERLY=5y, ANNUAL=forever, PORTFOLIO=1y
- Metadata enrichment: `actionTypes`, `relatedLenses`, `suggestedAction` for future goal integration
- User can manually trigger any tier via POST `/api/insights` with `{ tier, year, month, quarter, force }`

### Security master

Nightly refresh (3 AM UTC) of stock fundamentals from Twelve Data:

- Profile, earnings, dividends, quote data (41 credits per symbol)
- Computed fields: trailing EPS, P/E ratio, annualized dividend yield
- Separate rate limiter: `FUNDAMENTALS_THROTTLE_MS` (~30 calls/min)
- 7-day cache on profile data, checked before live API calls

## BullMQ workers reference

| Worker | Queue | Concurrency | Purpose |
|--------|-------|-------------|---------|
| `eventSchedulerWorker` | event-scheduler | 1 | Routes typed events to appropriate queues |
| `smartImportWorker` | smart-import | 1 | CSV parse, dedup, classify, stage; also dispatches `commit-smart-import` jobs to `commitWorker` |
| `plaidSyncWorker` | plaid-sync | 1 | Incremental Plaid transaction fetch |
| `plaidProcessorWorker` | plaid-processor | 1 | Classify and persist Plaid transactions |
| `portfolioWorker` | portfolio | 5 | FIFO lots, PnL, valuation, cash holdings, **nightly revaluation (4 AM UTC)** |
| `analyticsWorker` | analytics | 1 | Spending/tag analytics aggregation |
| `insightGeneratorWorker` | insights | 1 | Tiered AI insights: daily pulse (6 AM), monthly/quarterly/annual (auto-triggered), portfolio intel (Mon 5 AM) |
| `securityMasterWorker` | security-master | 1 | Nightly stock fundamentals refresh (cron 3 AM UTC) |

**Schedule chain:** securityMaster (3 AM, prices) -> portfolioWorker (4 AM, revaluation) -> portfolioIntel (Mon 5 AM, equity insights) -> insightGenerator (6 AM, daily pulse + auto-triggered monthly/quarterly/annual).

All workers route their `worker.on('failed', ...)` handler through `reportWorkerFailure` in `apps/backend/src/utils/workerFailureReporter.js`. The helper only calls `Sentry.captureException` on the **final** exhausted retry attempt — intermediate retries are logged at `warn` level. This prevents false alarms when BullMQ recovers from transient errors (Prisma Accelerate cold starts, Redis blips, Plaid race conditions). Never call `Sentry.captureException` directly from `worker.on('failed')`. Graceful shutdown: close workers before Redis disconnect.

## Environment variables

All services read from a single `.env` file at the repo root. Run `./scripts/setup.sh` to generate secrets.

**Required:** `DATABASE_URL`, `POSTGRES_PASSWORD`, `REDIS_URL`, `REDIS_PASSWORD`, `ENCRYPTION_SECRET`, `JWT_SECRET_CURRENT`, `NEXTAUTH_SECRET`, `INTERNAL_API_KEY`, `NEXTAUTH_URL`, `BACKEND_URL`, `NEXT_PUBLIC_API_URL`, `FRONTEND_URL`

**Optional integrations (degrade gracefully):**
- Plaid: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_WEBHOOK_URL`, `PLAID_HISTORY_DAYS`
- AI: `GEMINI_API_KEY`, `INSIGHT_MODEL`
- Market data: `TWELVE_DATA_API_KEY`
- Currency rates: `CURRENCYLAYER_API_KEY`
- Storage: `STORAGE_BACKEND`, `LOCAL_STORAGE_DIR`, `GCS_BUCKET_NAME`, `GCS_SERVICE_ACCOUNT_JSON`
- Key rotation: `ENCRYPTION_SECRET_PREVIOUS`, `JWT_SECRET_PREVIOUS`
- Observability: `SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`

See `.env.example` for the full reference.

## Deployment

Docker Compose orchestrates 5 services: postgres (with pgvector), redis, api, backend, web (nginx).

For production PaaS (e.g., Railway), the backend supports `START_MODE` env var:
- `web` -- API-only instance (lightweight, highly available)
- `worker` -- Worker-only instance (high CPU/RAM, no HTTP)
- `all` (default) -- Both in same process (local dev only)

## Documentation reference

Detailed specs live in `docs/` and are organized by layer:

- `docs/architecture.md` -- Full system design
- `docs/configuration.md` -- Environment variable reference
- `docs/guides/` -- How-to guides (Docker setup, imports, portfolios, etc.)
- `docs/specs/api/` -- API endpoint specifications (15 spec files)
- `docs/specs/backend/` -- Backend service specifications (12 spec files)
- `docs/specs/frontend/` -- Frontend component specifications (16 spec files)
- `docs/openapi/` -- OpenAPI/Swagger definitions (19 YAML files)

When working on a specific feature, read the relevant spec file(s) for full context on data models, business rules, and edge cases.

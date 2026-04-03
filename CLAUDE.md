# Bliss Finance

Bliss is a multi-tenant personal finance platform. It ingests bank transactions (Plaid or CSV), classifies them with a 4-tier AI pipeline, tracks investment portfolios with real-time pricing, and generates AI-powered financial insights.

## Architecture overview

Monorepo with three services behind a single `.env` file:

| Service | Stack | Port | Module system | Role |
|---------|-------|------|---------------|------|
| `apps/api` | Next.js 15 (Pages Router) | 3000 | ESM | Auth (NextAuth), REST API routes, Prisma ORM |
| `apps/backend` | Express + BullMQ | 3001 | **CJS** | Workers, async pipelines, internal API |
| `apps/web` | React 18 + Vite | 8080 | ESM | SPA with shadcn/ui, TanStack Query, Tailwind |
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
| All | `pnpm test` | -- | Runs all ~588 tests |
| API | `pnpm test:api` | Vitest (ESM) | Unit + integration with real Postgres |
| Backend | `pnpm test:backend` | Jest (CJS) | Unit + integration with supertest |
| Frontend | `pnpm test:web` | Vitest + RTL | Component tests, MSW for API mocking |

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
        workers/          # BullMQ consumers (10 workers)
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
  packages/shared/        # Encryption + storage adapters
  prisma/                 # Schema + 50+ migrations + seed
  docker/                 # Dockerfiles + nginx config
  scripts/                # setup.sh
  docs/                   # Architecture, config, specs, OpenAPI
```

## Key subsystems

### AI classification pipeline (4-tier waterfall)

Transaction classification flows through tiers until one succeeds:

1. **Exact Match** -- O(1) in-memory description cache per tenant. Confidence: `1.0`
2. **Vector Match (tenant)** -- pgvector cosine similarity on `TransactionEmbedding` (768-dim, Gemini embeddings). Threshold: `reviewThreshold` (default 0.70)
3. **Vector Match (global)** -- Cross-tenant `GlobalEmbedding` table, discounted by `0.92x`
4. **LLM** -- Gemini 2.0 Flash, temperature 0.1, confidence hard-capped at `0.85`

Thresholds are per-tenant (`Tenant.autoPromoteThreshold`, `Tenant.reviewThreshold`). Config constants live in `apps/backend/src/config/classificationConfig.js` and must stay in sync with Prisma schema defaults.

**Feedback loop:** User corrections update the exact-match cache immediately, then asynchronously generate/upsert embeddings.

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

### Insights engine

AI-generated financial insights via daily cron (6 AM UTC) or on-demand:

- 7 financial lenses: spending velocity, category concentration, income stability, savings rate, portfolio exposure, debt health, net worth trajectory
- Data hash deduplication skips regeneration when underlying data is unchanged
- Model: configurable via `INSIGHT_MODEL` env var (default Gemini)

### Security master

Nightly refresh (3 AM UTC) of stock fundamentals from Twelve Data:

- Profile, earnings, dividends, quote data (41 credits per symbol)
- Computed fields: trailing EPS, P/E ratio, annualized dividend yield
- Separate rate limiter: `FUNDAMENTALS_THROTTLE_MS` (~30 calls/min)
- 7-day cache on profile data, checked before live API calls

## BullMQ workers reference

| Worker | Queue | Concurrency | Purpose |
|--------|-------|-------------|---------|
| `eventSchedulerWorker` | event-scheduler | 3 | Routes typed events to appropriate queues |
| `smartImportWorker` | smart-import | 1 | CSV parse, dedup, classify, stage |
| `commitWorker` | smart-import | 1 | Batch commit staged rows to transactions |
| `plaidSyncWorker` | plaid-sync | 3 | Incremental Plaid transaction fetch |
| `plaidProcessorWorker` | plaid-processor | 5 | Classify and persist Plaid transactions |
| `portfolioWorker` | portfolio | 1 | FIFO lots, PnL, valuation, cash holdings |
| `analyticsWorker` | analytics | 1 | Spending/tag analytics aggregation |
| `insightGeneratorWorker` | insights | 1 | AI financial insights generation |
| `securityMasterWorker` | security-master | 1 | Nightly stock fundamentals refresh |

All workers report failures to Sentry with structured context (worker name, job name, tenantId, attempt count). Graceful shutdown: close workers before Redis disconnect.

## Environment variables

All services read from a single `.env` file at the repo root. Run `./scripts/setup.sh` to generate secrets.

**Required:** `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_SECRET`, `JWT_SECRET_CURRENT`, `NEXTAUTH_SECRET`, `INTERNAL_API_KEY`, `NEXTAUTH_URL`, `BACKEND_URL`, `NEXT_PUBLIC_API_URL`, `FRONTEND_URL`

**Optional integrations (degrade gracefully):**
- Plaid: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`
- AI: `GEMINI_API_KEY`
- Market data: `TWELVE_DATA_API_KEY` or `FINNHUB_API_KEY` (set `STOCK_PROVIDER`)
- Currency rates: `CURRENCYLAYER_API_KEY`
- Observability: `SENTRY_DSN`

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
- `docs/getting-started.md` -- Setup guide
- `docs/specs/api/` -- API endpoint specifications (15 spec files)
- `docs/specs/backend/` -- Backend service specifications (12 spec files)
- `docs/specs/frontend/` -- Frontend component specifications (16 spec files)
- `docs/openapi/` -- OpenAPI/Swagger definitions (19 YAML files)

When working on a specific feature, read the relevant spec file(s) for full context on data models, business rules, and edge cases.

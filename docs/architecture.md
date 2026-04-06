# Bliss Finance -- Architecture

## High-Level Overview

Bliss Finance is a self-hostable financial dashboard built as a monorepo with
three application services, one PostgreSQL database (with pgvector), and a Redis
instance for job queues and caching.

![Bliss Architecture](/images/blissarchitecture.svg)

```
                        Browser (React SPA)
                              |
                         :8080 (nginx)
                              |
              +---------------+---------------+
              |                               |
         Next.js API (:3000)          Express Backend (:3001)
         - Auth (JWT + cookies)       - 10 BullMQ workers
         - 60+ REST endpoints         - AI classification
         - Prisma ORM                 - Portfolio valuation
         - File upload                - Plaid sync
              |                               |
              +----------- PostgreSQL ---------+
                          (pgvector)
                              |
                            Redis
                        (queues + cache)
```

**Key properties:**

- The **Next.js API** is the only service exposed to the browser. It handles
  authentication, serves REST endpoints, manages file uploads, and owns the
  Prisma ORM layer.
- The **Express Backend** is an internal service. It runs long-lived BullMQ
  workers for async processing (AI classification, Plaid sync, portfolio
  valuation, analytics). It is never called directly by the browser.
- **PostgreSQL 16** stores all application data. The pgvector extension powers
  embedding-based similarity search for transaction classification.
- **Redis 7** acts as the message broker for BullMQ and provides ephemeral
  caching.

---

## Monorepo Structure

```
bliss-finance-monorepo/
|
+-- apps/
|   +-- api/            Next.js Pages Router (ESM, "type": "module")
|   +-- backend/        Express + BullMQ (CJS, require())
|   +-- web/            React SPA -- Vite, shadcn/ui, Tailwind CSS
|   +-- docs/           Nextra 4 documentation site (port 3002)
|
+-- packages/
|   +-- shared/         Dual ESM/CJS package (built with tsup)
|                       - encryption.js (AES-256-GCM helpers)
|                       - storage adapter (local / GCS)
|
+-- prisma/             Single Prisma schema shared by api and backend
|   +-- schema.prisma
|   +-- migrations/
|   +-- seed.js
|
+-- docker/             Dockerfiles for each service
+-- docker-compose.yml  Orchestrates all 5 containers
+-- scripts/            Dev and deployment helper scripts
+-- docs/               Canonical documentation (synced to apps/docs)
```

### Module System Split

| App          | Module System | Why                                         |
| ------------ | ------------- | ------------------------------------------- |
| apps/api     | ESM           | Next.js 13+ default; `"type": "module"`     |
| apps/backend | CJS           | BullMQ worker sandboxing requires `require()`|
| packages/shared | Dual      | tsup builds both `.mjs` and `.cjs` outputs  |

The shared package exposes conditional exports so that `apps/api` resolves the
ESM entry and `apps/backend` resolves the CJS entry, with no runtime import
mismatch.

---

## Service Communication

### Browser --> API (apps/web --> apps/api)

```
  React SPA                      Next.js API
  (Vite, :5173 dev)              (:3000)
       |                              |
       +--- fetch / axios ----------->|
       |    Cookie: jwt=...           |
       |                              +--- withAuth middleware
       |                              |    validates JWT
       |<-------- JSON response ------+    scopes by tenantId
```

- The SPA calls the API via `fetch` or `axios`. Base URL is set by
  `NEXT_PUBLIC_API_URL`.
- Authentication is handled by JWT tokens stored in httpOnly cookies (issued
  by NextAuth.js).
- Every API route that requires auth wraps its handler with `withAuth`, which
  decodes the JWT, loads the User/Tenant from the database, and attaches them
  to `req.user`.

### API --> Backend (apps/api --> apps/backend)

```
  Next.js API                    Express Backend
  (:3000)                        (:3001)
       |                              |
       +--- POST /api/events -------->|   Header: x-api-key
       |    { type, payload }         |
       |                              +--- eventSchedulerWorker
       |                              |    routes event to queue
       |                              |
       +--- GET  /api/similar ------->|   Vector search proxy
       +--- POST /api/feedback ------>|   Classification feedback
```

- Internal HTTP calls from the API to the Backend.
- Protected by a shared secret (`INTERNAL_API_KEY`) sent in the `x-api-key`
  header.
- The primary pattern is event-based: the API posts a typed event to
  `BACKEND_URL/api/events`, and the `eventSchedulerWorker` routes it to the
  correct BullMQ queue.
- A few routes are called directly for synchronous responses (e.g.,
  `/api/similar` for vector search).

### Backend Workers (Internal)

Workers consume jobs from BullMQ queues. They never receive direct HTTP traffic
from the browser. Communication flow:

```
  API posts event
       |
       v
  eventSchedulerWorker
       |
       +---> smartImportQueue ---> smartImportWorker
       +---> plaidSyncQueue   ---> plaidSyncWorker
       +---> classifyQueue    ---> classificationWorker
       +---> portfolioQueue   ---> portfolioValuationWorker
       +---> analyticsQueue   ---> analyticsWorker
       +---> insightsQueue    ---> insightsWorker
       ...
```

---

## Authentication Flow

```
  1. User signs up / signs in
     (credentials or Google OAuth via NextAuth.js)
                |
                v
  2. JWT issued containing:
     { userId, tenantId, email, role }
                |
                v
  3. JWT set as httpOnly cookie
     (secure, sameSite: lax)
                |
                v
  4. Every API request:
     withAuth middleware --> decode JWT --> load User --> attach req.user
                |
                v
  5. All database queries scoped by req.user.tenantId
     (multi-tenant isolation)
```

- NextAuth.js handles the OAuth/credentials flow and session management.
- JWTs are short-lived. Refresh is handled by NextAuth session callbacks.
- The `withAuth` higher-order function wraps API route handlers. It returns
  401 if the token is missing or invalid.
- Multi-tenancy is enforced at the query level: every Prisma `where` clause
  includes `tenantId` from the authenticated user.

---

## Database (PostgreSQL 16 + pgvector)

### Schema Overview

The database has 50+ migrations managed by Prisma. Key models:

```
  Tenant
    |--- User (1:N)
    |--- Account (1:N)
    |     |--- Transaction (1:N)
    |     |--- Holding (1:N)
    |
    |--- Category (1:N, hierarchical via parentId)
    |--- Tag (1:N)
    |--- Budget (1:N)
    |
    |--- PlaidItem (1:N)
    |     |--- PlaidSyncLog (1:N)
    |
    |--- StagedImport (1:N)
    |     |--- StagedImportRow (1:N)
    |
    |--- TransactionEmbedding (1:N)
    |--- ImportAdapter (1:N)
```

### pgvector

The `TransactionEmbedding` table stores 768-dimensional vectors generated by
Gemini `embedding-001`. An IVFFlat index supports fast cosine similarity
queries for the vector classification tier.

```sql
-- Simplified schema
CREATE TABLE "TransactionEmbedding" (
    id            SERIAL PRIMARY KEY,
    "tenantId"    INTEGER NOT NULL,
    description   TEXT NOT NULL,
    embedding     vector(768) NOT NULL,
    "categoryId"  INTEGER,
    "transactionId" INTEGER UNIQUE,
    UNIQUE ("tenantId", description)
);

CREATE INDEX ON "TransactionEmbedding"
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### Encryption at Rest

Sensitive fields are encrypted with AES-256-GCM before being written to the
database. This is handled transparently by Prisma middleware:

| Model       | Encrypted Fields                |
| ----------- | ------------------------------- |
| Transaction | description, details            |
| Account     | accountNumber                   |
| PlaidItem   | accessToken                     |

- Encryption uses `@bliss/shared/encryption`, which reads `ENCRYPTION_SECRET`
  from the environment.
- Dual-key rotation is supported: if `ENCRYPTION_SECRET_PREVIOUS` is set,
  reads attempt decryption with the new key first, then fall back to the
  previous key. Writes always use the current key.
- The Prisma middleware intercepts `create`, `update`, and `findMany` operations
  to encrypt/decrypt automatically. Application code never handles ciphertext
  directly.

---

## AI Classification Pipeline (4-Tier Waterfall)

Every incoming transaction (Plaid or CSV import) is classified into a category
using a four-tier waterfall. Each tier is progressively more expensive:

```
  Transaction Description
          |
     [Tier 1: EXACT_MATCH]
     In-memory Map backed by DescriptionMapping table
     Keyed by SHA-256(normalize(description)), O(1) lookup
          |
     confidence >= autoPromoteThreshold? --YES--> classified
          |                                       source: EXACT_MATCH
          NO
          |
     [Tier 2: VECTOR_MATCH (tenant)]
     pgvector cosine similarity search on TransactionEmbedding
     Gemini embedding-001, 768 dimensions
     Top-1 result above reviewThreshold
          |
     similarity >= reviewThreshold? --YES--> classified
          |                                  source: VECTOR_MATCH
          NO
          |
     [Tier 3: VECTOR_MATCH (global)]
     Cross-tenant GlobalEmbedding table
     Same cosine search, discounted by 0.92x
          |
     adjusted similarity >= reviewThreshold? --YES--> classified
          |                                           source: VECTOR_MATCH
          NO
          |
     [Tier 4: LLM]
     Gemini Flash with structured prompt
     Full transaction context + tenant categories
     Confidence hard-capped at 0.85
          |
     --> classified
         source: LLM
```

### Feedback Loop

When a user overrides a classification (corrects a category), the system:

1. **Immediately** updates the in-memory exact-match cache and the `DescriptionMapping`
   table (write-through via `addDescriptionEntry()`), so the next identical
   description is classified instantly.
2. **Asynchronously** generates a new embedding via Gemini and upserts it into
   `TransactionEmbedding` (Tier 2), so similar descriptions benefit from the
   correction.

This creates a flywheel: the more the user corrects, the fewer LLM calls are
needed, and classification accuracy improves over time.

### Configurable Thresholds

Each tenant has two tunable thresholds on the `Tenant` model:

| Threshold              | Default | Purpose                                  |
| ---------------------- | ------- | ---------------------------------------- |
| autoPromoteThreshold   | 0.95    | Exact matches above this are auto-committed (no review needed) |
| reviewThreshold        | 0.70    | Vector matches above this are accepted; below triggers LLM     |

### Classification Sources

Every classified transaction records its `classificationSource`:

- `EXACT_MATCH` -- from the in-memory cache
- `VECTOR_MATCH` -- from pgvector similarity
- `LLM` -- from Gemini Flash
- `USER_OVERRIDE` -- manually set by the user

---

## Storage Abstraction

File storage (CSV/XLSX uploads) uses a factory pattern:

```
  createStorageAdapter(config)
          |
          +-- STORAGE_BACKEND=local  --> LocalStorageAdapter
          |   Files in LOCAL_STORAGE_DIR (default: ./data/uploads)
          |
          +-- STORAGE_BACKEND=gcs    --> GCSStorageAdapter
              Files in GCS bucket (GCS_BUCKET_NAME)
```

Both adapters implement the same interface: `upload(key, buffer)`,
`download(key)`, `delete(key)`, `exists(key)`.

The shared package (`packages/shared`) exports the factory and both adapters.
File uploads use `formidable` for multipart parsing with `bodyParser: false` in
the Next.js API config. Temp files are cleaned up after upload completes.

---

## Queue System (Redis + BullMQ)

### Architecture

```
  Redis 7
    |
    +-- BullMQ Queues (reliable, persistent)
    |     smart-import
    |     plaid-sync
    |     plaid-processor
    |     classification
    |     portfolio-valuation
    |     event-scheduler
    |     analytics
    |     import (legacy)
    |     insights
    |     plaid-webhook
    |
    +-- Cache (ephemeral)
          Description cache (in-memory, backed by DescriptionMapping table)
          Rate limit counters
```

### Worker Details

| Worker                    | Queue              | Concurrency | Purpose                                           |
| ------------------------- | ------------------ | ----------- | ------------------------------------------------- |
| smartImportWorker         | smart-import       | 1           | CSV parse, dedup, classify, stage rows            |
| plaidSyncWorker           | plaid-sync         | 3           | Incremental transaction fetch from Plaid          |
| plaidProcessorWorker      | plaid-processor    | 1           | Classify and persist Plaid transactions            |
| classificationWorker      | classification     | 5           | 3-tier AI classification pipeline                  |
| portfolioValuationWorker  | portfolio-valuation| 1           | Fetch prices, calculate holdings P&L               |
| eventSchedulerWorker      | event-scheduler    | 3           | Route typed events to appropriate queues           |
| analyticsWorker           | analytics          | 1           | Compute and cache spending analytics               |
| importWorker              | import             | 1           | Legacy CSV import (kept for backward compat)       |
| insightsWorker            | insights           | 1           | Generate AI financial insights                     |
| plaidWebhookWorker        | plaid-webhook      | 3           | Process Plaid webhook payloads                     |

### Scheduled Jobs (Nightly Cron)

Three workers register BullMQ repeatable jobs that run on a nightly schedule:

| Job | Worker | Cron (UTC) | Purpose |
| --- | ------ | ---------- | ------- |
| `refresh-all-fundamentals` | securityMasterWorker | `0 3 * * *` (3 AM) | Refresh stock prices, profiles, earnings, dividends |
| `revalue-all-tenants` | portfolioWorker | `0 4 * * *` (4 AM) | Enqueue per-tenant portfolio revaluation (investments, cash, debts) |
| `generate-all-insights` | insightGeneratorWorker | `0 6 * * *` (6 AM) | Generate AI financial insights for all tenants |

The schedule chain is intentional: fresh prices (3 AM) feed into revaluation (4 AM), which feeds into insights (6 AM). The portfolio revaluation ensures history has no gaps even when no transactions occur for days.

**On-access fallback:** The `GET /api/portfolio/history` endpoint also checks if the most recent history record is before today. If stale, it fires a `PORTFOLIO_STALE_REVALUATION` event to trigger revaluation for that tenant. This covers self-hosters where the nightly job may not be running reliably.

### Queue Patterns

- **Singletons**: Each queue is created once in `src/queues/` and imported by
  the corresponding worker. This avoids duplicate Redis connections.
- **Retries**: Jobs have configurable retry counts with exponential backoff.
- **TLS**: Supports TLS connections to Redis in production. Set
  `REDIS_SKIP_TLS_CHECK=true` for local development without TLS.

---

## Docker Architecture

### Compose Services

```yaml
services:
  postgres:     # PostgreSQL 16 + pgvector extension
  redis:        # Redis 7
  api:          # Next.js API (apps/api)
  backend:      # Express workers (apps/backend)
  web:          # nginx serving the React SPA (apps/web)
```

### Startup Order

```
  postgres ----+
               |--- api (runs prisma migrate deploy + seed, then starts)
  redis -------+
               |--- backend (connects to postgres + redis, starts workers)
               |
               +--- web (nginx, no dependencies beyond api being routable)
```

### Key Configuration

- **Shared volume** (`uploads_data`): Mounted in both `api` and `backend` so
  that uploaded files (written by the API during file upload) can be read by
  backend workers (during smart import processing).
- **Multi-stage Dockerfiles**: Each service uses a multi-stage build to
  minimize final image size (install deps, build, copy only production
  artifacts).
- **nginx SPA routing**: The `web` service serves static assets and falls back
  to `index.html` for client-side routing.

---

## Multi-Tenancy

### Isolation Model

Bliss uses **query-level tenant isolation** (shared database, shared schema):

```
  Request arrives
       |
       v
  withAuth extracts tenantId from JWT
       |
       v
  Every Prisma query includes:
  { where: { tenantId: req.user.tenantId, ... } }
       |
       v
  Response contains only the tenant's data
```

### What Is Scoped

- All user-created data: accounts, transactions, categories, tags, budgets,
  imports, embeddings, audit logs, Plaid connections, holdings.
- Per-tenant settings: classification thresholds, display currency, adapter
  configurations.

### What Is Shared

- Reference data: countries, currencies, supported banks, exchange rates.
- System configuration: feature flags, global rate limits.

There is no row-level security (RLS) in PostgreSQL. Isolation is enforced
entirely in the application layer through Prisma query scoping. Every query
that touches tenant data must include `tenantId` in its `where` clause.

---

## Internationalization

The frontend (`apps/web`) uses **react-i18next** for client-side internationalization. The API and backend operate in English — all user-facing text is translated on the client.

**Supported languages:** English (`en`), Spanish (`es`), French (`fr`), Portuguese (`pt`), Italian (`it`).

Translation files are TypeScript objects in `apps/web/src/i18n/locales/`. System category names (seeded from `defaultCategories.js`) are translated on the frontend using the stable `defaultCategoryCode` field as the i18n lookup key. Custom user-created categories are stored and displayed in whatever language the user entered them.

Language preference is auto-detected from the browser and persisted in `localStorage`. Users can switch via the language selector in the header.

See `docs/specs/frontend/00-design-system.md` section 12 for implementation details.

---

## Environment Variables

### Required (all services)

| Variable            | Service(s)    | Purpose                              |
| ------------------- | ------------- | ------------------------------------ |
| DATABASE_URL        | api, backend  | PostgreSQL connection string          |
| REDIS_URL           | backend       | Redis connection string               |
| ENCRYPTION_SECRET   | api, backend  | AES-256-GCM key (32 bytes, base64)   |
| NEXTAUTH_SECRET     | api           | NextAuth.js JWT signing secret        |
| INTERNAL_API_KEY    | api, backend  | Shared secret for internal API calls  |
| BACKEND_URL         | api           | URL of the Express backend            |

### Optional

| Variable                    | Default          | Purpose                            |
| --------------------------- | ---------------- | ---------------------------------- |
| ENCRYPTION_SECRET_PREVIOUS  | (none)           | Previous key for rotation           |
| STORAGE_BACKEND             | local            | "local" or "gcs"                    |
| LOCAL_STORAGE_DIR           | ./data/uploads   | Path for local file storage         |
| GCS_BUCKET_NAME             | (none)           | Google Cloud Storage bucket          |
| PLAID_CLIENT_ID             | (none)           | Plaid API client ID                  |
| PLAID_SECRET                | (none)           | Plaid API secret                     |
| GEMINI_API_KEY              | (none)           | Google Gemini API key                |
| REDIS_SKIP_TLS_CHECK        | false            | Skip TLS verification (dev only)     |
| NEXT_PUBLIC_API_URL         | (none)           | API base URL for the frontend SPA    |

---

## Security Summary

| Layer                 | Mechanism                                          |
| --------------------- | -------------------------------------------------- |
| Transport             | HTTPS (TLS termination at nginx/load balancer)     |
| Authentication        | JWT in httpOnly cookies (NextAuth.js)              |
| Authorization         | Tenant-scoped queries; role field on User           |
| Internal services     | INTERNAL_API_KEY header                             |
| Data at rest          | AES-256-GCM on sensitive fields                     |
| Secrets management    | Environment variables (not committed to repo)       |
| Input validation      | Zod/Joi schemas on API routes                       |
| Rate limiting         | Per-route rate limiting middleware                   |
| File uploads          | formidable with size limits; temp file cleanup       |
| CSRF                  | httpOnly + sameSite cookie policy                    |

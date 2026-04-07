# 13. Automated Testing & Error Logging

## 13.1 Overview

This specification covers the testing infrastructure and error-logging strategy for the `apps/api` layer.

The finance-api is a Next.js application (ESM, `import/export`) built on top of Prisma ORM. Its API routes are standard Next.js handler functions — they do not run as a persistent Express server, which shapes the integration test approach (direct handler invocation rather than HTTP-level supertest).

The service uses a **two-layer test pyramid**:

```
         ┌──────────────────────────────────────┐
         │   Integration Tests                   │  Direct handler invocation, mocked Prisma
         │   (fewer, slower)                     │  mocked: rate limiter, withAuth, cors
         └──────────────────────────────────────┘
      ┌────────────────────────────────────────────┐
      │      Unit Tests                             │  Vitest + full vi.mock(), no I/O
      │      (more, fast)                           │
      └────────────────────────────────────────────┘
```

The API test suite includes unit tests (in `__tests__/unit/`) and integration tests (in `__tests__/integration/`). Run `pnpm test:api` to execute all tests.

---

## 13.2 Unit Test Architecture

### Framework

Vitest is used because the finance-api is pure ESM. The backend service (`apps/backend`) uses Jest (CJS) — the two frameworks are intentionally not mixed.

### Configuration (`vitest.config.ts`)

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    reporter: 'verbose',
    include: ['__tests__/**/*.test.{js,ts}'],
    setupFiles: [
      '__tests__/setup/env.ts',    // sets ENCRYPTION_SECRET + JWT_SECRET_CURRENT before imports
      '__tests__/setup/sentry.ts', // mocks @sentry/nextjs globally
    ],
    coverage: {
      provider: 'v8',
      include: ['pages/api/**', 'utils/**'],
      thresholds: { branches: 60, functions: 70, lines: 70 },
    },
  },
});
```

### Setup Files

**`setup/env.ts`** — sets `process.env.ENCRYPTION_SECRET` and `process.env.JWT_SECRET_CURRENT` before any module is resolved. Required because the Prisma encryption middleware and `withAuth` read these at module load time.

**`setup/sentry.ts`** — mocks the entire `@sentry/nextjs` package with `vi.mock()`. Prevents accidental Sentry traffic and avoids DSN errors in CI.

### Mocking Strategy

All unit tests use `vi.mock()` at the module level, before importing the module under test:

```ts
// Mock external dependencies
vi.mock('../../prisma/prisma.js', () => ({
  default: { user: { findUnique: vi.fn() } },
}));

// Type-safe mock access
const mockPrisma = vi.mocked(prisma);

// Reset between tests
beforeEach(() => vi.clearAllMocks());
```

For request/response testing, factory helpers build minimal Next.js-compatible objects:

```ts
function makeReq(overrides = {}): Partial<NextApiRequest> {
  return { cookies: {}, headers: {}, method: 'GET', ...overrides };
}

function makeRes(): Partial<NextApiResponse> {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.end = vi.fn();
  return res;
}
```

### Test Suites

**Middleware & utility tests** (`unit/middleware/`, `unit/utils/`):

| File | Covers | Key Mocks |
|------|--------|-----------|
| `unit/middleware/withAuth.test.ts` | JWT extraction (cookie + header), denylist check, role enforcement, optional mode | prisma, denylist, jsonwebtoken |
| `unit/utils/encryption.test.ts` | AES-256-GCM encrypt/decrypt, searchable salt behaviour | none |
| `unit/utils/cookieUtils.test.ts` | `setAuthCookie()` / `clearAuthCookie()` — HttpOnly, Secure, Domain, Max-Age | none |
| `unit/utils/cors.test.ts` | CORS preflight (OPTIONS), origin allowlist, localhost in dev | none |
| `unit/utils/denylist.test.ts` | `addToDenylist()` / `isRevoked()` — Redis SET/EXISTS, TTL, graceful degradation | ioredis constructor |
| `unit/utils/produceEvent.test.ts` | Fire-and-forget POST to backend `/api/events`, Sentry capture | node-fetch, @sentry/nextjs |
| `unit/utils/currencyConversion.test.ts` | `convertCurrency()` direct/inverse/forward-fill, `batchFetchRates()` | prisma.currencyRate |
| `unit/utils/tagUtils.test.ts` | Tag resolution and linking utilities | prisma |
| `unit/utils/transactionHash.test.ts` | SHA-256 transaction dedup hash computation | none |
| `unit/utils/descriptionHash.test.ts` | Description normalization and hashing | none |
| `unit/utils/validateEnv.test.ts` | Environment variable validation | none |
| `unit/utils/rateLimit.test.ts` | Rate limiter configuration and middleware | none |
| `unit/routes/signout.test.ts` | POST /api/auth/signout — method guard, cookie clear, JWT decode + denylist | rateLimit, cors, cookieUtils, denylist, jsonwebtoken |

**Route handler tests** (`unit/api/`): Covers a wide range of API routes using the mocked handler pattern, including analytics, banks, countries, currencies, currency-rates, imports (detect-adapter, pending, upload), insights, notifications-summary, onboarding-progress, plaid routes (accounts, bulk-promote, bulk-requeue, create-link-token, disconnect, exchange-token, items, resync, sync-accounts, sync-logs, webhook), portfolio routes (debt-terms, equity-analysis, history, holdings, items, manual-value-detail, manual-values), tenants, and transactions-merchant-history.

### Running Unit Tests

```bash
npm run test:unit       # run once
npm run test:watch      # watch mode during development
npm run test:coverage   # with v8 coverage report
```

---

## 13.3 Integration Test Architecture

### Philosophy

Integration tests call Next.js API route handlers **directly as functions**, passing factory-built `req`/`res` objects. This avoids the complexity of booting a full Next.js server while still exercising the real authentication middleware, real Prisma queries, and real business logic.

What is tested:
- Request parsing and validation
- `withAuth` middleware (JWT verification, DB user hydration)
- Prisma queries (correct data written / returned for the tenant)
- Response status codes and body shape

What is mocked:
- **Rate limiter** — Express rate-limit middleware is mocked to a no-op (`next()` immediately), preventing test failures caused by repeated requests from a single IP
- **Redis denylist** — `isRevoked()` in `utils/denylist.js` is mocked to always return `false`, removing the Redis dependency from test runs

### Test Database

```
DATABASE_URL=postgresql://<user>@localhost:5432/bliss_test
```

Create the database and apply all migrations once:

```bash
createdb bliss_test
npx prisma migrate deploy
```

CI uses a `pgvector/pgvector:pg16` service container (see §13.6).

### Tenant Isolation

Each integration test file creates an isolated tenant in `beforeAll` and hard-deletes it in `afterAll`. The `__tests__/helpers/tenant.ts` utility:

```ts
// Creates Tenant + admin User, returns { tenantId, userId, token }
const { tenantId, token } = await createIsolatedTenant();

// Cascade-deletes the tenant and all linked data
await teardownTenant(tenantId);
```

The returned `token` is a pre-signed JWT (using `JWT_SECRET_CURRENT` from `.env.test`) that can be passed as `req.headers.authorization = 'Bearer <token>'` in subsequent handler calls.

### Authentication in Tests

Because `withAuth` supports both cookies and the `Authorization` header, tests pass the JWT via header:

```ts
const req = makeReq({
  method: 'GET',
  headers: { authorization: `Bearer ${token}` },
});
```

No cookie setup is required.

### Test Files

#### Real-DB Integration Tests (supertest-like, `createIsolatedTenant`)

These tests use real Prisma connected to `bliss_test` and the `createIsolatedTenant()` helper:

| File | Route | Approach |
|------|-------|----------|
| `integration/api/auth/signup.test.ts` | `POST /api/auth/signup` | Real Prisma, mocked rate limiter |
| `integration/api/auth/change-password.test.ts` | `POST /api/auth/change-password` | Real Prisma + real `withAuth` |
| `integration/api/accounts.test.ts` | `GET/POST /api/accounts` | Real Prisma + real `withAuth` |
| `integration/api/categories.test.ts` | `GET /api/categories` | Real Prisma, manual category seeding |
| `integration/api/users.test.ts` | `GET/PUT /api/users` | Real Prisma + real `withAuth` |
| `integration/api/plaid/fetch-historical.test.ts` | `POST /api/plaid/fetch-historical` | Real Prisma, mocked Plaid client |

#### Mocked-Handler Integration Tests

These tests use the **mocked handler pattern**: `vi.mock()` for `withAuth`, `rateLimit`, `cors`, and `prisma`, then invoke the handler directly with `makeReq()`/`makeRes()` factories. No database required.

| File | Tests | Route | Key Mocks |
|------|-------|-------|-----------|
| `integration/api/tenant-settings.test.ts` | 8 | `GET/PUT /api/tenants/settings` | withAuth, prisma (user, tenant) |
| `integration/api/ticker-search.test.ts` | 6 | `GET /api/ticker/search` | withAuth, globalThis.fetch |
| `integration/api/auth/signin.test.ts` | 7 | `POST /api/auth/signin` | prisma, AuthService, cookieUtils, jsonwebtoken |
| `integration/api/tags.test.ts` | 10 | `GET/POST/PUT/DELETE /api/tags` | prisma (tag, $transaction), withAuth |
| `integration/api/imports/adapters.test.ts` | 7 | `GET/POST /api/imports/adapters` | prisma (importAdapter), withAuth |
| `integration/api/plaid/transactions.test.ts` | 6 | `PUT /api/plaid/transactions/:id` | prisma (plaidTransaction, category, account, transaction, $transaction), produceEvent, globalThis.fetch |
| `integration/api/transactions.test.ts` | 20 | `GET/POST/PUT/DELETE /api/transactions` | prisma (transaction, account, category, tag, $transaction), produceEvent, withAuth |
| `integration/api/imports/commit.test.ts` | 11 | `POST /api/imports/:id?action=commit\|cancel` | prisma (stagedImport), produceEvent, withAuth — tests async commit dispatch (202), partial commit with rowIds, produceEvent failure revert, cancel flow |

---

## 13.4 Error Logging Strategy (Sentry)

### Next.js Integration

Sentry is initialised in `instrumentation.js` (Next.js 15 instrumentation hook), which Next.js loads before any request handler runs. This replaces the old pattern of calling `Sentry.init()` inside the handler file.

```ts
// instrumentation.js
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { init } = await import('@sentry/nextjs');
    init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    });
  }
}
```

### What Gets Sent to Sentry

| Situation | Sent to Sentry? | Reason |
|-----------|-----------------|--------|
| Unhandled exception in route handler | ✅ Yes | `Sentry.captureException(error)` in catch block |
| Route returns 400 (validation failure) | ❌ No | Intentional `return res.status(400).json(...)` |
| Route returns 401/403 (auth failure) | ❌ No | `withAuth` returns early, no exception |
| Rate limit exceeded (429) | ❌ No | Handled by `express-rate-limit`, not thrown |

Only thrown exceptions in `catch` blocks are sent. All intentional error responses (4xx) are returned directly without throwing.

### Sentry Mock in Tests

The `__tests__/setup/sentry.ts` setup file mocks `@sentry/nextjs` globally:

```ts
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
  prismaIntegration: vi.fn(),
}));
```

This ensures:
1. No Sentry traffic during test runs
2. No crash when `SENTRY_DSN` is not set in `.env.test`
3. Tests can assert on `captureException` call counts if needed

---

## 13.5 MSW (Mock Service Worker)

`msw@^2` is installed as a dev dependency. In the finance-api, MSW is available for API-level mocking when integration tests need to stub responses from `apps/backend` (e.g., stubbing `POST /api/feedback` responses without running the backend service).

`apps/web` uses MSW's node server (`setupServer`) in its test setup (see the frontend test spec and `src/test/msw/server.ts`).

```ts
import { http, HttpResponse } from 'msw';
const handlers = [
  http.post('http://localhost:3001/api/feedback', () =>
    HttpResponse.json({ message: 'Feedback recorded' })
  ),
];
```

---

## 13.6 CI/CD

Integration tests run in GitHub Actions. See `.github/workflows/ci.yml` for the full configuration.

Key environment variables required for the `finance-api-integration` CI job:

| Variable | Value in CI |
|----------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/bliss_test` |
| `ENCRYPTION_SECRET` | Any 32-character test value |
| `JWT_SECRET_CURRENT` | Any test value |

The CI job runs `npx prisma migrate deploy` before executing tests to ensure the `bliss_test` schema is current. The `pgvector/pgvector:pg16` image is required because the schema includes the `vector` extension and the `TransactionEmbedding` model.

---

## 13.7 Test Results Summary

The API test suite consists of **46 unit test files (288 tests)** and **14 integration test files (121 tests)** for a total of **409 tests across 60 files**. Unit tests cover middleware, utilities, and route handlers across `unit/middleware/`, `unit/utils/`, and `unit/api/` directories. Integration tests use both real-DB and mocked-handler patterns. Run `pnpm test:api` to execute all tests.

### Key Implementation Patterns

**Rate limiter mock** — The rate limiter middleware is wrapped in a `new Promise(...)` inside handlers, so mocking it requires a `Proxy` no-op rather than a simple `vi.fn()`:

```ts
vi.mock('../../utils/rateLimit.js', () => ({
  default: new Proxy({}, { get: () => (_req: any, _res: any, next: any) => next() }),
}));
```

**Mocked handler pattern** — For routes that are complex to test with real Prisma, the handler is imported after mocking all dependencies. This pattern was introduced in `tenant-settings.test.ts` and extended to auth, tags, adapters, and plaid transaction tests:

```ts
vi.mock('../../utils/rateLimit.js', ...);  // Proxy no-op
vi.mock('../../utils/cors.js', ...);       // returns false (non-OPTIONS)
vi.mock('../../middleware/withAuth.js', ...); // injects req.user
vi.mock('../../prisma/prisma.js', ...);    // mock DB operations

const handler = (await import('../../pages/api/route.js')).default;
await handler(makeReq({...}), makeRes());
```

**Prisma $transaction mock** — For handlers using `prisma.$transaction(fn)` callback mode:

```ts
mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
```

**Denylist graceful degradation** — `utils/denylist.js` returns `false` when `REDIS_URL` is not set, meaning Redis is not required for finance-api tests.

**Teardown order** — `User` does not have `onDelete: Cascade` on its Tenant relation. The `teardownTenant` helper explicitly deletes users before deleting the Tenant.

---

## 13.8 E2E Scaffolding (Phase 4)

E2E tests live at `e2e/`, owned by the frontend CI workflow. They are not part of this repo's CI pipeline.

Full documentation is in:

```
docs/specs/frontend/13-automated-testing-and-error-logging.md §13.5
```

All 13 E2E test cases are `test.skip` stubs — they pass in CI (exit 0, all skipped) and run only on merges to `main` in the monorepo CI.

---

## 13.9 Coverage Notes & Next Steps

The API test suite has broad coverage across authentication, accounts, categories, tags, transactions, imports, Plaid routes, portfolio routes, analytics, and utility modules. Many features previously listed as "untested" now have unit or integration tests under `unit/api/` and `unit/utils/`.

**Areas with remaining gaps:**
- `auth/refresh.ts` -- token rotation
- `transactions/import.ts` -- legacy "dumb" import path
- `imports/upload.ts` -- multipart file upload + GCS storage

### Recommended Next Steps

1. **`auth/refresh.ts`** -- last remaining auth endpoint without coverage
2. **Multipart upload paths** -- `imports/upload.ts` and `imports/detect-adapter.ts` require formidable/file mocking
3. **Edge cases in existing tests** -- error paths, concurrent access, and boundary conditions in the already-tested routes

# Bliss API (Next.js)

This is the public-facing API layer. It handles authentication, REST endpoints, Prisma ORM access, and event dispatch to the backend service. Built with Next.js 15 Pages Router.

## Module system: ESM

All files use `import` / `export`. Never use `require()` in this app.

## Directory structure

```
apps/api/
  pages/api/            # File-based API routes (the core of this app)
    auth/               # signin, signup, signout, session, change-password, google-token, [...nextauth]
    transactions/       # CRUD, export, merchant-history
    imports/            # upload, detect-adapter, adapters, [id]/rows/[rowId], [id]/seeds, [id]/confirm-seeds
    portfolio/          # items, holdings, history, equity-analysis
    plaid/              # create-link-token, accounts, fetch-historical, transactions/, webhook
    notifications/      # Notification endpoints
    onboarding/         # Onboarding flow
    admin/              # default-categories management
    tenants/            # settings, info
    ticker/             # search
    accounts.js         # Account CRUD
    categories.js       # Category CRUD + merge
    tags.js             # Tag management
    analytics.js        # Financial metrics
    insights.js         # AI insights
    users.js            # User profile
    banks.js            # Bank listing
    countries.js        # Supported countries
    currencies.js       # Supported currencies
    currency-rates.js   # Exchange rates
  utils/                # Shared utilities (14+ files)
  services/             # Business logic (auth, transactions, plaid, valuation)
  lib/                  # Constants, default categories
  prisma/               # Prisma client with encryption + validation extensions
  __tests__/            # Vitest tests (unit + integration)
    unit/               # Isolated utility and middleware tests
    integration/api/    # Full handler tests with real Postgres
    setup/              # env.ts, sentry.ts
    helpers/            # tenant.ts (createIsolatedTenant / teardownTenant)
```

## Route handler pattern

Every API route follows this structure:

```javascript
import { withAuth } from '@/utils/withAuth';
import { applyCors } from '@/utils/cors';
import { rateLimiter } from '@/utils/rateLimit';

export default async function handler(req, res) {
  await rateLimiter(req, res);          // 1. Rate limit
  await applyCors(req, res);            // 2. CORS (returns early on OPTIONS)
  if (req.method === 'OPTIONS') return;

  const user = await withAuth(req, res); // 3. Auth (sets req.user)
  if (!user) return;

  switch (req.method) {                  // 4. Method dispatch
    case 'GET':    return handleGet(req, res, user);
    case 'POST':   return handlePost(req, res, user);
    default:       return res.status(405).json({ error: 'Method not allowed' });
  }
}
```

Errors are caught in try/catch, logged to Sentry, and returned as `{ error, details? }`.

## Authentication

- **JWT** stored in HttpOnly cookies (primary) or Authorization Bearer header (fallback)
- **Token payload:** `{ jti, userId, tenantId, email }` -- signed with `JWT_SECRET_CURRENT`, 24h expiry
- **Revocation:** jti added to Redis denylist on signout (TTL = remaining token life)
- **Secret rotation:** `withAuth` tries `JWT_SECRET_CURRENT` first, then `JWT_SECRET_PREVIOUS`
- **Multi-tenant isolation:** `user.tenantId` from JWT is used in every Prisma query. Never trust client-supplied tenantId.

## Key utilities

| File | Purpose |
|------|---------|
| `withAuth.js` | JWT validation, Redis denylist check, hydrates `req.user` |
| `cors.js` | Dynamic origin whitelist from `FRONTEND_URL`, auto-adds localhost in dev |
| `cookieUtils.js` | HttpOnly, Secure, SameSite cookie config |
| `rateLimit.js` | Per-route rate limiters (22 endpoints configured) |
| `denylist.js` | Redis-backed JWT revocation, fail-open if Redis unavailable |
| `produceEvent.js` | Dispatch events to backend via `POST BACKEND_URL/api/events` with `INTERNAL_API_KEY` |
| `currencyConversion.js` | Cross-currency conversion with 7-day forward-fill lookback |
| `tagUtils.js` | Find-or-create tags with P2002 race condition handling |
| `transactionHash.js` | SHA-256 dedup hash: `(date + description + amount + accountId)` |
| `validateEnv.js` | Startup validation of required env vars |

## Prisma client (`prisma/prisma.js`)

Uses Prisma 6 `$extends` with a single `$allModels.$allOperations` extension that runs in order:

1. **Encrypt** -- Auto-encrypts fields on create/update/upsert and in WHERE clauses (searchable encryption)
2. **Validate** -- Enforces data constraints (name lengths, currency ISO codes, date ranges, etc.)
3. **Execute** -- Runs the actual query
4. **Decrypt** -- Auto-decrypts returned data

The encrypted fields config comes from `@bliss/shared/encryption`. You never need to manually encrypt/decrypt.

## Path aliases

`@/*` maps to the app root (configured in `jsconfig.json`). Use `@/utils/withAuth`, `@/services/auth.service`, etc.

## Event dispatch

To trigger async work in the backend, use `produceEvent()`:

```javascript
import { produceEvent } from '@/utils/produceEvent';

await produceEvent({
  type: 'TRANSACTIONS_IMPORTED',
  tenantId: user.tenantId,
  // ... event-specific data
});
```

This POSTs to `BACKEND_URL/api/events` with the `INTERNAL_API_KEY` header. The backend's `eventSchedulerWorker` routes it to the appropriate BullMQ queue.

## Response format

**List endpoints:**
```json
{
  "items": [...],
  "total": 123,
  "page": 1,
  "limit": 100,
  "totalPages": 2,
  "filters": {},
  "sort": { "field": "name", "order": "asc" }
}
```

**Mutations:** 201 for creation, 200 for updates, 204 for deletes.

**Errors:** `{ "error": "message", "details": "..." }` with appropriate HTTP status (400, 401, 403, 404, 409, 429, 500).

## Testing

**Framework:** Vitest (ESM) with globals enabled.

**Run tests:**
```bash
pnpm test:api           # all tests
pnpm test:unit          # unit only
pnpm test:integration   # integration only (requires bliss_test DB)
```

**Coverage:** 70% lines/functions, 60% branches. Excludes `pages/api/auth/[...nextauth].js`.

**Integration tests** use `createIsolatedTenant()` from `__tests__/helpers/tenant.ts` which creates a Tenant + User + signed JWT. Always call `teardownTenant()` in afterAll.

**Test setup** (`__tests__/setup/env.ts`): Loads `.env.test` first, then root `.env`. Forces test values for encryption and JWT secrets. This runs before any module imports.

**Mocking:** Rate limiter is mocked in integration tests. Prisma hits a real `bliss_test` database. External APIs (Plaid, Gemini) are mocked.

## Services

| Service | Purpose |
|---------|---------|
| `auth.service.js` | Password hashing (PBKDF2-SHA512), user CRUD, Google OAuth find-or-create |
| `transaction.service.js` | Debt repayment splitting (principal + interest calculation) |
| `plaid.service.js` | Pre-configured Plaid client instance |

## Lib

- `constants.js` -- Category types: Income, Essentials, Lifestyle, Growth, Ventures, Investments, Asset, Debt, Transfers
- `defaultCategories.js` -- ~70 pre-seeded categories for new tenants (with type, group, icon, processingHint)

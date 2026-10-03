# Bliss API (Next.js)

This is the public-facing API layer. It handles authentication, REST endpoints, Prisma ORM access, and event dispatch to the backend service. Built with Next.js 15 Pages Router.

## Module system: ESM

All files use `import` / `export`. Never use `require()` in this app.

## Directory structure

```
apps/api/
  pages/api/            # File-based API routes (the core of this app)
    auth/               # signin, signup, signup-mode (public invite-only flag, #99), signout, session, change-password, google-token, [...nextauth]
    integrations/       # index, [id], [id]/keys (index, [keyId]) — admin-only integration token management (#84)
    transactions/       # CRUD (index), export, merchant-history
    imports/            # upload, detect-adapter, adapters, adapters/[id], pending, similar, [id], [id]/rows/[rowId], [id]/seeds, [id]/confirm-seeds
    portfolio/          # items, holdings, history, equity-analysis, passive-income, items/[assetId]/manual-values, manual-values/[valueId], items/[assetId]/debt-terms, items/[assetId]/income-terms, income-terms/detached, income-terms/[id], income-terms/[id]/attach
    passive-income/     # streams (index, [id]) — Allowance / Government Welfare income streams
    plaid/              # create-link-token, exchange-public-token, accounts, sync-accounts, sync-logs, fetch-historical, resync, disconnect, rotate-token, items, items/hard-delete, webhook, transactions/ (index, [id], bulk-promote, bulk-requeue, seeds, confirm-seeds)
    notifications/      # summary
    onboarding/         # progress
    admin/              # default-categories (index, [code], [code]/regenerate-embeddings), invites (sign-up allowlist, ADMIN_API_KEY, #99)
    tenants.js          # Tenant management
    tenants/            # settings
    ticker/             # search
    analytics.js        # Financial metrics
    analytics/tags.js   # Tag analytics
    accounts.js         # Account CRUD
    categories.js       # Category CRUD + merge
    tags.js             # Tag management
    insights.js         # AI insights
    users.js            # User profile
    banks.js            # Bank listing + idempotent create/link (201 new link, 200 already linked)
    countries.js        # Supported countries
    currencies.js       # Supported currencies
    currency-rates.js   # Exchange rates
    mcp.js              # MCP server for AI agents (#89) — POST only, integration keys only; 401s carry the OAuth challenge
    oauth/              # OAuth 2.1 for MCP connectors (#89): protected-resource, metadata, register, authorize, token, revoke, requests/[id] (index, approve, deny)
  utils/                # Shared utilities
  middleware.js         # Next.js middleware: refuses integration tokens on denylisted routes (Edge, pure)
  services/             # Business logic (auth, transactions, plaid, valuation)
  lib/                  # Constants, default categories
    mcp/                # MCP server (#89): server, loopback, errors, shape, registry, exclusions, tools/*
    oauthHttp.js        # OAuth route helpers: public CORS, limiter, error, form body
    oauthRewrites.js    # /.well-known/* → /api/oauth/* rewrites (next.config.mjs + test harness)
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
- **Integration tokens (#84):** `Authorization: Bearer bliss_<prefix>_<secret>` is checked first in `withAuth` (cookie ignored). It hydrates `req.user` as the creating admin with a capped role (`READ_ONLY` → `viewer`, `READ_WRITE` → `member`, never `admin`) plus `authType: 'integration'`, `integrationId`, `apiKeyId`, and logs one `integration_request` line per request. Only a SHA-256 hash + public prefix is stored (`ApiKey`). See `docs/specs/api/23-integrations-api.md`.
- **Every new route must be classified in `__tests__/unit/middleware/integrationRouteMatrix.data.ts`** (`integrationRouteMatrix.test.ts` fails otherwise). If a token must not reach it, add it to `INTEGRATION_DENYLIST` in `utils/integrationPolicy.js`. Never re-read the caller's own `User` row (and its `role`) by `req.user.id` in a token-reachable route — that would undo the role cap.
- **MCP (#89):** `POST /api/mcp` accepts integration keys only (read-only keys may POST there: exact-path allowance in `integrationPolicy.js`). **A token-reachable route must also be wrapped by an MCP tool or listed in `lib/mcp/exclusions.js`** — `__tests__/unit/mcp/coverage.test.ts` fails otherwise. Tools call REST over loopback; never put Prisma access or business logic in `lib/mcp`. Regenerate `docs/guides/mcp-tool-reference.md` with `pnpm mcp:reference` after changing a tool. See `docs/specs/api/24-mcp-server.md`.
- **OAuth (#89):** custom connectors get an integration key through the OAuth 2.1 flow in `services/oauth.service.js` / `utils/oauth.js` (see `docs/specs/api/25-oauth.md`). `/api/oauth` is on the denylist — never let an integration key reach it. OAuth secrets (codes, `bliss_rt_…` refresh tokens) are stored as SHA-256 only and redacted in logs/Sentry.

## Key utilities

| File | Purpose |
|------|---------|
| `withAuth.js` | Integration-token path (role cap + denylist + attribution log), then JWT validation, Redis denylist check; hydrates `req.user` |
| `apiKeys.js` | Integration tokens: generate, SHA-256 hash, parse, `verifyApiKey`, throttled `touchLastUsed` |
| `integrationPolicy.js` | Pure (Edge-safe) token policy: path normalisation, `INTEGRATION_DENYLIST`, `INTEGRATION_WRITE_ALLOWED` (exact `POST /api/accounts` + `POST /api/banks`, #98), `VIEWER_POST_ALLOWED` (`/api/mcp`), `effectiveRole`, token extraction/redaction |
| `cors.js` | Dynamic origin whitelist from `FRONTEND_URL`, auto-adds localhost in dev |
| `cookieUtils.js` | HttpOnly, Secure, SameSite cookie config |
| `rateLimit.js` | Per-route rate limiters (incl. `integrations`, `oauth`, `oauthRegister`) |
| `oauth.js` | OAuth config + pure helpers: issuer, MCP challenge, redirect-URI allowlist, PKCE, scopes, secret generation |
| `denylist.js` | Redis-backed JWT revocation, fail-open if Redis unavailable |
| `produceEvent.js` | Dispatch events to backend via `POST BACKEND_URL/api/events` with `INTERNAL_API_KEY` |
| `currencyConversion.js` | Cross-currency conversion with 7-day forward-fill lookback |
| `tagUtils.js` | Find-or-create tags with P2002 race condition handling |
| `transactionHash.js` | SHA-256 dedup hash: `(date + description + amount + accountId)` |
| `descriptionHash.js` | SHA-256 hash for description-based cache lookups |
| `encryption.js` | Encryption field configuration and helpers |
| `validateEnv.js` | Startup validation of required env vars (warns on an unknown `SIGNUP_MODE`) |
| `signupMode.js` | `getSignupMode()` / `isInviteOnly()` — the only reader of `SIGNUP_MODE`, per request, fails closed (#99) |

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

**Integration tests** use `createIsolatedTenant()` from `__tests__/helpers/tenant.ts` which creates a Tenant + User + signed JWT. Always call `teardownTenant()` in afterAll. For integration-token requests use `createIntegrationKey()` / `createTenantUser()` / `bearer()` from `__tests__/helpers/integration.ts` (no extra teardown — deleting users cascades to integrations and keys), and set `req.url` (the denylist fails closed without it). MCP suites use `startLoopbackServer()` / `connectMcp()` / `callTool()` from `__tests__/helpers/mcpServer.ts`: a real HTTP server serving every Pages Router handler, so tool loopback calls hit the real routes.

**Test setup** (`__tests__/setup/env.ts`): Loads `.env.test` first, then root `.env`. Forces test values for encryption and JWT secrets. This runs before any module imports.

**Mocking:** Rate limiter is mocked in integration tests. Prisma hits a real `bliss_test` database. External APIs (Plaid, Gemini) are mocked.

## Services

| Service | Purpose |
|---------|---------|
| `auth.service.js` | User CRUD, Google OAuth find-or-create, and `verifyAndUpgrade` (verify + rehash-on-login) |
| `password.js` | Password hashing. scrypt `N=2^17,r=8,p=1`, PHC-style string in `passwordHash`, `passwordSalt` null. Verifies legacy PBKDF2-1,000 rows too and upgrades them on login |
| `transaction.service.js` | Debt repayment splitting (principal + interest calculation) |
| `plaid.service.js` | Pre-configured Plaid client instance |
| `valuation.service.js` | Asset valuation logic |
| `passiveIncome.service.js` | Passive income `loadInputs()` (Prisma + FX) and response assembly around `project()` from `@bliss/shared/portfolio` |
| `incomeTerms.service.js` | IncomeTerms body validation/whitelisting, serialization, stream-category eligibility |
| `integrations.service.js` | Integrations & API keys (#84): body validation, key creation payload (`buildApiKey`), serialization that never exposes `keyHash` (adds `oauth` for OAuth connections) |
| `signupInvite.service.js` | Invite-only sign-up (#99): `hasUnusedInvite`, `consumeInviteInTx` (atomic, single-use), admin CRUD; normalizes every email, never logs one |
| `oauth.service.js` | OAuth 2.1 for MCP connectors (#89): client registration, authorization requests, consent approve/deny, code exchange, refresh rotation + reuse detection, revocation |

## Lib

- `mcp/` -- MCP server (#89): `server.js` (stateless SDK wiring), `loopback.js`, `errors.js`, `shape.js`, `define.js`, `registry.js` (40 tools, role filter), `exclusions.js`, `reference.js`, `tools/*.js`
- `constants.js` -- Category types: Income, Essentials, Lifestyle, Growth, Ventures, Investments, Asset, Debt, Transfers
- `defaultCategories.js` -- ~70 pre-seeded categories for new tenants (with type, group, icon, processingHint)

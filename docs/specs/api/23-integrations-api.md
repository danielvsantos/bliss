# 23. Integrations & API Tokens (API)

Tenant-scoped, revocable credentials for non-human clients — AI agents, scripts,
other systems (#84). A tenant admin creates an **Integration** with an access
level and one or more **API keys**; clients send
`Authorization: Bearer bliss_<prefix>_<secret>`.

All enforcement lives in `utils/withAuth.js` (plus the pure policy module and a
root Next.js middleware). **No route handler knows about tokens**: a valid key
becomes an ordinary `req.user` whose role is capped, so every existing viewer
rule and admin check applies to it unchanged.

Guide: [`docs/guides/connecting-ai-agents.md`](../../guides/connecting-ai-agents.md).
OpenAPI: [`docs/openapi/integrations.yaml`](../../openapi/integrations.yaml).
Frontend: [`docs/specs/frontend/23-integrations.md`](../frontend/23-integrations.md).

---

## 23.1. Data model

Hand-written migration `prisma/migrations/20261001120000_add_integrations_api_keys`
(applied with `migrate deploy`; touches no pgvector state).

```prisma
enum IntegrationAccessLevel { READ_ONLY READ_WRITE }

model Integration {
  id              String   @id @default(cuid())
  tenantId        String                   // → Tenant, onDelete: Cascade
  name            String                   // 1–80 chars
  description     String?                  // ≤ 280 chars
  accessLevel     IntegrationAccessLevel   // fixed at creation
  createdByUserId String                   // → User, onDelete: Cascade
  createdAt, updatedAt
  revokedAt       DateTime?
  apiKeys         ApiKey[]
}

model ApiKey {
  id            String   @id @default(cuid())
  tenantId      String                     // denormalised; → Tenant, Cascade
  integrationId String                     // → Integration, Cascade
  name          String                     // default "Default key"
  prefix        String   @unique           // 8 base62 chars, public
  keyHash       String   @unique           // sha256(token), hex
  expiresAt     DateTime?                  // null = never
  lastUsedAt    DateTime?
  lastUsedIp    String?
  createdAt     DateTime @default(now())
  revokedAt     DateTime?
}
```

Cascades: tenant deleted → integrations + keys deleted; creating user deleted →
their integrations + keys deleted (their tokens return `401 TOKEN_INVALID` on
the next request). `teardownTenant()` in the test helpers keeps working
unchanged because it deletes users first.

## 23.2. Token format and storage (`utils/apiKeys.js`)

- `bliss_<prefix>_<secret>`: `prefix` = 8 base62 chars, `secret` = 43 base62
  chars (≥ 256 bits), both from `crypto.randomBytes` with rejection sampling
  (no modulo bias). The recognisable `bliss_` prefix enables secret scanning.
- Only `sha256(fullToken)` (hex) and the prefix are stored. The plaintext is
  returned once, in the create response. A plain hash is deliberate: 256-bit
  random tokens gain nothing from a slow KDF or a pepper, and binding them to
  `ENCRYPTION_SECRET` would break every token on key rotation.
- **Verification** (`verifyApiKey`): strict regex parse (malformed →
  `TOKEN_INVALID`, no DB hit) → `apiKey.findUnique({ prefix })` →
  `timingSafeCompare(sha256(token), keyHash)` → revoked key or integration →
  `TOKEN_REVOKED` → `expiresAt <= now` → `TOKEN_EXPIRED` → creating user loaded
  with a separate query (so the Prisma extension decrypts `email`) → any
  tenant mismatch → `TOKEN_INVALID`.
- **`lastUsedAt` / `lastUsedIp`** (`touchLastUsed`): fire-and-forget, at most
  once per key per minute. A per-instance memo skips the write; a conditional
  `updateMany(… lastUsedAt < now − 60 s)` keeps it at ≤ 1/min across Vercel
  instances without Redis. Errors are logged (redacted) and never fail the
  request.

## 23.3. Authentication path (`utils/withAuth.js`)

The token branch runs right after `cors()`, **before** any cookie or JWT logic:

```
extractIntegrationToken(Authorization)   // /^bearer\s+(bliss_.*)$/i
  ├─ verifyApiKey → 401 { error, code: TOKEN_INVALID | TOKEN_EXPIRED | TOKEN_REVOKED }
  │                 (optional mode: req.user = null, like the JWT path)
  ├─ isDeniedForIntegration(req.url, method) → 403 NOT_AVAILABLE_TO_INTEGRATIONS
  ├─ role = effectiveRole(creator.role, accessLevel)
  ├─ role === 'viewer' && method !== 'GET'
  │     && !isViewerPostAllowed(url, method)  → 403 READ_ONLY_INTEGRATION
  │     (exact-path exception: POST /api/mcp, #89)
  ├─ requireRole && role !== requireRole → 403 "Insufficient permissions"
  ├─ touchLastUsed(key, ip)
  └─ req.user = { id: creator.id, tenantId, email: creator.email, role,
                  authType: 'integration', integrationId, apiKeyId }
```

- When a `bliss_` bearer token is present the **cookie is ignored** (no mixed
  identity). The JWT/cookie branch is otherwise unchanged.
- `effectiveRole`: `READ_ONLY` → `viewer`; `READ_WRITE` → `member`, or
  `viewer` if the creator has since been demoted to viewer. **Never `admin`**,
  so every `requireRole: 'admin'` and inline `role !== 'admin'` check refuses
  tokens (maintenance rebuilds, fundamentals refresh, tenant settings, users).
- **Acting identity.** `req.user.id` is the creating admin, so routes that
  write `user.id` / `user.email` (`imports/upload.js`, `notifications/summary.js`,
  transaction `userId`) keep working. This is safe only while routes read the
  role from `req.user` — no reachable route re-reads the caller's own `User`
  row; the route-matrix test enforces this statically.
- Tenant isolation is inherited: every query already filters on
  `req.user.tenantId`.

### Attribution log

One line per token request, emitted on the response `finish` event (or after
the handler when the response object has no events, as in tests):

```json
{"event":"integration_request","tenantId":"…","integrationId":"…","apiKeyId":"…","method":"POST","route":"/api/transactions","status":201}
```

IDs only — never the token, its hash, the query string or the body. Denied
requests (403) are logged too. REST calls made by an MCP tool (#89) carry an
`x-bliss-mcp-tool` header; a well-formed value (`^[a-z_]{1,64}$`) is added as
`"mcpTool":"update_transaction"`, anything else is dropped. Error messages logged on the token path go
through `redactIntegrationTokens()`.

### Sentry

`@bliss/shared/sentry` `scrubEvent` already drops `authorization` headers. It
now also redacts `bliss_<8>_<8+>` patterns inside free text: `message`,
`logentry`, `exception.values[].value`, breadcrumbs, `extra`, `contexts`,
`tags` and the request URL.

## 23.4. Central denylist (`utils/integrationPolicy.js`)

Pure module (no Node or Prisma imports), shared by `withAuth` (Node) and the
root `middleware.js` (Edge). Paths are normalised first — query/fragment
stripped, percent-decoded, lowercased, duplicate/trailing slashes removed,
`.`/`..` resolved — and matched on **whole segments** (`/api/users` does not
match `/api/usersettings`). A token request whose path is unknown is refused
(fail closed).

| Prefix | Methods denied | Why |
|---|---|---|
| `/api/auth` | all | Sessions, sign-in, password change |
| `/api/users` | all | A member can edit their own profile; a token must not edit the creator's |
| `/api/integrations` | all | Tokens can't manage tokens |
| `/api/oauth` | all | A key must never mint or approve another token (#89 OAuth, [25-oauth.md](./25-oauth.md)) |
| `/api/plaid/create-link-token`, `exchange-public-token`, `disconnect`, `rotate-token`, `items/hard-delete`, `resync`, `sync-accounts`, `fetch-historical` | all | Plaid connection lifecycle |
| `/api/plaid/items` | non-GET | `PATCH` resets connection status after re-auth (lifecycle) |
| `/api/accounts` | non-GET | No account writes for tokens |
| `/api/categories` | non-GET | No category writes for tokens |
| `/api/tenants` | non-GET | No tenant writes for tokens |

The Plaid **review queue** (`/api/plaid/transactions/*`: promote, bulk-promote,
bulk-requeue, retry, confirm-seeds) stays available to read-write tokens.

### Root `middleware.js`

Matcher `/api/:path*`. For requests carrying a `bliss_` bearer token it applies
`isDeniedForIntegration(nextUrl.pathname, method)` and answers
`403 NOT_AVAILABLE_TO_INTEGRATIONS` — this is what covers the routes that don't
use `withAuth` (`auth/signin`, `signup`, `signout`, `google-token`,
`[...nextauth]`, `plaid/items/hard-delete`). No DB access, no token validation;
requests without a `bliss_` token pass straight through. The remaining
non-`withAuth` routes answer tokens with their own 401 (`ADMIN_API_KEY` routes,
the Plaid-signed webhook) or are public (`countries`, `currencies`).

### Route matrix (keeping the denylist complete)

`__tests__/unit/middleware/integrationRouteMatrix.data.ts` lists every file
under `pages/api` with the expected outcome per method for READ_ONLY and
READ_WRITE tokens (`A` allow, `R` read-only 403, `X` admin 403, `D` denylist
403, `U` own credential, `P` public). It fails when:

- a route file is not classified (**every new route must be added**), or an entry has no file;
- a file's `withAuth` / `requireRole: 'admin'` / inline admin check / admin-key wiring no longer matches its entry;
- a token-reachable route re-reads the caller's `User` row by `req.user.id`;
- the real `withAuth` (or `middleware.js` for non-`withAuth` routes) produces a different outcome than declared.

The assertions live in `integrationRouteMatrix.test.ts`. The same table drives
the MCP coverage test (#89, [24-mcp-server.md](./24-mcp-server.md#249-coverage)):
a token-reachable route must also be wrapped by an MCP tool or listed in
`lib/mcp/exclusions.js`.

### MCP server (#89)

Integration keys are also the only credential of the MCP endpoint
`POST /api/mcp`, which exposes 39 tools over these same REST routes (every tool
call goes through this authentication path again). See
[24-mcp-server.md](./24-mcp-server.md).

### OAuth connections (#89)

Approving an OAuth consent ([25-oauth.md](./25-oauth.md)) creates an ordinary
Integration with `oauthClientId` and `connectionExpiresAt` set and a single
`ApiKey` ("OAuth access token") that the OAuth server re-keys on every refresh.
`GET /api/integrations` adds `oauth: { clientName, connectionExpiresAt }` for
these rows (`null` otherwise). Revoking the integration ends the connection:
its refresh tokens stop working on the next refresh.

## 23.5. Management endpoints

All `withAuth(…, { requireRole: 'admin' })` with the `integrations` rate limiter
(30 / 5 min). Integration tokens are refused by the denylist. Every lookup is
`findFirst({ id, tenantId: req.user.tenantId })`, so another tenant's ID → 404.
Responses never contain `keyHash`; `token` appears only in the two create
responses.

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/integrations` | — | `200 { integrations: Integration[] }` (newest first, with `keys`, `keyCount`, `activeKeyCount`, `lastUsedAt`, `status`) | 403 |
| `POST /api/integrations` | `{ name, description?, accessLevel, key: { name?, expiresInDays: 30\|90\|365\|null } }` | `201 { integration, apiKey, token }` (integration + first key in one nested create) | 400, 403 |
| `PATCH /api/integrations/:id` | `{ name?, description? }` | `200 { integration }` | 400 (`ACCESS_LEVEL_IMMUTABLE` if `accessLevel` is sent), 403, 404 |
| `DELETE /api/integrations/:id` | — | `200 { integration }` — stamps `revokedAt` on the integration and every key; idempotent | 403, 404 |
| `POST /api/integrations/:id/keys` | `{ name?, expiresInDays }` | `201 { apiKey, token }` | 400, 403, 404, 409 `INTEGRATION_REVOKED`, 409 `OAUTH_MANAGED` (OAuth connection) |
| `DELETE /api/integrations/:id/keys/:keyId` | — | `200 { apiKey }` — idempotent; other keys unaffected | 403, 404 |

Key `status` is derived: `revoked` (wins) → `expired` → `active`.

## 23.6. Error codes

| Status | `code` | When |
|---|---|---|
| 401 | `TOKEN_INVALID` | Malformed, unknown prefix, wrong secret, creator deleted, tenant mismatch |
| 401 | `TOKEN_EXPIRED` | `expiresAt` has passed |
| 401 | `TOKEN_REVOKED` | Key or integration revoked |
| 403 | `NOT_AVAILABLE_TO_INTEGRATIONS` | Denylisted route (withAuth or middleware) |
| 403 | `READ_ONLY_INTEGRATION` | Non-GET with a read-only token |
| 403 | — (`Insufficient permissions` / route's own message) | Admin-only route |
| 400 | `ACCESS_LEVEL_IMMUTABLE` | PATCH tried to change the access level |
| 409 | `INTEGRATION_REVOKED` | Adding a key to a revoked integration |
| 409 | `OAUTH_MANAGED` | Adding a key to an OAuth connection (its key is managed by the OAuth server) |

## 23.7. Rate limiting and deployment

- Rate limiters run inside each handler, so token requests go through the same
  IP-keyed `express-rate-limit` limiters as session requests (no bypass). On
  Vercel they are per instance (accepted).
- No new environment variables. The token path never calls the backend, so the
  split Vercel (API) + Railway (backend) deployment needs nothing extra.
- Token auth adds two indexed lookups (`ApiKey` by unique prefix, `User` by id)
  — the same cost as the JWT path's user hydration.

## 23.8. Tests

| File | Covers |
|---|---|
| `unit/utils/apiKeys.test.ts` | Format/entropy, hashing, parsing, verify outcomes, lastUsed throttle |
| `unit/utils/integrationPolicy.test.ts` | Path normalisation, every denylist entry, segment matching, role cap, redaction |
| `unit/middleware/withAuth.test.ts` (token block) | req.user shape, cookie ignored, 401/403 codes, optional mode, attribution log, no token in logs |
| `unit/middleware/nextMiddleware.test.ts` | Root middleware deny/pass-through |
| `unit/middleware/integrationRouteMatrix.test.ts` | Route enumeration (AC9) |
| `unit/utils/sentryScrub.test.ts` | Token redaction in Sentry events |
| `integration/api/integrations/management.test.ts` | Management endpoints, hash-only storage, member/viewer 403 |
| `integration/api/integrations/token-auth.test.ts` | End-to-end reads/writes, tenant isolation, revocation/expiry/cascade, multi-key, rate limiter |

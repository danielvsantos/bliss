# 27. Enable Banking API

Routes that connect EU bank accounts through Enable Banking (PSD2 AIS, #132), map them to Bliss accounts and trigger syncs. Sync itself runs in the backend — see [backend spec](../backend/24-enable-banking.md). OpenAPI: [`enablebanking.yaml`](../../openapi/enablebanking.yaml).

All routes live in `apps/api/pages/api/enablebanking/`, use `withAuth` and the `enableBanking` rate limiter (60 / 5 min), and scope every query by `req.user.tenantId`. The whole `/api/enablebanking` prefix is on `INTEGRATION_DENYLIST`: integration tokens get `403 NOT_AVAILABLE_TO_INTEGRATIONS`, so no MCP tool wraps these routes (the MCP coverage test counts only token-reachable operations, so no exclusion entry is needed).

**Per-tenant credentials (#148).** Every Enable Banking call is signed with the **tenant's own** application, resolved per request by `getTenantEnableBanking(tenantId)` (`utils/enableBanking.js`): one indexed read of `EnableBankingCredential`, then a client from an in-process LRU (200) keyed `tenantId:credentialId:version`, so a replace or removal takes effect on the next request on every instance. When the tenant has no credentials, every route except `status` and `GET connections/:id` answers `404 { code: 'NOT_ENABLED' }`; the callback redirects with `eb_error=not_enabled`. The retired `ENABLE_BANKING_APP_ID` / `ENABLE_BANKING_PRIVATE_KEY(_PATH)` are never read (a boot warning names them while set).

## Routes

| Route | Roles | Contract |
|---|---|---|
| `GET /api/enablebanking/status` | all | `{ enabled, configurable, pausedConnections }`. `enabled` = the tenant has credentials (any status); the web app hides every Enable Banking entry point when `false`. `configurable` = the caller is an admin. `pausedConnections` = non-revoked connections while there are no credentials, else 0. |
| `GET /api/enablebanking/aspsps` | admin, member | Calls `GET /aspsps?country=` for each tenant country with an ISO-2 code → `{ aspsps: [{ name, country, logo, maximumConsentValiditySec }], startDate }`. `startDate` = today (UTC) − `plaidHistoryDays`, the first sync's `date_from`. |
| `POST /api/enablebanking/connect` | admin, member | Body `{ aspspName, aspspCountry }` or `{ reconnectItemId }` → `{ url, startDate }`. The bank must be in a tenant country (`400 COUNTRY_NOT_ENABLED`) and known to Enable Banking (`400 UNKNOWN_ASPSP`). A reconnect must target an Enable Banking connection of the tenant **authorised by the caller** (`403 NOT_AUTHORISING_USER`); its bank comes from the connection and `startDate` = max(cutoff, lastSync − 7 d). Calls `POST /auth` with `access.valid_until = now + maximum_consent_validity − 1 day` (90 days when the bank reports none), `psu_type: 'personal'`, the callback URL and a signed state. `503` when Redis is unavailable (the state could not be single use). |
| `GET /api/enablebanking/callback` | none — state-authenticated | See below. Always a `302` into the web app. |
| `GET /api/enablebanking/connections/:id` | admin, member | Works without credentials; `connection.paused` is true when the tenant has none and the connection is not revoked. The connection, `startDate`, its bank accounts (`id, name, ibanLast4, currency, accountId, suggestedAccountId, conflict, lastBalance, lastBalanceCurrency, lastBalanceAt`) and the tenant's Bliss accounts (`id, name, currencyCode, last4, linkedProvider, linkedToThisConnection`). Account numbers are never returned. |
| `POST /api/enablebanking/connections/:id/map` | admin, member | See below. |
| `POST /api/enablebanking/connections/:id/sync` | admin, member | `202` + `ENABLE_BANKING_SYNC { source: 'MANUAL_RESYNC' }`; `429 { code: 'SYNC_BUDGET_EXHAUSTED', resetsAt }` when every mapped account has spent today's budget (read-only check; the worker's counter decides); `400 CONNECTION_NOT_ACTIVE` / `NO_MAPPED_ACCOUNTS`. |
| `DELETE /api/enablebanking/connections/:id` | admin, or the authorising user | `DELETE /sessions/{id}` (best effort), status → `REVOKED`, `204`. Accounts, mappings and ingested data are kept (as with a Plaid "Pause Sync"), so a reconnect re-attaches without a mapping step. `409` when already disconnected. |

## Credentials (#148)

Tenant admins only (`withAuth(..., { requireRole: 'admin' })`; members and viewers `403`), `enableBankingCredentials` rate limiter (20 / 5 min), body limit 32 KB. Logic in `services/enableBankingCredentials.service.js`. Errors go to Sentry without the request (its body carries the key).

| Route | Contract |
|---|---|
| `GET /api/enablebanking/credentials` | `{ configured, callbackUrl, credential, usage, history }`. `credential` = `{ appId, keyFingerprint, keyBits, status, lastValidatedAt, callbackRegistered, updatedAt }` or `null`. `usage` = `{ activeConnections, pausedConnections, linkedAccounts, limit: 5 }`. `history` = the 10 most recent events, newest first: `{ action, appId, keyFingerprint, user: { id, name } \| null, createdAt }`. **No response ever contains the private key**: reads use a field whitelist that never selects it. |
| `PUT /api/enablebanking/credentials` | Body `{ appId (UUID), privateKey (PEM ≤ 16 KB), confirmAppChange? }` → `201` (first Set) / `200` with the GET payload. Steps below. |
| `DELETE /api/enablebanking/credentials?confirm=true` | Without `confirm` and with non-revoked connections → `409 CONFIRMATION_REQUIRED { affectedConnections }`. Otherwise one transaction deletes the credential and writes a `REMOVED` event (app id, hash and fingerprint copied) → `204`. Connections become paused with no write to them. `404 NOT_CONFIGURED` when there is nothing to remove. |
| `POST /api/enablebanking/credentials/verify` | Re-runs the probe with the stored credentials: `VERIFIED` (clears `invalidatedAt`), `INVALID` (+ `invalidatedAt`), or `UNVERIFIED` when Enable Banking is unreachable. Conditional on `version`. No history entry. → the GET payload. |

PUT, in order:

1. `appId` must be a UUID (`400 INVALID_APP_ID`).
2. `parsePrivateKey()` (`@bliss/shared/enablebanking`) normalises CRLF / CR, literal `\n` escapes and surrounding whitespace, accepts PKCS#8 and PKCS#1, requires RSA ≥ 2048 bits and re-exports PKCS#8 (the stored form). Format errors → `400` with `KEY_NOT_PEM`, `KEY_PUBLIC`, `KEY_CERTIFICATE`, `KEY_NOT_RSA`, `KEY_ENCRYPTED`, `KEY_TRUNCATED`, `KEY_TOO_LARGE` or `KEY_TOO_SMALL`. The fingerprint is `SHA256:` + the first 16 base64 chars of sha256(SPKI DER of the derived public key).
3. **App change (D3).** The previous app is the stored credential's `appIdHash`, else the latest `REMOVED` event's, else none (first-ever Set). When it differs from the new one and ACTIVE / ERROR connections exist without `confirmAppChange` → `409 CONFIRMATION_REQUIRED { affectedConnections }`.
4. **Probe** `GET /application` (10 s timeout, a fresh uncached client): `401/403/404` → `422 INVALID_CREDENTIALS`; an app whose `environment` reads sandbox → `422 SANDBOX_APP` (nothing stored in either case); network error, timeout, `429` or `5xx` → stored as `UNVERIFIED`. `redirect_urls`, when present, sets `callbackRegistered`. Field names are read defensively: an absent field is unknown (`null`), never a failure.
5. One `$transaction`: upsert the credential (`version + 1` on update); write `SET` (no stored credential), `REPLACED` (different app) or `KEY_ROTATED` (same app, new fingerprint) — a re-save of the same app and key writes no event; on an app change, `updateMany` the tenant's ACTIVE / ERROR Enable Banking items to `LOGIN_REQUIRED` / `errorCode: 'APP_CHANGED'`. A reconnect then re-keys the same `PlaidItem` and re-links accounts by `identificationHash` (the existing reconnect path).

A first-ever Set (the upgrade from the retired env vars) assumes the existing connections belong to the new app and resumes them. If they don't, the first sync's session errors move them to `LOGIN_REQUIRED` through the normal failure matrix.

## Signed state (decision D6)

The callback is a top-level navigation from the bank, so the API cookie may not arrive (and correctness must not depend on it). The `state` is the authority:

- `base64url(JSON { t: tenantId, u: userId, r?: reconnectItemId, n: nonce, exp })` + `.` + `HMAC-SHA256` under a key HKDF-derived from `NEXTAUTH_SECRET` with the label `enablebanking-state`.
- Valid for 15 minutes. The nonce is stored with `SET NX EX 900` at connect time and consumed with `GETDEL` in the callback: single use (replay protection).
- When a session cookie does arrive, its user must equal `state.u`.

## Callback

`GET /api/enablebanking/callback?code=…&state=…` (or `?error=…&state=…`):

1. Missing, malformed, tampered, expired or replayed state, a different signed-in user, or an unknown user → `/accounts?eb_error=invalid_state`. Nothing is exchanged or stored.
2. `error` (or no `code`) → `/accounts?eb_error=denied`.
3. `POST /sessions { code }`; a failure → `/accounts?eb_error=exchange_failed`. Account details are returned only here, so they are persisted now (R4).
4. One `$transaction`: create the `PlaidItem` (`status: 'PENDING_SELECTION'`, `userId` = the authorising user) — or, for a reconnect, update the same row (`accessToken`, `consentExpiration`, `status: 'ACTIVE'`) — and upsert one `EnableBankingAccount` per account by `(plaidItemId, identificationHash)` (new `uid`, IBAN encrypted, `ibanLast4`). For a reconnect, mapped accounts are re-linked to the same Bliss account unless it was linked elsewhere meanwhile.
5. Every returned account already mapped → `ENABLE_BANKING_SYNC { source: 'RECONNECT_SYNC' }` and `/accounts?eb=reconnected&connection=<id>`; otherwise `/accounts?eb=map&connection=<id>`.

The code is exchanged with the credentials of the tenant in the signed state (one callback URL for every tenant). A tenant without credentials at callback time → `/accounts?eb_error=not_enabled`.

The callback never relies on the API root (which bounces to `/auth/login`). The redirect URL is `ENABLE_BANKING_REDIRECT_URL`, or `<NEXTAUTH_URL origin>/api/enablebanking/callback`, and must be registered on the Enable Banking app exactly.

## Mapping (R5, R5a, R6)

`POST /api/enablebanking/connections/:id/map`

```json
{
  "mappings": [
    { "ebAccountId": "…", "accountId": 3603 },
    { "ebAccountId": "…", "create": { "name": "Revolut", "bankId": 1, "countryId": "ESP", "currencyCode": "EUR" } },
    { "ebAccountId": "…", "skip": true }
  ],
  "confirmProviderSwitch": true
}
```

- Each mapping has exactly one of `accountId`, `create`, `skip`. An `Account` is created only for `create` — never implicitly.
- **R6 joint guard:** a bank account already mapped through another non-revoked connection → `409 ACCOUNT_ALREADY_CONNECTED` (also enforced by the partial unique index; a lost race maps P2002 to the same error). Mappings held by a revoked connection are released.
- **R5a provider switch:** a target already synced by another connection (usually Plaid) → `409 PROVIDER_SWITCH_REQUIRED { accounts: [{ id, name, provider, institutionName }] }` unless `confirmProviderSwitch`. On confirm the **same `Account` rows** are re-pointed (`plaidAccountId = eb:<hash>`, `plaidItemId` = this connection): ids, transactions, analytics and portfolio items are unchanged. A previous connection left with no linked account is set to `REVOKED` (history kept); `plaidSyncWorker` also drops rows for unlinked Plaid accounts.
- `400 DUPLICATE_TARGET` when two bank accounts point at the same Bliss account.
- Success → `200 { mapped, created, skipped, switched, active }`; the connection becomes `ACTIVE` and `ENABLE_BANKING_SYNC { source: 'INITIAL' }` is enqueued.

## Changes to existing routes

- `GET /api/plaid/items` adds `provider`, `aspspCountry` and `userId` per item, and `paused` on Enable Banking items (#148: no tenant credentials and not revoked).
- `POST /api/plaid/{resync,rotate-token,fetch-historical,sync-accounts,disconnect}` and `PATCH /api/plaid/items` answer `400 { code: 'WRONG_PROVIDER' }` for Enable Banking items, so an Enable Banking session id is never sent to Plaid. `exchange-public-token` and `webhook` look items up by Plaid's `item_id` and cannot reach `eb_` items; `items/hard-delete` stays provider-agnostic.
- `PUT /api/plaid/transactions/:id`, `bulk-promote` and `confirm-seeds` promote with the provider-aware label (`bankTxLabel`): Enable Banking rows are described by their remittance text.
- `GET /api/notifications/summary`: Enable Banking items in `LOGIN_REQUIRED` / `ERROR` produce `PLAID_ACTION_REQUIRED` ("… needs to be re-connected") **only for the authorising user**; new signal `BANK_CONSENT_EXPIRING`; admin-only `ENABLE_BANKING_CREDENTIALS_INVALID` while the tenant's credential is `INVALID` (#148) — see the [notification center spec](./14-notification-center.md).

## Tests

`__tests__/integration/api/enablebanking/credentials.test.ts` (#148, real Postgres: admin-only access, integration tokens denied, every probe outcome, every key fixture, rotation, app change with confirmation, remove → paused → set again, re-verify, history cap, two tenants signing with their own apps, no key in any response, log line, Sentry call or history row), `__tests__/unit/utils/enableBanking.test.ts` (the tenant resolver, state signing, tamper / expiry / replay, consent validity, callback URL, last-4 matching, budget view), `__tests__/unit/api/notifications-summary.test.ts` (Enable Banking signals), and `__tests__/integration/api/enablebanking/flow.test.ts` (real Postgres: connect → callback → map → provider switch → R6 → sync budget → WRONG_PROVIDER guards → promotion label → reconnect → disconnect).

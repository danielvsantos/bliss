# 27. Enable Banking API

Routes that connect EU bank accounts through Enable Banking (PSD2 AIS, #132), map them to Bliss accounts and trigger syncs. Sync itself runs in the backend — see [backend spec](../backend/24-enable-banking.md). OpenAPI: [`enablebanking.yaml`](../../openapi/enablebanking.yaml).

All routes live in `apps/api/pages/api/enablebanking/`, use `withAuth` and the `enableBanking` rate limiter (60 / 5 min), and scope every query by `req.user.tenantId`. The whole `/api/enablebanking` prefix is on `INTEGRATION_DENYLIST`: integration tokens get `403 NOT_AVAILABLE_TO_INTEGRATIONS`, so no MCP tool wraps these routes. When `ENABLE_BANKING_APP_ID` or the private key is missing, every route except `status` answers `404 { code: 'NOT_ENABLED' }`.

## Routes

| Route | Roles | Contract |
|---|---|---|
| `GET /api/enablebanking/status` | all | `{ enabled }`. The web app hides every Enable Banking entry point when `false`. |
| `GET /api/enablebanking/aspsps` | admin, member | Calls `GET /aspsps?country=` for each tenant country with an ISO-2 code → `{ aspsps: [{ name, country, logo, maximumConsentValiditySec }], startDate }`. `startDate` = today (UTC) − `plaidHistoryDays`, the first sync's `date_from`. |
| `POST /api/enablebanking/connect` | admin, member | Body `{ aspspName, aspspCountry }` or `{ reconnectItemId }` → `{ url, startDate }`. The bank must be in a tenant country (`400 COUNTRY_NOT_ENABLED`) and known to Enable Banking (`400 UNKNOWN_ASPSP`). A reconnect must target an Enable Banking connection of the tenant **authorised by the caller** (`403 NOT_AUTHORISING_USER`); its bank comes from the connection and `startDate` = max(cutoff, lastSync − 7 d). Calls `POST /auth` with `access.valid_until = now + maximum_consent_validity − 1 day` (90 days when the bank reports none), `psu_type: 'personal'`, the callback URL and a signed state. `503` when Redis is unavailable (the state could not be single use). |
| `GET /api/enablebanking/callback` | none — state-authenticated | See below. Always a `302` into the web app. |
| `GET /api/enablebanking/connections/:id` | admin, member | The connection, `startDate`, its bank accounts (`id, name, ibanLast4, currency, accountId, suggestedAccountId, conflict, lastBalance, lastBalanceCurrency, lastBalanceAt`) and the tenant's Bliss accounts (`id, name, currencyCode, last4, linkedProvider, linkedToThisConnection`). Account numbers are never returned. |
| `POST /api/enablebanking/connections/:id/map` | admin, member | See below. |
| `POST /api/enablebanking/connections/:id/sync` | admin, member | `202` + `ENABLE_BANKING_SYNC { source: 'MANUAL_RESYNC' }`; `429 { code: 'SYNC_BUDGET_EXHAUSTED', resetsAt }` when every mapped account has spent today's budget (read-only check; the worker's counter decides); `400 CONNECTION_NOT_ACTIVE` / `NO_MAPPED_ACCOUNTS`. |
| `DELETE /api/enablebanking/connections/:id` | admin, or the authorising user | `DELETE /sessions/{id}` (best effort), status → `REVOKED`, `204`. Accounts, mappings and ingested data are kept (as with a Plaid "Pause Sync"), so a reconnect re-attaches without a mapping step. `409` when already disconnected. |

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

- `GET /api/plaid/items` adds `provider`, `aspspCountry` and `userId` per item.
- `POST /api/plaid/{resync,rotate-token,fetch-historical,sync-accounts,disconnect}` and `PATCH /api/plaid/items` answer `400 { code: 'WRONG_PROVIDER' }` for Enable Banking items, so an Enable Banking session id is never sent to Plaid. `exchange-public-token` and `webhook` look items up by Plaid's `item_id` and cannot reach `eb_` items; `items/hard-delete` stays provider-agnostic.
- `PUT /api/plaid/transactions/:id`, `bulk-promote` and `confirm-seeds` promote with the provider-aware label (`bankTxLabel`): Enable Banking rows are described by their remittance text.
- `GET /api/notifications/summary`: Enable Banking items in `LOGIN_REQUIRED` / `ERROR` produce `PLAID_ACTION_REQUIRED` ("… needs to be re-connected") **only for the authorising user**; new signal `BANK_CONSENT_EXPIRING` — see the [notification center spec](./14-notification-center.md).

## Tests

`__tests__/unit/utils/enableBanking.test.ts` (state signing, tamper / expiry / replay, consent validity, callback URL, last-4 matching, budget view), `__tests__/unit/api/notifications-summary.test.ts` (Enable Banking signals), and `__tests__/integration/api/enablebanking/flow.test.ts` (real Postgres: connect → callback → map → provider switch → R6 → sync budget → WRONG_PROVIDER guards → promotion label → reconnect → disconnect).

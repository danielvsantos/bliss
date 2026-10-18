# 24. Enable Banking Sync (Backend)

EU bank sync through [Enable Banking](https://enablebanking.com) (PSD2 account information), added in #132 because Plaid serves EU/UK customers only on Custom plans. It feeds the **existing** Plaid review pipeline: classification, the Quick Seed interview, hash dedupe, review, promotion, notifications and the MCP review tools work unchanged.

Related: [API spec](../api/27-enable-banking-api.md) · [frontend spec](../frontend/27-enable-banking.md) · [Plaid backend spec](./08-plaid-integration.md) · [user guide](../../guides/enable-banking.md).

---

## 24.1 Provider model (decision D1)

Enable Banking connections reuse the Plaid tables instead of parallel ones:

| Table | Enable Banking use |
|---|---|
| `PlaidItem` | One row per consent. `provider = 'ENABLE_BANKING'` (default `'PLAID'`), `itemId = 'eb_<uuid>'`, `accessToken` = the Enable Banking `session_id` (encrypted, swapped on reconnect), `consentExpiration` = `access.valid_until`, `institutionName` / `aspspCountry` = the bank, `environment = 'production'`. |
| `EnableBankingAccount` (new) | One row per bank account returned by `POST /sessions`: session-scoped `uid`, stable `identificationHash`, `iban` (encrypted), plaintext `ibanLast4`, `currency`, `name`, `authorizedByUserId`, the mapped Bliss `accountId`, and the latest balance. |
| `PlaidTransaction` | Synced rows, written with Plaid's conventions (below). |
| `PlaidSyncLog` | One row per sync run. |

`PlaidItem.status` for Enable Banking: `PENDING_SELECTION` (connected, nothing mapped yet) → `ACTIVE` → `LOGIN_REQUIRED` (consent expired or revoked) | `ERROR` | `REVOKED` (disconnected). "Expiring" is derived on read from `consentExpiration`.

The migration `20261012120000_add_enable_banking` is hand-written and additive; apply it with `prisma migrate deploy` (never `migrate dev`, see CLAUDE.md). It also creates the **R6 joint-account guard** as a partial unique index, `EnableBankingAccount_mapped_hash_uniq ON ("tenantId", "identificationHash") WHERE "accountId" IS NOT NULL`, which Prisma cannot model.

**Per-tenant credentials (#148).** `EnableBankingCredential` (1:1 with `Tenant`): `appId` and `privateKey` encrypted (Prisma extension, in `ROTATION_COVERAGE`), plaintext `appIdHash` (sha256, 32 hex — compared without decrypting), `keyFingerprint`, `keyBits`, `status` (`VERIFIED | UNVERIFIED | INVALID`), `lastValidatedAt`, `invalidatedAt`, `callbackRegistered`, `version` (bumped on every change; part of the client cache key) and `updatedByUserId`. `EnableBankingCredentialEvent` is the append-only change history (`SET | REPLACED | KEY_ROTATED | REMOVED`, encrypted `appId`, `appIdHash`, fingerprint, `userId`), never holding key material. Migration `20261020120000_enable_banking_tenant_credentials`, hand-written, `migrate deploy` only, no backfill. "Paused" is derived (no credential and not revoked), never stored, so the upgrade leaves every connection's status untouched.

Naming debt: the `Plaid*` tables now mean "bank feed". Renaming them is a later mechanical refactor.

## 24.2 Synthetic keys (decision D2)

Enable Banking account `uid`s change on every reconnect; `identification_hash` does not. Every stored key derives from it:

| Field | Value |
|---|---|
| `Account.plaidAccountId`, `PlaidTransaction.plaidAccountId` | `eb:<identification_hash>` |
| `PlaidTransaction.plaidTransactionId` (globally `@unique`, becomes `Transaction.externalId`) | `eb:<identification_hash>:<entry_reference>` |
| …fallback when `entry_reference` is missing (R10) | `eb:<identification_hash>:fp:<sha256(date\|amount\|indicator\|remittance\|counterparty)>`, logged at `warn` |

The unique key plus `createMany({ skipDuplicates: true })` is the provider-level dedupe: repeated syncs, overlapping windows, retries and reconnects never create a second review row. `skipped = fetched − inserted`.

## 24.3 Mapping (R11) — `services/enableBanking/mapper.js`

| `PlaidTransaction` field | Source |
|---|---|
| `amount` | `DBIT` → `+amount`, `CRDT` → `−amount` (Plaid convention: positive = money out) |
| `date` | `booking_date` → `value_date` → `transaction_date` |
| `name` | `remittance_information` joined with `" - "`, else the counterparty name, else `bank_transaction_code.description` |
| `merchantName` | `creditor.name` for a debit, `debtor.name` for a credit |
| `isoCurrencyCode` | `transaction_amount.currency` |
| `category` | `bank_transaction_code.code` (string hint, e.g. `CARD_PAYMENT`) |
| `pending` / `paymentChannel` | `false` / `null` |
| `rawJson` | the full transaction, AES-256-GCM encrypted |

Only `status = 'BOOK'` is ingested (R9). Pending items are counted (`pendingSeen`) but never stored, until it is confirmed that Revolut keeps `entry_reference` when a pending item books.

## 24.4 Label rule (decision D3) — `@bliss/shared/bank-tx-label`

`bankTxLabel(tx, provider)` is the string a row is hashed and promoted under:

- Plaid: `merchantName || name` (unchanged).
- Enable Banking: `name` (the joined remittance text).

It is used by `checkHashDuplicate` and auto-promotion in `plaidProcessorWorker`, and by the promote routes (`plaid/transactions/[id]`, `bulk-promote`, `confirm-seeds`). Classification input stays `name` + `merchantName`. Hashing on the counterparty name matched existing Plaid history worse in the spike; the remittance text matched every overlapping row on the migration boundary day (2026-10-10). Trade-off: promoted Enable Banking transactions show raw text ("Sq *giro Bar").

The processor also writes `{ duplicates, autoPromoted, classified }` back into the originating sync log when the job carries `syncLogId`.

**No Quick Seed hold.** The seed interview only exists in the Plaid connect modal, so Enable Banking rows are never held back for it (`seedHoldAllowed(source, provider)`): every row is classified straight into Transaction Review or auto-promoted. Rows held by a run before this rule existed are released at the start of the next processor run (`releaseSeedHolds`), and a sync that adds nothing still re-queues classification when the connection has unprocessed `PENDING` rows.

## 24.5 Date window (R8)

`@bliss/shared/enablebanking` (`syncCutoffDate`, `syncDateFrom`), shared with the API so the start date shown to the user is the one the worker uses:

- `cutoff = UTC midnight(PlaidItem.createdAt) − Tenant.plaidHistoryDays` — the same formula `plaidSyncWorker` applies to Plaid items (it now calls the shared helper).
- First sync: `date_from = cutoff`.
- Later syncs: `date_from = max(cutoff, UTC midnight(lastSync) − 7 days)` to catch late-booked items.
- Rows dated before `cutoff` are dropped. Changing `plaidHistoryDays` later never re-pulls history.

## 24.6 Unattended-access budget (R12, decision D5)

PSD2 limits unattended access (typically 4 per day per account). Redis key `ebbudget:v1:{enableBankingAccountId}:{YYYY-MM-DD in Europe/Madrid}`: the worker `INCR`s it before each account's data calls (36 h TTL). One sync run of one account counts as one access, whatever the number of pages. `ENABLE_BANKING_DAILY_BUDGET` defaults to 4. A Redis failure fails open (the bank's own 429 stays the backstop).

The default schedule is **3 runs a day** (`ENABLE_BANKING_SYNC_TIMES=06:15,13:15,20:15`, Madrid time), so a manual "Sync now" always fits. The API checks the budget read-only and answers `429 SYNC_BUDGET_EXHAUSTED` before enqueueing; the worker's `INCR` is the authority.

## 24.7 Jobs (decision D4)

Both run on the existing **`plaid-sync`** queue; `plaidSyncWorker` dispatches any job whose name starts with `ENABLE_BANKING_` to `workers/handlers/enableBankingSync.js`. No new queue or worker.

| Job | Data | Source |
|---|---|---|
| `ENABLE_BANKING_SYNC` | `{ plaidItemId, tenantId, source }` | Event `ENABLE_BANKING_SYNC` (first sync after mapping, reconnect, "Sync now"), or the fan-out. Options: `deduplication: { id: 'eb-sync:<itemId>' }`, `attempts: 3`, exponential 30 s backoff (`enableBankingSyncOpts`). |
| `ENABLE_BANKING_SYNC_ALL` | `{}` | One BullMQ job scheduler per `ENABLE_BANKING_SYNC_TIMES` slot (`eb-sync-all-HHMM`, tz `Europe/Madrid`), always registered at worker start (credentials are per tenant, #148); schedulers for removed slots are deleted. |

`ENABLE_BANKING_SYNC_ALL` marks ACTIVE connections whose consent has passed `LOGIN_REQUIRED` (with a FAILED sync log), then enqueues one deduplicated `ENABLE_BANKING_SYNC` per ACTIVE connection with `_trigger: 'bank_sync'`. Both steps cover only tenants whose credential exists and is not `INVALID` (`tenant: { enableBankingCredential: { is: { status: { not: 'INVALID' } } } }`): paused connections are left untouched, and invalid credentials wait for a re-verify instead of failing every slot.

A generic Plaid event (`PLAID_SYNC_UPDATES`) that reaches an Enable Banking item is routed to the Enable Banking sync, so its session id can never be sent to Plaid.

Processing status (#100): `ENABLE_BANKING_SYNC` is mapped in `config/activityMap.js` (bank sync, "Fetching from bank"); the fan-out has no `tenantId` and is not tracked. `ENABLE_BANKING_*` job names resolve to the `bank_sync` trigger.

### `syncConnection` steps

1. Load the item, its tenant's `plaidHistoryDays` and its mapped accounts (an `EnableBankingAccount` with `accountId` whose `Account.plaidItemId` is still this item). Skip non-Enable-Banking and non-ACTIVE items.
2. Resolve the tenant's client with `getTenantEnableBanking(item.tenantId)` (`services/enableBanking/client.js`: per job from the database, cached per `tenantId:credentialId:version`). **No credential → `{ skipped: 'paused' }`**: no sync log (a paused connection is not a run), no status change, no notification (#148, R6). A credential marked `INVALID` skips `SCHEDULED` runs the same way; a manual "Sync now" still runs so an admin can test.
3. Consent past `valid_until` → `LOGIN_REQUIRED`, FAILED log, return.
4. Per mapped account: budget `INCR` (over budget → `budgetExhausted`, skip); page `GET /accounts/{uid}/transactions?date_from=…` following `continuation_key` (repeated key or 500 pages stops the loop); map, filter `date >= cutoff`, `createMany skipDuplicates` per page; `GET /balances` and store the closest-to-booked balance (`CLBD` › `ITBD` › `XPCD` › `ITAV` › first) on the account row (R14).
5. Write exactly one `PlaidSyncLog { type: INITIAL_SYNC | SYNC_UPDATE, status, details: { fetched, added, skipped, pendingSeen, invalid, fingerprintKeys, dateFrom, accounts, perAccount: [{ ebAccountId, added, skipped, balance, budgetExhausted }], budgetExhausted?, error?, reason } }`. All accounts over budget → `FAILED` with `SYNC_BUDGET_EXHAUSTED`.
6. Advance `lastSync` only when every mapped account was fetched.
7. `added > 0` → `plaid-processing` `PLAID_SYNC_COMPLETE { plaidItemId, tenantId, source, syncLogId, _trigger }`.

### Failure matrix (R13)

Every run writes a sync log row — no silent loss (#51). A paused connection (no tenant credentials) is not a run: it is skipped before the run starts.

| Error | Handling |
|---|---|
| 429 | FAILED log `{ rateLimited: true }`; return without throwing (the next slot retries). No Sentry. |
| 401 / 403 without a session code, **confirmed by the probe** (#148, D5) | `isCredentialError(err)` triggers one `GET /application` with the same client. Rejected too → the app's credentials are at fault: FAILED log `{ error: 'CREDENTIALS_INVALID', httpStatus }`, `markCredentialInvalid(tenantId, version)` (conditional on `version`, so a credential replaced moments ago is never marked) sets `INVALID` + `invalidatedAt`, which raises the admin-only `ENABLE_BANKING_CREDENTIALS_INVALID` signal. The connection status is untouched; no Sentry. Other tenants in the slot are unaffected. |
| 401 / 403 (probe succeeded or unreachable), or a session error code (`EXPIRED`, `REVOKED`, `SESSION`, `CONSENT`) | Status → `LOGIN_REQUIRED` (session/consent codes) or `ERROR`; FAILED log; `Sentry.captureException` inline; return. A session code never triggers the probe. |
| 5xx / network / unexpected | FAILED log, then throw: BullMQ retries; the final attempt reports through `reportWorkerFailure`. Rows already inserted are safe (synthetic keys) and are handed to the classifier. |

## 24.8 Client — `@bliss/shared/enablebanking`

Node-only, dual build. `signJwt` signs RS256 through `node:crypto` (header `{ typ, alg: 'RS256', kid: appId }`, claims `iss: 'enablebanking.com'`, `aud: 'api.enablebanking.com'`, 1 h TTL; cached until 5 min before expiry). `createClient` wraps `getAspsps`, `startAuth`, `createSession`, `getSession`, `deleteSession`, `getTransactions`, `getBalances` and `getApplication` (the credential probe, #148) with a 20 s timeout and throws `EnableBankingError { status, code, retryable, rateLimited, consent }`; messages never contain the JWT.

Per-tenant helpers (#148): `parsePrivateKey(input)` → `{ pem (PKCS#8), bits, fingerprint }` or `KeyFormatError(code)` (the API's save path; `apps/web/src/lib/pem.ts` mirrors its format checks and both are tested against `packages/shared/test-fixtures/enablebanking-keys/`), `appIdHash`, `isValidAppId`, `probeApplication(client, { callbackUrl })` → `VERIFIED | INVALID | SANDBOX | UNREACHABLE` (+ `callbackRegistered`), `isCredentialError`, `createTenantClientCache({ max })` (LRU keyed `tenantId:credentialId:version`), `getBaseUrl(env)` (`ENABLE_BANKING_API_URL` stays deployment-wide) and `retiredEnvVars(env)`. There is no env-driven key loader any more. The Sentry scrubber drops `session_id`, `iban` and private-key fields and redacts PEM blocks in free text.

## 24.9 Plaid path changes

- `plaidSyncWorker` drops `added` rows whose `account_id` no longer maps to an `Account` linked to the item — defence in depth for a provider switch (R5a) that leaves the Plaid item alive for sibling accounts.
- `validateEnv` (API and backend) warns while any retired variable (`ENABLE_BANKING_APP_ID`, `ENABLE_BANKING_PRIVATE_KEY`, `ENABLE_BANKING_PRIVATE_KEY_PATH`) is set: they are ignored, credentials belong in Settings → Bank sync (#148).

## 24.10 Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ENABLE_BANKING_SYNC_TIMES` | `06:15,13:15,20:15` | Scheduled sync slots, Europe/Madrid. |
| `ENABLE_BANKING_DAILY_BUDGET` | `4` | Accesses per account per Madrid day. |
| `ENABLE_BANKING_API_URL` | `https://api.enablebanking.com` | Override for tests / sandboxes. |

Set them on both the API and the backend worker. The application id and private key are **per tenant** (`EnableBankingCredential`, managed in Settings → Bank sync, #148); `ENABLE_BANKING_APP_ID` / `ENABLE_BANKING_PRIVATE_KEY(_PATH)` are retired and never read.

## 24.11 Tests

Backend: `unit/shared/enableBanking.test.js` (JWT, key parsing against the shared test keys, probe, tenant client cache, client errors, balances, window, budget, label), `unit/services/enableBanking/mapper.test.js`, `unit/workers/handlers/enableBankingSync.test.js` (window, paging, pending, idempotency, budget, failure matrix, expiry, fan-out), `unit/workers/plaidProcessorWorker.enableBanking.test.js` (boundary day: 3 DUPLICATE + 4 for review; promotion label; sync log count), `integration/enableBankingSync.test.js` (real Postgres: twice-run and reconnect insert nothing; paused skip; resume with the 7-day overlap; the real resolver signs with the tenant's app id; `markCredentialInvalid` is version-conditional). The handler unit test also covers the paused skip, the INVALID scheduled skip and the D5 probe split. The R6 partial unique index is checked in the API flow suite: backend CI builds its database with `prisma db push`, which never creates SQL-only indexes.

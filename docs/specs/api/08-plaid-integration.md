# 8. Plaid Integration API

This module handles secure connection establishment, real-time webhook processing, and full lifecycle management for Plaid linked accounts. It acts as the bridge between the Frontend (Plaid Link flow) and the Backend (Data Sync pipeline).

---

## Endpoints

### 1. Link Token Creation
**POST** `/api/plaid/create-link-token`

- **Purpose**: Initialises the Plaid Link flow, or opens Link in **Update Mode** to re-authenticate an existing Item.
- **Auth**: JWT.
- **Body**: `{ plaidItemId?: string }` — when provided, creates a link token scoped to that existing Item (update mode for re-auth or reconnect). Omit for a new connection.
- **Response**: `{ link_token: string }`.
- **Configuration**: Requests access to `['transactions']` product. When `PLAID_WEBHOOK_URL` is set, the URL is included as the `webhook` parameter so Plaid sends TRANSACTIONS and ITEM events to the application automatically.

---

### 2. Public Token Exchange
**POST** `/api/plaid/exchange-public-token`

- **Purpose**: Completes the Plaid Link OAuth flow. Exchanges the temporary `public_token` returned by the client SDK for a permanent `access_token`.
- **Auth**: JWT.
- **Body**: `{ public_token, institutionId, institutionName, bankName? }`
- **Security**: The `accessToken` is **encrypted** (AES-256-GCM) before being stored in `PlaidItem`.
- **Features**:
  - **Optimistic Bank Linking**: Automatically attempts to match the Plaid Institution ID with existing `Bank` records.
  - **Auto-Creation**: If the Bank does not exist, it is created on-the-fly using Plaid metadata.
  - **PlaidItem Status**: New items are created with `status: 'PENDING_SELECTION'` — no sync is triggered until the user completes account selection.
- **Response**: `{ plaidItemId: string }` — the internal CUID of the created/updated `PlaidItem`.

---

### 3. Fetch Plaid Accounts
**GET** `/api/plaid/accounts?plaidItemId={id}`

- **Purpose**: Fetches the sub-accounts (checking, savings, credit card) from a PlaidItem for user selection during the linking flow.
- **Auth**: JWT.
- **Query params**: `plaidItemId` (required) — the internal CUID of the PlaidItem.
- **Logic**: Calls Plaid `accounts/get` API, validates supported currencies and countries against tenant's configured reference data, and returns enriched account data.
- **Response**: `{ accounts: [{ plaidAccountId, name, mask, type, subtype, currency, institutionName }] }`

---

### 4. Account Selection & Sync Start
**POST** `/api/plaid/sync-accounts`

- **Purpose**: Allows the user to select which sub-accounts (checking, savings, credit card) to import from the linked Item. Optionally links Plaid accounts to existing manual accounts instead of creating new records.
- **Auth**: JWT.
- **Body**: `{ plaidItemId, selectedAccountIds: string[], countryId?: string, accountMappings?: Record<string, number>, accountNames?: Record<string, string> }`
  - `accountMappings` — optional map of `{ [plaidAccountId]: existingAccountId }`. When provided, the endpoint **updates** the existing manual Account with Plaid fields (`plaidAccountId`, `plaidItemId`, `mask`, `type`, `subtype`) instead of creating a new Account. The target account must belong to the same tenant and have no existing `plaidAccountId`. If the target is invalid, a new account is created as fallback.
  - `accountNames` — optional map of `{ [plaidAccountId]: customName }`. When provided, newly created accounts use the custom name instead of Plaid's default name. Ignored for linked accounts (they keep their existing name).
- **Action**:
  1. For each selected account: links to an existing manual Account (if mapped) or creates a new `Account` record keyed by `plaidAccountId`.
  2. Sets `PlaidItem.status = 'ACTIVE'`.
  3. Emits `PLAID_INITIAL_SYNC` event to trigger the backend ingestion worker.
- **Why link before sync?** The hash-based duplicate detection (`computeTransactionHash`) uses the local `accountId`. Linking must happen **before** the transaction sync so that incoming Plaid transactions reference the same `accountId` as existing manual transactions — enabling the hash dedup to catch duplicates.
- **Response**: `{ success: true, message: string }`.

---

### 4. PlaidItem Management

**GET** `/api/plaid/items`
- **Purpose**: Returns all `PlaidItem` records for the authenticated tenant with status and account data.
- **Auth**: JWT.
- **Response**: Array of items with `id`, `itemId`, `status`, `errorCode`, `lastSync`, `historicalSyncComplete`, `earliestTransactionDate`, `institutionName`, `institutionId`, `bankId`, `consentExpiration`, `environment`, `createdAt`, and nested `accounts[]`.

**PATCH** `/api/plaid/items?id={plaidItemId}`
- **Purpose**: Resets the `PlaidItem` status after successful re-authentication via Plaid Link update mode.
- **Auth**: JWT.
- **Body**: `{ status: 'ACTIVE' }` — only resetting to `ACTIVE` is permitted.
- **Action**: Sets `status = 'ACTIVE'`, clears `errorCode`, and **fire-and-forgets a `PLAID_SYNC_UPDATES` event** (source: `RECONNECT_SYNC`) to catch up on transactions that arrived while the connection was paused.
- **Response**: Updated `{ id, status, errorCode, lastSync, institutionName }`.

---

### 5. Token Rotation
**POST** `/api/plaid/rotate-token?id={plaidItemId}`

- **Purpose**: Rotates the Plaid `accessToken` for a given Item by calling `plaidClient.itemAccessTokenInvalidate()`. The old token is invalidated and the new token is encrypted and persisted.
- **Auth**: JWT.
- **Validation**: Validates tenant ownership. Any item status may be rotated (no status check is enforced).
- **Action**: Calls Plaid's `itemAccessTokenInvalidate` API, encrypts the returned new token, updates `PlaidItem.accessToken`.
- **Response**: `{ message: 'Access token rotated successfully' }`.

---

### 6. Manual Resync
**POST** `/api/plaid/resync?id={plaidItemId}`

- **Purpose**: Triggers a manual incremental sync without waiting for the next Plaid webhook.
- **Auth**: JWT.
- **Validation**: Only `ACTIVE` items can be resynced. Returns `400` if status is anything else.
- **Action**: Emits `PLAID_SYNC_UPDATES` event with `source: 'MANUAL_RESYNC'`.
- **Response**: `{ message: 'Sync triggered' }`.

---

### 6a. Historical Backfill
**POST** `/api/plaid/fetch-historical?id={plaidItemId}`

- **Purpose**: Triggers an on-demand historical transaction backfill for a Plaid connection. Allows users to fetch transactions older than the default 90-day `transactionsSync` window.
- **Auth**: JWT.
- **Query params**: `id` (required) — the internal CUID of the PlaidItem.
- **Body**: `{ fromDate: "YYYY-MM-DD" }` — the start date for the backfill.
- **Validation**:
  - `fromDate` must match `YYYY-MM-DD` format.
  - `fromDate` cannot be more than 2 years in the past.
  - `fromDate` cannot be in the future.
  - PlaidItem must exist, belong to the authenticated tenant, and have `status === 'ACTIVE'`.
- **Action**: Emits `PLAID_HISTORICAL_BACKFILL` event with `{ tenantId, plaidItemId, fromDate }`. The backend `plaidSyncWorker` processes this using Plaid's `transactionsGet` endpoint (offset-paginated) instead of the cursor-based `transactionsSync`.
- **Response**: `{ message: 'Historical backfill triggered' }`.
- **Errors**: `400` (missing/invalid date, inactive item), `403` (wrong tenant), `404` (item not found), `500` (internal error).

---

### 7. Soft Disconnect (Pause Sync)
**POST** `/api/plaid/disconnect?id={plaidItemId}`

- **Purpose**: Pauses syncing for a Plaid connection by setting `PlaidItem.status = 'REVOKED'` **without** calling `plaidClient.itemRemove()`.
- **Auth**: JWT.
- **Design rationale**: `plaidClient.itemRemove()` is a **permanent, irreversible** Plaid operation — once called, the Item is destroyed and reconnection via Plaid Link update mode is impossible. By only updating the local status, the `accessToken` remains valid so the user can reconnect at any time.
- **Effect on sync**: The `plaidSyncWorker` checks `status === 'ACTIVE'` at job start and skips gracefully for `REVOKED` items. Plaid webhooks for `REVOKED` items are also ignored.
- **Action**: Sets `PlaidItem.status = 'REVOKED'`.
- **Response**: `{ message: 'Connection disconnected' }`.
- **UI label**: Shown to users as **"Pause Sync"** to accurately set expectations.

> **See also — Admin Hard Delete**: A permanent, irreversible delete is available as a separate admin-only endpoint (`DELETE /api/plaid/items/hard-delete`). It is intentionally invisible to end-users and protected by an admin key rather than JWT. See §12 below.

---

### 8. Sync Logs
**GET** `/api/plaid/sync-logs?plaidItemId={id}&limit={n}`

- **Purpose**: Returns recent `PlaidSyncLog` records for a given `PlaidItem`. Powers the Sync Logs table in the Accounts detail panel.
- **Auth**: JWT.
- **Query params**: `plaidItemId` (required), `limit` (optional, default 10, max 50).
- **Validates** tenant ownership before returning data.
- **Response**: Array of `{ id, plaidItemId, type, status, details, createdAt }`.

**PlaidSyncLog fields:**

| Field | Values | Description |
|---|---|---|
| `type` | `INITIAL_SYNC` / `SYNC_UPDATE` / `HISTORICAL_BACKFILL` | What triggered the sync |
| `status` | `SUCCESS` / `FAILED` | Outcome |
| `details` | JSON | `{ added, modified, removed, batches }` on success; `{ error, added, modified, removed }` on failure |

---

### 9. Webhook Handler
**POST** `/api/plaid/webhook`

- **Purpose**: Public endpoint for Plaid to push real-time events. **Not JWT-protected** — Plaid calls this directly from their servers, not from a browser.
- **Route**: The file lives at `pages/api/plaid/webhook.js`, so the actual route is `/api/plaid/webhook`.
- **Webhook URL**: Set the `PLAID_WEBHOOK_URL` environment variable (e.g. `https://{domain}/api/plaid/webhook`). The URL is passed to Plaid automatically via the `webhook` parameter in `/link/token/create` — no manual dashboard registration is needed for TRANSACTIONS and ITEM events.
- **Signature Verification**:
  - **Production**: Verifies the `Plaid-Verification` header using `jose.compactVerify()` against Plaid's public JWK (fetched via `webhookVerificationKeyGet`, cached in-memory by `kid`). The `iat` claim is validated to prevent replay attacks (5-minute max age). Requests failing verification receive `401`.
  - **Development/Sandbox**: Verification is skipped so sandbox webhooks from the Plaid dashboard can be tested without an HTTPS-reachable URL. A warning is logged.
- **Response strategy**: Returns `200 { received: true }` **immediately before** async processing — Plaid retries on non-2xx, so fast acknowledgement is critical.

**Events handled:**

| `webhook_type` | `webhook_code` | Action |
|---|---|---|
| `TRANSACTIONS` | `SYNC_UPDATES_AVAILABLE` | Emits `PLAID_SYNC_UPDATES` if item is `ACTIVE` |
| `TRANSACTIONS` | `HISTORICAL_UPDATE` | Emits `PLAID_SYNC_UPDATES` with `source: 'WEBHOOK_HISTORICAL_UPDATE'` — full transaction history now available. The backend uses this source to mark `historicalSyncComplete = true` on the `PlaidItem`. |
| `ITEM` | `ERROR` | Updates `PlaidItem.status` + `errorCode` (`LOGIN_REQUIRED` if error code is `ITEM_LOGIN_REQUIRED`, otherwise `ERROR`) |
| `ITEM` | `LOGIN_REQUIRED` | Sets `PlaidItem.status = 'LOGIN_REQUIRED'` |
| `ITEM` | `USER_PERMISSION_REVOKED` | Sets `PlaidItem.status = 'REVOKED'` — user revoked access at their bank |
| `ITEM` | `WEBHOOK_UPDATE_ACKNOWLEDGED` | No-op (logged only — Plaid confirming webhook URL registration) |

---

### 10. Transaction Actions (Review API)

See [`10-ai-classification-and-review.md`](./10-ai-classification-and-review.md) for full documentation of:
- `GET /api/plaid/transactions` — list transactions for review
- `PUT /api/plaid/transactions/:id` — promote, skip, re-queue, category override, investment enrichment
- `POST /api/plaid/transactions/bulk-promote` — bulk promote above confidence threshold

### 10a. Quick Seed Interview

**GET** `/api/plaid/transactions/seeds`

- **Purpose**: Returns all `seedHeld=true` PlaidTransactions for a Plaid item, grouped by normalised description (sorted by frequency). Includes rows classified by LLM, VECTOR_MATCH, and VECTOR_MATCH_GLOBAL — but **not** EXACT_MATCH (those are never seedHeld).
- **Auth**: JWT.
- **Query params**: `plaidItemId` (required), `limit` (optional, default 15, max 50).
- **Response**: Array of `SeedItem` objects — each represents one unique normalised description with the AI suggestion, confidence, source, and count of matching transactions.

**POST** `/api/plaid/transactions/confirm-seeds`

- **Purpose**: Processes user decisions from the Quick Seed modal. Also handles the "Skip for now" case when `seeds` is an empty array.
- **Auth**: JWT.
- **Body**: `{ plaidItemId: string, seeds: Array<{ description: string, rawName?: string, confirmedCategoryId: number }> }`
  - `seeds` may be an empty array (e.g. when the user clicks "Skip for now"). In this case, the for-loop simply doesn't iterate and execution falls through to the release step.
- **Confirmed seeds**: Each seed entry matches all `seedHeld=true` rows for that description. For each matched row: creates a `Transaction` record (if not already promoted), sets `seedHeld = false`, `promotionStatus = 'PROMOTED'`. Calls fire-and-forget `recordFeedback` to update the embedding index.
- **Excluded seeds / Skip**: After processing confirmed seeds, any `seedHeld=true` rows still remaining on the `plaidItemId` are batch-released: `seedHeld = false`, `promotionStatus = 'CLASSIFIED'`. These transactions appear in the standard pending review queue with their AI suggestion intact. When `seeds` is empty, **all** seedHeld rows are released this way.
- **Dedup**: Uses same `externalId` dedup guard as single-row promote.
- **Response**: `{ confirmed: N, promoted: N }`

### 12. Admin Hard Delete
**DELETE** `/api/plaid/items/hard-delete`

- **Purpose**: Permanently and irreversibly destroys a Plaid connection and all associated staging data. **Not visible to end-users** — internal tooling / support workflows only.
- **Auth**: `X-Admin-Key: <ADMIN_API_KEY>` header — **not** JWT. Returns `401` if the header is missing, wrong, or if `ADMIN_API_KEY` is not set in the environment.
- **Query params** (one required):
  - `?id=<plaidItemCuid>` — our internal cuid
  - `?itemId=<plaidExternalItemId>` — Plaid's `item_id`
- **Execution order**:
  1. Fetches the `PlaidItem` (access token auto-decrypted by Prisma middleware).
  2. Calls `plaidClient.itemRemove({ access_token })` to revoke the token at Plaid's side. Tolerates `ITEM_NOT_FOUND` (already gone on Plaid's side — continues with local cleanup). Aborts on any other Plaid error (`502`).
  3. Nullifies `Account.plaidAccountId` and `Account.plaidItemId` for every local `Account` linked to this `PlaidItem` (accounts are preserved, just unlinked).
  4. Deletes the `PlaidItem` record. `PlaidTransaction` and `PlaidSyncLog` cascade-delete automatically (`onDelete: Cascade`).
- **Intentionally preserves**: `Transaction` records (real promoted financial data must never be deleted here).
- **Response**: `{ deleted: true, plaidItemId, institutionName, tenantId, summary: { accountsUnlinked, plaidTransactionsDeleted, syncLogsDeleted, transactionsPreserved: true, plaidTokenRevoked } }`.

> **Why admin-only?** `plaidClient.itemRemove()` is irreversible — once called, reconnection via Plaid Link update mode is permanently impossible. This operation must never be triggered accidentally by end-users. The soft disconnect (`POST /api/plaid/disconnect`) remains the standard user-facing path.

---

### 11. Merchant History
**GET** `/api/transactions/merchant-history?description={str}&limit={n}`

- **Purpose**: Returns recent `Transaction` records for the same merchant/description. Powers the Merchant History section in the Transaction Review deep-dive drawer.
- **Auth**: JWT.
- **Query params**: `description` (required), `limit` (optional, default 10).
- **Response**: Array of `{ id, date, amount, currencyCode, categoryName, source }`.

---

## Tenant Config

### `plaidHistoryDays`

| Field | Type | Default | Editable |
|---|---|---|---|
| `plaidHistoryDays` | `Int` | `1` (or `PLAID_HISTORY_DAYS` env var at creation) | Yes — via `PUT /api/tenants/settings` |

Controls two things simultaneously:

1. **`days_requested` in the Plaid link token** (`create-link-token.js`) — tells Plaid how far back to initialise the item's transaction ledger when a bank is first connected. This is a one-time hint at item creation; Plaid may backfill more history later regardless.

2. **Resync date cutoff** (`plaidSyncWorker.js`) — when processing `transactionsSync` results, any `added` transaction whose `date` is earlier than `(PlaidItem.createdAt – plaidHistoryDays)` is silently dropped before DB insert. This prevents subsequent resyncs from pulling Plaid's backfilled history beyond the original window.

**Seeding at creation time**: Both `POST /api/auth/signup` and the Google SSO path (`findOrCreateGoogleUser`) read `process.env.PLAID_HISTORY_DAYS ?? 1` and write it directly to `Tenant.plaidHistoryDays`. This means the operator can set a system-wide default via env var, while each tenant can override it later through the Settings UI.

**UI**: Exposed as a number input in the **AI Classification** tab of the Settings page, alongside the AI confidence thresholds.

---

## Data Models

### `PlaidItem` — Status Reference

| Status | Meaning | UI display | Actions available |
|---|---|---|---|
| `PENDING_SELECTION` | Token exchanged, awaiting account selection | — (modal in progress) | Account selection |
| `ACTIVE` | Healthy, syncing normally | ✅ Synced (green) | Resync, Rotate Token, Re-link, Pause Sync |
| `LOGIN_REQUIRED` | Re-authentication needed at bank | ⚠️ Action Required (amber) | Re-link Plaid (update mode) |
| `ERROR` | Non-auth Plaid error | 🔴 Action Required (red) | Re-link Plaid, Resync |
| `REVOKED` | User paused sync (soft disconnect) | ⬜ Disconnected (gray) | Reconnect Bank |

### `PlaidItem` — Historical Sync Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `historicalSyncComplete` | `Boolean` | `false` | Set to `true` when a `WEBHOOK_HISTORICAL_UPDATE` sync completes. Indicates the full 2-year Plaid backfill is done. |
| `earliestTransactionDate` | `DateTime?` | `null` | The oldest transaction date seen across all sync batches. Updated monotonically (only moves earlier, never later). |
| `seedReady` | `Boolean` | `false` | Set to `true` when Phase 1 seed classification is complete in `plaidProcessorWorker`. Signals the frontend to show the Quick Seed interview. |

### `PlaidTransaction`

Staging table for raw Plaid data extended with AI classification and investment fields. See [`10-ai-classification-and-review.md`](./10-ai-classification-and-review.md) for full field list.

### `PlaidSyncLog`

One record per sync attempt. Links to `PlaidItem`. Stores type, status, and stats (added/modified/removed counts). Written by `plaidSyncWorker` after every sync completes (success or failure).

---

## CORS Configuration

`utils/cors.js` applies cross-origin headers to all Plaid API endpoints. Allowed methods: `GET, POST, PUT, PATCH, DELETE, OPTIONS`. Allowed origins: `FRONTEND_URL` env var + `localhost:8080` and `localhost:3000` in non-production.

The `/api/plaid/webhook` endpoint does **not** require CORS headers — it is a server-to-server call from Plaid, not from a browser.

---

### Hash-Based Duplicate Detection

The `PUT /api/plaid/transactions/:id` promote path and `POST /api/plaid/transactions/bulk-promote` both apply hash-based duplicate detection in addition to `externalId` dedup. A SHA-256 hash of `(isoDate + normalizedDescription + amount + accountId)` is computed and checked against existing `Transaction` records. This catches manual-entry duplicates that `externalId`-based dedup cannot detect (manually entered transactions have `externalId = null`). When a hash collision is found, the promotion is skipped and the PlaidTransaction is marked as a duplicate.

---

### Bulk Re-Queue

**POST** `/api/plaid/transactions/bulk-requeue`

- **Purpose**: Moves all `SKIPPED` PlaidTransactions back to `CLASSIFIED` for re-review. Enables mass recovery of previously skipped transactions.
- **Auth**: JWT.
- **Body**: `{ plaidItemId?: string }` — optional filter to scope the operation to a single Plaid connection.
- **Response**: `{ updated: number }` — count of rows transitioned from `SKIPPED` to `CLASSIFIED`.

---


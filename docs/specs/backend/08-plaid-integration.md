# 8. Plaid Integration & Data Sync

This service handles the robust, asynchronous synchronisation of financial data from Plaid. It is designed to be fault-tolerant, scalable, and secure, ensuring users' financial data stays up-to-date without blocking the main application.

---

## Tenant Config

### `plaidHistoryDays`

| Field | Type | Default | Editable |
|---|---|---|---|
| `plaidHistoryDays` | `Int` | `1` (or `PLAID_HISTORY_DAYS` env var at creation) | Yes — via `PUT /api/tenants/settings` |

Controls two things simultaneously:

1. **`days_requested` in the Plaid link token** (`bliss-finance-api/pages/api/plaid/create-link-token.js`) — tells Plaid how far back to initialise the item's transaction ledger when a bank is first connected.

2. **Resync date cutoff** (`plaidSyncWorker.js`) — when processing `transactionsSync` results, any `added` transaction whose `date` is earlier than `(PlaidItem.createdAt – plaidHistoryDays)` is silently dropped before DB insert. This prevents subsequent resyncs from pulling Plaid's backfilled history beyond the original window.

The cutoff is computed as:
```js
const historyDays = plaidItem.tenant?.plaidHistoryDays ?? 1;
const syncCutoffDate = new Date(plaidItem.createdAt); // midnight UTC
syncCutoffDate.setUTCHours(0, 0, 0, 0);
syncCutoffDate.setUTCDate(syncCutoffDate.getUTCDate() - historyDays);
```

The constant `DEFAULT_PLAID_HISTORY_DAYS` in `src/config/classificationConfig.js` reads from `process.env.PLAID_HISTORY_DAYS` and documents the system-wide default. The env var is consumed only at tenant creation time; from then on, `Tenant.plaidHistoryDays` is the source of truth.

---

## Architecture

The integration uses a **two-worker system** to separate IO-bound work (Plaid API calls) from CPU/DB-bound work (classification and reconciliation).

```
Webhook / Manual Resync
        │
        ▼
 eventSchedulerWorker
        │
        ▼
  plaid-sync queue ──► PlaidSyncWorker (ingestion)
                              │
                              │ PLAID_SYNC_COMPLETE
                              ▼
                 plaid-processing queue ──► PlaidProcessorWorker (classification + reconciliation)
                              │
                              │ TRANSACTIONS_IMPORTED
                              ▼
                     Analytics / Portfolio pipeline
```

---

## 1. Ingestion: `PlaidSyncWorker`

**Queue**: `plaid-sync`
**File**: `src/workers/plaidSyncWorker.js`

Responsible for all Plaid API communication. Implements Plaid's cursor-based `transactionsSync` protocol for incremental syncs and Plaid's `transactionsGet` endpoint for on-demand historical backfills.

### Trigger

Receives `PLAID_INITIAL_SYNC`, `PLAID_SYNC_UPDATES`, or `PLAID_HISTORICAL_BACKFILL` jobs from `eventSchedulerWorker`. The `source` field in the job data identifies the origin (e.g. `MANUAL_RESYNC`, `WEBHOOK_SYNC_UPDATES_AVAILABLE`, `WEBHOOK_HISTORICAL_UPDATE`, `RECONNECT_SYNC`, `HISTORICAL_BACKFILL`). For backfill jobs, `fromDate` (YYYY-MM-DD) is also passed in the job data. The `eventSchedulerWorker` forwards all fields from the event payload to the queue job data.

### Status Guard

On every job, the worker fetches the `PlaidItem` and checks `status === 'ACTIVE'` before proceeding. If the item has any other status (e.g. `REVOKED`, `LOGIN_REQUIRED`, `ERROR`), the job **returns immediately** without throwing — this is intentional so the job completes cleanly and is not retried by BullMQ.

This handles the case where:
- A Plaid webhook fires for a recently soft-disconnected item
- A queued job executes after the user paused sync from the UI

### Helper Functions

Two shared helper functions are extracted at the top of the file (before `startPlaidSyncWorker`) to reduce duplication between the incremental sync and historical backfill paths:

| Helper | Purpose |
|---|---|
| `mapPlaidTransaction(plaidItemId, txn)` | Maps a raw Plaid transaction object to the `PlaidTransaction` Prisma shape. Sets `syncType: 'ADDED'`, `processed: false`, encrypts `rawJson`. Used by both `transactionsSync` (added items) and `transactionsGet` (backfill) paths. |
| `trackEarliestDate(transactions, currentEarliest)` | Computes the earliest `tx.date` in a batch. Returns the new minimum or the existing `currentEarliest` if no earlier date is found. |

### Sync Workflow

The worker branches based on `source`:

#### Branch A: Incremental Sync (`source !== 'HISTORICAL_BACKFILL'`)

1. Decrypt `accessToken` (auto-decrypted by Prisma middleware).
2. Destructure `source` from `job.data` and initialise `overallEarliestDate = null`.
3. Call `plaidClient.transactionsSync({ access_token, cursor, count: 500 })` in a loop until `has_more = false`.
4. **Added**: Bulk insert via `mapPlaidTransaction()` + `createMany({ skipDuplicates: true })`. After each batch, calls `trackEarliestDate()` to update `overallEarliestDate`.
5. **Modified**: Sequential upserts — updates existing rows in place (preserves `promotionStatus`).
6. **Removed**: Marks existing rows as `syncType: 'REMOVED'`, `processed: false`.
7. After each page: updates `PlaidItem.nextCursor`.

#### Branch B: Historical Backfill (`source === 'HISTORICAL_BACKFILL'`)

1. Decrypt `accessToken` (auto-decrypted by Prisma middleware).
2. Read `fromDate` from `job.data`. Compute `endDate` as the item's current `earliestTransactionDate` (or today if null).
3. Call `plaidClient.transactionsGet({ access_token, start_date: fromDate, end_date: endDate, options: { count: 500, offset } })` in a paginated loop (`offset` incremented by batch size until `offset >= total_transactions`).
4. Map each transaction via `mapPlaidTransaction()`, bulk insert with `createMany({ skipDuplicates: true })`. Calls `trackEarliestDate()` per batch.
5. **No cursor management** — `transactionsGet` uses offset pagination, not cursors.

#### Convergence (both branches)

8. On loop completion:
   - Updates `PlaidItem.lastSync`.
   - Updates `PlaidItem.earliestTransactionDate` if `overallEarliestDate` is earlier than the currently stored value (monotonically decreasing — only moves to earlier dates).
   - If `source === 'WEBHOOK_HISTORICAL_UPDATE'`: sets `PlaidItem.historicalSyncComplete = true`.
   - Writes a `PlaidSyncLog` record (`type: INITIAL_SYNC | SYNC_UPDATE | HISTORICAL_BACKFILL`, `status: SUCCESS`).
   - Enqueues `PLAID_SYNC_COMPLETE` to trigger the processor, **passing the `source` field** in the job data. This allows the processor to apply source-aware behaviour (e.g. Quick Seed interview only during `INITIAL_SYNC`).

### Sync Logs

A `PlaidSyncLog` record is written after every sync attempt regardless of outcome:

| Scenario | `type` | `status` | `details` |
|---|---|---|---|
| Incremental sync completes | `INITIAL_SYNC` / `SYNC_UPDATE` | `SUCCESS` | `{ added, modified, removed, batches }` |
| Historical backfill completes | `HISTORICAL_BACKFILL` | `SUCCESS` | `{ added, modified, removed, batches }` |
| Any error throws | (per source) | `FAILED` | `{ error, added, modified, removed }` |

The `syncType` is derived from `source`: `'HISTORICAL_BACKFILL'` when `source === 'HISTORICAL_BACKFILL'`, `'INITIAL_SYNC'` when `job.name === 'PLAID_INITIAL_SYNC'`, otherwise `'SYNC_UPDATE'`.

### Error Handling & Status Updates

In the catch block, if the error contains a Plaid error code (`error.response?.data?.error_code`):

- **`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`** — Transient race condition; data changed at Plaid while we were paginating pages. This is **not** an item health error. The worker:
  1. Resets `PlaidItem.nextCursor = null` (so the next attempt restarts from the beginning).
  2. Re-throws the error **without** setting `status = 'ERROR'`.
  3. BullMQ retries the job automatically. Because `createMany` uses `skipDuplicates: true`, re-inserting already-ingested rows is safe.
  4. The `worker.on('failed', ...)` handler suppresses Sentry reporting for this specific code to avoid noise.
- `ITEM_LOGIN_REQUIRED` → updates `PlaidItem.status = 'LOGIN_REQUIRED'`
- Any other Plaid error code → updates `PlaidItem.status = 'ERROR'`, stores `errorCode`

This provides immediate UI feedback without waiting for the next `ITEM.ERROR` webhook.

### Raw Payload Encryption

The full Plaid API response for each transaction is encrypted (AES-256-GCM) and stored in `PlaidTransaction.rawJson` for auditing and future replayability.

---

## 2. Processing: `PlaidProcessorWorker`

**Queue**: `plaid-processing`
**File**: `src/workers/plaidProcessorWorker.js`

Takes the raw staged data and applies business logic.

**Concurrency**: 1 (one Plaid item at a time). Note: `PHASE2_CONCURRENCY = 5` controls concurrent LLM classification calls *within* a single job, not worker-level concurrency.

### Workflow

1. **Trigger**: Receives `PLAID_SYNC_COMPLETE` job (`{ plaidItemId, source }`).
2. **Source guard (`allowSeedHeld`)**: Derives `allowSeedHeld = !source || source === 'INITIAL_SYNC'`. Only `INITIAL_SYNC` enables the Quick Seed interview — `WEBHOOK_HISTORICAL_UPDATE`, `MANUAL_RESYNC`, and other sources skip Phase 1 hold-back entirely (user is not necessarily present).
3. **Batch**: Fetches all unprocessed `PlaidTransaction` rows where `processed = false` and `promotionStatus = 'PENDING'`.
4. **Classify**: Calls `categorizationService.classify(description, merchantName, tenantId, reviewThreshold, plaidCategory)` for each row. The Plaid `personal_finance_category` JSON (stored in `PlaidTransaction.category`) is passed as a 5th argument and injected as a `PLAID CATEGORY` hint in the Gemini prompt (used as context, not a direct override). Up to `PHASE2_CONCURRENCY` (5) rows are classified concurrently within a single job.
5. **Investment Detection**: If the classified category has `type = 'Investments'` and a matching `processingHint` (`API_STOCK`, `API_CRYPTO`, `API_FUND`, or `MANUAL`), the row is flagged with `requiresEnrichment: true`, `enrichmentType: 'INVESTMENT'`. These rows are **never auto-promoted** regardless of confidence — they require user-provided ticker/quantity/price.
6. **Auto-Promote**: If `aiConfidence >= tenant.autoPromoteThreshold` AND not an investment requiring enrichment: creates a `Transaction` immediately (`promotionStatus = 'PROMOTED'`). Calls `recordFeedback()` after commit.
7. **Phase 1 Hold-Back (Quick Seed — INITIAL_SYNC only)**: When `allowSeedHeld = true`, rows that do **not** meet auto-promote criteria AND have `classificationSource ≠ EXACT_MATCH` are held with `seedHeld = true` for the Quick Seed interview. `EXACT_MATCH` results below threshold go straight to `CLASSIFIED`.
8. **Staged**: All other classified rows remain with `promotionStatus = 'CLASSIFIED'` for manual review.
9. **Rate-limit handling**: If `geminiService.classifyTransaction()` exhausts retries due to a 429 (quota), the row is **not** marked `processed = true` — it is left eligible for the next job run. After Phase 2, if any rows were deferred, the worker re-queues itself with a 60-second delay.
10. **Completion**: Emits `TRANSACTIONS_IMPORTED` to trigger the analytics chain.

---

## AI Classification Integration

### PlaidTransaction Staging Fields

| Field | Description |
|---|---|
| `suggestedCategoryId` | AI-suggested category ID |
| `aiConfidence` | Classification confidence (0.0–1.0) |
| `classificationSource` | `'EXACT_MATCH'` / `'VECTOR_MATCH'` / `'VECTOR_MATCH_GLOBAL'` / `'LLM'` / `'USER_OVERRIDE'` |
| `classificationReasoning` | Free-text reasoning string returned by the Gemini LLM (null for EXACT_MATCH, VECTOR_MATCH, and VECTOR_MATCH_GLOBAL) |
| `promotionStatus` | `'PENDING'` / `'CLASSIFIED'` / `'PROMOTED'` / `'SKIPPED'` |
| `seedHeld` | `true` while the row is held for the Quick Seed interview. **Only set during `INITIAL_SYNC`** (`allowSeedHeld = true`). Condition: `confidence < autoPromoteThreshold` AND `classificationSource ≠ EXACT_MATCH`. Cleared by `confirm-seeds` (on confirm) or bulk `updateMany` (on exclude). |
| `requiresEnrichment` | `true` for investment transactions that need ticker/qty/price before promotion |
| `enrichmentType` | `'INVESTMENT'` when requiresEnrichment is true |

### Plaid Category Hint

`plaidProcessorWorker` passes the Plaid `personal_finance_category` object to `geminiService.classifyTransaction()`. When present, it is injected into the LLM prompt as:

```
PLAID CATEGORY (from the bank — use as a hint, NOT as the answer):
Primary: "FOOD_AND_DRINK"
Detailed: "FOOD_AND_DRINK_RESTAURANTS"
Confidence: "HIGH"
```

The classification rule adds: *"If a PLAID CATEGORY is provided, use it as a contextual hint but always map to the most appropriate category from your list."* This improves accuracy for first-time merchants that miss Tiers 1 & 2.

---

## Auto-Promote

For each classified `PlaidTransaction`:
- `aiConfidence >= autoPromoteThreshold` **AND** `requiresEnrichment !== true` **AND** local `Account` is linked → creates a `Transaction` immediately, sets `promotionStatus = 'PROMOTED'`. Calls `recordFeedback(description, categoryId, tenantId, transactionId)` to reinforce the cache.
- `aiConfidence < autoPromoteThreshold` AND `classificationSource ≠ EXACT_MATCH` AND `allowSeedHeld = true` (INITIAL_SYNC only) → `seedHeld = true`, `promotionStatus = 'PENDING'` — held for Quick Seed interview.
- `aiConfidence < autoPromoteThreshold` AND `classificationSource ≠ EXACT_MATCH` AND `allowSeedHeld = false` (historical/resync) → `promotionStatus = 'CLASSIFIED'` — goes straight to review queue.
- `aiConfidence < autoPromoteThreshold` AND `classificationSource === EXACT_MATCH` → `promotionStatus = 'CLASSIFIED'` (never seedHeld) — skips interview, goes straight to review queue.
- Investment requiring enrichment → never auto-promoted regardless of confidence; **not** seedHeld — goes straight to `CLASSIFIED`.
- **429 rate limit** → row left with `processed = false`, `promotionStatus = 'PENDING'`. Worker re-queues itself with a 60-second delay to retry.

**Logging**: `logger.warn()` is emitted when auto-promote is eligible but `localAccount` is null.

### Gemini Resilience

`geminiService.js` applies the following policies to every LLM and embedding call:

| Concern | Policy |
|---|---|
| **Hard call timeout** | 30-second `Promise.race` timeout per API call. Prevents indefinite hangs if the Gemini API never responds. |
| **429 detection** | `isRateLimitError(error)` — checks for `"429"`, `"quota"`, `"resource has been exhausted"`, `"rate limit"` in the error message. |
| **Retry backoff** | Non-429: exponential 1s → 2s → 4s → 8s → 16s (MAX_RETRIES = 5). 429: linear 60s → 120s → 180s → 240s → 300s (allowing the quota window to reset). |
| **Concurrency** | `PHASE2_CONCURRENCY = 5` limits concurrent LLM calls to avoid quota bursting (≈ 100 RPM at 3s/call — safe on paid tier; paced recovery on free tier). |
| **No permanent failure on 429** | Rows that exhaust retries due to rate-limiting are **not** marked `processed = true`. The processor re-queues itself with a 60-second delay so they are retried on the next run. |

---

## Quick Seed Interview

After the initial Plaid sync, any `seedHeld=true` PlaidTransactions are surfaced to the user via the Quick Seed modal before the main review queue.

### `GET /api/plaid/transactions/seeds`

Returns all `seedHeld=true` PlaidTransactions for the item, grouped by normalised description (sorted by frequency). Includes LLM, VECTOR_MATCH, and VECTOR_MATCH_GLOBAL rows.

- **Query params**: `plaidItemId` (required), `limit` (default 15, max 50)
- **Badge labels in UI**: `VECTOR_MATCH_GLOBAL` → "Global", `VECTOR_MATCH` → "Match", `LLM` → "AI" (+ confidence %)

### `POST /api/plaid/transactions/confirm-seeds`

Processes the user's seed decisions.

- **Body**: `{ plaidItemId, seeds: [{ description: string, rawName?: string, confirmedCategoryId: number }] }`
  - `seeds` may be an empty array (e.g. when the user clicks "Skip for now"). In this case, the for-loop simply does not iterate and execution falls through to the release step.
- **Confirmed seeds**: promoted to `Transaction` records; `seedHeld = false`; `recordFeedback()` called to update embedding index.
- **Excluded seeds**: any `seedHeld=true` rows still remaining after confirmed seeds are processed (user clicked X) are batch-released via `updateMany`: `seedHeld = false`, `promotionStatus = 'CLASSIFIED'`. This moves excluded transactions to the pending review queue with their AI suggestion intact — they are not discarded.
- **Response**: `{ confirmed: N, promoted: N }`

---

## Manual Review & Promotion API

See [`bliss-finance-api/specs/10-ai-classification-and-review.md`](../../bliss-finance-api/specs/10-ai-classification-and-review.md):

- **Category override** — `PUT /api/plaid/transactions/:id` with `suggestedCategoryId`
- **Skip** — `PUT /api/plaid/transactions/:id` with `promotionStatus: 'SKIPPED'`
- **Re-queue** — `PUT /api/plaid/transactions/:id` with `promotionStatus: 'CLASSIFIED'` (only from `SKIPPED`)
- **Promote** — `PUT /api/plaid/transactions/:id` with `promotionStatus: 'PROMOTED'`, optional investment fields
- **Bulk promote** — `POST /api/plaid/transactions/bulk-promote` (excludes `requiresEnrichment: true` rows)

---

## Historical Sync Transparency

When a user connects a new bank, the initial sync retrieves only the last 30–90 days. Plaid asynchronously backfills up to 2 years and fires a `TRANSACTIONS.HISTORICAL_UPDATE` webhook when done (can take hours to days).

**PlaidItem fields:**

| Field | Type | Default | Updated by |
|---|---|---|---|
| `historicalSyncComplete` | `Boolean` | `false` | Set to `true` when `source === 'WEBHOOK_HISTORICAL_UPDATE'` in `plaidSyncWorker` |
| `earliestTransactionDate` | `DateTime?` | `null` | Updated to the minimum `tx.date` seen across all sync batches (monotonically decreasing) |

**Flow:**
1. Initial sync → `historicalSyncComplete` stays `false`, `earliestTransactionDate` set to oldest date in the initial batch (~90 days ago).
2. Background: Plaid backfills older transactions.
3. Plaid fires `HISTORICAL_UPDATE` → webhook emits `PLAID_SYNC_UPDATES` with `source: 'WEBHOOK_HISTORICAL_UPDATE'`.
4. `plaidSyncWorker` processes the historical batch → `earliestTransactionDate` moves further back → `historicalSyncComplete` flips to `true`.
5. Frontend polls `GET /api/plaid/items` every 60s while any item has `historicalSyncComplete === false`, and auto-stops when all items are complete.

---

## Security

- **Token Encryption**: `accessToken` is AES-256-GCM encrypted at rest in `PlaidItem`. Decrypted automatically by Prisma middleware.
- **Payload Encryption**: `PlaidTransaction.rawJson` is encrypted to protect PII while preserving the exact Plaid response.
- **Webhook Verification**: `POST /api/plaid/webhook` verifies the `plaid-verification-jwt` header using Plaid's JWKS endpoint (`jose` library). Replay attacks are prevented by validating the `iat` claim (5-minute window). Verification is skipped in non-production for sandbox testing convenience. See `bliss-finance-api/specs/08-plaid-integration.md` for full webhook routing details.

---

## Soft Disconnect & Reconnect

When a user clicks **Pause Sync** in the UI:
- `disconnect.js` sets `PlaidItem.status = 'REVOKED'` locally. **`plaidClient.itemRemove()` is never called.**
- The `plaidSyncWorker` skips REVOKED items (status guard at job start).
- The `ITEM.USER_PERMISSION_REVOKED` webhook also sets status to `REVOKED` when the user revokes access directly through their bank.

When a user clicks **Reconnect Bank**:
- Plaid Link opens in update mode (existing `accessToken` is still valid at Plaid).
- On success, `PATCH /api/plaid/items` sets `status = 'ACTIVE'` and triggers an incremental sync.

> **Admin Hard Delete**: A permanent delete endpoint is implemented at `DELETE /api/plaid/items/hard-delete` (admin-only, protected by `X-Admin-Key` header). It calls `plaidClient.itemRemove()`, nullifies linked `Account.plaidAccountId`/`plaidItemId`, and deletes the `PlaidItem` record (cascading `PlaidTransaction` and `PlaidSyncLog`). `Transaction` records are intentionally preserved. See `bliss-finance-api/specs/08-plaid-integration.md` §12 for full details.

---

## Error Handling

| Source | Error Code | Status set |
|---|---|---|
| Plaid API during sync | `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` | **No status change** — cursor reset to `null`, job re-thrown for BullMQ retry |
| Plaid API during sync | `ITEM_LOGIN_REQUIRED` | `LOGIN_REQUIRED` |
| Plaid API during sync | Any other error code | `ERROR` |
| `ITEM.ERROR` webhook | `ITEM_LOGIN_REQUIRED` | `LOGIN_REQUIRED` |
| `ITEM.ERROR` webhook | Other codes | `ERROR` |
| `ITEM.LOGIN_REQUIRED` webhook | — | `LOGIN_REQUIRED` |
| `ITEM.USER_PERMISSION_REVOKED` webhook | — | `REVOKED` |

Failed jobs are logged by BullMQ's `worker.on('failed', ...)` handler. `PlaidSyncLog` records are always written even for failed syncs, including the error message.

---

## Hash-Based Duplicate Detection

During auto-promotion (Phase 2 of `plaidProcessorWorker`), the worker computes a SHA-256 hash of `(isoDate + normalizedDescription + amount + accountId)` for each transaction and checks it against existing `Transaction` records. This catches manual-entry duplicates that `externalId`-based dedup (Plaid's transaction ID) cannot detect — manually entered transactions have `externalId = null`, so they are invisible to the `externalId` guard.

When a hash collision is found, the `PlaidTransaction` is marked with `promotionStatus: 'DUPLICATE'` and is **not** promoted. This prevents the same transaction from appearing twice when a user connects a Plaid account to an existing manual account where transactions were already entered by hand.

---

## Plaid SDK Timeout

All Plaid API calls are configured with a 30-second request timeout (`baseOptions.timeout: 30_000` on the Plaid client configuration). This prevents indefinite hangs if the Plaid API becomes unresponsive.

---

## Bulk Re-Queue

**Endpoint**: `POST /api/plaid/transactions/bulk-requeue`

Moves all `SKIPPED` PlaidTransactions back to `CLASSIFIED` for re-review. Accepts an optional `plaidItemId` filter to scope the operation to a single Plaid connection. Returns `{ updated: number }` with the count of rows transitioned.

See [`bliss-finance-api/specs/08-plaid-integration.md`](../../bliss-finance-api/specs/08-plaid-integration.md) for API-level details.

---

## On-Demand Historical Backfill

Users can request older transactions beyond the initial 90-day `transactionsSync` window by selecting a date from the account detail page. This triggers a backfill via Plaid's `transactionsGet` endpoint, processed as a branch inside the existing `plaidSyncWorker` (no separate queue or worker).

### Event Flow

```
Frontend date picker → POST /api/plaid/fetch-historical
  → produceEvent({ type: 'PLAID_HISTORICAL_BACKFILL', plaidItemId, fromDate })
  → eventSchedulerWorker routes to plaid-sync queue (source: 'HISTORICAL_BACKFILL', fromDate)
  → plaidSyncWorker Branch B (transactionsGet loop)
  → PlaidItem.earliestTransactionDate updated
  → PlaidSyncLog (type: HISTORICAL_BACKFILL)
  → PLAID_SYNC_COMPLETE → plaidProcessorWorker
```

### Event Routing: `eventSchedulerWorker.js`

The `PLAID_HISTORICAL_BACKFILL` case requires both `plaidItemId` and `fromDate`. It routes to the same `plaid-sync` queue with `source: 'HISTORICAL_BACKFILL'` and passes `fromDate` in the job data.

### Constraints

- `fromDate` must be a valid `YYYY-MM-DD` string, within 2 years of today, and not in the future.
- Only `ACTIVE` PlaidItems can be backfilled.
- `createMany({ skipDuplicates: true })` ensures idempotency — overlapping date ranges are safe.
- The `endDate` for the backfill is the item's current `earliestTransactionDate` (or today if null), avoiding re-fetching already-synced transactions.

---

## Future Work

- **Link Plaid to existing manual account**: Allow users who already have a manual Account to associate an incoming Plaid connection with it during `sync-accounts.js` (rather than always creating a new Account). In `sync-accounts.js` this is a small change — set `plaidAccountId`/`plaidItemId` on the existing Account instead of inserting a new one.

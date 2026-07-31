# 10. AI Classification & Review API

This module provides the API layer for reviewing, categorising, and promoting AI-classified Plaid transactions. Transactions are staged in the `PlaidTransaction` table after sync and classification; this API is how users move them into the core `Transaction` table.

> **LLM provider abstraction.** The backend's classification layer supports Gemini, OpenAI, and Anthropic Claude through `services/llm/`. Historical references to "Gemini" in this spec describe the Tier 4 LLM in provider-agnostic terms — whichever provider is configured via `LLM_PROVIDER` in the deployment's environment. See [Backend Spec 20](../backend/20-llm-provider-abstraction.md).

---

## Tenant Classification Settings

**GET** `/api/tenants/settings`

- **Purpose**: Returns the tenant's AI classification thresholds.
- **Auth**: JWT.
- **Response**: `{ autoPromoteThreshold: number, reviewThreshold: number }` — values in range [0.0, 1.0].

**PUT** `/api/tenants/settings`

- **Purpose**: Updates one or both thresholds for the authenticated tenant.
- **Auth**: JWT (admin only).
- **Body**: `{ autoPromoteThreshold?: number, reviewThreshold?: number }` — both optional; validated 0.0–1.0.
- **Response**: Updated `{ autoPromoteThreshold, reviewThreshold }`.
- **Effect**: Workers pick up the new values on their next job (no restart required — values are fetched fresh per job).

---

## Endpoints

### List Transactions for Review

**GET** `/api/plaid/transactions`

- **Purpose**: Returns paginated `PlaidTransaction` records for the authenticated tenant, enriched with category names, account names, and institution names.
- **Default filter**: `promotionStatus: 'CLASSIFIED'` (only transactions that have been classified but not yet actioned).
- **Query params**:
  - `?plaidItemId` — filter by specific Plaid connection
  - `?promotionStatus` — `CLASSIFIED`, `PENDING`, `PROMOTED`, `SKIPPED`, `FAILED`, or `ALL`
  - `?minConfidence`, `?maxConfidence` — filter by AI confidence range
  - `?categoryId` — optional integer. Filters rows to a single `suggestedCategoryId`. Used by the grouped-view to paginate within one category group without re-fetching all rows.
  - `?uncategorized=true` — optional boolean. Filters rows to those with `suggestedCategoryId IS NULL`. Mutually exclusive with `?categoryId` (when both are sent, `?uncategorized` wins). Needed so the "Uncategorized" group in the grouped view is drillable.
  - `?page`, `?limit`
- **Response**: `{ transactions, pagination, summary }` where `summary` contains counts across all statuses and a category breakdown:
  - `classified` — `promotionStatus = 'CLASSIFIED'` (awaiting user review)
  - `pending` — `promotionStatus = 'PENDING'` AND `seedHeld = false` (still being classified)
  - `promoted` — `promotionStatus = 'PROMOTED'`
  - `skipped` — `promotionStatus = 'SKIPPED'`
  - `failed` — `promotionStatus = 'FAILED'` (all classification tiers errored out after one silent worker retry — see `docs/specs/backend/08-plaid-integration.md#classification-failure--retry`)
  - `seedHeld` — `seedHeld = true` (held for Quick Seed interview; counted separately from `pending`)
  - `categoryBreakdown` — **server-side groupBy across all `CLASSIFIED` and `FAILED` transactions** (not just the current page). Array of `{ categoryId, category: { id, name, group, type }, count }`, sorted descending by count. Scoped to the same `plaidItemId` filter as the transaction query. Used by grouped-view headers to show accurate cross-page per-category totals without additional requests. `FAILED` is included alongside `CLASSIFIED` specifically so the Uncategorized group header appears even when a tenant has zero CLASSIFIED-uncategorized rows — otherwise a FAILED-only backlog would have no group to attach to and would silently disappear from the grouped view.

---

### Single Transaction Actions

**PUT** `/api/plaid/transactions/:id`

- **Purpose**: Handles four distinct actions depending on the request body.
- **Security**: Validates tenant ownership of the `PlaidTransaction` and prevents re-actioning already-promoted records.

**Category Override** (`{ suggestedCategoryId }` only):
- Updates `suggestedCategoryId`, sets `classificationSource: 'USER_OVERRIDE'`, `aiConfidence: 1.0`.
- No `Transaction` record created yet — this only updates the staging row.
- Fires a fire-and-forget `POST /api/feedback` to the backend service to update the description cache and vector index.

**Skip** (`{ promotionStatus: 'SKIPPED' }`):
- Sets `promotionStatus: 'SKIPPED'`. Transaction will not appear in future review queues.

**Re-queue** (`{ promotionStatus: 'CLASSIFIED' }` from a `SKIPPED` record):
- Transitions a previously skipped transaction back to `CLASSIFIED` so it reappears in the review queue.
- Guard: only allows `SKIPPED` → `CLASSIFIED` (not from `PROMOTED`).

**Promote** (`{ promotionStatus: 'PROMOTED' }`):
- Works identically from `CLASSIFIED` or `FAILED` — the endpoint only blocks rows already `promotionStatus === 'PROMOTED'`. A `FAILED` row is just a row with no AI-suggested category yet; the user supplies one manually.
- Requires a `suggestedCategoryId` (either existing or provided in the same request).
- Optional fields accepted at promote time:
  - `details?: string` — overrides the default `plaidTx.name` used as the `Transaction.details` field.
  - `ticker?: string`, `assetQuantity?: number`, `assetPrice?: number` — investment enrichment fields. Required (validation enforced) when the target category has an investment `processingHint` (`API_STOCK`, `API_CRYPTO`, `API_FUND`, or `MANUAL`).
  - `tags?: string[]` — optional tag names to attach to the newly created `Transaction`. Resolved via the shared `resolveTagsByName()` helper (`apps/api/utils/tagUtils.js`) — find-or-create by name, the same function used by `POST /api/transactions` and Smart Import commit. Called with the top-level `prisma` client *before* the `$transaction` block (`resolveTagsByName()` doesn't accept a transaction client). Only applied when a new `Transaction` is created — the externalId-dedup branch below does not retroactively apply tags to an already-promoted match.
- Atomically (within a Prisma transaction):
  1. Creates a `Transaction` record with `source: 'PLAID'` and `externalId: plaidTransactionId` (dedup guard).
  2. Updates `PlaidTransaction.promotionStatus = 'PROMOTED'` and sets `matchedTransactionId`.
- **Amount convention**: Plaid positive amounts = debit (money leaving), negative = credit (money entering).
- **Event**: Emits `TRANSACTIONS_IMPORTED` with `accountIds: [localAccount.id]` and `dateScope: { year, month }` to trigger the scoped analytics chain.
- **Dedup**: If a `Transaction` with the same `externalId` already exists, skips creation and just marks the PlaidTransaction as promoted.
- **Feedback**: Fires a fire-and-forget `POST /api/feedback` after the commit.

---

### Retry Classification

**POST** `/api/plaid/transactions/:id/retry`

- **Purpose**: Manually retries classification for a `FAILED` PlaidTransaction. Follows the project's "routes validate + enqueue + return, workers do the work" convention — this route never calls classification inline.
- **Security**: Validates tenant ownership. Returns `409 Conflict` if `promotionStatus !== 'FAILED'`.
- **Workflow**:
  1. Resets the row: `processed: false`, `promotionStatus: 'PENDING'`, `processingError: null`, `classificationRetryCount: 1`.
  2. Produces a `PLAID_TRANSACTION_RETRY` event (`{ tenantId, plaidItemId }`) — `eventSchedulerWorker` routes it to the `plaid-processing` queue with **no delay** (user-initiated, unlike the worker's own 60-second silent-retry re-queue).
  3. Returns `202 Accepted` with the reset row immediately; the actual reclassification happens asynchronously when `plaidProcessorWorker` picks up the job.
- **Why `classificationRetryCount: 1`, not `0`**: this is deliberate, not a typo. It means if the retried attempt also fails, the worker's own two-phase retry logic sends it straight back to `FAILED` rather than silently scheduling another invisible 60-second retry — a user-initiated Retry must always resolve to a new terminal state (`CLASSIFIED`/`PROMOTED` on success, `FAILED` again on repeat failure), never back to an ambiguous wait.
- **Rate limit**: `plaidReview` limiter, same as the other single-row actions.

---

### Bulk Promote

**POST** `/api/plaid/transactions/bulk-promote`

- **Purpose**: Promotes `CLASSIFIED` transactions in a single batch operation, with optional filters and category override.
- **Body**:

| Field | Type | Default | Description |
|---|---|---|---|
| `minConfidence` | `number` | `0.80` | Minimum AI confidence required for promotion. Ignored when `transactionIds` is provided. |
| `transactionIds` | `string[]` | `null` | When provided, promotes only these specific PlaidTransaction IDs. **Bypasses the `minConfidence` gate entirely** — the user has explicitly selected these rows. |
| `plaidItemId` | `string` | `null` | Filter to transactions from a single Plaid connection. Must belong to the authenticated tenant. |
| `categoryId` | `number` | `null` | Filter to transactions whose `suggestedCategoryId` matches this value. |
| `overrideCategoryId` | `number` | `null` | When set, **every promoted transaction receives this category** regardless of its existing `suggestedCategoryId`. Sets `classificationSource: 'USER_OVERRIDE'` and `aiConfidence: 1.0` on the staging row. Validated to belong to the tenant. When set, the `suggestedCategoryId: not null` filter is relaxed (the override supplies the category). |
| `tags` | `string[]` | `null` | Optional tag names (find-or-create via `resolveTagsByName()`) applied to **every newly-created `Transaction`** in the batch — same one-to-many semantics as `overrideCategoryId`. Used by the drawer's "Promote all N matching transactions" dialog to carry the drawer's tag selection to every sibling transaction, not just the one being directly edited. Never retroactively applied to dedup-linked ("already existing") transactions. |

- **Investment filter**: Transactions with `requiresEnrichment: true` are **always excluded** — they require user-provided ticker/quantity/price and must be promoted individually via the drawer.
- **Workflow**:
  1. Validates `overrideCategoryId` belongs to the authenticated tenant (if provided).
  2. Queries all eligible `CLASSIFIED` PlaidTransactions matching the filters.
  3. **Batch dedup**: Single `findMany` fetches all existing `Transaction` records by `externalId` up-front (O(1) Map lookup per row — avoids N sequential DB roundtrips).
  4. **Parallel execution**: `Promise.all` within batches of 100 — each batch runs concurrently.
  5. For each transaction: creates a `Transaction` record and marks the PlaidTransaction as `PROMOTED`. If `overrideCategoryId` is set, uses it as `effectiveCategoryId` and updates the staging row's `suggestedCategoryId`/`classificationSource`/`aiConfidence`.
  6. **Tag attachment** (if `tags` provided): tag names are resolved once via `resolveTagsByName()` — skipped entirely if there are no transactions to create, so a batch that resolves to zero new transactions never creates a phantom `Tag` row. Because transactions are batch-inserted via `prisma.transaction.createMany()` (which cannot perform nested relation writes), tags are attached in a **second, independent** `prisma.transactionTag.createMany()` call after the transaction IDs are known. This step is deliberately best-effort: a failure here is caught, logged to Sentry, and reflected only in the `tagsApplied: false` response flag — it never rolls back or blocks the promote, consistent with this endpoint's existing non-atomic batch design (see the file-level comment: batch operations are used instead of per-row interactive transactions to avoid exhausting the Prisma connection pool).
  7. Emits one consolidated `TRANSACTIONS_IMPORTED` event covering all `accountIds` and `dateScopes`.
- **Response**: `{ promoted: N, skipped: M, errors: N, tagsApplied?: boolean }` — `skipped` includes already-promoted, dedup-skipped, and investment-enrichment-required records; `errors` is a count of per-row failures (the batch continues even when individual rows fail); `tagsApplied` is present only when `tags` was provided in the request.
- **Rate limit**: `plaidReview` limiter (150 requests per 5 minutes).

---

## Data Model

### `PlaidTransaction` — Full Field Reference

The staging table for raw Plaid data, extended with AI classification and investment enrichment fields.

| Field | Description |
|---|---|
| `suggestedCategoryId` | FK to `Category` — AI or user-assigned |
| `aiConfidence` | 0.0–1.0 score from classification pipeline |
| `classificationSource` | `'EXACT_MATCH'` / `'VECTOR_MATCH'` / `'VECTOR_MATCH_GLOBAL'` / `'LLM'` / `'LLM_UNKNOWN'` / `'USER_OVERRIDE'`. `'LLM_UNKNOWN'` is set when the LLM invokes the explicit ambiguous-fallback (`categoryId: null`) — the row is left unclassified and surfaces in the review queue. |
| `classificationReasoning` | Free-text reasoning string returned by the configured LLM provider. `null` for `EXACT_MATCH` and `VECTOR_MATCH` results. Displayed in the Transaction Review deep-dive drawer. |
| `promotionStatus` | `'PENDING'` / `'CLASSIFIED'` / `'PROMOTED'` / `'SKIPPED'` / `'FAILED'` |
| `classificationRetryCount` | `Int`, default `0`. Number of silent auto-retries the worker has given this row before marking it terminally `FAILED`. Reset to `1` (not `0`) by the manual `POST .../retry` endpoint — see that endpoint's docs above. |
| `matchedTransactionId` | FK to `Transaction` — set on promote |
| `requiresEnrichment` | `true` for investment transactions that need ticker/quantity/price before promotion. Never auto-promoted regardless of confidence. |
| `enrichmentType` | `'INVESTMENT'` when `requiresEnrichment` is true |
| `category` | JSON — Raw Plaid `personal_finance_category` object (`{ primary, detailed, confidence_level }`). Passed to the LLM as a contextual hint during classification. |

### `Tenant` — Classification Thresholds

> Threshold fields live on `Tenant` (not `User`) since they are business rules that apply to all users in the tenant. Managed via `GET/PUT /api/tenants/settings`.

| Field | Default | Description |
|---|---|---|
| `autoPromoteThreshold` | `0.90` | Transactions at or above this confidence are auto-promoted, bypassing the review queue. Default matches `DEFAULT_AUTO_PROMOTE_THRESHOLD` in `apps/backend/src/config/classificationConfig.js`. In practice EXACT_MATCH (1.0) and high-confidence tenant-scoped VECTOR_MATCH routinely reach this threshold. LLM is hard-capped at 0.90 and only enters the 0.86–0.90 band under the ABSOLUTE CERTAINTY criterion (recognized brand + matching Plaid hint + typical amount), so an LLM classification auto-promotes only when all three of those signals agree. Tenants who want LLM never to auto-promote raise this threshold to 0.91+. |
| `reviewThreshold` | `0.70` | Minimum confidence for a VECTOR_MATCH / VECTOR_MATCH_GLOBAL to be accepted. Rows below this threshold fall through to the next tier. Default matches `DEFAULT_REVIEW_THRESHOLD` in `classificationConfig.js`. |

---

## Vector Similarity

The AI classification pipeline runs a three-tier waterfall: Exact Match → Vector Similarity → LLM. The `classificationSource` field on both `PlaidTransaction` and `StagedImportRow` reflects which tier produced the result:

| Source | Description | Confidence range |
|---|---|---|
| `EXACT_MATCH` | Description hash found in the tenant's `DescriptionMapping` table (loaded into in-memory cache) | Always `1.0` |
| `VECTOR_MATCH` | Tenant-scoped pgvector cosine similarity match | `0.70–1.00` |
| `VECTOR_MATCH_GLOBAL` | Cross-tenant pgvector match against GlobalEmbedding (score × 0.92 discount) | `0.64–0.92` |
| `LLM` | Classified by the configured LLM provider (Gemini / OpenAI / Anthropic) | `0.00–0.90` (hard-capped). The 0.86–0.90 ABSOLUTE CERTAINTY band requires recognized brand + matching Plaid hint + typical amount. |
| `LLM_UNKNOWN` | LLM declined the explicit "no category fits" fallback (`categoryId: null`) | `0.00` (always) |
| `USER_OVERRIDE` | User manually changed the category (or auto-confirmed at `autoPromoteThreshold`) | `1.0` |

When a transaction is confirmed (promoted, committed, or overridden), a fire-and-forget `POST /api/feedback` call is sent to the backend service, which updates the in-memory cache, the `DescriptionMapping` table (write-through), and the pgvector embedding index. This means future identical descriptions hit EXACT_MATCH instantly, and semantically-similar transactions are classified by VECTOR_MATCH instead of falling through to LLM.

---

## Merchant History

**GET** `/api/transactions/merchant-history`

- **Purpose**: Returns recent `Transaction` records for the same merchant/description. Powers the Merchant History section in the Transaction Review deep-dive drawer.
- **Auth**: JWT.
- **Query params**: `description` (required), `limit` (optional, default 10).
- **Response**: Array of `{ id, date, amount, currencyCode, categoryName, source }`.

---

## Additional Endpoints

### Bulk Re-queue

**POST** `/api/plaid/transactions/bulk-requeue`

- **Purpose**: Transitions multiple `SKIPPED` PlaidTransactions back to `CLASSIFIED` so they reappear in the review queue.
- **Auth**: JWT.
- **Body**: `{ transactionIds: string[] }` — IDs of PlaidTransactions to re-queue.
- **Response**: `{ requeued: N, skipped: M }`.

### Seed Transactions

**GET** `/api/plaid/transactions/seeds`

- **Purpose**: Returns PlaidTransactions held for the Quick Seed interview (`seedHeld: true`). These are high-frequency descriptions classified during Phase 1 that require user confirmation before Phase 2 processing continues.
- **Auth**: JWT.
- **Response**: Array of seed PlaidTransactions with suggested categories and classification details.

**POST** `/api/plaid/transactions/confirm-seeds`

- **Purpose**: Confirms or overrides categories for seed-held transactions. On confirmation, promotes held transactions and releases any excluded seeds to `promotionStatus: CLASSIFIED` (pending review queue).
- **Auth**: JWT.
- **Body**: Array of `{ id: string, suggestedCategoryId: number }` — one entry per seed transaction.
- **Response**: `{ confirmed: N, released: M }`.

---

## Future Work

- **Investment enrichment for Smart Import**: The `StagedImportRow` model has `requiresEnrichment`, `enrichmentType`, `ticker`, `assetQuantity`, and `assetPrice` fields, but the Smart Import commit endpoint validation and the Transaction Review drawer smart-import path for investment enrichment may need further hardening.

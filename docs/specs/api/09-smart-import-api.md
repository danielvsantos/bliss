# 9. Smart Import API

This module provides the API layer for the intelligent CSV/XLSX import pipeline. It handles adapter detection, file upload, staged import retrieval, row-level overrides, and commit/cancel actions.

See `docs/specs/backend/09-smart-import.md` for the backend worker pipeline that processes uploaded files.

---

## Endpoints

### Adapter Management

**GET** `/api/imports/adapters`

- **Purpose**: Lists all available `ImportAdapter` records — both global (tenantId: null) and tenant-specific.
- **Response**: Array of adapters with `id`, `name`, `description`, `amountStrategy`, `matchSignature`.

**POST** `/api/imports/adapters`

- **Purpose**: Creates a new tenant-specific adapter.
- **Body**: `{ name, description, columnMappings, dateFormat, amountStrategy, matchSignature }`
- **Security**: Adapter is scoped to the authenticated tenant; global adapters cannot be created via this endpoint.

**PUT** `/api/imports/adapters/:id`

- **Purpose**: Updates an existing tenant-specific adapter.
- **Security**: Only tenant-owned adapters can be modified; global adapters (`tenantId: null`) return 403.
- **Body**: Any subset of `{ name, matchSignature, columnMapping, dateFormat, amountStrategy, currencyDefault, skipRows }`.
- **Response**: `{ adapter }` — updated adapter object.

**DELETE** `/api/imports/adapters/:id`

- **Purpose**: Soft-deletes a tenant-specific adapter (`isActive: false`).
- **Security**: Only tenant-owned adapters can be deleted; global adapters return 403.
- **Response**: 204 No Content.

---

### Adapter Detection

**POST** `/api/imports/detect-adapter`

- **Purpose**: Lightweight detection step. Reads only the first row (headers) and up to 3 data rows from the uploaded file without storing anything.
- **Body**: `multipart/form-data` with `file` field.
- **Accepted file types**: `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (XLSX), `application/vnd.ms-excel` (XLS). Any other MIME type returns `400` with `{ error: "Unsupported file type..." }`.
- **Size limit**: 10 MB maximum. Exceeding this returns `400` with `{ error: "File exceeds maximum allowed size of 10 MB" }`.
- **Response**: `{ matchedAdapter, rawHeaders, previewRows }` — returns the best-matching adapter (if any) and raw data for manual mapping fallback.
- **XLSX**: Reads the first non-empty sheet unless a sheet name is specified.
- **Header filtering**: `__EMPTY` columns (from merged cells) are excluded.

---

### Upload & Processing Start

**POST** `/api/imports/upload`

- **Purpose**: Accepts the file, stores it in GCS, creates a `StagedImport` record, and enqueues the background processing job.
- **Body**: `multipart/form-data` with `file`, `accountId`, `adapterId`.
  - `accountId` is **required** for all adapters except the Bliss Native adapter (`matchSignature.isNative: true`). Native adapters resolve the target account per-row from the CSV `account` column, so `accountId` is optional and may be omitted.
- **Accepted file types**: `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (XLSX), `application/vnd.ms-excel` (XLS). Any other MIME type returns `400` with `{ error: "Unsupported file type..." }`.
- **Size limit**: 10 MB maximum. Exceeding this returns `400` with `{ error: "File exceeds maximum allowed size of 10 MB" }`.
- **Workflow**:
  1. Validate MIME type and file size.
  2. Upload file to GCS with a UUID-keyed path (`imports/{tenantId}/{uuid}-{filename}`).
  3. Create `StagedImport { status: 'PROCESSING', progress: 0 }`.
  4. Emit `SMART_IMPORT_REQUESTED` event → backend `smartImportWorker` picks it up.
- **Response**: `{ stagedImportId, status: 'PROCESSING', message }` — returned immediately; processing is asynchronous.
- **Rate limit**: `importsUpload` limiter (stricter than read endpoints).

---

### Import Status & Rows

**GET** `/api/imports/:id`

- **Purpose**: Returns the `StagedImport` record and a paginated list of `StagedImportRow` records enriched with category names.
- **`seedReady` field**: When the worker finishes and `StagedImport.seedReady === true`, the response includes this flag. The frontend uses it to gate the Quick Classify step — the status transition to `'review'` is intentionally blocked when `seedReady=true` so the seeds can be presented first.
- **Query params**:
  - `?page` (default 1), `?limit` (default 50, max 200)
  - `?status` — filter by row status. Accepts a **single value** (e.g. `status=CONFIRMED`) or a **comma-separated list** (e.g. `status=STAGED,POTENTIAL_DUPLICATE`). When multiple values are provided, the query uses an `IN` clause. **When omitted, the endpoint defaults to `['PENDING', 'POTENTIAL_DUPLICATE', 'CONFIRMED', 'ERROR', 'STAGED']` — `DUPLICATE` (hard duplicate with a wall-clock timestamp match) and `SKIPPED` rows are deliberately hidden** so duplicate-flagged rows can never reach the Review UI as committable. Callers that need to audit those rows must opt in explicitly (e.g. `?status=DUPLICATE`).
  - `?categoryId` — optional integer. Filters rows to a single `suggestedCategoryId`. Used by the grouped-view to paginate within one category group without re-fetching all rows.
  - `?uncategorized=true` — optional boolean. Filters rows to those with `suggestedCategoryId IS NULL`. Mutually exclusive with `?categoryId` (when both are sent, `?uncategorized` wins). Needed so the "Uncategorized" group in the grouped view is drillable.
- **Response**: `{ import, rows, categorySummary, pagination }`:
  - `import` — the `StagedImport` record, including a `statusSummary` map of `{ PENDING: N, CONFIRMED: N, STAGED: N, POTENTIAL_DUPLICATE: N, ... }` and `earliestTransactionDate`.
  - `rows` — paginated `StagedImportRow` records, each enriched with `suggestedCategory: { id, name, group, type }`.
  - `categorySummary` — **server-side groupBy across all pending rows** (regardless of the current page). Each entry is `{ categoryId, category: { id, name, group, type }, count }`, sorted descending by count. Computed against the same status filter used for `rows` (default excludes `DUPLICATE` and `SKIPPED`), so grouped-view headers always match the items visible in the paginated list. Used to show accurate cross-page totals without additional requests.
  - `pagination` — `{ page, limit, total, totalPages }`.
- **Polling**: The frontend polls this endpoint every 2 seconds while `import.status === 'PROCESSING'`.

**GET** `/api/imports/pending`

- **Purpose**: Lists all `READY` imports for the tenant with uncommitted row counts — used by the Transaction Review page to populate the Imports tab.
- **Response**: `{ imports: [{ id, fileName, adapterName, accountId, totalRows, pendingRowCount, createdAt }] }`
- **Caching**: `Cache-Control: no-store, no-cache, must-revalidate` — browser caching is explicitly disabled to prevent stale 304 responses.

---

### Import Seeds (Quick Classify)

**GET** `/api/imports/:id/seeds`

- **Purpose**: Returns the seed items for the Quick Classify modal. Only available when `StagedImport.seedReady === true`.
- **Auth**: JWT.
- **Query params**: `limit` (optional, default 15, max 50).
- **Response**: Array of seed objects, each representing a unique normalised description with the AI category suggestion, confidence, classificationSource, and count of matching rows. Only rows classified by LLM, VECTOR_MATCH, or VECTOR_MATCH_GLOBAL below `autoPromoteThreshold` are returned. EXACT_MATCH rows are never included (they have no classification uncertainty).
- **Badge labels** (used by the frontend): `VECTOR_MATCH_GLOBAL` → "Global", `VECTOR_MATCH` → "Match", `LLM` → "AI".

---

### Confirm Seeds (Quick Classify)

**POST** `/api/imports/:id/confirm-seeds`

- **Purpose**: Confirms user-reviewed seed categories and applies them across matching rows in the staged import.
- **Auth**: JWT.
- **Body**: `{ seeds: [{ description: string, categoryId: number, confirmed: boolean }] }`
  - `confirmed: true` — applies the category to all matching rows with the same normalised description.
  - `confirmed: false` — skips the seed (rows remain in their current state for manual review).
- **Post-confirm**:
  - Matching rows are updated with the confirmed `suggestedCategoryId`, `classificationSource: 'USER_OVERRIDE'`, and `confidence: 1.0`.
  - Confirmed rows transition to `status: 'CONFIRMED'`.
  - A batch of fire-and-forget `POST /api/feedback` calls is made to the backend for each confirmed seed, building the in-memory cache and vector embedding index.
- **Response**: `{ updated: N }` — count of rows updated.

---

### Commit & Cancel

**POST** `/api/imports/:id?action=commit`

- **Purpose**: Dispatches an async commit job that promotes staged rows to the core `Transaction` table.
- **Async flow**: The endpoint does **not** create transactions synchronously. Instead:
  1. Validates the `StagedImport` exists and has `status: 'READY'`.
  2. Sets `StagedImport.status = 'COMMITTING'` and `progress = 0`.
  3. Dispatches a `SMART_IMPORT_COMMIT` event to the backend service via `produceEvent()`.
  4. Returns `202 Accepted` immediately.
- **Body (optional)**: `{ rowIds: string[] }` — partial commit; if omitted, every row with `status === 'CONFIRMED'` is promoted. `POTENTIAL_DUPLICATE` and `DUPLICATE` rows are **never** promoted regardless of `rowIds` — the user must first override them to `CONFIRMED` via `PUT /api/imports/:id/rows/:rowId`. This is the data-integrity guard that prevents accidental re-imports from silently landing in the `Transaction` table.
- **Response**: `202 { status: 'COMMITTING', message: 'Commit process started. Poll for progress.' }`
- **Error handling**: If `produceEvent()` fails, the status is reverted to `READY` (with `progress: 100`) and the endpoint returns `500 { error: 'Failed to start commit process' }`.
- **Frontend polling**: The frontend polls `GET /api/imports/:id` while `status === 'COMMITTING'`. The backend `commitWorker` updates `StagedImport.progress` (0→85% batch processing, 90% embeddings, 100% done) and stores the final result in `StagedImport.errorDetails.commitResult` as `{ transactionCount: N, remaining: M }`.
- **Status lifecycle**: `PROCESSING → READY → COMMITTING → COMMITTED` (all rows done) or `COMMITTING → READY` (partial commit with remaining rows).

> **Actual commit logic**: Transaction creation, tag linking, embedding feedback, and `TRANSACTIONS_IMPORTED` event emission all happen in the backend `commitWorker.js` (see `docs/specs/backend/09-smart-import.md` §9.6). The API endpoint is a thin dispatcher.

**POST** `/api/imports/:id?action=cancel`

- **Purpose**: Cancels the import. No rows are promoted.
- **Guard**: Cannot cancel an already-committed import.

---

### Row Override

**PUT** `/api/imports/:id/rows/:rowId`

- **Purpose**: Allows per-row overrides before commit.
- **Body**: `{ suggestedCategoryId?, status?, notes?, tags? }`
  - Category override: sets `classificationSource: 'USER_OVERRIDE'`, `confidence: 1.0`.
  - Status override: sets `status` to `'CONFIRMED'`, `'SKIPPED'`, or `'PENDING'`.
  - Notes: freeform text stored on the row, displayed in the review UI.
  - Tags: `string[] | null` — array of tag name strings. Tags are auto-created and linked to the transaction at commit time. Pass `null` to clear.

> **Feedback side effect**: When `suggestedCategoryId` is changed (category override), a fire-and-forget `POST /api/feedback` is sent to the backend service to update the description cache. This is non-fatal — the row update succeeds even if the feedback call fails.

---

### Vector Similarity Suggestions

**GET** `/api/imports/similar`

- **Purpose**: Returns the top-5 previously-classified transactions that are semantically similar to the given description. Intended to power "did you mean?" category suggestions in the import review UI.
- **Auth**: JWT.
- **Query params**: `?description=` (required) — the raw transaction description to search for.
- **Workflow**:
  1. Authenticates the user, extracts `tenantId`.
  2. Proxies to the backend service's `GET /api/similar?description=...&tenantId=...&limit=5&threshold=0.70`.
  3. Returns the backend's response with similarity scores and category names.
- **Response**: `{ results: [{ description, categoryId, categoryName, similarity, source }] }`
- **Use case**: Display the top suggestion(s) when a user is manually reviewing an unclassified or questionable import row.

---

## Data Models

- **`StagedImport`**: Import session record. See `docs/specs/backend/09-smart-import.md` for full schema.
- **`StagedImportRow`**: Individual staged row. See `docs/specs/backend/09-smart-import.md` for full schema.
- **`ImportAdapter`**: Adapter definition with `matchSignature`, `columnMappings`, `amountStrategy`, `dateFormat`. Can be global (`tenantId: null`) or tenant-specific.

---

## Transaction Export

**GET** `/api/transactions/export`

- **Purpose**: Exports the user's transactions as a downloadable Bliss Native CSV with the `id` column populated, enabling round-trip editing through re-import.
- **File**: `pages/api/transactions/export.js`
- **Auth**: JWT.
- **Query params**: Same filter set as `GET /api/transactions` — `startDate`, `endDate`, `accountId`, `categoryId`, `categoryGroup`, `type`, `tags`, `source`, `currencyCode`, `group`.
- **No pagination**: All matching transactions are streamed as a single CSV response.
- **Response headers**:
  - `Content-Type: text/csv; charset=utf-8`
  - `Content-Disposition: attachment; filename="bliss-export-YYYY-MM-DD.csv"`
- **Response body**: UTF-8 CSV with BOM (`\uFEFF`) for Excel compatibility. Columns: `id`, `transactiondate`, `description`, `debit`, `credit`, `account`, `category`, `currency`, `details`, `ticker`, `assetquantity`, `assetprice`, `tags` (pipe-separated).
- **Empty export**: Returns only the header row if no transactions match (no 404).
- **Rate limit**: `transactions` limiter (same as `GET /api/transactions`).

> **Encryption note**: `description` and `details` are AES-256-GCM encrypted at rest. Prisma middleware decrypts them transparently during the query.

---

## Update Support (CSV Round-Trip)

When a Bliss Native CSV with an `id` column is re-imported, the Smart Import pipeline detects existing transactions and treats matching rows as updates rather than inserts. The following changes support this flow.

### Import Status — Additional Fields

**GET** `/api/imports/:id`

- `import.updateCount` — the number of rows targeting existing transactions for update.
- Each `StagedImportRow` now includes:
  - `updateTargetId` (`Int | null`) — the target `Transaction.id` if this is an update row.
  - `updateDiff` (`JSON | null`) — computed diff showing what will change:
    ```json
    { "fieldName": { "old": "...", "new": "...", "oldName": "...", "newName": "..." } }
    ```
    `oldName`/`newName` are present for ID-based fields (`categoryId`, `accountId`) to provide human-readable labels.

### Row Override — Diff Recomputation

**PUT** `/api/imports/:id/rows/:rowId`

- For update rows (`updateTargetId` is set), changing `suggestedCategoryId` or `status` recomputes `updateDiff` against the target transaction's current state, keeping the review UI diff fresh.
- No changes to the body schema.

### Commit Result — Update Count

**POST** `/api/imports/:id?action=commit`

- No API-level changes to the commit dispatcher. The backend `commitWorker` handles create/update partitioning.
- `errorDetails.commitResult` (returned via polling) now includes `updateCount`:
  ```json
  { "transactionCount": 10, "updateCount": 5, "remaining": 2 }
  ```

### Data Model Additions

**`StagedImportRow`** — new fields:

| Field | Type | Nullable | Description |
|-------|------|----------|-------------|
| `updateTargetId` | `Int` | Yes | FK to `Transaction.id`. Non-null = update row. |
| `updateDiff` | `Json` | Yes | Computed diff between CSV values and existing transaction. |

**`StagedImport`** — new fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `updateCount` | `Int` | `0` | Count of rows targeting existing transactions. |

See `docs/specs/backend/17-transaction-export-update.md` for backend pipeline details.


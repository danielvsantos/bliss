# 9. Smart Import Pipeline (Backend)

## 9.1. Overview

The Smart Import pipeline provides an intelligent, adapter-driven import flow for CSV and XLSX/XLS files. It is designed to handle the variety of export formats produced by different banks and financial institutions, deduplicating against existing transactions and classifying each row via the AI pipeline before presenting results for user review.

Smart import uses its own queue (`smart-import`), worker (`smartImportWorker.js`), staging tables (`StagedImport`, `StagedImportRow`), and API (`/api/imports/*`). The "Bliss Native CSV" global system adapter (`matchSignature.isNative: true`) enables direct CSV import without AI classification — it resolves account and category by name or ID from CSV columns and auto-confirms fully-resolved rows.

---

## 9.2. Adapter Engine (`adapterEngine.js`)

The adapter engine is responsible for detecting which adapter matches an uploaded file and parsing its rows into a normalised format.

### Adapter Detection

Each `ImportAdapter` record carries a `matchSignature` JSON object:

```json
{
  "headers": ["Date", "Amount", "Description"],
  "sheet": "Sheet1"
}
```

Detection logic:
1. For XLSX files: reads the sheet specified in `matchSignature.sheet` (falls back to sheet index 0). Filters out `__EMPTY` column keys produced by merged cells.
2. For CSV files: reads the first row as headers.
3. Computes intersection of file headers vs `matchSignature.headers` — best match wins.
4. Returns the matching `ImportAdapter` or `null` if no match found.

**Caching**: Adapter definitions are cached in Redis (5-minute TTL) to avoid repeated DB lookups across concurrent import jobs.

### Amount Strategies

Adapters declare one of four amount parsing strategies via `amountStrategy`:

- `SINGLE_SIGNED` — one amount column; positive = credit, negative = debit.
- `SINGLE_SIGNED_INVERTED` — one amount column with inverted sign convention; positive = debit, negative = credit. Used by banks like American Express where charges are positive and payments/refunds are negative.
- `DEBIT_CREDIT_COLUMNS` — two separate columns: `debitColumn` and `creditColumn`.
- `AMOUNT_WITH_TYPE` — one amount column + one type indicator column (`D`/`C`, `debit`/`credit`, etc.).

### Date Parsing

Adapters declare a `dateFormat` string (e.g., `DD/MM/YYYY`, `MM-DD-YYYY`, `YYYY-MM-DD`). The engine normalises all parsed dates to ISO 8601 before storing.

---

## 9.3. Queue & Worker

### Queue: `smartImportQueue.js`
**Queue name**: `smart-import`

BullMQ singleton, registered in `src/index.js` via `startSmartImportWorker()`. The same queue handles both the staging job (`process-smart-import`) and the commit job (`commit-smart-import`), dispatched by a single worker that routes by `job.name`.

### Worker: `smartImportWorker.js`

**Trigger**: `SMART_IMPORT_REQUESTED` event → `eventSchedulerWorker.js` enqueues `process-smart-import` job.

**Full pipeline**:

1. **Download** — Fetches the uploaded file from GCS as a buffer (XLSX) or UTF-8 string (CSV). Writes to a temp file.
2. **Load adapter** — Fetches `ImportAdapter` from DB by `adapterId`. Throws if not found.
3. **Parse** — Calls `adapterEngine.parseFile(fileContent, adapter, fileType)` → returns `ParsedRow[]` with normalised `{ date, debit, credit, description, details, currency, ticker, assetQuantity, assetPrice, tags, rawData }`.
4. **Warm caches** — Calls `descriptionCache.warmDescriptionCache(tenantId)` (loads from `DescriptionMapping` table) and `getCategoriesForTenant(tenantId)`. For native adapters, also loads tenant accounts and categories for name→ID resolution.
5. **Build duplicate hash set** — Queries existing `Transaction` records for the target account within the batch's date range (with a 1-day buffer on each side for timezone edge cases; falls back to a 90-day window when no dates are available). Computes SHA-256 hashes and loads into an in-memory `Set`. For native adapters, duplicate sets are built per-account lazily as each unique `accountId` is encountered.
6. **First pass — validate, dedup, and native classification** — For each parsed row, builds a `rowData` object and:
   - Validates required fields (`date`, `debit`/`credit`). Missing fields → `status: 'ERROR'`.
   - Computes the dedup hash and checks against the hash set via the `applyDuplicateStatus()` helper:
     - Exact match with a wall-clock timestamp on the parsed date → `status: 'DUPLICATE'` (hard duplicate; hidden from the Review UI by default — see [GET /api/imports/[id]](../api/09-smart-import-api.md))
     - Match on date-only (no time component) → `status: 'POTENTIAL_DUPLICATE'` (surfaced in Review with a warning badge so the user can explicitly override to CONFIRMED if it really is a distinct transaction)
     - No match → `status: 'PENDING'` and the hash is added to the set so subsequent CSV rows with the same fingerprint are also flagged
   - Duplicate-flagged rows are still classified so the suggested category is available to the user if they choose to override. They are **never** auto-confirmed (see `applyClassificationToRowData()` — auto-promote only fires on `status === 'PENDING'`).
   - **Native adapter path**: Resolves `account` and `category` CSV columns to IDs using tenant lookup maps. Rows with both resolved + no duplicate conflict are set to `status: 'CONFIRMED'`. Unresolvable rows stay `PENDING` with an `errorMessage`. Investment fields (`ticker`, `assetQuantity`, `assetPrice`) are taken directly from the CSV; `requiresEnrichment` is always `false`.
   - **AI adapter path**: Row is added to the `aiEntries` list for Phase 1/2 classification. Classification is **not** performed inline — all AI rows are collected first to enable frequency-based ordering.
   - Progress → 1%.

**Phase 1 — Frequency-first seed classification** (AI rows only):
   - Groups AI rows by normalised description and sorts groups by frequency (highest first).
   - Classifies one representative per unique description via `categorizationService.classify()` (up to `TOP_N_SEEDS` LLM calls).
   - Applies results to all rows sharing that description via `applyClassificationToRowData()`.
   - Rows where `confidence >= autoPromoteThreshold` are auto-confirmed (`status: 'CONFIRMED'`). No embeddings are generated here — deferred to commit time.
   - Sets `StagedImport.seedReady = true` and progress → 30%.

**Phase 2 — Parallel classification of remaining AI rows**:
   - Processes rows not touched by Phase 1 (still `classificationSource === null`).
   - Sorted ascending by frequency (rarest descriptions first).
   - Runs with bounded concurrency via `p-limit` (`PHASE2_CONCURRENCY`).
   - Progress updates every 50 rows (30→80%).

**Step 6b — Ticker metadata resolution**:
   - Collects all `rowData` objects that have a `ticker` but no `isin` (native adapter investment rows).
   - Pre-groups them by ticker into a `Map<ticker, rowData[]>` to avoid repeated scans.
   - **Branches on `processingHint`** to use the correct TwelveData search path:
     - **`API_CRYPTO`**: Calls `cryptoService.searchCrypto(ticker)` (1 API credit). Filters for `digital currency` type, deduplicates pairs (e.g. `BTC/USD` + `BTC/EUR` → `BTC`), and normalises the ticker to the base symbol. `getSymbolProfile()` is **not** called for crypto.
     - **`API_STOCK` / `API_FUND`**: Calls `searchSymbol()` and `getSymbolProfile()` **concurrently** via `Promise.all()` (2 API credits). Disambiguates using currencies present on the rows (currency match → exact symbol match → first result). Writes `exchange` (MIC code), `assetCurrency`, and `isin` back to all matching `rowData` objects.
   - Existing values from the CSV are preserved — API results are only written when non-null.
   - This step is **best-effort**: any lookup failure is caught per-ticker and logged as a warning without affecting the import.
   - **Rate limiting**: Uses `acquireImportSlot()` (150 calls/min, ~400ms/slot), separate from the valuation slot queue — see § TwelveData Rate Limiting.

7. **Batch insert** — Inserts all `rowData` objects into `StagedImportRow` in batches of 20 via `prisma.stagedImportRow.createMany()`. Progress → 90% → 100%.
8. **Finalise** — Sets `StagedImport.status = 'READY'`, `totalRows`, `errorCount`, and `autoConfirmedCount`.
9. **Cleanup** — Deletes the local temp file and the GCS upload (with one retry on failure).

---

## 9.4. Data Models

### `StagedImport`

Represents a single import session.

| Field | Description |
|---|---|
| `id` | UUID |
| `tenantId` | Owner tenant |
| `fileName` | Original file name |
| `accountId` | Target account (null for native adapter imports where account comes from each CSV row) |
| `adapterId` | Matched adapter |
| `adapterName` | Denormalised adapter name |
| `status` | `PROCESSING` → `READY` → `COMMITTING` → `COMMITTED` / `READY` / `ERROR` / `CANCELLED` |
| `progress` | 0–100, updated during processing and commit |
| `totalRows` | Total staged rows |
| `autoConfirmedCount` | Rows auto-confirmed during processing (confidence ≥ `autoPromoteThreshold`) |
| `seedReady` | `true` once Phase 1 classification is complete. When `true`, the frontend may show the Quick Classify card. |
| `errorCount` | Rows that failed to parse |
| `errorDetails` | JSON error details; after commit contains `{ commitResult: { transactionCount, remaining } }` |

### `StagedImportRow`

Represents one row from the imported file, pending user review.

| Field | Description |
|---|---|
| `id` | UUID |
| `stagedImportId` | Parent import |
| `rowNumber` | Original row order |
| `transactionDate` | Parsed date |
| `description` | Parsed description |
| `details` | Parsed secondary field (e.g. memo) |
| `debit` | Parsed debit amount |
| `credit` | Parsed credit amount |
| `currency` | Parsed or defaulted currency |
| `accountId` | Target account |
| `status` | `PENDING` / `CONFIRMED` / `SKIPPED` / `DUPLICATE` / `POTENTIAL_DUPLICATE` / `ERROR` |
| `suggestedCategoryId` | AI-suggested or user-overridden category |
| `confidence` | Classification confidence score (0.0–1.0) |
| `classificationSource` | `EXACT_MATCH` / `VECTOR_MATCH` / `VECTOR_MATCH_GLOBAL` / `LLM` / `USER_OVERRIDE` |
| `errorMessage` | Parse or resolution error description |
| `duplicateOfId` | ID of the existing `Transaction` this row duplicates (if detected) |
| `rawData` | Original unparsed CSV/XLSX row as JSON |
| `tags` | JSON array of tag name strings from CSV (e.g. `["Japan 2026", "Business"]`) |
| `ticker` | Investment ticker symbol (e.g. `FLRY3`, `VWCE`) |
| `assetQuantity` | Number of units/shares |
| `assetPrice` | Price per unit at transaction date |
| `requiresEnrichment` | `true` if the category demands ticker/quantity/price and at least one is missing |
| `enrichmentType` | `'INVESTMENT'` when `requiresEnrichment` is `true` |
| `isin` | System-resolved ISIN (e.g. `BRBIDI...`), populated by TwelveData at staging time |
| `exchange` | MIC code of the primary exchange (e.g. `BVMF`, `XNAS`), populated by TwelveData at staging time |
| `assetCurrency` | Currency the asset trades in (e.g. `BRL`, `USD`), populated by TwelveData at staging time |

---

## 9.5. Deduplication Logic

Duplicate detection uses a deterministic SHA-256 hash:

```
hash = SHA-256(isoDate + normalizedDescription + normalizedAmount + accountId)
```

Where:
- `isoDate` = `new Date(date).toISOString()`
- `normalizedDescription` = `description.trim().toLowerCase()`
- `normalizedAmount` = `String(debit || credit)`

The same formula is used by `commitWorker.js` when writing `Transaction.externalId`, ensuring DB-level dedup via `createMany({ skipDuplicates: true })`.

### Intra-CSV duplicate detection

During staging, the hash set is also used to detect duplicates **within the CSV itself**. After checking a row's hash against existing transactions, the hash is added to the set. If a subsequent row in the same CSV produces the same hash (same date + description + amount + account), it is flagged as `POTENTIAL_DUPLICATE`. This ensures the user sees and can review legitimately identical transactions (e.g., two $5.00 coffee purchases on the same day) rather than having one silently dropped at commit time.

---

## 9.6. Commit Logic

Commit is processed **asynchronously** by `commitWorker.js` via the `smart-import` BullMQ queue.

### Dispatch (API layer)

When the user clicks "Commit Import", the API endpoint (`POST /api/imports/:id?action=commit`):

1. Validates the import exists and has `status: 'READY'`.
2. Sets `StagedImport.status = 'COMMITTING'` and `progress = 0`.
3. Dispatches a `SMART_IMPORT_COMMIT` event via `produceEvent()`.
4. Returns `202 Accepted` with `{ status: 'COMMITTING', message: 'Commit process started. Poll for progress.' }`.
5. If `produceEvent()` fails, reverts status to `READY` and returns `500`.

### Worker: `commitWorker.js`

**Trigger**: `SMART_IMPORT_COMMIT` event → `eventSchedulerWorker.js` enqueues `commit-smart-import` job on the `smart-import` queue.

**Full pipeline**:

1. **Verify** — Confirms `StagedImport` exists and has `status: 'COMMITTING'`.
2. **Fetch promotable rows** — Queries `StagedImportRow` with `status === 'CONFIRMED'` **exactly** and non-null `suggestedCategoryId`. If `rowIds` is provided in the event data, only those rows are additionally filtered (partial commit).
   - **Data-integrity guard**: `POTENTIAL_DUPLICATE` and `DUPLICATE` rows are deliberately excluded from this query. A user who wants to commit a flagged duplicate must explicitly override its status to `CONFIRMED` through the Review UI first. This keeps the `Transaction.externalId @unique` constraint as the true defense-in-depth backstop against accidental re-imports. Regression test: `apps/backend/src/__tests__/unit/workers/commitWorker.test.js` → "only fetches CONFIRMED rows — POTENTIAL_DUPLICATE and DUPLICATE are filtered out".
3. **Batch create transactions** (batches of 200):
   a. Filters out rows requiring enrichment that are still missing ticker/quantity/price.
   b. **Occurrence counter** — Tracks how many times each base hash appears across the entire commit (counter persists across batches). When multiple `CONFIRMED` rows in the same commit share the same base hash (e.g. 7 × "$1 Commission" on the same day that the user explicitly confirmed), each gets a unique `externalId`: 1st → `baseHash`, 2nd → `baseHash:2`, 3rd → `baseHash:3`, etc. This lets a user commit legitimate same-fingerprint transactions.

      The counter is intentionally **scoped to a single commit** — it starts empty on each job. A re-committed row (re-import of a CSV that was previously committed) gets `externalId = baseHash` in the new commit, which already exists in the DB, so `createMany({ skipDuplicates: true })` correctly skips it. Combined with step 2's `status === 'CONFIRMED'` guard, this means any row reaching `createMany` is either a brand-new transaction or a DB-level duplicate that the unique constraint will reject — never a silent re-import.
   c. Maps rows to `Transaction` data. Investment fields (`ticker`, `assetQuantity`, `assetPrice`, `isin`, `exchange`, `assetCurrency`) are carried through from the staged row when present.
   d. Sets `Transaction.externalId` to the occurrence-suffixed hash for idempotent dedup.
   e. **Pre-checks for existing externalIds** — queries `Transaction` for all `externalId`s in the batch *before* calling `createMany`. This identifies which rows will be skipped by `skipDuplicates` so they can be treated differently from successfully committed rows. The check uses the full suffixed externalId, so re-importing the same CSV correctly detects all occurrences (including `baseHash:2`, `baseHash:3`, etc.).
   f. Calls `prisma.transaction.createMany({ skipDuplicates: true })`.
   g. **Three-bucket row classification** — after the insert, each row in the batch is classified by its commit outcome:
      - **Committed** (`externalId` not pre-existing) → `status: 'SKIPPED'` (advances the cursor, hidden from review)
      - **Duplicate** (`externalId` pre-existing in DB) → `status: 'POTENTIAL_DUPLICATE'` (returned to user review queue)
      - **Enrichment missing** (filtered out at step a, not in `rowIdToExternalId` map) → `status: 'STAGED'` (returned for data entry)
   h. **Tag linking**: For rows with a non-null `tags` array, tags are resolved via `resolveTagsByName()` (find-or-create by name) and linked to created transactions via `TransactionTag`.
   h. Updates `StagedImport.progress` (0→85% across batches).
4. **Embedding feedback** (fire-and-forget, non-blocking): Calls `categorizationService.recordFeedback()` for committed rows with `classificationSource = 'LLM'` or `'USER_OVERRIDE'` to update the pgvector embedding index. Additionally, `addDescriptionEntry()` is called for **all** committed rows (regardless of classification source) to warm the in-memory description cache — this ensures EXACT_MATCH and VECTOR_MATCH descriptions are also cached for future classification. Progress → 90%.
5. **Check remaining rows** — Counts remaining `CONFIRMED`/`PENDING`/`POTENTIAL_DUPLICATE`/`STAGED` rows with a category.
6. **Final status** — Sets `StagedImport.status` to `'COMMITTED'` (remaining = 0) or `'READY'` (remaining > 0), with `progress: 100` and `errorDetails.commitResult = { transactionCount, remaining }`.
7. **Downstream event** — Enqueues `TRANSACTIONS_IMPORTED` event (direct queue call) with `accountIds`, `dateScopes`, and `source: 'SMART_IMPORT'` to trigger portfolio recalculation.

### Error handling

If the worker throws at any point:
- Sets `StagedImport.status = 'ERROR'` with `errorDetails.message`.
- Logs the error and reports to Sentry.
- Re-throws so BullMQ marks the job as failed.

### Progress updates

| Phase | Progress | Description |
|-------|----------|-------------|
| Start | 0% | Reset on commit begin |
| Batch processing | 0→85% | Pro-rated across transaction batches |
| Embedding feedback | 90% | Fire-and-forget embedding calls queued |
| Complete | 100% | Final status set |

---

## 9.7. Bliss Native CSV Adapter

The "Bliss Native CSV" system adapter (`matchSignature.isNative: true`, `tenantId: null`) provides a direct, non-AI import path through the Smart Import pipeline. It is seeded via `migrations/20260228120000_seed_bliss_native_adapter`.

**Key behaviour differences from bank-format adapters:**
- AI classification is **bypassed** — `account` and `category` columns are resolved by name or numeric ID using tenant-scoped lookup maps.
- Rows with both account and category resolved are **auto-confirmed** (`status: 'CONFIRMED'`).
- Rows with an unresolvable account or category remain `PENDING` for manual review with an `errorMessage`.
- Investment fields (`ticker`, `assetquantity`, `assetprice`) are accepted directly from the CSV — no enrichment step is required and `requiresEnrichment` is always `false`.
- `classificationSource` is set to `'USER_OVERRIDE'` so commit-time vector embeddings are generated for all committed rows.

**Ticker metadata auto-resolution (Step 6b)**:
For any row that carries a `ticker`, the worker automatically resolves `isin`, `exchange` (MIC code), and `assetCurrency` from TwelveData at staging time — before the rows are written to the DB. This means the user can commit native adapter investment rows immediately without any manual enrichment, and the created `Transaction` and `PortfolioItem` records will carry the correct exchange and ISIN from the start.

The resolution strategy differs by asset type (`processingHint`):

**Stocks / Funds (`API_STOCK`, `API_FUND`)**:
1. `searchSymbol(ticker)` + `getSymbolProfile(ticker)` fired concurrently (2 credits per ticker).
2. Disambiguation: currency match → exact symbol match → first result.
3. Writes `exchange` (MIC), `assetCurrency`, and `isin` back to matching rows.

**Crypto (`API_CRYPTO`)**:
1. `cryptoService.searchCrypto(ticker)` only (1 credit per ticker, no profile call).
2. Filters for `digital currency` instrument type; deduplicates multiple pairs (BTC/USD, BTC/EUR → BTC).
3. Normalises `ticker` to base symbol (e.g. `BTC`, `ETH`). No exchange/ISIN resolution.

If no candidates are found or the API call fails, `isin`/`exchange`/`assetCurrency` are left `null` and the import proceeds normally. Existing CSV-sourced values are never overwritten by a null API response.

**Supported CSV columns**:

| Column | Required | Description |
|--------|----------|-------------|
| `transactiondate` | ✅ | Transaction date |
| `description` | ✅ | Transaction description |
| `debit` or `credit` | ✅ | At least one amount column |
| `account` | ✅ | Account name or numeric ID |
| `category` | ✅ | Category name or numeric ID |
| `currency` | — | ISO currency code; defaults to tenant base currency |
| `details` | — | Secondary description / memo |
| `ticker` | — | Investment ticker symbol (triggers Step 6b metadata resolution) |
| `assetquantity` | — | Number of units |
| `assetprice` | — | Price per unit at transaction date |
| `tags` | — | Comma-separated tag names (e.g. `Japan 2026, Business`) |

A downloadable template is available at `/templates/bliss-native-template.csv`.

---

## 9.8. CSV Update Pipeline — Overview

The Smart Import pipeline supports **updating existing transactions** via CSV round-trip. Users export transactions as a Bliss Native CSV (with a pre-populated `id` column), edit the file in a spreadsheet, and re-import it. Rows with a valid `id` update the existing transaction; rows without an `id` create new transactions (existing behaviour).

The export endpoint (`apps/api/pages/api/transactions/export.js`) produces a CSV in the exact Bliss Native format, including the transaction `id` and all editable fields. This creates a full round-trip: Export → Edit → Re-import → Review → Commit.

The Bliss Native CSV adapter gains one new optional column:

| Column | Required | Description |
|--------|----------|-------------|
| `id` | — | Existing `Transaction.id`. When present and non-empty, signals an **update**. When empty or absent, signals a **create** (existing behaviour). |

The `id` column is always the first column in exported CSVs. During import, column order does not matter — detection is header-based. All other columns remain unchanged (see § 9.7).

See `docs/specs/api/17-transaction-export-update-api.md` for the API layer and `docs/specs/frontend/17-transaction-export-update-ui.md` for the UI.

---

## 9.9. CSV Update Pipeline — Worker Changes (`smartImportWorker.js`)

For native adapter imports, the Phase 0 loop gains a new branch for rows with an `id` value. Rows with a populated `id` follow the **update path**; rows without follow the existing **create path**.

**Update-only import optimisation:** When every row in a native adapter CSV has a valid `id` column (i.e. a pure update import with no new rows), the worker skips the expensive description cache warming (`warmDescriptionCache`) and duplicate hash set building entirely, since update rows need neither AI classification nor deduplication.

**Update path logic:**

1. **Parse ID** — Parse `row.id` as integer. Non-numeric values → `status: 'ERROR'`.
2. **Validate existence** — Look up `Transaction` by `id` and `tenantId`. Not found → `status: 'ERROR'`.
3. **Resolve account & category** — Same resolution as existing native path. Account column is **ignored** for update rows to prevent accidental balance corruption across accounts.
4. **Compute diff** — Compare CSV values against the existing transaction; only changed fields appear in a `updateDiff` JSON object. If no fields changed → `status: 'SKIPPED'`.
5. **Set row data** — `updateTargetId = Transaction.id`, `status = 'CONFIRMED'`, `classificationSource = 'USER_OVERRIDE'`, `confidence = 1.0`.

**Empty field semantics**: An empty cell for an optional field (e.g. `details`, `tags`, `ticker`) means **clear that field**. Empty required fields produce `status: 'ERROR'`.

**Diff-compared fields**: `transactionDate`, `description`, `details`, `debit`, `credit`, `currency`, `categoryId`, `tags` (set comparison), `ticker`, `assetQuantity`, `assetPrice`. `accountId` is excluded — account changes are disallowed.

**Transaction lookup optimisation**: To avoid N+1 queries, the worker pre-fetches all referenced transactions in a single batch query (`findMany` with `id IN (...)` and `tenantId`) before entering the Phase 0 loop, building a `Map<id, Transaction>` for O(1) lookups.

Update rows are excluded from Phase 1/2 AI classification. Ticker metadata resolution (Step 6b) applies to update rows with a changed `ticker` the same as for create rows.

---

## 9.10. CSV Update Pipeline — Data Model Changes

### `StagedImportRow` — New Fields

| Field | Type | Description |
|-------|------|-------------|
| `updateTargetId` | `Int?` | FK to `Transaction.id`. Non-null signals this row is an update, not a create. |
| `updateDiff` | `Json?` | Computed diff between CSV values and existing transaction. Only changed fields included. |

### `StagedImport` — New Fields

| Field | Type | Description |
|-------|------|-------------|
| `updateCount` | `Int` | Count of rows that are updates (have `updateTargetId`). Default `0`. |

No foreign key constraint on `updateTargetId` — existence is validated at staging time, but the transaction could be deleted between staging and commit. The commit worker handles this gracefully (see § 9.11).

---

## 9.11. CSV Update Pipeline — Commit Logic (`commitWorker.js`)

The commit worker partitions promotable rows into `createRows` (where `updateTargetId IS NULL`) and `updateRows` (where `updateTargetId IS NOT NULL`).

**Create rows** follow the existing batch-create pipeline unchanged.

**Update rows** (batches of 200):
1. Build an update payload from the staged row data. Guarded fields (`accountId`, `source`, `externalId`, `userId`, `createdAt`) are never overwritten.
2. Validate the target transaction still exists and belongs to the tenant. If deleted since staging → `status: 'ERROR'`.
3. Apply via `prisma.transaction.update()` with date normalisation (year, month, day, quarter extraction).
4. Handle category changes (portfolio item upsert) and tag changes (`resolveTagsByName()` re-link).
5. Mark the `StagedImportRow` as `status: 'SKIPPED'` (processed).

**Embedding feedback**: Category changes on update rows with `classificationSource = 'USER_OVERRIDE'` trigger `recordFeedback()`, same as creates.

**Final status**: `errorDetails.commitResult` now includes `{ transactionCount, updateCount, remaining }`.

**Downstream events**: `TRANSACTIONS_IMPORTED` includes all affected account IDs. Category changes on update rows also produce `MANUAL_TRANSACTION_UPDATED` events for portfolio recalculation.

---

## 9.12. CSV Update Pipeline — Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Non-numeric `id` in CSV | Row → `ERROR`, message: "Invalid transaction ID" |
| Transaction ID not found | Row → `ERROR`, message: "Transaction not found or belongs to another tenant" |
| Transaction deleted between staging and commit | Row → `ERROR`, message: "Transaction was deleted before commit" |
| No fields changed | Row → `SKIPPED`, message: "No changes detected" |
| Account/category name unresolvable | Row → `PENDING` with error message (same as existing native behaviour) |
| Mixed create + update CSV | Both paths run in the same pipeline — no special handling |
| Duplicate `id` values in same CSV | Each row processed independently — last-write-wins within the same batch |

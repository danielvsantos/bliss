# 10. AI Classification Pipeline (Backend)

## 10.1. Overview

The AI classification pipeline automatically assigns categories to transactions during Plaid sync and CSV/XLSX smart import. It uses a **four-tier waterfall** that prioritises fast, deterministic matching before falling back to an LLM call. User overrides feed back into both the in-memory cache and the vector index immediately via the feedback loop.

The pipeline is implemented in `src/services/` and called directly by `plaidProcessorWorker.js` and `smartImportWorker.js`.

> **Configuration**: All tuning constants (thresholds, dimensions, concurrency limits) are centralised in `src/config/classificationConfig.js`. Edit only that file to change system-wide classification behaviour. See §9.10 for details.

---

## 10.2. Classification Waterfall

### Tier 1 — Exact Match (`descriptionCache.js`)

The first tier is an O(1) in-memory lookup built from the `DescriptionMapping` table — a hash-keyed lookup table that maps `SHA-256(normalize(description))` to `categoryId` per tenant. This avoids scanning the full `Transaction` table (which has encrypted descriptions requiring per-row decryption).

**Workflow**:
1. On first use, `buildLookupForTenant(tenantId)` queries `DescriptionMapping` and builds a `Map<descriptionHash, categoryId>`.
2. The incoming transaction description is hashed via `computeDescriptionHash()` (normalize + SHA-256) and looked up.
3. On a **hit**: returns `{ categoryId, confidence: EXACT_MATCH_CONFIDENCE, source: 'EXACT_MATCH' }`. No API call needed. `EXACT_MATCH_CONFIDENCE = 1.0` (from `classificationConfig.js`) — full confidence for exact description matches.
4. On a **miss**: falls through to Tier 2.

**Cache population**: The `DescriptionMapping` table is maintained via write-through — every `addDescriptionEntry()` call updates the in-memory cache AND upserts a row in the table (fire-and-forget). Sources: `recordFeedback()`, `commitWorker` (all committed rows), `bulk-promote`, and manual transaction creation.

**Cache refresh**: 10-minute staleness check triggers a reload from `DescriptionMapping`. Per-tenant, 25k entry safety cap.

---

### Tier 2 — Vector Similarity (`categorizationService.js` + pgvector)

When no exact match exists, the description is embedded using the Gemini embedding model and compared against previously classified transactions stored in the `TransactionEmbedding` table.

**Workflow**:
1. `categorizationService.classify()` calls `geminiService.generateEmbedding(description)` → 768-dim float vector.
2. `findVectorMatch(embedding, tenantId, reviewThreshold)` runs a raw SQL cosine similarity query:
   ```sql
   SELECT te."categoryId",
          1 - (te."embedding" <=> $embedding::vector) AS similarity
   FROM "TransactionEmbedding" te
   WHERE te."tenantId" = $tenantId
     AND te."embedding" IS NOT NULL
   ORDER BY te."embedding" <=> $embedding::vector
   LIMIT 1
   ```
3. If `similarity >= reviewThreshold` (default `DEFAULT_REVIEW_THRESHOLD = 0.70`): returns `{ categoryId, confidence: similarity, source: 'VECTOR_MATCH' }`.
4. On a **miss** (no rows, or best similarity below threshold): falls through to **Tier 2b**.

### Tier 2b — Global Vector Similarity (`categorizationService.js` + `GlobalEmbedding`)

When no tenant-scoped vector match exists, the same embedding is compared against the **cross-tenant** `GlobalEmbedding` table. This table contains anonymised descriptions confirmed against default categories by users across all tenants.

**Workflow**:
1. `findGlobalVectorMatch(embedding, reviewThreshold)` queries `GlobalEmbedding` using the same cosine similarity approach as Tier 2.
2. On a **hit**: the raw similarity is **discounted by `GLOBAL_VECTOR_DISCOUNT = 0.92`** (from `classificationConfig.js`) because cross-tenant matches are less trustworthy than tenant-scoped ones. Returns `{ categoryId (resolved from defaultCategoryCode), confidence: similarity × 0.92, source: 'VECTOR_MATCH_GLOBAL' }`.
3. On a **miss**: falls through to Tier 3 (LLM).

**Why the discount?** A `GlobalEmbedding` row was confirmed by a different tenant whose categories may differ slightly from the current tenant's. The 0.92 factor ensures VECTOR_MATCH_GLOBAL scores almost never reach `DEFAULT_AUTO_PROMOTE_THRESHOLD (0.90)` so they typically appear in the Quick Seed interview rather than being silently auto-promoted.

**GlobalEmbedding rows are only created when** a user confirms a seed against a *default category* (one with a non-null `defaultCategoryCode`). Custom tenant-only categories never contribute to the global pool.

**Index**: An IVFFlat index on `embedding` (`vector_cosine_ops`, `lists=100`) makes queries fast even as the table grows.

---

### Tier 3 — LLM Classification (`geminiService.js`)

When neither exact nor vector match is found, the description is sent to the Google Gemini API for classification.

**Workflow**:
1. `categorizationService.classify()` fetches the tenant's category list via `categoryCache.getCategoriesForTenant(tenantId)`.
2. Builds a prompt: description + tenant category list → Gemini `generateContent()` with `responseMimeType: 'application/json'`.
3. **Plaid Category Hint**: When a `plaidCategory` object is provided (Plaid transactions only), it is injected into the prompt between TRANSACTION and AVAILABLE CATEGORIES:
   ```
   PLAID CATEGORY (from the bank — use as a hint, NOT as the answer):
   Primary: "FOOD_AND_DRINK"
   Detailed: "FOOD_AND_DRINK_RESTAURANTS"
   Confidence: "HIGH"
   ```
   A classification rule is added: *"If a PLAID CATEGORY is provided, use it as a contextual hint but always map to the most appropriate category from your list."* This improves accuracy for first-time merchants that miss Tiers 1 & 2.
4. Parses the structured JSON response: `{ categoryId, confidence, reasoning }`.
5. Returns `{ categoryId, confidence, reasoning, source: 'LLM' }`. The confidence is **hard-capped at 0.85** in code (`Math.min(..., 0.85)`) so LLM classifications can never auto-promote. The `reasoning` string is stored in `PlaidTransaction.classificationReasoning` and surfaced in the Transaction Review deep-dive drawer.
6. On Gemini API failure: retries up to 5 times with exponential backoff, then throws an `Error` (`'All classification tiers failed...'`). The calling worker handles this by leaving the transaction without a category.

**Retry/backoff**: Implemented in `geminiService.js` with `MAX_RETRIES = 5` and `BASE_DELAY_MS = 1000`. Rate-limit errors (429) use a longer `RATE_LIMIT_BASE_DELAY_MS = 60_000` (60s → 120s → 180s).

---

## 10.3. Supporting Services

### `categoryCache.js`

Provides a tenant-scoped, in-memory cache of `Category` records.

- `getCategoriesForTenant(tenantId)` — returns `Category[]`, cached per tenant.
- Used by `geminiService.js` to build classification prompts.
- Invalidated on process restart; no TTL (categories change infrequently).

### `descriptionCache.js`

Provides an O(1) description → categoryId lookup per tenant.

- Built from the `DescriptionMapping` table (hash-keyed, no encryption overhead).
- Key: `SHA-256(normalize(description))` via `computeDescriptionHash()` from `descriptionHash.js`.
- Updated immediately on every new classification so future identical descriptions hit Tier 1.

**`addDescriptionEntry(description, categoryId, tenantId)`** — Writes a description→categoryId mapping to both the in-memory cache (immediate) and the `DescriptionMapping` table (fire-and-forget upsert). Called by `recordFeedback()` on user overrides, by `commitWorker` for all committed rows, and by the bulk-promote and manual transaction create endpoints via `POST /api/feedback`.

### `categorizationService.js`

The main classification orchestrator. Key functions:

- **`classify(description, merchantName, tenantId, reviewThreshold, plaidCategory?)`** — Runs the 3-tier waterfall in sequence, returning the first successful result. The optional 5th parameter `plaidCategory` is the raw Plaid `personal_finance_category` JSON object. When present, it is injected as a hint into the Tier 3 LLM prompt (see §9.6). Tiers 1 and 2 are unaffected.

- **`findVectorMatch(embedding, tenantId, threshold)`** — Executes the pgvector cosine similarity query against `TransactionEmbedding`. Returns `{ categoryId, confidence }` if similarity ≥ threshold, otherwise `null`.

- **`upsertEmbedding(description, categoryId, tenantId, embedding, source, transactionId = null)`** — Stores or updates a `TransactionEmbedding` row. Uses `ON CONFLICT ("tenantId", "description") DO UPDATE` so the same description is always kept current rather than duplicated.

- **`recordFeedback(description, categoryId, tenantId, transactionId = null)`** — Called when a classification is confirmed. Two effects:
  1. Immediately updates the in-memory description cache via `addDescriptionEntry()` (synchronous).
  2. Fire-and-forget: calls `generateEmbedding(description)` then `upsertEmbedding(...)` to persist the confirmed classification into the vector index (asynchronous, non-blocking).

---

## 10.4. Integration Points

### `plaidProcessorWorker.js`

After staging a `PlaidTransaction`, the processor calls `categorizationService.classify(description, merchantName, tenantId, reviewThreshold, plaidTx.category)` and writes the result back to the `PlaidTransaction` row:
- `suggestedCategoryId`
- `aiConfidence`
- `classificationSource` (`'EXACT_MATCH'` | `'VECTOR_MATCH'` | `'VECTOR_MATCH_GLOBAL'` | `'LLM'` | `'USER_OVERRIDE'`)
- `classificationReasoning` — LLM reasoning string (only for `'LLM'` tier; `null` otherwise)
- `promotionStatus` → `'CLASSIFIED'`

**Investment Detection**: After classification, if `category.type === 'Investments'` and `category.processingHint` is in `INVESTMENT_HINTS` (`API_STOCK`, `API_CRYPTO`, `API_FUND`, or `MANUAL`), the row is flagged with `requiresEnrichment: true` and `enrichmentType: 'INVESTMENT'`. These rows are **never auto-promoted** regardless of confidence — they require user-provided ticker/quantity/price before the Transaction record can be created correctly.

**Phase 1 hold-back (Quick Seed interview)**: Before Phase 2 classifies the bulk of transactions, Phase 1 classifies the top N descriptions by frequency. Results are held with `seedHeld=true` (rather than processed immediately) unless:
- `result.source === 'EXACT_MATCH'` — always trusted, processed immediately.
- `result.confidence >= tenant.autoPromoteThreshold` — high enough to auto-promote, processed immediately.

All other results (LLM, VECTOR_MATCH, or VECTOR_MATCH_GLOBAL below threshold) are stored on the `PlaidTransaction` row with `seedHeld=true` and the worker continues with Phase 2. The user sees these in the Quick Seed interview modal and confirms/overrides them. On confirmation, `POST /api/plaid/transactions/confirm-seeds` promotes the held transactions and releases any excluded seeds to `promotionStatus=CLASSIFIED` (pending review queue).

**Auto-promote**: After classification (and investment detection) during Phase 2, if `aiConfidence >= tenant.autoPromoteThreshold` AND `requiresEnrichment !== true`, the worker creates a `Transaction` record immediately (`promotionStatus = 'PROMOTED'`) inside a Prisma `$transaction`. After the commit, calls `recordFeedback(description, categoryId, tenantId, newTransactionId)` — the `transactionId` is passed so the resulting `TransactionEmbedding` row can be linked to the concrete transaction.

Rows that fail classification (null result) are left with `promotionStatus: 'PENDING'` for manual review.

### `smartImportWorker.js`

During batch processing of `StagedImportRow` records, each row is classified via the same `categorizationService.classify()` call. The result is written to:
- `suggestedCategoryId`
- `confidence`
- `classificationSource`

**Auto-confirm**: After classification, if `confidence >= tenant.autoPromoteThreshold` and `rowData.status === 'PENDING'`, the row is immediately set to `status: 'CONFIRMED'` and `classificationSource: 'USER_OVERRIDE'`. `autoConfirmedCount` is incremented.

> **Important**: `recordFeedback()` (and therefore embedding generation) is **not** called during worker processing. Embeddings are only saved at commit time, once the user has confirmed the final category. This prevents polluting the vector index with unconfirmed or subsequently-cancelled classifications. See **9.8 — Embedding Pipeline** for the commit-time guarantee.

Unclassified rows remain in the staging table with `status: 'PENDING'` and no `suggestedCategoryId`.

---

## 10.5. Feedback Loop (`categorizationService.recordFeedback`)

When a user overrides a transaction's category (in Transaction Review, Smart Import review, or any other surface), the `apps/api` fires a fire-and-forget `POST /api/feedback` to the backend service.

**`recordFeedback(description, categoryId, tenantId, transactionId = null)`**:
1. Normalises the description (lowercase, trim).
2. Calls `addDescriptionEntry(description, categoryId, tenantId)` → in-memory cache updated immediately.
3. Fire-and-forget: calls `geminiService.generateEmbedding(description)` then `upsertEmbedding(description, categoryId, tenantId, embedding, 'USER_CONFIRMED', transactionId)` — builds/updates the vector index asynchronously.

The next classification for the same tenant with the same description hits **Tier 1 (EXACT_MATCH)** at 1.0 confidence. Semantically similar (but differently worded) descriptions hit **Tier 2 (VECTOR_MATCH)** on the next classification attempt.

**Trigger points** (fire-and-forget, non-fatal if backend unreachable):

| Action | Trigger |
|---|---|
| User changes category on a Plaid transaction (`PUT /api/plaid/transactions/:id`) | `apps/api` |
| User changes category on an import row (`PUT /api/imports/:id/rows/:rowId`) | `apps/api` |
| User changes category on a manual transaction (`PUT/POST /api/transactions`) | `apps/api` |
| Plaid auto-promote | `plaidProcessorWorker.js` (direct call, passes `transactionId`) |
| Commit smart import (LLM and USER_OVERRIDE rows only) | `apps/api` commit endpoint (`POST /api/imports/:id?action=commit`) |

---

## 10.6. Gemini Services (`geminiService.js`)

Two Gemini API capabilities are used:

### Embedding Model

- **Model**: `gemini-embedding-001`
- **Output**: 768-dimensional float vector
- **API call**: `model.embedContent({ content: { parts: [{ text }] }, outputDimensionality: 768 })`
- `outputDimensionality: 768` is required — the model produces 3072 dims by default; constraining to 768 matches the `vector(768)` DB column without a migration.
- Retry logic: 5 attempts (`MAX_RETRIES = 5`) with exponential backoff.

### Classification Model

- **Model**: `gemini-3-flash-preview`
- **Temperature**: `0.1` (low for deterministic output)
- **Response format**: `application/json`
- Returns `{ categoryId: int, confidence: float 0–1, reasoning: string }`
- The prompt includes: tenant category list (ID, name, group, type), classification rules, the transaction description, and optionally the Plaid `personal_finance_category` hint.
- The `reasoning` field is stored in `PlaidTransaction.classificationReasoning` and displayed in the Transaction Review deep-dive drawer to help users understand why a category was chosen.

**LLM Confidence Scale** (instructed in the prompt, hard-capped at 0.85 in code):

| Range | Label | Meaning | System effect |
|---|---|---|---|
| 0.78–0.85 | Certain | Only one category clearly fits | Held for review (LLM can never auto-promote) |
| 0.65–0.77 | Very confident | Clearly fits; minor ambiguity | Held for review |
| 0.50–0.64 | Confident | Best fit; 1–2 alternatives possible | Held for review |
| 0.30–0.49 | Uncertain | Multiple categories apply | Held for review |
| 0.00–0.29 | Very uncertain | Too ambiguous | Held for review |

> **Design decision**: LLM confidence is hard-capped at 0.85 and the auto-promote threshold defaults to 0.90, so LLM classifications always require human review. Only EXACT_MATCH (1.0) and high-confidence tenant-scoped VECTOR_MATCH (≥0.90) can auto-promote.

---

## 10.7. Tenant Classification Thresholds

Two float fields on the `Tenant` model control classification behaviour. Their defaults match `DEFAULT_AUTO_PROMOTE_THRESHOLD` and `DEFAULT_REVIEW_THRESHOLD` in `src/config/classificationConfig.js` — keep both in sync if you change the defaults.

| Field | Default | Effect |
|---|---|---|
| `autoPromoteThreshold` | `0.90` | Transactions classified at or above this confidence (from any tier) are promoted/confirmed automatically, bypassing the review queue. In practice only EXACT_MATCH (1.0) and high-confidence tenant-scoped VECTOR_MATCH routinely reach this threshold. LLM is hard-capped at 0.85. |
| `reviewThreshold` | `0.70` | Minimum cosine similarity for a Tier 2/2b VECTOR_MATCH to be accepted. Matches below this score fall through to the next tier. In the review UI, rows below this threshold are also flagged as uncertain. |

Both workers fetch these values from the `Tenant` table at job start. Managed via `GET/PUT /api/tenants/settings`.

---

## 10.8. Embedding Pipeline

### `TransactionEmbedding` Data Model

Stores confirmed classification embeddings used by Tier 2 (VECTOR_MATCH).

| Field | Type | Description |
|---|---|---|
| `id` | Int (PK) | Auto-increment |
| `transactionId` | Int? (unique) | FK to `Transaction` — null for CSV import rows at commit time (createMany does not return IDs) |
| `tenantId` | String | FK to `Tenant` |
| `description` | String | SHA-256 hash of the normalised description (plaintext is never stored — `Transaction.description` is AES-256-GCM encrypted and the hash preserves the upsert key without leaking the original text) |
| `categoryId` | Int | FK to `Category` — the confirmed category |
| `confidence` | Float | Confidence score at time of confirmation |
| `source` | String | `'USER_CONFIRMED'` (user override or auto-promote) |
| `embedding` | vector(768) | Managed via raw SQL migration (pgvector extension) |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

**Upsert key**: `@@unique([tenantId, description])` — embeddings are keyed by description hash within a tenant. The `description` column stores a SHA-256 hash of the normalised description, not the original plaintext. If the same description is confirmed again with a different category, the existing row is updated (ON CONFLICT DO UPDATE).

### Commit-Time Guarantee

Embeddings are **never** saved during worker classification. They are only saved after a transaction is committed:

| Event | Embedding saved? | Why |
|---|---|---|
| Worker classifies a CSV row (any tier) | ❌ No | Row is still PENDING; user can override |
| User overrides an import row | ✅ Yes (via `POST /api/feedback`) | User intent confirmed |
| User commits CSV import (`POST /api/imports/:id?action=commit`) | ✅ Yes (fire-and-forget, LLM and USER_OVERRIDE rows only) | Transaction is now in the DB |
| Plaid auto-promote | ✅ Yes (via `recordFeedback` in worker, with transactionId) | Transaction committed inline |
| User promotes a Plaid transaction manually | ✅ Yes (via `POST /api/feedback` from finance-api) | Transaction committed |

EXACT_MATCH and VECTOR_MATCH rows are skipped at commit time — they already have embeddings in the DB.

### pgvector Infrastructure

- **Extension**: `CREATE EXTENSION IF NOT EXISTS vector`
- **Column**: `ALTER TABLE "TransactionEmbedding" ADD COLUMN embedding vector(768)`
- **Index**: `CREATE INDEX "TransactionEmbedding_embedding_idx" ON "TransactionEmbedding" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
- Managed via a dedicated SQL migration (bypasses Prisma's native type support for vector).

---

## 10.10. Classification Config (`classificationConfig.js`)

All tuning constants for the four-tier waterfall live in `src/config/classificationConfig.js`. This is the single source of truth — edit only this file to change system-wide behaviour.

| Constant | Default | Where used |
|---|---|---|
| `EXACT_MATCH_CONFIDENCE` | `1.0` | `categorizationService.js` — returned for Tier 1 hits |
| `GLOBAL_VECTOR_DISCOUNT` | `0.92` | `categorizationService.js` — multiplier applied to Tier 2b scores |
| `EMBEDDING_DIMENSIONS` | `768` | `geminiService.js` — Gemini embedding output dimensionality |
| `DEFAULT_AUTO_PROMOTE_THRESHOLD` | `0.90` | Worker fallback when `Tenant.autoPromoteThreshold` is null |
| `DEFAULT_REVIEW_THRESHOLD` | `0.70` | Worker fallback when `Tenant.reviewThreshold` is null |
| `TOP_N_SEEDS` | `15` | Phase 1 — max distinct descriptions held for the Quick Seed interview |
| `DEFAULT_PLAID_HISTORY_DAYS` | `1` (from `PLAID_HISTORY_DAYS` env var) | Default days of Plaid transaction history fetched on initial connect; written to `Tenant.plaidHistoryDays` at creation |
| `PHASE2_CONCURRENCY` | `5` | Phase 2 — p-limit concurrency cap for parallel LLM calls |

**Note on Prisma schema sync**: The `Tenant` model in `prisma/schema.prisma` also has `@default(0.90)` and `@default(0.70)` on `autoPromoteThreshold` and `reviewThreshold`. These must be kept in sync manually — Prisma schema cannot import this JS file.

---

## 10.11. Encryption Key Caching

`geminiService.js` accesses encrypted transaction data. The PBKDF2 key derivation used for AES-256-GCM decryption is computationally expensive. The encryption module caches derived keys in an LRU cache to avoid re-deriving the key on every decrypted field access.

`descriptionCache.js` no longer accesses encrypted data directly — it reads from the `DescriptionMapping` table which stores SHA-256 hashes (not encrypted descriptions). This eliminates the decryption overhead that previously made cache warming expensive for large tenants.

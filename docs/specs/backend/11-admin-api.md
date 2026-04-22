# 11. Admin API

Internal administration endpoints for managing default categories and the cross-tenant classification system. These endpoints are **not user-facing** — they are used by Bliss operations staff for category provisioning, metadata maintenance, and embedding quality management.

The admin endpoints live in the Next.js API (`apps/api`) and are documented here for cross-repo context since the backend service owns the classification pipeline that produces and consumes `GlobalEmbedding` data.

> **LLM provider abstraction.** Embedding regeneration uses whichever provider is configured via `EMBEDDING_PROVIDER` (defaults to `LLM_PROVIDER`). Vectors across providers are not interchangeable — switching providers requires regenerating the index. For tenant-scoped regeneration use the `scripts/regenerate-embeddings.js` operator script; this admin endpoint targets `GlobalEmbedding` rows under a default-category code. See [Spec 20 — LLM Provider Abstraction](./20-llm-provider-abstraction.md).

---

## Authentication

All admin endpoints use a static API key, **not** a user JWT session.

- **Header**: `x-admin-key: <value>`
- **Env var**: `ADMIN_API_KEY` (in `apps/api`)
- Returns `401` if the header is missing, incorrect, or if `ADMIN_API_KEY` is not set.

---

## Backend Service Context

The backend service interacts with the admin data model at several points:

### GlobalEmbedding — created during classification feedback

When `recordFeedback()` in `src/services/categorizationService.js` is called after a transaction is confirmed, it:
1. Updates the in-memory description cache synchronously.
2. Generates a Gemini embedding async (`geminiService.generateEmbedding()`).
3. Upserts a `TransactionEmbedding` row for the tenant.
4. If the confirmed `Category` has a `defaultCategoryCode`, also upserts a `GlobalEmbedding` row — making this description available for cross-tenant Tier 2b (VECTOR_MATCH_GLOBAL) classification.

This is the **only** way `GlobalEmbedding` rows are created. The admin `regenerate-embeddings` endpoint only refreshes existing vectors, never creates new rows.

### VECTOR_MATCH_GLOBAL — used during classification

In `categorizationService.classify()`, after the tenant-scoped VECTOR_MATCH tier fails (or returns no results above `reviewThreshold`), the service falls through to query `GlobalEmbedding` using pgvector cosine similarity. Matching scores are multiplied by `0.92` (cross-tenant discount) before being compared to `reviewThreshold`.

The `classificationSource` on the resulting `PlaidTransaction` or `StagedImportRow` is set to `'VECTOR_MATCH_GLOBAL'`.

---

## Endpoints (in `apps/api`)

### `GET /api/admin/default-categories`

Lists all categories from `lib/defaultCategories.js` with live DB stats: `tenantCount` and `globalEmbeddingCount`.

### `POST /api/admin/default-categories`

Provisions a new category to all existing tenants (idempotent — uses `skipDuplicates: true`). Does **not** update `defaultCategories.js` — requires manual file update.

### `PUT /api/admin/default-categories/:code`

Updates name/group/type/icon/portfolioItemKeyStrategy across all tenant `Category` rows. Optional `newCode` renames the code and cascades to `GlobalEmbedding` rows. `processingHint` is blocked (400).

### `POST /api/admin/default-categories/:code/regenerate-embeddings`

Re-generates Gemini vectors for all `GlobalEmbedding` rows under this code. Sequential processing to respect Gemini rate limits. Returns `{ regenerated, failed }`.

---

## Data Architecture

### `defaultCategories.js`

**File**: `apps/api/lib/defaultCategories.js`

Source of truth for all default category definitions. Categories are provisioned from this file at tenant creation time. The admin API does not auto-sync this file — manual updates are required after provisioning or renaming.

### `GlobalEmbedding`

Cross-tenant embedding table for Tier 2b classification.

| Field | Description |
|---|---|
| `defaultCategoryCode` | The default category this embedding represents |
| `description` | SHA-256 hash of the normalised transaction description (plaintext never stored; original text sourced from encrypted `Transaction.description` when needed) |
| `embedding` | Gemini `vector(768)` — IVFFlat index for cosine similarity search |
| `source` | `USER_CONFIRMED` or `AUTO_CONFIRMED` |

**Creation**: Only via `recordFeedback()` in `categorizationService.js` when the confirmed category has a `defaultCategoryCode`. The feedback call is fire-and-forget (non-blocking).

**Cross-tenant discount**: `rawSimilarity × 0.92` before comparing to `reviewThreshold`. Reflected in `aiConfidence` stored on the staging row.

### `classificationConfig.js`

**File**: `src/config/classificationConfig.js`

Single source of truth for all AI classification tuning constants. All thresholds and default values used by the workers and the feedback pipeline are sourced from this file.

| Constant | Default | Description |
|---|---|---|
| `DEFAULT_AUTO_PROMOTE_THRESHOLD` | `0.90` | Confidence at or above which transactions are auto-promoted without review |
| `DEFAULT_REVIEW_THRESHOLD` | `0.70` | Minimum confidence for VECTOR_MATCH results to be accepted |
| `EXACT_MATCH_CONFIDENCE` | `1` | Fixed confidence assigned to all EXACT_MATCH results |
| `GLOBAL_VECTOR_DISCOUNT` | `0.92` | Multiplier applied to GlobalEmbedding similarity scores |
| `EMBEDDING_DIMENSIONS` | `768` | Gemini embedding output dimensionality |
| `TOP_N_SEEDS` | `15` | Max unique descriptions held for the Quick Seed interview (Phase 1 stops once this many are accumulated) |
| `PHASE2_CONCURRENCY` | `5` | Max concurrent LLM calls during Phase 2 (lowered from 15 to avoid Gemini quota bursting) |

> **Note**: `autoPromoteThreshold` and `reviewThreshold` are also stored on the `Tenant` model so tenants can customise them. Workers fetch fresh values per-job. The constants above are the system defaults applied when creating new tenants.

### `processingHint`

System-managed field on `Category`. Values used by the classification pipeline:

| Value | Meaning |
|---|---|
| `API_STOCK` | Requires investment enrichment (ticker/qty/price) before promotion |
| `API_CRYPTO` | Requires investment enrichment (ticker/qty/price) before promotion |
| `API_FUND` | Requires investment enrichment (ticker/qty/price) before promotion |
| `MANUAL` | Requires manual investment enrichment before promotion |

Cannot be changed via the Admin API (returns 400 if attempted).

---

## File Inventory (backend service)

| File | Purpose |
|---|---|
| `src/config/classificationConfig.js` | All AI classification tuning constants (thresholds, dimensions, concurrency) |
| `src/services/categorizationService.js` | 4-tier waterfall classification + `recordFeedback()` which writes `GlobalEmbedding` |
| `src/services/geminiService.js` | Gemini API wrapper for LLM classification + embedding generation |

For the admin route files themselves, see `docs/specs/api/11-admin-api.md`.

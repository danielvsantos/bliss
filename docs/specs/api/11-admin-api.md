# 11. Admin API

Internal administration endpoints for managing default categories and the cross-tenant classification system. These endpoints are **not user-facing** — they are used by Bliss operations staff for category provisioning, metadata maintenance, and embedding quality management.

---

## Authentication

All admin endpoints use a static API key, **not** a user JWT session.

- **Header**: `x-admin-key: <value>`
- **Env var**: `ADMIN_API_KEY`
- Returns `401` if the header is missing, incorrect, or if `ADMIN_API_KEY` is not set in the environment.

This mirrors the pattern used by `DELETE /api/plaid/items/hard-delete`.

---

## OpenAPI Spec

Full machine-readable spec: `bliss-finance-api/openapi/admin.yaml`

---

## Endpoints

### `GET /api/admin/default-categories`

**File**: `pages/api/admin/default-categories/index.js`

Lists all categories defined in `lib/defaultCategories.js` enriched with live database statistics.

**Response**: Array of objects, each containing:

| Field | Description |
|---|---|
| `code` | `SNAKE_UPPER_CASE` identifier (e.g. `GROCERIES`) |
| `name` | Human-readable display name |
| `group` | Top-level UI grouping (e.g. `Food & Drink`) |
| `type` | Broad transaction type (e.g. `Essentials`) |
| `icon` | Emoji icon (nullable) |
| `processingHint` | System-managed hint (e.g. `SALARY`, `API_STOCK`). Null for most categories. |
| `portfolioItemKeyStrategy` | How portfolio items are keyed for this category (`TICKER`, `CATEGORY_NAME`, etc.) |
| `tenantCount` | Number of tenant `Category` rows currently using this `defaultCategoryCode` |
| `globalEmbeddingCount` | Number of `GlobalEmbedding` rows for this code (cross-tenant Tier 2b classification data) |

**Use case**: Auditing category coverage and embedding density before a regenerate-embeddings run. Low `globalEmbeddingCount` values indicate categories that will rely more heavily on LLM classification for new tenants.

---

### `POST /api/admin/default-categories`

**File**: `pages/api/admin/default-categories/index.js`

Provisions a new default category to **all existing tenants** simultaneously.

**Body**:

| Field | Required | Description |
|---|---|---|
| `code` | Yes | `SNAKE_UPPER_CASE`. Must match `/^[A-Z0-9_]+$/`. Must be unique. |
| `name` | Yes | Human-readable display name |
| `group` | Yes | Top-level UI grouping |
| `type` | Yes | Broad transaction type |
| `icon` | No | Emoji icon |
| `processingHint` | No | Rarely needed — check existing categories first. Cannot be changed via PUT once set. |
| `portfolioItemKeyStrategy` | No | Defaults to `IGNORE` |

**Behaviour**:
- Creates one `Category` row per existing tenant using `createMany({ skipDuplicates: true })` — safe to re-run.
- Returns `409` if any `Category` row with this code already exists (use PUT to update).
- **Does not update `defaultCategories.js`** — this file must be updated manually so that new signups also receive the category.

**Response**: `{ provisioned: N, note: "Remember to add this category to defaultCategories.js..." }`

---

### `PUT /api/admin/default-categories/:code`

**File**: `pages/api/admin/default-categories/[code].js`

Updates category metadata across **all tenant `Category` rows** that share this `defaultCategoryCode`.

**Body** (all fields optional; at least one required):

| Field | Description |
|---|---|
| `name` | New display name — pushed to all tenant rows |
| `group` | New group — pushed to all tenant rows |
| `type` | New type — pushed to all tenant rows |
| `icon` | New emoji icon — pushed to all tenant rows |
| `portfolioItemKeyStrategy` | New portfolio key strategy — pushed to all tenant rows |
| `newCode` | Renames the code to a new `SNAKE_UPPER_CASE` value. Cascades to all tenant `Category` rows and all `GlobalEmbedding` rows for this code. Returns `409` if the new code is already taken. |

**Protected field**: `processingHint` cannot be set or changed via this endpoint. Returns `400` if included. It is system-managed and changes require a code change + migration.

**After updating**: Also update `defaultCategories.js` manually to keep new signups consistent.

**Response**: `{ updatedTenantCategories: N, globalEmbeddingsRenamed: N, renamedTo?: string, note: string }`

---

### `POST /api/admin/default-categories/:code/regenerate-embeddings`

**File**: `pages/api/admin/default-categories/[code]/regenerate-embeddings.js`

Re-generates Gemini embedding vectors for all existing `GlobalEmbedding` rows under this code.

**What it does**:
- Fetches all `GlobalEmbedding` rows where `defaultCategoryCode === code`.
- For each row: calls Gemini to regenerate the `embedding` vector and updates it in place.
- Processing is **sequential** (not parallel) to avoid Gemini rate-limiting.
- Synchronous response — waits for all rows to complete before returning.

**What it does NOT do**:
- Does not create new `GlobalEmbedding` rows. Rows are only created by the classification pipeline when real users confirm transactions against a default category.
- Does not delete or modify `StagedImportRow` or `TransactionEmbedding` data.

**Use cases**:
- After a Gemini model upgrade (refresh all vectors with the new model output)
- After a code rename (verify renamed rows still classify correctly)
- Periodic quality refresh

**Response**: `{ regenerated: N, failed: N, message?: string }`

---

## Data Architecture

### `defaultCategories.js`

**File**: `bliss-finance-api/lib/defaultCategories.js`

The source of truth for all default category definitions. Used to:
1. Seed categories for new tenant sign-ups (at tenant creation time)
2. Power the `GET /api/admin/default-categories` stats endpoint (as the authoritative list)

**Important**: The admin API endpoints (`POST` to provision, `PUT` to update) operate directly on the database and do **not** automatically update this file. Manual updates to `defaultCategories.js` are always required after provisioning or renaming a category.

### `GlobalEmbedding`

The cross-tenant embedding table that powers **Tier 2b (VECTOR_MATCH_GLOBAL)** classification.

| Field | Description |
|---|---|
| `defaultCategoryCode` | The default category this embedding represents |
| `description` | Normalised transaction description confirmed by a real user |
| `embedding` | Gemini vector(768) — cosine similarity searched at classification time |
| `source` | `USER_CONFIRMED` or `AUTO_CONFIRMED` |

**How rows are created**: Only via the classification feedback pipeline when a user (from any tenant) confirms a transaction against a category that has a `defaultCategoryCode`. Bliss uses this confirmation to add the description to the global pool, so all future tenants benefit from it immediately.

**Cross-tenant discount**: During classification, `GlobalEmbedding` matches are multiplied by `0.92` to produce a slightly lower confidence than tenant-scoped `TransactionEmbedding` matches. This reflects that a global match is less certain than a match from the same tenant's own history.

### `processingHint`

A system-managed field on `Category` that controls special processing behavior:

| Value | Meaning |
|---|---|
| `SALARY` | Income categorisation hint |
| `API_STOCK` | Investment: requires ticker/quantity/price enrichment |
| `API_CRYPTO` | Investment: requires ticker/quantity/price enrichment |
| `MANUAL` | Investment: manual enrichment required |
| `API_FUND` | Investment: automated fund pricing via Twelve Data with manual fallback |

`processingHint` is set at category creation time and cannot be changed via the Admin API (400 if attempted). Changes require a code change + migration.

---

## Backend Admin Route

The backend service (`bliss-backend-service`) exposes a single admin endpoint:

### `POST /api/admin/regenerate-embedding`

- **Auth**: `apiKeyAuth` middleware (`x-api-key` header)
- **Body**: `{ description: string, defaultCategoryCode: string }`
- **Purpose**: Regenerates a single Gemini embedding for a `GlobalEmbedding` row. Called sequentially by the finance-api's `regenerate-embeddings` endpoint for each row under a given category code.
- **File**: `bliss-backend-service/src/routes/adminRoutes.js`
- **Response**: `{ ok: true }`

---

## File Inventory

| File | Purpose |
|---|---|
| `pages/api/admin/default-categories/index.js` | `GET` list with stats, `POST` provision to all tenants |
| `pages/api/admin/default-categories/[code].js` | `PUT` update metadata + optional code rename |
| `pages/api/admin/default-categories/[code]/regenerate-embeddings.js` | `POST` refresh Gemini vectors for all GlobalEmbedding rows under a code |
| `lib/defaultCategories.js` | Source of truth — must be kept in sync with DB manually after admin changes |
| `openapi/admin.yaml` | OpenAPI 3.0 spec for all admin endpoints |

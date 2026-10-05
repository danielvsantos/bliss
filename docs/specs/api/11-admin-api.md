# 11. Admin API

Internal administration endpoints for managing default categories, the cross-tenant classification system and the invite-only sign-up allowlist. These endpoints are **not user-facing** — they are used by Bliss operations staff for category provisioning, metadata maintenance, and embedding quality management. (Tenant-admin rebuilds live in [03-reference-data-management.md §3.4](03-reference-data-management.md#34-maintenance--rebuild-operations); since #100 their history is shown in Settings → Processing, see [26-activity-api.md](26-activity-api.md).)

> **LLM provider abstraction.** Embeddings are generated via `services/llm/` (supports Gemini, OpenAI, or Anthropic). References to "Gemini" below refer to the currently-configured embedding provider. See [Backend Spec 20 — LLM Provider Abstraction](../backend/20-llm-provider-abstraction.md).

---

## Authentication

All admin endpoints use a static API key, **not** a user JWT session.

- **Header**: `x-admin-key: <value>`
- **Env var**: `ADMIN_API_KEY`
- Returns `401` if the header is missing, incorrect, or if `ADMIN_API_KEY` is not set in the environment.

This mirrors the pattern used by `DELETE /api/plaid/items/hard-delete`.

---

## OpenAPI Spec

Full machine-readable spec: `apps/api/openapi/admin.yaml`

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

### Invite-only sign-up allowlist

`/api/admin/invites` (`pages/api/admin/invites.js`, #99) manages the per-email allowlist enforced when `SIGNUP_MODE=invite_only` (see [User Identity §1.1](01-user-identity.md#invite-only-gate-99)). It works whatever `SIGNUP_MODE` is, so invites can be loaded before the gate is turned on, and takes effect immediately (no redeploy).

Same `x-admin-key` auth as above (`isAdminAuthorized(req, 'admin/invites')`, fails closed). The route is also on `INTEGRATION_DENYLIST`, so an integration token is refused (`403 NOT_AVAILABLE_TO_INTEGRATIONS`) before the key check runs. This is the only route that returns invited emails; it never logs them.

| Method | Request | Responses |
|---|---|---|
| `GET` | `?status=unused\|used` (optional) | `200 { invites: [{ id, email, note, createdAt, usedAt, usedByTenantId }] }` newest first; `400` for another status |
| `POST` | `{ email, note? }` | `201 { invite }`; `400` invalid email, non-string note or note > 200 chars; `409 { code: 'INVITE_EXISTS' }` |
| `DELETE` | JSON body `{ email }` or `{ id }` (preferred), or `?email=` / `?id=` | `204`; `400` neither given; `404 { code: 'INVITE_NOT_FOUND' }`; `409 { code: 'INVITE_ALREADY_USED' }` |

- **Normalization**: every email is trimmed + lowercased on write and lookup (`services/signupInvite.service.js` does it internally). `Ana.B+x@Gmail.com` is stored as `ana.b+x@gmail.com` and matches only that address (no dot or plus folding).
- **Single-use**: a sign-up consumes the invite (`usedAt`, `usedByTenantId`) inside the tenant-creation transaction. A used invite cannot be revoked (`409`): it is audit history and its tenant already exists. The delete is conditional on `usedAt IS NULL`, so an invite consumed between the read and the delete is not removed.
- **No expiry**: an invite stays valid until used or revoked.
- **Keep emails out of URLs**: request URLs end up in platform access logs, so prefer the JSON body for `DELETE` (the script does). `POST` already carries the email in its body.

**Operator script** — `apps/api/scripts/manage-invites.mjs` (also `pnpm --filter @bliss/api invites …`) calls this endpoint over HTTP, so it works against a remote deployment without database credentials:

```bash
ADMIN_API_KEY=… BLISS_API_URL=https://<api-host> node apps/api/scripts/manage-invites.mjs add ana@example.com --note "Ana – college"
ADMIN_API_KEY=… node apps/api/scripts/manage-invites.mjs list [--unused|--used] [--url https://<api-host>]
ADMIN_API_KEY=… node apps/api/scripts/manage-invites.mjs revoke ana@example.com
```

Base URL: `--url`, else `BLISS_API_URL`, else `NEXTAUTH_URL`, else `http://localhost:3000`. Exits `1` when `ADMIN_API_KEY` is missing (before any request), on a usage error, on `401` ("ADMIN_API_KEY rejected, or not configured on the server") and on any other non-2xx.

**Data model** — `SignupInvite` (`id` cuid, `email` unique, `note?`, `createdAt`, `usedAt?`, `usedByTenantId?` → `Tenant` `onDelete: SetNull`). It is a **global** table with no `tenantId`, by design: an invite exists before its tenant does. `email` is deterministically encrypted (searchable) like `User.email` and listed in the key-rotation coverage manifest, so a plaintext SQL insert never matches.

### Plaid webhook check

`/api/admin/plaid-webhooks` (`pages/api/admin/plaid-webhooks.js`) shows, for each `PlaidItem`, the webhook URL Plaid has registered (`/item/get`) next to the API's `PLAID_WEBHOOK_URL`, plus Plaid's `last_webhook` and last transaction update times. Plaid stores the webhook per Item at link time, so changing `PLAID_WEBHOOK_URL` never reaches existing Items; `POST` re-points the mismatched ones with `/item/webhook/update`. It runs server-side because the Plaid calls need each Item's access token, which only the API can decrypt; access tokens are never returned or logged.

Same `x-admin-key` auth as above, and on `INTEGRATION_DENYLIST`.

| Method | Request | Responses |
|---|---|---|
| `GET` | `?tenantId=` (optional) | `200 { plaidEnv, expectedWebhook, items: [{ id, tenantId, institutionName, status, lastSync, registeredWebhook, matches, lastWebhookSentAt, lastWebhookCode, lastSuccessfulUpdate, lastFailedUpdate, plaidItemError, updated, error }] }` |
| `POST` | `{ tenantId? }` | `200` same report, `updated: true` on re-pointed Items; `400` when `PLAID_WEBHOOK_URL` is unset |

A Plaid failure for one Item is reported in its `error` field; the request still answers `200`.

**Operator script** — `apps/api/scripts/check-plaid-webhooks.mjs`, no dependencies, no database or Plaid credentials:

```bash
ADMIN_API_KEY=… node apps/api/scripts/check-plaid-webhooks.mjs --url https://<api-host> [--tenant <id>] [--fix]
```

---

## Data Architecture

### `defaultCategories.js`

**File**: `apps/api/lib/defaultCategories.js`

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

The backend service (`apps/backend`) exposes a single admin endpoint:

### `POST /api/admin/regenerate-embedding`

- **Auth**: `apiKeyAuth` middleware (`x-api-key` header)
- **Body**: `{ description: string, defaultCategoryCode: string }`
- **Purpose**: Regenerates a single Gemini embedding for a `GlobalEmbedding` row. Called sequentially by the finance-api's `regenerate-embeddings` endpoint for each row under a given category code.
- **File**: `apps/backend/src/routes/adminRoutes.js`
- **Response**: `{ ok: true }`

---

## File Inventory

| File | Purpose |
|---|---|
| `pages/api/admin/default-categories/index.js` | `GET` list with stats, `POST` provision to all tenants |
| `pages/api/admin/default-categories/[code].js` | `PUT` update metadata + optional code rename |
| `pages/api/admin/default-categories/[code]/regenerate-embeddings.js` | `POST` refresh Gemini vectors for all GlobalEmbedding rows under a code |
| `pages/api/admin/invites.js` | `GET`/`POST`/`DELETE` the invite-only sign-up allowlist (#99) |
| `services/signupInvite.service.js` | Invite lookup, atomic consumption, admin CRUD, privacy-safe logging |
| `scripts/manage-invites.mjs` | Operator CLI over `/api/admin/invites` |
| `pages/api/admin/plaid-webhooks.js` | `GET` report / `POST` repair of each PlaidItem's registered Plaid webhook |
| `scripts/check-plaid-webhooks.mjs` | Operator CLI over `/api/admin/plaid-webhooks` |
| `lib/defaultCategories.js` | Source of truth — must be kept in sync with DB manually after admin changes |
| `openapi/admin.yaml` | OpenAPI 3.0 spec for all admin endpoints |

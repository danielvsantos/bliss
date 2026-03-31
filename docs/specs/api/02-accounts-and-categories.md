# 2. Core Entities (API)

This document outlines the API implementation for the core data entities in the Bliss Finance application: **Accounts** and **Categories**.

---

## 2.1. Accounts

The Accounts API, located at `pages/api/accounts.js`, provides full CRUD functionality for managing bank accounts within a tenant.

### Endpoints

- **`GET /api/accounts`**: Retrieves a list of accounts for the authenticated user's tenant. Supports filtering by `countryId`, `currencyCode`, and `ownerId`, as well as pagination and sorting.
- **`POST /api/accounts`**: Creates a new account. Performs extensive validation to ensure that the specified bank, currency, country, and owners are all valid and associated with the tenant.
- **`PUT /api/accounts?id={accountId}`**: Updates an existing account. Includes pre-transaction validation to verify any changed fields and handles the addition and removal of account owners.
- **`DELETE /api/accounts?id={accountId}`**: Deletes an account. Includes a safeguard to prevent the deletion of an account that has associated transactions, thus maintaining data integrity.

### Data Model (`Account`)

- `id` (Integer): The unique identifier for the account.
- `name` (String): The user-defined name for the account.
- `accountNumber` (String): The account number. **Encrypted at rest using AES-256-GCM.**
- `bankId` (Integer): Foreign key to the `Bank` entity.
- `currencyCode` (String): Foreign key to the `Currency` entity.
- `countryId` (String): Foreign key to the `Country` entity.
- `owners` (Relation): Many-to-many with `User` via the `AccountOwner` join table.

### Business Logic & Security

- **Encryption at Rest**: The `accountNumber` field is encrypted using AES-256-GCM with a random salt per entry (non-searchable). Decryption is handled transparently by Prisma middleware.
- **Authorization**: All queries are strictly scoped to the `tenantId` of the authenticated user.
- **Validation**: `POST` and `PUT` endpoints validate that all associated entities (banks, currencies, countries, owners) belong to the current tenant.
- **Deletion Protection**: An account cannot be deleted if it has any linked transactions.
- **Auditing**: All `CREATE`, `UPDATE`, and `DELETE` operations are recorded in the `AuditLog`.

---

## 2.2. Categories

The Categories API, at `pages/api/categories.js`, provides full CRUD functionality for managing transaction categories.

### Endpoints

- **`GET /api/categories`**: Retrieves a list of categories for the tenant. Supports filtering by `name`, `type`, `group`; pagination; and sorting. The response includes `_count.transactions` (number of transactions tagged to each category) and the full category object including `defaultCategoryCode` and `icon`.
- **`POST /api/categories`**: Creates a new custom category.
- **`PUT /api/categories?id={categoryId}`**: Updates an existing category.
- **`DELETE /api/categories?id={categoryId}`**: Deletes a category, with safeguards.

### Data Model (`Category`)

| Field | Type | Description |
|---|---|---|
| `id` | Integer | Primary key. |
| `name` | String | User-defined display name (e.g. "Groceries"). |
| `group` | String | Broader grouping (e.g. "Eating In"). |
| `type` | String | High-level financial type. Must be one of `ALLOWED_CATEGORY_TYPES`. |
| `icon` | String? | Optional emoji icon (e.g. `🛒`). User-editable. |
| `processingHint` | String? | System-managed field that directs backend workers. **Never user-editable.** |
| `portfolioItemKeyStrategy` | Enum | Controls portfolio item aggregation. System-managed. |
| `defaultCategoryCode` | String? | Stable `SNAKE_UPPER_CASE` identifier from `defaultCategories.js`. `null` for custom tenant categories. Set only at tenant creation; never modified at runtime. |
| `tenantId` | String | Owner tenant. |

### Allowed Types (`ALLOWED_CATEGORY_TYPES`)

Defined in `lib/constants.js`. The `type` field must be one of:
- `Income`
- `Essentials`
- `Lifestyle`
- `Growth`
- `Investments`
- `Asset`
- `Debt`
- `Transfers`

### POST — Create Category

**Request body:**
```json
{
  "name": "Freelance Income",
  "group": "Labor Income",
  "type": "Income",
  "icon": "💼"
}
```

- `name`, `group`, `type` are required.
- `icon` is optional — any emoji string.
- **System-managed fields** (`processingHint`, `portfolioItemKeyStrategy`, `defaultCategoryCode`) are **never accepted** from users. They are silently ignored on POST — these fields are only set during tenant seeding at signup.

### PUT — Update Category

**Request body** (all fields optional):
```json
{
  "name": "Consulting Income",
  "group": "Labor Income",
  "type": "Income",
  "icon": "🧑‍💻"
}
```

- The API accepts `name`, `group`, `type`, and `icon`.
- **System-managed fields** (`processingHint`, `portfolioItemKeyStrategy`, `defaultCategoryCode`) are explicitly blocked — sending any of them returns `400 Bad Request`.
- For **default categories** (those with `defaultCategoryCode != null`), the frontend only sends `name` and `icon`; it does not send `group` or `type` changes. The API itself does not enforce this restriction — it is a UI-layer concern enforced in `category-form.tsx`.

### DELETE — Delete Category

- Returns `404` if the category is not found in the tenant.
- Returns `400` with a descriptive error if the category belongs to a **system-critical group** (i.e., its `processingHint` is non-null and non-`MANUAL`), and it is the **last** category in that group. This prevents the portfolio processing pipeline from losing its routing configuration.
- Note: The UI prevents deleting default categories (`defaultCategoryCode != null`) entirely, so the deletion protection guard at the API level is primarily a safety net for API-level calls.

**"Merge into" on delete**: When deleting a category that has dependent records (transactions, PlaidTransactions, TransactionEmbeddings, PortfolioItems), the API requires a `mergeInto` query parameter specifying the target category ID. All dependent records are atomically reassigned to the target category before deletion within a single Prisma `$transaction`. This allows users to consolidate categories without losing any transaction data. If `mergeInto` is omitted and the category has dependents, the API returns `400` with a descriptive error.

**Post-merge event**: After a successful merge that reassigned transactions (`transactionCount > 0`), the API emits a `TRANSACTIONS_IMPORTED` event with `source: 'CATEGORY_MERGE'`. This triggers the full pipeline rebuild (portfolio sync → cash holdings → analytics → valuation) so that analytics groupings and portfolio data reflect the new category assignments.

### Business Logic

- **Authorization**: All queries are scoped by `tenantId`.
- **Validation**: The `type` field is validated against `ALLOWED_CATEGORY_TYPES`. Invalid values return `400`.
- **Uniqueness**: The `[name, tenantId]` pair must be unique. Duplicate name creation returns `409 Conflict`.
- **Auditing**: All `CREATE`, `UPDATE`, and `DELETE` operations are recorded in the `AuditLog`.

---

## 2.3. Default Categories (`lib/defaultCategories.js`)

The file `lib/defaultCategories.js` is the **canonical source of truth** for the initial category set seeded for every new tenant at signup.

### Structure

Each entry in the exported `DEFAULT_CATEGORIES` array has:

| Field | Description |
|---|---|
| `code` | Stable `SNAKE_UPPER_CASE` identifier. Persisted as `defaultCategoryCode` on the `Category` row. Used for cross-tenant global embedding matching. |
| `name` | Display name (e.g. `"Groceries"`). |
| `group` | Broader grouping (e.g. `"Eating In"`). |
| `type` | One of the 8 canonical types. |
| `icon` | Emoji icon (e.g. `"🛒"`). User can rename this via the UI. |
| `processingHint` | Optional. Directs backend workers (e.g. `"API_STOCK"`, `"MANUAL"`). **Immutable after creation.** |
| `portfolioItemKeyStrategy` | Optional. Controls portfolio item aggregation (`"TICKER"`, `"CATEGORY_NAME"`, etc.). |

### Usage

1. **At signup** (`pages/api/auth/signup.js`): After tenant/user creation, `DEFAULT_CATEGORIES` is read and all entries are bulk-inserted via `prisma.category.createMany()` with the new `tenantId`.
2. **At seed** (`prisma/seed.js`): The same array populates the dev/test database.
3. **Never modified at runtime**: Users can create additional custom categories, but the defaults themselves are static and managed in code.

### Existing Tenant Migration

Existing tenants do **not** automatically receive new default categories when the file is updated. Only new signups and re-seeds include them. If backfilling is needed for existing tenants, a one-off migration script must be written.

### processingHint Values

| Value | Meaning |
|---|---|
| `API_STOCK` | Category is backed by live stock price data from AlphaVantage |
| `API_CRYPTO` | Category is backed by live crypto price data |
| `AMORTIZING_LOAN` | Triggers amortizing loan debt tracking in the portfolio worker |
| `SIMPLE_LIABILITY` | Triggers simple liability tracking |
| `CASH` | Treated as operating cash in the portfolio |
| `MANUAL` | No automated price fetching; values entered manually |
| `TAX_DEDUCTIBLE` | Marks transactions for tax deduction tracking |

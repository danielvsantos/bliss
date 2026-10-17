# 4. Transactions (API)

This document outlines the API implementation for managing transactions, which form the core ledger of the Bliss application.

---

## 4.1. Core Transaction Management

The primary endpoint for transaction management provides full CRUD (Create, Read, Update, Delete) functionality and is located at `pages/api/transactions/index.js`.

### API-Driven UI

A key design principle of the transaction management system is that the backend API is the single source of truth. The frontend UI is a "dumb" client that simply provides user inputs (such as search queries, filters, and sorting preferences) to the API. All the business logic for filtering, sorting, and data retrieval is handled by the backend, which ensures consistency and performance.

### Endpoints

-   **`GET /api/transactions`**: This is a powerful endpoint for retrieving transaction data. It supports a wide range of filters, including by date (year, month, quarter, or arbitrary `startDate`/`endDate` range), entity (category, account, group, type), source (`source` — MANUAL, PLAID, or CSV), and properties (currency, tags, accountCountry), plus an amount range (`amountMin` / `amountMax`, see [Amount filter](#amount-filter-141)). It also provides robust sorting and pagination capabilities to handle large datasets efficiently. The response includes a `totals` object with aggregated `credit`, `debit`, and `balance` (credit minus debit) for the current filter set.
-   **`POST /api/transactions`**: Handles the creation of new transactions. A key feature of this endpoint is its ability to automatically manage `PortfolioItem`s. When a transaction is related to an investment or debt, this endpoint will automatically `upsert` a corresponding portfolio item, linking the two. It also includes special logic for handling debt repayments, which are split into principal and interest components.
-   **`PUT /api/transactions?id={transactionId}`**: Manages the updating of existing transactions. Similar to the `POST` endpoint, it will intelligently update any associated `PortfolioItem` links if the transaction's category or other key details are changed. An edit that changes nothing is a no-op (see [No-op edits](#no-op-edits-141)).
-   **`PATCH /api/transactions/bulk`**: Recategorises up to 50 transactions in one all-or-nothing call (see [Bulk recategorisation](#bulk-recategorisation-141)).
-   **`DELETE /api/transactions?id={transactionId}`**: Handles the deletion of transactions. To ensure data integrity, it also removes any associated `TransactionTag` entries.

### Mandatory Investment Enrichment

`POST` and `PUT` reject with `400` (`{ error, missingFields }`) a transaction whose category is `type = 'Investments'` with `processingHint` `API_STOCK`, `API_FUND` (ETFs and funds) or `API_CRYPTO` unless it carries:
- an `assetQuantity` whose magnitude is greater than 0 (a sell may send it signed)
- an `assetPrice` greater than 0
- a `ticker` containing at least one letter, except in the built-in Funds category (`API_FUND` + `defaultCategoryCode = 'INVESTMENT_FUNDS'`).

This applies to buys and sells alike. Without a quantity, the portfolio engine counts a buy as 1 unit worth the whole amount. Without a ticker, the holding can't be market-priced. The Funds category is the one exemption because private / unlisted funds have no ticker: the holding is keyed `<category>:<description>`, created with `source: MANUAL`, priced from manual values and never sent to Twelve Data. ETFs share the `API_FUND` hint but always have a ticker, so the ETFs category stays strict: a ticker-less ETF would lose market pricing, dividends and look-through and split into a second holding. The exemption is strict by default: an `API_FUND` category without a code (created before codes existed) requires a ticker. `MANUAL` investments (e.g. real estate) stay optional.

The check is `missingInvestmentFields` in `apps/api/utils/investmentEnrichment.js`. Its hint list and ticker rule (`requiresTicker`) come from `@bliss/shared/portfolio` (`enrichment.js`), shared with the Plaid and Smart Import review gates; the web form mirrors it with `getMissingInvestmentFields` (`apps/web/src/lib/investment-utils.ts`).

### Security & Encryption
- **Encryption at Rest**: Two fields on the `Transaction` model are encrypted at rest in the database using AES-256-GCM:
    - `description` (non-searchable)
    - `details` (non-searchable)
- This encryption is handled transparently by a Prisma middleware. Because these fields use non-searchable encryption (with a random salt for each entry), they cannot be used in `WHERE` clauses for filtering. All data is automatically decrypted upon being read from the database.
- **Tenant ownership of foreign keys (#90)**: `POST` and `PUT` load the body's `categoryId` and `accountId` with `findFirst({ where: { id, tenantId } })` before any write. A missing, non-integer or other-tenant ID returns `400` and writes nothing (no Transaction, PortfolioItem, DebtTerms or tag). The foreign keys alone only prove the rows exist, so this check is what prevents a session or Read & write integration token from attaching a transaction to another tenant's account or category.

### Debt Terms Support

The transaction creation and update endpoints (`POST` and `PUT`) now support the inclusion of `DebtTerms`. When a transaction's category is of type `Debt`, the API can accept an optional `debtTerms` object in the request body.

-   **Data Model:** The `DebtTerms` are not stored on the transaction itself. Instead, they are linked to the `PortfolioItem` that is automatically created for the debt. This maintains a clean separation of concerns, where the `Transaction` represents a single event, and the `PortfolioItem` and its associated `DebtTerms` represent the underlying asset.
-   **API Logic:** If a `debtTerms` object is provided for a `Debt` type transaction, the API will first `upsert` the `PortfolioItem` and then create or update the `DebtTerms`, linking it to the portfolio item.

### System Events

All `write` operations (`POST`, `PUT`, `DELETE`) on this endpoint produce system events that are sent to the backend worker service. These events (`MANUAL_TRANSACTION_CREATED`, `MANUAL_TRANSACTION_MODIFIED`) trigger asynchronous background jobs, such as recalculating portfolio valuations, ensuring that the user's financial picture is always up-to-date.

A `PUT` that changes nothing emits no events (#141). Additionally, when tags are assigned or changed on a transaction, a `TAG_ASSIGNMENT_MODIFIED` event is emitted. This event carries the affected `tagIds` and `transactionScopes` (year, month, currency, country) so the backend can incrementally rebuild the tag analytics cache for only the impacted dimensions.

### Amount filter (#141)

`amountMin` and `amountMax` on `GET /api/transactions` are optional, **unsigned magnitudes in the transaction's own currency**, both inclusive. They are matched against whichever of `credit` / `debit` is set (amounts are stored unsigned), at 2-decimal precision: each bound is rounded half-up to cents and the range is widened by half a cent, so a stored `2003.76000000` (or an FX-derived `2003.7649`) matches `2003.76`. An exact amount is `amountMin = amountMax`, e.g. `amountMin=2003.76&amountMax=2003.76`; a missing bound is open.

- `400` when a value is negative or not a plain decimal, or when `amountMin > amountMax` after rounding.
- The clause sits in the shared filter (inside `AND`), so it combines with every other filter and applies to the page, `total` and `totals`.
- The response `filters` echo includes the rounded `amountMin` / `amountMax` (`null` when absent).

Parsing lives in `apps/api/utils/amountFilter.js` (`parseAmountRange`). Descriptions stay unsearchable (encrypted with per-value keys); the amount is the usual way to find one remembered transaction.

### No-op edits (#141)

`PUT` builds the scalar `data` it would write (`nextData`) and compares it with the stored row using `diffTransactionUpdate` (`apps/api/utils/transactionDiff.js`): dates by instant, `Decimal(18,8)` columns at 8 dp, `null` / `''` / absent alike for optional text, tags as a set (only when `tags` was sent), and the audit `userId` ignored. When nothing differs (and no `debtTerms` was supplied), the route writes nothing, sends no classifier feedback and emits **no events**, and answers `200` with the current transaction in the same shape as an update. Agents (`update_transaction`) and the edit form resend the whole record, so this removes background work and a "busy" processing status for edits that change nothing. The diff compares exactly the object the update writes, so the field list cannot drift.

### Bulk recategorisation (#141)

**`PATCH /api/transactions/bulk`** (`pages/api/transactions/bulk.js`), MCP tool `bulk_update_transactions`.

- **Body:** `{ ids: number[], categoryId: number }`: 1 to 50 distinct positive integer IDs.
- **Access:** as `PUT`: admin / member sessions and Read & write integration keys; viewers and Read-only keys get `403` from `withAuth`. Same `transactions` rate limiter, so one bulk call is one request.
- **All-or-nothing.** Every check runs before any write:

| Status | `code` | When |
|---|---|---|
| 400 | `INVALID_BODY` | `ids` empty, longer than 50, non-integer or duplicated; `categoryId` missing or not a positive integer |
| 400 | `CATEGORY_NOT_FOUND` | `categoryId` is not in the caller's tenant (`Category not found in this tenant.`, as `PUT`) |
| 400 | `CATEGORY_NOT_ALLOWED` | the target category is `Investments` or `Debt` |
| 404 | `TRANSACTIONS_NOT_FOUND` | an ID does not exist or belongs to another tenant; `ids` lists the missing IDs, computed from the request, so a foreign row is never read or revealed |
| 400 | `ROWS_NOT_ALLOWED` | a selected row is currently in an `Investments` or `Debt` category; `ids` names them |

  Moves into or out of portfolio categories need ticker / quantity / price per row and change holdings, so they stay single-row `PUT`s. Members have no per-account permissions; the tenant scope is the ownership check (#90).
- **Write:** rows already in the target category are skipped. The rest are written with one `updateMany({ id in changed, tenantId })` (`categoryId`, audit `userId`) inside `$transaction`; a short count (a row deleted meanwhile) throws and rolls back.
- **Classifier feedback:** one fire-and-forget `POST /api/feedback/batch` with `{ description, categoryId, transactionId }` per changed row, the same `recordFeedback` (DescriptionMapping write-through + embedding) a single `PUT` triggers.
- **One event per call:** a single `TAG_ASSIGNMENT_MODIFIED` whose `transactionScopes` are the deduplicated `{ year, month, country, type, group }` of every changed row's old and new category, with no `tagIds` and no `currency`, plus `_trigger` from `eventOrigin` (`agent` for keys). It is the backend's scoped-analytics event: the scheduler only reads `tenantId` + `transactionScopes` and enqueues one debounced `scoped-update-analytics` job that recomputes regular and tag analytics. A category change touches neither cash holdings nor the portfolio, so the `MANUAL_TRANSACTION_MODIFIED` chain would be wasted work; do not turn this into a per-row loop. Scopes omit the native currency so the analytics worker recomputes (and, when a slice empties, clears) the whole slice (see backend spec 05, "Emptied slices").
- **Response:** `200 { updated: [ids], unchanged: [ids] }`, in request order. When every row is unchanged, nothing is written and no feedback or events are sent.

### Merchant History

**`GET /api/transactions/merchant-history`** (`pages/api/transactions/merchant-history.js`)

Returns recent promoted Plaid transactions matching a merchant name, used by the Transaction Review inbox to show historical context for a merchant.

-   **Auth**: JWT via `withAuth`.
-   **Query params**: `description` (required, the merchant name to search), `limit` (optional, default 10, max 50).
-   **Logic**: Because `Transaction.description` is encrypted (non-searchable), this endpoint searches `PlaidTransaction` by `merchantName` and `name` fields (unencrypted, case-insensitive contains) where `promotionStatus = 'PROMOTED'`. Results are scoped to the tenant's Plaid items and enriched with category data.
-   **Response**: Array of objects with `id`, `transaction_date`, `description`, `debit`, `credit`, `currency`, `source`, `category` (with name/group), and `account`.

---

## 4.2. Bulk CSV Import (Smart Import — Native Adapter)

All CSV imports are now handled through the Smart Import pipeline (`/api/imports/*`). The "Bliss Native CSV" system adapter provides a direct replacement for the retired dumb import: it resolves account and category by name or numeric ID from CSV columns, auto-confirms fully-resolved rows, and routes investment rows (ticker, quantity, price) into the enrichment flow.

**To import CSV data**, navigate to `/smart-import?adapter=native`. Download the template from the adapter manager, fill in the `transactiondate`, `description`, `debit`/`credit`, `account`, `category`, and optionally `ticker`, `assetquantity`, `assetprice` columns, then upload through the Smart Import flow.

See the Smart Import API docs (`/api/imports/*`) and backend spec `09-smart-import.md` for full pipeline details.

### Analytics Event Production

A key responsibility of the transaction endpoints is to produce events for the backend analytics engine. Whenever a transaction is created, updated, or deleted, a `MANUAL_TRANSACTION_MODIFIED` event is sent to the `/api/events` endpoint of `apps/backend`. This event contains a rich payload of data about the transaction, which allows the backend to efficiently update the analytics cache without needing to make additional queries back to the API.

---

## 4.3. Tags API

The Tags API, located at `pages/api/tags.js`, provides full, tenant-scoped CRUD functionality for managing transaction tags.

- **Uniqueness**: It enforces that tag names must be unique within a tenant (enforced by both pre-check and Prisma `P2002` constraint).
- **Deletion Protection**: It includes a critical safeguard that prevents the deletion of a tag if it is currently associated with any transactions. This maintains the integrity of the transaction ledger.
- **Tag Fields**: Each tag has `id`, `name`, and optional `color`, `emoji`, `budget` (Float), `startDate` (DateTime), and `endDate` (DateTime) fields. `color` is `#RRGGBB` or `null`; `POST`/`PUT /api/tags` refuse anything else with `400` (#93).
- **Pagination**: `GET /api/tags` supports optional `limit` and `offset` query parameters. When `limit` is provided, the response shape is `{ tags: Tag[], total: number }`. Without `limit`, it returns a flat `Tag[]` array for backward compatibility.
- **Response Shape**: The `GET /api/transactions` endpoint returns tags as flat `Tag[]` objects (via `t.tags.map(tt => tt.tag)`), not the raw join-table shape. Each tag object contains `id`, `name`, and optional `color`/`emoji` fields.

---

## 4.4. Transaction Export

**GET** `/api/transactions/export` (`pages/api/transactions/export.js`)

Exports matching transactions as a downloadable Bliss Native CSV file with the `id` column populated, enabling round-trip editing via re-import through Smart Import.

- **Auth**: JWT.
- **Query params**: Same filter set as `GET /api/transactions` — `startDate`, `endDate`, `accountId`, `categoryId`, `group`, `type`, `tags`, `source`, `currencyCode`.
- **Response**: Streamed `text/csv; charset=utf-8` with `Content-Disposition: attachment`. Columns: `id`, `transactiondate`, `description`, `debit`, `credit`, `account`, `category`, `currency`, `details`, `ticker`, `assetquantity`, `assetprice`, `tags` (pipe-separated). Includes UTF-8 BOM for Excel compatibility.
- **Empty result**: Returns header row only (no error).

See `specs/09-smart-import-api.md` for the full export specification and CSV update flow.

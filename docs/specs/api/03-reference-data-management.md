# 3. Reference Data Management (Backend)

This document outlines the API implementation for managing reference data entities: Banks, Countries, and Currencies. It covers both the global, public-facing endpoints and the tenant-specific management of these entities.

---

## 3.1. Reference Data Endpoints

### `pages/api/banks.js`

All endpoints require JWT authentication via `withAuth`.

-   **`GET /api/banks`**: Returns the full global list of banks, ordered alphabetically by name. Banks are reference data (like countries and currencies) — users see all available banks so they can select from the full list during onboarding and settings. Tenant-specific bank selection is managed via the `TenantBank` join table through the tenants API.
-   **`POST /api/banks`**: Creates or links a bank for the tenant. Accepts `{ name: string }`. The name is trimmed and validated (2–100 characters). If a bank with that name already exists globally, it is reused; otherwise a new global `Bank` record is created. In both cases, a `TenantBank` link is upserted for the user's tenant. All operations are wrapped in a `prisma.$transaction`.

### `pages/api/countries.js`

> **Public endpoint** — no JWT authentication. Rate-limited only.

-   **Endpoint**: `GET /api/countries`
-   **Responsibility**: Returns a list of all countries, including their `id`, `name`, and `emoji`, ordered alphabetically. It uses the shared singleton instance of the Prisma client.

### `pages/api/currencies.js`

> **Public endpoint** — no JWT authentication. Rate-limited only.

-   **Endpoint**: `GET /api/currencies`
-   **Responsibility**: Returns a list of all currencies (with `id`, `name`, `symbol`), ordered alphabetically. It uses the shared singleton instance of the Prisma client.

---

## 3.2. Tenant-Specific Reference Data

The `tenants.js` API provides endpoints for reading, updating, and deleting a tenant's configuration.

### `pages/api/tenants.js` - The `GET` Handler

-   **Endpoint**: `GET /api/tenants?id={tenantId}`
-   **Responsibility**: Returns the tenant object with all relations. The response includes:
    -   `countries`, `currencies`, `banks` — resolved from join tables with full entity details.
    -   `plaidLinkedBankIds` — an array of `bankId` values from the tenant's `PlaidItem` records, used by the frontend to show which banks have active Plaid connections.
    -   `transactionYears` — a descending list of distinct years extracted from the tenant's transactions (via raw SQL `EXTRACT(YEAR ...)`), used to populate year filter dropdowns.

### `pages/api/tenants.js` - The `PUT` Handler

-   **Endpoint**: `PUT /api/tenants?id={tenantId}`
-   **Responsibility**: This endpoint is the single point of control for updating a tenant's configuration, including their chosen banks, countries, and currencies.

#### Data Flow and Logic:

1.  **Authentication and Authorization**: The handler first verifies the user's JWT and ensures that the `tenantId` in the token matches the `id` in the query string. This prevents a user from modifying another tenant's settings.
2.  **Validation**:
    -   It receives arrays of `countries` (string IDs), `currencies` (string IDs), and `bankIds` (numeric IDs).
    -   It performs a series of validation checks in parallel (`Promise.all`) to ensure that every ID provided in these arrays corresponds to a valid, existing record in the respective master tables (`Country`, `Currency`, `Bank`).
    -   If any invalid IDs are found, it returns a `400 Bad Request` error with a detailed list of the invalid entries.
3.  **Transactional Update**: All database updates are performed within a `prisma.$transaction` to ensure atomicity. Join tables are updated with **conditional-replace** semantics:
    -   **Countries**: Only replaced when the `countries` array is non-empty. If empty or omitted, existing `TenantCountry` associations are preserved.
    -   **Currencies**: Only replaced when the `currencies` array is non-empty. If empty or omitted, existing `TenantCurrency` associations are preserved.
    -   **Banks**: Only replaced when `bankIds` is explicitly present in the request body (`req.body.hasOwnProperty('bankIds')`). If `bankIds` is provided as an empty array, existing associations are cleared. If `bankIds` is omitted entirely, existing associations are preserved.
4.  **Portfolio Currency Auto-Detection**: When currencies are updated, the handler automatically determines the `portfolioCurrency` field:
    -   If `portfolioCurrency` is explicitly provided in the request body, it is validated against the new or existing currency list.
    -   If currencies are being updated and the current `portfolioCurrency` is no longer in the new list, auto-detection kicks in with priority: **USD > EUR > GBP > first currency in list**.
5.  **Event Dispatch**: If the currency list changed (compared to the original state fetched before the update), a `TENANT_CURRENCY_SETTINGS_UPDATED` event is dispatched to the backend via `produceEvent()`.
6.  **Response**: After the transaction is successfully completed, it fetches the updated tenant object with all its relations and returns it to the client.

#### Key Business Rules:

-   Join table updates use conditional-replace semantics — only non-empty provided arrays trigger a delete-and-recreate cycle. This allows partial updates (e.g., updating only the name without touching countries/currencies/banks).
-   The system relies on foreign key constraints to link tenants to the master reference data tables.

### `pages/api/tenants.js` - The `DELETE` Handler

-   **Endpoint**: `DELETE /api/tenants?id={tenantId}`
-   **Responsibility**: Performs a full cascade deletion of the tenant and all associated data within a single `prisma.$transaction`. The deletion order respects foreign key constraints:
    1.  Collects IDs for accounts and portfolio items.
    2.  Deletes dependent records: `AccountOwner`, `DebtTerms`, `PortfolioHolding`, `PortfolioValueHistory`.
    3.  Deletes AI/Import models: `TransactionEmbedding`, `StagedImport`, `ImportAdapter`.
    4.  Deletes `TransactionTag` entries, then `Transaction`, `Tag`, `PortfolioItem`.
    5.  Deletes `DescriptionMapping`, `Account`, `Category`.
    6.  Deletes analytics and insights: `AnalyticsCacheMonthly`, `Insight`.
    7.  Deletes tenant relations: `TenantCountry`, `TenantCurrency`, `TenantBank`, `PlaidItem`.
    8.  Deletes `User` records, then the `Tenant` itself.
-   **Authorization**: Only the tenant's own user can delete it (verified via JWT `tenantId` match).
-   **Response**: `204 No Content` on success.

---

## 3.3. Currency Rates

The Currency Rates API, located at `pages/api/currency-rates.js`, provides full CRUD functionality for managing daily currency exchange rates.

### Endpoints
- **`GET /api/currency-rates`**: Retrieves a list of currency rates. It can be filtered by date components or currency pairs. If no specific currencies are requested, it returns all rates for the currencies configured on the user's tenant. Supports an `id` query parameter to fetch a single currency rate by its ID (returns 404 if not found, 403 if the tenant lacks access to its currencies).
- **`POST /api/currency-rates`**: Creates or updates (upserts) a currency rate for a specific day. Rejects same-currency pairs with `400 Bad Request`. The `provider` field is optional on POST.
- **`PUT /api/currency-rates?id={rateId}`**: Updates an existing currency rate. The `provider` field is **required** on PUT (returns 400 if missing). Rejects same-currency pairs with `400 Bad Request`.
- **`DELETE /api/currency-rates?id={rateId}`**: Deletes a specific currency rate.

### Business Logic
- **Authorization**: All operations are authorized at the tenant level. A user can only view or manage rates for currencies that are explicitly enabled for their tenant. This is handled by a `validateCurrencies` helper function that checks against the `TenantCurrency` join table.
- **Same-Currency Rejection**: Both POST and PUT reject currency pairs where `currencyFrom` equals `currencyTo` (case-insensitive), returning `400` with error `"Invalid currency pair"`.
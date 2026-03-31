# 3. Reference Data Management (Backend)

This document outlines the API implementation for managing reference data entities: Banks, Countries, and Currencies. It covers both the global, public-facing endpoints and the tenant-specific management of these entities.

---

## 3.1. Reference Data Endpoints

### `pages/api/banks.js`

All endpoints require JWT authentication via `withAuth`.

-   **`GET /api/banks`**: Returns the full global list of banks, ordered alphabetically by name. Banks are reference data (like countries and currencies) — users see all available banks so they can select from the full list during onboarding and settings. Tenant-specific bank selection is managed via the `TenantBank` join table through the tenants API.
-   **`POST /api/banks`**: Creates or links a bank for the tenant. Accepts `{ name: string }`. The name is trimmed and validated (2–100 characters). If a bank with that name already exists globally, it is reused; otherwise a new global `Bank` record is created. In both cases, a `TenantBank` link is upserted for the user's tenant. All operations are wrapped in a `prisma.$transaction` with audit logging.

### `pages/api/countries.js`

-   **Endpoint**: `GET /api/countries`
-   **Responsibility**: Returns a list of all countries, including their `id`, `name`, and `emoji`, ordered alphabetically. It uses the shared singleton instance of the Prisma client.

### `pages/api/currencies.js`

-   **Endpoint**: `GET /api/currencies`
-   **Responsibility**: Returns a list of all currencies, ordered alphabetically. It uses the shared singleton instance of the Prisma client.

---

## 3.2. Tenant-Specific Reference Data

The `tenants.js` API provides an endpoint for updating a tenant's selected reference data.

### `pages/api/tenants.js` - The `PUT` Handler

-   **Endpoint**: `PUT /api/tenants?id={tenantId}`
-   **Responsibility**: This endpoint is the single point of control for updating a tenant's configuration, including their chosen banks, countries, and currencies.

#### Data Flow and Logic:

1.  **Authentication and Authorization**: The handler first verifies the user's JWT and ensures that the `tenantId` in the token matches the `id` in the query string. This prevents a user from modifying another tenant's settings.
2.  **Validation**:
    -   It receives arrays of `countries` (string IDs), `currencies` (string IDs), and `bankIds` (numeric IDs).
    -   It performs a series of validation checks in parallel (`Promise.all`) to ensure that every ID provided in these arrays corresponds to a valid, existing record in the respective master tables (`Country`, `Currency`, `Bank`).
    -   If any invalid IDs are found, it returns a `400 Bad Request` error with a detailed list of the invalid entries.
3.  **Transactional Update**: All database updates are performed within a `prisma.$transaction` to ensure atomicity.
    -   It first deletes all existing associations for the tenant from the join tables (`TenantCountry`, `TenantCurrency`, `TenantBank`).
    -   It then creates new records in these join tables based on the validated arrays provided in the request body.
4.  **Response**: After the transaction is successfully completed, it fetches the updated tenant object with all its relations and returns it to the client.

#### Key Business Rules:

-   A tenant's list of associated banks, countries, and currencies is treated as a complete set. Every `PUT` request replaces the existing set with the new one.
-   The system relies on foreign key constraints to link tenants to the master reference data tables. 

---

## 3.3. Currency Rates

The Currency Rates API, located at `pages/api/currency-rates.js`, provides full CRUD functionality for managing daily currency exchange rates.

### Endpoints
- **`GET /api/currency-rates`**: Retrieves a list of currency rates. It can be filtered by date components or currency pairs. If no specific currencies are requested, it returns all rates for the currencies configured on the user's tenant.
- **`POST /api/currency-rates`**: Creates or updates (upserts) a currency rate for a specific day.
- **`PUT /api/currency-rates?id={rateId}`**: Updates an existing currency rate.
- **`DELETE /api/currency-rates?id={rateId}`**: Deletes a specific currency rate.

### Business Logic
- **Authorization**: All operations are authorized at the tenant level. A user can only view or manage rates for currencies that are explicitly enabled for their tenant. This is handled by a `validateCurrencies` helper function that checks against the `TenantCurrency` join table.
- **Auditing**: All CUD operations are recorded in the `AuditLog`.
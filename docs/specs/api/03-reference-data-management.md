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
---

## 3.4. Maintenance & Rebuild Operations

Tenant-admin-only endpoints that let an admin manually trigger background rebuilds of analytics and portfolio valuations when caches appear stale, and observe the status and history of recent rebuild operations. Surfaced in the UI via the **Settings → Maintenance** tab.

These endpoints live under `/api/admin/rebuild` but are conceptually distinct from the ops-staff `/api/admin/default-categories/*` endpoints — they use tenant JWT auth with a `user.role === 'admin'` check (not the global `ADMIN_API_KEY`), and are scoped strictly to the caller's own tenant.

### OpenAPI Spec

Full machine-readable spec: `docs/openapi/admin.yaml` (see the two `/api/admin/rebuild` operations plus the `Rebuild*` component schemas).

### `pages/api/admin/rebuild.js`

All operations require JWT authentication via `withAuth({ requireRole: 'admin' })`. Members and viewers receive `403 Admin access required` on both GET and POST.

The API route is a **thin proxy** to the backend service. It:

1.  Reads `tenantId` and `requestedBy` (email) server-side from the verified JWT — clients never name the tenant they're operating on.
2.  Validates the `scope` + `payload` shape before round-tripping.
3.  Forwards to the backend at `BACKEND_URL/api/admin/rebuild/{trigger,status}` with an `x-api-key: INTERNAL_API_KEY` header.
4.  Returns the backend's response verbatim (status code + JSON body).

**Rate limits** (dedicated limiters in `utils/rateLimit.js`):

| Endpoint | Limit | Reason |
|----------|-------|--------|
| `POST /api/admin/rebuild` | 20 / 5 min per IP | Caps against accidental trigger-spam. |
| `GET /api/admin/rebuild`  | 300 / 5 min per IP | Polled every 5s by the UI — leaves 3× headroom. |

**Proxy timeout**: `fetchWithTimeout(..., 30_000)`. 30 seconds accommodates the status endpoint when the backend's Redis is under contention from an active rebuild (BullMQ's `getJobs` across the portfolio + analytics queues can take a couple seconds each when a worker is hammering Redis with batch writes). The trigger path stays well under this — it's just a `SET NX EX` + event enqueue.

### `POST /api/admin/rebuild` — Trigger a Rebuild

**Request body**:

```json
{
  "scope": "full-portfolio" | "full-analytics" | "scoped-analytics" | "single-asset",
  "payload": {
    // scope-specific, see below
  }
}
```

**Payload requirements by scope**:

| Scope | Required payload | Notes |
|-------|------------------|-------|
| `full-portfolio` | none | Runs the full rebuild chain: `process-portfolio-changes` → `process-cash-holdings` → `full-rebuild-analytics` → `value-all-assets` + loan processors. |
| `full-analytics` | none | Rebuilds `AnalyticsCacheMonthly` and `TagAnalyticsCacheMonthly` from current transactions. Does **not** trigger portfolio valuation (the cascade is explicitly suppressed when `_rebuildMeta.rebuildType === 'full-analytics'`). |
| `scoped-analytics` | `{ earliestDate: string }` (ISO 8601) | Rebuilds analytics from `earliestDate` onwards. Matches the existing `scope.earliestDate` shape consumed by `analyticsWorker`. |
| `single-asset` | `{ portfolioItemId: number }` | Re-values one portfolio item's full price history and holdings via the existing `value-portfolio-items` job. |

**Response**:

- **`202 Accepted`** — the trigger was enqueued.
  ```json
  {
    "status": "accepted",
    "scope": "full-analytics",
    "requestedAt": "2026-04-23T10:00:00.000Z",
    "lockTtlSeconds": 3600
  }
  ```
- **`400 Bad Request`** — invalid scope or missing scope-specific payload.
- **`403 Forbidden`** — user is not an admin.
- **`409 Conflict`** — a rebuild of this scope is already in flight.
  ```json
  {
    "error": "Rebuild already in progress",
    "scope": "full-portfolio",
    "ttlSeconds": 1750
  }
  ```
  The UI renders the remaining `ttlSeconds` as "Next available in X min" (although this typically resolves within seconds of the previous rebuild finishing — see *Lock Release* below).

### `GET /api/admin/rebuild` — Status + History + Picker Data

Polled every 5 seconds by the Maintenance tab. Returns three views of the tenant's current rebuild state plus a lightweight asset list for the single-asset picker.

**Response** (`200`):

```json
{
  "locks": [
    { "scope": "full-portfolio",   "held": false, "ttlSeconds": null },
    { "scope": "full-analytics",   "held": true,  "ttlSeconds": 1750 },
    { "scope": "scoped-analytics", "held": false, "ttlSeconds": null },
    { "scope": "single-asset",     "held": false, "ttlSeconds": null }
  ],
  "current": [
    {
      "id": "manual-rebuild-full-analytics-<tenantId>-<ts>",
      "name": "full-rebuild-analytics",
      "state": "active",
      "progress": 42,
      "rebuildType": "full-analytics",
      "requestedBy": "admin@example.com",
      "requestedAt": "2026-04-23T10:00:00.000Z",
      "startedAt":   "2026-04-23T10:00:02.000Z",
      "finishedAt":  null,
      "failedReason": null,
      "attemptsMade": 1
    }
  ],
  "recent": [ /* last 20 completed/failed */ ],
  "assets": [
    { "id": 1, "symbol": "AAPL", "currency": "USD", "category": { "name": "Stocks" } },
    { "id": 2, "symbol": "BTC",  "currency": "USD", "category": { "name": "Crypto" } }
  ]
}
```

**Key semantics**:

- **`locks`** — one entry per scope, always 4 entries in the current release. `held` tracks the Redis single-flight lock; `ttlSeconds` is the remaining TTL.
- **`current`** — in-flight rebuild jobs (`active`, `waiting`, or `delayed`). Usually 0-1 entries per scope; different scopes can run in parallel so up to 4 total.
- **`recent`** — the last 20 completed or failed admin-triggered rebuilds, newest first.
- **`assets`** — tenant's portfolio items for the single-asset rebuild picker. Ships alongside status so the Maintenance tab doesn't need a second fetch against `/api/portfolio/items`, which triggers a live price fetch per asset.

**Job filtering**: only BullMQ jobs carrying `data._rebuildMeta` are included. Nightly cron runs, transaction-driven scoped updates, and other queue activity are filtered out so the history reflects only admin-initiated operations.

**Per-rebuild grouping**: a `full-portfolio` rebuild is a chain of 4 BullMQ jobs (`process-portfolio-changes` → `process-cash-holdings` → `full-rebuild-analytics` → `value-all-assets`) that all share the same `_rebuildMeta.requestedAt`. Without grouping, the history would show 4 "Full rebuild" rows per admin click. The status endpoint groups jobs by `requestedAt` and returns **one representative per rebuild**:

1.  **Any active / waiting / delayed subjob** → rebuild is in progress. Surface the latest-started one (its `progress` reflects the current step).
2.  **Any failed subjob** → rebuild failed. Surface the failed one with its `failedReason`.
3.  **All completed** → prefer the **terminal job** (from `TERMINAL_JOBS` in `utils/rebuildLock.js` — `value-all-assets` for full-portfolio, `full-rebuild-analytics` for full-analytics, etc.). Fall back to the latest-finished if no terminal is present.

The single-job scopes (`full-analytics`, `scoped-analytics`, `single-asset`) are one-job chains, so grouping is a no-op for them.

### Concurrency: Redis Single-Flight Lock

Each `(tenantId, scope)` pair has an independent Redis lock at `rebuild-lock:<tenantId>:<scope>` acquired via `SET NX EX 3600` on trigger. While held, a second trigger for the same scope returns `409` with the remaining TTL. Different scopes have independent locks — `full-analytics` and `single-asset` can run in parallel without blocking each other.

Implementation: `apps/backend/src/utils/singleFlightLock.js` (thin wrapper over ioredis `set NX` / `del` / `ttl`).

### Lock Release

Locks release **automatically when the terminal job of the chain completes**, via completion handlers wired into `worker.on('completed')` in both `analyticsWorker` and `portfolioWorker`. The terminal job per scope:

| Scope | Terminal Job | Worker |
|-------|-------------|--------|
| `full-portfolio` | `value-all-assets` | portfolioWorker |
| `full-analytics` | `full-rebuild-analytics` | analyticsWorker |
| `scoped-analytics` | `scoped-update-analytics` | analyticsWorker |
| `single-asset` | `value-portfolio-items` | portfolioWorker |

The release helper (`apps/backend/src/utils/rebuildLock.js`) reads `job.data._rebuildMeta.rebuildType`, looks up the terminal job name for that scope, and releases the lock iff the just-completed job matches.

The 1-hour TTL is a **safety ceiling** for catastrophic failures (worker crash mid-run, Redis split-brain). In the happy path, locks release within seconds of the job finishing, so an admin who sees a rebuild complete can immediately click again if needed.

### Event Propagation: `_rebuildMeta`

Admin-triggered rebuilds are tagged with a `_rebuildMeta` marker on the initial BullMQ job:

```js
{
  rebuildType: 'full-portfolio' | 'full-analytics' | 'scoped-analytics' | 'single-asset',
  requestedBy: 'admin@example.com',
  requestedAt: '2026-04-23T10:00:00.000Z',
}
```

This marker has two purposes:

1.  **History filtering**: `GET /api/admin/rebuild` only returns BullMQ jobs that carry `_rebuildMeta` for the current tenant. Nightly crons and transaction-driven scoped updates run on the same queues but without the marker, so they're excluded from the admin-visible history.

2.  **Lock-release routing**: the marker lets completion handlers determine whether a finished job was the terminal step of an admin rebuild (and therefore should release the lock), vs a routine background job.

For single-job scopes (`full-analytics`, `scoped-analytics`, `single-asset`) the marker stays on the one job that runs and nothing special is needed. For the multi-hop `full-portfolio` chain, the marker propagates through three event hops:

```
process-portfolio-changes (has meta)
    └─ PORTFOLIO_CHANGES_PROCESSED (forwards meta)
        └─ process-cash-holdings (has meta)
            └─ CASH_HOLDINGS_PROCESSED (forwards meta)
                └─ full-rebuild-analytics (has meta)
                    └─ ANALYTICS_RECALCULATION_COMPLETE (forwards meta)
                        └─ value-all-assets (has meta) ← releases lock on completion
```

Event propagation is implemented in `process-portfolio-changes.js`, `cash-processor.js`, and `eventSchedulerWorker.js`. A "no meta in → no meta out" test in the event scheduler guards against accidentally injecting the marker onto non-admin chains.

### History Retention

Admin-triggered rebuild jobs are enqueued with per-job retention overrides:

```js
{
  removeOnComplete: { age: 30 * 24 * 3600 }, // 30 days
  removeOnFail:     { age: 30 * 24 * 3600 },
}
```

This keeps rebuild history available in BullMQ for a full month without bloating Redis with every routine nightly cron run (which uses the default 24-hour retention).

Redis restart wipes this history — if long-term persistent audit is needed in the future, we'd add a dedicated `RebuildJob` Prisma model. For the current single-user-per-tenant usage pattern, in-memory Redis retention is sufficient.

### Cascade Suppression for `full-analytics`

When `ANALYTICS_RECALCULATION_COMPLETE` fires with `isFullRebuild: true`, the event scheduler normally cascades into `value-all-assets` so a full analytics rebuild pulls fresh valuations along with it. For admin-triggered **`full-analytics`** rebuilds we explicitly suppress this cascade — the user asked for analytics only.

The suppression guard in `eventSchedulerWorker` checks `_rebuildMeta?.rebuildType === 'full-analytics'` and short-circuits the cascade in that one case. Every other path (nightly cron, transaction-driven, `full-portfolio` manual rebuild) is unaffected because the check is exact-match on a value that only flows through the manual-rebuild path.

### Frontend: Settings → Maintenance Tab

Component: `apps/web/src/components/settings/maintenance-tab.tsx`. The tab is gated on `user?.role === 'admin'` in `apps/web/src/pages/settings/index.tsx` — members and viewers don't see the entry point (and server-side auth returns 403 if they find the URL anyway).

Four rebuild panels:

1.  **Rebuild all analytics** → `scope: 'full-analytics'`.
2.  **Full rebuild** → `scope: 'full-portfolio'`. (Heading and button copy say "Full rebuild", not "Rebuild portfolio", because this scope runs the entire chain — items → cash holdings → analytics → valuation + loan processors — not just the portfolio step. Calling it "portfolio" was misleading; the scope's backend event name `full-portfolio` is kept for wire-format stability.)
3.  **Rebuild analytics from a date** → date picker + `scope: 'scoped-analytics'`.
4.  **Rebuild a single asset** → searchable combobox fed by `status.assets` + `scope: 'single-asset'`.

Button state derives from the polled status response:

| State | Display |
|-------|---------|
| Idle (lock released, no active job) | `Rebuild …` — clickable |
| Active job matching this scope | `Running… {progress}%` — disabled |
| Lock held but no active job (brief window during TTL expiry) | `Next available in X min` — disabled |
| Trigger mutation in flight | `Starting…` — disabled |

History panel below the buttons renders the last 20 completed/failed rebuilds with state badge (Completed / Failed / Running / Queued), requester email, elapsed time, and failure reason for failed jobs.

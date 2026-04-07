# Bliss API

This is the central API layer for the Bliss platform. It serves as the backend-for-frontend (BFF) for the `bliss-frontend` application, handling user authentication, data querying, and acting as the primary gateway to the `bliss-backend-service`.

## Core Purpose

-   **Authentication & Authorization**: Manages user sign-up, sign-in, and session management using JWT. Sessions are transported via an HttpOnly cookie (never exposed in response bodies or URL parameters). A Redis-backed token denylist enables immediate server-side revocation on sign-out. Role-based access control (`admin` / `member`) enforces tenant ownership rules on sensitive endpoints. It provides a secure and robust identity layer for the entire platform.
-   **Data API**: Provides a rich set of RESTful endpoints for all Create, Read, Update, and Delete (CRUD) operations on core entities like Accounts, Transactions, Categories, and Tags.
-   **Gateway to Backend**: Acts as an intelligent gateway to the backend worker service. It exposes endpoints that, when called, dispatch events and jobs to the `bliss-backend-service` for complex asynchronous processing.
-   **Real-time Enrichment**: For certain high-priority endpoints (like the main portfolio view), it enriches data with real-time information (e.g., fetching live stock/fund prices via Twelve Data) before sending it to the client, ensuring the user always sees the most up-to-date information.
-   **Ticker Resolution**: Provides a ticker search endpoint (`GET /api/ticker/search`) that proxies to the backend's Twelve Data integration for all asset types (stocks, funds, and crypto). When `?type=crypto`, results are filtered and deduplicated for digital currency symbols. Enables autocomplete-style symbol search with ISIN, exchange, and currency resolution for EU-market assets. Ticker values are validated to contain at least one letter (`/[a-zA-Z]/`) across all paths.
-   **Portfolio Currency**: Supports tenant-configurable portfolio display currency via `GET/PUT /api/tenants/settings`. Portfolio items and history endpoints return values in both USD and the tenant's chosen currency, with on-the-fly conversion using stored currency rates.
-   **Plaid Integration**: Full lifecycle management of Plaid bank connections — link token creation, public token exchange, account selection, incremental sync, token rotation, soft disconnect (Pause Sync), and reconnect. Receives real-time Plaid webhook events at `POST /api/plaid/webhook` (ES256 JWT signature-verified in production) and routes them to the backend sync pipeline.
-   **Onboarding API**: Tracks multi-step onboarding progress with server-side persistence. Supports checklist completion (connectBank, reviewTransactions, setPortfolioCurrency, exploreExpenses, checkPnL), setup flow tracking, and dismissal.
-   **AI Insights API**: Serves pre-generated financial insights with filtering by lens/severity, dismissal, and on-demand generation trigger (fire-and-forget to backend service).
-   **Notification Center API**: Aggregates 4 signal types from existing tables (pending review, Plaid errors, onboarding progress, new insights) into a unified summary with read-tracking via `User.lastNotificationSeenAt`.
-   **Equity Analysis**: Provides a dedicated endpoint for analyzing stock-only portfolio composition, enriched with fundamental data from the `SecurityMaster` reference table. Supports grouping by sector, industry, and country with weighted aggregate metrics (P/E ratio, dividend yield).

## Technology Stack

-   **Framework**: [Next.js](https://nextjs.org/). The application leverages the powerful and flexible API route handlers provided by Next.js to build the RESTful API.
-   **Database**: [PostgreSQL](https://www.postgresql.org/). A robust, open-source object-relational database system.
-   **ORM**: [Prisma](https://www.prisma.io/). A next-generation ORM that provides a type-safe database client and powerful migration tools.
-   **Authentication**: JWT-based sessions via `jsonwebtoken`. Tokens are issued with a `jti` (UUID) claim, transported exclusively in an HttpOnly cookie (`token`), and verified on every protected request via `utils/withAuth.js`. The resolved user (including their `role`) is attached to `req.user`. Rolling secret rotation is supported via `JWT_SECRET_CURRENT → JWT_SECRET → JWT_SECRET_PREVIOUS`. Revoked tokens are tracked in Redis (`utils/denylist.js`).
-   **Validation**: [Zod](https://zod.dev/). A TypeScript-first schema declaration and validation library, used to ensure all API inputs are valid and type-safe.

## Security Features

The API implements several key security features to protect user data and ensure platform stability.

### Encryption at Rest

To protect sensitive user information, several fields are encrypted at rest in the database using the **AES-256-GCM** algorithm. This is handled transparently by a custom Prisma middleware, which automatically encrypts data on writes and decrypts it on reads.

-   **User Model**:
    -   `email`: Encrypted with a **searchable** configuration, allowing for user lookups by email while the data remains encrypted in the database.
-   **Account Model**:
    -   `accountNumber`: Encrypted with a **non-searchable** configuration (using a random salt per entry) for maximum security.
-   **Transaction Model**:
    -   `description`: Non-searchable encryption.
    -   `details`: Non-searchable encryption.
-   **PlaidItem Model**:
    -   `accessToken`: Non-searchable encryption.

> **Implementation note**: The encryption middleware handles `create`, `update`, `upsert`, `createMany`, and `updateMany` operations. Both `create` and `createMany` (used by the bulk CSV commit endpoint) are covered. A pre-existing bug where `createMany` bypassed encryption was fixed in Sprint 6.

### Rate Limiting

To prevent abuse and ensure high availability, the API employs a per-route rate-limiting strategy. Each API endpoint has a specifically configured limit based on its function, generally measured as requests per IP address within a 5-minute window.

-   **Strict Limits**: Sensitive endpoints like `/auth/signin` and `/auth/signup` are strictly limited to mitigate brute-force attacks.
-   **Standard Limits**: Most CRUD endpoints for entities like accounts, categories, and portfolio items use a standard limit.
-   **Generous Limits**: High-traffic endpoints like `/transactions` have more generous limits.
-   **Import Limits**: Smart import endpoints (`/api/imports/*`) have dedicated limits for detection, upload, read, and adapter management operations.

### Cookie-Based Session Transport

JWT tokens are **never** included in API response bodies or URL parameters. Upon successful authentication (sign-up, sign-in, or Google OAuth), the token is written to a server-set HttpOnly cookie named `token` via `utils/cookieUtils.js`:

-   **`HttpOnly`**: Prevents JavaScript from reading the cookie, mitigating XSS-based token theft.
-   **`SameSite=Lax`**: Prevents the cookie from being sent on cross-site form POSTs.
-   **`Max-Age=86400`**: Cookie lifetime mirrors the 24 h JWT expiry.
-   **`Path=/`**: Cookie is sent on all API routes.
-   **`Secure` + `Domain=<COOKIE_DOMAIN>`** (production only): Restricts to HTTPS and your configured domain (set via `COOKIE_DOMAIN` env var).

The frontend reads session state via `GET /api/auth/session` (which reads the cookie server-side) rather than from `localStorage`.

### JWT Token Denylist (Server-Side Revocation)

`utils/denylist.js` provides a Redis-backed denylist using `ioredis`. Every JWT is issued with a `jti` UUID claim. On sign-out, the `jti` is written to Redis with a TTL equal to the token's remaining lifetime, enabling immediate revocation before natural expiry.

-   **`addToDenylist(jti, ttlSeconds)`**: Writes the `jti` to Redis with a TTL.
-   **`isRevoked(jti)`**: Called on every authenticated request by `utils/withAuth.js`.
-   **Graceful degradation**: If `REDIS_URL` is not set, logs a one-time warning and no-ops — authentication still works, but tokens cannot be server-side revoked.

**Environment variable required**: `REDIS_URL` (e.g. `redis://localhost:6379`).

### Role-Based Access Control (RBAC)

Users have a `role` field on the `User` model (`'admin'` or `'member'`, default `'member'`). Tenant owners (created via sign-up or first-time Google OAuth) are assigned `role: 'admin'`. Invited users default to `'member'`.

`utils/withAuth.js` supports a `requireRole` option. Endpoints enforcing admin access return `403 Forbidden` if `req.user.role !== 'admin'`:

-   **`POST /api/users`** (invite user): Admin only.
-   **`DELETE /api/users`** (remove user): Admin only.
-   **`PUT /api/tenants/settings`** (update tenant settings): Admin only.

Admins may promote/demote other users via `PUT /api/users?id={id}` by including a `role` field.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `JWT_SECRET_CURRENT` (or `JWT_SECRET`) | JWT signing secret. Startup validation rejects fallback/default values. `JWT_SECRET_CURRENT` takes precedence; `JWT_SECRET` is accepted as a legacy alias. |
| `DATABASE_URL` | PostgreSQL connection string (e.g. `postgresql://user:pass@localhost:5432/bliss`). |

### Optional

| Variable | Description |
|----------|-------------|
| `JWT_SECRET_PREVIOUS` | Previous JWT secret, enabling rolling token rotation. Tokens signed with the previous secret remain valid until they expire naturally. |
| `INTERNAL_API_KEY` | API key for authenticated communication with `bliss-backend-service` (event dispatch, feedback, similar-search). |
| `BACKEND_URL` | URL of the backend service (default: `http://localhost:3001`). |
| `REDIS_URL` | Redis connection string for the JWT token denylist. If unset, server-side revocation is disabled (see [JWT Token Denylist](#jwt-token-denylist-server-side-revocation)). |
| `SENTRY_DSN` | Sentry DSN for error tracking and observability. |

### Startup Validation

The API validates environment variables at startup via `utils/validateEnv.js`. In production, missing `JWT_SECRET_CURRENT`/`JWT_SECRET` or `DATABASE_URL` causes the process to exit with a non-zero code. In development, warnings are logged to the console instead.

## Setup and Running Locally

1.  **Install Dependencies**:
    ```bash
    pnpm install
    ```

2.  **Setup Environment Variables**:
    Create a `.env` file in the root of this project. You will need to provide a `DATABASE_URL` and secrets for authentication. See the `.env.example` file for the full list of required variables.

3.  **Run Database Migrations**:
    Apply the database schema and any pending migrations using Prisma.
    ```bash
    npx prisma generate
    npx prisma migrate dev
    ```

4.  **Run the Development Server**:
    ```bash
    pnpm dev
    ```

The API will now be running at `http://localhost:3000`.

## Testing

| Suite | Command | Runner | Tests |
|-------|---------|--------|-------|
| Unit | `npm run test:unit` | Vitest | ~20 |
| Integration | `npm run test:integration` | Vitest | requires `bliss_test` DB |
| Coverage | `npm run test:coverage` | Vitest v8 | 70% line/fn threshold |

Unit tests are fully mocked — no database or network required. Integration tests invoke Next.js API handlers directly with factory-built `req`/`res` objects and a real `bliss_test` Postgres database.

**Setup for integration tests**: configure `.env.test` with `DATABASE_URL` pointing to `bliss_test`, then run `npx prisma migrate deploy` once against that database.

Test files live under `__tests__/unit/` (Vitest, all deps mocked) and `__tests__/integration/` (real Prisma, mocked rate limiters and Redis).

See [13. Automated Testing & Error Logging](./specs/13-automated-testing-and-error-logging.md) for the full testing strategy and architecture.

## Project Structure

-   **/pages/api**: The core of the application, containing all API route handlers, organized by feature.
-   **/prisma**: Contains the database schema (`schema.prisma`), a history of all migrations, and the database seed script.
-   **/services**: Contains business logic shared across multiple API endpoints (e.g., `auth.service.js`, `transaction.service.js`).
-   **/utils**: Shared utilities including the rate limiter factory, GCS helpers, encryption middleware, cookie helpers (`cookieUtils.js`), CORS handler (`cors.js`), JWT denylist (`denylist.js`), and the `withAuth` higher-order function.
-   **/data**: Sample CSV files used for development and integration testing.
-   **/specs**: Contains detailed markdown documentation for each feature set, providing a deep dive into the API's functionality and business logic.
-   **/openapi**: OpenAPI specification files providing a machine-readable definition of the public-facing APIs.
-   **/utils/currencyConversion.js**: Helper for on-the-fly portfolio currency conversion using the `CurrencyRate` table with 7-day forward-fill.
-   **/pages/api/ticker**: Ticker search proxy endpoint — proxies to the backend's Twelve Data integration for symbol autocomplete.
-   **/pages/api/plaid**: Plaid integration endpoints — `create-link-token.js`, `exchange-public-token.js`, `sync-accounts.js`, `items.js`, `rotate-token.js`, `resync.js`, `disconnect.js`, `sync-logs.js`, `webhook.js`, and the `transactions/` sub-directory for review and promotion.

## System Documentation

This `README.md` provides a high-level architectural overview. For detailed, in-depth information on specific features and endpoints, please refer to the specification documents in the `/specs` directory.

-   **[1. User Identity & Tenant Management](./specs/01-user-identity.md)**
-   **[2. Accounts & Categories](./specs/02-accounts-and-categories.md)**
-   **[3. Reference Data Management](./specs/03-reference-data-management.md)**
-   **[4. Transactions & CSV Import](./specs/04-transactions.md)**
-   **[5. Analytics API](./specs/05-analytics-api.md)**
-   **[6. Portfolio API](./specs/06-portfolio-api.md)**
-   **[8. Plaid Integration API](./specs/08-plaid-integration.md)**
-   **[9. Smart Import API](./specs/09-smart-import-api.md)**
-   **[10. AI Classification & Review API](./specs/10-ai-classification-and-review.md)**
-   **[13. Automated Testing & Error Logging](./specs/13-automated-testing-and-error-logging.md)**
-   **[14. Notification Center](./specs/14-notification-center.md)**
-   **[15. Insights](./specs/15-insights.md)**
-   **[19. SecurityMaster & Equity Analysis API](./specs/19-security-master-api.md)**

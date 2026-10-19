# Multi-Tenant Deployment

Bliss supports multi-tenancy out of the box -- every user gets their own isolated tenant with separate accounts, transactions, and settings. This guide covers the recommended production architecture for hosting Bliss as a multi-user service.

---

## Recommended Stack

Bliss ships a Dockerfile per service ([`docker/`](../../docker/)), so the whole platform runs on a single container host. [Railway](https://railway.app) is the reference target: one project, one private network, one bill.

| Component | Provider | Why |
|-----------|----------|-----|
| **Web** | Railway (nginx container) | Serves the built Vite SPA. Front with a CDN (e.g. Cloudflare) if you need edge caching. |
| **API** | Railway (Next.js container) | Auth (NextAuth), REST routes, Prisma. Long-running, so the connection pool is persistent; size it explicitly (see [Database connection pools](#database-connection-pools)). |
| **Backend** | Railway (Express + BullMQ) | `START_MODE=web` for HTTP + `START_MODE=worker` for jobs, or a single `START_MODE=all` service for low volume. |
| **PostgreSQL** | Railway Postgres (pgvector image) | Standard Postgres 16+ with the `vector` extension. Reachable only on Railway's private network. |
| **Redis** | Railway (managed) | BullMQ job queues and caching. Private network -- set `REDIS_SKIP_TLS_CHECK=true` (Railway private Redis is `redis://`, not `rediss://`). |
| **Error tracking** | [Sentry](https://sentry.io) | Structured error reports with worker context (job name, tenantId, attempt count). |
| **Authentication** | Google OAuth | Frictionless sign-in via NextAuth.js Google provider. |

---

## Architecture Overview

```
Users (Browser)
     |
  app.yoursite.com                 api.yoursite.com
     |                                  |
   Web (nginx)  ----- XHR ----->   API (Next.js)
                                        |
                                        +-- INTERNAL_API_KEY --> Backend (Express + BullMQ)
                                        |                             |
                                        +--------- Postgres ----------+
                                        |        (pgvector)           |
                                        |                          Redis
                                    (all on Railway's private network)
```

All four services live in one Railway **environment**. Service-to-service traffic (`API -> Backend`, everything `-> Postgres/Redis`) stays on the private network via `*.railway.internal` hostnames and never touches the public internet. Only Web and API get public domains.

**Web** and **API** are separate Railway services built from [`docker/Dockerfile.web`](../../docker/Dockerfile.web) and [`docker/Dockerfile.api`](../../docker/Dockerfile.api). The web image bakes `NEXT_PUBLIC_API_URL` at **build time** -- rebuild it whenever the API domain changes.

**Backend** runs as one `START_MODE=all` service for small deployments, or split into `START_MODE=web` (the internal HTTP API the frontend API calls for events and pricing) + `START_MODE=worker` (BullMQ consumers). It never needs a public domain -- the frontend API reaches it over `*.railway.internal`. BullMQ distributes jobs across all worker instances automatically -- add worker replicas to scale job throughput.

**PostgreSQL** uses Railway's pgvector-capable Postgres image. The API container runs `prisma migrate deploy` + `prisma db seed` on startup ([`docker/Dockerfile.api`](../../docker/Dockerfile.api)), so a fresh database is provisioned automatically on first boot.

### Staging environments

Duplicate the Railway environment to get a `staging` copy with the same service wiring. Volume data is **not** copied -- staging comes up with an empty Postgres, which you seed or load from a `pg_dump` of production. Point production at `main` and staging at a `staging` branch, or promote manually.

---

## Key Configuration

### Environment Variables

Set these per Railway service. Use `${{<service>.VAR}}` reference variables for anything that points at another service so URLs resolve to the private network.

| Variable | Where | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | API + Backend | `${{Postgres.DATABASE_URL}}` -- the **internal** connection string. A direct `postgresql://` URL (not `prisma://`). Append `?connection_limit=N&pool_timeout=20` per service to size its pool (see [Database connection pools](#database-connection-pools)). |
| `REDIS_URL` | Backend | `${{Redis.REDIS_URL}}` |
| `REDIS_SKIP_TLS_CHECK` | Backend | `true` -- Railway's private Redis has no `rediss://` endpoint. |
| `INTERNAL_API_KEY` | API + Backend | Service-to-service auth. Must match across all three. |
| `BACKEND_URL` | API | Internal backend address, e.g. `http://bliss-backend.railway.internal:8080`. Used for both event delivery and pricing calls. |
| `NEXTAUTH_URL` | API | The API's public HTTPS URL, e.g. `https://api.yoursite.com`. |
| `FRONTEND_URL` | API | The web app's public origin, e.g. `https://app.yoursite.com`. Drives CORS -- exact match, no trailing slash. |
| `COOKIE_DOMAIN` | API | `.yoursite.com` when web + API are siblings on one root domain (shared session). Leave unset otherwise -- never set it to a `*.up.railway.app` value (public suffix; browsers reject it). |
| `SIGNUP_MODE` | API | Optional. `invite_only` restricts new sign-ups to invited emails; unset means open. See [Invite-only hosting](#invite-only-hosting). |
| `ADMIN_API_KEY` | API | Optional operator credential. Required to manage invites when `SIGNUP_MODE=invite_only`. |
| `NEXT_PUBLIC_API_URL` | Web (build arg) | Baked into the SPA bundle at build time. Rebuild the web image when it changes. |

> **Port note:** Railway injects `PORT` and routes public traffic to it. The API and backend read `process.env.PORT`; the web/nginx image listens on `80` -- set the web service's target port to `80` in Railway's networking settings (or template `nginx.conf` to `listen ${PORT}`).

### Google OAuth

NextAuth.js supports Google as an OAuth provider. Configure in your environment:

| Variable | Value |
|----------|-------|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |

Users can sign up with Google (creates a tenant automatically) or with email/password. Both flows coexist.

**HTTPS is required.** Google's OAuth policy rejects plain-HTTP redirect URIs. Your `NEXTAUTH_URL` must start with `https://`.

**Cross-domain deployments** (frontend and API on different origins) are fully supported. When `NEXTAUTH_URL` is `https://`, Bliss automatically configures NextAuth cookies as `SameSite=None; Secure`, which is necessary for the cross-origin OAuth form POST to carry its CSRF token. No extra configuration is needed — setting `NEXTAUTH_URL` and `FRONTEND_URL` to their respective public HTTPS URLs is sufficient.

In Google Cloud Console, set the Authorized Redirect URI to `<NEXTAUTH_URL>/api/auth/callback/google`.

### Plaid

`PLAID_WEBHOOK_URL` points at the **API's** public URL: `https://<api-domain>/api/plaid/webhook`. The handler lives in [`apps/api/pages/api/plaid/webhook.js`](../../apps/api/pages/api/plaid/webhook.js) and is intentionally unauthenticated -- Plaid signs every call with an ES256 JWT, which the handler verifies in production. The backend needs no public exposure for this. Changing the env var only affects newly linked Items -- call Plaid's `/item/webhook/update` for existing `PlaidItem` rows after a domain change.

### Enable Banking (EU bank sync)

Enable Banking credentials are **per workspace** (#148): each workspace admin creates their own free Enable Banking application (5 accounts in restricted mode) and enters it in **Settings → Bank sync**, so hosted friends never share your application or its quota. The operator only sets the server-wide schedule (`ENABLE_BANKING_SYNC_TIMES`, `ENABLE_BANKING_DAILY_BUDGET`) and, if needed, `ENABLE_BANKING_REDIRECT_URL`, on both the API and the backend. The callback URL (`https://<api-domain>/api/enablebanking/callback`) is the same for every workspace and each admin registers it on their own application.

**Upgrading from the server-wide app:** `ENABLE_BANKING_APP_ID` / `ENABLE_BANKING_PRIVATE_KEY(_PATH)` are no longer read. Right after deploying, save the same application id and key in Settings → Bank sync of the workspace that owns the existing connections; they resume without a reconnect. Then remove the variables (both services warn at startup while they are set). Details: [EU Bank Sync with Enable Banking](/docs/guides/enable-banking#upgrading-from-the-server-wide-setup).

### Sentry

Bliss has built-in Sentry integration. Every worker failure is reported with structured context:

```
Worker: portfolioWorker
Job: value-all-assets
TenantId: clx7abc123
Attempt: 2 of 3
```

| Variable | Where | Purpose |
|----------|-------|---------|
| `SENTRY_DSN` | API + Backend | Error ingestion endpoint |
| `SENTRY_ORG` | CI | Organization slug (for source maps) |
| `SENTRY_PROJECT` | CI | Project slug |

---

## Migrating an existing database

Moving from a managed Postgres (e.g. Prisma Postgres) to Railway Postgres is a physical `pg_dump` / `pg_restore`, **not** a schema replay -- `prisma migrate` would drop the raw-SQL `embedding vector(768)` columns (see [CLAUDE.md](../../CLAUDE.md)).

1. Provision Railway Postgres from the pgvector image; `CREATE EXTENSION IF NOT EXISTS vector;`.
2. Freeze writes on the old stack (pause the old API + workers).
3. `pg_dump --no-owner --no-privileges --no-acl --exclude-extension=prisma_postgres --no-publications --no-subscriptions --format=custom` from the source (client version >= source server).
4. `pg_restore --no-owner --no-privileges --no-acl` into the Railway DB.
5. Verify row counts table-by-table and run one `<=>` vector query.
6. Point the services at `${{Postgres.DATABASE_URL}}`, redeploy, cut over DNS.
7. Keep the old database read-only for a rollback window.

Reuse `ENCRYPTION_SECRET`, `JWT_SECRET_CURRENT`, and `NEXTAUTH_SECRET` verbatim -- encrypted columns are unreadable with a different key, and changing the JWT secrets forces every user to re-login.

---

## Multi-Tenancy Model

Bliss uses **query-level tenant isolation** -- every database query includes a `tenantId` filter. There is no Row-Level Security (RLS); isolation is enforced at the application layer.

Each tenant gets:
- Isolated accounts, transactions, categories, and portfolio items
- Independent AI classification models (description cache + vector embeddings)
- Separate analytics caches and insights
- Configurable thresholds (auto-promote, review confidence)

Tenant data is fully isolated. A user in Tenant A cannot see or modify data belonging to Tenant B.

Every sign-up creates its own tenant, and the first user in it is its admin. Friends on your server therefore get separate workspaces, not a view of yours.

### Invite-only hosting

If you host Bliss for a known group, you probably don't want sign-up open to the internet. Set `SIGNUP_MODE=invite_only` on the API and only emails you have invited can create an account, with email and password or with Google.

```bash
export ADMIN_API_KEY=...                   # same value as the API server
export BLISS_API_URL=https://api.yoursite.com
node apps/api/scripts/manage-invites.mjs add ana@example.com --note "Ana"
node apps/api/scripts/manage-invites.mjs list --unused
node apps/api/scripts/manage-invites.mjs revoke ana@example.com
```

- Invites are stored in the database, so you can add or revoke them without redeploying, and you can load them before switching the mode on.
- An invite is single-use and matches the email exactly (case and surrounding spaces are ignored, but not dots or `+` tags). Existing users can always sign in.
- Any value other than `open` or `invite_only` is treated as `invite_only`, so a typo locks sign-up instead of opening it.
- Share the sign-up URL and the invited email with each person. For Claude users, also share the connector URL (your API address ending in `/api/mcp`). See [Bring Your Finances into Bliss with Claude](/docs/guides/bring-your-finances-with-claude).
- Reference: [Configuration](/docs/configuration#invite-only-sign-up).

---

### Database connection pools

Every service process opens its own Prisma pool, and Postgres refuses new connections past `max_connections` (Railway Postgres: **100** by default) with `FATAL: sorry, too many clients already`. Prisma's default pool is `num_cpus * 2 + 1`, and inside a container Node sees the **host's** CPUs, so unbounded pools add up fast.

Bliss therefore applies a default when `DATABASE_URL` has no `connection_limit`, and an explicit value always wins:

| Service | Default `connection_limit` | Suggested override |
|---------|---------------------------|--------------------|
| API | 10 | 10–15 |
| Backend `START_MODE=web` | 5 | 5 |
| Backend `START_MODE=worker` / `all` | 10 | 10 |

`pool_timeout` defaults to 20 seconds. On Railway set it per service, e.g. `DATABASE_URL=${{Postgres.DATABASE_URL}}?connection_limit=15&pool_timeout=20` on the API.

**Budget:** `sum(connection_limit × replicas)` across API, backend web and every worker replica must stay below `max_connections`, leaving headroom (~20) for `prisma migrate deploy`, `psql`, `pg_dump` and the provider's own connections. One API + one backend web + one worker at the defaults is 25. Before adding replicas, re-check the sum; past ~80 add PgBouncer (transaction mode, with `pgbouncer=true` in the URL) rather than raising `max_connections`.

## Scaling Considerations

| Concern | Approach |
|---------|----------|
| **More API traffic** | Raise the API service's replica count / resources in Railway. The container holds a persistent Prisma pool, so there's no serverless connection storm -- but each replica adds its `connection_limit` to the [connection budget](#database-connection-pools). |
| **Slow job processing** | Add backend `START_MODE=worker` replicas. BullMQ distributes jobs automatically. |
| **Database growth** | Scale the Railway Postgres plan (storage + compute). Connections are bounded per service by `connection_limit`; keep the total under `max_connections` (see [Database connection pools](#database-connection-pools)) and add PgBouncer if replicas push it past ~80. |
| **Edge latency for the SPA** | Put Cloudflare (or another CDN) in front of the web service. |
| **Redis memory** | BullMQ jobs are transient. Monitor queue depth; increase Redis memory if backlogs grow. |

---

## Next steps

- [Docker Quick Start](/docs/guides/docker-quickstart) -- try Bliss locally before deploying
- [Choosing Your External Services](/docs/guides/external-services) -- configure Gemini, Twelve Data (prices + FX), and Plaid

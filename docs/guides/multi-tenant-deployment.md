# Multi-Tenant Deployment

Bliss supports multi-tenancy out of the box -- every user gets their own isolated tenant with separate accounts, transactions, and settings. This guide covers the recommended production architecture for hosting Bliss as a multi-user service.

---

## Recommended Stack

Bliss ships a Dockerfile per service ([`docker/`](../../docker/)), so the whole platform runs on a single container host. [Railway](https://railway.app) is the reference target: one project, one private network, one bill.

| Component | Provider | Why |
|-----------|----------|-----|
| **Web** | Railway (nginx container) | Serves the built Vite SPA. Front with a CDN (e.g. Cloudflare) if you need edge caching. |
| **API** | Railway (Next.js container) | Auth (NextAuth), REST routes, Prisma. Long-running, so the connection pool is persistent -- no serverless pooler needed. |
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

**Backend** runs as one `START_MODE=all` service for small deployments, or split into `START_MODE=web` (HTTP, needed for Plaid webhooks and the API's pricing calls) + `START_MODE=worker` (BullMQ consumers). BullMQ distributes jobs across all worker instances automatically -- add worker replicas to scale job throughput.

**PostgreSQL** uses Railway's pgvector-capable Postgres image. The API container runs `prisma migrate deploy` + `prisma db seed` on startup ([`docker/Dockerfile.api`](../../docker/Dockerfile.api)), so a fresh database is provisioned automatically on first boot.

### Staging environments

Duplicate the Railway environment to get a `staging` copy with the same service wiring. Volume data is **not** copied -- staging comes up with an empty Postgres, which you seed or load from a `pg_dump` of production. Point production at `main` and staging at a `staging` branch, or promote manually.

---

## Key Configuration

### Environment Variables

Set these per Railway service. Use `${{<service>.VAR}}` reference variables for anything that points at another service so URLs resolve to the private network.

| Variable | Where | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | API + Backend | `${{Postgres.DATABASE_URL}}` -- the **internal** connection string. A direct `postgresql://` URL (not `prisma://`). |
| `REDIS_URL` | Backend | `${{Redis.REDIS_URL}}` |
| `REDIS_SKIP_TLS_CHECK` | Backend | `true` -- Railway's private Redis has no `rediss://` endpoint. |
| `INTERNAL_API_KEY` | API + Backend | Service-to-service auth. Must match across all three. |
| `BACKEND_URL` | API | Internal backend address, e.g. `http://bliss-backend.railway.internal:8080`. Used for both event delivery and pricing calls. |
| `NEXTAUTH_URL` | API | The API's public HTTPS URL, e.g. `https://api.yoursite.com`. |
| `FRONTEND_URL` | API | The web app's public origin, e.g. `https://app.yoursite.com`. Drives CORS -- exact match, no trailing slash. |
| `COOKIE_DOMAIN` | API | `.yoursite.com` when web + API are siblings on one root domain (shared session). Leave unset otherwise -- never set it to a `*.up.railway.app` value (public suffix; browsers reject it). |
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

`PLAID_WEBHOOK_URL` must point at the **backend's** public URL (`https://<backend-domain>/api/plaid/webhook`), so the backend service needs a public domain even though the API talks to it privately. Changing the env var only affects newly linked Items -- call Plaid's `/item/webhook/update` for existing `PlaidItem` rows after a domain change.

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

---

## Scaling Considerations

| Concern | Approach |
|---------|----------|
| **More API traffic** | Raise the API service's replica count / resources in Railway. The container holds a persistent Prisma pool, so there's no serverless connection storm. |
| **Slow job processing** | Add backend `START_MODE=worker` replicas. BullMQ distributes jobs automatically. |
| **Database growth** | Scale the Railway Postgres plan (storage + compute). A long-running API means a bounded connection count -- no external pooler needed. |
| **Edge latency for the SPA** | Put Cloudflare (or another CDN) in front of the web service. |
| **Redis memory** | BullMQ jobs are transient. Monitor queue depth; increase Redis memory if backlogs grow. |

---

## Next steps

- [Docker Quick Start](/docs/guides/docker-quickstart) -- try Bliss locally before deploying
- [Choosing Your External Services](/docs/guides/external-services) -- configure Gemini, Twelve Data (prices + FX), and Plaid

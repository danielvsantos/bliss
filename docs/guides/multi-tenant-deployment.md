# Multi-Tenant Deployment

Bliss supports multi-tenancy out of the box -- every user gets their own isolated tenant with separate accounts, transactions, and settings. This guide covers the recommended production architecture for hosting Bliss as a multi-user service.

---

## Recommended Stack

| Component | Provider | Why |
|-----------|----------|-----|
| **Web + API** | [Vercel](https://vercel.com) | Zero-config Next.js hosting, global CDN, automatic HTTPS, preview deployments |
| **Backend workers** | [Railway](https://railway.app) | Always-on containers for BullMQ workers, easy Redis/Postgres provisioning |
| **PostgreSQL** | [Prisma Postgres](https://www.prisma.io/postgres) with Accelerate | Managed PostgreSQL with connection pooling, caching, and pgvector support |
| **Redis** | Railway (managed) | BullMQ job queues and caching |
| **Error tracking** | [Sentry](https://sentry.io) | Structured error reports with worker context (job name, tenantId, attempt count) |
| **Authentication** | Google OAuth | Frictionless sign-in via NextAuth.js Google provider |

---

## Architecture Overview

```
Users (Browser)
     |
  Vercel CDN
     |
  +--+--+
  |     |
 Web   API  (Vercel — two deployments from same repo)
  |     |
  |     +--- INTERNAL_API_KEY ---> Backend (Railway — Express + BullMQ)
  |                                   |
  +-------- Prisma Postgres ----------+
              (Accelerate)            |
                                   Redis
                                 (Railway)
```

**Web** (React SPA) and **API** (Next.js) deploy to Vercel from the same repository. Vercel handles TLS, CDN, and scaling automatically.

**Backend** deploys to Railway as a single service running in `START_MODE=all` (both HTTP and workers in one process). For higher traffic, split into two Railway services: one with `START_MODE=web` and another with `START_MODE=worker` -- BullMQ distributes jobs across all worker instances automatically.

**PostgreSQL** is hosted on [Prisma Postgres](https://www.prisma.io/postgres) with Accelerate, which provides managed connection pooling, query caching, and built-in pgvector support. Accelerate is particularly valuable when deploying on serverless platforms like Vercel, where each function invocation opens a new database connection -- the connection pooler prevents exhausting PostgreSQL's connection limit. **Redis** is provisioned as a Railway managed service.

---

## Key Configuration

### Environment Variables

Both Vercel and Railway read from environment variables. The critical ones for multi-tenant production:

| Variable | Where | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | API + Backend | Shared PostgreSQL connection string |
| `REDIS_URL` | Backend | BullMQ queue broker |
| `INTERNAL_API_KEY` | API + Backend | Service-to-service auth (must match) |
| `NEXTAUTH_URL` | API | Your production domain (e.g., `https://app.yoursite.com`) |
| `FRONTEND_URL` | API | CORS origin for the web app |
| `BACKEND_URL` | API | Railway backend URL (e.g., `https://bliss-backend.up.railway.app`) |
| `COOKIE_DOMAIN` | API | Cookie scope for auth (e.g., `.yoursite.com`) |

### Google OAuth

NextAuth.js supports Google as an OAuth provider. Configure in your Vercel environment:

| Variable | Value |
|----------|-------|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |

Users can sign up with Google (creates a tenant automatically) or with email/password. Both flows coexist.

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
| **More users** | Vercel auto-scales the web and API layers. No action needed. |
| **Slow job processing** | Add Railway worker replicas (`START_MODE=worker`). BullMQ distributes jobs automatically. |
| **Database growth** | Prisma Postgres scales storage and compute independently. Accelerate handles connection pooling automatically -- no PgBouncer needed. |
| **Redis memory** | BullMQ jobs are transient. Monitor queue depth; increase Redis memory if backlogs grow. |

---

## Next steps

- [Docker Quick Start](/docs/guides/docker-quickstart) -- try Bliss locally before deploying
- [Choosing Your External Services](/docs/guides/external-services) -- configure Gemini, Twelve Data, Plaid, and CurrencyLayer

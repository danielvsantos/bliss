# 12. API Deployment

This document specifies the deployment configuration for the Next.js API layer (`apps/api`).

## 12.1. Overview

The API is a Next.js 15 application using the Pages Router. It serves as the authentication layer (NextAuth), REST API, and Prisma ORM gateway. In production, it runs as a standalone Node.js server inside Docker.

## 12.2. Docker Build (`Dockerfile.api`)

The API uses a 4-stage multi-stage Docker build:

1. **deps**: Installs all workspace dependencies via pnpm with frozen lockfile. All workspace `package.json` stubs are copied to ensure correct peer resolution.
2. **shared-build**: Builds the `@bliss/shared` package (encryption + storage adapters).
3. **builder**: Generates the Prisma client and builds Next.js in standalone output mode (`output: 'standalone'` in `next.config.mjs`).
4. **runner**: Minimal production image with a non-root `nextjs` user (UID 1001).

The standalone build bundles only the files required to run the server, producing a significantly smaller image than a full `node_modules` copy.

## 12.3. Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (e.g. `postgresql://bliss:pass@postgres:5432/bliss`) |
| `JWT_SECRET_CURRENT` | Secret for signing JWT tokens |
| `NEXTAUTH_SECRET` | Secret for NextAuth session encryption |
| `ENCRYPTION_SECRET` | AES-256-GCM key for encrypting sensitive fields |
| `INTERNAL_API_KEY` | Shared key for authenticating calls to the backend service |
| `BACKEND_URL` | Backend service URL (e.g. `http://backend:3001` in Docker) |
| `NEXTAUTH_URL` | Canonical URL for NextAuth callbacks (e.g. `http://localhost:3000`) |
| `FRONTEND_URL` | Frontend origin for CORS headers (e.g. `http://localhost:8080`) |

### Optional

| Variable | Description |
|----------|-------------|
| `JWT_SECRET_PREVIOUS` | Previous JWT secret for key rotation (accepts tokens signed with either) |
| `ENCRYPTION_SECRET_PREVIOUS` | Previous encryption secret for re-encryption migration |
| `COOKIE_DOMAIN` | Domain for auth cookies (omit for localhost, set for production) |
| `STORAGE_BACKEND` | `local` (default) or `gcs` for Google Cloud Storage |
| `LOCAL_STORAGE_DIR` | Path for local file uploads (default: `/app/data/uploads`) |
| `GCS_BUCKET_NAME` | GCS bucket for file uploads (when `STORAGE_BACKEND=gcs`) |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Plaid integration (app degrades gracefully without these) |
| `GEMINI_API_KEY` | Google Gemini for AI classification |
| `SENTRY_DSN` | Sentry error tracking |

## 12.4. Migration on Startup

The Docker CMD runs migrations automatically before starting the server:

```
wait-for-db.sh -> prisma migrate deploy -> prisma/seed.js -> node apps/api/server.js
```

1. **wait-for-db.sh**: TCP socket check against PostgreSQL (30 retries, 2s interval)
2. **prisma migrate deploy**: Applies all pending migrations (safe for concurrent containers -- Prisma uses advisory locks)
3. **prisma/seed.js**: Populates reference data (countries, currencies, default categories). Idempotent -- skips if data exists.
4. **server.js**: Starts the Next.js standalone server on port 3000

## 12.5. Health Check

The API exposes health monitoring through the standard Next.js server. The Docker Compose setup relies on the `depends_on` condition against PostgreSQL health rather than an API-level health endpoint.

## 12.6. Cookie and CORS Configuration

### Cookies

Auth cookies are set as `httpOnly` with `SameSite=Lax`. In production:
- Set `COOKIE_DOMAIN` to the root domain (e.g. `.example.com`) for cross-subdomain auth
- Cookies use `Secure` flag when `NEXTAUTH_URL` uses HTTPS

### CORS

The API allows requests from the origin specified in `FRONTEND_URL`. In Docker Compose, the backend's `ALLOWED_ORIGINS` is set to `http://api:3000` for internal service-to-service calls.

## 12.7. File Upload Storage

The API supports two storage backends via `STORAGE_BACKEND`:

- **`local`** (default): Files stored in `LOCAL_STORAGE_DIR`. In Docker, the `uploads_data` named volume is shared between `api` and `backend` containers.
- **`gcs`**: Files stored in Google Cloud Storage. Required for multi-instance deployments where local disk is not shared.

## 12.8. Production Notes

- The standalone server listens on `0.0.0.0:3000` (configured via `HOSTNAME` env var in Dockerfile)
- For Vercel deployment, the standard Next.js build is used instead of standalone mode
- TLS termination should be handled by a reverse proxy in front of the Docker stack

# 12. Deployment Architecture

This document specifies the deployment infrastructure for the Bliss platform.

## 12.1. Docker Compose (Primary)

The primary deployment method uses Docker Compose to orchestrate a 5-service stack plus an optional database admin UI.

### Services

| Service | Image / Dockerfile | Port (host:container) | Role |
|---------|-------------------|----------------------|------|
| `postgres` | `pgvector/pgvector:pg16` | 5432:5432 | PostgreSQL 16 with pgvector extension |
| `redis` | `redis:7-alpine` | Internal only | BullMQ job queues and caching |
| `api` | `docker/Dockerfile.api` | 3000:3000 | Next.js API layer (auth, REST endpoints, Prisma ORM) |
| `backend` | `docker/Dockerfile.backend` | Internal only | Express + BullMQ workers (classification, portfolio, analytics) |
| `web` | `docker/Dockerfile.web` | 8080:80 | Vite React SPA served by nginx |
| `adminer` | `adminer:latest` | 8888:8080 | Lightweight database GUI (optional) |

### Named Volumes

| Volume | Mount point | Purpose |
|--------|------------|---------|
| `postgres_data` | `/var/lib/postgresql/data` | Persistent database storage |
| `redis_data` | `/data` | Redis AOF/RDB persistence |
| `uploads_data` | `/app/data/uploads` | Shared file upload storage (mounted by both `api` and `backend`) |

### Health Checks

- **postgres**: `pg_isready -U bliss` (10s interval, 5 retries)
- **redis**: `redis-cli -a <password> ping` (10s interval, 5 retries)

### Dependency Chain

- `api` depends on `postgres` (healthy)
- `backend` depends on `postgres` (healthy) and `redis` (healthy)
- `web` depends on `api` (started)
- `adminer` depends on `postgres` (healthy)

### Internal Networking

Services communicate via Docker Compose DNS hostnames:
- API connects to `postgres:5432` (DATABASE_URL) and `backend:3001` (BACKEND_URL)
- Backend connects to `postgres:5432` and `redis:6379`
- Redis is not exposed to the host -- only `backend` accesses it

### Secret Generation (`scripts/setup.sh`)

The setup script generates cryptographically random secrets and creates `.env` from `.env.example`:

- `ENCRYPTION_SECRET` -- 48-char base64 for AES-256-GCM encryption
- `JWT_SECRET_CURRENT` -- 48-char base64 for JWT signing
- `NEXTAUTH_SECRET` -- 48-char base64 for NextAuth session encryption
- `INTERNAL_API_KEY` -- 32-char base64 for service-to-service auth
- `POSTGRES_PASSWORD` -- 24-char base64 for database authentication
- `REDIS_PASSWORD` -- 24-char base64 for Redis authentication

All secrets are generated via `openssl rand -base64` with special characters stripped. The script refuses to overwrite an existing `.env` file.

To rotate any of these secrets after initial setup, see
[`docs/guides/key-rotation.md`](/docs/guides/key-rotation) for the
step-by-step procedure, verification, and rollback paths.

### First Boot

On first startup, the API container automatically:
1. Waits for PostgreSQL to accept connections (`wait-for-db.sh`)
2. Runs `prisma migrate deploy` to apply all migrations
3. Runs `prisma/seed.js` to populate reference data (countries, currencies, default categories)
4. Starts the Next.js standalone server

## 12.2. Dockerfiles

### `Dockerfile.api` -- Next.js API (4 stages)

| Stage | Base | Purpose |
|-------|------|---------|
| `deps` | `node:20-alpine` | pnpm install with frozen lockfile; copies all workspace package.json stubs for peer resolution |
| `shared-build` | deps | Builds `@bliss/shared` package |
| `builder` | shared-build | Generates Prisma client, builds Next.js standalone output |
| `runner` | `node:20-alpine` | Production image with non-root `nextjs` user (UID 1001). Copies standalone output, Prisma schema/migrations, seed script, and `wait-for-db.sh` |

The standalone build includes only the files needed to run the server, significantly reducing the final image size.

### `Dockerfile.backend` -- Express + BullMQ (4 stages)

| Stage | Base | Purpose |
|-------|------|---------|
| `deps` | `node:20-alpine` | pnpm install; sets `PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x` for Alpine compatibility |
| `shared-build` | deps | Builds `@bliss/shared` package |
| `builder` | shared-build | Generates Prisma client for the backend app |
| `runner` | `node:20-alpine` | Production image with non-root `backendjs` user (UID 1001). Copies app code, shared package dist, full node_modules, and Prisma schema |

### `Dockerfile.web` -- Vite + nginx (2 stages)

| Stage | Base | Purpose |
|-------|------|---------|
| `builder` | `node:20-alpine` | pnpm install (ignore-scripts), Vite build with `NEXT_PUBLIC_API_URL` build arg baked into the static bundle |
| `runner` | `nginx:alpine` | Copies built assets to `/usr/share/nginx/html` and custom nginx config |

The `NEXT_PUBLIC_API_URL` build argument controls which API URL is embedded in the frontend bundle. It defaults to `http://localhost:3000` and must be set at build time (not runtime).

## 12.3. Nginx Configuration

The nginx server (`docker/nginx.conf`) provides:

- **Gzip compression**: Enabled for text, CSS, JSON, JavaScript, and XML (min 1024 bytes)
- **Immutable asset caching**: `/assets/` directory served with `Cache-Control: public, immutable` and 1-year expiry. Vite uses content-hashed filenames, so assets are safe to cache indefinitely.
- **SPA fallback**: All routes fall through to `index.html` via `try_files $uri $uri/ /index.html`, enabling client-side routing

## 12.4. Database Readiness (`wait-for-db.sh`)

The wait script uses a Node.js TCP socket check (since Alpine lacks `pg_isready` and `nc` by default):

- Attempts to connect to the PostgreSQL host/port parsed from `DATABASE_URL`
- Retries up to 30 times with 2-second intervals (max 60 seconds)
- Exits with code 0 on success, code 1 on timeout
- Used by the API container before running migrations

## 12.5. Process Separation (`START_MODE`)

The backend service entry point (`src/index.js`) accepts a `START_MODE` environment variable that allows the codebase to boot in distinct roles.

### `START_MODE=web` (The API Instance)
- **Role**: Lightweight HTTP ingestor. Sits idle until the API layer or Plaid hits one of its endpoints.
- **Action**: Validates incoming payloads and pushes jobs onto Redis queues, responding with HTTP 202 or 200.
- **Scaling**: Minimal CPU/RAM. Can scale horizontally (multiple replicas) to handle traffic spikes.

### `START_MODE=worker` (The Worker Instance)
- **Role**: The workhorses of the backend. These instances do not run an HTTP server and are unreachable from the internet.
- **Action**: Connect to Redis and continuously process BullMQ jobs (Plaid sync, portfolio valuation, analytics, AI classification).
- **Scaling**: Requires high CPU and RAM. Increase replicas to scale throughput. BullMQ automatically distributes jobs across all active worker instances.

### Default Mode (`START_MODE=all`)
If `START_MODE` is undefined or set to `all`, the application boots both the Express server and all BullMQ workers in the same process. This is the default for local development and Docker Compose, keeping the setup simple without requiring multiple terminal windows.

### Startup Sequence
1. Validate environment variables (`validateEnv()`)
2. Initialize Redis connection
3. Start workers (if mode is `worker` or `all`)
4. Refresh category cache and start Express server (if mode is `web` or `all`)

### Shutdown Sequence
Workers are closed before Redis is disconnected to ensure in-flight jobs complete gracefully.

### Redis TLS Guard
In production (`NODE_ENV=production`), the backend requires `REDIS_URL` to use the `rediss://` scheme (TLS). This can be bypassed with `REDIS_SKIP_TLS_CHECK=true` for providers whose internal network does not expose a TLS endpoint (e.g. Railway private-network Redis).

## 12.6. PaaS Deployment (Secondary) -- Railway (single project)

Railway is the reference PaaS target -- see
[`docs/guides/multi-tenant-deployment.md`](/docs/guides/multi-tenant-deployment)
for the full walkthrough (environment variables, private networking, staging
environments, and migrating an existing database into it). The `START_MODE`
mechanism described in §12.5 works on any container PaaS; Railway is
documented here because it's what this project actually runs in production.

All five services -- `web`, `api`, `backend`, Postgres, and Redis -- live in
**one Railway project** on its private network, built from the same
Dockerfiles as Docker Compose:

1. **Web**: `docker/Dockerfile.web` (nginx). Public domain.
2. **API**: `docker/Dockerfile.api` -- the same standalone Next.js build used
   in Docker Compose. Public domain.
3. **Backend**: `docker/Dockerfile.backend`, as either one `START_MODE=all`
   service (low volume) or split into `START_MODE=web` (HTTP ingestion, no
   public domain) + `START_MODE=worker` (BullMQ consumers) services for
   higher throughput.
4. **PostgreSQL**: Railway's Postgres plugin (pgvector image). Private
   network only -- a direct `postgresql://` connection, not a pooled/serverless
   one, since the API and backend hold long-running connection pools.
5. **Redis**: Railway's Redis plugin. Private network only -- set
   `REDIS_SKIP_TLS_CHECK=true`, since Railway's private Redis has no
   `rediss://` endpoint (see the Redis TLS Guard note above).

Cross-service variables (`DATABASE_URL`, `REDIS_URL`, `BACKEND_URL`) are set
as `${{service.VAR}}` reference variables rather than copy-pasted connection
strings, so they always resolve to the current internal hostname/credential
without manual duplication across services.

Each service redeploys independently when its own variables or watched paths
change -- there is no atomic "deploy all" across the project. This matters
when rotating a secret read by more than one service; see
[`docs/guides/key-rotation.md`](/docs/guides/key-rotation) §0.2 for the
ordering this implies.

## 12.7. Production Considerations

- **TLS termination**: In production, place a reverse proxy (e.g. Cloudflare, AWS ALB, Caddy) in front of the Docker stack for HTTPS termination. The Docker services themselves communicate over plain HTTP internally.
- **Volume persistence**: Ensure `postgres_data` and `redis_data` volumes are backed by persistent storage (not ephemeral). Loss of `postgres_data` means data loss.
- **Redis TLS**: Use `rediss://` URLs in production or set `REDIS_SKIP_TLS_CHECK=true` for private networks.
- **Cookie domain**: Set `COOKIE_DOMAIN` to the production domain for cross-subdomain auth cookies.
- **CORS**: `FRONTEND_URL` must match the actual frontend origin for proper CORS headers.
- **Upload storage**: For multi-instance deployments, switch `STORAGE_BACKEND` from `local` to `gcs` so all instances share the same file storage.

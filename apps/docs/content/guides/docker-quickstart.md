# Docker Quick Start

Get Bliss running locally in under 5 minutes.

## Prerequisites

- Docker and Docker Compose installed
- No other services on ports 8080, 3000, 3001, or 5432

## Start everything

```bash
git clone https://github.com/your-org/bliss.git && cd bliss
./scripts/setup.sh          # generates secrets, creates .env
docker compose up --build   # starts all 5 services
```

Open [http://localhost:8080](http://localhost:8080) once all containers are healthy. The database is auto-migrated and seeded with reference data (countries, currencies, banks) on first boot.

## Create your account

1. Click **Sign Up** and fill in email, password, and tenant name (this is your workspace).
2. The onboarding wizard asks you to select your countries and currencies.
3. After onboarding, you land on an empty dashboard.

![Onboarding wizard](/images/onboarding.png)

## What's running

| Container | Port | Role |
|-----------|------|------|
| `web` (Nginx) | 8080 | Serves the React SPA |
| `api` (Next.js) | 3000 | Auth, REST API, Prisma ORM |
| `backend` (Express) | 3001 | BullMQ workers, AI pipelines |
| `postgres` | 5432 | PostgreSQL 16 + pgvector |
| `redis` | 6379 | Job queues + cache |

## Data persistence

Your data lives in Docker named volumes (`postgres_data`, `redis_data`, `uploads_data`). It survives `docker compose stop` and `docker compose down`. Only `docker compose down -v` destroys volumes.

## Database GUI

Adminer is included at [http://localhost:8888](http://localhost:8888). Log in with system **PostgreSQL**, server **postgres**, username **bliss**, and the `POSTGRES_PASSWORD` from your `.env`.

## Next steps

- [Seed your financial world](/docs/guides/tenant-seed-setup) — bulk-create accounts, banks, and categories
- [Import transactions](/docs/guides/importing-transactions) — bring in your CSV/XLSX data
- [Connect a bank](/docs/guides/plaid-bank-sync) — automatic sync with Plaid

Ready to contribute? See the full [Getting Started](/docs/getting-started) guide for local development setup.

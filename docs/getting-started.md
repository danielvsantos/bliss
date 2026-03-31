# Getting Started

This guide walks you through setting up Bliss Finance for development or local use.

## Monorepo Structure

```
bliss/
├── apps/
│   ├── api/          # Next.js API (port 3000)
│   ├── backend/      # Express + BullMQ workers (port 3001)
│   └── web/          # React SPA — Vite + shadcn/ui (port 8080)
├── packages/
│   └── shared/       # Shared utilities: encryption, storage adapter
├── prisma/           # Schema, migrations, seed
├── docker/           # Dockerfiles + nginx
├── scripts/          # setup.sh
├── .env.example
└── docker-compose.yml
```

---

## 1. Prerequisites

### For local development

| Dependency | Version | Notes |
|---|---|---|
| Node.js | 20+ | LTS recommended |
| pnpm | 9+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| PostgreSQL | 16+ | Must have the pgvector extension (see below) |
| Redis | 7+ | Used by BullMQ for job queues |

#### Installing pgvector

pgvector adds vector similarity search to PostgreSQL. Install it before creating your database.

**macOS (Homebrew):**

```bash
brew install pgvector
```

**Ubuntu / Debian:**

```bash
sudo apt install postgresql-16-pgvector
```

**From source (any platform):**

```bash
git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install
```

After installation, enable the extension inside your database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### For Docker path

Only Docker and Docker Compose are required. All other dependencies are handled by the containers.

---

## 2. Quick Start with Docker (Recommended)

```bash
git clone https://github.com/your-org/bliss.git && cd bliss
./scripts/setup.sh          # generates secrets, creates .env
docker compose up --build   # starts all services
```

Open [http://localhost:8080](http://localhost:8080). The database is auto-migrated and seeded on first boot.

**Database GUI:** Adminer is included in the Docker Compose stack. Open [http://localhost:8888](http://localhost:8888) to browse your PostgreSQL database. Log in with system **PostgreSQL**, server **postgres**, username **bliss**, and the `POSTGRES_PASSWORD` from your `.env` file.

**Data persistence:** Your data is stored in Docker named volumes (`postgres_data`, `redis_data`, `uploads_data`). It survives `docker compose stop` and `docker compose down`. Only `docker compose down -v` destroys volumes and resets all data.

---

## 3. Local Development (Without Docker)

### Clone and configure

```bash
git clone https://github.com/your-org/bliss.git && cd bliss
cp .env.example .env
```

Edit `.env` and set at minimum:

- `DATABASE_URL` — e.g. `postgresql://user:password@localhost:5432/bliss`
- `REDIS_URL` — e.g. `redis://localhost:6379`

### Generate secrets

```bash
./scripts/setup.sh
```

This populates encryption keys and JWT secrets in your `.env`.

### Install dependencies

```bash
pnpm install
```

### Set up the database

```bash
createdb bliss                                                    # create the database
psql bliss -c 'CREATE EXTENSION IF NOT EXISTS vector;'            # enable pgvector
pnpm exec prisma migrate deploy --schema=prisma/schema.prisma     # run migrations
pnpm exec prisma db seed                                          # seed countries, currencies, banks
```

### Start all services

```bash
pnpm dev
```

This starts three processes concurrently:

| Service | Port |
|---|---|
| Frontend (Vite) | 8080 |
| API (Next.js) | 3000 |
| Backend (Express + BullMQ) | 3001 |

---

## 4. First Run Walkthrough

1. Open [http://localhost:8080](http://localhost:8080).
2. Create an account using the signup form.
3. Select your country and base currency during onboarding.
4. Add accounts manually or connect a bank via Plaid (see next section).

---

## 5. Connecting a Bank (Plaid Sandbox)

1. Sign up for a free Plaid account at [plaid.com/dashboard](https://plaid.com/dashboard).
2. Copy your sandbox credentials and add them to `.env`:

   ```env
   PLAID_CLIENT_ID=your_client_id
   PLAID_SECRET=your_sandbox_secret
   PLAID_ENV=sandbox
   ```

3. Restart all services.
4. In the app, navigate to **Accounts** and click **Connect Bank**.
5. Use the Plaid sandbox test credentials:
   - Username: `user_good`
   - Password: `pass_good`

---

## 6. Importing Transactions via CSV

1. Navigate to **Smart Import** in the sidebar.
2. Upload a CSV file exported from your bank.
3. Bliss auto-detects the file format. If no known adapter matches, you can create a custom adapter by mapping columns.
4. Review the AI-generated classifications for each transaction.
5. Make any corrections, then click **Commit** to save.

---

## 7. Enabling AI Classification

Bliss uses a 3-tier classification waterfall: exact match (cache), vector similarity (pgvector), and LLM (Gemini). To enable the LLM tier:

1. Get a Gemini API key from [ai.google.dev](https://ai.google.dev).
2. Add it to `.env`:

   ```env
   GEMINI_API_KEY=your_api_key
   ```

3. Restart the backend service.
4. The classification waterfall activates automatically when processing new transactions.

---

## 8. Enabling Stock Prices

1. Get an API key from [twelvedata.com](https://twelvedata.com).
2. Add it to `.env`:

   ```env
   TWELVE_DATA_API_KEY=your_api_key
   STOCK_PROVIDER=twelvedata
   ```

3. Restart the backend service. Stock prices will be fetched for investment-type accounts.

---

## 9. Running Tests

```bash
pnpm test              # all 588 tests
pnpm test:api          # 198 API tests (Vitest)
pnpm test:backend      # 301 backend tests (Jest)
pnpm test:web          # 89 frontend tests (Vitest)
```

---

## 10. Troubleshooting

**pgvector extension not found**

Connect to your database and run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

If this fails, pgvector is not installed at the system level. See the installation instructions in the Prerequisites section.

**Port conflicts**

Check your `.env` for port configuration variables. The defaults are 8080 (frontend), 3000 (API), and 3001 (backend). Make sure nothing else is bound to those ports.

**Redis connection refused**

Verify that Redis is running and that `REDIS_URL` in `.env` points to the correct host and port.

**Prisma migration issues**

If migrations are in a broken state during development, you can reset the database:

```bash
pnpm exec prisma migrate reset --schema=prisma/schema.prisma
```

> WARNING: This destroys all data in the database and re-runs all migrations and the seed script.

---

## 11. CLAUDE.md — AI-Assisted Development

The codebase includes `CLAUDE.md` files that serve as structured context for AI coding tools (Claude Code, Copilot, Cursor, etc.) and as onboarding references for new developers. Each file documents the architecture, conventions, and critical rules for its scope:

| File | Scope |
|------|-------|
| [`CLAUDE.md`](../CLAUDE.md) | Project-wide architecture, module systems, design tokens, worker reference |
| [`apps/api/CLAUDE.md`](../apps/api/CLAUDE.md) | API layer — route patterns, auth flow, Prisma client, path aliases, testing |
| [`apps/backend/CLAUDE.md`](../apps/backend/CLAUDE.md) | Backend — CJS conventions, worker structure, services, queue patterns |
| [`apps/web/CLAUDE.md`](../apps/web/CLAUDE.md) | Frontend — component patterns, design tokens, hooks, TanStack Query conventions |

These files are the fastest way to understand how each service works and what rules to follow when making changes.

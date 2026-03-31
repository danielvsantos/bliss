<p align="center">
  <img src="apps/api/assets/logobliss.png" alt="Bliss Finance" width="120" />
</p>

<h1 align="center">Bliss Finance</h1>

<p align="center">
  <strong>The open-source financial control panel for global professionals.</strong><br>
  Multi-currency wealth tracking, AI-powered transaction classification, and portfolio management — unified in one calm, powerful interface.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#develop-with-claude-code">Claude Code</a> &bull;
  <a href="docs/getting-started.md">Docs</a> &bull;
  <a href="docs/architecture.md">Architecture</a> &bull;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" />
  <img src="https://img.shields.io/badge/tests-588%20passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/docker-compose%20ready-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/Claude%20Code-ready-6D657A?logo=anthropic&logoColor=white" alt="Claude Code Ready" />
</p>

---

## Why Bliss?

Most financial tools force you to choose: basic budgeting apps that can't handle investments, or trading platforms drowning in noise. If your financial life crosses borders — multiple currencies, banks in different countries, a mix of stocks, crypto, and everyday expenses — you're left stitching it all together in spreadsheets.

**Bliss eliminates that.** It's a single, self-hostable dashboard that unifies your entire financial picture: bank accounts across countries, investment portfolios, expense tracking, and P&L reporting — all normalized to your chosen currency, all classified by AI, all updated automatically.

---

## Built with Spec-Driven Development

Bliss was built using a strict Spec-Driven Development framework. Every feature, from the Plaid sync engine to the AI classification waterfall, was documented in detailed technical specifications before a single line of code was written. This approach ensures a decoupled architecture, predictable state management, and a codebase that is easy to reason about and extend.

---

## Features

### AI-Powered Transaction Classification

Bliss uses a three-tier classification waterfall that learns from your behavior and gets smarter over time:

| Tier | Method | Speed | How it works |
|------|--------|-------|-------------|
| **1. Exact Match** | In-memory cache | < 1ms | O(1) lookup against your transaction history. Instantly recognizes recurring merchants. |
| **2. Vector Similarity** | pgvector cosine search | ~10ms | Semantic matching using Gemini embeddings (768-dim). Catches variations like "AMZN" vs "Amazon.com". |
| **3. LLM Fallback** | Gemini Flash | ~500ms | Full AI classification with reasoning for truly novel transactions. |

Every time you correct a classification, the system learns immediately — your override updates the cache and generates a new embedding, so the same merchant is auto-classified next time. Configurable confidence thresholds let you control the balance between automation and manual review.

### Multi-Currency, Multi-Country Wealth View

- **Track accounts across countries** — USD checking in New York, EUR savings in Barcelona, BRL investments in Sao Paulo
- **Unified P&L in your currency** — See your true global net worth converted to a single display currency with historical exchange rates
- **Per-account country and currency tagging** — Every account knows its jurisdiction for accurate reporting
- **Automatic rate fetching** — Daily exchange rates via market data providers

### Portfolio & Investment Tracking

- **Stocks, ETFs, crypto, mutual funds** — Real-time pricing via TwelveData (10,000+ symbols)
- **Average cost basis calculation** — Automatic lot tracking from your transaction history
- **Realized & unrealized P&L** — Per-holding and aggregate, in both native and display currencies
- **Sector and geography analysis** — Break down your equity portfolio by industry, sector, or country
- **Debt tracking** — Model amortizing loans with interest rates, terms, and paydown schedules
- **Manual asset support** — Track illiquid assets (real estate, private equity) with user-provided valuations

### Bank Integration via Plaid

- **One-click bank linking** — Connect checking, savings, credit cards, and investment accounts
- **Automatic transaction sync** — Cursor-based incremental sync keeps your data current
- **Historical fetch** — Pull up to 2 years of transaction history on first connect
- **Multi-institution support** — Link accounts from thousands of financial institutions
- **Connection health monitoring** — Sync logs, re-auth handling, token rotation

### Smart CSV/XLSX Import

Not on Plaid? No problem. Bliss has a sophisticated import pipeline for any bank's export format:

1. **Adapter auto-detection** — Upload your CSV and Bliss identifies the format by matching column headers
2. **Custom adapter builder** — Define column mappings for any bank's export format
3. **AI classification** — Every imported row goes through the same 3-tier classification engine
4. **Investment enrichment** — Automatically detects stock/crypto transactions and fetches current prices
5. **Duplicate detection** — SHA-256 hash-based dedup with a 90-day sliding window
6. **Staged review** — Preview all classifications before committing to your ledger

### Reporting & Analytics

- **Monthly P&L statements** — Income vs. expenses broken down by category type
- **Category analytics** — See where your money goes with type/group breakdowns
- **Tag-based budgeting** — Create tags like "Japan Trip" or "Home Renovation" with optional budgets and date ranges
- **Portfolio equity analysis** — Holdings grouped by sector, industry, or country with weighted metrics
- **CSV/XLSX export** — Export filtered transaction data for tax prep or external analysis

### AI-Generated Insights

Bliss analyzes your financial patterns and generates actionable insights:
- Spending velocity changes and category concentration warnings
- Income stability analysis
- Configurable severity levels (info, warning, positive, critical)
- Dismissible cards — acknowledge and move on

---

## Architecture

```
                    Browser (React SPA)
                         |
                    :8080 (nginx)
                         |
         +---------------+---------------+
         |                               |
    Next.js API (:3000)          Express Backend (:3001)
    - Auth (JWT + cookies)       - BullMQ workers (10)
    - REST endpoints             - AI classification
    - Prisma ORM                 - Portfolio valuation
    - File upload                - Plaid sync
         |                               |
         +----------- PostgreSQL ---------+
                     (pgvector)
                         |
                       Redis
                   (queues + cache)
```

**Three services, one database, one queue.** The API layer handles auth and CRUD. The backend service runs 10 async workers for heavy computation — AI classification, portfolio revaluation, Plaid sync, analytics caching, and more. Both share the same Prisma schema and PostgreSQL instance.

See [docs/architecture.md](docs/architecture.md) for the full deep dive.

---

## Security & Privacy

All sensitive API keys and Plaid access tokens are encrypted at rest using AES-256-GCM. Because Bliss is self-hosted, your transaction data never leaves your infrastructure.

---

## Quick Start

### With Docker (recommended)

Three commands to a running instance:

```bash
git clone https://github.com/your-org/bliss.git && cd bliss
./scripts/setup.sh        # generates secrets, creates .env
docker compose up --build  # starts all services
```

Open **http://localhost:8080** and create your account. The database is automatically migrated and seeded with reference data (countries, currencies, banks).

### Without Docker (local development)

Prerequisites: Node.js 20+, pnpm 9+, PostgreSQL 16 with pgvector, Redis 7+

```bash
git clone https://github.com/your-org/bliss.git && cd bliss
cp .env.example .env       # edit DATABASE_URL and REDIS_URL for your local setup
./scripts/setup.sh          # generates secrets (skip if you already have .env)
pnpm install                # installs all workspace dependencies
pnpm exec prisma migrate deploy --schema=prisma/schema.prisma
pnpm exec prisma db seed    # seeds countries, currencies, banks
pnpm dev                    # starts all three services in parallel
```

- Frontend: http://localhost:8080
- API: http://localhost:3000
- Backend: http://localhost:3001

See [docs/getting-started.md](docs/getting-started.md) for detailed setup instructions.

### Develop with Claude Code

Bliss ships with carefully crafted [`CLAUDE.md`](CLAUDE.md) files that give AI assistants full context on the architecture, conventions, and subsystems. If you use [Claude Code](https://claude.ai/code), just open the repo and start working -- it already knows the codebase.

```bash
cd bliss
claude   # Claude Code automatically loads the project context
```

The project includes four `CLAUDE.md` files that layer context by scope:

| File | Scope |
|------|-------|
| [`CLAUDE.md`](CLAUDE.md) | System architecture, critical rules (module systems, design tokens), all subsystems |
| [`apps/api/CLAUDE.md`](apps/api/CLAUDE.md) | Route handler patterns, auth flow, Prisma extensions, event dispatch |
| [`apps/backend/CLAUDE.md`](apps/backend/CLAUDE.md) | Worker patterns, event routing, services, classification config |
| [`apps/web/CLAUDE.md`](apps/web/CLAUDE.md) | Design tokens, component conventions, hooks reference, chart colors |

Claude Code loads the root file everywhere, plus the app-specific file when you're working in that directory. This means it knows to use `require()` in the backend, `import` in the API, and never to use `green-500` in the frontend -- without you having to explain it.

---

## Service Overview

| Service | Tech | Port | Role |
|---------|------|------|------|
| **web** | React + Vite + shadcn/ui | 8080 | SPA frontend served by nginx (Docker) or Vite dev server |
| **api** | Next.js | 3000 | Auth, REST API, Prisma ORM, file uploads |
| **backend** | Express + BullMQ | 3001 | 10 async workers: AI classification, portfolio valuation, Plaid sync, analytics |
| **postgres** | PostgreSQL 16 + pgvector | 5432 | Primary datastore with vector similarity search |
| **redis** | Redis 7 | 6379 | Job queues (BullMQ) and caching |

---

## Optional Integrations

Bliss works out of the box with just a database. Enable additional features by adding API keys:

| Feature | Provider | Env Var | What it unlocks |
|---------|----------|---------|----------------|
| Bank sync | [Plaid](https://plaid.com) | `PLAID_CLIENT_ID` | One-click bank account linking and automatic transaction sync |
| AI classification | [Google Gemini](https://ai.google.dev) | `GEMINI_API_KEY` | 3-tier classification waterfall (vector search + LLM fallback) |
| Stock prices | [Twelve Data](https://twelvedata.com) | `TWELVE_DATA_API_KEY` | Real-time and historical pricing for 10,000+ symbols |
| Error tracking | [Sentry](https://sentry.io) | `SENTRY_DSN` | Production error monitoring and performance tracing |

Without these keys, Bliss still provides full manual transaction management, CSV import (with rule-based classification), multi-currency tracking, and portfolio management with manual valuations.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite, TanStack Query, Recharts, shadcn/ui, Tailwind CSS, Framer Motion |
| API | Next.js, NextAuth.js, Prisma ORM |
| Backend | Express, BullMQ, Google Generative AI SDK |
| Database | PostgreSQL 16 with pgvector extension |
| Queue | Redis 7 via BullMQ |
| Storage | Local filesystem (default) or Google Cloud Storage |
| AI/ML | Gemini Flash (classification), Gemini Embedding-001 (768-dim vectors) |
| Market Data | Twelve Data, Alpha Vantage (legacy) |
| Banking | Plaid |
| Observability | Sentry, OpenTelemetry |
| Testing | Jest (backend), Vitest (API + frontend), MSW, Playwright (E2E stubs) |
| CI/CD | GitHub Actions (5 jobs), Docker Compose |

---

## Project Structure

```
bliss/
├── apps/
│   ├── api/          # Next.js API layer (auth, REST, Prisma)
│   ├── backend/      # Express + BullMQ workers (AI, portfolio, sync)
│   └── web/          # React SPA (Vite + shadcn/ui)
├── packages/
│   └── shared/       # Shared modules (encryption, storage adapter)
├── prisma/           # Schema, migrations, seed script
├── docker/           # Dockerfiles + nginx config
├── scripts/          # setup.sh and utility scripts
├── docs/             # Architecture, configuration, specs
├── .env.example      # All env vars with descriptions
└── docker-compose.yml
```

---

## Testing

```bash
pnpm test              # run all 588 tests across all apps
pnpm test:api          # 198 tests (Vitest) — API routes + utils
pnpm test:backend      # 301 tests (Jest) — workers, services, routes
pnpm test:web          # 89 tests (Vitest + MSW) — components, hooks, pages
```

---

## Configuration

All environment variables are documented in [`.env.example`](.env.example) and explained in detail in [docs/configuration.md](docs/configuration.md).

The single root `.env` file is the source of truth for local development. Docker Compose reads from it automatically. For production, each deployment platform (Vercel, Cloud Run) manages its own environment variables.

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup and module system rules
- Design system tokens and component patterns
- Test requirements per app
- PR process

---

## License

[AGPL-3.0](LICENSE) — free to use, modify, and self-host. If you distribute a modified version as a service, you must open-source your changes.

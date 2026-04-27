<p align="center">
  <img src="apps/api/assets/logoblissgh.png" alt="Bliss" width="400" />
</p>
<p align="center">
  <strong>Self-Hosted Personal Finance for Global Citizens.</strong><br>
  AI-powered transaction classification, real-time portfolio tracking, and event-driven analytics.<br>
  Secured by AES-256 encryption. Open-source and designed for global wealth.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="https://blissfinance.co/docs">Documentation</a> &bull;
  <a href="https://app.blissfinance.co/auth?origin=docs-site">Live Demo</a> &bull;
  <a href="https://blissfinance.co/docs/architecture">Architecture</a> &bull;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" />
  <img src="https://img.shields.io/badge/tests-1428%20passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/docker-compose%20ready-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/Claude%20Code-ready-6D657A?logo=anthropic&logoColor=white" alt="Claude Code Ready" />
</p>

<p align="center">
  <img src="https://blissfinance.co/images/dashboard.png" alt="Bliss — Dashboard with net worth, synced accounts, expense breakdown, and quick actions" width="49%" />
  <img src="https://blissfinance.co/images/portfolio.png" alt="Bliss — Portfolio Holdings with stacked area chart, multi-asset breakdown, and real-time pricing" width="49%" />
</p>

---

## Why Bliss?

Most financial tools force you to trade privacy for convenience. If your financial footprint spans multiple countries, currencies, and asset classes, you're usually handing your most sensitive data to a third-party SaaS — or stitching it together in spreadsheets.

**Bliss is the open-source alternative.** A single, self-hostable dashboard that unifies bank accounts, investment portfolios, expense tracking, and financial summary reporting across borders. Everything runs on your infrastructure, classified by AI, normalized to your chosen currency, and encrypted at rest.

> Built with [Spec-Driven Development](https://blissfinance.co/docs/specifications) — every feature was documented in detailed technical specs before a line of code was written.

---

## Features

### The Intelligence Pipeline

#### 4-Tier Classification Engine

A deterministic AI waterfall that learns from your behavior and gets smarter over time:

| Tier | Method | Speed | How it works |
|------|--------|-------|-------------|
| **1. Exact Match** | In-memory cache | < 1ms | O(1) lookup against your transaction history. Instantly recognizes recurring merchants. |
| **2. Vector Match (tenant)** | pgvector cosine search | ~10ms | Semantic matching using 768-dim embeddings (Gemini or OpenAI). Catches variations like "AMZN" vs "Amazon.com". |
| **3. Vector Match (global)** | Cross-tenant pgvector | ~10ms | Falls back to global embeddings, discounted by 0.92x, for new tenants with sparse data. |
| **4. LLM Fallback** | Configured LLM provider (Gemini, OpenAI, or Anthropic) | ~500ms | Full AI classification with reasoning for truly novel transactions. Confidence is hard-capped at 0.90, with the top band reserved for cases where merchant + Plaid hint + amount all agree. The model can decline genuinely opaque transactions instead of guessing. |

Every correction feeds the loop immediately — your override updates the in-memory cache and generates a new vector embedding, so the same merchant is auto-classified next time.

#### Smart CSV/XLSX Import

Adapter-driven ingestion with 30+ preconfigured bank formats (Chase, Bank of America, Citi, Capital One, Amex, HSBC, Barclays, Revolut, N26, BBVA, CaixaBank, Nubank, and more):

1. **Adapter auto-detection** — Upload a CSV and Bliss identifies the format by matching column headers against 30+ known bank formats
2. **Custom adapter builder** — Define column mappings for any bank format not yet supported
3. **AI classification** — Every imported row goes through the same 4-tier classification engine
4. **Investment enrichment** — Automatically detects stock/crypto transactions and fetches current prices
5. **SHA-256 deduplication** — Hash-based dedup scoped to the batch's date range prevents double-counting
6. **Staged review** — Preview all classifications before committing to your ledger

#### AI-Generated Insights

Fifteen financial lenses organized into six categories (Spending, Income, Savings, Portfolio, Debt, Net Worth) analyze your patterns across four cadence tiers:

- **Monthly Review** — Month-over-month and year-over-year health check, triggered on the 2nd of every month
- **Quarterly Deep Dive** — Seasonal trend analysis, triggered three days after each quarter closes
- **Annual Report** — Comprehensive year-in-review, triggered on January 3rd
- **Portfolio Intelligence** — Equity-specific analysis (sector concentration, valuation risk, dividend opportunities) using `SecurityMaster` fundamentals, triggered every Monday

Each tier is calendar-gated and runs a strict data-completeness check before generation, so partial periods never get compared to full ones. A deterministic pre-pass computes all financial deltas, baselines, and anomalies locally — the LLM writes prose about verified math rather than attempting to calculate numbers itself. Insights persist across runs, and you can manually refresh any tier for any period from the UI.

### The Global Ledger

#### Multi-Currency, Multi-Country Financial Summary

Your personal income statement, across borders and currencies. Bliss organizes finances into a structured financial summary — Income flows through Essentials, Lifestyle, and Growth spending to produce Discretionary Income, Savings Capacity, and Net Savings.

- **115+ pre-built categories across 9 types** — A ready-made chart of accounts so classification works from day one
- **Automatic currency normalization** — Every transaction converted to your display currency using historical FX rates from the transaction date
- **Drill down by year, quarter, or month** — Group-level breakdowns, period comparisons, and trend spotting
- **Filter by country** — See your full global financial summary or isolate a single country's activity

#### Real-Time Portfolio Tracking

- **Stocks, ETFs, crypto, mutual funds** — Real-time pricing via TwelveData (10,000+ symbols)
- **FIFO lot tracking** — Automatic cost-basis calculation with historical FX rates per buy lot
- **Realized & unrealized P&L** — Per-holding and aggregate, in both native and display currencies
- **Sector and geography analysis** — Break down your equity portfolio by industry, sector, or country
- **Fundamentals trust gate** — Stock metrics (P/E, EPS, yield) are validated during nightly refreshes. When exchange data is inconsistent or stale, Bliss hides the affected metrics from the equity page and insight prompts rather than surfacing bad numbers
- **Debt tracking** — Model amortizing loans with interest rates, terms, and paydown schedules
- **Manual asset support** — Track illiquid assets (real estate, private equity) with user-provided valuations

#### Secure Bank Sync via Plaid

- **One-click bank linking** — Connect checking, savings, credit cards, and investment accounts
- **Cursor-based incremental sync** — Automatic transaction fetching with up to 2 years of history on first connect
- **Multi-institution support** — Thousands of financial institutions across countries
- **Connection health monitoring** — Sync logs, re-auth handling, automated token rotation
- **Encrypted at rest** — Plaid access tokens and raw payloads stored with AES-256-GCM

### Self-Hosted Infrastructure

#### Multi-Tenant, Multi-User

Host completely isolated financial environments for family, friends, or a partner from a single deployment. Every database query includes `tenantId` — strict query-level isolation with no data leakage between users. View-only access lets you share visibility without giving control.

#### AES-256-GCM Encryption at Rest

Self-hosted doesn't mean risk-free. Transaction descriptions, account numbers, and Plaid access tokens are encrypted before they reach the database. Classification lookup tables use SHA-256 hashes instead of plaintext for performance indexes. No telemetry, no cloud sync, no third-party analytics — every byte stays on your hardware.

#### Event-Driven Analytics

Every transaction triggers a scoped analytics update. Monthly aggregations across categories, tags, currencies, and countries are computed incrementally — never a full table scan. Tag-based budgeting lets you create tags like "Japan Trip" or "Home Renovation" with optional budgets and date ranges. Export filtered data as CSV/XLSX for tax prep or external analysis.

---

## Production-Grade Architecture

Three services. Ten asynchronous workers. Sixty endpoints. One configuration file.

```text
[ ENTRYPOINT: Nginx :8080 (Docker) ]
│
├──► /     [ FRONTEND SPA ]
│           ├── React 18, Vite 6, shadcn/ui
│           └── Communicates via REST (JWT in HttpOnly Cookie)
│
├──► /api/ [ API LAYER ]
│           ├── Next.js 15 (Pages Router), NextAuth
│           ├── >60 Endpoints (Transactions, Reports, Users)
│           └── Communicates via Internal REST (API Key Auth)
│
└──► /svc/ [ EXPRESS BACKEND :3001 ]
            ├── Event-Driven Architecture
            ├── 10 Asynchronous BullMQ Workers
            │
            ├─► Redis 7 (Cache + Job Queues)
            │
            ├─► Database: PostgreSQL 16 + pgvector
            │   ├── Secure Store: AES-256-GCM Encryption
            │   └── AI Embeddings: 768-dim Vectors
            │
            └─► 3rd Party Integrations:
                ├─► AI: LLM provider abstraction (Gemini / OpenAI / Anthropic)
                ├─► Banks: Plaid (Sync + Tokens)
                ├─► Prices: TwelveData (Real-time Stocks)
                ├─► FX: CurrencyLayer (Historical Rates)
                └─► Ops: Sentry (Observability)
```

See the full [Architecture Documentation](https://blissfinance.co/docs/architecture) for the deep dive.

---

## Quick Start

### With Docker (recommended)

Three commands to a running instance:

```bash
git clone https://github.com/danielvsantos/bliss.git && cd bliss
./scripts/setup.sh        # prompts for LLM provider, generates secrets, creates .env
docker compose up          # pulls images and starts all services
```

During `setup.sh` you're asked to pick an LLM provider (Gemini / OpenAI / Anthropic) and paste its API key. An LLM is required for AI classification and financial insights. See [Choosing an LLM Provider](https://blissfinance.co/docs/guides/external-services) for the full comparison.

Open **http://localhost:8080** and create your account. The database is automatically migrated and seeded with reference data (countries, currencies, banks).

### Without Docker (local development)

Prerequisites: Node.js 20+, pnpm 9+, PostgreSQL 16 with pgvector, Redis 7+

```bash
git clone https://github.com/danielvsantos/bliss.git && cd bliss
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

See the [Guides](https://blissfinance.co/docs/guides) for detailed setup instructions.

### Develop with Claude Code

Bliss ships with carefully crafted [`CLAUDE.md`](CLAUDE.md) files that give AI assistants full context on the architecture, conventions, and subsystems. Combined with 43 technical specification files and 19 OpenAPI YAML definitions, the repo is designed for AI coding agents to onboard instantly. If you use [Claude Code](https://claude.ai/code), just open the repo and start working -- it already knows the codebase.

```bash
cd bliss
claude   # Claude Code automatically loads the project context
```

The project includes five `CLAUDE.md` files that layer context by scope:

| File | Scope |
|------|-------|
| [`CLAUDE.md`](CLAUDE.md) | System architecture, critical rules (module systems, design tokens), all subsystems |
| [`apps/api/CLAUDE.md`](apps/api/CLAUDE.md) | Route handler patterns, auth flow, Prisma extensions, event dispatch |
| [`apps/backend/CLAUDE.md`](apps/backend/CLAUDE.md) | Worker patterns, event routing, services, classification config |
| [`apps/web/CLAUDE.md`](apps/web/CLAUDE.md) | Design tokens, component conventions, hooks reference, chart colors |
| [`apps/docs/CLAUDE.md`](apps/docs/CLAUDE.md) | Sync script rules, content architecture, Nextra patterns |

Claude Code loads the root file everywhere, plus the app-specific file when you're working in that directory. This means it knows to use `require()` in the backend, `import` in the API, and never to use `green-500` in the frontend -- without you having to explain it.

---

## Integrations

### Required: LLM provider

AI classification and financial insights are powered by an LLM. Pick one — Gemini, OpenAI, or Anthropic — at setup time.

| Provider | Role | Env Vars |
|---|---|---|
| [Google Gemini](https://ai.google.dev) | Default. Native embedding support. | `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` |
| [OpenAI](https://platform.openai.com) | Native embedding support. | `LLM_PROVIDER=openai`, `OPENAI_API_KEY` |
| [Anthropic Claude](https://console.anthropic.com) | Best prose quality for insights. Requires a secondary provider (Gemini or OpenAI) for embeddings. | `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `EMBEDDING_PROVIDER`, matching embedding-provider key |

Without an LLM configured, Tier 1 (exact match) still works for already-categorized merchants, but new merchants stay unclassified and the insights page is empty. See the [LLM provider guide](https://blissfinance.co/docs/guides/external-services) for details.

### Optional integrations

Enable additional features by adding API keys. All degrade gracefully if missing.

| Feature | Provider | Env Var | What it unlocks |
|---------|----------|---------|----------------|
| Bank sync | [Plaid](https://plaid.com) | `PLAID_CLIENT_ID` | One-click bank account linking and automatic transaction sync |
| Stock prices | [Twelve Data](https://twelvedata.com) | `TWELVE_DATA_API_KEY` | Real-time and historical pricing for 10,000+ symbols |
| Currency rates | [CurrencyLayer](https://currencylayer.com) | `CURRENCYLAYER_API_KEY` | Live and historical FX rates for multi-currency conversion |
| Error tracking | [Sentry](https://sentry.io) | `SENTRY_DSN` | Production error monitoring and performance tracing |

Without the optional keys, Bliss still provides full manual transaction management, CSV import, and portfolio management with manual valuations.

---

## Project Structure

```
bliss/
├── apps/
│   ├── api/          # Next.js API layer (auth, REST, Prisma)
│   ├── backend/      # Express + BullMQ workers (AI, portfolio, sync)
│   ├── web/          # React SPA (Vite + shadcn/ui)
│   └── docs/         # Documentation site (Next.js + Nextra)
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
pnpm test              # run all 1,428 tests across all apps
pnpm test:api          # 428 tests (Vitest) — unit + integration
pnpm test:backend      # 758 tests (Jest) — unit + integration
pnpm test:web          # 242 tests (Vitest + MSW) — hooks, pages, components, contexts
```

---

## Configuration

All environment variables are documented in [`.env.example`](.env.example) and explained in detail in the [Configuration Reference](https://blissfinance.co/docs/configuration).

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

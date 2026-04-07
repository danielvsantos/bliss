# Contributing to Bliss

Thank you for your interest in contributing to Bliss! This guide covers how we build, how the project is documented, and how to make your first contribution.

## How We Build: Spec-Driven Development

Bliss follows a **spec-driven development** workflow. Every feature has a technical specification in `docs/specs/` organized by layer:

```
docs/specs/
  api/          # REST endpoints, request/response shapes, auth rules
  backend/      # Workers, pipelines, services, queue config
  frontend/     # Pages, hooks, components, design patterns
```

Each spec is numbered by topic (e.g., `05-analytics-api.md`, `06-portfolio-processing.md`). The same topic number links related specs across layers -- so Topic 08 covers Plaid integration in the API, backend worker, and frontend UI.

**Before implementing a feature**, read the relevant spec. It documents data models, business rules, validation logic, and edge cases that aren't obvious from the code alone.

**When modifying behavior**, update the spec to match. Specs describe *current reality*, not aspirational design. If the code changes, the spec should too -- in the same PR.

**To add a new feature**, create spec files for each affected layer using the next available topic number.

## AI-Assisted Development with CLAUDE.md

Each app has a `CLAUDE.md` file that encodes critical rules for AI coding assistants:

| File | Scope |
|------|-------|
| `/CLAUDE.md` | Monorepo architecture, worker reference, environment variables |
| `apps/api/CLAUDE.md` | Route patterns, auth middleware, rate limiting, Prisma client |
| `apps/backend/CLAUDE.md` | Worker table, event routing, classification config, CJS rules |
| `apps/web/CLAUDE.md` | Design tokens, hook inventory, component patterns |
| `apps/docs/CLAUDE.md` | Sync script rules, content architecture, Nextra patterns |

These files prevent the most common mistakes: using the wrong module system, hardcoding Tailwind colors instead of design tokens, missing `tenantId` in queries, or editing auto-synced docs files.

**Review the relevant CLAUDE.md before contributing.** If your change introduces new patterns or conventions, update the CLAUDE.md in the same PR. This is a transferable practice that works with Claude Code, Cursor, Copilot, and other AI-assisted tools.

## Documentation Structure

| Location | What lives here | Who edits it |
|----------|----------------|--------------|
| `docs/specs/{api,backend,frontend}/` | Technical specifications (source of truth) | Anyone modifying features |
| `CLAUDE.md` files (root + each app) | AI assistant context | Anyone introducing new patterns |
| `docs/{architecture,configuration}.md` | Foundation docs (synced to docs site) | Core maintainers |
| `docs/guides/` | How-to guides (synced to docs site) | Anyone adding user-facing docs |
| `CONTRIBUTING.md` | This file | Core maintainers |

**Important:** All content inside `apps/docs/content/` (except `_meta.ts` files and `index.mdx`) is **auto-synced** from `docs/` root by `apps/docs/scripts/sync-docs.mjs`. Never edit the copies -- edit the source in `docs/` instead.

## Development Setup

The fastest way to get started is Docker:

```bash
git clone https://github.com/danielvsantos/bliss.git
cd bliss
./scripts/setup.sh
docker compose up --build
```

Open http://localhost:8080 when all containers are healthy. See the [Docker Quick Start](https://blissfinance.co/docs/guides/docker-quickstart) guide for details.

### Local Development (without Docker)

If you prefer running services directly:

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   ./scripts/setup.sh
   ```

3. Ensure you have running:
   - **PostgreSQL 16** with the **pgvector** extension
   - **Redis 7**

4. Start all services:
   ```bash
   pnpm dev
   ```

## Module System Rules

This is critical -- each app uses a specific module system and they must not be mixed.

| App | Module System | Syntax |
|-----|--------------|--------|
| `apps/api` | ESM | `import` / `export` |
| `apps/backend` | CJS | `require()` / `module.exports` |
| `apps/web` | ESM | `import` / `export` (React + Vite) |
| `apps/docs` | ESM | `import` / `export` (Next.js + Nextra) |
| `packages/shared` | Dual (ESM + CJS) | Built via tsup |

**NEVER mix module systems within an app.** If you are editing a file in `apps/backend`, use `require()`. If you are editing a file in `apps/api` or `apps/web`, use `import/export`.

## Project Structure

```
bliss/
  apps/
    api/          # Next.js API routes + Prisma ORM (ESM)
    backend/      # Express + BullMQ workers (CJS)
    web/          # React + Vite SPA (ESM)
    docs/         # Documentation site -- Next.js + Nextra (ESM)
  packages/
    shared/       # Encryption + storage adapters (dual ESM + CJS via tsup)
  prisma/         # Prisma schema and migrations (shared by api and backend)
  docs/           # Specs, architecture, configuration
  docker/         # Dockerfiles + nginx config
  scripts/        # setup.sh and utilities
```

## Design System (Frontend)

When working on `apps/web`, you must follow the design system strictly:

- **All colors MUST use design tokens** defined in `apps/web/src/index.css`. Never use raw Tailwind color classes like `green-500`, `amber-100`, etc.
- Semantic token mapping:
  - `positive` -- green (#2E8B57)
  - `negative` -- rose (#E5989B)
  - `warning` -- amber (#E09F12)
  - `destructive` -- for error/delete actions
  - `brand-primary` -- (#6D657A)
  - `brand-deep` -- (#3A3542)
- Badge pattern: `bg-positive/10 text-positive border-positive/20` (use `/10` opacity for light backgrounds)
- Components are built with **shadcn/ui**

## Testing Requirements

Run tests with the following commands:

| Scope | Command | Framework |
|-------|---------|-----------|
| Backend | `pnpm test:backend` | Jest (CJS) |
| API | `pnpm test:api` | Vitest (ESM) |
| Frontend | `pnpm test:web` | Vitest + MSW |
| All | `pnpm test` | -- |

Guidelines:

- New features should include tests.
- Integration tests use isolated tenants via the `createIsolatedTenant` / `teardownTenant` pattern (see test helpers in each app).
- Backend tests live in `apps/backend/src/__tests__/`.
- API tests live in `apps/api/__tests__/`.
- Follow the existing test patterns in each app (mocked handler pattern for API unit tests, real-DB for integration tests).

## Database Changes

The Prisma schema is shared across apps and lives at `prisma/schema.prisma`.

To create a new migration:

```bash
pnpm exec prisma migrate dev --schema=prisma/schema.prisma --name your_migration_name
```

Both `apps/api` and `apps/backend` reference the schema via `--schema=../../prisma/schema.prisma` in their respective configurations.

Always create a migration when modifying the schema -- do not apply changes without one.

## Code Style

- TypeScript and JavaScript are both used. Follow the conventions of the file you are editing (semicolons, quotes, etc.).
- Use **Prisma** for all database access. Avoid raw SQL unless absolutely necessary.
- Use **BullMQ** for async work. Never perform heavy computation directly in API route handlers.
- Internal service-to-service communication uses HTTP endpoints protected by `INTERNAL_API_KEY`.

## Pull Request Process

1. Fork the repository and create a feature branch from `main`.
2. Read the relevant spec files and CLAUDE.md before making changes.
3. Make your changes, following the module system rules and code style of the existing codebase.
4. Update specs and/or CLAUDE.md if your change modifies behavior or introduces new patterns.
5. Ensure all tests pass:
   ```bash
   pnpm test
   ```
6. Write clear, descriptive commit messages.
7. Open a pull request against the `main` branch with a description of your changes.

## Getting Help

- Read the relevant `docs/specs/` files for detailed feature documentation
- Check the CLAUDE.md files for quick-reference rules and patterns
- Browse `apps/docs/content/guides/` for user-facing how-to guides
- Open an issue for bugs or feature discussions

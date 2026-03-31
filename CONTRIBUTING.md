# Contributing to Bliss Finance

Thank you for your interest in contributing to Bliss Finance! This guide will help you get started.

## Development Setup

1. Clone the repository and install dependencies:
   ```bash
   git clone <repo-url>
   cd bliss-finance-monorepo
   pnpm install
   ```

2. Copy the environment template and configure secrets:
   ```bash
   cp .env.example .env
   ./scripts/setup.sh
   ```

3. Ensure you have the following services running:
   - **PostgreSQL 16** with the **pgvector** extension
   - **Redis 7**

4. Start all services in development mode:
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
| `packages/shared` | Dual (ESM + CJS) | Built via tsup |

**NEVER mix module systems within an app.** If you are editing a file in `apps/backend`, use `require()`. If you are editing a file in `apps/api` or `apps/web`, use `import/export`.

## Project Structure

```
bliss-finance-monorepo/
  apps/
    api/          # Next.js API routes + Prisma ORM + frontend pages (ESM)
    backend/      # Express + BullMQ workers (CJS)
    web/          # React + Vite frontend (ESM)
  packages/
    shared/       # Shared utilities, types, constants (dual ESM + CJS via tsup)
  prisma/         # Prisma schema and migrations (shared by api and backend)
  docker/         # Docker configuration files
  scripts/        # Setup and utility scripts
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
2. Make your changes, following the module system rules and code style of the existing codebase.
3. Ensure all tests pass:
   ```bash
   pnpm test
   ```
4. Write clear, descriptive commit messages.
5. Open a pull request against the `main` branch with a description of your changes.

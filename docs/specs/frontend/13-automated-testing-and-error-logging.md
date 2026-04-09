# 13. Automated Testing & Error Logging

## 13.1 Overview

This specification covers the testing infrastructure for the `apps/web` React application. The goals are:

1. **Catch regressions in UI logic** — hook and component tests that verify data-fetching, state transitions, and rendering without requiring a live backend.
2. **Validate user flows end-to-end** — Playwright E2E tests (currently scaffolded as stubs) that will drive a real browser through auth, Plaid linking, and CSV import flows once implemented.
3. **Run automatically in CI** — every push to any branch triggers unit tests; E2E runs only on `main` merges to keep branch builds fast.

The frontend uses a **three-layer test pyramid**:

```
            ┌────────────────────────────────────┐
            │         E2E Tests (Playwright)      │  Real browser, real stack
            │         (fewest, slowest)           │  13 stubs — main branch only
            └────────────────────────────────────┘
         ┌──────────────────────────────────────────┐
         │      Component Tests (RTL)               │  jsdom + MSW, no real API
         │      (medium)                            │  page + context tests
         └──────────────────────────────────────────┘
      ┌────────────────────────────────────────────────┐
      │         Hook / Unit Tests (Vitest + MSW)        │  renderHook, no DOM render
      │         (most, fastest)                         │  hooks + lib tests
      └────────────────────────────────────────────────┘
```

---

## 13.2 Unit & Component Test Architecture

### Framework

| Tool | Version | Role |
|------|---------|------|
| Vitest | 2.x | Test runner — ESM-native, Vite-integrated |
| `@vitejs/plugin-react-swc` | matches `vite.config.ts` | JSX transform (SWC, not Babel) |
| `@testing-library/react` | latest | Component rendering + `renderHook` |
| `@testing-library/jest-dom` | latest | DOM matchers (`toBeInTheDocument`, etc.) |
| `@testing-library/user-event` | latest | Realistic user interaction simulation |
| MSW v2 | 2.x | HTTP interception — intercepts `fetch` calls in jsdom |
| jsdom | latest | Browser environment simulation |

### Configuration (`vitest.config.ts`)

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    reporter: 'verbose',
    passWithNoTests: false,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/components/**', 'src/hooks/**'],
      thresholds: { branches: 60, functions: 60, lines: 60 },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

Key decisions:
- `passWithNoTests: false` — test files now exist, so the suite should fail if no tests are found (indicating a config issue)
- `@vitejs/plugin-react-swc` — must match the existing `vite.config.ts` plugin; using `@vitejs/plugin-react` (Babel) causes transform errors
- `@` alias — mirrors `vite.config.ts` so import paths like `@/hooks/use-accounts` work in tests

### Setup File (`src/test/setup.ts`)

```ts
import '@testing-library/jest-dom';
import { beforeAll, afterAll, afterEach } from 'vitest';
import { server } from './msw/server';

// Start MSW before all tests
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
// Reset any runtime handler overrides after each test
afterEach(() => server.resetHandlers());
// Clean up after the full suite
afterAll(() => server.close());
```

`onUnhandledRequest: 'warn'` (not `'error'`) is intentional during early development — it lets tests run even when an API call is made that no handler covers, while still surfacing the issue in the console.

---

## 13.3 MSW API Mocking

MSW (Mock Service Worker) intercepts `fetch` calls in the jsdom environment using a Node-compatible server. No real HTTP server or backend is required to run any unit or component test.

### Server (`src/test/msw/server.ts`)

```ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';
export const server = setupServer(...handlers);
```

### Default Handlers (`src/test/msw/handlers.ts`)

The default handler set covers the most-used API endpoints with happy-path stub responses. Individual tests can override specific handlers using `server.use(...)` for error or edge-case scenarios.

| Handler | Method | Default Response |
|---------|--------|-----------------|
| `/api/session` | GET | `{ user: null }` |
| `/api/accounts` | GET | `{ accounts: [] }` |
| `/api/categories` | GET | `{ categories: [] }` |
| `/api/transactions` | GET | `{ transactions: [], total: 0 }` |
| `/api/analytics` | GET | `{ summary: {} }` |
| `/api/portfolio` | GET | `{ items: [] }` |

### Overriding Handlers in a Test

```ts
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';

it('shows an error banner when accounts fail to load', async () => {
  server.use(
    http.get('/api/accounts', () => HttpResponse.json({ error: 'Server error' }, { status: 500 }))
  );
  // ... render component and assert error state
});
```

---

## 13.4 Hook-Level Mocking with Typed Helpers

MSW intercepts at the HTTP layer, which is the right tool when a test renders a component that triggers real network calls (page tests, integration-style flows). For tests where the component reads from a custom hook and the hook itself is the unit of behavior worth controlling — most page and component tests in `apps/web` — it's simpler to mock the hook directly with `vi.mocked()` and skip the network layer entirely.

The challenge: TanStack Query's `UseQueryResult<T>` and `UseMutationResult` interfaces have ~20 properties each, and tests usually only care about `data` / `mutate`. Building a full result object inline is verbose, and casting with `as any` defeats the type system.

### Helper: `src/test/mock-helpers.ts`

A small set of typed helpers that build minimal-but-valid `UseQueryResult` / `UseMutationResult` fakes via a single `as unknown as …` cast at the helper boundary, so test files stay clean and never need explicit `any`.

```ts
import { mockQueryResult, mockQueryLoading, mockQueryError, mockMutationResult } from '@/test/mock-helpers';

// Successful query
vi.mocked(useAdapters).mockReturnValue(
  mockQueryResult([{ id: 1, name: 'Chase CSV' }])
);

// Loading state
vi.mocked(useAdapters).mockReturnValue(mockQueryLoading());

// Error state
vi.mocked(useAdapters).mockReturnValue(mockQueryError(new Error('500')));

// Mutation with custom mutate spy
const uploadMock = vi.fn();
vi.mocked(useUploadSmartImport).mockReturnValue(
  mockMutationResult({ mutate: uploadMock })
);
```

Each helper accepts an `overrides` argument when a test needs to set additional fields (e.g. `isFetching: true`). The cast through `unknown` keeps the public API type-safe without introducing `any` tokens that ESLint flags.

### Choosing Between MSW and `vi.mocked` + Helpers

| Use MSW when… | Use `vi.mocked` + helpers when… |
|---|---|
| The test renders a component that calls `fetch` directly | The test renders a component that reads from a custom hook |
| You're testing the data-fetching layer itself (a `use-X.ts` hook) | You're testing how a component reacts to a hook's `data` / `isLoading` / `error` |
| You need to assert the request shape (URL, body, query params) | You only care about the rendered output for a given hook return value |
| The test spans multiple hooks that share an HTTP endpoint | You want to isolate one component from the entire data layer |

Both approaches coexist. Hook tests under `src/hooks/*.test.tsx` typically use MSW because they're exercising the hook's actual `useQuery` plumbing. Page and component tests typically use `vi.mock('@/hooks/use-X')` + `mockQueryResult` because they don't need the network layer at all.

### No `as any` in Test Fixtures

ESLint's `@typescript-eslint/no-explicit-any` rule is enforced across `apps/web` (including test files) with `--max-warnings 0`. When you need to construct a mock fixture that doesn't satisfy a strict type, prefer one of the following in order of preference:

1. **Build the full real type.** If the fixture is small (Tag, User, Adapter), spell it out. TypeScript catches drift when the real type changes.
2. **Use the `mockQueryResult` / `mockMutationResult` helpers.** They handle the `UseQueryResult` / `UseMutationResult` envelope so you only have to provide `data`.
3. **Cast through `unknown` to a `ReturnType` alias.** When the hook exposes a complex shape you don't want to fully reconstruct:
   ```ts
   vi.mocked(api.getStagedImport).mockResolvedValueOnce(
     stagedFixture as unknown as Awaited<ReturnType<typeof api.getStagedImport>>
   );
   ```
4. **Use `Awaited<ReturnType<typeof api.X>>`** for `Promise<void>` returns — pass an empty object `{}` or `undefined` as needed since the test typically doesn't consume the resolved value.

`as any` is never the right answer in a test file. All `api.ts` methods now return fully-typed promises (`src/types/api.ts` holds the shared response interfaces). If none of the above patterns work, fix the type at its definition site instead of papering over it in the test.

---

## 13.5 Running Tests

```bash
# Unit + component tests (no backend required)
npm run test:unit       # run once
npm run test:watch      # watch mode — recommended during active development
npm run test:coverage   # v8 coverage report, enforces 60/60/60 thresholds
```

---

## 13.6 E2E Scaffolding (Phase 4)

### Location

The E2E suite lives inside this repository at `e2e/`. This is its permanent home — E2E tests cover user-facing flows and belong in the frontend repo.

```
bliss/
└── e2e/
    ├── package.json               # standalone Node project, @playwright/test
    ├── playwright.config.ts       # Chromium only, baseURL from E2E_BASE_URL
    ├── tests/
    │   ├── auth.spec.ts           # 4 stubs: sign-up, sign-in, protected route, sign-out
    │   ├── plaid-connect.spec.ts  # 4 stubs: link bank, disconnect, sync, re-sync
    │   └── import.spec.ts         # 5 stubs: detect adapter, review, confirm, dedup, cancel
    └── helpers/
        └── setup.ts               # createTestUser() helper — direct API call
```

### Playwright Config (`e2e/playwright.config.ts`)

```ts
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

### Current Status

All 13 test cases are **`test.skip` stubs** — they pass in CI with exit 0 (skipped, not failed). This establishes the structure and CI hook without blocking development.

> **`test.todo` vs `test.skip`**: Never use `test.todo('description')` inside a `test.describe()` block. It fails at runtime due to a TypeScript/CJS compilation issue where `test.todo` does not resolve correctly when called on the imported `test` object. Use `test.skip('description', async () => {})` for all placeholder tests.

### Running Locally

```bash
cd e2e
npm ci                                       # first time only
npx playwright install --with-deps chromium  # first time only
E2E_BASE_URL=http://localhost:8080 npx playwright test
```

### CI

The `e2e` job in `.github/workflows/ci.yml` runs **only on `main` branch merges** (`if: github.ref == 'refs/heads/main'`). It is excluded from feature branch runs while tests remain stubs. When real E2E tests are written, remove this guard so they run on every PR.

When real tests are implemented, the CI job will also need to start `apps/backend` and `apps/api` before Playwright runs. This can be done with additional checkout + `npm run dev` steps in the workflow, or via Docker Compose.

---

## 13.7 CI/CD

Frontend tests run as part of the unified monorepo CI workflow at `.github/workflows/ci.yml`.

### Jobs

| Job | Trigger | Infrastructure |
|-----|---------|---------------|
| `web-unit` | every push + PRs to main/develop | none |
| `e2e` | `main` branch only, after unit jobs pass | none (stubs skip without a server) |

### Environment Variables

No secrets required for unit tests. All CI values are hardcoded test-safe values.

### Workflow Trigger

The unified CI workflow triggers on every push and pull request to main/develop. The `web-unit` job runs frontend tests as part of the broader monorepo CI pipeline.

---

## 13.8 Current Coverage Status

### Frontend Unit & Component Tests

The frontend test suite consists of **45 test files with 206 tests** covering the major application layers. Run `pnpm test:web` to execute all tests.

**Test categories:**

- **Hook tests** (`src/hooks/*.test.tsx`): The largest group, covering data-fetching hooks including use-account-list, use-currency-rates, use-dashboard-actions, use-equity-analysis, use-force-theme, use-insights, use-notifications, use-onboarding-progress, use-portfolio-holdings, use-portfolio-lots, use-sync-logs, use-tag-analytics, use-tags, use-ticker-search, and more. These use `renderHook()` and mock `api.X` directly with `vi.mocked()`.
- **Page tests** (`src/pages/*.test.tsx`): Component-level tests for dashboard, smart-import, transactions, reports/portfolio, and settings pages. These use RTL + `vi.mock('@/hooks/use-X')` + the typed helpers from `src/test/mock-helpers.ts` (see §13.4).
- **Context tests** (`src/contexts/*.test.tsx`): AuthContext provider tests.
- **Library tests** (`src/lib/*.test.ts`): Pure utility tests for investment-utils, pnl, portfolio-utils, and general utils.

### E2E Flows Not Yet Implemented (Phase 4)

| Spec File | Stubs | When to Implement |
|-----------|-------|------------------|
| `auth.spec.ts` | 4 | Ready to implement |
| `import.spec.ts` | 5 | Ready to implement |
| `plaid-connect.spec.ts` | 4 | Ready to implement (Requires Plaid Sandbox credentials configured in CI) |

---

## 13.9 Next Steps

1. **Implement Playwright Cases**: Begin fleshing out the `test.skip` stubs in `e2e/tests/`. Start with `auth.spec.ts` to establish reliable login mechanisms that other tests can leverage.
2. **Enhance MSW Edge Cases**: Add more `.throws()` or `500` error intercepts in the existing tests to assert that global error banners and toast notifications correctly respond to backend instabilities.
3. **Expand GitHub Actions Strategy**: Modify `.github/workflows/ci.yml` so that if the `frontend-unit` runs successfully on `main`, the CI auto-boots the API docker-compose instance to run the Playwright headless browsers natively against testing environments.

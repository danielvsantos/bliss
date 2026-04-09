# Bliss Frontend (React + Vite)

This is the single-page application that users interact with. Built with React 18, Vite, shadcn/ui, Tailwind CSS, and TanStack Query.

## Module system: ESM

All files use `import` / `export`. Never use `require()` in this app.

## Directory structure

```
apps/web/src/
  pages/                # Route pages
    auth/               # Sign-in, sign-up
    reports/            # Financial reports (portfolio, expenses, tags, PnL, equity-analysis)
    settings/           # User settings (index.tsx) + user management (users.tsx)
    Index.tsx           # Landing / home page
    dashboard.tsx       # Main dashboard
    accounts.tsx        # Account management
    transactions.tsx    # Transaction list
    smart-import.tsx    # CSV/XLSX import flow
    transaction-review.tsx  # Plaid transaction review
    insights.tsx        # AI insights
    manual-updates.tsx  # Manual asset value updates
    currency-rates.tsx  # Exchange rates
    Categories.tsx      # Category management
    onboarding.tsx      # First-time setup
    coming-soon.tsx     # Placeholder page
    NotFound.tsx        # 404 page
  components/
    ui/                 # shadcn/ui primitives (53 components -- do not modify directly)
    layout/             # App shell, sidebar, navigation
    dashboard/          # Dashboard widgets
    accounts/           # Account-related components
    charts/             # Recharts-based chart components
    metrics/            # Financial metric displays
    insights/           # Insight cards
    review/             # Transaction review components
    entities/           # Shared entity components
    settings/           # Settings panels
    onboarding/         # Onboarding flow components
    plaid-connect.tsx   # Plaid connection component (top-level)
    withAuth.tsx        # Auth HOC wrapper (top-level)
  hooks/                # 32 custom React hooks (use-*.ts/tsx)
  contexts/             # AuthContext (single context provider)
  lib/                  # Utility modules
    portfolio-utils.ts  # parseDecimal, getGroupColor, buildGroupColorMap, getGroupIcon
  types/                # TypeScript type definitions
  i18n/                 # Internationalization (i18next, multiple locales)
```

## Design system -- MANDATORY

All semantic colors must use design tokens from `src/index.css`. **Never use raw Tailwind color utilities** (e.g., `green-500`, `red-600`, `amber-100`, `blue-700`) in JSX.

### Semantic color tokens

| Token | Hex | Tailwind classes | Use for |
|-------|-----|------------------|---------|
| `positive` | #2E8B57 | `text-positive`, `bg-positive`, `bg-positive/10` | Success, gains, synced, healthy |
| `negative` | #E5989B | `text-negative`, `bg-negative`, `bg-negative/10` | Losses, negative amounts |
| `warning` | #E09F12 | `text-warning`, `bg-warning`, `bg-warning/10` | Caution, pending, attention |
| `destructive` | #E5989B | `text-destructive`, `bg-destructive` | Errors, delete actions |
| `brand-primary` | #6D657A | `text-brand-primary`, `bg-brand-primary/10` | Brand accents, info badges |
| `brand-deep` | #3A3542 | `text-brand-deep`, `bg-brand-deep` | Primary text, deep accents |
| `muted` | #F1EEF5 | `text-muted-foreground`, `bg-muted` | Disabled, inactive, manual |
| `primary` | #3A3542 | `text-primary`, `bg-primary` | Buttons, selected states |
| `accent` | #EDE9F3 | `text-accent-foreground`, `bg-accent` | Hover, subtle highlights |

### Badge pattern

```tsx
// CORRECT
<Badge className="bg-positive/10 text-positive border-positive/20">Success</Badge>
<Badge className="bg-warning/10 text-warning border-warning/20">Pending</Badge>
<Badge className="bg-brand-primary/10 text-brand-primary border-brand-primary/20">Info</Badge>
<Badge variant="destructive">Error</Badge>

// WRONG -- never do this
<Badge className="bg-green-100 text-green-700">Success</Badge>
```

Use `/10` opacity for light backgrounds, `/20` for subtle borders.

### Status indicators

| Status | Text | Background | Dot |
|--------|------|------------|-----|
| Healthy / Synced | `text-positive` | `bg-positive/10` | `bg-positive` |
| Warning / Action Required | `text-warning` | `bg-warning/10` | `bg-warning` |
| Error / Critical | `text-destructive` | `bg-destructive/10` | `bg-destructive` |
| Disconnected / Manual | `text-muted-foreground` | `bg-muted` | `bg-muted-foreground` |

### Allowed raw Tailwind colors

Only these are permitted without tokens:
- **Gray scale:** `gray-50` through `gray-900` (structural elements)
- **White / Black:** absolute contrast
- **Inherit / Current:** inheriting parent colors

Everything else (green, red, blue, amber, yellow, orange, indigo, etc.) must come from the token system.

### Data visualization palette (charts)

Use `dataviz-1` through `dataviz-8` tokens for charts and portfolio groups. These are assigned dynamically via `buildGroupColorMap()` and `getGroupColor()` from `src/lib/portfolio-utils.ts`.

| Token | Hex | Purpose |
|-------|-----|---------|
| `dataviz-1` | #6D657A | Default / brand |
| `dataviz-2` | #2E8B57 | Positive / green |
| `dataviz-3` | #E09F12 | Warning / amber |
| `dataviz-4` | #3A3542 | Brand-deep / dark plum |
| `dataviz-5` | #3A8A8F | Teal |
| `dataviz-6` | #B8AEC8 | Light purple |
| `dataviz-7` | #7E7590 | Mid purple |
| `dataviz-8` | #9A95A4 | Muted |

Debt groups always use negative-family colors (#E5989B, #D4686C, #C44E52, #F0B4B6). **Never hardcode hex colors for chart groups.**

### Token source of truth layers

1. UIKit CSS variables (hex) -> external `Uikitforbliss/src/styles/theme.css`
2. Production CSS (HSL) -> `src/index.css`
3. Tailwind mapping -> `tailwind.config.ts`

When adding new semantic colors, update all three layers plus this file.

## Component patterns

- Use **shadcn/ui** components from `@/components/ui/`. Do not modify these directly -- customize via className props or wrapper components.
- Use **TanStack Query** (`@tanstack/react-query`) for all server state. Never store server data in local state.
- Always **invalidate relevant query caches** after mutations.
- Use `useToast()` from `@/hooks/use-toast` for user notifications.
- Use **React Router v6** for navigation.

## Portfolio utilities (`src/lib/portfolio-utils.ts`)

| Function | Purpose |
|----------|---------|
| `parseDecimal(value)` | Safe Prisma Decimal -> number. Use instead of `parseFloat(x as any)` |
| `getDisplayData(item, currency)` | Picks USD vs portfolio currency financial summary |
| `getGroupColor(group, isDebt, index)` | Returns hex color for a category group |
| `buildGroupColorMap(assetGroups, debtGroups)` | Builds `Record<string, string>` color map for all groups |
| `getGroupIcon(group, processingHint?)` | Returns Lucide icon for a category group |

## Custom hooks (`src/hooks/`)

All data fetching is done via custom hooks wrapping TanStack Query:

- `use-transactions.ts` -- Transaction CRUD + pagination
- `use-analytics.ts` -- Financial analytics data
- `use-portfolio-items.ts` -- Portfolio asset management
- `use-portfolio-history.ts` -- Historical portfolio valuations
- `use-portfolio-holdings.ts` -- Portfolio holdings data
- `use-portfolio-lots.ts` -- Portfolio lot-level data
- `use-normalized-portfolio-items.ts` -- Normalized portfolio item data
- `use-plaid-actions.ts` -- Plaid link/sync operations
- `use-plaid-review.ts` -- Plaid transaction review
- `use-imports.ts` -- Smart import flow
- `use-insights.ts` -- AI insights
- `use-tenant-settings.ts` -- Tenant configuration
- `use-user-settings.ts` -- User preferences
- `use-tags.ts` -- Tag management
- `use-tag-analytics.ts` -- Per-tag analytics
- `use-equity-analysis.ts` -- Equity risk metrics
- `use-dashboard-metrics.ts` -- Dashboard summary data
- `use-dashboard-actions.ts` -- Dashboard quick actions
- `use-notifications.ts` -- Notification center
- `use-merchant-history.ts` -- Merchant name suggestions
- `use-account-list.ts` -- Account list data
- `use-currency-rates.ts` -- Exchange rate data
- `use-sync-logs.ts` -- Plaid sync log history
- `use-ticker-search.ts` -- Stock/fund ticker lookup
- `use-export-transactions.ts` -- Transaction CSV export
- `use-onboarding-progress.ts` -- Onboarding checklist state
- `use-force-theme.ts` -- Theme override
- `use-metadata.ts` -- Page metadata
- `use-page-visible.ts` -- Page visibility detection
- `use-user-signals.ts` -- User signal tracking
- `use-toast.ts` -- Toast notification hook

## Internationalization

react-i18next with 5 locales: English (`en`), Spanish (`es`), French (`fr`), Portuguese (`pt`), Italian (`it`). Translation files live in `src/i18n/locales/`.

**Rules:**
- Use `useTranslation()` hook and `t('key')` for ALL user-facing strings. No hardcoded English text in JSX.
- System category names use helpers from `src/lib/category-i18n.ts`: `translateCategoryName(t, category)`, `translateCategoryGroup(t, group)`, `translateCategoryType(t, type)`.
- Custom user-created categories display as-is (not translated).
- Search features should match against both original DB values and translated values.
- Tests mock i18n with `t: (key) => key` and assert on translation keys, not English strings.
- Full i18n spec in `docs/specs/frontend/00-design-system.md` section 12.

## Testing

**Framework:** Vitest with React Testing Library and MSW (Mock Service Worker).

**Run tests:**
```bash
pnpm test:web
```

**Coverage:** 46 test files across hooks (28), pages (7), components (7), contexts (1), and lib utilities (4).

**Patterns:**
- Component tests render with necessary providers (QueryClient, Router, Auth)
- Two valid mocking strategies: MSW handlers (HTTP-level, used by hook tests) or `vi.mock('@/hooks/use-X')` + `mockQueryResult` / `mockMutationResult` from `src/test/mock-helpers.ts` (hook-level, used by page/component tests)
- Never use `as any` in test fixtures — use the typed helpers, build the real type, or cast through `as unknown as Awaited<ReturnType<typeof api.X>>`. ESLint enforces `--max-warnings 0` on test files.
- Hook tests use `renderHook` from `@testing-library/react` with query client wrapper
- Playwright e2e tests in `e2e/` directory (stubs only)
- Full testing spec at `docs/specs/frontend/13-automated-testing-and-error-logging.md`

## Path aliases

`@/*` maps to `./src/*` (configured in `vite.config.ts` and `tsconfig.json`). Use `@/components/ui/button`, `@/hooks/use-transactions`, etc.

## Environment variables

The only env var baked into the web bundle at build time is `NEXT_PUBLIC_API_URL` (the API layer URL). All other configuration is server-side.

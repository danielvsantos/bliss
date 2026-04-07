# 2. Core Entities (Frontend)

This document describes the frontend implementation of two core data entities in the Bliss application: **Accounts** and **Categories**.

---

## 2.1. Accounts

The Accounts page (`src/pages/accounts.tsx`) uses a **master-detail layout** — a fixed-width left panel lists all accounts, and a flexible right panel shows the selected account's detail. This pattern provides a familiar, responsive layout for account management.

### Component Architecture

| Component | File | Responsibility |
|---|---|---|
| `AccountsPage` | `src/pages/accounts.tsx` | Layout shell, state orchestration, dialog triggers |
| `AccountListPanel` | `src/components/accounts/account-list-panel.tsx` | Left panel: searchable list of accounts with status badges |
| `AccountDetailPanel` | `src/components/accounts/account-detail-panel.tsx` | Right panel: account details, Plaid actions, sync logs, health status |
| `AddAccountModal` | `src/components/accounts/add-account-modal.tsx` | Dialog for creating / editing manual accounts |
| `PlaidConnect` | `src/components/plaid-connect.tsx` | Embedded Plaid Link flow for connecting bank accounts |

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  Accounts              [Connect Bank Account]  [Add Manual Account]   │
├──────────────────────────────────────────────────────────────────────┤
│  [Left panel — w-[380px] shrink-0] │ [Right panel — flex-1]         │
│                                    │                                  │
│  [Search input]                    │  <AccountDetailPanel />          │
│                                    │   or empty-state prompt          │
│  Account list items:               │                                  │
│  • icon + name + institution       │                                  │
│  • status badge                    │                                  │
│  • selected state: border-l-2      │                                  │
│    border-l-primary bg-muted       │                                  │
└──────────────────────────────────────────────────────────────────────┘
```

The outer flex container uses `flex flex-1 min-h-0` for correct overflow handling.

### Account List Panel (`account-list-panel.tsx`)

- Renders a scrollable list of all tenant accounts **grouped by bank** using `<Collapsible>` components. Each bank is a collapsible section header showing the bank name and account count. Accounts under the same institution are grouped together; accounts without a bank are grouped under "Manual Accounts" (sorted last).
- Each item is a `<button>` with icon, name, institution, masked account number, and a `StatusBadge`.
- **Status badges** use design tokens:
  - `ACTIVE` → `bg-positive/10 text-positive border-positive/20` ("Synced")
  - `LOGIN_REQUIRED` / `ERROR` → `bg-warning/10 text-warning border-warning/20` ("Action Required")
  - `REVOKED` / `DISCONNECTED` → `bg-muted text-muted-foreground` ("Disconnected")
  - Manual accounts → `bg-muted text-muted-foreground` ("Manual")
- Selected item: `bg-muted border-l-2 border-l-primary`.
- Real-time search by account name or institution.
- Data fetched via `useAccountList()` hook.

### Account Detail Panel (`account-detail-panel.tsx`)

Shows the full detail of the selected account, including:
- Account name, bank name, masked account number, currency, country.
- **Plaid status card** — connection health, last sync timestamp, `consentExpiration` warning.
- **Actions card** — contextual action buttons:
  - Plaid accounts: "Force Re-sync", "Rotate Token", "Disconnect"
  - All accounts: "Edit", "Delete"
- **Sync Logs card** — paginated log of recent Plaid sync events (type, status, counts, timestamp).
- **Linked accounts** — list of Plaid sub-accounts under the same institution.

### Adding an Account

Two entry points:

1. **Manual account** — `[Add Manual Account]` button opens `<AddAccountModal />`, a dialog form with fields: name, account number (encrypted at rest), bank, currency, country, owners. Uses `react-hook-form` + `zod`.

2. **Plaid Connect** — `[Connect Bank Account]` button opens the `<PlaidConnect />` component, which initiates the Plaid Link flow (fetches a link token from `/api/plaid/link-token`, opens the Plaid SDK modal, exchanges the public token via `/api/plaid/exchange-token`).

### Deleting an Account

Triggered from the detail panel. A confirmation dialog is shown. The delete operation calls `api.deleteAccount(id)`. The API enforces that an account with linked transactions cannot be deleted — the error message is surfaced to the user via toast.

### Key Hooks

- `useAccountList()` — fetches and caches the account list; returns `{ accounts, isLoading, refetch }`. Internally fetches both metadata (accounts, banks) and Plaid items, then builds an `EnrichedAccount[]` array.
- `accountListKeys` — React Query key factory for cache invalidation (`all` for accounts, `plaidItems()` for Plaid items).

### EnrichedAccount Interface

The `useAccountList()` hook enriches raw `Account` objects into an `EnrichedAccount` type that includes:
- `status`: `'synced' | 'action-required' | 'disconnected' | 'manual'`
- `healthLabel` / `healthColor`: Design-system-friendly health indicators
- `plaidItem`: Linked `PlaidItem` reference (null for manual accounts)
- `plaidAccountId`: Specific Plaid sub-account ID
- `historicalSyncComplete`, `earliestTransactionDate`: Sync progress indicators
- `originalAccount`: Reference to the raw `Account` object

### Plaid Items Polling

Plaid items are fetched via a separate query (`accountListKeys.plaidItems()`) that polls every 60 seconds while any item has an incomplete historical sync (`historicalSyncComplete === false`). Polling is paused when the browser tab is not visible (`usePageVisible()`). The account list also refetches on window focus to catch post-Plaid-modal updates.

### Subcomponents

- **`ConnectionHealth`** (`src/components/accounts/connection-health.tsx`) — Renders Plaid connection health status with consent expiration warnings.
- **`SyncLogsTable`** (`src/components/accounts/sync-logs-table.tsx`) — Paginated table of recent Plaid sync events (type, status, counts, timestamp).

### Design System

All status badges, borders, and interactive states use Bliss design tokens — never raw Tailwind color classes. See `apps/web/CLAUDE.md` and `specs/00-design-system.md` for the full token reference.

---

## 2.2. Categories

The Categories page (`src/pages/Categories.tsx`) uses an **accordion-per-type layout** that reflects the natural 3-level hierarchy in the data model: **Type → Group → Category**. It replaces the old flat table.

### Data Model Hierarchy

```
Type (e.g. "Essentials")
  └── Group (e.g. "Eating In")
        └── Category (e.g. 🛒 Groceries)
```

The 9 canonical types are defined in `apps/api/lib/constants.js` as `ALLOWED_CATEGORY_TYPES` and mirrored on the frontend in `CATEGORY_TYPES`. All categories must belong to one of these types: Income, Essentials, Lifestyle, Growth, Ventures, Investments, Asset, Debt, Transfers. Groups are free-form strings within a type.

### Default vs. Custom Categories

Every tenant receives the full default category set at signup (seeded from `apps/api/lib/defaultCategories.js`). These are identified by a non-null `defaultCategoryCode` on the `Category` model.

| Attribute | Default Category | Custom Category |
|---|---|---|
| `defaultCategoryCode` | Non-null string (e.g. `GROCERIES`) | `null` |
| Can rename? | ✅ Yes | ✅ Yes |
| Can change type/group? | ❌ No | ✅ Yes |
| Can delete? | ❌ No | ✅ Yes |
| Can set icon? | ✅ Yes | ✅ Yes |
| AI classification | Used for cross-tenant global embeddings | Tenant-scoped only |

### Component Architecture

| Component | File | Responsibility |
|---|---|---|
| `CategoriesPage` | `src/pages/Categories.tsx` | Layout, search, accordion sections, dialogs |
| `TypeSection` | *(inlined in Categories.tsx)* | Accordion item per type: groups + rows + contextual add button |
| `CategoryRow` | *(inlined in Categories.tsx)* | Single category row: icon, name, badges, action menu |
| `CategoryForm` | `src/components/entities/category-form.tsx` | Two-mode form: rename (default) or full (custom) |

### Page Layout

```
┌────────────────────────────────────────────────────────┐
│  Categories                          [+ Add Category]  │
├────────────────────────────────────────────────────────┤
│  [Search input]                                        │
│                                                        │
│  ▼  Income                 7 categories               │
│  ├── Labor Income                                      │
│  │     💵  Salary                     [···]            │
│  │     🏛️  Government Funds           [···]            │
│  └──  [+ Add Income Category]                          │
│                                                        │
│  ▶  Essentials            43 categories               │
│  ▶  Lifestyle              8 categories               │
│  ▶  Growth                 5 categories               │
│  ▶  Ventures               3 categories               │
│  ...                                                   │
└────────────────────────────────────────────────────────┘
```

Custom categories (those with `defaultCategoryCode === null`) are mixed into the same type-based accordion sections alongside default categories. They are distinguished by the absence of the Default/Lock badge. There is no separate standalone section for custom categories.

### Accordion Sections

Each type has an `AccordionItem` (from `src/components/ui/accordion.tsx`, built on Radix UI). The header shows the type name and a category count badge. Each accordion has a **colored left border** (4px) using a design token mapped to the type:

| Type | Token Class |
|---|---|
| Income | `border-l-positive` |
| Essentials | `border-l-negative` |
| Lifestyle | `border-l-warning` |
| Growth | `border-l-brand-primary` |
| Ventures | `border-l-dataviz-5` |
| Investments | `border-l-brand-primary` |
| Asset | `border-l-brand-deep` |
| Debt | `border-l-destructive` |
| Transfers | `border-l-muted-foreground` |

Within each open accordion, **group subheadings** appear as `text-[10px] font-semibold uppercase tracking-wider text-muted-foreground` labels — purely visual, non-collapsible.

### Category Row

Each category is rendered as a row with:

- **Emoji icon** from `category.icon`, or a `TagIcon` fallback if unset.
- **Name**.
- **Default badge** (when `defaultCategoryCode != null`): `bg-brand-primary/10 text-brand-primary border-brand-primary/20` with a `LockIcon`. Tooltip explains: *"System category — used for AI classification across all tenants. Cannot be deleted."*
- **Integration badge** (when `processingHint` is set) — view-only, indicates the category's backend behaviour:

| processingHint | Label | Badge Class |
|---|---|---|
| `API_STOCK` | Stock Prices API | `bg-positive/10 text-positive border-positive/20` |
| `API_CRYPTO` | Crypto Prices API | `bg-positive/10 text-positive border-positive/20` |
| `AMORTIZING_LOAN` | Loan Tracking | `bg-brand-primary/10 text-brand-primary border-brand-primary/20` |
| `SIMPLE_LIABILITY` | Liability Tracking | `bg-brand-primary/10 text-brand-primary border-brand-primary/20` |
| `CASH` | Cash Tracking | `bg-brand-primary/10 text-brand-primary border-brand-primary/20` |
| `MANUAL` | Manual | `bg-muted text-muted-foreground border-border` |
| `TAX_DEDUCTIBLE` | Tax Deductible | `bg-warning/10 text-warning border-warning/20` |
| `DEBT` | Debt Tracking | `bg-brand-primary/10 text-brand-primary border-brand-primary/20` |

- **Transaction count** — `{n} transactions` in `text-xs text-muted-foreground` (omitted when count is 0).
- **`···` context menu** — context-sensitive:
  - Default category: **Rename** only.
  - Custom category: **Edit** + **Delete**.

### Search Behaviour

The search input filters by name, group, and type simultaneously. When a query is active:
- Accordion sections that contain at least one match are **auto-expanded**.
- Non-matching category rows are dimmed (`opacity-30`) but remain visible within their group.
- Accordion sections with no matches are **hidden entirely**.

### Contextual Add Button

Each accordion section has a `+ Add [Type] Category` ghost button at the bottom. Clicking it opens the create form with the `type` field pre-populated.

### Category Form (`category-form.tsx`)

The form has two modes, selected automatically by the parent:

**Rename mode** — for default categories:
- Fields: `name`, `icon` (emoji text input).
- The type and group cannot be changed.
- A description note explains this restriction.

**Full mode** — for creating or editing custom categories:
- Fields: `name`, `type` (hardcoded `ALLOWED_CATEGORY_TYPES` select), `group` (filtered by selected type + "Create new group…" option), `icon` (optional).
- The group dropdown is disabled until a type is selected, and resets when the type changes.
- Uses two separate Zod schemas: `renameSchema` and `fullSchema`.

### "Merge Into" on Delete

When deleting a category that has associated transactions, the delete dialog transitions to a "Reassign & Delete" flow. The API returns `requiresMerge: true` with a `transactionCount`, and the dialog displays a `<Select>` dropdown listing all other categories as merge targets. The user selects a target category, then confirms with a "Delete & Reassign" button. All dependent records (transactions, PlaidTransactions, TransactionEmbeddings, PortfolioItems) are atomically reassigned to the target category before the source category is deleted.

### API Interaction

- `api.getCategories()` — fetches all categories. The response now includes `_count.transactions` (number of transactions tagged to each category) and `defaultCategoryCode`.
- `api.createCategory(payload)` — creates a custom category. Accepts `name`, `group`, `type`, `icon`.
- `api.updateCategory(id, payload)` — updates a category. Accepts `name`, `group`, `type`, `icon`. The `processingHint` and `portfolioItemKeyStrategy` fields are system-managed and cannot be set by users.
- `api.deleteCategory(id, mergeTargetId?)` — deletes a custom category. If the category has transactions, the API returns `requiresMerge: true` and the UI prompts the user to select a merge target. On retry with a `mergeTargetId`, all dependent records are reassigned before deletion. The API enforces deletion protection for system-critical groups.

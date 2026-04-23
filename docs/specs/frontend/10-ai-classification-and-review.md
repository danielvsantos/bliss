# 10. AI Classification & Review UI

The Transaction Review page provides a unified workspace for reviewing and actioning transactions from both Plaid sync and smart file imports. It lives at `/agents/review` and is the canonical post-processing review surface.

---

## Page: `transaction-review.tsx`

### URL Parameters

- `?source=plaid` — opens page with Plaid tab pre-selected
- `?source=imports` — opens page with Imports tab pre-selected
- `?plaidItemId=<id>` — pre-filters the Plaid tab to a specific connection

---

## Layout Overview

```
┌─────────────────────────────────────────────────────────┐
│  Transaction Review                                     │
│  X of Y reviewed  [████████░░]  80%   [Bulk Promote]   │
├─────────────────────────────────────────────────────────┤
│  [All Pending (N)] [From Plaid (N)] [From Imports (N)]  │
│                                            [◻ Grouped]  │
├─────────────────────────────────────────────────────────┤
│  ┌──── GroupCard ────────────────────────────────────┐  │
│  │ (5) 🛒 Shopping    $268.20    [Approve All (5)]   │  │
│  │ ────────────────────────────────────────────────  │  │
│  │  Date     Merchant      Amount  Confidence Status  │  │
│  │  Feb 18   Target       -$89.99  94% LLM    ✅     │  │
│  │  Feb 19   Amazon      -$124.50  91% LLM    🔵     │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
              ┌── DeepDiveDrawer (Sheet, right) ──────────┐
              │  Target                                    │
              │  Feb 18, 2026 · -$89.99                   │
              │  [Shopping ▼]  [✅ AI Approved]           │
              │ ─────────────────────────────────────────  │
              │  ✨ BLISS ANALYSIS                         │
              │  Confidence     94%  ████████░             │
              │  Source     [LLM Classification]           │
              │  Plaid Hint  GENERAL_MERCHANDISE           │
              │  ─ Why I chose this ─                      │
              │  "Classified as Shopping because..."       │
              │ ─────────────────────────────────────────  │
              │  🔧 ENRICHMENT REQUIRED  (investment only) │
              │  Ticker Symbol    [VFIAX]                  │
              │  Quantity         [1.23]                   │
              │  Price per Share  [43.67]                  │
              │  Notes            [textarea]               │
              │ ─────────────────────────────────────────  │
              │  🕐 MERCHANT HISTORY                       │
              │  Jan 12  -$67.40   Shopping                │
              │  Dec 18  -$112.30  Shopping                │
              │ ─────────────────────────────────────────  │
              │              [Cancel] [Save & Promote]     │
              └────────────────────────────────────────────┘
```

---

## Header: Progress Bar

At the top of the page, a progress bar shows overall review progress:

- **"X of Y reviewed"** — `promoted + skipped` count versus total pending.
- A shadcn `Progress` component shows percentage completion.
- **Bulk Promote** button → opens a confirmation dialog showing the confidence threshold and expected promotion count. Calls `POST /api/plaid/transactions/bulk-promote` on confirm. The API applies `minConfidence: 0.8` by default; `requiresEnrichment: true` rows are always excluded.

---

## Tabs

### "All Pending" Tab

A combined overview of both data sources. Shows all pending Plaid transactions and a list of pending import files (one card per import).

### "From Plaid" Tab

Full Plaid transaction review interface. Shows `CLASSIFIED` PlaidTransactions for the tenant.

### "From Imports" Tab

Review and commit interface for staged file imports.
- Import selector bar at top — one button per pending import from `usePendingImports()`.
- Row table below with same controls as the Plaid tab.
- "Commit Import" button at bottom — calls `POST /api/imports/:id?action=commit`.

---

## View Toggle: `components/review/view-toggle.tsx`

A toggle button (grid icon + "Grouped" label) in the tab header area. Controls `viewMode` state:
- **Grouped** (default): rows grouped into `GroupCard` components by category.
- **Flat**: all rows rendered in a single card without grouping.

---

## Group Card: `components/review/group-card.tsx`

Expandable card for a single category group.

**Header** (clickable — expands/collapses):
- Pill badge with row count
- Category icon + name
- Net total amount
- **"Approve All (N)"** button → calls `handlePromoteGroup()` for Plaid rows, or batches `handleImportRowStatus(row, 'CONFIRMED')` for import rows. For Plaid rows, `handlePromoteGroup()` calls `POST /api/plaid/transactions/bulk-promote` with `{ transactionIds: [...], categoryId }` scoped to the group's transactions. This bypasses the confidence gate — the user is explicitly approving these rows.
- Chevron icon (rotates on expand)

**Column header row** (desktop, when expanded): Date | Merchant | Account | Amount | Confidence | Status | Actions

**Rows**: list of `TxDataRow` components separated by dividers.

---

## Transaction Row: `components/review/tx-data-row.tsx`

Flex row with the following columns:

| Column | Content |
|---|---|
| Date | Formatted transaction date |
| Merchant | Merchant name or description |
| Account | Account name |
| Amount | Formatted currency amount (debit negative, credit positive) |
| Confidence | Percentage + `classificationSource` label badge |
| Status | `StatusBadge` (see below) |
| Actions | Approve (✓) / Skip (✗) buttons with keyboard shortcut hints (Y/N) |

**Interaction**:
- Clicking the row body opens the `DeepDiveDrawer` for that transaction.
- Approved rows: green background tint.
- Skipped rows: reduced opacity + muted text.
- `Button variant="ghost"` for approve/skip actions.

### Single-Row Approve Intercept ("Promote by Description" Dialog)

When the user clicks the **✓ Approve** button on a single Plaid transaction row, the handler (`handleItemApprove`) checks whether other `CLASSIFIED` rows with the **same `description`** (excluding `requiresEnrichment: true` rows) exist in the current review set.

- **If only 1 match** (the row itself): promotes immediately with no dialog.
- **If 2+ matches**: a confirmation dialog appears:

```
┌─────────────────────────────────────────────────────────┐
│  Promote matching transactions?                          │
│  ─────────────────────────────────────────────────────  │
│  Found 4 transactions from "Target" in the same         │
│  category. Promote all of them?                         │
│                                                          │
│           [Just this one]   [Promote all 4]             │
└─────────────────────────────────────────────────────────┘
```

- **"Just this one"**: promotes the single row via `PUT /api/plaid/transactions/:id`.
- **"Promote all N"**: calls `POST /api/plaid/transactions/bulk-promote` with `{ transactionIds: [<all matching IDs>] }`. The `transactionIds` param bypasses `minConfidence` (user is explicitly choosing these rows).
- The dialog shows a spinner while the mutation is in-flight and closes only on success or error.

State: `pendingApproveItem` holds the row the user clicked. `pendingApproveMatches` memo computes the full set of matching-description rows each render.

---

## Status Badge: `components/review/status-badge.tsx`

Four status types using design system tokens:

| Status | Design Token | When applied |
|---|---|---|
| `ai-approved` | `bg-positive/10 text-positive border-positive/20` | `confidence >= reviewThreshold` and not new merchant |
| `new-merchant` | `bg-brand-primary/10 text-brand-primary border-brand-primary/20` | No transaction history found for this merchant |
| `needs-enrichment` | `bg-warning/10 text-warning border-warning/20` | `requiresEnrichment === true` |
| `low-confidence` | `bg-destructive/10 text-destructive border-destructive/20` | `confidence < reviewThreshold` |

**Status mapping logic**:
```typescript
const INVESTMENT_HINTS = new Set(['API_STOCK', 'API_CRYPTO', 'API_FUND', 'MANUAL']);
if (item.requiresEnrichment) → 'needs-enrichment'
else if (item.confidence < reviewThreshold) → 'low-confidence'
else if (noMerchantHistory) → 'new-merchant'
else → 'ai-approved'
```

---

## Deep Dive Drawer: `components/review/deep-dive-drawer.tsx`

A shadcn `Sheet` component (`side="right"`, width `min(480px, 92vw)`) that opens when a row is clicked. Closes when the user clicks Cancel, the overlay, or the X button. All local state resets when `selectedItem` changes.

### A. Header

- Merchant name (heading), formatted date + amount.
- Category `Select` dropdown — editable. Changing the category dynamically re-evaluates whether investment enrichment fields should appear.
- `StatusBadge` for the current status.
- X close button.

### B. AI Analysis Panel: `components/review/ai-analysis-panel.tsx`

Card section labeled **✨ BLISS ANALYSIS**:

| Field | Content |
|---|---|
| AI Confidence | Percentage label + shadcn `Progress` bar |
| Source | `Badge` showing `EXACT_MATCH` / `VECTOR_MATCH` / `VECTOR_MATCH_GLOBAL` / `LLM` / `USER_OVERRIDE` |
| Plaid Category | `plaidHint` from Plaid `personal_finance_category` (Plaid transactions only) |
| Why I chose this | `classificationReasoning` text block (LLM results only; hidden for EXACT_MATCH, VECTOR_MATCH, and VECTOR_MATCH_GLOBAL) |

### C. Investment Enrichment Form: `components/review/investment-enrichment-form.tsx`

Section labeled **🔧 ENRICHMENT REQUIRED**. Shown conditionally:

```typescript
const INVESTMENT_HINTS = new Set(['API_STOCK', 'API_CRYPTO', 'API_FUND', 'MANUAL']);
const selectedCat = categories.find(c => c.id === drawerCategory);
const showEnrichment = item.requiresEnrichment ||
  (selectedCat?.type === 'Investments' && INVESTMENT_HINTS.has(selectedCat.processingHint ?? ''));
```

This means enrichment fields appear both for transactions flagged by the backend AND when the user manually selects an investment category in the drawer.

Fields:
- **Ticker Symbol** — `Input` with placeholder "e.g. VFIAX"
- **Quantity** — `Input type="number"` with placeholder "e.g. 1.23"
- **Price per Share** — `Input type="number"` with placeholder "e.g. 43.67"
- **Notes** — `Textarea` for optional `details` override (used as the `Transaction.details` field)

> Note: There is no Buy/Sell toggle — buy vs. sell is implicit from the transaction amount sign (positive = debit/buy, negative = credit/sell) per Plaid's convention.

### D. Merchant History: `components/review/merchant-history.tsx`

Section labeled **🕐 MERCHANT HISTORY**. Shows the last 10 `Transaction` records for the same merchant/description:

- Data from `useMerchantHistory(selectedItem?.merchant)` hook (`GET /api/transactions/merchant-history?description=...`).
- Table: Date | Amount | Category rows with alternating background.
- Empty state: "No previous transactions found for this merchant."

### E. Footer

- **Cancel** → closes drawer without saving.
- **Skip** → sets `status: 'SKIPPED'` (not shown for already-processed rows).
- **Reset to Pending** → only visible for **import rows** with `promotionStatus === 'CONFIRMED'`. Moves the row back to `PENDING` via `PUT /api/imports/:id/rows/:rowId` with `{ status: 'PENDING' }`. Closes the drawer on click. See §E.1 below.
- **Save & Promote** → the `handleDrawerSave` handler first checks whether other matching transactions exist before committing:

### Drawer Promote-All Intercept

When the user clicks **Save & Promote** for a Plaid transaction that is not already promoted, `handleDrawerSave` checks whether other `CLASSIFIED` rows with the **same `description`** (excluding `requiresEnrichment: true` rows) exist in the current review set.

- **If no other matches**: saves and promotes the single row immediately (no dialog).
- **If 1+ other matches**: a confirmation dialog appears:

```
┌─────────────────────────────────────────────────────────┐
│  Also promote matching transactions?                     │
│  ─────────────────────────────────────────────────────  │
│  3 other transactions from "Starbucks" are pending      │
│  review. Apply [Coffee & Drinks] to all of them too?    │
│                                                          │
│           [Just this one]   [Promote all 4]             │
└─────────────────────────────────────────────────────────┘
```

- **"Just this one"**: calls `PUT /api/plaid/transactions/:id` for the drawer's transaction only (category + promote).
- **"Promote all N+1"**: calls two mutations in sequence:
  1. `PUT /api/plaid/transactions/:id` for the drawer's transaction (suppresses its individual success toast).
  2. `POST /api/plaid/transactions/bulk-promote` with `{ transactionIds: [<other matching IDs>], overrideCategoryId: <drawerCategoryId> }` — applies the user's chosen category to all matching rows and promotes them in one batch.
  - A single combined toast shows the total promoted count.
- The dialog shows a spinner while mutations are in-flight and closes only on success or error.

State: `pendingDrawerSave` holds the drawer's save payload. `pendingDrawerOtherMatches` memo computes the other matching-description rows each render.

After any successful promote mutation:
- `['plaid-transactions']`, `['merchant-history']` caches are invalidated.
- The drawer closes.

### E.1 Reset to Pending (import rows only)

Auto-promote fires at the tenant's `autoPromoteThreshold` (default 0.90), and a classification landing at e.g. 0.91 confidence gets auto-marked `CONFIRMED` without the user ever seeing it. If the user wants a closer look before commit, they need an escape hatch that doesn't require committing then editing the transaction post-facto.

The **Reset to Pending** button in the drawer footer provides that hatch:

- Visible only when `item.source === 'import'` and `item.promotionStatus === 'CONFIRMED'`. For Plaid rows it's hidden entirely (Plaid uses a different status model — PROMOTED rather than CONFIRMED).
- For `SKIPPED` rows it is deliberately NOT shown. User-initiated skips are considered intentional; exposing "un-skip" alongside "un-confirm" adds surface area without a clear use case.
- Wired via the `onResetToPending` prop on `DeepDiveDrawer`. The prop is always optional — callers that don't want to expose the behavior (e.g. any future Plaid-only review surface) simply don't pass it. Both the Smart Import page and the Transaction Review page currently wire it for their import rows.
- Backend acceptance: `apps/api/pages/api/imports/[id]/rows/[rowId].js` includes `'PENDING'` in `ALLOWED_STATUS_OVERRIDES`, so the transition is already supported API-side — only UI was missing.

Design decision: the reset lives in the drawer footer rather than as an inline icon on the row. The row actions (`✓` approve, `✗` skip) hide entirely once a row is `CONFIRMED` / `SKIPPED` (see `tx-data-row.tsx:105`: `showActions = !isPromoted && !isSkipped`), keeping the row-level UI clean. Users who care enough to undo will open the drawer to investigate anyway, and the drawer footer is where destructive / reversal actions live for the single-row context.

---

## Flat View

When `viewMode === 'flat'`, all rows render in a single shadcn `Card` using `TxDataRow` without `GroupCard` wrapping. Same row interactions and drawer opening behavior apply.

---

## Sidebar Badge

The "Review" nav item in the sidebar shows a live badge:
- **Plaid count**: `usePlaidTransactions({ limit: 1 })` → `summary.classified`.
- **Import count**: `usePendingImports()` → sum of `pendingRowCount`.
- **Polling**: `refetchInterval: 30_000` — updates automatically after background Plaid syncs.

---

## Dashboard Notification Card

Shown on `/dashboard` when `classified + importPending > 0`:
- "*X items pending review*" with source breakdown.
- "Review Now" button → `/agents/review`.
- Auto-dismisses when count drops to 0.

---

## Key Hooks

| Hook | File | Purpose |
|---|---|---|
| `usePlaidTransactions` | `hooks/use-plaid-review.ts` | Fetch CLASSIFIED PlaidTransactions (limit: 500) |
| `useUpdatePlaidTransaction` | `hooks/use-plaid-review.ts` | Promote / skip / re-queue / category override |
| `useBulkPromotePlaidTransactions` | `hooks/use-plaid-review.ts` | Bulk promote — accepts `transactionIds`, `overrideCategoryId`, `categoryId`, `plaidItemId`, `minConfidence` |
| `usePendingImports` | `hooks/use-imports.ts` | Fetch READY imports with pending rows |
| `useStagedImport` | `hooks/use-imports.ts` | Fetch staged rows for a single import |
| `useUpdateImportRow` | `hooks/use-imports.ts` | Confirm / skip / category override on import row |
| `useCommitImport` | `hooks/use-imports.ts` | Commit import → creates Transaction records |
| `useMerchantHistory` | `hooks/use-merchant-history.ts` | Fetch recent transactions for same merchant |
| `useMetadata` | `hooks/use-metadata.ts` | Categories, accounts for dropdowns |

---

## Re-queue Skipped Transactions

Users can un-skip a previously skipped transaction directly from the review UI:
- Filter by `?promotionStatus=SKIPPED` to view skipped transactions.
- Row action: "Re-queue" button → calls `PUT /api/plaid/transactions/:id` with `{ promotionStatus: 'CLASSIFIED' }`.
- Transaction reappears in the default `CLASSIFIED` queue.

---

## Page State Summary

| State variable | Type | Purpose |
|---|---|---|
| `pendingApproveItem` | `PlaidReviewItem \| null` | Row whose ✓ Approve click triggered the "promote by description" dialog |
| `pendingDrawerSave` | `DrawerSaveData \| null` | Drawer save payload held while the "also promote matching" dialog is open |

---

## Future Work

- **Import investment enrichment in drawer**: The drawer currently shows investment enrichment fields for Plaid transactions. Smart Import rows with `requiresEnrichment: true` will benefit from the same drawer flow once the import promote path is fully hardened.

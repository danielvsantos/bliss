# 9. Smart Import UI

The Smart Import feature provides an intelligent, guided wizard for importing financial transactions from CSV and XLSX/XLS files. It lives at `/agents/import` and is accessible from the sidebar nav (FileUp icon).

See `docs/specs/backend/09-smart-import.md` for the backend pipeline and `docs/specs/api/09-smart-import-api.md` for the API layer.

---

## Page: `smart-import.tsx`

The page is a four-step wizard with linear progression: **Upload → Processing → Review → Done**.

---

### Step 1: Upload

The user selects a file and a destination account.

**Components & interactions:**
- File picker accepting `.csv`, `.xlsx`, `.xls` — drag-and-drop or click to browse. Maximum file size: **10 MB** (enforced server-side; the API returns a `400` error if exceeded).
- **Auto-detection**: On file selection, calls `POST /api/imports/detect-adapter` (via `useDetectAdapter` mutation). If a match is found, the adapter name is shown and auto-selected.
- **Manual fallback**: If no adapter is detected, a dropdown lists available adapters for manual selection.
- **Account selector**: Dropdown listing the user's accounts; required before upload.
- **Upload button**: Calls `POST /api/imports/upload` (via `useUploadSmartImport` mutation). On success, stores `stagedImportId` and advances to the Processing step.

**Adapter Manager panel:**
A collapsible "Import Adapters" section below the file picker lists all available adapters:
- **Global adapters** (system-wide): displayed with a "System" badge; no edit/delete controls.
- **Tenant adapters**: displayed with Edit (pencil) and Delete (trash) icon buttons.
- **"New Adapter" button**: opens the adapter form in create mode.
- **Edit**: pre-fills the form with existing adapter values.
- **Delete**: soft-deletes the adapter (sets `isActive: false`); tenant-owned only.

**Unknown Format alert:**
When `POST /api/imports/detect-adapter` returns no match, the "Unknown Format" alert includes a **"Create Adapter for this Format"** button. Clicking it opens the Adapter Manager with the create form pre-filled with the detected headers in the `Match Headers` field, allowing the user to define a new adapter without typing headers manually. After the adapter is saved, adapter detection automatically re-runs on the already-selected file. If it matches, the new adapter is auto-selected and a "Format matched: AdapterName" toast is shown.

**Hooks used:** `useAdapters`, `useCreateAdapter`, `useUpdateAdapter`, `useDeleteAdapter`, `useDetectAdapter`, `useUploadSmartImport`

---

### Step 2: Processing

A progress screen shown while the backend worker processes the file (and also during the async commit phase).

**Behaviour:**
- Displays a `Progress` bar driven by `StagedImport.progress` (0–100).
- Polls `GET /api/imports/:id` every 2 seconds via `useStagedImport(stagedImportId)`.
- Polling is active while `status === 'PROCESSING'` or `status === 'COMMITTING'`.
- **Status transition guard**: The transition from `'processing'` step to `'review'` is blocked when `seedReady === true`. This prevents a race condition where the page would advance to the review table before `useImportSeeds` has resolved. When `seedReady=true`, the page stays in `'processing'` step so `useImportSeeds` remains enabled and can load seed data.
- On `status === 'READY'` AND `seedReady === false`: advances to the Review step. If `autoConfirmedCount > 0`, a toast is shown: *"Import Ready — N rows auto-confirmed (high confidence)"*.
- On `status === 'READY'` AND `seedReady === true`: the Quick Classify card appears (see Step 2.5 below).
- On `status === 'CANCELLED'` or error: shows an error state with retry option.

**COMMITTING phase** (after user clicks "Commit Import" in Step 3):
- The commit endpoint returns `202 Accepted` immediately with `{ status: 'COMMITTING' }`.
- A `useRef` tracks the previous `importStatus` to detect `COMMITTING → COMMITTED` or `COMMITTING → READY` transitions.
- On `COMMITTED`: reads `errorDetails.commitResult` (`{ transactionCount, remaining }`), shows a toast, and advances to Step 4 (Done).
- On `COMMITTING → READY` (partial commit): reads `commitResult`, shows a "Partial Commit Complete" toast with transaction count and remaining rows, and stays on the review step.

---

### Step 2.5: Quick Classify

Shown **between** the processing spinner and the review table when `StagedImport.seedReady === true` and `GET /api/imports/:id/seeds` returns one or more items. If seeds are empty (all rows were auto-promoted or EXACT_MATCH hits), this step is skipped and a toast is shown before advancing to review.

The Quick Classify card presents each unique merchant/description group with the AI category suggestion for user confirmation or adjustment:

```
┌───────────────────────────────────────────────────────────┐
│  Quick Classify                                            │
│  Help us learn your spending patterns (4 items)            │
├───────────────────────────────────────────────────────────┤
│  [X]  Netflix               [Streaming ▼]   AI 87%        │
│  [X]  Target                [Shopping ▼]    Match 91%      │
│  [X]  Vanguard Fund         [Investments ▼] Global 84%    │
│  [X]  DUNKIN #1234          [Coffee ▼]      AI 73%        │
├───────────────────────────────────────────────────────────┤
│                             [Skip]  [Confirm Categories]  │
└───────────────────────────────────────────────────────────┘
```

**Badge labels** (based on `classificationSource`):
- `VECTOR_MATCH_GLOBAL` → **"Global"** badge (+ confidence %)
- `VECTOR_MATCH` → **"Match"** badge (+ confidence %)
- `LLM` → **"AI"** badge (+ confidence %)

**X toggle**: Clicking X on a row excludes that merchant from the confirmation batch. Excluded rows do **not** appear in the seeds array sent to the API. The backend releases their corresponding `StagedImportRow` records back to standard `PENDING` status — they appear in the review table with their AI suggestion intact and are not discarded.

**"Skip"**: Advances directly to the review table without confirming any seeds. All held rows become standard `PENDING` rows.

**"Confirm Categories"**: Submits confirmed seed entries via the import seeds confirm endpoint. On success, advances to the review table.

---

### Step 3: Review

The core review interface showing all staged rows for user confirmation.

**Layout:**
- **Flat / Grouped toggle**: Switches between a flat paginated table and an Accordion view grouped by suggested category.
- **Pagination bar**: Previous/Next with page indicator.

**Auto-confirmed rows banner:**
When `autoConfirmedCount > 0`, an info banner appears at the top of the review table: *"N rows were automatically confirmed (confidence ≥ X%)"*. Auto-confirmed rows arrive already in `CONFIRMED` status with a green badge and were classified at or above the tenant's `autoPromoteThreshold` during processing.

**Per-row controls (flat view):**
- **Category dropdown**: Pre-selected to `suggestedCategoryId`. Changing it calls `PUT /api/imports/:id/rows/:rowId` with the new category and sets `classificationSource: 'USER_OVERRIDE'`.
- **Confidence badge**: Colour-coded (green/yellow/red) with source label (`EXACT_MATCH`, `VECTOR_MATCH`, `VECTOR_MATCH_GLOBAL`, `LLM`, `USER_OVERRIDE`).
- **Status badge**: Current row status (`PENDING`, `CONFIRMED`, `DUPLICATE`, etc.).
- **Confirm button**: Sets `status: 'CONFIRMED'`.
- **Skip button**: Sets `status: 'SKIPPED'`.
- **Notes popover**: Opens a text area; content saved on blur via `PUT /api/imports/:id/rows/:rowId`.

**Auto-suggest toast:**
After confirming a row, if other unconfirmed rows share the same `suggestedCategoryId`, a toast appears:
> "3 other transactions in 'Groceries' — Confirm All?"
Clicking "Confirm All" bulk-confirms those rows.

**Grouped view (Accordion):**
- One `AccordionItem` per category.
- Each item shows the category name, row count, and total amount.
- Expanding shows the same per-row controls as the flat view.

**Commit bar (bottom):**
- "Commit Import" button — calls `POST /api/imports/:id?action=commit`. The endpoint returns `202 Accepted` immediately and the commit runs asynchronously in the backend `commitWorker`. The `useCommitImport` hook's `onSuccess` shows a "Commit started" toast; the page detects completion via the polling `useEffect` that watches for `COMMITTING → COMMITTED` or `COMMITTING → READY` transitions.
- "Cancel" button — calls `POST /api/imports/:id?action=cancel`.

**Hooks used:** `useStagedImport`, `useUpdateImportRow`, `useCommitImport`, `useCancelImport`

---

### Step 4: Done

Shown after a successful commit. The transition is triggered by a `useEffect` that detects `importStatus === 'COMMITTED'` and reads the commit result from `StagedImport.errorDetails.commitResult`.

**Displays:**
- Number of transactions committed (from `commitResult.transactionCount`).
- `remaining` count — if > 0, informs the user that uncommitted rows are still available in Transaction Review.

**Actions:**
- **Import Another File** — resets all state back to Step 1.
- **Review in Transaction Review** — navigates to `/agents/review?source=imports`.

---

## Hooks (`src/hooks/use-imports.ts`)

| Hook | Description |
|---|---|
| `useAdapters()` | Lists available adapters |
| `useCreateAdapter()` | Creates a new tenant adapter |
| `useUpdateAdapter(id)` | Mutation: updates an existing tenant adapter |
| `useDeleteAdapter(id)` | Mutation: soft-deletes a tenant adapter |
| `useDetectAdapter()` | Mutation: detects adapter from file headers |
| `useUploadSmartImport()` | Mutation: uploads file and starts processing |
| `useStagedImport(id, params)` | Polling query (2s while PROCESSING or COMMITTING); `staleTime: 0` |
| `useUpdateImportRow(importId)` | Mutation: overrides row category/status/notes |
| `useCommitImport()` | Mutation: commits CONFIRMED rows |
| `useCancelImport()` | Mutation: cancels the import |
| `usePendingImports()` | Lists all READY imports with pending row counts (`staleTime: 30s`) |
| `useTenantSettings()` | Query: reads `autoPromoteThreshold` / `reviewThreshold` for the auto-confirm banner |

---

## Update Row Support

Update rows are staged rows that modify an existing transaction (identified by a non-null `updateTargetId`) rather than creating a new one. The backend computes a field-level diff during processing; the frontend surfaces these diffs in the review step.

See `docs/specs/backend/17-transaction-export-update.md` for the backend pipeline and `docs/specs/api/17-transaction-export-update-api.md` for the API layer.

### Quick Classify Behaviour

Update rows carry `classificationSource: 'USER_OVERRIDE'` and `confidence: 1.0`, so they never generate seeds. Update-only imports skip the Quick Classify step entirely. Mixed imports (creates + updates) may still trigger Quick Classify for the create rows.

### Review Step — Update Row Rendering (`TxDataRow`)

Update rows are visually distinct from create rows:

1. **Update indicator**: A `RefreshCw` icon (lucide-react) appears before the description, coloured `text-brand-primary`.
2. **Diff panel**: A collapsible section below the main row data shows field-level changes. Collapsed by default.
   - Changed fields display `old → new` with the old value in `text-muted-foreground line-through` and the new value in `text-foreground font-medium`.
   - Added tags: `+TagName` in `text-positive`. Removed tags: `-TagName` in `text-destructive`.
   - Amount changes use `text-positive` / `text-negative` colouring as appropriate.
3. **Account column**: Read-only for update rows — the transaction stays on its original account regardless of CSV content.
4. **No-change rows**: Rows with an empty diff are auto-skipped during processing (`status: 'SKIPPED'`, message "No changes detected") and collapsed in the review UI.
5. **Row controls**: Confirm/Skip and the category dropdown work identically to create rows. Changing the category recomputes the diff via `PUT /api/imports/:id/rows/:rowId`.

### Review Step — Import Summary Bar

The summary bar gains an "Updates" count badge using `brand-primary` tokens: `bg-brand-primary/10 text-brand-primary border-brand-primary/20`. The count is sourced from `import.updateCount`.

### Review Step — Status Filter

The status filter dropdown gains a new **"Updates"** option, filtering to rows where `updateTargetId` is non-null.

### Review Step — Grouped View

In grouped view, update rows are grouped alongside create rows under their target category. Group headers show combined counts: *"12 rows (3 updates)"*.

### Review Step — Commit Confirmation Dialog

The commit dialog now distinguishes creates from updates, listing both counts (e.g. "Create 85 new transactions" and "Update 45 existing transactions").

### Review Step — Deep Dive Drawer

When opening the Deep Dive drawer for an update row, an additional "Current Values" panel displays the existing transaction's field values for side-by-side comparison. The `updateDiff` is rendered inline with change arrows for each modified field.

### Done Step — Updated Counts

The done step now reports both created and updated counts, sourced from `commitResult.transactionCount` and `commitResult.updateCount`.

### Hooks — Changes for Update Support

| Hook | Change |
|------|--------|
| `useStagedImport(id)` | Response now includes `import.updateCount`; rows include `updateTargetId` and `updateDiff` |
| `useUpdateImportRow(importId)` | No change — handles update rows transparently |
| `useCommitImport()` | No change — commit result now includes `updateCount` |

### Design Tokens — Update Elements

| Element | Token |
|---------|-------|
| Update badge | `bg-brand-primary/10 text-brand-primary border-brand-primary/20` |
| Update icon (`RefreshCw`) | `text-brand-primary` |
| Diff old value | `text-muted-foreground line-through` |
| Diff new value | `text-foreground font-medium` |
| Added tag | `text-positive` |
| Removed tag | `text-destructive` |
| Amount increase | `text-positive` |
| Amount decrease | `text-negative` |


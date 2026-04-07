# 8. Plaid Integration UI

The frontend Plaid integration provides a seamless, secure, and fully-featured experience for connecting and managing bank accounts. It leverages the `react-plaid-link` SDK and a dedicated Accounts page with a master-detail layout.

---

## Page: Accounts (`/accounts`)

**File**: `src/pages/accounts.tsx`

The Accounts page is the primary surface for all bank connection management. It replaced the old Connections tab in Settings (which has been removed). The page uses a responsive master-detail layout.

```
┌─────────────────────────────────────────────────────────┐
│  Left Panel (~380px)    │  Right Panel (flex-1)         │
│  ─────────────────────  │  ──────────────────────────── │
│  [Search]               │  Account Name                 │
│                         │  Institution · Mask           │
│  ● Chase Checking  ✅   │  [USD] [Plaid Connected]  Edit│
│  ● Chase Savings   ✅   │  ──────────────────────────── │
│  ● Wells Fargo    ⚠️   │  CONNECTION HEALTH             │
│  ● BofA CC        ⬜   │  Status / Last Synced /...    │
│                         │  ──────────────────────────── │
│  [+ Add Account]        │  ACTIONS / RECONNECT          │
│                         │  ──────────────────────────── │
│                         │  SYNC LOGS                    │
└─────────────────────────────────────────────────────────┘
```

### Left Panel: `account-list-panel.tsx`

- Search input filters accounts by name or institution.
- Flat list of all accounts (Plaid-linked and manual).
- Each item: initials avatar, account name, institution, status badge.
- Clicking an item sets `selectedAccountId` and loads the detail panel.
- **Status badges** use design system tokens:
  - ✅ **Synced** — `bg-positive/10 text-positive border-positive/20`
  - ⚠️ **Action Required** — `bg-warning/10 text-warning border-warning/20`
  - 🔴 **Error** — `bg-destructive/10 text-destructive border-destructive/20`
  - ⬜ **Disconnected** — `bg-muted text-muted-foreground border-border`
  - ○ **Manual** — `bg-muted text-muted-foreground border-border`
- "Add Account" button at the bottom opens the Add Account modal.
- "Connect Bank" button opens Plaid Link for a new connection.

### Data Hook: `use-account-list.ts`

Merges `Account[]` from `useMetadata()` with `PlaidItem[]` from `api.getPlaidItems()` into a unified flat list (`EnrichedAccount[]`). Each enriched account includes:
- `plaidItem` — the linked `PlaidItem` (null for manual accounts)
- `status` — normalised: `'synced'` / `'action-required'` / `'disconnected'` / `'manual'`
- `healthColor` — design token name: `'positive'` / `'warning'` / `'destructive'` / `'muted'`
- `healthLabel` — human-readable status string
- `institution`, `mask`, `currencyCode`
- `historicalSyncComplete` — `boolean`, defaults to `true` for manual accounts (no historical sync concept). For Plaid accounts, reflects `PlaidItem.historicalSyncComplete`.
- `earliestTransactionDate` — `Date | null`, parsed from `PlaidItem.earliestTransactionDate` ISO string.

**Automatic polling**: The `usePlaidItems` query uses `refetchInterval` to poll every 60 seconds while any `ACTIVE` PlaidItem has `historicalSyncComplete === false`. Polling stops automatically once all items are complete.

**PlaidItem status → account status mapping:**

| PlaidItem status | Account status | healthColor |
|---|---|---|
| `ACTIVE` | `synced` | `positive` |
| `LOGIN_REQUIRED` | `action-required` | `warning` |
| `ERROR` / `PENDING_SELECTION` | `action-required` | `destructive` |
| `REVOKED` | `disconnected` | `muted` |
| No PlaidItem | `manual` | `muted` |

---

## Right Panel: `account-detail-panel.tsx`

Renders when an account is selected. Shows different content based on the account's Plaid connection state.

### Header
- Account name, institution, masked account number.
- Currency badge + "Plaid Connected" badge (when applicable).
- Edit button → opens the Account form dialog.

### Connection Health: `connection-health.tsx`

A card with metric rows. For Plaid accounts, shows up to six rows:
- **Status** — colored label (Healthy / Action Required / Disconnected / Manual)
- **Last Synced** — relative timestamp of the last successful sync (or "Never")
- **Next Sync** — "~6 hours"
- **History Range** — `{earliestTransactionDate} → Today` (only shown when `earliestTransactionDate` is set). Uses `format(date, 'MMM d, yyyy')` from `date-fns`. Includes a **Backfill Date Picker** button (CalendarDays icon, ghost variant) that opens a popover for fetching older transactions.
- **History Status** — badge indicating whether the full Plaid 2-year backfill is done:
  - **Complete** — `bg-positive/10 text-positive border-positive/20` (green badge)
  - **Syncing full history...** — `bg-warning/10 text-warning border-warning/20` (amber badge, shown while `historicalSyncComplete === false`)
- **Institution ID** — Plaid institution ID (shown when available)

When `earliestTransactionDate` is null but the account is active, a "Not yet synced" label is shown with the backfill date picker button.

For manual accounts, only Status and Connection ("Manual Entry") are shown.

#### Historical Backfill Date Picker

The backfill button opens a `Popover` containing:
- Header: "Fetch older transactions"
- `Calendar` component (mode `single`) with date constraints:
  - **Minimum date**: 2 years ago from today
  - **Maximum date**: current `earliestTransactionDate` (or today if null)
  - Disabled dates outside this range
- A "Fetch from {date}" confirm button (disabled until a date is selected)
- Uses `useFetchHistoricalTransactions()` mutation hook
- On success: shows toast "Historical backfill triggered", calls `onRefetch()` to refresh account data
- On error: shows toast with the error message
- The popover auto-closes on successful trigger

**Props**: `{ account: EnrichedAccount; onRefetch?: () => void }`

### Reconnect Card (shown only when `isPlaid && isDisconnected`)

Rendered when `PlaidItem.status === 'REVOKED'`. Gives the user a clear path to resume syncing:

```tsx
<Card>
  <CardContent>
    <span>Reconnect</span>
    <p>This bank connection was disconnected. Re-link to resume syncing transactions.</p>
    <PlaidConnect plaidItemId={plaidItemId} variant="default" onSuccess={() => onRefetch()}>
      <LinkIcon /> Reconnect Bank
    </PlaidConnect>
  </CardContent>
</Card>
```

`PlaidConnect` opens Plaid Link in update mode using the existing `accessToken` (which is still valid — see soft disconnect design). On success, `PATCH /api/plaid/items` sets status to `ACTIVE` and automatically triggers a sync.

### Actions Card (shown only when `isPlaid && !isDisconnected`)

Four action buttons for active/error-state Plaid accounts:

| Button | Hook | What it does |
|---|---|---|
| **Resync Now** | `useResyncPlaidItem()` | `POST /api/plaid/resync?id=` — triggers incremental sync immediately |
| **Rotate Token** | `useRotatePlaidToken()` | `POST /api/plaid/rotate-token?id=` — invalidates old token, stores new one |
| **Re-link Plaid** | `PlaidConnect` in update mode | Opens Plaid Link for re-authentication (use for LOGIN_REQUIRED) |
| **Pause Sync** | `useDisconnectPlaidItem()` | `POST /api/plaid/disconnect?id=` — soft disconnect (status → REVOKED) |

"Pause Sync" opens a confirmation dialog explaining that existing transactions are unaffected and the user can reconnect at any time.

### Security Card

Always visible. Shows AES-256-GCM encryption notice. For Plaid accounts, adds the token rotation note.

### Sync Logs: `sync-logs-table.tsx`

Shown when `isPlaid && !isDisconnected`. Displays the last 10 `PlaidSyncLog` records in a table:
- **Date** — formatted timestamp
- **Type** — `Initial Sync` / `Sync Update` / `Historical Backfill`
- **Status** — `Success` (green badge) / `Failed` (red badge)

Data fetched via `useSyncLogs(plaidItemId)` from `GET /api/plaid/sync-logs`.

---

## Component: `PlaidConnect`

**File**: `src/components/plaid-connect.tsx`

A wrapper around `react-plaid-link` that handles both new connections and re-authentication. Used in multiple places:

| Location | Mode | Purpose |
|---|---|---|
| Account list panel header | New connection | Link a new bank |
| Account detail Actions card | Update mode | Re-link / re-auth (Re-link Plaid button) |
| Account detail Reconnect card | Update mode | Reconnect after soft disconnect |

**Props**:
- `plaidItemId?: string` — when provided, opens Link in update mode (re-auth/reconnect)
- `variant`, `className` — passed to the underlying `Button`
- `onSuccess: () => void` — called after successful Link flow

**Success flow**:
1. Exchange `public_token` via `POST /api/plaid/exchange-public-token`
2. `PATCH /api/plaid/items?id={plaidItemId}` with `{ status: 'ACTIVE' }` (resets status, triggers sync)
3. Calls `onSuccess()` → parent refetches account list

---

## Sync Progress Modal: `account-selection-modal.tsx`

Opened after a new Plaid connection is established (post token exchange). Transitions through four phases: **setup → syncing → seed → done**.

### Phase 1 — Setup

A single consolidated screen that replaces the previous select, link, and rename phases. On open, Plaid accounts and existing manual accounts are fetched in parallel.

Each Plaid account is shown as a card with:
- **Checkbox** — select or deselect the account for syncing (all pre-checked by default)
- **Link dropdown** — "Create new account" (default) or link to an existing manual account (filtered by matching `currencyCode`, no `plaidAccountId`). Only shown when compatible manual accounts exist.
- **Name input** — editable account name, pre-filled with Plaid's account name. Only shown for "Create new" accounts. Hidden when linked (shows "Existing account name will be kept" instead).
- **Unchecked accounts** — dimmed; link dropdown and name input are hidden.

When the user clicks "Sync N Accounts":
- `accountMappings` (non-null entries only) are sent to `sync-accounts.js` so existing manual accounts are updated with Plaid fields instead of creating duplicates. This preserves the original `accountId` for hash-based dedup.
- `accountNames` (only custom-named accounts where the user changed the default) are sent so new accounts are created with the desired name.

Currency/country warnings are shown as `Alert` banners at the top of the screen.

> *Clock icon* Bliss will sync up to 2 years of history. Recent transactions appear in seconds; full history arrives within 24 hours.

### Phase 2 — Syncing

- Shows a step tracker (Accounts linked → Syncing transactions → AI classifying) and three live counters updated by polling `GET /api/plaid/transactions`:
  - **Auto-Promoted** (green) — transactions already committed to the Transaction table
  - **Pending Review** — `summary.classified + summary.seedHeld` combined. Both "fully classified awaiting review" and "held for Quick Seed interview" are surfaced as a single count since they both require the user's attention.
  - **Processing** — `summary.pending` (rows not yet classified, excluding seedHeld rows)
- The modal is **non-dismissible** during the syncing phase — clicking outside or pressing Escape does nothing.
- **Earliest date tracking**: Each poll cycle also fetches `GET /api/plaid/items` to read `earliestTransactionDate`. When available, the subtitle updates to show the date range: *"Importing your recent transactions from **Nov 28, 2024**. Your full 2-year history will continue to sync in the background."*
- Polling stops when processing has completed (stable `classified` count for 2 consecutive polls)
- Cache invalidation: `['account-list']`, `['plaid-items']`, `['metadata']` are invalidated at multiple lifecycle points (phase transitions, modal close, skip)

### Phase 2.5 — Quick Seed Interview

Shown after syncing completes **only when** `GET /api/plaid/transactions/seeds` returns one or more seed items. If there are no seeds (all transactions were auto-promoted or EXACT_MATCH hits), this phase is skipped and the modal proceeds directly to Done.

**The Quick Seed modal is non-dismissible** — clicking outside the modal or pressing Escape does nothing. The user must explicitly click "Skip" or "Confirm Categories" to advance. Long merchant names are truncated with ellipsis; the modal content is `overflow-hidden` to prevent horizontal scroll.

The Quick Seed modal presents each unique merchant/description group and asks the user to confirm or adjust the AI-suggested category:

```
┌─────────────────────────────────────────────────────────┐
│  Quick Classify                                          │
│  Help us learn your spending patterns (4 items)         │
├─────────────────────────────────────────────────────────┤
│  [X]  Netflix               [Streaming ▼]  AI 87%       │
│  [X]  Target                [Shopping ▼]   Match 91%    │
│  [X]  Vanguard Fund         [Investments▼] Global 84%   │
│  [X]  DUNKIN #1234          [Coffee ▼]     AI 73%       │
├─────────────────────────────────────────────────────────┤
│                          [Skip]  [Confirm Categories]   │
└─────────────────────────────────────────────────────────┘
```

**Badge labels** (based on `classificationSource`):
- `VECTOR_MATCH_GLOBAL` → **"Global"** badge
- `VECTOR_MATCH` → **"Match"** badge
- `LLM` → **"AI"** badge
- All badges include the confidence percentage (e.g. "AI 87%")

**X toggle**: Clicking X on a row excludes that merchant from the current batch. Excluded rows are **not** sent to the backend in the `seeds` array. The backend releases any remaining `seedHeld=true` rows for the `plaidItemId` via a bulk `updateMany` → these transactions appear in the standard pending review queue with their AI suggestion intact.

**"Skip for now"**: Skips the entire Quick Seed phase. Calls `POST /api/plaid/transactions/confirm-seeds` with `seeds: []` (empty array). The backend's release step sets all remaining `seedHeld=true` rows to `seedHeld: false, promotionStatus: 'CLASSIFIED'`, making them visible in the standard pending review queue with their AI suggestions intact.

**"Confirm Categories"**: Calls `POST /api/plaid/transactions/confirm-seeds` with the confirmed seed entries only. Excluded (X'd) rows are handled server-side.

### Phase 3 — Done

Summary card showing:
- **History Range** — `{earliestTransactionDate} → Today` (when available)
- Auto-Promoted count (green)
- Ready for Review count
- Skipped (duplicates) count (only shown when > 0)

Below the summary, a `brand-primary` info banner explains ongoing historical sync:

> *Clock icon* **Full history syncing in the background**
> Currently synced from **Nov 28, 2024**. Bliss will automatically sync up to 2 years of transaction history over the next 24 hours. New transactions will appear in your review queue as they arrive — no action needed.

Design tokens: `border-brand-primary/20 bg-brand-primary/5 text-brand-primary` — uses brand-primary for a calm, informational tone (not warning/amber).

Action buttons:
- "Close" → closes modal
- "Review Transactions" → `/agents/review?source=plaid&plaidItemId=<id>`

---

## Settings — Connections Tab Removed

The "Connections" tab that previously existed in `/settings` has been **removed**. All bank connection management now lives at `/accounts`. The remaining Settings tabs (General, Countries & Currencies, Banks, Plan, AI Classification) are unaffected.

---

## Transaction Views

The main transaction list at `/transactions` supports filtering by `Source`:
- `MANUAL` — manually entered
- `PLAID` — synced from Plaid and promoted
- `CSV` — imported via Smart Import

Plaid transactions are **not surfaced** in the main list until promoted via the Transaction Review page (`/agents/review`).

---

## Key Hooks

| Hook | File | Purpose |
|---|---|---|
| `useAccountList` | `hooks/use-account-list.ts` | Merges accounts + Plaid items into unified list |
| `useSyncLogs` | `hooks/use-sync-logs.ts` | Fetches `PlaidSyncLog` records for a PlaidItem |
| `useResyncPlaidItem` | `hooks/use-plaid-actions.ts` | Mutation: trigger manual resync |
| `useRotatePlaidToken` | `hooks/use-plaid-actions.ts` | Mutation: rotate access token |
| `useDisconnectPlaidItem` | `hooks/use-plaid-actions.ts` | Mutation: soft disconnect (Pause Sync) |
| `useFetchHistoricalTransactions` | `hooks/use-plaid-actions.ts` | Mutation: trigger historical backfill for a date range |
| `usePlaidItems` | `hooks/use-plaid-actions.ts` | Query: fetch all PlaidItems for tenant |
| `usePageVisible` | `hooks/use-page-visible.ts` | Returns `true` when the browser tab is visible (uses `document.visibilitychange`). Used to pause the 60-second polling interval when the tab is hidden, preventing unnecessary network requests. |

---

## Consent Expiration Alerts

The account list and detail panels surface `consentExpiration` from `PlaidItem` to warn users about expiring Plaid connections:

- **Warning banner** (amber): Shown when a Plaid connection's consent expires within the next 30 days. Prompts the user to re-link before access is lost.
- **Error banner** (red): Shown when consent has already expired. Instructs the user to reconnect the bank immediately.

Both banners appear in the `account-detail-panel.tsx` Connection Health section, using the standard design system tokens (`bg-warning/10 text-warning` and `bg-destructive/10 text-destructive`).

---

## Multi-Account Visual Grouping

Accounts in the left panel (`account-list-panel.tsx`) are grouped by institution when multiple accounts share the same Plaid connection. Each institution group has a collapsible section header showing the institution name and account count (e.g., "Chase -- 3 accounts"). Individual accounts within a group are indented below the header. Manual accounts (no Plaid connection) appear in a separate ungrouped section at the bottom.

---

---

## Admin Note — Hard Delete

A permanent delete endpoint exists at `DELETE /api/plaid/items/hard-delete` but is **admin-only** (protected by `X-Admin-Key` header, not exposed in the UI). It calls `plaidClient.itemRemove()`, unlinks all associated `Account` records, and cascades-deletes `PlaidTransaction` and `PlaidSyncLog` records. Promoted `Transaction` records are preserved. See `docs/specs/api/08-plaid-integration.md` §12 for full details.

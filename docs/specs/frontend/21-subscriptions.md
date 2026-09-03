# Subscriptions (frontend)

Route `/subscriptions` (`apps/web/src/pages/subscriptions.tsx`), nav item under
**REPORTS** in the sidebar (lucide `Repeat`, `t('nav.subscriptions')`).

## Page anatomy

- **Header** — title/subtitle + **Scan now** button. The button disables and
  shows `t('subscriptions.scanCooldownShort', { count })` while
  `refreshCooldownSeconds > 0`; a `429` from the API surfaces a cooldown toast.
- **Maintenance hint** — one line linking to Settings → Maintenance, shown only
  while `fullScanAt == null`.
- **Summary** — three cards: monthly total, annualized total, active count
  (all in `displayCurrency` via `formatCurrency`). A `fxExcluded` sub-line
  appears when `summary.fxUnavailableCount > 0`.
- **Filters** — status `Select` (Active / Lapsed / All) and category `Select`
  built from `response.categories` (`{ id, name, icon, count }`).
- **Rows** — one per merchant: category icon, `merchantLabel`, category name,
  occurrence count, cadence (click the dotted label to edit → inline `Select`,
  which calls `setCadence` and sets `userCadenceLocked`), native amount +
  `≈ display-currency` amount (or an `FX unavailable` note), next-expected
  relative date, status badge (`bg-positive/10` active, `bg-warning/10` lapsed).
- **Row actions** — `DETECTED`: **Confirm** + **Not a subscription**;
  `CONFIRMED`: **Remove**; `DISMISSED` tombstones (only visible under
  All): **Restore**.
- **Expand** — the chevron toggles a child list of the row's
  `contributingTransactionIds`, fetched via `api.getTransactions({ ids })`.
- **Empty state** — shown when `items.length === 0` (not a spinner, not a raw
  table). **Skeletons** while `isLoading`.

All colors use design tokens — no raw Tailwind color classes.

## Hooks — `apps/web/src/hooks/use-subscriptions.ts`

`useSubscriptions({ view, categoryId })`, `useConfirmSubscription`,
`useDismissSubscription`, `useRestoreSubscription`, `useSetSubscriptionCadence`,
`useRefreshSubscriptions`, `useFullHistoryScan`. Mutations invalidate
`['subscriptions']`.

## Categories page — "Recurring charge" toggle

`category-form.tsx` gains a `<Switch>` ("Recurring charge — show in the
Subscriptions view") in both the rename dialog (default categories) and the
full form (custom). Saves through the existing `api.updateCategory` /
`api.createCategory` with `isRecurring`. The update is in place — same category
`id`, transactions keep their `categoryId`.

## Settings → Maintenance

A "Subscriptions — full history scan" card: shows the last-run time
(`fullScanAt`) and a **Run full scan** button → `useFullHistoryScan()` →
`POST /api/subscriptions { action: 'fullScan' }`.

## i18n

`nav.subscriptions`, the `subscriptions.*` tree, and
`categoryFormPage.recurringLabel` / `recurringHint` are translated across all 5
locales (`en`, `es`, `fr`, `pt`, `it`). Cadence, status and "due" strings are
keyed; tests assert on keys with `t: (k) => k`.

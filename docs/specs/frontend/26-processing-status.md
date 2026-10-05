# 26. Processing Status — Chip, Banners and the Processing Tab (Frontend)

Task #100. API: [`docs/specs/api/26-activity-api.md`](../api/26-activity-api.md). Backend: [`docs/specs/backend/23-activity-tracking.md`](../backend/23-activity-tracking.md). User guide: [Why are my numbers updating?](../../guides/processing-status.md).

## 26.1. Data layer

| File | Role |
|---|---|
| `src/types/activity.ts` | `ActivityResponse` and friends (mirror of the API payload) |
| `src/lib/api.ts` | `api.getActivity()` → `GET /api/activity` |
| `src/hooks/use-activity.ts` | `useActivity()`, `useActivityStatus()` (chip), `useActivityWatcher()` (banners), pure `activityPollInterval()` / `buildActivityStatus()` |
| `src/lib/activity-pending.ts` | Optimistic "Queued" store: `markActivityPending(types)` |
| `src/lib/activity-format.ts` | Translated type/stage labels, "5 min ago", durations |
| `src/lib/providers.tsx` | `MutationCache({ onSuccess })` reads `mutation.meta.activity` → `markActivityPending`; `Register.mutationMeta` types `meta.activity` |

**Polling (PRD R4.4).** One shared query, `['activity']`. It polls every **5 s** while anything is in flight or optimistically queued, every **60 s** when idle, and on window focus. It **never** polls while the tab is hidden (`usePageVisible`). `retry: false`, `staleTime: 2 s`.

**Optimistic Queued (R4.3, AC1).** After a write that starts background work, its activity types show as `queued` immediately, and the `['activity']` query is invalidated so the first real poll happens now. Sources:

- `meta: { activity: [...] }` on mutations: import commit, Plaid resync / historical fetch / review update / retry / bulk promote, subscription scan / merge / unmerge / full scan, insight generation. `useTriggerRebuild` marks types by scope in `onSuccess`.
- Direct `markActivityPending` calls where the API is called without a mutation: the transaction form (create/update), transaction delete, manual price create/update/delete.

A pending entry clears once a poll completed ≥ 1.5 s after the write. That is long enough for routes that emit their event without awaiting it. It also clears after a 20 s grace at most. It is ignored once the server says status is unavailable.

## 26.2. Header chip — `components/processing/ActivityChip.tsx`

Mounted in `layout/Header.tsx` just before the notification bell, for every role.

| Chip state | When | Look |
|---|---|---|
| hidden | nothing in flight, or status unavailable (PRD OQ1) | — |
| Queued | only queued entries / optimistic writes | `bg-warning/10 text-warning border-warning/20`, clock icon |
| Updating | something running | same tokens, pulsing `bg-warning` dot |
| Taking longer than usual | something stalled | same tokens, hourglass |
| Update failed | a recent final failure of a type that hasn't completed since | `bg-destructive/10 text-destructive`, alert icon |

The state is the most severe across rows (failed > stalled > running > queued). The label hides below `sm`, leaving the icon and an `aria-label`. **INSIGHTS never appears on the chip** (PRD OQ2); it shows on the Insights banner and in the Processing tab.

Popover: one row per activity type (AC2), with the friendly name, stage, progress % and bar, "N jobs" when more than one, and a trigger badge for **AI agent** / **Nightly** / **Rebuild** / bank sync / import (none for the user's own change). A failed row shows its error code. A worker-offline notice appears when `workerOnline === false` and something is waiting. The footer reads "Last updated X ago" (latest `lastCompletedAt` of chip types).

## 26.3. Page banner — `components/processing/DataUpdatingBanner.tsx`

`<DataUpdatingBanner watch={types} invalidate={queryKeys} primary? />` uses `useActivityWatcher`:

- **Matches on `affects`** (D3), so a chain that will change the page shows from its first stage.
- Variants: `queued`, `running` ("Numbers on this page are being recalculated (Valuing assets, 40 %). They'll refresh automatically."), `stalled` and `failed` (`destructive`). It is `role="status"`, `aria-live="polite"` and non-blocking.
- **Refresh on settle (AC3):** when the last affecting entry finishes, or a watched type's `lastCompletedAt` moves between two polls (e.g. the 4 AM nightly revaluation, AC4), the page's `invalidate` keys are invalidated, so its numbers refresh without a reload and the banner disappears.
- Idle: a quiet "Updated X ago" from `lastCompletedAt[primary]` (default: the first watched type). Nothing renders when status is unavailable.

| Page | `watch` | Refreshed queries |
|---|---|---|
| Dashboard | ANALYTICS_UPDATE, PORTFOLIO_UPDATE | analytics, dashboard-metrics, portfolio-history/holdings/items |
| Reports → Expenses | ANALYTICS_UPDATE | analytics |
| Reports → Financial Summary | ANALYTICS_UPDATE | analytics |
| Reports → Tag Analytics | ANALYTICS_UPDATE (D1) | tag-analytics, analytics |
| Reports → Portfolio | PORTFOLIO_UPDATE, SECURITY_DATA | portfolio-holdings/history/items |
| Reports → Equity Analysis | PORTFOLIO_UPDATE, SECURITY_DATA | equity-analysis, portfolio-holdings |
| Reports → Passive Income | PORTFOLIO_UPDATE, SECURITY_DATA, ANALYTICS_UPDATE | passive-income |
| Subscriptions | SUBSCRIPTION_SCAN | subscriptions |
| Accounts | BANK_SYNC | account-list, plaid-items, accounts |
| Insights | INSIGHTS | insights |

## 26.4. Settings → Administration → Processing — `components/settings/processing-tab.tsx`

An admin-only tab (`value: "processing"`, icon `Activity`) in the Administration section, next to Maintenance and Integrations. It is hidden for members and viewers like the other admin tabs (AC7).

- **Live**: every in-flight entry with stage, progress bar, trigger and "running for / queued for X".
- **Last 24 hours**: **one row per run** (`runs` from the API). A run is every job of one edit, sync, import, rebuild or nightly run, so a single transaction is one row, not one per job. The title lists the activity types it touched; the subline shows the trigger, "finished X ago" and total duration ("< 1 s" under a second). A failed run shows its error code. Multi-step runs expand ("4 steps") to list each job's stage and duration. Against an older API without `runs`, each job is shown as its own run.
- **Recent rebuilds**: `RebuildHistoryList`, moved verbatim from Maintenance into `components/settings/rebuild-history-list.tsx` (labels in `lib/rebuild-labels.ts`). It still uses `GET /api/admin/rebuild` with 30-day retention (AC12).
- Banners for "status unavailable" and "worker offline".

**Deep link.** The settings page reads `?tab=<value>` (`useSearchParams`) and opens that tab if the role may see it, otherwise General. Changing tabs while a `tab` param is present keeps the URL in sync. The **Maintenance** tab no longer shows the history: a card links to it ("See progress" → `/settings?tab=processing`) and keeps the rebuild buttons and their lock state.

**Notification.** `PROCESSING_FAILED` renders with a translated label (`activity.notification.failed`, pluralised). Admins get a link to the Processing tab; other roles get a plain label (`href: null`). See [14-notification-center.md](14-notification-center.md).

## 26.5. i18n and tokens

All strings live under `activity.*` (types, stages, triggers, states, chip, banner, time, processing, notification, maintenance) plus `pages.settings.tabs.processing`, in en/es/fr/pt/it. `i18n/i18n-parity.test.ts` checks the same key set, non-empty values and identical `{{placeholders}}` in every locale. Only `warning`, `destructive`, `positive`, `brand-primary` and `muted` tokens are used (`components/processing/page-banners.test.ts` greps for raw Tailwind colours) (AC14).

## 26.6. Tests

| Test | Covers |
|---|---|
| `hooks/use-activity.test.tsx` | Poll interval rules; one row per type; optimistic Queued via `meta.activity` + immediate poll; settle / grace expiry; severity order; INSIGHTS off the chip; unavailable hides; watcher matches on `affects`, invalidates on settle and on a `lastCompletedAt` change (AC3, AC4); failure (AC8) |
| `components/processing/ActivityChip.test.tsx` | Hidden idle, Queued before first poll (AC1), each state's label and tokens, coalesced rows / trigger badges / progress (AC2, AC5), failure hint, worker offline |
| `components/processing/DataUpdatingBanner.test.tsx` | Watch list passed through, every variant, idle "Updated X ago", unavailable |
| `components/processing/page-banners.test.ts` | Each R5 page mounts the banner with its watch list; no raw colours |
| `components/settings/processing-tab.test.tsx` | Live / 24 h / rebuild history sections (moved Maintenance history tests) |
| `components/settings/maintenance-tab.test.tsx` | History gone, "See progress" link (AC12) |
| `pages/settings/settings-integrations-tab.test.tsx` | Processing tab for admins only (AC7), `?tab=processing` deep link |
| `components/notification-center.test.tsx` | `PROCESSING_FAILED` link vs label |
| `components/layout/Header.test.tsx` | Chip mounted |

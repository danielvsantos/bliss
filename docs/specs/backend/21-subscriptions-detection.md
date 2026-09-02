# Subscriptions & Recurring-Charge Detection

Backend detection engine behind the **Subscriptions** page. Deterministic (no
LLM). Reads committed `Transaction` rows (so CSV imports are covered exactly like
Plaid), decrypts descriptions in memory, groups by merchant, and persists one
`RecurringCharge` row per merchant per tenant.

## Data model

`RecurringCharge` (one row per `(tenantId, descriptionHash)`):

| Field | Notes |
|---|---|
| `descriptionHash` | SHA-256 of `normalizeMerchant(description)` — the merchant key. Not encrypted. |
| `merchantLabel` | AES-256-GCM encrypted human-readable name (most recent contributing description, ≤140 chars). |
| `categoryId` | Category of the most recent contributing transaction. |
| `state` | `DETECTED` \| `CONFIRMED` \| `DISMISSED`. User decisions; the detector never overwrites this. |
| `cadence` | `WEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `ANNUAL` \| null. |
| `userCadenceLocked` | `true` once the user edits the cadence — the detector then stops touching `cadence`. |
| `status` | `ACTIVE` \| `LAPSED` (`LAPSED` once no charge within `1.5 × cadence`). |
| `detectionReason` | `CATEGORY_SIGNAL` (Tier A) \| `INTERVAL_HEURISTIC` (Tier B) \| `USER_CONFIRMED`. |
| `amount` / `currency` | Median native amount + dominant currency across occurrences. |
| `occurrenceCount`, `firstChargedAt`, `lastChargedAt`, `nextExpectedAt` | `nextExpectedAt = lastChargedAt + one nominal cadence period`. Never fetched from a provider. |
| `contributingTransactionIds` | Up to 24 most-recent ids — powers the page's "expand row → underlying charges" view. |

Also: `Category.isRecurring BOOLEAN NOT NULL DEFAULT false`;
`Tenant.subscriptionsFullScanAt TIMESTAMP NULL`.

> **Why `Category.isRecurring` and not `processingHint = 'RECURRING'`** —
> `processingHint` is a single scalar that drives worker routing; a `'RECURRING'`
> value could not coexist with `'API_STOCK'` / `'AMORTIZING_LOAN'`. A boolean
> composes freely and stays user-toggleable. Nothing in the codebase ever read
> or wrote `processingHint = 'RECURRING'`, so there is no migration or cleanup.

## Detection tiers

### Tier A — category signal (primary)

`Transaction` where `debit != null`, in the lookback window, joined to a
`Category` with `isRecurring = true`. **One occurrence qualifies.**
`detectionReason = CATEGORY_SIGNAL`. Cadence is inferred if ≥2 occurrences,
otherwise `MONTHLY`. No amount-stability gate.

Default `isRecurring = true` categories (`apps/api/lib/defaultCategories.js`):
`SOFTWARE`, `CONTENT_AND_MEDIA`, `LOYALTY_PROGRAMS`, `HEALTH_INSURANCE`,
`HOME_INSURANCE`, `VEHICLE_INSURANCE`, `PET_INSURANCE`, `INTERNET`, `DATA_PLAN`.
Utilities/rent stay `false` (usage-variable) and rely on Tier B or a manual toggle.

### Tier B — bounded interval heuristic (fallback)

`Transaction` where `debit != null`, in the **6-month** window, in a
**non-recurring** category of type `Essentials | Lifestyle | Growth`.
Row-cap guarded: above `SUBSCRIPTION_TIER_B_ROW_CAP` (8000) Tier B is skipped
(logged) — the category signal still runs and "confirm from a transaction" is
still available.

A merchant qualifies when **all** hold:
* `occurrenceCount >= SUBSCRIPTION_MIN_OCCURRENCES` (3)
* gap coefficient-of-variation `<= SUBSCRIPTION_GAP_CV_MAX` (0.25)
* median inter-charge gap falls in the **WEEKLY or MONTHLY** bucket
* amounts stable within `max(5%, 2 units)` of the median

`detectionReason = INTERVAL_HEURISTIC`. Tier B never yields QUARTERLY/ANNUAL —
those only come from Tier A (which widens to 48 months on a full scan).

### Learning loop

Per run: `state = DISMISSED` merchants are skipped entirely (tombstone kept);
`state = CONFIRMED` merchants are force-included (`detectionReason =
USER_CONFIRMED`) even if the heuristic wouldn't pick them up.

## Execution

| Trigger | Job | Window |
|---|---|---|
| Nightly cron `0 5 * * *` UTC | `detect-all-tenants` → one `detect-tenant { mode: 'incremental' }` per tenant with transactions, 1s apart, `jobId: subs-<tenantId>-<date>` | Tier A 6mo, Tier B 6mo |
| "Scan now" on the Subscriptions page | `SUBSCRIPTION_DETECTION_REQUESTED { mode: 'incremental' }` event → `detect-tenant` | 6mo / 6mo. 30-min per-tenant cooldown enforced in the API. |
| "Full history scan" in Settings → Maintenance | `SUBSCRIPTION_DETECTION_REQUESTED { mode: 'full' }` → `detect-tenant`; stamps `Tenant.subscriptionsFullScanAt` | Tier A **48mo**, Tier B 6mo |

Queue: `subscription-detection` (concurrency 1, `lockDuration` 300s). Worker
`subscriptionDetectionWorker.js`. Failure reporting via `reportWorkerFailure`.

### Persistence (`detect-tenant`)

In one `prisma.$transaction`:
1. `upsert` per `(tenantId, descriptionHash)` — **create** with `state:
   'DETECTED'`; **update** merges detector fields only, never `state` /
   `userCadenceLocked`, and skips `cadence` when `userCadenceLocked`.
2. `deleteMany` `state = 'DETECTED'` rows whose hash is no longer detected.
   `CONFIRMED` / `DISMISSED` rows are retained forever.

Then, for `mode: 'full'`, `tenant.update({ subscriptionsFullScanAt: now })`.

Structured log line per run: `{ tenantId, mode, tierACount, tierBCount|skipped,
detected, active, lapsed, pruned, durationMs }`.

## Config (`config/classificationConfig.js`)

`SUBSCRIPTION_INCREMENTAL_MONTHS=6`, `SUBSCRIPTION_FULL_SCAN_MONTHS=48`,
`SUBSCRIPTION_TIER_B_ROW_CAP=8000`, `SUBSCRIPTION_MIN_OCCURRENCES=3`,
`SUBSCRIPTION_AMOUNT_DRIFT_PCT=0.05`, `SUBSCRIPTION_AMOUNT_DRIFT_ABS=2`,
`SUBSCRIPTION_GAP_CV_MAX=0.25`, `SUBSCRIPTION_LAPSE_MULTIPLIER=1.5`,
`SUBSCRIPTION_REFRESH_COOLDOWN_MIN=30`, `SUBSCRIPTION_MAX_CONTRIBUTING_IDS=24`,
`SUBSCRIPTION_CADENCE_BUCKETS` (day ranges per cadence).

## Merchant normalization

`normalizeMerchant()` (backend) and its ESM mirror
`apps/api/utils/merchantNormalize.js` **must stay byte-identical** — the API's
"confirm from a transaction" path hashes with the mirror and must land on the
same `descriptionHash` the worker computes. Normalization: lowercase, strip
accents, card masks (`xxxx1234`), dates, ref/store numbers, punctuation, and a
small stop-word list (`purchase`, `pos`, `card`, …).

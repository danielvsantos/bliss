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
**non-recurring** category of type `Essentials | Lifestyle | Growth | Ventures`.
`Ventures` is included so business subscriptions (Cloud & Hosting, SaaS & Tools,
Data & API Services, domains, recurring ad spend) are caught even before the
user flags those categories as recurring. Row-cap guarded: above
`SUBSCRIPTION_TIER_B_ROW_CAP` (8000) Tier B is skipped (logged) — the category
signal still runs and "confirm from a transaction" is still available.

A band qualifies when **all** hold:
* `occurrenceCount >= SUBSCRIPTION_MIN_OCCURRENCES` (3)
* gap coefficient-of-variation `<= SUBSCRIPTION_GAP_CV_MAX` (0.25)
* median inter-charge gap falls in the **WEEKLY or MONTHLY** bucket
* amounts stable within `max(5%, 2 units)` of the median

`detectionReason = INTERVAL_HEURISTIC`. Tier B never yields QUARTERLY/ANNUAL —
those only come from Tier A (which widens to 48 months on a full scan).

### Amount clustering (aggregator merchants)

Aggregator merchants — Apple App Store, Amazon, PayPal — bill many unrelated
things under one descriptor. Grouping by merchant alone then produces a single
row with a meaningless median amount and a dense (→ WEEKLY) date series.

So when a merchant has `>= SUBSCRIPTION_CLUSTER_MIN_GROUP` (6) occurrences whose
amounts fall into clearly separated bands (a break whenever the gap to the next
sorted amount exceeds `max(5%, 2 units)`), it is **split into one
`RecurringCharge` per band**:

* `descriptionHash` becomes `sha256("<merchantKey>#<rounded band median>")` —
  the median is rounded to a whole currency unit so sub-unit drift
  (`9.99 → 10.49`) keeps the same key.
* Each band still has to qualify on its own: **≥ 2 occurrences** for Tier A,
  the full gate for Tier B. A lone large App Store purchase in the mix forms no
  band → never becomes a subscription.
* A merchant with < 6 occurrences, or whose charges all land in one band, is
  **untouched** — its row keeps the bare `sha256("<merchantKey>")` hash.

The worker additionally **retires** (deletes, any state) the pre-clustering
bare-merchant row for merchants that split this run — including a `CONFIRMED` /
`DISMISSED` decision the user had applied to the old combined row. The merchant
re-appears as fresh `DETECTED` per-band rows for review. Non-aggregator
merchants and their decisions are never affected.

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
1. `deleteMany` `state = 'DETECTED'` rows whose hash is no longer detected
   (`CONFIRMED` / `DISMISSED` rows are retained).
2. `deleteMany` the `legacyRetireHashes` (bare-merchant hashes of merchants that
   split this run) — **any state**.
3. `upsert` per `(tenantId, descriptionHash)` — **create** with `state:
   'DETECTED'`; **update** merges detector fields only, never `state` /
   `userCadenceLocked`, and skips `cadence` when `userCadenceLocked`.

Then, for `mode: 'full'`, `tenant.update({ subscriptionsFullScanAt: now })`.

Structured log line per run: `{ tenantId, mode, tierACount, tierBCount|skipped,
detected, active, lapsed, pruned, retired, durationMs }`.

## API status recompute on cadence edit

`POST /api/subscriptions { action: 'setCadence' }` recomputes `status`
(`ACTIVE` / `LAPSED`) against the new cadence and `lastChargedAt` synchronously,
so correcting a wrongly-`MONTHLY` annual subscription un-lapses it immediately
instead of leaving it stuck in the Lapsed tab until the next detection run. The
formula mirrors the backend `computeStatus` (grace = `1.5 × cadence`).

## Config (`config/classificationConfig.js`)

`SUBSCRIPTION_INCREMENTAL_MONTHS=6`, `SUBSCRIPTION_FULL_SCAN_MONTHS=48`,
`SUBSCRIPTION_TIER_B_ROW_CAP=8000`, `SUBSCRIPTION_MIN_OCCURRENCES=3`,
`SUBSCRIPTION_AMOUNT_DRIFT_PCT=0.05`, `SUBSCRIPTION_AMOUNT_DRIFT_ABS=2`,
`SUBSCRIPTION_GAP_CV_MAX=0.25`, `SUBSCRIPTION_LAPSE_MULTIPLIER=1.5`,
`SUBSCRIPTION_REFRESH_COOLDOWN_MIN=30`, `SUBSCRIPTION_MAX_CONTRIBUTING_IDS=24`,
`SUBSCRIPTION_CLUSTER_MIN_GROUP=6`, `SUBSCRIPTION_CADENCE_BUCKETS` (day ranges
per cadence).

## Merchant normalization

`normalizeMerchant()` (backend) and its ESM mirror
`apps/api/utils/merchantNormalize.js` **must stay byte-identical** — the API's
"confirm from a transaction" path hashes with the mirror and must land on the
same `descriptionHash` the worker computes. A parallel unit test in each package
(`recurringDetectionService.test.js`, `merchantNormalize.test.ts`) runs the same
case set so drift fails a build.

Pipeline (order matters), lower-casing then:

1. Strip accents (NFKD + combining marks).
2. Strip a **payment-aggregator prefix** — allow-list only (`sq`, `sqc`, `tst`,
   `pp`, `pyp`, `ppl`, `dd`, `cke`, `clv`, `sp`, `py`, `paypal`, `pos`) followed
   by `*`. Deliberately not "any short token + `*`" — that would eat a merchant's
   own short name (`ADOBE *CREATIVE CLD`).
3. Strip the `www.` URL prefix, then common **TLDs** (`.com`, `.net`, `.io`,
   `.co`, `.app`, …) — `NETFLIX.COM` → `netflix`.
4. Strip masked card numbers (`xxxx1234`), dates (`04/12`, `2026-01-03`), and
   ref/store numbers (`#00421`, 3+ digit runs).
5. Collapse remaining punctuation to spaces.
6. Drop stop-words: `purchase`, `payment`, `pos`, `debit`, `card`, `recurring`,
   `autopay`, `ppd`, `id`, `ref`, `trace`, `www`, `http`, `https`.
7. Drop a trailing **corporate suffix** (`inc`, `llc`, `ltd`, `corp`, `gmbh`,
   `plc`, `lp`, `llp`) — `Adobe Systems Inc` → `adobe systems`.
8. Drop a trailing run of **1–2 digit sequence tokens** (`NETFLIX 4`,
   `SODEXO 07` → the merchant) — but keep the original key if this would empty
   it.

So `Netflix`, `NETFLIX.COM`, `SQ *NETFLIX`, `NETFLIX 08/15 POS DEBIT`,
`Netflix Inc`, `Netflix 4`, `NÉTFLIX` all → `netflix`.

**Known limits (left to Confirm/Dismiss and, later, manual merge):** it never
merges on a shared first word (`Netflix` ≠ `Netflix Games`), and it does not
resolve word-order changes, non-allow-listed aggregator prefixes
(`GOOGLE *YouTube`), abbreviations, or brand renames.

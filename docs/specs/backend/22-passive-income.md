# 22. Passive Income Projection (Backend & shared engine)

Task #77. Companion specs: `docs/specs/api/22-passive-income-api.md`, `docs/specs/frontend/22-passive-income.md`.

## 22.1. Overview

The projection is **computed on read** in the API layer; there is no new worker, queue or stored result. The backend's part is keeping the inputs fresh and never losing user-entered income terms:

| Piece | Where |
|-------|-------|
| Pure projection engine `project()` | `packages/shared/src/portfolio/index.js` (`@bliss/shared/portfolio`, dual ESM/CJS) |
| Last-12-month dividend history | `SecurityMaster.recentDividends`, written by `upsertFundamentals` (see `19-security-master.md`) |
| ETFs in the nightly refresh + `refresh-tenant-securities` | `securityMasterWorker.js`, `securityMasterService.js`, `queues/securityMasterQueue.js` |
| Income terms survive re-keying | `workers/portfolio-handlers/income-terms-preserver.js`, called from `process-portfolio-changes.js` |
| `newSecuritySymbols` on `PORTFOLIO_CHANGES_PROCESSED` | `process-portfolio-changes.js` (scoped and full paths) → `eventSchedulerWorker.js` |

## 22.2. Data model

`IncomeTerms` (migration `20260927120000_add_income_terms`, hand-written, apply with `migrate deploy`):

- Owner is **exactly one** of `assetId` (unique, 1:1 with `PortfolioItem`, `onDelete: Cascade`) or `categoryId` (income streams, N per `Category`), **or neither when detached** (`orphanedAt` set). Enforced by the raw CHECK `IncomeTerms_owner_check`.
- `incomeType`: `DIVIDEND`, `FIXED_COUPON`, `FLOATING_COUPON`, `INFLATION_LINKED`, `RENT`, `INTEREST`, `CUSTOM_YIELD`, `FIXED_AMOUNT` (streams only), `NONE`.
- Rates (`couponRate`, `spread`, `assumedIndexRate`, `yieldPct`, `apyPct`, `annualIndexationPct`) are stored as **percentages**.
- `SecurityMaster.recentDividends JSONB` — `[{ exDate, amount }]`, newest first.

Backend integration tests use `prisma db push`, so the CHECK constraint only exists where migrations are applied (API integration tests exercise it).

## 22.3. Detaching during rebuild (`process-portfolio-changes`, prune step)

Before `portfolioItem.deleteMany` on items that are no longer active, `pruneItemsPreservingTerms(prisma, orphans, newItems)` runs **in one interactive `$transaction`** with the delete:

1. Load orphans owning `IncomeTerms` or `DebtTerms`.
2. For each, candidates = items **created in this run** with the same `categoryId` **and** the same `accountId` (corrected description) **or** the same `symbol` (corrected account). A candidate claimed by two orphans is ambiguous for both.
3. Exactly one unambiguous candidate → both rows move (`assetId` updated). Otherwise → the `IncomeTerms` is **detached** (`assetId = null`, `orphanedAt = now`, `orphanedLabel = <old symbol>`); unmatched `DebtTerms` keep today's behaviour (cascade-deleted).
4. An orphan's `PortfolioItem.assetClassOverride` (#79) is matched the same way (an override alone also counts) and, on a move, copied to the new item unless it already has one. A detached orphan's override is lost with the item.
5. An orphan's **user-entered `ManualAssetValue` rows** (appraisals — every row whose `notes` is not `Auto-seeded from purchase transaction`) are matched the same way (they alone also count) and move with it. Auto-seeded rows are regenerated from the target's own transactions.
6. `IncomeTerms` and `DebtTerms` are 1:1 per asset: when the target **already owns** one, it keeps its own. The orphan's `IncomeTerms` are then detached and its `DebtTerms` cascade.

The same helper covers the early-return path (no investment/debt transactions left in scope) and the **scoped-update reconcile** (#86, below).

### Scoped updates: the item an edit moved away from (#86)

Editing a transaction can re-key it (e.g. a new description on a `category:description` asset such as Real Estate). The API upserts the new item and relinks the transaction *before* emitting, then sends `previousPortfolioItemId` on the old-state `MANUAL_TRANSACTION_MODIFIED` event; `eventSchedulerWorker` forwards it on the `process-portfolio-changes` job. `handleScopedUpdate` then reconciles that item (`reconcilePreviousItem`, tenant-scoped lookup):

| Old item after the edit | Outcome |
|---|---|
| Still has transactions | Investment state recalculated; included in `portfolioItemIds` |
| Empty, **clear replacement** (the transaction's current item: same category and same account or same symbol) | Pruned via `pruneItemsPreservingTerms(prisma, [old], [replacement])` — terms, override and user manual values move |
| Empty, no clear replacement (recategorised out of Investments/Debt, or into another category) | **Kept, never deleted**: stored state zeroed (`quantity`, `costBasis`, `currentValue`, USD fields…), included in `portfolioItemIds` so valuation clears its history. User data survives an edit the user may revert; a full rebuild prunes it later |

A transaction whose new category yields no asset key is unlinked (`portfolioItemId = null`), as a full rebuild would do. `recalculate-portfolio-item.js` (item with no transactions left) and user deletions are intentional removals and still cascade.

## 22.4. Trigger map

| Trigger | Behaviour |
|---------|-----------|
| `PORTFOLIO_CHANGES_PROCESSED` with `newSecuritySymbols.length > 0` | `refresh-tenant-securities { force: false }` (deduplicated per tenant). Enqueue failure is logged and never blocks the cash/analytics cascade. |
| `PORTFOLIO_CHANGES_PROCESSED` with `_rebuildMeta.rebuildType = 'full-portfolio'` | Same job with `_rebuildMeta` (30-day retention) → "Refresh securities data" step. |
| `MANUAL_REBUILD_REQUESTED` scope `security-data` | `refresh-tenant-securities { force: true, _rebuildMeta }`, 1-hour single-flight lock, released on completion. |
| Nightly 3 AM `refresh-all-fundamentals` | Stocks + ETFs; stores `recentDividends`. |
| Income terms / stream CRUD, attach/discard | **No job.** The projection is read-time only. |

## 22.5. Projection engine (`@bliss/shared/portfolio`)

`project({ assets, streams, asOf, horizon, displayCurrency })` — no I/O. Monetary inputs carry an `fxRate` (native → display) resolved by the caller.

- **Window**: the next `horizon` (12/24/36) full calendar months starting the 1st of the month after `asOf`; the current month belongs to actuals. Upcoming payments and next-payment dates also include the rest of the current month.
- **Automatic dividends (stocks/ETFs)**: each `{ exDate, amount }` in trusted `recentDividends` is replayed at `exDate + k years + 14 days` (`PAYMENT_LAG_DAYS`) for every k that lands in the window, × current quantity. Empty list → trusted zero (not missing). Untrusted (`null`) and no terms → **missing**.
- **Priority**: `NONE`/`isDistributing = false` → zero; `DIVIDEND` with `dividendPerUnit` → override (spread evenly by frequency, default quarterly, anchored on `anchorPaymentDate`, else last ex-date + 14 days, else month-end); `DIVIDEND` with `yieldPct` / `CUSTOM_YIELD` → % of current value; otherwise the replay.
- **Bonds**: `face × qty × rate / paymentsPerYear` up to and including maturity (anchor defaults to the maturity date). `FLOATING` rate = assumed index + spread; `INFLATION_LINKED` = real coupon + assumed inflation on unadjusted face. `AT_MATURITY` pays accrued (compounded) interest once. Principal is a separate ladder event, never income.
- **Rent**: net monthly rent, × (1 + indexation) per full year since `startDate`/anchor, stopping at `leaseEndDate`. **Cash interest**: `value × APY / 12` monthly. **Streams**: `amountPerPayment` at frequency (weekly…annual) from the anchor/`startDate` to `endDate`, indexed on `startDate` anniversaries, bucket `other`.
- **Statuses**: `MATURED_UNREDEEMED` (bond past maturity with quantity), `ENDED` (lease/stream/end date passed), `STALE_RATE` (floating/inflation terms not updated in 180 days).
- **Frequency label** for automatic dividends: 11–13 → MONTHLY, 4 → QUARTERLY, 2 → SEMIANNUAL, 1 → ANNUAL, 0 → NONE, else IRREGULAR.
- Also exports `classifyIncomeAsset`, `validateIncomeTerms`, `isStreamEligibleCategory`, `frequencyFromDividendCount`, `resolveIncomeSource` (#83) and the constants used by the API.

**Grouped view (#83).** Assets may carry `accountId`, `accountName`, `currency` and `securityName`; item rows echo them plus `quantity` and `currentValue`. `project()` then returns:

- `groups` = `groupItems(items, missing)` — one group per `assetClass + symbol` (cash therefore groups by currency: its symbol is `Cash EUR`). Missing holdings become `source: 'MISSING'` children with zero totals. Sums for totals, quantity and value; `rateOrYield` = next-12-month income ÷ value, except bonds/cash (shared rate, or `rateRange`); earliest next payment, latest end date; `incomeType`/`source`/`frequency` are the shared value or `MIXED`; status severity `MATURED_UNREDEEMED > STALE_RATE > ENDED > OK`, `statusCount` = children not OK. O(n).
- `upcomingPaymentsGrouped` — events merged by `(group, date, source)` over the **full** event list, then the top 10.
- `missingGroups` = `groupMissing(missing)`; `totals.coverage` counts groups (configured = no missing child), `totals.coverageByHolding` keeps the old count.

Monthly/yearly buckets, totals and the maturity ladder are unaffected (a regression test compares them with and without the grouping fields). #80's insights should read `groups` when describing holdings.

The backend loads it with `require('@bliss/shared/portfolio')` (CJS build); a unit test asserts the CJS and ESM builds return identical results (#80 depends on it).

## 22.6. Tests

- `income-terms-preserver.test.js` — single match by account / by symbol, ambiguous and shared candidates, category mismatch, DebtTerms unchanged, one transaction.
- `process-portfolio-changes.test.js` — move/detach on prune (incl. early-return path), `newSecuritySymbols` from full and scoped paths, `processingHint` stripped before `createMany`.
- `securityMasterService.test.js` / `securityMasterWorker.test.js` — ETF profile fields ignored, `recentDividends` stored/preserved, ETF selection, `/earnings` skipped, tenant refresh + lock release.
- `eventSchedulerWorker.test.js`, `rebuild.test.js`, `rebuildLock.test.js` — wiring and the `security-data` scope.
- `insightService.test.js` — PORTFOLIO-tier regression with ETF SecurityMaster rows.
- `shared/portfolioProjection.test.js` — CJS/ESM parity (incl. `groups`).

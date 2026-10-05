# 23. Processing Status — Activity Tracking (Backend)

Task #100. Companion specs: [`docs/specs/api/26-activity-api.md`](../api/26-activity-api.md) (read API, payload, MCP tool), [`docs/specs/frontend/26-processing-status.md`](../frontend/26-processing-status.md).

## 23.1. Overview

Every BullMQ job that works on a tenant's data leaves one small entry in a per-tenant Redis hash. The API reads that hash in one pipeline to answer "is my data still updating?". The tracker is **observational only**:

- no new queues, workers, crons or Postgres tables, and no Prisma call anywhere in the tracker;
- no change to job data semantics, dedup, debounce or scheduling;
- a tracker failure can never fail, retry or slow a job.

| File | Role |
|---|---|
| `packages/shared/src/activity/index.js` | `@bliss/shared/activity`: keys, constants, pure `summarize()` (shared with the API) |
| `apps/backend/src/config/activityMap.js` | `resolveActivity(queueName, job)` → `{ type, stage, affects, long, ephemeral }` or `null` (pure) |
| `apps/backend/src/utils/activityTracker.js` | The only writer: Lua write script, dedicated Redis connection, queue/worker hooks, progress reporter, trigger and error classification |

## 23.2. Redis model

| Key | Type | Content | Lifetime |
|---|---|---|---|
| `activity:v1:{tenantId}` | HASH | field `{queue}:{jobId}` → JSON entry | `EXPIRE 86400`, refreshed on every write |
| `activity:v1:{tenantId}:last` | HASH | activity type → ISO `lastCompletedAt` | no TTL |
| `bliss:runtime:worker` | STRING | existing worker heartbeat (`utils/workerHeartbeat.js`) | 180 s |

Entry fields (short keys): `t` type · `s` stage · `st` state (`queued`/`running`/`completed`/`failed`) · `p` progress 0–100 · `tr` trigger · `af` affects[] · `lg` long-running flag · `sa` enqueued at · `ra` running since · `ua` updated at · `fa` finished at (epoch ms) · `ec` errorCode · `at` attempts made. No descriptions, amounts, account numbers or error messages.

## 23.3. Write path

One Lua script (`defineCommand('activityWrite')`), so **one round-trip per write**. Modes:

| Mode | Behaviour |
|---|---|
| `queued` | HSETNX semantics. A deduplicated add returns the existing job id (`fullValuationDedupOpts`, `tenantSecuritiesDedupOpts`, fixed nightly `jobId`s), so it can never reset an active entry to queued. |
| `update` | `running` and progress. Never overwrites a finished entry, so a late progress write can't resurrect a completed job. |
| `terminal` | `completed` / `failed`, same guard. `completed` also stamps `:last[type]`. Once the hash has more than 200 fields, it prunes entries older than 24 h, then the oldest finished ones down to 500. In-flight entries are never capped away. |
| `drop` | `HDEL`: a debounced job removed before it ran, or a finished event hop |

**Write budget.** Per job: queued + running + terminal = 3 writes, plus progress throttled to one write per job per 2 s (100 % always passes). Writes use a **dedicated** ioredis connection (`maxRetriesPerRequest: 1`, `enableOfflineQueue: false`), so an unhealthy Redis drops status writes instead of queueing them behind BullMQ's `maxRetriesPerRequest: null` connection. Every public function is synchronous fire-and-forget: it catches internally and logs a throttled `warn`.

The tracker is disabled when `REDIS_URL` is unset, when `ACTIVITY_TRACKING=false`, and under `NODE_ENV=test` unless a test injects a client (`__setClientForTests`).

## 23.4. Hooks (central, not per handler)

| Hook | Where | Writes |
|---|---|---|
| `trackQueue(queue)` | once in each of the 9 `queues/*Queue.js` factories | `queued` on the Queue `'waiting'` event, which BullMQ emits for immediate, delayed and deduplicated adds in whichever process adds |
| `trackWorker(worker, queueName)` | once in each of the 9 worker start functions, next to `on('failed')` | `running` on `'active'`; progress on `'progress'` (so the existing `job.updateProgress` calls in smart import, commit, security master and analytics surface as-is); `completed` on `'completed'`; `failed` on `'failed'` **only when `isFinalAttempt(job)`** (the same rule as `reportWorkerFailure`, now exported from `workerFailureReporter.js`) |
| `createProgressReporter(job, queue)` | `portfolioWorker` attaches it as an own property `job.reportProgress` (like `job.heartbeat`, so it survives the `{ ...job, data }` spread); analytics creates one per job | throttled progress (done / total) |
| `dropEntry(tenantId, queue, jobId)` | `debounceService` after a successful `job.remove()` | `drop`: a removed job never completes and would otherwise age into "stalled" |
| `startInlineActivity({...})` | the nightly insight crons (`generate-all-insights`, `generate-portfolio-intel`), which work per tenant inline with no child job | `running` → `completed` / `failed`, labelled `nightly` |

New queues and workers **must** call `trackQueue` / `trackWorker` (and map their jobs in `activityMap.js`), or their work is invisible to users. `__tests__/unit/workers/activityTracking.workers.test.js` checks that every worker and queue is wired.

## 23.5. Job → activity map

| Queue / job (or event) | type | stage | affects |
|---|---|---|---|
| events: `MANUAL_TRANSACTION_*`, `TRANSACTIONS_IMPORTED`, `MANUAL_PORTFOLIO_PRICE_UPDATED`, `PORTFOLIO_STALE_REVALUATION`, `TENANT_CURRENCY_SETTINGS_UPDATED`, `PORTFOLIO_CHANGES_PROCESSED`, `PORTFOLIO_ITEMS_RECALCULATED`, `ANALYTICS_RECALCULATION_COMPLETE` | PORTFOLIO_UPDATE | scheduling | PORTFOLIO, ANALYTICS |
| events: `CASH_HOLDINGS_PROCESSED` | ANALYTICS_UPDATE | scheduling | ANALYTICS, PORTFOLIO |
| events: `TAG_ASSIGNMENT_MODIFIED`, `ANALYTICS_RECALCULATION_COMPLETE` of a `full-analytics` rebuild | ANALYTICS_UPDATE | scheduling | ANALYTICS |
| events: `PLAID_*` | BANK_SYNC | scheduling | BANK_SYNC, PORTFOLIO, ANALYTICS |
| events: `SMART_IMPORT_REQUESTED` / `SMART_IMPORT_COMMIT` | IMPORT | scheduling | IMPORT (+ PORTFOLIO, ANALYTICS on commit) |
| events: `SUBSCRIPTION_DETECTION_REQUESTED` | SUBSCRIPTION_SCAN | scheduling | SUBSCRIPTION_SCAN |
| events: `MANUAL_REBUILD_REQUESTED` | by `scope` | scheduling | by scope |
| portfolio: `process-portfolio-changes` | PORTFOLIO_UPDATE | recalculating_lots (long when unscoped) | PORTFOLIO, ANALYTICS |
| portfolio: `process-cash-holdings` | PORTFOLIO_UPDATE | updating_cash | PORTFOLIO, ANALYTICS |
| portfolio: `value-all-assets` (long), `value-portfolio-items`, `recalculate-portfolio-items` | PORTFOLIO_UPDATE | valuing_assets | PORTFOLIO |
| portfolio: `process-simple-liability`, `process-amortizing-loan` | PORTFOLIO_UPDATE | updating_debts | PORTFOLIO |
| analytics: all (full rebuild = long) | ANALYTICS_UPDATE | updating_analytics | ANALYTICS (+ PORTFOLIO when it chains into valuation) |
| plaid-sync / plaid-processing | BANK_SYNC | fetching_bank / classifying | BANK_SYNC, PORTFOLIO, ANALYTICS |
| smart-import: `process-smart-import` / `commit-smart-import` | IMPORT | processing_file / committing | IMPORT (+ PORTFOLIO, ANALYTICS on commit) |
| security-master: `refresh-tenant-securities`, `refresh-single-symbol` with tenantId (long) | SECURITY_DATA | refreshing_market_data | SECURITY_DATA, PORTFOLIO |
| subscription-detection: `detect-tenant` | SUBSCRIPTION_SCAN | scanning | SUBSCRIPTION_SCAN |
| insights: `generate-tenant-insights`, `generate-portfolio-intel` (long) | INSIGHTS | generating_insights | INSIGHTS |
| anything without `data.tenantId`, unknown names | untracked | | |

Event hops are **ephemeral**. An event's entry bridges two jobs and is dropped when the event completes, so it never shows in the 24 h history. The chain has **no gap** (AC1): each handler enqueues its follow-up job or event *inside* the processor, so the next entry is written as `queued` before the current job's `'completed'` fires. Both writes go over the same connection, in order.

`PLAID_SYNC_COMPLETE` jobs now carry `tenantId` (added by `plaidSyncWorker` and the processor's 60 s re-queue) so the classification stage can be attributed without a Postgres lookup.

Out of scope (deviation D2): tenant-less fan-outs (`revalue-all-tenants`, `detect-all-tenants`, the global 3 AM `refresh-all-fundamentals`, `refresh-all-from-table`). Their per-tenant children are tracked.

## 23.6. Trigger resolution and propagation

`resolveTrigger(queueName, job)`, checked in order:

1. `data._rebuildMeta` → `manual_rebuild`
2. `data._trigger` (propagated; must be a known trigger) → that value
3. a `nightly-` jobId prefix, or a `*cron*` source → `nightly`
4. the plaid queues, a `PLAID_*` event, or a Plaid source (`PLAID_*`, `INITIAL`, `SYNCED`, `MANUAL_RESYNC`, …) → `bank_sync`
5. the smart-import queue, a `SMART_IMPORT_*` event, or a `CSV` / `SMART_IMPORT` source → `import`
6. otherwise → `user_change`

`carryTrigger(queue, job)` returns `{ _trigger }` for `nightly` / `agent` / `bank_sync` / `import`, and `{}` otherwise. `eventSchedulerWorker` spreads it into every downstream job it adds, and every debounced job name has a `_trigger: mergers.keepPresent` merger. `process-portfolio-changes`, `cash-processor` (via the enriched scope) and `analyticsWorker` forward `_trigger` into the events they emit. The nightly fan-outs stamp `_trigger: 'nightly'` on their children (`revalue-all-tenants`, `detect-all-tenants`). The API stamps `_trigger: 'agent'` on events from integration keys (`utils/eventOrigin.js`). A missed site only degrades the label to `user_change`; processing is unaffected.

## 23.7. Progress

| Work | Progress |
|---|---|
| Full / account-scoped `process-portfolio-changes` | portfolio item groups processed / total |
| Valuation (`value-all-assets`, `value-portfolio-items`, …) | assets valued / total |
| Analytics | 0–80 % by transactions processed in Pass 2 (per scope for multi-scope jobs), then 80–100 % by cache-write batches. The single `updateProgress(50)` became `updateProgress(80)` at the calculation / write boundary, which the rebuild history also reads |
| Smart import, commit, security master | their existing `job.updateProgress` calls, surfaced via the worker `'progress'` event |

## 23.8. Tests

| Test | Covers |
|---|---|
| `unit/utils/activityTracker.test.js` | Every hook's writes; final-attempt-only failure and no message stored (AC8); 2 s throttle with 100 % always written; monotonic progress (AC5); sync throw / rejected write / broken client swallowed with only `warn` (AC10); trigger and error classification; inline activity |
| `unit/config/activityMap.test.js` | The map above: untracked jobs, `affects`, long flags, D1 |
| `unit/workers/activityTracking.workers.test.js` | **Per worker** (all 9): wired once, and every lifecycle event survives a throwing tracker Redis (sync and async) with `reportWorkerFailure` still called (AC10); every queue factory tracked once |
| `unit/workers/portfolioWorker.test.js` | Nightly children carry `_trigger: 'nightly'` (AC4); `reportProgress` survives the spread; cash scope forwards `_trigger` |
| `integration/activityChain.test.js` | Real Redis + BullMQ, throwaway prefix. Lua guards and pruning; event → portfolio → event → analytics with **no gap** and a clean finish (AC1); ten debounced edits → one coalesced row and no orphans (AC2); a dedup add never resets a running entry; a failure shows only after the final attempt with its code (AC8) |

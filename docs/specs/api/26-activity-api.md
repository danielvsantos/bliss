# 26. Processing Status — `GET /api/activity` (API)

Task #100. Companion specs: [backend tracking](../backend/23-activity-tracking.md), [frontend chip, banners and Processing tab](../frontend/26-processing-status.md). OpenAPI: [`docs/openapi/activity.yaml`](../../openapi/activity.yaml). User guide: [Why are my numbers updating?](../../guides/processing-status.md).

## 26.1. Overview

Almost every write in Bliss starts background work: a transaction edit runs portfolio (cash or lots) → analytics → valuation, and a bank sync or an import commit runs a longer chain. Nightly crons do the same. `GET /api/activity` tells the caller what is **queued, running, stalled or failed** for their tenant, the last 24 h of finished work, and when each kind of work last completed.

It is a pure read of a per-tenant hash in **Redis**, written by the backend activity tracker. There is no Postgres table, no migration, no new job and no BullMQ scan.

| Property | Value |
|---|---|
| Auth | `withAuth`, **all roles** (admin, member, viewer), and integration keys (read-only included) |
| Methods | `GET` only (`405` otherwise, `Allow: GET`) |
| Rate limit | `rateLimiters.activity`: 600 / 5 min per IP (5 s polling × 2 tabs + the MCP tool) |
| Caching | `Cache-Control: no-store` |
| Cost | **One Redis pipeline** (`HGETALL`, `HGETALL`, `EXISTS`). No Prisma, no BullMQ (enforced by `__tests__/unit/api/activity.test.ts`) |
| Integration matrix | `'activity.js': RW_ALL(['GET'])` |
| MCP | wrapped by the read tool `get_processing_status` (§26.6) |

## 26.2. Files

| File | Role |
|---|---|
| `apps/api/pages/api/activity.js` | Route: rate limit, CORS, method check, `readActivity(req.user.tenantId)` |
| `apps/api/utils/activityStore.js` | `readActivity(tenantId)`: the pipeline + `summarize()`; fail-soft. `countFailuresSince()` for the notification signal |
| `apps/api/utils/redisClient.js` | Shared lazy ioredis client (`maxRetriesPerRequest: 1`, 2 s `commandTimeout`); `null` without `REDIS_URL` |
| `packages/shared/src/activity/index.js` | `@bliss/shared/activity`: keys, types, stages, triggers, stall thresholds and the pure `summarize()` shared with the backend writer |
| `apps/api/utils/eventOrigin.js` | `eventOrigin(req)` → `{ _trigger: 'agent' }` for integration-key requests, spread into `produceEvent` payloads |

## 26.3. Response

```json
{
  "available": true,
  "workerOnline": true,
  "serverTime": "2026-10-04T12:00:00.000Z",
  "summary": {
    "PORTFOLIO_UPDATE": {
      "state": "running", "stage": "valuing_assets", "progress": 40, "count": 3,
      "trigger": "user_change", "startedAt": "…", "affects": ["PORTFOLIO_UPDATE", "ANALYTICS_UPDATE"]
    }
  },
  "inFlight": [
    {
      "id": "portfolio:123", "type": "PORTFOLIO_UPDATE", "stage": "valuing_assets", "state": "running",
      "progress": 40, "trigger": "nightly", "affects": ["PORTFOLIO_UPDATE"],
      "enqueuedAt": "…", "startedAt": "…", "updatedAt": "…"
    }
  ],
  "recent": [
    {
      "id": "analytics:9", "type": "ANALYTICS_UPDATE", "stage": "updating_analytics", "state": "failed",
      "errorCode": "P2034", "trigger": "user_change", "enqueuedAt": "…", "startedAt": "…",
      "finishedAt": "…", "durationMs": 5120
    }
  ],
  "lastCompletedAt": { "PORTFOLIO_UPDATE": "…", "ANALYTICS_UPDATE": "…" }
}
```

| Field | Meaning |
|---|---|
| `available` | `false` when `REDIS_URL` is unset or Redis errors. All other fields are then empty. **Unknown is not idle**: clients must not show "up to date". |
| `workerOnline` | Whether the backend worker heartbeat key (`bliss:runtime:worker`, 180 s TTL) exists. `false` + something queued = the worker is down, not slow. `null` when unavailable. |
| `summary` | **One row per activity type** (the header chip, AC2). `state` is the most severe among that type's entries (`failed` > `stalled` > `running` > `queued`). `stage`, `progress` and `trigger` come from the longest-running entry. `count` is the number of in-flight entries. `affects` is the union. A **final failure** keeps its type in `summary` as `failed` (with `errorCode`, `count: 0` if nothing else is in flight) until that type completes again, for at most 60 min. |
| `inFlight` | Every queued / running / stalled entry, longest-running first. |
| `recent` | Finished entries (`completed` / `failed`) of the last 24 h, newest first, capped at 200. `errorCode` on failures only. |
| `lastCompletedAt` | Last completion per type. It has no TTL in Redis, so it survives the 24 h window. It is missing after a Redis flush, and is then hidden, never recomputed from Postgres. |

Types, stages and triggers are **keys**; clients translate them.

**Activity types:** `PORTFOLIO_UPDATE`, `ANALYTICS_UPDATE`, `BANK_SYNC`, `IMPORT`, `SECURITY_DATA`, `SUBSCRIPTION_SCAN`, `INSIGHTS`. There is no `TAG_ANALYTICS_UPDATE` (deviation D1): tag analytics are written by the same analytics job.

**Stages:** `scheduling`, `recalculating_lots`, `updating_cash`, `valuing_assets`, `updating_debts`, `updating_analytics`, `fetching_bank`, `classifying`, `processing_file`, `committing`, `refreshing_market_data`, `scanning`, `generating_insights`.

**Triggers:** `user_change`, `bank_sync`, `import`, `nightly`, `manual_rebuild`, `agent`.

**`affects` vs `type`** (deviation D3). `type` is the current stage of the chain, which is what the chip groups by. `affects` lists every type the chain will still touch, which is what page banners match on. The first hop of a simple transaction edit is `process-cash-holdings` (type `PORTFOLIO_UPDATE`), but it `affects` `ANALYTICS_UPDATE` too, so the Expenses page shows its banner from the very first stage.

## 26.4. Stalled (display-only)

`stalled` is never written; `summarize()` derives it on read. An in-flight entry is stalled when `now − updatedAt` exceeds:

- **60 min** for long work: full portfolio rebuild (`process-portfolio-changes` without scope), `value-all-assets`, `full-rebuild-analytics`, `SECURITY_DATA`, insights, and anything still `queued` (analytics and plaid-processor run at concurrency 1 globally, so a tenant's job can wait behind the nightly fan-out);
- **30 min** otherwise.

Nothing in the system acts on `stalled` (AC9). Non-terminal entries older than 24 h are treated as orphans and dropped from the response.

## 26.5. Tenant isolation

Keys are `activity:v1:{tenantId}` and `activity:v1:{tenantId}:last`; the route only ever reads `req.user.tenantId`'s keys (AC6, `__tests__/integration/api/activity.test.ts`). Entries carry no PII and no amounts: type, stage, state, progress, trigger, timestamps and a stable `errorCode` (a Prisma `P####` code, a Node `E…` code, `LLM_TIMEOUT`, `TIMEOUT` or `INTERNAL`). The error message is never stored.

## 26.6. MCP tool `get_processing_status`

A read tool (all keys) in `lib/mcp/tools/analytics.js` wrapping `GET /api/activity`. It returns the REST payload shaped by `shapeProcessingStatus()`: `available`, `workerOnline`, `serverTime`, `summary`, `inFlight`, `lastCompletedAt`, `recent` trimmed to 20, plus `settled` (`available && inFlight.length === 0`). The MCP server instructions tell agents to poll it after a write until nothing in flight `affects` what they changed. This replaces the old "allow a minute" guess. AC13 is checked by `__tests__/integration/api/activity.test.ts`: a read-only key gets the same shaped payload from REST and from the tool over the real MCP server.

Tool counts after #100: 22 read / 41 total. Coverage: 88 reachable, 68 wrapped, 20 excluded.

## 26.7. Agent-triggered work

Writes made with an integration key (directly or through MCP) spread `eventOrigin(req)` (`{ _trigger: 'agent' }`) into their `produceEvent` payloads. The call sites are transactions (create/update/delete, tags), Plaid review (promote, bulk promote, retry), import commit, manual asset values and subscriptions (scan / merge / unmerge). The backend forwards `_trigger` through the whole chain, so household members see that work labelled **AI agent** (PRD OQ3). Session requests add nothing.

## 26.8. `PROCESSING_FAILED` notification

`GET /api/notifications/summary` adds `readActivity()` to its parallel reads. This adds no Prisma. It emits `PROCESSING_FAILED` with the number of `recent` failures whose `finishedAt` is after the user's `lastNotificationSeenAt`. Admins get `href: '/settings?tab=processing'`; other roles get `href: null` (label only). See [14-notification-center.md](14-notification-center.md).

## 26.9. Tests

| Test | Covers |
|---|---|
| `unit/api/activity.test.ts` | One pipeline, zero Prisma / BullMQ access and no such imports (AC11); viewer 200 (AC7); 405; Redis error / missing → `available: false`; worker offline |
| `unit/services/activity-summarize.test.ts` | `summarize()`: coalescing (AC2), both stall clocks (AC9), expiry, ordering, cap, failure colouring (AC8), malformed input |
| `unit/api/notifications-summary.test.ts` | `PROCESSING_FAILED` count since last seen, admin link vs label only, unavailable → nothing |
| `unit/utils/eventOrigin.test.ts` | Agent label for integration keys only |
| `unit/mcp/tools.test.ts` | Tool wraps `GET /api/activity`, trims `recent`, `settled` |
| `integration/api/activity.test.ts` | Real tenants and keys (Postgres). Redis is real when `REDIS_URL` is set, in-memory otherwise (CI's API job has no Redis). Covers AC6, AC7 and AC13 |
| `unit/middleware/integrationRouteMatrix.test.ts`, `unit/mcp/coverage.test.ts` | Route classified; operation wrapped |

**p95 (AC11).** The route is a single Redis pipeline with no database work, so its latency is Redis round-trip time. Measure it on a deployment during a full rebuild (`hey -n 200 -H "Cookie: token=…" $API/api/activity`, or the equivalent) and check p95 < 200 ms.

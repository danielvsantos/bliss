# Subscriptions API

`apps/api/pages/api/subscriptions.js` — JWT auth (`withAuth`), `cors`,
`rateLimiters.subscriptions` (120 / 5 min). All queries scoped to
`req.user.tenantId`. Detection is never computed inline — it runs in the backend
`subscriptionDetectionWorker`.

## `GET /api/subscriptions`

Query params:

| Param | Values | Default | Effect |
|---|---|---|---|
| `view` | `active` \| `lapsed` \| `all` | `active` | `active`/`lapsed` exclude `DISMISSED` tombstones **and merge tombstones** (`mergedIntoHash != null`) and filter on `status`; `all` includes both so the UI can offer "Restore" / "Unmerge". |
| `categoryId` | integer | — | Restricts to one category. |

Response:

```jsonc
{
  "displayCurrency": "USD",              // Tenant.portfolioCurrency
  "lastDetectedAt": "2026-09-01T05:00:00Z",
  "fullScanAt": null,                    // Tenant.subscriptionsFullScanAt — null → page shows the Maintenance hint
  "refreshCooldownSeconds": 0,           // >0 → "Scan now" is on cooldown
  "categories": [ { "id": 10, "name": "Content & Media", "icon": "📺", "count": 4 } ],
  "mergeCandidates": [   // every non-dismissed, non-merged row for the tenant — view/filter-independent, so a Lapsed row can merge into a hidden Active one
    { "descriptionHash": "…", "merchantLabel": "Orange", "status": "ACTIVE", "state": "CONFIRMED", "categoryIcon": "📱", "categoryName": "Telecom" }
  ],
  "summary": {
    "monthlyTotal": 42.97,              // Σ monthly-normalized amount, ACTIVE + non-dismissed + fx-available only
    "annualTotal": 515.64,             // monthlyTotal × 12
    "activeCount": 6,
    "lapsedCount": 1,
    "fxUnavailableCount": 1
  },
  "items": [ {
    "id": 1, "descriptionHash": "…", "merchantLabel": "Netflix",
    "categoryId": 10, "category": { "id": 10, "name": "Content & Media", "icon": "📺" },
    "state": "DETECTED", "cadence": "MONTHLY", "userCadenceLocked": false,
    "userLabelLocked": false,           // true → user renamed it; detector no longer overwrites merchantLabel
    "status": "ACTIVE", "detectionReason": "CATEGORY_SIGNAL",
    "amount": 15.99, "currency": "USD",
    "amountInDisplayCurrency": 15.99,   // convertCurrency(amount, currency, displayCurrency, lastChargedAt); null → fxUnavailable
    "monthlyAmount": 15.99,             // amountInDisplayCurrency × cadence factor
    "fxUnavailable": false,
    "occurrenceCount": 3,
    "firstChargedAt": "…", "lastChargedAt": "…", "nextExpectedAt": "…", "lastDetectedAt": "…",
    "contributingTransactionIds": [ 812, 799, 781 ],
    "mergedIntoHash": null,             // non-null → this row is a merge tombstone (only surfaces under view=all)
    "mergedIntoLabel": null             // merchantLabel of the merge target, resolved for the UI
  } ]
}
```

Monthly-normalization factors: `WEEKLY × 52/12`, `MONTHLY × 1`,
`QUARTERLY × 1/3`, `ANNUAL × 1/12`.

## `POST /api/subscriptions`

Body `{ action, … }`:

| `action` | Body | Result |
|---|---|---|
| `confirm` | `{ descriptionHash }` | `updateMany` → `state: CONFIRMED`, `detectionReason: USER_CONFIRMED`. `200`; `404` if no match. |
| `confirm` | `{ transactionId }` | Derives hash/category/label/amount/currency/dates from the transaction (tenant-scoped) and `upsert`s a provisional row (`cadence: MONTHLY`, `occurrenceCount: 1`, `state: CONFIRMED`). `201` on create, `200` on update. |
| `dismiss` | `{ descriptionHash }` | `updateMany` → `state: DISMISSED`, detector fields cleared. `200`; `404` if no match. |
| `restore` | `{ descriptionHash }` | `deleteMany` the `DISMISSED` tombstone. `200`; `404` if none. |
| `setCadence` | `{ descriptionHash, cadence }` | `update` → `cadence`, `userCadenceLocked: true`, `nextExpectedAt` recomputed, `status` recomputed. `400` on bad enum; `404` if no row. |
| `rename` | `{ descriptionHash, merchantLabel }` | `update` → `merchantLabel` (trimmed, non-empty, ≤140), `userLabelLocked: true`. `400` on empty/too-long; `404` if no row. |
| `merge` | `{ sourceDescriptionHash, targetDescriptionHash }` | `update` source → `mergedIntoHash = targetDescriptionHash` (the target row's own hash — **not** a label hash, so a renamed target still resolves), `nextExpectedAt: null`, `contributingTransactionIds: []`; then `produceEvent(…, mode: 'incremental', source: 'merge')` (no cooldown). `200 { merged: 1, mergedIntoHash }`. `400` on same hash / source already merged / target itself merged; `404` if either row is missing. |
| `unmerge` | `{ descriptionHash }` | `updateMany where { …, mergedIntoHash: { not: null } }` → `mergedIntoHash: null`; then rescan (`source: 'unmerge'`). `200 { unmerged: n }`; `404` if the row is not merged. |
| `refresh` | — | 30-min per-tenant cooldown → `429 { retryAfter }`, else `produceEvent(SUBSCRIPTION_DETECTION_REQUESTED, mode: 'incremental')` → `202`. |
| `fullScan` | — | `produceEvent(SUBSCRIPTION_DETECTION_REQUESTED, mode: 'full')` → `202`. No cooldown (called from the admin Maintenance tab). |

## Related change: `GET /api/transactions?ids=`

`transactions/index.js` now accepts `ids` (comma-separated integers) →
`where.id IN (...)`. Used by the Subscriptions page to load a row's
`contributingTransactionIds` for the expand view. Tenant scoping unchanged.

# 14. Notification Center (API)

This document covers the Notification Center API endpoint. The notification system is lightweight by design — it has no dedicated notification table. Instead, it aggregates signals from existing tables in parallel to produce a unified summary with read-tracking.

---

## 14.1. Overview

The Notification Center provides two operations:

| Method | Purpose |
|--------|---------|
| `GET /api/notifications/summary` | Aggregate signal types from 7 parallel queries |
| `PUT /api/notifications/summary` | Mark notifications as seen (update `lastNotificationSeenAt`) |

Both endpoints require JWT authentication via `withAuth` and are protected by rate limiting and CORS middleware.

---

## 14.2. `pages/api/notifications/summary.js` — Notification Summary Endpoint

### `GET /api/notifications/summary`

Runs 7 parallel queries against existing tables to produce a unified signal summary.

**Response** (`200 OK`):

```json
{
  "totalUnseen": 5,
  "lastSeenAt": "2026-03-05T14:30:00.000Z",
  "signals": [
    {
      "type": "PENDING_REVIEW",
      "count": 3,
      "label": "3 transactions awaiting review",
      "href": "/agents/review",
      "severity": "info",
      "isNew": true
    },
    {
      "type": "PLAID_ACTION_REQUIRED",
      "count": 1,
      "label": "Chase needs attention",
      "href": "/accounts",
      "severity": "warning",
      "isNew": true
    },
    {
      "type": "ONBOARDING_INCOMPLETE",
      "count": 3,
      "label": "3 setup steps remaining",
      "href": "/",
      "severity": "info",
      "isNew": false
    },
    {
      "type": "NEW_INSIGHTS",
      "count": 7,
      "label": "7 new insights available",
      "href": "/agents/insight",
      "severity": "positive",
      "isNew": true
    }
  ]
}
```

### `PUT /api/notifications/summary`

Marks all notifications as seen by updating `User.lastNotificationSeenAt` to the current timestamp.

**Request Body:** None required.

**Response** (`200 OK`):

```json
{
  "success": true
}
```

---

## 14.3. Signal Types

Signal types are aggregated from existing tables via 7 parallel queries (including `accountCount`, `hasTransaction`, and `tenant.onboardingCompletedAt` lookups). No dedicated notification storage is needed.

| Signal Type | Source Table(s) | Count Logic | `isNew` Logic |
|-------------|----------------|-------------|---------------|
| `PENDING_REVIEW` | `PlaidTransaction` (status `CLASSIFIED`) + `StagedImportRow` (status `PENDING`) | Sum of both counts | Always `true` (actionable) |
| `PLAID_ACTION_REQUIRED` | `PlaidItem` (status `LOGIN_REQUIRED` or `ERROR`) | One signal PER PlaidItem (each with `count: 1` and institution-specific label, e.g., "Chase needs attention") | Always `true` (actionable) |
| `ONBOARDING_INCOMPLETE` | `Tenant.onboardingCompletedAt` + account/transaction counts | Number of incomplete onboarding steps | Always `false` (not urgent) |
| `NEW_INSIGHTS` | `Insight` (not dismissed) | Count of insights created after `lastSeenAt` | `true` if any `createdAt > lastSeenAt` |

All queries are scoped to `req.user.tenantId`. Signals with `count: 0` are omitted from the response (guarded by `if (count > 0)`).

---

## 14.4. `totalUnseen` Calculation

```
totalUnseen = sum of count for each signal where isNew === true
```

This value drives the badge display in the frontend notification center. Signals where `isNew` is `false` (e.g., onboarding) don't contribute to the unseen count.

---

## 14.5. Signal Response Shape

Each signal in the `signals` array has the following structure:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Signal identifier (e.g., `PENDING_REVIEW`) |
| `count` | integer | Number of items in this signal |
| `label` | string | Dynamic human-readable description with count (e.g., "3 transactions awaiting review") |
| `href` | string | Frontend route to navigate to (e.g., `/agents/review`) |
| `severity` | string | Color hint for the frontend (`positive`, `warning`, `info`) |
| `isNew` | boolean | Whether this signal contributes to `totalUnseen` |

Signals with `count: 0` are omitted entirely from the response (guarded by `if (count > 0)`). The frontend handles a variable-length signal array.

---

## 14.6. Data Model Changes

The notification center required one addition to the existing schema:

```prisma
model User {
  // ... existing fields ...
  lastNotificationSeenAt DateTime?
}
```

No new tables were created. The `lastNotificationSeenAt` timestamp is used to determine which insights are "new" (created after the user last opened the notification popover).

---

## 14.7. Future Enhancements

- **Push notifications** — Web Push API integration for real-time browser notifications on critical signals.
- **Email digests** — Daily/weekly email summary of pending signals and new insights.
- **Notification preferences** — Per-signal-type mute/unmute (e.g., disable onboarding signal).
- **Notification history persistence** — Dedicated `Notification` table for historical tracking and audit.
- **WebSocket real-time updates** — Replace polling with WebSocket push for instant updates.
- **Sound/vibration on critical alerts** — Audio or haptic feedback for high-severity signals.

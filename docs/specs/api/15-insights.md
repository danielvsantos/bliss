# 15. Insights API

This document covers the Insights endpoints exposed by the finance-api. The backend service generates insights via Google Gemini (see `bliss-backend-service/specs/15-insights-engine.md`); the finance-api serves, filters, and manages their dismissal state.

---

## 15.1. Overview

The Insights API provides three operations on the `Insight` model:

| Method | Purpose |
|--------|---------|
| `GET /api/insights` | Fetch insights with filtering by lens, severity, and dismissal state |
| `PUT /api/insights` | Dismiss or restore a specific insight |
| `POST /api/insights` | Trigger on-demand insight generation (fire-and-forget to backend) |

All endpoints require JWT authentication via `withAuth` and are protected by rate limiting and CORS middleware.

---

## 15.2. `pages/api/insights.js` — Insights Endpoint

### `GET /api/insights`

Fetches the tenant's insights with optional filtering and pagination.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer | 20 | Max results per page |
| `offset` | integer | 0 | Pagination offset |
| `lens` | string | — | Filter by lens (e.g., `SPENDING_VELOCITY`) |
| `severity` | string | — | Filter by severity (e.g., `WARNING`) |
| `includeDismissed` | boolean | `false` | Include dismissed insights |

**Response** (`200 OK`):

```json
{
  "insights": [
    {
      "id": "cm1abc2d3e4f5g6h7i8j9k0l",
      "batchId": "a1b2c3d4-...",
      "date": "2026-03-06T00:00:00.000Z",
      "lens": "SPENDING_VELOCITY",
      "title": "Dining spend rose 23%",
      "body": "Your dining category increased from R$620 to R$763...",
      "severity": "WARNING",
      "priority": 78,
      "metadata": { "dataPoints": { ... } },
      "dismissed": false,
      "createdAt": "2026-03-06T06:12:34.000Z"
    }
  ],
  "total": 7,
  "latestBatchDate": "2026-03-06T06:12:34.000Z"
}
```

**Ordering:** `priority DESC`, `createdAt DESC`.

**`latestBatchDate`:** The `date` field of the most recent insight for this tenant. Used by the frontend to detect when a new batch has been generated during polling.

### `PUT /api/insights`

Dismisses or restores a specific insight.

**Request Body:**

```json
{
  "insightId": "cm1abc2d3e4f5g6h7i8j9k0l",
  "dismissed": true
}
```

**Validation:**
- `insightId` is required and must be a valid string.
- Ownership check: the query filters by both `id` and `tenantId`, so a non-owned insight returns `404` (not found rather than forbidden).

**Response** (`200 OK`): The updated `Insight` object.

### `POST /api/insights`

Triggers on-demand insight generation for the authenticated user's tenant.

**Request Body:** None required.

**Behaviour:**
1. Extracts `tenantId` from `req.user`.
2. Sends a fire-and-forget HTTP POST to `BACKEND_URL/api/insights/generate` with `{ tenantId }` and `BACKEND_API_KEY` in the `x-api-key` header.
3. Returns `202 Accepted` immediately, regardless of whether the backend accepted the job.

**Response** (`202 Accepted`):

```json
{
  "message": "Insight generation started"
}
```

**Error Handling:** If the backend POST fails, the error is logged but not propagated to the client (fire-and-forget pattern).

---

## 15.3. Data Model

### `Insight`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `String` | CUID primary key (`@default(cuid())`) |
| `tenantId` | `String` | FK to Tenant |
| `batchId` | `String` | Groups insights from the same generation run |
| `date` | `DateTime` | Generation date |
| `lens` | `String` | Analysis lens identifier |
| `title` | `String` | Short title (max 255 chars) |
| `body` | `String` | Detailed observation (2-4 sentences) |
| `severity` | `String` | `POSITIVE` / `INFO` / `WARNING` / `CRITICAL` |
| `priority` | `Int` | 1-100 (higher = more important) |
| `dataHash` | `String?` | SHA-256 hash for deduplication (nullable) |
| `metadata` | `Json?` | Lens-specific data points |
| `dismissed` | `Boolean` | Default `false`. User-toggleable. |
| `createdAt` | `DateTime` | Creation timestamp |

**Relation:** `Tenant.insights Insight[]` — one-to-many.

**Indexes:** `[tenantId, date]`, `[tenantId, batchId]`.

---

## 15.4. Backend Communication

The `POST /api/insights` handler communicates with the backend service:

```
Finance API                          Backend Service
    │                                      │
    │  POST /api/insights/generate         │
    │  x-api-key: BACKEND_API_KEY          │
    │  { tenantId }                        │
    ├─────────────────────────────────────►│
    │                                      │ enqueue job
    │◄─────────────────────────────────────┤ 202 Accepted
    │                                      │
    │  return 202 to client                │
```

Environment variables used:
- `BACKEND_URL` — Base URL of the backend service (e.g., `http://localhost:3001`)
- `BACKEND_API_KEY` — Shared API key for service-to-service auth

---

## 15.5. Future Enhancements

- **Lens-specific endpoints** — Dedicated endpoints for detailed drill-down into a specific lens.
- **Insight history/changelog** — Track how insights evolve over time across batches.
- **Scheduled report emails** — Daily/weekly insight digest sent to the user's email.
- **Insight sharing** — Export individual insights or the full batch as image/PDF.
- **Granular notification triggers** — Webhook or push notification when specific severity levels are generated.

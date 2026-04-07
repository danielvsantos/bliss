# 14. Notification Center (Frontend)

This document covers the Notification Center UI component, its hooks, and its integration with the application header. The notification center aggregates actionable signals from the API (see `docs/specs/api/14-notification-center.md`) and presents them in a popover.

---

## 14.1. Overview

The Notification Center is a popover-based component embedded in the app header. It displays a summary of actionable items across the platform — pending transaction reviews, Plaid connection issues, onboarding progress, and new AI insights — with navigation links to the relevant pages.

---

## 14.2. Notification Center Component (`src/components/notification-center.tsx`)

### Placement

Positioned in the `Header` component between the search input and the user avatar.

### Layout

```
  Header
  ┌─────────────────────────────────────────────┐
  │   [Search...]          [🔔•]  [Avatar ▼]    │
  └─────────────────────────────────────────────┘
                             │
                             ▼ (popover on click)
  ┌─────────────────────────────────────────────┐
  │  Notifications                              │
  │                                             │
  │  📋  3 transactions awaiting review    →    │
  │  ⚠️  1 bank connection needs attention →    │
  │  ✨  7 new insights available          →    │
  │  ☑️  1 setup steps remaining           →    │
  │                                             │
  └─────────────────────────────────────────────┘
```

### Behaviour

1. **Bell icon** — `Bell` from `lucide-react`. Shows a red dot badge when `totalUnseen > 0`.
2. **Popover open** — On open, immediately calls `markNotificationsSeen()` to reset the badge.
3. **Signal list** — Each signal rendered with an icon, count, label, severity color, and a navigation link.
4. **Empty state** — When all signals have `count: 0`, displays "All caught up" message.
5. **Navigation** — Clicking a signal navigates to the relevant page (e.g., `/agents/review`, `/accounts`).

---

## 14.3. Signal Icons & Colors

Each signal type maps to a specific icon and severity color:

| Signal Type | Icon | Color (Design Token) |
|-------------|------|---------------------|
| `PENDING_REVIEW` | `ClipboardCheck` | `warning` |
| `PLAID_ACTION_REQUIRED` | `AlertTriangle` | `warning` |
| `ONBOARDING_INCOMPLETE` | `ListChecks` | `brand-primary` |
| `NEW_INSIGHTS` | `Sparkles` | `positive` |

All icons are from `lucide-react`. Colors follow the design system tokens defined in `src/index.css`.

---

## 14.4. Polling Strategy

| Setting | Value |
|---------|-------|
| `refetchInterval` | `60_000ms` (60 seconds) |
| `staleTime` | `30_000ms` (30 seconds) |
| `refetchOnWindowFocus` | `true` (automatic) |
| Tab visibility | Polling only active when tab is visible (`usePageVisible()` hook) |

The 60-second polling ensures the badge updates reasonably quickly when new events occur (e.g., Plaid sync completes, new insights generated) without creating excessive API load. Polling pauses when the browser tab is not visible to avoid unnecessary network requests.

---

## 14.5. Hooks

Defined in `src/hooks/use-notifications.ts`:

| Hook | Query Key | Description |
|------|-----------|-------------|
| `useNotificationSummary()` | `['notification-summary']` | Fetches `GET /api/notifications/summary`. 60s polling (paused when tab hidden via `usePageVisible()`), 30s stale time. Returns `{ totalUnseen, lastSeenAt, signals[] }`. |
| `useMarkNotificationsSeen()` | — | Mutation: `PUT /api/notifications/summary`. Invalidates `notification-summary` query on success. |

---

## 14.6. API Client Methods

Defined in `src/lib/api.ts`:

| Method | HTTP | Endpoint | Description |
|--------|------|----------|-------------|
| `getNotificationSummary()` | `GET` | `/api/notifications/summary` | Fetch signal summary |
| `markNotificationsSeen()` | `PUT` | `/api/notifications/summary` | Update `lastNotificationSeenAt` |

---

## 14.7. Relationship with Dashboard Action Registry

The notification center and the dashboard action registry (`specs/16-dashboard-actions.md`) compute overlapping signals from different layers:

| Notification Signal | Dashboard `UserSignals` Equivalent |
|---------------------|-----------------------------------|
| `PENDING_REVIEW` | `totalReviewCount > 0` |
| `PLAID_ACTION_REQUIRED` | `hasActionRequired` |
| `ONBOARDING_INCOMPLETE` | `!onboardingComplete` |
| `NEW_INSIGHTS` | `insightCount > 0` |

**Architecture decision**: The notification center stays server-side (7 parallel DB queries via `/api/notifications/summary`; includes accountCount, hasTransaction, and tenant onboardingCompletedAt lookups) because it's always visible in the header and needs to be lightweight. The dashboard's `useUserSignals()` hook evaluates the same signals client-side from data already being fetched for dashboard rendering. React Query deduplicates the underlying HTTP calls.

**Future unification**: If needed, the notification center could adopt `useUserSignals()` for client-side rendering while keeping the server-side endpoint for badge count polling.

---

## 14.8. Future Enhancements

- **Notification preferences panel** — Per-signal-type mute/unmute settings accessible from the popover.
- **Sound/vibration on critical alerts** — Audio or haptic feedback when a critical signal appears.
- **Group similar notifications** — Collapse multiple signals of the same type into a single expandable row.
- **Notification history drawer** — Full-page or drawer view showing historical notification state.
- **Badge count in browser tab title** — Show `(3) Bliss` in the browser tab when there are unseen notifications.

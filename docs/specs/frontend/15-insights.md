# 15. Insights (Frontend)

This document covers the Insights page and its supporting hooks and components. Insights are AI-generated financial observations produced by the backend Gemini pipeline (see `docs/specs/backend/15-insights-engine.md`) and served via the finance-api (see `docs/specs/api/15-insights.md`).

---

## 15.1. Overview

The Insights feature provides a card-based feed of AI-generated financial observations with severity filtering, dismissal, and on-demand generation. The page replaces the previous coming-soon stub at the `/agents/insight` route.

---

## 15.2. Insights Page (`src/pages/insights.tsx`)

### Route

`/agents/insight` — registered in `src/routes.tsx`.

### Layout

```
┌──────────────────────────────────────────────────────┐
│  Insights                    [Generate New Insights] │
│                                                      │
│  [All] [POSITIVE] [INFO] [WARNING] [CRITICAL]        │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ ▌ SPENDING_VELOCITY                          │    │
│  │  Dining spend rose 23%                       │    │
│  │  Your dining category increased from R$620   │    │
│  │  to R$763 this month...              [×]     │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ ▌ SAVINGS_RATE                               │    │
│  │  Savings rate trending upward                │    │
│  │  Your savings rate improved from 12% to      │    │
│  │  18% over the past three months...   [×]     │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Behaviour

1. **Filter chips**: `All | POSITIVE | INFO | WARNING | CRITICAL`. Selecting a chip filters the visible insights by severity. `All` shows everything.
2. **Generate button**: Triggers `POST /api/insights` and begins polling for new results.
3. **Generation polling**: 10-second interval. Stops when `latestBatchDate` changes (new batch detected) or after 30 seconds (timeout). Shows a loading indicator during generation.
4. **Empty state**: When no insights exist, displays a message encouraging the user to generate their first batch.
5. **Animations**: Framer Motion `AnimatePresence` for card enter/exit transitions.

---

## 15.3. InsightCard Component

Each insight is rendered as a card with:

| Element | Detail |
|---------|--------|
| **Left border** | Colored by severity using design tokens |
| **Lens badge** | Pill showing the lens name (e.g., `SPENDING_VELOCITY`) |
| **Title** | Bold, max 8 words |
| **Body** | 2-4 sentences with specific numbers |
| **Dismiss button** | `×` icon to dismiss/restore the insight |

### Severity Color Mapping (Design Tokens)

| Severity | Border / Text Color |
|----------|-------------------|
| `POSITIVE` | `positive` (green) |
| `INFO` | `brand-primary` |
| `WARNING` | `warning` (amber) |
| `CRITICAL` | `destructive` |

Cards are ordered by `priority` DESC, then `createdAt` DESC.

---

## 15.4. Hooks

| Hook | Query Key | Description |
|------|-----------|-------------|
| `useInsights(params?)` | `['insights', params]` | Fetches insights with optional filters. 5-minute stale time. Returns `{ insights, total, latestBatchDate }`. |
| `useDismissInsight()` | — | Mutation: PUT to dismiss/restore. Optimistic update. Invalidates `insights` query on settle. |
| `useGenerateInsights()` | — | Mutation: POST to trigger generation. Invalidates `insights` query after 5-second delay (async job). |

All hooks are defined in `src/hooks/use-insights.ts`.

---

## 15.5. API Client Methods

Defined in `src/lib/api.ts`:

| Method | HTTP | Endpoint | Description |
|--------|------|----------|-------------|
| `getInsights(params?)` | `GET` | `/api/insights` | Fetch insights with query params |
| `dismissInsight(id, dismissed)` | `PUT` | `/api/insights` | Dismiss or restore an insight |
| `generateInsights()` | `POST` | `/api/insights` | Trigger on-demand generation |

---

## 15.6. Future Enhancements

- **Insight detail modal** — Full analysis view with data visualization charts for the relevant metrics.
- **Export as PDF** — Download the current insight batch as a formatted PDF report.
- **Trend comparison view** — Side-by-side comparison of insights from this week vs. last week.
- **Insight-to-transaction drill-down** — Navigate from an insight to the transactions that contributed to it.
- **Dashboard widget** — Show the top-priority insight on the main dashboard as a card.

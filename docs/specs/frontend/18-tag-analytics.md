# 18. Tag Analytics Page

This document specifies the frontend Tag Analytics page, which provides per-tag financial analysis with single-tag breakdown and side-by-side comparison mode.

## 18.1. Overview

The Tag Analytics page allows users to analyze spending associated with individual tags across all accounts, currencies, and categories. The primary use case is trip/project tracking — e.g., a "Japan 2026" tag that collects flights, hotels, food, and souvenirs across multiple accounts and currencies.

- **Route**: `/reports/tags`
- **File**: `src/pages/reports/tags.tsx`
- **Navigation**: "Tag Analytics" link in the Reports section of the Sidebar (uses `Hash` icon from lucide-react)

## 18.2. Data Flow

### 18.2.1. API Client

- **File**: `src/lib/api.ts`
- **Method**: `api.getTagAnalytics(params)` — serializes query params and calls `GET /api/analytics/tags`

### 18.2.2. Hook

- **File**: `src/hooks/use-tag-analytics.ts`
- **Hook**: `useTagAnalytics(filters)` — React Query wrapper
- **Query key**: `['tag-analytics', filters]`
- **Enabled**: when `tagIds.length > 0 && !!view`

### 18.2.3. Types

- **File**: `src/types/api.ts`

```typescript
export type TagAnalyticsResponse = {
  currency: string;
  view: string;
  tags: Record<string, Record<string, Record<string, Record<string, Record<string, {
    credit: number; debit: number; balance: number
  }>>>>>;
};
```

Nesting: `tagId → timePeriod → type → group → categoryName → values`

## 18.3. Page Structure

```
TagAnalyticsPage
  +-- Header: Title + back link
  +-- Filters bar:
  |     +-- TagSelector (primary tag)
  |     +-- Compare toggle button
  |     +-- TagSelector (compare tag, shown in compare mode)
  |     +-- Currency selector (USD, EUR, GBP, BRL, JPY)
  |     +-- Date range badge (shown when tag has startDate/endDate)
  +-- Empty state (when no tag selected)
  +-- Summary Cards (3-col grid, or 2-col in compare mode):
  |     +-- Total Spend card (sum of abs(balance) across all categories)
  |     +-- Budget Progress card (if tag.budget set, non-compare mode)
  |     +-- Top Category card (highest abs(balance) category, non-compare mode)
  |     +-- Compare Total Spend card (compare mode)
  +-- Charts (2-col grid):
  |     +-- Category Breakdown: Recharts PieChart (top 7 + Other)
  |     +-- Monthly Timeline: Recharts BarChart (balance per month)
  +-- Compare mode: Side-by-side timelines
```

## 18.4. Data Processing

### 18.4.1. processTagData

Aggregates per-category balance across all time periods:

1. Iterates all `timeMap → typeMap → groupMap → categoryMap` levels
2. Sums `Math.abs(values.balance)` per category name
3. Sorts by value descending
4. Takes top 7, groups remainder into "Other"
5. Returns `{ categories, total, highestCategory }`

### 18.4.2. processMonthlyTimeline

Aggregates balance per time period:

1. Iterates all nesting levels, sums `values.balance` per time key
2. Returns sorted array of `{ month, balance }`

### 18.4.3. Financial Values

All displays use `balance` (credit - debit), not raw debit:
- **Pie chart**: `Math.abs(balance)` per category
- **Summary total**: sum of `Math.abs(balance)`
- **Bar chart**: raw `balance` (can be negative)
- **Budget progress**: `total / tag.budget * 100`

## 18.5. Components

### 18.5.1. TagSelector

Reusable tag picker using shadcn/ui `Command` + `Popover`:
- Searchable list of all tags from `useTags()`
- Shows tag emoji and name
- Shows budget badge when tag has a budget
- Click to select/deselect

### 18.5.2. Compare Mode

Toggle via the Compare button:
- Shows a second `TagSelector` (filtered to exclude primary tag)
- Summary cards switch from 3-col to 2-col (Total Spend for each tag)
- Pie charts shown side by side
- Monthly timelines shown side by side (primary: brand-deep fill, compare: positive fill)

## 18.6. Date Range Behavior

- When the selected tag has `startDate` and `endDate`, the page automatically sends `startMonth`/`endMonth` to the API and shows a date range badge
- When the tag has no dates, the API is called without date filters (returns all data for that tag)
- No manual date range picker — dates are derived from the tag

## 18.7. Styling

- **Animations**: framer-motion `fadeUp` with staggered delays (0.1s increments)
- **Chart colors**: Hardcoded palette array (8 colors from design tokens)
- **Pie labels**: Custom label renderer, hidden for slices < 5%
- **Legend**: 2-column grid below pie chart with color dots and percentages
- **Tooltip**: Card-styled with design token border/background

## 18.8. Route and Navigation

- **File**: `src/routes.tsx` — `/reports/tags` route added
- **File**: `src/components/layout/Sidebar.tsx` — "Tag Analytics" link in Reports section with `Hash` icon

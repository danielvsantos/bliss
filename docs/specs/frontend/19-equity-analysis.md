# 19. Equity Analysis Page

This document specifies the frontend page for stock portfolio analysis.

## 19.1. Overview

- **Route**: `/reports/equity-analysis`
- **File**: `src/pages/reports/equity-analysis.tsx`
- **Navigation**: "Equity Analysis" link in the Reports section of the sidebar (PieChart icon from lucide-react)

## 19.2. Data Flow

| Layer | File | Description |
|-------|------|-------------|
| Types | `src/types/equity-analysis.ts` | `EquityAnalysisResponse`, `EquityAnalysisSummary`, `EquityGroup`, `EquityHolding` |
| API client | `src/lib/api.ts` | `api.getEquityAnalysis({ groupBy })` |
| Hook | `src/hooks/use-equity-analysis.ts` | `useEquityAnalysis(groupBy)` — React Query wrapper |

## 19.3. Page Structure

```
┌─────────────────────────────────────────────────┐
│  ← Back    📈 Equity Analysis                   │
├─────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐│
│  │Total Val │ │Holdings  │ │Avg P/E   │ │Yield ││
│  │$150,000  │ │12        │ │22.5      │ │1.80% ││
│  └──────────┘ └──────────┘ └──────────┘ └──────┘│
│                                                  │
│  Group by: [Sector] [Industry] [Country]         │
│                                                  │
│  ┌────────────────────┐ ┌───────────────────────┐│
│  │   Allocation Donut │ │  Top 10 Holdings Bar  ││
│  │                    │ │                       ││
│  └────────────────────┘ └───────────────────────┘│
│                                                  │
│  ┌──────────────────────────────────────────────┐│
│  │  Symbol  Name  Sector  P/E  Yield  Weight... ││
│  │  AAPL    Apple Tech    28.5  0.55%  5.8%     ││
│  │  ...                                         ││
│  └──────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

## 19.4. Summary Cards

Four-card grid layout:

| Card | Value | Format |
|------|-------|--------|
| Total Equity Value | `summary.totalEquityValue` | Currency (portfolio currency) |
| Holdings | `summary.holdingsCount` | Integer |
| Avg P/E Ratio | `summary.weightedPeRatio` | 1 decimal place, or "—" if null |
| Avg Dividend Yield | `summary.weightedDividendYield` | Percentage (2 decimal places), or "—" if null |

## 19.5. Grouping Selector

Pill-toggle with three options: Sector (default), Industry, Country. Triggers a new API call via the `groupBy` parameter on the React Query hook.

## 19.6. Allocation Chart

- Recharts `PieChart` with inner radius (donut style)
- Uses `dataviz-1` through `dataviz-8` palette colors: `['#6D657A', '#2E8B57', '#E09F12', '#3A3542', '#3A8A8F', '#B8AEC8', '#7E7590', '#9A95A4']`
- Custom labels showing group name and percentage (hidden for slices < 4%)
- Custom tooltip showing value and percentage

## 19.7. Top Holdings Chart

- Recharts horizontal `BarChart`
- Top 10 holdings sorted by weight
- Y-axis: ticker symbol, X-axis: weight percentage
- Same dataviz palette colors per bar

## 19.8. Data Table

Sortable columns (click header to toggle sort):

| Column | Field | Format | Sortable |
|--------|-------|--------|----------|
| Symbol | `symbol` | Bold, brand-deep | Yes |
| Name | `name` | Truncated at 160px | Yes |
| Sector | `sector` | Small text | No |
| Industry | `industry` | Small, truncated | No |
| P/E | `peRatio` | 1 decimal, or "—" | Yes |
| Div Yield | `dividendYield` | Percentage, or "—" | Yes |
| EPS | `trailingEps` | 2 decimals, positive/negative colors | Yes |
| 52W Range | `week52Low` – `week52High` | Currency range | No |
| Weight | `weight` | Percentage | Yes |
| Value | `currentValue` | Currency, bold | Yes |

## 19.9. Styling

- Design tokens only — no raw Tailwind colors
- Positive EPS: `text-positive`; negative EPS: `text-negative`
- Hover rows: `bg-accent/40`
- Animation: framer-motion `fadeUp` pattern with staggered delays
- Loading: Skeleton components for each section
- Empty state: centered message when no stock holdings found

## 19.10. Route and Navigation

- **Route**: `src/routes.tsx` — `{ path: "/reports/equity-analysis", component: EquityAnalysisPage, protected: true }`
- **Sidebar**: `src/components/layout/Sidebar.tsx` — "Equity Analysis" entry in Reports section with `PieChart` icon from lucide-react

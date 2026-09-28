# 19. Equity Analysis Page

This document specifies the frontend page for stock portfolio analysis.

## 19.1. Overview

- **Route**: `/reports/equity-analysis`
- **File**: `src/pages/reports/equity-analysis.tsx`
- **Navigation**: "Equity Analysis" link in the Reports section of the sidebar (PieChart icon from lucide-react)

## 19.2. Data Flow

| Layer | File | Description |
|-------|------|-------------|
| Types | `src/types/equity-analysis.ts` | `EquityAnalysisResponse`, `EquityAnalysisSummary`, `EquityGroup`, `EquityHolding`, `AssetClass` / `ASSET_CLASSES`, `EtfComposition` |
| API client | `src/lib/api.ts` | `api.getEquityAnalysis({ groupBy, lookThrough })`, `api.setAssetClass(itemId, assetClass, { applyToSymbol })` |
| Hooks | `src/hooks/use-equity-analysis.ts` | `useEquityAnalysis(groupBy, { lookThrough })` — React Query wrapper; `useSetAssetClass()` — override mutation, invalidates `equity-analysis` |
| Components | `src/components/equity-analysis/` | `AssetClassEditor`, `ASSET_CLASS_COLORS` (`asset-class-colors.ts`) |

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
│  Group by: [Sector] [Industry] [Country] [Asset  │
│  class]            (●) Look through ETFs         │
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

## 19.4a. Scope: stocks and ETFs only

Every card, chart and table on this page covers only stock and ETF holdings, matching the summary cards. The page briefly had a whole-portfolio "Portfolio composition" card and a bonds "Fixed income" card (#79). Both were removed: they measured a different set of holdings from the rest of the page, and the Portfolio page (breakdown by category group) and the Passive Income page (bond rates, maturity ladder) already show that data. Asset class colors come from `ASSET_CLASS_COLORS = buildGroupColorMap(ASSET_CLASSES, new Set())`, so a class keeps the same dataviz color in the badges and the asset class donut.

## 19.5. Grouping Selector & Look-through Toggle

Pill-toggle with four options: Sector (default), Industry, Country, Asset class. The hook fetches once per look-through setting (`queryKey: ['equity-analysis', { lookThrough }]`) and picks `groupings[groupBy]` from the response — the API computes every grouping because sector and country look through ETFs server-side. Switching tabs never refetches. (Responses without `groupings` are still re-grouped client-side.)

**Look through ETFs** switch (default on, persisted in the URL as `?lookThrough=0` when off; **only rendered when the response's `lookThroughAvailable` is true**, i.e. some ETF has composition data — the Twelve Data plan may not include `/etfs/world/composition`): with it on, the sector and country views split each ETF's value across its sectors / countries by weight; the uncovered remainder shows as "Other", bond ETFs as "Fixed income", and ETFs without composition (or with no country data, e.g. QQQ) stay "Diversified". Off restores the pre-#79 "Diversified" buckets. Industry never looks through. Group labels `Diversified` / `Other` / `Fixed Income` and asset class keys are translated.

## 19.5a. Asset Class Badge & Override (#79)

Each holding row shows its asset class as a badge (`AssetClassEditor`, `*` when set manually). Clicking it opens a popover (a bottom-sheet `Drawer` on mobile, via `useIsMobile`) with the ETF's top 5 sectors when known and a select: "Automatic (<class>)" clears the override, any class sets it. Saving calls `useSetAssetClass()` → `PUT /api/portfolio/items/{itemId}/asset-class` with `applyToSymbol: true`, toasts, and invalidates `equity-analysis`. Holdings rows come from the response's flat `holdings` list, so a looked-through ETF is still one row.

## 19.6. Allocation Chart

- Recharts `PieChart` with inner radius (donut style)
- Uses `dataviz-1` through `dataviz-8` palette colors via `buildGroupColorMap()` (stable per group name; `ASSET_CLASS_COLORS` when grouping by asset class)
- Custom labels showing group name and percentage (hidden for slices < 4%)
- Custom tooltip showing value and percentage

## 19.7. Top Holdings Chart

- Recharts horizontal `BarChart`
- Top 10 holdings sorted by weight
- Y-axis: ticker symbol, X-axis: weight percentage
- Same dataviz palette via `getGroupColor()` per bar

## 19.8. Data Table

Sortable columns (click header to toggle sort):

| Column | Field | Format | Sortable |
|--------|-------|--------|----------|
| Symbol | `symbol` + asset class badge / editor | Bold, brand-deep | Yes |
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

## 19.11. Trust Gate (rendering missing data)

The API can return `null` for `peRatio`, `trailingEps`, `latestEpsActual`, `latestEpsSurprise`, and `dividendYield` even when the underlying SecurityMaster row holds non-null values — this happens when the row's `earningsTrusted` / `dividendTrusted` flag is `false` because Twelve Data returned inconsistent data for that symbol (see backend spec 19, section 19.10).

**The frontend already handles this correctly** — every numeric column in the table renders `—` when its source field is `null`:

```tsx
{h.peRatio != null ? h.peRatio.toFixed(1) : '—'}
{h.dividendYield != null ? `${(h.dividendYield * 100).toFixed(2)}%` : '—'}
{h.trailingEps != null ? h.trailingEps.toFixed(2) : '—'}
```

No new code or special-case rendering is needed. Quote-derived columns (`week52High`, `week52Low`) are **not** subject to the trust gate — they come from `/quote`, which is reliable. A row with `—` in P/E / EPS / Yield but real numbers in 52-Week Range is the expected appearance for a stock with broken Twelve Data fundamentals.

The summary cards at the top (`weightedPeRatio`, `weightedDividendYield`) are computed by the API across **only the trusted holdings**. If no holding is trusted, both fall through to `null` and the cards show `—`. This is correct: a weighted average across zero trusted samples is undefined.

## 19.12. Manual Fundamentals Refresh

When the equity analysis page shows `—` widely (e.g., right after deploying the trust-flag migration before the next nightly refresh runs, or after a Twelve Data hiccup), an admin can force-recompute the trust flags by triggering a manual refresh:

- **Path**: Settings → Maintenance → "Refresh stock fundamentals" → click **Refresh fundamentals**.
- **Hook**: `useRefreshFundamentals()` from `src/hooks/use-refresh-fundamentals.ts`.
- **API client**: `api.refreshStockFundamentals()` in `src/lib/api.ts`.

The mutation resolves once the backend has enqueued the job. Actual refresh runs asynchronously (~2 seconds per active stock symbol). The user reloads the equity analysis page after a few minutes to see updated numbers; symbols whose underlying Twelve Data response is genuinely broken will continue to show `—` even after the refresh, by design.

Frontend implementation lives in `src/components/settings/maintenance-tab.tsx` (the `RefreshFundamentalsButton` sub-component). The button only disables briefly while the enqueue HTTP call is in flight — there's no status polling for this scope, since the user-facing signal is on the equity analysis page, not on the Maintenance tab. See `docs/specs/api/03-reference-data-management.md` section 3.5 for the design rationale.

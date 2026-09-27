# 22. Passive Income (Frontend)

Task #77. API: `docs/specs/api/22-passive-income-api.md`.

## 22.1. Passive Income page — `/reports/passive-income`

`src/pages/reports/passive-income.tsx`, sidebar entry "Passive Income" (`nav.passiveIncome`, Coins icon) after Equity Analysis.

| Section | Component | Notes |
|---------|-----------|-------|
| Horizon selector | page | 12 / 24 / 36 months (default 12), `usePassiveIncome(horizon)` |
| Five KPI tiles | page | Next 12 months (investment vs other), monthly average, yield on value (investment only), essentials covered, data coverage "N of M" |
| Missing data prompt | page | One button per missing holding → Income Terms modal; first 8, then "Show all (N)" |
| Actual vs projected chart | `components/passive-income/income-chart.tsx` | 12 actual bars (`dataviz-8`) then projected bars stacked by source (`dataviz-1/5/3/2/7`) with a dashed "Today" line; min width grows with the horizon and scrolls horizontally on phones |
| Annual summary | page | Year 1–3 by source |
| Upcoming payments | page | Next 10 |
| Breakdown | `income-breakdown.tsx` | Search (label, symbol, category, type), filter chips (All / Holdings / Streams / Needs attention), 20 rows per page; table from `md`, cards on phones; source badge (Auto/Override/Manual) and status badges (Matured: record redemption / Ended / Rate may be stale); rows open the modal |
| Other income streams | `streams-card.tsx` | Add / edit (delete inside the modal) |
| Bond maturity ladder | page | Principal per year, not income |
| Detached income terms | `detached-terms.tsx` | Only when any exist; Re-attach (searchable combobox of income-capable holdings without terms, fetched on demand) and Discard (confirmation dialog) |

## 22.2. Income Terms modal

`src/components/income/income-terms-modal.tsx`, schema `income-terms-schema.ts` (zod, mirrors `validateIncomeTerms`; messages are `incomeTerms.errors.*` keys).

- **Asset mode**: form adapts to the asset class (`useAssetIncomeTerms`): bonds (issuer, **total face value** — defaulted to the holding's cost basis and stored per unit as `total ÷ units held`, with a "N units held · X per unit" hint, because manual holdings without a quantity are 1 unit — coupon or index + spread + assumed rate, frequency incl. at maturity, maturity, anchor), real estate (net rent, indexation, lease start/end), cash (APY), funds/other (dividend per unit or yield %), stocks/ETFs (automatic last-12-month dividends summary, "Override automatic dividends" switch, "Apply to all holdings of this symbol"). "Doesn't distribute" on every asset. Turning the override off and saving deletes the terms (back to automatic data).
- **Stream mode**: name, eligible category, amount, frequency (weekly…annual), currency (defaults to the display currency), start/end, anchor, yearly indexation.
- Live preview from `previewIncome()` (`src/lib/passive-income.ts`): "≈ 1,240 / year · next payment 15 Nov · ends 2029".
- Full-screen sheet below `sm` (dialog classes). Dates use the app's Popover + Calendar picker (same as the transaction filters) with a clear button; amounts use `inputMode="decimal"`.
- Mutations invalidate `passive-income`, `equity-analysis` and `portfolio-items`; no background job is started.

## 22.3. Entry points

- **Portfolio holdings** (`pages/reports/portfolio.tsx`): a Coins icon button next to the symbol of every income-capable, open holding (incl. cash). Opens the modal in place (the debt row still navigates away). Highlighted (`text-brand-primary`) when terms exist.
- **Asset Price Updates** (`pages/manual-updates.tsx`): "Income terms" button on every row of the "All manually-priced assets" table.
- **Passive Income page**: breakdown rows and the missing-data prompt.

`canHoldIncomeTerms` / `classifyIncomeCategory` in `src/lib/passive-income.ts` mirror the shared classifier (the web bundle doesn't depend on `@bliss/shared`).

## 22.4. Equity Analysis & Maintenance

- Equity Analysis shows ETFs with an "ETF" badge; the API's `Diversified` bucket is translated (`equityAnalysis.diversified`). Copy now says "stock and ETF holdings".
- Settings → Maintenance: new **Refresh my securities data** card (`RebuildButton scope="security-data"`, 1-hour lock, history step "Refresh securities data"); the fundamentals card is relabelled as the **global** refresh; the Full rebuild description mentions the securities step. New strings are i18n keys under `maintenance.*` (the rest of the tab is still English-only).

## 22.5. i18n, tokens, mobile

- New keys under `passiveIncome.*`, `incomeTerms.*`, `maintenance.*`, `nav.passiveIncome`, `equityAnalysis.diversified/etfBadge` in all 5 locales; `i18n-parity.test.ts` checks them.
- Design tokens only (badges use `positive`/`warning`/`brand-primary`/`muted`; charts use `dataviz-*`).
- Layout: KPI grid 2 columns on phones, breakdown as cards, chart scrolls horizontally, modal full screen.

## 22.6. Tests

`passive-income.test.tsx` (page), `income-terms-modal.test.tsx`, `income-terms-schema.test.ts`, `lib/passive-income.test.ts`, `hooks/use-passive-income.test.tsx`, plus additions to `portfolio.test.tsx`, `maintenance-tab.test.tsx` and `i18n-parity.test.ts`.

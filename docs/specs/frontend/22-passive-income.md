# 22. Passive Income (Frontend)

Task #77; grouped view by #83. API: `docs/specs/api/22-passive-income-api.md`.

## 22.1. Passive Income page — `/reports/passive-income`

`src/pages/reports/passive-income.tsx`, sidebar entry "Passive Income" (`nav.passiveIncome`, Coins icon) after Equity Analysis.

| Section | Component | Notes |
|---------|-----------|-------|
| Horizon selector | page | 12 / 24 / 36 months (default 12), `usePassiveIncome(horizon)` |
| Five KPI tiles | page | Next 12 months (investment vs other), monthly average, yield on value (investment only), essentials covered, data coverage "N of M" |
| Missing data prompt | page | One button per missing **symbol** (`missingGroups`, group mode) in the grouped view, per holding in the flat view → Income Terms modal; first 8, then "Show all (N)" |
| Actual vs projected chart | `components/passive-income/income-chart.tsx` | 12 actual bars (`dataviz-8`) then projected bars stacked by source (`dataviz-1/5/3/2/7`) with a dashed "Today" line; min width grows with the horizon and scrolls horizontally on phones |
| Annual summary | page | Year 1–3 by source |
| Upcoming payments | page | Next 10; grouped view uses `upcomingPaymentsGrouped` (one line per symbol + date, "N accounts", tooltip listing them) |
| Breakdown | `income-breakdown.tsx` | **By holding / By account** toggle (#83, grouped by default, remembered in `localStorage` `bliss.passiveIncome.breakdownView`, read/write in try/catch; flat forced when the API has no `groups`). Grouped: one row per symbol / cash currency + stream rows; multi-account rows expand in place (chevron) into per-account rows; subtitle "N accounts · qty" (single holding: the account name), cash "Balance · /month" with APY or range; Mixed badges (`bg-muted`). Search (label, symbol, category, type, **account names** — an account match auto-expands the group), filter chips (All / Holdings / Streams / Needs attention — a group needs attention if any account does), 20 rows (groups) per page; table from `md`, cards on phones ("Show N accounts"); source badge (Auto/Override/Manual/Mixed) and status badges; edit: multi-account security group → modal in symbol scope, single-holding group or child row → that holding, cash groups read-only |
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
- **Group editing (#83)**: `scope: 'single' | 'symbol'` and `defaultApplyToSymbol`. With more than one non-cash sibling (`siblings` from the GET), single scope shows an "Apply to all N holdings of {symbol}" checkbox for every income type (pre-ticked with `defaultApplyToSymbol`); symbol scope always applies to all ("Applies to N holdings"), titles "Income terms — {symbol} (N accounts)", and asks the bond face value **per unit** with the combined total as a hint. If the siblings' source/terms differ (`siblingsDiffer()`), symbol scope first shows the **Mixed step**: each account's current terms, an account picker, "Use the same terms for all" (pre-fills from that account) or "Edit this account only" (switches to single scope for it). Removing terms for all holdings asks for confirmation, then `DELETE ?applyToSymbol=true`; turning a stock group's override off deletes the terms of every holding (back to automatic data).

## 22.3. Entry points

- **Portfolio holdings** (`pages/reports/portfolio.tsx`): a Coins icon button next to the symbol of every income-capable, open holding (incl. cash). Opens the modal in place (the debt row still navigates away) with `defaultApplyToSymbol` (#83): "apply to all holdings" is pre-ticked when the server reports more than one non-cash holding of the symbol (it's decided from `siblings`, so an account filter on the page doesn't hide other accounts). Highlighted (`text-brand-primary`) when terms exist.
- **Asset Price Updates** (`pages/manual-updates.tsx`): "Income terms" button on every row of the "All manually-priced assets" table; same `defaultApplyToSymbol` rule.
- **Passive Income page**: breakdown rows (group rows open symbol scope) and the missing-data prompt.

`canHoldIncomeTerms` / `classifyIncomeCategory` in `src/lib/passive-income.ts` mirror the shared classifier (the web bundle doesn't depend on `@bliss/shared`).

## 22.4. Equity Analysis & Maintenance

- Equity Analysis shows ETFs with an "ETF" badge; the API's `Diversified` bucket is translated (`equityAnalysis.diversified`). Copy now says "stock and ETF holdings".
- Settings → Maintenance: new **Refresh my securities data** card (`RebuildButton scope="security-data"`, 1-hour lock, history step "Refresh securities data"); the fundamentals card is relabelled as the **global** refresh; the Full rebuild description mentions the securities step. New strings are i18n keys under `maintenance.*` (the rest of the tab is still English-only).

## 22.5. i18n, tokens, mobile

- New keys under `passiveIncome.*`, `incomeTerms.*`, `maintenance.*`, `nav.passiveIncome`, `equityAnalysis.diversified/etfBadge` in all 5 locales; `i18n-parity.test.ts` checks them.
- Design tokens only (badges use `positive`/`warning`/`brand-primary`/`muted`; charts use `dataviz-*`).
- Layout: KPI grid 2 columns on phones, breakdown as cards, chart scrolls horizontally, modal full screen.

## 22.6. Tests

`passive-income.test.tsx` (page — #83: grouped upcoming/missing, group vs child edit, coverage tile, view persistence incl. throwing storage, older-API fallback), `income-breakdown.test.tsx` (#83: grouping, expand, cash read-only, account search, attention, pagination by group, phone cards, toggle), `income-terms-modal.test.tsx` (#83: apply-to-all default, symbol scope, Mixed step both choices, per-unit bond, remove-all confirmation, cash excluded), `income-terms-schema.test.ts`, `lib/passive-income.test.ts`, `hooks/use-passive-income.test.tsx`, plus additions to `portfolio.test.tsx`, `maintenance-tab.test.tsx` and `i18n-parity.test.ts`.

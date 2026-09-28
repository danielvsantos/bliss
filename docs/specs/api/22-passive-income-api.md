# 22. Passive Income API

Task #77; grouped view added by #83. OpenAPI: `docs/openapi/passive-income.yaml`. Engine: `docs/specs/backend/22-passive-income.md`.

All routes use `withAuth` (tenant from the JWT), the `portfolio` rate limiter and CORS, and scope every query by `tenantId`.

## 22.1. Routes

| Method | Route | Notes |
|--------|-------|-------|
| GET | `/api/portfolio/passive-income?horizon=12\|24\|36` | Projection (default 12; anything else → 400). #83 adds `groups`, `upcomingPaymentsGrouped`, `missingGroups`, `kpis.coverageByHolding` and per-item `accountId/accountName/securityName/quantity/currentValue/currency` (§22.6). |
| GET | `/api/portfolio/items/:assetId/income-terms` | `{ asset (with assetClass, defaultIncomeType, quantity, costBasis), terms, auto, siblings }`. `auto` only when SecurityMaster `dividendTrusted`. `siblings` (#83): every **open** holding (quantity > 0, plus this one) of the same symbol **and asset class** in the tenant — `{ assetId, accountName, currency, quantity, costBasis, terms, source }`. |
| PUT | `/api/portfolio/items/:assetId/income-terms` | Upsert, validated per `incomeType` by `validateIncomeTerms` (`@bliss/shared/portfolio`). `applyToSymbol: true` upserts the same terms on every sibling (same symbol + asset class, open positions) in one transaction, for **every income type except `INTEREST`** (#83; cash APY is per account → 400 `Cash interest is set per account`). Without a body `currency`, each target keeps **its own** item currency. Bonds copy `faceValuePerUnit`, so coupons scale with each holding's quantity. Non income-capable assets (crypto, collectibles, vehicles, commodities, debt) → 400. |
| DELETE | `/api/portfolio/items/:assetId/income-terms` | 204; stocks/ETFs fall back to automatic data. `?applyToSymbol=true` (#83) removes the terms from every holding of the symbol with the same asset class (closed positions included) → 200 `{ deleted: n }`; rejected (400) for cash. |
| GET / POST | `/api/passive-income/streams` | List streams + eligible categories / create (`incomeType FIXED_AMOUNT`). |
| PUT / DELETE | `/api/passive-income/streams/:id` | Update / delete a stream of the tenant. |
| GET | `/api/portfolio/income-terms/detached` | Tenant's detached terms. |
| POST | `/api/portfolio/income-terms/:id/attach` | `{ assetId }`: target must be the tenant's and have no terms (409 otherwise); clears `orphanedAt/Label`. |
| DELETE | `/api/portfolio/income-terms/:id` | Discard — only while detached (409 otherwise). |

**Stream-eligible categories**: `type = 'Income'`, `group = 'Passive Income'`, no `processingHint`, `portfolioItemKeyStrategy = IGNORE`, and not one of the asset-produced defaults (`DIVIDENDS`, `BOND_INCOME`, `INTEREST_INCOME`, `RENT_INCOME`, `OPTIONS_INCOME`). Several streams per category are allowed.

`toIncomeTermsData()` (`services/incomeTerms.service.js`) whitelists body fields and writes every field (null when absent) so switching income type leaves no stale values. Owner fields are never taken from the body.

`GET /api/portfolio/items` now also returns `category.defaultCategoryCode` and `incomeTerms { id, incomeType, isDistributing }` so holdings rows can show the Income terms action and its state.

## 22.2. `services/passiveIncome.service.js`

`loadInputs(tenantId, asOf)` does all reads; `project()` does the math.

- Items with `quantity > 0`, classified by `classifyIncomeAsset` (category + SecurityMaster `assetType`); non income-capable items are skipped.
- Current value: `currentValueInUSD` × USD→display (else `currentValue` × item-currency→display).
- FX: `createFxResolver(display)` — direct or inverse `CurrencyRate`, else via USD, 7-day lookback (`utils/currencyConversion.js`); unknown rates fall back to 1 (same as Equity Analysis).
- `recentDividends` only when `dividendTrusted`; dividend FX uses SecurityMaster `currency`.
- **Actuals**: `AnalyticsCacheMonthly` rows in the display currency, `type = 'Income'`, `group = 'Passive Income'`, the 12 months ending with the current (month-to-date) month, `credit − debit`. Mirrors the backend's `gatherPassiveIncomeRecent`. A category moved out of the group leaves the actuals (documented limitation).
- **Essentials coverage**: `next12mIncome ÷ trailing-12-month Essentials spending (debit − credit) × 100`; `null` when no essentials.

## 22.3. Equity Analysis changes

`GET /api/portfolio/equity-analysis` now includes `API_STOCK` and `API_FUND` holdings SecurityMaster identifies as `ETF` (any holding whose row says ETF is treated as one). ETFs: sector/industry/country always `Diversified`, `peRatio`/EPS always `null`, `assetType: 'ETF'`. Dividend yield honours IncomeTerms: `dividendPerUnit` override (converted to USD) or 0 for "doesn't distribute"; merged same-symbol holdings recompute yield from summed annual dividends.

## 22.4. Admin

`POST /api/admin/rebuild` accepts scope `security-data` (no payload) → backend `MANUAL_REBUILD_REQUESTED` → `refresh-tenant-securities { force: true }`.

## 22.5. Tests

- `__tests__/unit/services/portfolio-projection.test.ts` — the engine (all 9 income types, spike-derived dividend fixtures, horizons, clamping, statuses, currencies, validation, classification).
- `__tests__/integration/api/passive-income.test.ts` — real Postgres: CRUD, validation, `applyToSymbol`, eligible categories, owner CHECK, detached attach/discard, tenant isolation, projection route; #83: `siblings` (same symbol/class, open, tenant-isolated), fan-out for FIXED_COUPON and DIVIDEND with per-target currency, INTEREST → 400, group DELETE, `groups` / `missingGroups` / `upcomingPaymentsGrouped` in the projection.
- `portfolio-equity-analysis.test.ts`, `admin-rebuild.test.ts` — ETF and `security-data` additions.

## 22.6. Grouped view (#83)

The breakdown groups holdings by **symbol** (a holding is `(tenant, symbol, account)`, so the symbol is the "same thing in another account" key: the ticker, `Category - Description` for manual assets, `Cash EUR` for cash). Groups are computed in the engine (`groupItems()`, backend spec §22.5) and returned **in addition to** the flat `items`, so older consumers are unaffected. No migration; income terms stay per holding and group edits fan out server-side.

| Field | Meaning |
|-------|---------|
| `groups[]` | One per symbol + asset class (streams are never grouped). `kind` `SECURITY`/`CASH`, `label` (SecurityMaster name, else symbol), `accountCount`, `portfolioItemIds`, summed `quantity`/`currentValue`/`horizonTotal`/`next12mTotal`, `rateOrYield` (next-12-month income ÷ value; bonds and cash: the shared rate, else `null` + `rateRange [min, max]`), earliest `nextPaymentDate`, latest `endDate`, `incomeType`/`source`/`frequency` = shared value or `MIXED`, most severe `status` + `statusCount`, `configured` (no MISSING child), `children` (item rows incl. MISSING rows for holdings without data). |
| `upcomingPaymentsGrouped[]` | Payments of the same symbol, date and source merged (amount summed, `accounts`, `refIds`) **before** the top 10 is taken. Streams stay one line each. |
| `missingGroups[]` | One per symbol: `{ groupKey, symbol, label, assetClass, portfolioItemIds, reason }` (`NO_TERMS` wins over `UNTRUSTED_DIVIDEND`). |
| `kpis.coverage` | Now counts **groups** ("N of M"): a group is configured only when none of its holdings is missing. |
| `kpis.coverageByHolding` | The pre-#83 per-holding count. |

Page totals, `projected`, `yearly` and `maturityLadder` are unchanged by grouping.

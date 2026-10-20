# 25. eToro Copy Trading (Backend)

A tenant admin connects an eToro **Read** key. Each night, and on "Sync now", Bliss reads that account's copies and their holdings. It writes each copy's daily value onto the matching **Copy Trading** holding and keeps the copy's holdings, so Equity Analysis, the #80 insight lenses and MCP `get_equity_analysis` can look through a copy the way they look through an ETF. Added in #143.

**Scope.** Bliss follows the value and composition of the user's own copies. It never creates, changes, suggests or reconciles transactions, and it does not use public-investor data, direct (non-copy) eToro holdings, dividends, fees or the WebSocket feed. Account movements (P2) were a NO-GO in the spike; an eToro statement adapter is a separate task.

Related: [Portfolio API §6.7 Equity Analysis](../api/06-portfolio-api.md#67-equity-analysis) · [Security master](./19-security-master.md) · [Passive income](./22-passive-income.md) · [Enable Banking](./24-enable-banking.md) (the sync pattern this follows).

---

## 25.1 Implementation status

The work ships in five PRs. This spec describes the whole feature; each PR updates the sections it changes.

| PR | Scope | Status |
|---|---|---|
| **A** | Pure shared layer: instrument mapper, scope check, copy composition, `COPY_TRADE` asset class, passive income exclusion (§25.4–§25.6) | **this PR** |
| B | Schema + migration, eToro HTTP client, sync handler, valuation (§25.2, §25.3, §25.7) | planned |
| C | API connection routes, convert action, Equity Analysis copy rows, #80 insights, MCP (§25.8) | planned |
| D | Web: connect dialog, connection management, holdings badges, Equity Analysis labels | planned |
| E | Security master look-through watchlist (§25.9) | planned |

## 25.2 Data model

All three tables are new and are created by a hand-written migration (`migrate deploy` only, see CLAUDE.md). Every row carries `tenantId` and cascades on tenant delete.

| Table | Purpose |
|---|---|
| `EtoroConnection` | One row per eToro login per tenant (`@@unique([tenantId, etoroCid])`). `accountId` → the one Bliss account the login maps to. `apiKey` and `userKey` are encrypted (`encryptedFields` + `ROTATION_COVERAGE`) and never returned; `keyLast4` only. `scopes` from `/api/v1/me`. `status`: `ACTIVE` \| `NEEDS_RECONNECT` \| `REMOVED`. `connectedAt` is the boundary before which values never change. |
| `EtoroCopy` | One row per copy (`@@unique([connectionId, mirrorId])`): copied investor's `parentUsername` (lower-cased), `startedAt`, `status` (`ACTIVE` \| `CLOSED`), `closedAt`, `lastValue` + `lastValueCurrency` (USD) + `lastValueAt`, and `holdings` (JSON, mapped at sync, §25.4) + `unmappedPct` + `holdingsAt`. |
| `EtoroCopyValue` | One row per copy per UTC day (`@@unique([copyId, day])`): eToro's copy value in USD. |

**Why not `PlaidItem` / `AssetPrice` (approved PRD amendment, 2026-10-20).**
- `PlaidItem` means "bank feed into the review pipeline". At least ten readers treat any provider other than `ENABLE_BANKING` as Plaid, so an `ETORO` row would risk reaching the Plaid SDK or raising a phantom re-login notification.
- `AssetPrice` is global (no `tenantId`). Two tenants copying the same investor have different copy values, and the rows would survive tenant deletion.

**Link to the holding (resolved, never stored).** A Copy Trading holding is linked to a copy when `tenantId` matches, `PortfolioItem.accountId = EtoroConnection.accountId`, the category's `processingHint = 'COPY_TRADING'`, and `lower(PortfolioItem.symbol) = EtoroCopy.parentUsername`. Nothing references `portfolioItemId`, so a re-keying portfolio rebuild can't orphan values or holdings.

**Category.** New default category **Copy Trading** (`defaultCategoryCode = 'COPY_TRADING'`, group "Funds", type "Investments", `processingHint = 'COPY_TRADING'`, key strategy `TICKER`, icon 🔁), in `DEFAULT_CATEGORIES` and inserted for existing tenants by the migration (`ON CONFLICT DO NOTHING`). The ticker is the copied investor's eToro username, not a market symbol: `COPY_TRADING` is not in `SECURITY_PROCESSING_HINTS` or `MANDATORY_ENRICHMENT_HINTS`, so it is never sent to Twelve Data.

## 25.3 Sync cadence

- **Queue:** the existing `plaid-sync` queue, like Enable Banking. No new queue or worker.
- **Jobs:** `ETORO_SYNC` (one connection, deduplicated per connection) and `ETORO_SYNC_ALL` (job scheduler at **03:30 UTC**, fans out one `ETORO_SYNC` per `ACTIVE` connection). 03:30 is after the security master (03:00) and before the nightly revaluation (04:00), which picks up the new values.
- **Sync now:** `POST /api/etoro/connections/:id/sync`, 15-minute Redis cooldown. After writing, it enqueues `value-portfolio-items` for the linked items.
- **Calls per connection:** about 3 (`GET /api/v1/me`, `POST` aggregate-portfolio with `mirrorLevel: details` + `instrumentLevel: details`, one instrument-metadata batch for unseen instruments). eToro allows 60 reads/min per key and returns `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; the client sleeps until reset when `Remaining ≤ 1`, and on 429 waits `Retry-After` and retries once.
- **Key revoked:** on a 401/403 the handler probes `GET /me` once before changing anything (the #148 rule). Confirmed → `NEEDS_RECONNECT`, no value written, the job resolves so other connections continue. Probe succeeds → retryable failure, status unchanged.
- **No Twelve Data from the sync.** The handler must not `require` anything that reaches `services/twelveDataService.js`; values are stored in USD and converted during valuation. `twelveDataPriorityCoverage.test.js` enforces it.
- **Processing status (#100):** both jobs mapped in `config/activityMap.js` (stage "Syncing eToro copies", trigger `bank_sync` / `nightly`). Final failures raise `PROCESSING_FAILED`.

## 25.4 Instrument mapping — `@bliss/shared/etoro` `mapEtoroInstrument()`

Pure: a fixed exchange table and suffix rules, no database, no network, no alias cache. eToro instrument metadata has `symbolFull` and `exchangeID` but no ISIN, country or sector, and `priceSource` is the data vendor, not the venue. The venue always comes from `exchangeID`.

| `exchangeID` | MIC | eToro suffix |
|---|---|---|
| 4 | XNAS | – |
| 5 | XNYS | – |
| 6 | XETR | `.DE` |
| 7 | XLON | `.L` |
| 9 | XPAR | `.PA` |
| 12 | XSWX | `.ZU` |
| 14 | XOSL | `.OL` |
| 15 | XSTO | `.ST` |
| 16 | XCSE | `.CO` |
| 17 | XHEL | `.HE` |
| 20 | BATS | – |
| 21 | XHKG | `.HK` |
| 22 | XLIS | `.LSB` |
| 30 | XAMS | `.NV` |
| 33 | — (Regular Trading Hours variant) | `.RTH` |
| 39 | XDFM | `.AE` |

Rules:
- A suffix is stripped only when it is the suffix of the instrument's own exchange, so share classes (`BRK.B`, `NOVO-B`) stay intact: `AIR.PA` → `AIR`/XPAR, `BRK.B` → `BRK.B`/XNYS, `NOVO-B.CO` → `NOVO-B`/XCSE, `1810.HK` → `1810`/XHKG; `ASML` and `ASML.NV` are two listings (XNAS, XAMS).
- Exchange 33 is not a venue: `AMZN.RTH` → `{ symbol: 'AMZN', exchange: null, rthVariant: true }`. `mergeCopyHoldings()` folds it into the copy's US listing of the same symbol (XNAS, XNYS or BATS), so a copy holding both shows one Amazon line.
- `instrumentTypeID` 5 → `type: 'STOCK'`, 6 → `'ETF'`, anything else → `null`.
- An unknown exchange or a missing symbol → `{ unresolved: true, reason, exchangeId }`, and `etoro_unmapped_instrument { reason, exchangeId, instrumentId }` is logged through the optional `logger`. Unresolved holdings count as "Other" and in `unmappedPct`.
- **Exchange 6 (D9).** eToro labels it "FRA" while its metadata says Xetra; Twelve Data lists the `.DE` primaries on XETR, so the table uses XETR. The live check against Twelve Data (two exchange-6 symbols on XETR vs XFRA) needs a Twelve Data key and is still pending. If they resolve only on XFRA, it is a one-line table change.

**Scope check.** `assertReadOnlyScopes(scopes)` throws `EtoroScopeError` (`code: 'ETORO_WRITE_SCOPE'`, `writeScopes`) unless every scope ends in `:read`. An empty list is refused too, because a key that reports no scopes can't be proven read-only.

## 25.5 Copy composition — `@bliss/shared/portfolio` `deriveCopyComposition()`

Computed on read, never stored: the sync keeps only the mapped holdings (`[{ instrumentId, etoroSymbol, symbol, exchange, type, rthVariant, valuePct }]` with `valuePct` 0–100, plus `cashPct`). New SecurityMaster data shows up without another eToro sync.

`deriveCopyComposition({ holdings, cashPct }, securities)` takes SecurityMaster rows by symbol (a `Map` or a plain object) and returns:

| Field | Meaning |
|---|---|
| `sectors`, `countries` | `[{ sector \| country, weight }]`, weights as **fractions of the copy's value**, largest first. The same shape as an ETF's `etfComposition`, so `lookThrough()` consumes it unchanged. |
| `assetClassMix` | `[{ assetClass, weight }]`, summing to 1: the holdings' classes, plus `CASH` for copy cash and `OTHER` for unresolved instruments. |
| `peRatio`, `peCoverage` | Value-weighted P/E over **stocks** with `earningsTrusted` and P/E > 0; coverage is the share of the copy's value (0–100) behind it. |
| `dividendYield`, `yieldCoverage` | Value-weighted yield (fraction) over holdings with `dividendTrusted`, zero yields included; coverage 0–100. Informational only (§25.6). |
| `sectorCoveragePct`, `countryCoveragePct` | Share of the copy split into named groups; the rest is "Other". |
| `unmappedPct` | Share of the copy in unresolved instruments (0–100). |

Per holding, by its #79 asset class (`classifyAssetClass` with eToro's instrument type standing in for the category):
- **STOCK / REIT:** its own SecurityMaster sector and country.
- **INDEX_ETF / SECTOR_ETF with `etfComposition`:** spread across that ETF's sectors and countries by weight (two-level look-through: copy → ETF → sector/country).
- **BOND_ETF:** "Fixed Income" in both views, like a directly held bond ETF.
- **ETFs without composition, funds, holdings without SecurityMaster data:** left out, so they fall into the copy's "Other" remainder. The §25.9 watchlist is what fills them in.

Holdings are merged first (`mergeCopyHoldings()`): same `symbol|exchange` lines are summed and RTH variants folded (§25.4). If eToro's shares add up past 100%, they are scaled back to 100% so a copy never inflates.

## 25.6 Asset class and passive income

- **`COPY_TRADE`** is a 13th asset class (`ASSET_CLASSES`) and an equity class (`EQUITY_ASSET_CLASSES`). `classifyAssetClass()` returns it for the `COPY_TRADING` hint; a user override still wins.
- **Not an override.** `COPY_TRADE` only means something for a linked copy, so the override route (`PUT /api/portfolio/items/:assetId/asset-class`) and the MCP `set_asset_class` tool validate against `OVERRIDE_ASSET_CLASSES` (every class except `COPY_TRADE`).
- **`lookThrough()`** splits a `COPY_TRADE` holding by its `composition` exactly like an ETF: weights → groups, `1 − Σweights` → "Other". Look-through off, the industry view, or an unlinked copy (no composition) → one "Diversified" bucket.
- **Passive income (R19).** `classifyIncomeAsset()` returns `null` for the `COPY_TRADING` hint. A Copy Trading holding projects **no cash income** and is never flagged "missing terms": the spike showed dividends are paid inside the copy (the copy is accumulating).

## 25.7 Valuation (PR-B)

New strategy `COPY_TRADING` in `portfolio-handlers/valuation/strategies/`:
- Before the first `EtoroCopyValue` row (before the connection), the holding behaves like today's ticker-less Fund: manual values, otherwise cost basis.
- From the first row on, the day's **total** value is eToro's copy value (not multiplied by quantity), converted from USD on the existing USD-intermediary FX path and forward-filled to today. `PortfolioValueHistory.source = 'ETORO'` / `'ETORO:FORWARD'`.
- A `ManualAssetValue` on the same day still wins (R11).
- A restarted copy of the same investor (old mirror `CLOSED`, new `ACTIVE`) matches the same holding: the `ACTIVE` copy wins per day, and a closed copy only contributes days before its `closedAt`.

## 25.8 Integration tokens and MCP

- Every `/api/etoro/*` route is **session-only**: one `INTEGRATION_DENYLIST` entry `{ prefix: '/api/etoro', methods: 'ALL' }`, each route `DENY_ALL` in `integrationRouteMatrix.data.ts`, and each operation listed in `lib/mcp/exclusions.js` with the reason "eToro connection lifecycle (session-only)". The R8 convert action (`POST /api/etoro/convert-holding`) is under the same prefix.
- Agents see copies only through `get_equity_analysis`, which returns the same split as the web page (`assetClass: 'COPY_TRADE'`, per-holding look-through coverage).
- Only Bliss-derived numbers reach the LLM; no eToro market content does.

## 25.9 Look-through watchlist (PR-E)

Holdings inside linked copies that no tenant holds directly form a watchlist that the security master refreshes weekly: profile, fundamentals and ETF composition.
- **Job:** `refresh-lookthrough-watchlist` on the `security-master` queue, Sunday 02:00 UTC. It runs at `PRIORITIES.BACKGROUND` in the #150 Twelve Data budget and has no pacing of its own.
- **Symbols:** distinct mapped symbols of `ACTIVE` copies, minus symbols held directly, limited to symbols that are missing or more than 7 days stale. Only symbols leave the query: no tenant id, no value.
- **Cost:** about 51 credits per stale symbol. On a small plan, coverage builds up over several weeks, and missing data shows as "Other" in the meantime.

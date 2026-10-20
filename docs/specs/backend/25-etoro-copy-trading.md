# 25. eToro Copy Trading (Backend)

A tenant admin connects an eToro **Read** key. Each night, and on "Sync now", Bliss reads that account's copies and their holdings. It writes each copy's daily value onto the matching **Copy Trading** holding and keeps the copy's holdings, so Equity Analysis, the #80 insight lenses and MCP `get_equity_analysis` can look through a copy the way they look through an ETF. Added in #143.

**Scope.** Bliss follows the value and composition of the user's own copies. It never creates, changes, suggests or reconciles transactions, and it does not use public-investor data, direct (non-copy) eToro holdings, dividends, fees or the WebSocket feed. Account movements (P2) were a NO-GO in the spike; an eToro statement adapter is a separate task.

Related: [Portfolio API §6.7 Equity Analysis](../api/06-portfolio-api.md#67-equity-analysis) · [Security master](./19-security-master.md) · [Passive income](./22-passive-income.md) · [Enable Banking](./24-enable-banking.md) (the sync pattern this follows).

---

## 25.1 Implementation status

The work ships in five PRs. This spec describes the whole feature; each PR updates the sections it changes.

| PR | Scope | Status |
|---|---|---|
| A | Pure shared layer: instrument mapper, scope check, copy composition, `COPY_TRADE` asset class, passive income exclusion (§25.4–§25.6) | #247 |
| B | Schema + migration, eToro HTTP client, sync handler, valuation (§25.2, §25.3, §25.7, §25.10) | done |
| C | API connection routes, convert action, Equity Analysis copy rows, #80 insights, MCP (§25.8) | planned |
| D | Web: connect dialog, connection management, holdings badges, Equity Analysis labels | planned |
| E | Security master look-through watchlist (§25.9) | planned |

## 25.2 Data model

All three tables are new and are created by a hand-written migration (`migrate deploy` only, see CLAUDE.md). Every row carries `tenantId` and cascades on tenant delete.

| Table | Purpose |
|---|---|
| `EtoroConnection` | One row per eToro login per tenant (`@@unique([tenantId, etoroCid])`). `accountId` → the one Bliss account the login maps to. `apiKey` and `userKey` are encrypted (`encryptedFields` + `ROTATION_COVERAGE`) and never returned; `keyLast4` only. `scopes` from `/api/v1/me`. `status`: `ACTIVE` \| `NEEDS_RECONNECT` \| `REMOVED`. `connectedAt` is the boundary before which values never change. |
| `EtoroCopy` | One row per copy (`@@unique([connectionId, mirrorId])`): copied investor's `parentUsername` (lower-cased), `startedAt`, `status` (`ACTIVE` \| `CLOSED`), `closedAt`, `lastValue` + `lastValueCurrency` (the eToro account currency, normally USD) + `lastValueAt`, and `holdings` (JSON, mapped at sync, §25.4) + `cashPct` + `unmappedPct` + `holdingsAt`. |
| `EtoroCopyValue` | One row per copy per UTC day (`@@unique([copyId, day])`): eToro's copy value in the account currency. A second sync on the same day updates the row. |

Connection sync state: `lastSyncAt`, `lastSyncStatus` (`SUCCESS` \| `FAILED`), `lastSyncError` (an error code, never a message from eToro) and `errorCode` (why the connection needs a reconnect). Migration: `20261021120000_add_etoro_copy_trading`.

**Why not `PlaidItem` / `AssetPrice` (approved PRD amendment, 2026-10-20).**
- `PlaidItem` means "bank feed into the review pipeline". At least ten readers treat any provider other than `ENABLE_BANKING` as Plaid, so an `ETORO` row would risk reaching the Plaid SDK or raising a phantom re-login notification.
- `AssetPrice` is global (no `tenantId`). Two tenants copying the same investor have different copy values, and the rows would survive tenant deletion.

**Link to the holding (resolved, never stored).** A Copy Trading holding is linked to a copy when `tenantId` matches, `PortfolioItem.accountId = EtoroConnection.accountId`, the category's `processingHint = 'COPY_TRADING'`, and `lower(PortfolioItem.symbol) = EtoroCopy.parentUsername`. Nothing references `portfolioItemId`, so a re-keying portfolio rebuild can't orphan values or holdings.

**Category.** New default category **Copy Trading** (`defaultCategoryCode = 'COPY_TRADING'`, group "Funds", type "Investments", `processingHint = 'COPY_TRADING'`, key strategy `TICKER`, icon 🔁), in `DEFAULT_CATEGORIES` and inserted for existing tenants by the migration (`ON CONFLICT DO NOTHING`). The ticker is the copied investor's eToro username, not a market symbol: `COPY_TRADING` is not in `SECURITY_PROCESSING_HINTS` or `MANDATORY_ENRICHMENT_HINTS`, so it is never sent to Twelve Data.

## 25.3 Sync cadence

- **Queue:** the existing `plaid-sync` queue, like Enable Banking. No new queue or worker.
- **Jobs:** `ETORO_SYNC` (one connection, deduplicated per connection) and `ETORO_SYNC_ALL` (job scheduler at **03:30 UTC**, fans out one `ETORO_SYNC` per `ACTIVE` connection). 03:30 is after the security master (03:00) and before the nightly revaluation (04:00), which picks up the new values.
- **Sync now:** `POST /api/etoro/connections/:id/sync`, 15-minute Redis cooldown. After writing, it enqueues `value-portfolio-items` for the linked items.
- **Calls per connection:** 3 + one per 50 instruments: `POST /api/v1/trading/info/aggregate-portfolio` with `{ mirrorLevel: 'details', instrumentLevel: 'details' }` (each copy's value, cash and per-instrument liquidation value), `GET /api/v1/trading/info/portfolio` (who each copy follows and since when), and `GET /api/v1/market-data/instruments?instrumentIds=…` in batches of 50. `GET /api/v1/me` is called only by the connect check and the key probe. eToro allows 60 reads/min per key and returns `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; the client sleeps until reset when `Remaining ≤ 1`, and on 429 waits `Retry-After` and retries once.
- **Key revoked:** on a 401/403 the handler probes `GET /me` once before changing anything (the #148 rule). Confirmed → `NEEDS_RECONNECT`, no value written, the job resolves so other connections continue. Probe succeeds → retryable failure, status unchanged.
- **No Twelve Data from the sync.** `workers/handlers/etoroSync.js` must not `require` anything that reaches `services/twelveDataService.js`; values are stored in eToro's account currency and converted during valuation. `twelveDataPriorityCoverage.test.js` asserts `plaidSyncWorker.js` never reaches it.
- **Processing status (#100):** `ETORO_SYNC` is a `PORTFOLIO_UPDATE` with stage `syncing_copies` ("Syncing eToro copies"), affecting the portfolio; `ETORO_SYNC_ALL` has no tenant and is not tracked. Scheduled syncs carry `_trigger: 'nightly'`. Final failures raise `PROCESSING_FAILED`.

**One run, in order.** Everything is read before anything is written, so a bad response never leaves partial rows:
1. Load the connection; skip unless `ACTIVE`.
2. Read the aggregate portfolio, the raw portfolio and the instrument metadata; parse with `parseCopies()` (mirror id 0, the user's direct holdings, is ignored).
3. Upsert each copy (`connectionId` + `mirrorId`) with its value, cash and mapped holdings (`buildCopyHoldings()`), and upsert today's `EtoroCopyValue`.
4. Mark the connection's `ACTIVE` copies missing from the response `CLOSED` (`closedAt = now`).
5. Record `lastSyncStatus = SUCCESS`.
6. Enqueue `value-portfolio-items` for the linked Copy Trading holdings (closed copies included, so they keep their last value).

## 25.4 Instrument mapping — `@bliss/shared/etoro` `mapEtoroInstrument()`

Pure: a fixed exchange table and suffix rules, no database, no network, no alias cache. eToro instrument metadata has `symbolFull`, `exchangeID` and `instrumentTypeID` (1 currencies, 2 commodities, 4 indices, 5 stocks, 6 ETFs, 10 crypto) but no ISIN, country or sector, and `priceSource` is the data vendor, not the venue. The venue always comes from `exchangeID`.

`ETORO_EXCHANGES` holds **every exchange eToro lists** (ids 1–24 and 30–58, from eToro's exchanges endpoint). **Verified** means the suffix was seen on live instruments in the spike. The other suffixes follow eToro's convention but haven't been confirmed. A suffix is only ever stripped on an exact match, so a wrong guess leaves the symbol intact; it then fails enrichment and lands in "Other", never under a wrong company.

| `exchangeID` | eToro description | MIC | Suffix(es) | Verified |
|---|---|---|---|---|
| 1 / 2 / 3 / 40 | FX / Commodity / CFD / CME | — (non-equity: currency, commodity, index, future) | – | – |
| 4 | Nasdaq | XNAS | – | ✓ |
| 5 | NYSE | XNYS | – | ✓ |
| 6 | FRA | XFRA | `.DE` | ✓ |
| 7 | LSE | XLON | `.L` | ✓ |
| 8 | Digital Currency | — (non-equity: crypto) | – | – |
| 9 | Euronext Paris | XPAR | `.PA` | ✓ |
| 10 | Bolsa De Madrid | XMAD | `.MC` | |
| 11 | Borsa Italiana | XMIL | `.MI` | |
| 12 | SIX | XSWX | `.ZU` | ✓ |
| 13 / 56 | TYO / Tokyo Stock Exchange | XJPX | `.T` | |
| 14 | Oslo | XOSL | `.OL` | ✓ |
| 15 | Stockholm | XSTO | `.ST` | ✓ |
| 16 | Copenhagen | XCSE | `.CO` | ✓ |
| 17 | Helsinki | XHEL | `.HE` | ✓ |
| 18 | Toronto | XTSE | `.TO` | |
| 19 | OTC Markets | OTCM | – | |
| 20 | Chicago Board Options Exchange | BATS | – | ✓ |
| 21 | Hong Kong Exchanges | XHKG | `.HK` | ✓ |
| 22 | Euronext Lisbon | XLIS | `.LSB` | ✓ |
| 23 | Euronext Brussels | XBRU | `.BR` | |
| 24 | Tadawul | XSAU | `.SR` | |
| 30 | Euronext Amsterdam | XAMS | `.NV` | ✓ |
| 31 | Sydney | XASX | `.ASX`, `.AX` | |
| 32 | Vienna | XWBO | `.VI` | |
| 33 | Regular Trading Hours - RTH | — (US variant) | `.RTH` | ✓ |
| 34 | Dublin EN | XMSM | `.ISE`, `.IR` | |
| 35 / 36 / 37 | Prague / Warsaw / Budapest | XPRA / XWAR / XBUD | `.PR` / `.WA` / `.BD` | |
| 38 | Xetra ETFs | XETR | `.DE` | |
| 39 | Dubai Financial Market | XDFM | `.AE` | ✓ |
| 41 | Abu Dhabi | XADS | `.AD` | |
| 42 / 43 / 44 | LSE AIM / AIM Auction / LSE Auction | XLON | `.L` | |
| 45 / 46 | Shenzhen / Shanghai | XSHE / XSHG | `.SZ` / `.SS`, `.SH` | |
| 47 | National Stock Exchange of India | XNSE | `.NS` | |
| 48 | TSX Venture | XTSX | `.V` | |
| 49 | Singapore | XSES | `.SI` | |
| 50–53 | Nasdaq Iceland / Tallinn / Vilnius / Riga | XICE / XTAL / XLIT / XRIS | `.IC` / `.TL` / `.VS` / `.RG` | |
| 54 / 55 | Korea / Taiwan | XKRX / XTAI | `.KS` / `.TW` | |
| 57 | Texas Stock Exchange | — (US variant) | `.TXSE` | |
| 58 | Tel Aviv | XTAE | `.TA` | |

Rules:
- Share classes (`BRK.B`, `NOVO-B`) stay intact: `AIR.PA` → `AIR`/XPAR, `BRK.B` → `BRK.B`/XNYS, `NOVO-B.CO` → `NOVO-B`/XCSE, `1810.HK` → `1810`/XHKG. `ASML` and `ASML.NV` are two listings (XNAS, XAMS).
- **US variants** (33 RTH, 57 Texas) aren't venues: `AMZN.RTH` → `{ symbol: 'AMZN', exchange: null, usVariant: true }`. `mergeCopyHoldings()` folds it into the copy's US listing of the same symbol (XNAS, XNYS or BATS), so a copy holding both shows one Amazon line.
- **Non-equity instruments** (by `instrumentTypeID` 1/2/4/10, or exchange 1/2/3/8/40) → `{ symbol, exchange: null, nonEquity: 'CURRENCY'|'COMMODITY'|'INDEX'|'FUTURE'|'CRYPTO' }`. Copies often hold crypto and commodities. These holdings count in the asset-class mix (`CRYPTO`, otherwise `OTHER`), are never enriched from SecurityMaster, and are not "unmapped".
- `instrumentTypeID` 5 → `type: 'STOCK'`, 6 → `'ETF'`.
- An unknown exchange (for a stock or ETF) or a missing symbol → `{ unresolved: true, reason, exchangeId }`, logged as `etoro_unmapped_instrument { reason, exchangeId, instrumentId }` through the optional `logger`. These count as "Other" and in `unmappedPct`.
- **Exchange 6 (D9).** eToro's own list names 6 "FRA" and gives Xetra its own id (38, "Xetra ETFs"), so 6 maps to XFRA and 38 to XETR. Because SecurityMaster is keyed by symbol only, the MIC affects only the watchlist refresh (§25.9): Frankfurt and Xetra quote the same German companies.

**Scope check.** `assertReadOnlyScopes(scopes)` throws `EtoroScopeError` (`code: 'ETORO_WRITE_SCOPE'`, `writeScopes`) unless every scope ends in `:read`. An empty list is refused too, because a key that reports no scopes can't be proven read-only.

## 25.5 Copy composition — `@bliss/shared/portfolio` `deriveCopyComposition()`

Computed on read, never stored: the sync keeps only the mapped holdings (`[{ instrumentId, etoroSymbol, symbol, exchange, type, usVariant, nonEquity, valuePct }]` with `valuePct` 0–100, plus `cashPct`). New SecurityMaster data shows up without another eToro sync.

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
- **Non-equity holdings** (crypto, commodities, currencies, index CFDs, futures): `CRYPTO` or `OTHER` in `assetClassMix` only.

Holdings are merged first (`mergeCopyHoldings()`): same `symbol|exchange` lines are summed, US variants are folded in, and non-equity holdings merge by kind + symbol (§25.4). If eToro's shares add up past 100%, they are scaled back to 100% so a copy never inflates.

## 25.6 Asset class and passive income

- **`COPY_TRADE`** is a 13th asset class (`ASSET_CLASSES`) and an equity class (`EQUITY_ASSET_CLASSES`). `classifyAssetClass()` returns it for the `COPY_TRADING` hint; a user override still wins.
- **Not an override.** `COPY_TRADE` only means something for a linked copy, so the override route (`PUT /api/portfolio/items/:assetId/asset-class`) and the MCP `set_asset_class` tool validate against `OVERRIDE_ASSET_CLASSES` (every class except `COPY_TRADE`).
- **`lookThrough()`** splits a `COPY_TRADE` holding by its `composition` exactly like an ETF: weights → groups, `1 − Σweights` → "Other". Look-through off, the industry view, or an unlinked copy (no composition) → one "Diversified" bucket.
- **Passive income (R19).** `classifyIncomeAsset()` returns `null` for the `COPY_TRADING` hint. A Copy Trading holding projects **no cash income** and is never flagged "missing terms": the spike showed dividends are paid inside the copy (the copy is accumulating).

## 25.7 Valuation

Strategy `COPY_TRADING` (`portfolio-handlers/valuation/strategies/COPY_TRADING.js`), fed by `loadCopyValueMap()` in `price-fetcher.js`:
- **Which values.** The copies of the holding's account's connections whose `parentUsername` is the holding's ticker, lower-cased. A Copy Trading holding never reads `AssetPrice` (its ticker is a username, not a market symbol).
- **Before the first eToro day** (before the connection, or never linked): exactly the MANUAL behaviour, manual values forward-filled, otherwise cost basis (`COST_BASIS_FALLBACK`). History before the connection is never changed.
- **From the first eToro day on**, the day's **total** value is eToro's copy value (not multiplied by quantity), forward-filled to today on days without a value. `PortfolioValueHistory.source` is `ETORO` or `ETORO:FORWARD`. It is converted to the holding's currency through USD (`convertCopyValue()`), and `valueInUSD` is the USD leg. A missing FX rate stores 0 for that day and logs a warning, like the other strategies.
- **A manual value on the exact day still wins** (R11), per unit as for MANUAL. A forward-filled manual value does not override eToro.
- **Restarted copies.** When a copy of the same investor was stopped and started again, both match the holding; on a day both have, the most recently started copy wins. A closed copy gets no new values, so the active one takes over.
- **Stopped copy or broken connection (R12).** No new values arrive, and the last one is carried forward.

## 25.8 Integration tokens and MCP

- Every `/api/etoro/*` route is **session-only**: one `INTEGRATION_DENYLIST` entry `{ prefix: '/api/etoro', methods: 'ALL' }`, each route `DENY_ALL` in `integrationRouteMatrix.data.ts`, and each operation listed in `lib/mcp/exclusions.js` with the reason "eToro connection lifecycle (session-only)". The R8 convert action (`POST /api/etoro/convert-holding`) is under the same prefix.
- Agents see copies only through `get_equity_analysis`, which returns the same split as the web page (`assetClass: 'COPY_TRADE'`, per-holding look-through coverage).
- Only Bliss-derived numbers reach the LLM; no eToro market content does.

## 25.9 Look-through watchlist (PR-E)

Holdings inside linked copies that no tenant holds directly form a watchlist that the security master refreshes weekly: profile, fundamentals and ETF composition.
- **Job:** `refresh-lookthrough-watchlist` on the `security-master` queue, Sunday 02:00 UTC. It runs at `PRIORITIES.BACKGROUND` in the #150 Twelve Data budget and has no pacing of its own.
- **Symbols:** distinct mapped symbols of `ACTIVE` copies, minus symbols held directly, limited to symbols that are missing or more than 7 days stale. Only symbols leave the query: no tenant id, no value.
- **Cost:** about 51 credits per stale symbol. On a small plan, coverage builds up over several weeks, and missing data shows as "Other" in the meantime.

## 25.10 Failure modes

| Failure | Connection | Job | Data |
|---|---|---|---|
| 401/403 confirmed by the `GET /me` probe | `NEEDS_RECONNECT`, `errorCode = KEY_INVALID`, `lastSyncStatus = FAILED` | resolves (no retry); later runs skip it until the key is replaced | nothing written; holdings keep their last value |
| 401/403 the probe does not confirm | stays `ACTIVE`, `lastSyncStatus = FAILED` | throws `UNAVAILABLE`, retried (3 attempts, 60 s backoff) | nothing written |
| 5xx, network error, timeout, 429 after one retry | stays `ACTIVE`, `lastSyncStatus = FAILED` | retried; final failure → `PROCESSING_FAILED` | nothing written |
| Response shape changed (`SHAPE_CHANGED`) | stays `ACTIVE`, `lastSyncError = SHAPE_CHANGED` | `UnrecoverableError`: fails once, no retries, `PROCESSING_FAILED` | nothing written |
| Copy missing from eToro's response | unchanged | succeeds | copy `CLOSED`, last value kept |
| Instrument on an unknown exchange or without metadata | unchanged | succeeds | stored `unresolved`, counted in `unmappedPct`, logged `etoro_unmapped_instrument` |

Keys and eToro response bodies never appear in logs or error messages.

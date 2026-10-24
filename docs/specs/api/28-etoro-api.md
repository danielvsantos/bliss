# 28. eToro Copy Trading API

Routes that connect an eToro account with a Read key pair (#143), plus the "switch to Copy Trading" action. The sync, the valuation and the instrument mapping run in the backend; see the [backend spec](../backend/25-etoro-copy-trading.md). OpenAPI: [`etoro.yaml`](../../openapi/etoro.yaml).

**Scope.** Bliss follows the value and the composition of the user's own copies. It never creates, changes, suggests or reconciles a transaction from eToro data.

## Platform rules

- **Location and plumbing.** All routes live in `apps/api/pages/api/etoro/` and use `withAuth` and the `etoro` rate limiter (60 / 5 min). Every query is scoped by `req.user.tenantId`.
- **Integration tokens.** The `/api/etoro` prefix is on `INTEGRATION_DENYLIST`, so tokens get `403 NOT_AVAILABLE_TO_INTEGRATIONS`. Each route is `DENY_ALL` in `integrationRouteMatrix.data.ts`.
- **MCP.** No MCP tool wraps these routes. The MCP coverage test only counts token-reachable operations, so they need no exclusion entry. Agents see copies through `get_equity_analysis` (below).
- **Logic.** Everything lives in `services/etoro.service.js`; shared plumbing (rate limit, error mapping, admin-only answer) is in `utils/etoroRoute.js`.
- **Errors.** Errors go to Sentry without the request, because its body may hold a key.

**Keys.**
- The pair (`apiKey` = eToro's `x-api-key`, `userKey` = `x-user-key`) is checked against eToro before it is stored.
- It is encrypted at rest (`EtoroConnection.apiKey/userKey` in `encryptedFields` and `ROTATION_COVERAGE`).
- It never appears in a response: connections expose `keyLast4` (last 4 characters of the API key) only. Removing a connection overwrites both keys with `''`.

**Per-account keys only.** Each tenant uses its own key, and data fetched with it serves that tenant only. There is no operator key (eToro's Builders terms).

## Routes

| Route | Roles | Contract |
|---|---|---|
| `GET /api/etoro/connections` | all | `{ connections }`, removed connections excluded. Each connection: `{ id, etoroUsername, accountId, account { id, name }, keyLast4, scopes, status (ACTIVE \| NEEDS_RECONNECT), errorCode, connectedAt, lastSyncAt, lastSyncStatus, lastSyncError, copies }`. Each copy: `{ id, parentUsername, startedAt, status (ACTIVE \| CLOSED), closedAt, lastValue, lastValueCurrency, lastValueAt, cashPct, unmappedPct, holdingsCount, linkedHolding { id, symbol } \| null }`. |
| `POST /api/etoro/connections` | admin (inline check) | Connect; steps below. `201 { connection, copies }`, or `200` when it reactivates a removed connection of the same login. |
| `PUT /api/etoro/connections/:id` | admin (`requireRole`) | `{ apiKey, userKey }` replaces the key; `{ accountId }` changes the account; either or both. A new key must belong to the same eToro login (`409 ETORO_DIFFERENT_LOGIN`). It sets the connection `ACTIVE`, clears `errorCode` and starts a sync, without losing data. `400 NOTHING_TO_UPDATE` for an empty body; `400 CONNECTION_REMOVED` for a removed connection. |
| `DELETE /api/etoro/connections/:id` | admin | `204`. Status → `REMOVED`, keys wiped. Copies, daily values and the holdings' history stay. |
| `POST /api/etoro/connections/:id/sync` | admin | `202` and an `ETORO_SYNC` event. One manual sync per connection every **15 minutes**: Redis key `etoro:sync:cooldown:<id>`, or an in-process fallback without Redis; fail-open. A second call gets `429 { code: 'COOLDOWN', retryAfter }` with a `Retry-After` header. `400 CONNECTION_NOT_ACTIVE` unless the connection is `ACTIVE`. |
| `POST /api/etoro/convert-holding` | admin, member | Switches a holding to Copy Trading (R8); see below. |

### Connect (R1, R2)

In order. Nothing is stored unless every step passes.

1. **Validate the body.** `apiKey` and `userKey` are non-empty strings of at most 1,024 characters (`400 KEYS_REQUIRED` / `KEYS_INVALID_FORMAT`). `accountId` is an account of the tenant (`400 ACCOUNT_REQUIRED` / `ACCOUNT_NOT_FOUND`).
2. **Check the identity.** `GET /api/v1/me` with the key. eToro refuses it → `422 ETORO_KEY_INVALID`. Unreachable → `502 ETORO_UNAVAILABLE`. Rate limited → `429 ETORO_RATE_LIMITED`.
3. **Check the scopes.** `assertReadOnlyScopes()`: any scope not ending in `:read`, or none at all → `400 ETORO_WRITE_SCOPE { writeScopes }`, with guidance to create a Read key.
4. **Read the copies** for the preview: aggregate portfolio + raw portfolio, about 1 s in total.
5. **Check for duplicates.** The same eToro login (`etoroCid`, the real-account customer id) already connected in the tenant → `409 ETORO_ALREADY_CONNECTED { connectionId }`. A **removed** connection of that login is reactivated instead: same row, copies and values kept.
6. **Store and sync.** Store the connection (`connectedAt = now`) and send `ETORO_SYNC { connectionId, source: 'CONNECT' }`.
7. **Respond** with `{ connection, copies: [{ parentUsername, startedAt, value, currency }] }`.

### Convert a holding (R8)

Body `{ portfolioItemId, etoroUsername }`. The username is trimmed, a leading `@` is dropped, and it is lower-cased; it must match `^[a-z0-9][a-z0-9_.-]{1,39}$` (`400 INVALID_USERNAME`).

Checks, each answered with the code shown:
- The item belongs to the tenant: `404 NOT_FOUND` otherwise.
- It is not already Copy Trading: `400 ALREADY_COPY_TRADING`.
- Its category type is `Investments`: `400 NOT_AN_INVESTMENT`.
- The tenant has the Copy Trading category (code `COPY_TRADING`, or the hint): `409 COPY_TRADING_CATEGORY_MISSING`.
- No other holding of the same account already has that ticker: `409 COPY_HOLDING_EXISTS { portfolioItemId }`.

Then one `$transaction`:
- Every transaction of the item gets the Copy Trading category, `ticker = username` and no ISIN / exchange / asset currency. Amounts, dates and descriptions are unchanged.
- The `PortfolioItem` is updated **in place** (`categoryId`, `symbol = username`, `source = 'SYNCED'`). Its id stays, so `IncomeTerms`, manual values and value history stay attached.

Afterwards:
- `MANUAL_PORTFOLIO_PRICE_UPDATED { portfolioItemId }` revalues the holding, which links it when the account's connection has a copy of that investor.
- `CATEGORY_CLASSIFICATION_CHANGED { portfolioImpact: false }` is sent only when the old category was in another group, because analytics is keyed by group.

Response: `200 { portfolioItemId, symbol, categoryId, transactionsMoved }`.

A later full portfolio rebuild derives the same key (`TICKER` strategy + account), so the holding and its terms survive it.

## Link rule

A Copy Trading holding (category hint `COPY_TRADING`) is **linked** to a copy when:
- the tenant matches;
- the copy's connection maps to the holding's account;
- the copy's `parentUsername` equals the holding's ticker, lower-cased.

**One form of the username.** A holding's key is its exact ticker, so a Copy Trading ticker is always stored as the username lower-cased, without a leading `@` (`copyTradingTicker()`): `POST` / `PUT /api/transactions` normalise it, the backend's `generateAssetKey()` does the same for imports, and the web form doesn't upper-case it. Otherwise a deposit typed `AmitKup` after a switch to `amitkup` would start a second holding, and both would link to the copy and count its value twice. The switch's duplicate check compares case-insensitively.

When several copies match (a stopped and restarted copy), an `ACTIVE` one wins, then the most recently started. Nothing stores the link (`findCopiesForItems()`), so portfolio rebuilds can't break it. The backend valuation and the #80 insights apply the same rule.

`copyTradeStatus(copy)` → `{ linked: false }`, or `{ linked: true, copyId, status (ACTIVE | CLOSED), connectionStatus (ACTIVE | NEEDS_RECONNECT | REMOVED), lastValueAt, unmappedPct }`. It is returned as:
- `copyTrade` on every Copy Trading holding of `GET /api/portfolio/items`, for the "Linked to eToro" / "needs reconnect" / "copy closed on eToro" badges (R12);
- `copyTrade` on every copy row of Equity Analysis.

## Equity Analysis and MCP

See [Portfolio API §6.7](./06-portfolio-api.md#67-equity-analysis). In short:
- A linked copy is one copy row (`assetType` and `assetClass` `COPY_TRADE`, in `copies`) with a composition derived on read from its own holdings and SecurityMaster (`loadCopyLookThrough()` → `deriveCopyComposition()`).
- With look-through on, `holdings` and the groups show the copy's **positions** instead (`explodeCopyHoldings()`, one row per security: a position is added to the same security held directly, and `viaCopies` says what each copy holds), so the Top 10 and the table list the equities the copy holds. With it off, the copy row is one `Diversified` / `COPY_TRADE` holding.
- Its value is the stored eToro value; there is no live price.
- MCP `get_equity_analysis` returns the same groups. `copies` lists each copy with a `copyTrade` block: `{ linked, status, lookThroughCoveragePct, peCoveragePct, yieldCoveragePct, unmappedPct }`; rows in `topHoldings` that copies hold part of carry `viaCopies` (`[{ username, value }]`), and a copy kept whole carries the `copyTrade` block itself.

## Passive income

A Copy Trading holding projects no cash income and is never "missing terms" (`classifyIncomeAsset()` → `null`): dividends are paid inside the copy (R19).

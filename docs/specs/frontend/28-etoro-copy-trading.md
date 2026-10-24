# 28. eToro Copy Trading (Frontend)

Task #143. API: [`docs/specs/api/28-etoro-api.md`](../api/28-etoro-api.md). Backend: [`docs/specs/backend/25-etoro-copy-trading.md`](../backend/25-etoro-copy-trading.md). User guide: [eToro Copy Trading](../../guides/etoro-copy-trading.md).

The web app connects an eToro account, shows its copies, flags each Copy Trading holding's link status, offers "Switch to Copy Trading" in Manage Assets, and renders copies on Equity Analysis. Colors are design tokens only.

## 28.1. Data layer

| File | Role |
|---|---|
| `src/types/api.ts` | `CopyTradeStatus`, `EtoroConnection`, `EtoroCopy`, `EtoroConnectRequest` / `Response`, `EtoroUpdateRequest`, `ConvertToCopyTradingResponse`; `PortfolioItem.copyTrade`. |
| `src/types/equity-analysis.ts` | `ASSET_CLASSES` gains `COPY_TRADE`, placed **last** so the other classes keep their `ASSET_CLASS_COLORS`. `OVERRIDE_ASSET_CLASSES` excludes it and is the list every override picker uses (Equity Analysis editor, Manage Assets modal). `EquityHolding` gains `assetType: 'COPY_TRADE'`, `peCoverage`, `yieldCoverage`, `sectorCoveragePct`, `countryCoveragePct`, `unmappedPct`, `assetClassMix` and `copyTrade`; the summary gains `copyTradeCount`. |
| `src/lib/api.ts` | `getEtoroConnections`, `connectEtoro`, `updateEtoroConnection`, `removeEtoroConnection`, `syncEtoroConnection`, `convertToCopyTrading`. Raw JSON responses, with no numeric coercion. |
| `src/hooks/use-etoro.ts` | `useEtoroConnections` (30 s stale). Connect / replace / remove / convert invalidate `['etoro']`, `['portfolio-items']`, `['equity-analysis']` and `['portfolio-assets']`; sync invalidates `['etoro']`. Connect and replace use `gcTime: 0`, so the keys never outlive the request. `etoroError()` reads `{ code, retryAfter, writeScopes }`. |
| `src/lib/etoro.ts` | `copyTradeBadgeState()` (needs-reconnect > closed > linked; unlinked = `notLinked`), `normalizeEtoroUsername()` / `isValidEtoroUsername()` (mirror the API). |

## 28.2. Settings → Bank sync → eToro copy trading — `components/settings/etoro-section.tsx`

Rendered under the Enable Banking credentials in the admin-only **Bank sync** tab.
- **Header.** The title, a short "read-only, never trades or creates transactions" note, a link to the guide, and **Connect eToro**.
- **Connection card.** The eToro username, a status badge (`ACTIVE` positive, `NEEDS_RECONNECT` warning), the Bliss account, the key as `••••<last4>`, the last sync, and the last failure code when the last sync failed.
- **Actions.**
  - **Sync now** (ACTIVE only): a `429 COOLDOWN` toasts "Try again in N min".
  - **Replace key**: the primary button when the connection needs a new key.
  - **Remove**: asks for confirmation; holdings and history stay.
- **Copies.** One row per copy: `@investor`, start date, "Closed on eToro", last value, and either "Linked to <holding>" (positive) or "Not linked" (warning). The card ends with a hint on how to link the unlinked copies (ticker = username in that account, or "Switch to Copy Trading").

## 28.3. Connect / replace dialog — `components/etoro/connect-etoro-dialog.tsx`

- **Fields.** API key, user key (`type="password"`), and the Bliss account (a Radix select over `useAccounts()`; hidden when replacing). It links to the guide (R5).
- **Submit.** Calls connect or `PUT` with the key pair. Known errors have their own message: `ETORO_WRITE_SCOPE`, `ETORO_KEY_INVALID`, `ETORO_UNAVAILABLE`, `ETORO_RATE_LIMITED`, `ETORO_ALREADY_CONNECTED`, `ETORO_DIFFERENT_LOGIN`, `KEYS_REQUIRED`, `ACCOUNT_REQUIRED`. Anything else is a generic error.
- **Success.** Connecting shows "Connected as <username>" and the copies with their values (R2). Replacing closes the dialog.
- **Keys.** They live in component state only and are cleared on success and on close.

## 28.4. Holdings badges — `components/etoro/copy-trade-badge.tsx`

Shown next to the symbol of every Copy Trading holding on **Portfolio** (`AssetRow`) and on every copy row of **Equity Analysis** (R12). The tooltip carries the date of the last eToro value.

| State | Badge |
|---|---|
| Linked | `bg-positive/10 text-positive` "Linked to eToro" |
| Key needs replacing (connection `NEEDS_RECONNECT`) | `bg-warning/10 text-warning` |
| Copy closed on eToro | muted |
| Not linked | muted |

## 28.5. Manage Assets — "Switch to Copy Trading"

- **Where.** `availableModals()` adds `copyTrading` for investment holdings in the **Funds** group that aren't Copy Trading yet (`canSwitchToCopyTrading()`). The server accepts any investment holding; the UI narrows it to where copies are recorded today.
- **Modal.** The `?modal=copyTrading` modal (`components/etoro/convert-to-copy-trading-modal.tsx`) asks for the investor's username. Submit stays disabled until the username is valid.
- **Errors.** `INVALID_USERNAME`, `COPY_HOLDING_EXISTS` and `COPY_TRADING_CATEGORY_MISSING` have their own messages.
- **Success.** It toasts and closes.

## 28.6. Equity Analysis

- **Copy positions (look-through on).** The API replaces a linked copy by its positions (`viaCopy`, [Portfolio API §6.7](../api/06-portfolio-api.md#67-equity-analysis)), so the **Top 10** and **All holdings** show the equities the copy holds:
  - each position row shows its symbol, a muted "via @investor" badge and a read-only asset-class badge (a copy's positions have nothing to override);
  - the copy's cash and its unidentified share are named "Cash" and "Unidentified" (`equityAnalysis.copyCash` / `copyUnmapped`);
  - a position is never merged with a direct holding of the same symbol, so rows and Top 10 bars are keyed by `rowKey()` (the API `key`, else the item ids), and the Top 10 axis shows the symbol;
  - above the table, each split copy (from `copies`) is listed: `@investor`, its link badge, "<value> split into N positions" and the unmapped share.
- **Switch label.** When the tenant has a copy (`summary.copyTradeCount > 0`) the look-through switch reads "Look through ETFs and copies" (`equityAnalysis.lookThroughWithCopies`, with its own hint); otherwise it stays "Look through ETFs".
- **Copy rows** (`assetType: 'COPY_TRADE'`, look-through off or an unlinked copy) show the copy badge plus the asset-class badge `COPY_TRADE` ("Copy trade"). The name is `@investor`.
- **Coverage labels.** P/E and yield get "based on N% of value" when the coverage is under 100% (R17). An unmapped share of at least 0.5% shows as "N% unmapped" (R16), in warning color.
- **Row keys** use the merged item ids, so two copies of the same investor in two accounts never collide.
- **Groups.** The donut and groups come from the API: sector, country and asset-class mix with look-through on, and one "Diversified" / `COPY_TRADE` bucket with it off. `COPY_TRADE` translates through `equityAnalysis.assetClasses`.

## 28.7. Transaction form

For a category with the `COPY_TRADING` hint:
- the ticker field is labelled **eToro username**, with its own placeholder, and the ticker search is off (a username is not a market symbol);
- price and quantity are hidden and cleared, replaced by a hint (`copyTradeAmountHint`). A copy has no unit price: the portfolio calculator counts a buy without a quantity as one unit at its amount and sells a withdrawal without a quantity pro rata to cost, and the market value is eToro's total. A fixed quantity of 1 on a withdrawal would close the whole position, which is why the field isn't offered.

## 28.7a. Categories page

`PROCESSING_HINT_STYLE` gives `COPY_TRADING` the same positive badge as the price-API hints (it is backed by a live feed), labelled `defaultCategories.processingHints.COPY_TRADING` ("eToro Copy Trading").

## 28.8. i18n

New keys in all 5 locales:
- `etoro.*`: section, status, connection, copy, dialog, errors, badge and convert strings;
- `equityAnalysis.assetClasses.COPY_TRADE`, `equityAnalysis.basedOn`, `equityAnalysis.unmapped`, `equityAnalysis.copyBadge`, `equityAnalysis.viaCopy`, `equityAnalysis.copyCash`, `equityAnalysis.copyUnmapped`, `equityAnalysis.copySplit`, `equityAnalysis.lookThroughWithCopies`, `equityAnalysis.lookThroughHintWithCopies`;
- `manageAssets.actions.copyTrading`;
- `transactionFormPage.etoroUsernameLabel` / `etoroUsernamePlaceholder` / `copyTradeAmountHint`;
- `defaultCategories.names.COPY_TRADING`, `defaultCategories.processingHints.COPY_TRADING`;
- `activity.stages.syncing_copies`.

## 28.9. Tests

- **`hooks/use-etoro.test.tsx`:** list; connect payload, invalidations and no cached variables; the cooldown error body; convert payload.
- **`lib/etoro.test.ts`:** badge states; username normalization.
- **`components/settings/etoro-section.test.tsx`:** empty state; card with masked key and link states; the "Sync now" cooldown toast; the connect flow (write-scope error, then success with username and copies).
- **`components/etoro/*.test.tsx`:** badge states; the convert modal (validation, normalized payload, clash error).
- **`pages/reports/equity-analysis.test.tsx`:** the copy row (badge, coverage label, unmapped share, needs-reconnect state); a split copy ("via" rows next to a direct holding of the same symbol, the copy strip, no override editor on positions); `COPY_TRADE` never offered as an override.
- **`lib/manage-assets.test.ts`:** which holdings get `copyTrading`.
- **`components/entities/transaction-form.test.tsx`:** a Copy Trading transaction shows the username label and the hint, and saves with no price or quantity.
- **`i18n/i18n-parity.test.ts`:** the form and hint keys exist at their full path in every locale.

# MCP Tool Reference

<!-- Generated from apps/api/lib/mcp/registry.js by `pnpm --filter @bliss/api mcp:reference`. Do not edit by hand. -->

Bliss exposes **41 tools** over MCP at `POST /api/mcp`: **22 read** tools available to every integration key and **19 write** tools available only to *Read & write* keys. Setup: [Use Bliss with Claude (MCP)](/docs/guides/using-bliss-with-claude-mcp).

Conventions: dates are `YYYY-MM-DD`; amounts are `{ value, currency }`; transaction amounts are signed (positive = money in, negative = money out); lists return `hasMore` and `nextCursor` — pass `nextCursor` back as `cursor` for the next page (default 50 items, max 100).

## Reference data

### `list_accounts` — List accounts

**Access:** Read (all keys)  
**Wraps:** `GET /api/accounts`

List the user's bank, card and brokerage accounts with their IDs, bank, currency and country. Use the returned `id` as accountId in other tools.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `currencyCode` | string | no | Only accounts in this currency (ISO code). |
| `countryId` | string | no | Only accounts in this country (ISO country code). |
| `limit` | integer | no | Items per page (1-100, default 100). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `list_categories` — List categories

**Access:** Read (all keys)  
**Wraps:** `GET /api/categories`

List transaction categories with their IDs, group and type (e.g. type "Essentials", group "Food"). Categories are what transactions, review items and import rows are classified into. Filter by name (partial, case-insensitive), group or type.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | no | Partial category name, case-insensitive. |
| `group` | string | no | Exact category group, e.g. "Food". |
| `type` | string | no | Exact category type, e.g. "Income", "Essentials", "Investments". |
| `limit` | integer | no | Items per page (1-100, default 100). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `get_reference_data` — Get reference data

**Access:** Read (all keys)  
**Wraps:** `GET /api/tenants`, `GET /api/tenants/settings`, `GET /api/banks`, `GET /api/countries`, `GET /api/currencies`, `GET /api/currency-rates`

Reference data for the user's workspace. `tenant`: display (portfolio) currency, enabled currencies and countries, years that have transactions, and classification thresholds — call it first to learn the currency to use for summaries. `banks`, `countries`, `currencies`: global lists (use `search` to filter). `fxRates`: stored exchange rates for one date (requires fxDate).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kinds` | array of `tenant` \| `banks` \| `countries` \| `currencies` \| `fxRates` | no | Which lists to return (default ["tenant"]). |
| `search` | string | no | Substring filter for banks, countries and currencies. |
| `fxDate` | string | no | Date of the FX rates (YYYY-MM-DD) |
| `fxFrom` | string | no | FX rates from this currency only. |
| `fxTo` | string | no | FX rates to this currency only. |

### `search_ticker` — Search tickers

**Access:** Read (all keys)  
**Wraps:** `GET /api/ticker/search`

Look up stock, ETF or crypto tickers by symbol or company name (market data provider search).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Symbol or name, e.g. "VWCE" or "Apple". |
| `type` | string | no | Optional instrument type filter passed to the provider. |
| `limit` | integer | no | Max results (default 20). |

### `list_tags` — List tags

**Access:** Read (all keys)  
**Wraps:** `GET /api/tags`

List tags (free labels such as trips or projects, optionally with a budget and date range) with their IDs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Items per page (1-100, default 100). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `manage_tags` — Create, update or delete a tag

**Access:** Write (Read & write keys only) · can delete or discard data  
**Wraps:** `POST /api/tags`, `PUT /api/tags`, `DELETE /api/tags`

create: new tag (name required). update: change name, color, emoji, budget or dates of tagId. delete: remove tagId (refused while transactions still use it). Tag transactions with update_transaction.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `create` \| `update` \| `delete` | yes |  |
| `tagId` | integer | no | Tag ID (update/delete). From list_tags. |
| `name` | string | no |  |
| `color` | string | no | Hex color, e.g. "#6D657A". |
| `emoji` | string | no |  |
| `budget` | number \| null | no | Budget amount; null clears it. |
| `startDate` | string \| null | no | Start date (YYYY-MM-DD) |
| `endDate` | string \| null | no | End date (YYYY-MM-DD) |

## Workspace setup

### `create_bank` — Create bank

**Access:** Write (Read & write keys only)  
**Wraps:** `POST /api/banks`

Add a bank (or broker, card issuer…) to the user's workspace and return its ID for create_account. Idempotent: if a bank with this name already exists (any casing) it is reused and linked, never duplicated; `created` is false when the workspace already had it. This is the way to get a bankId — the banks in get_reference_data are a global list that may include banks this workspace has not linked. Bank creation shares a budget of 10 requests per 5 minutes with bank listing: reuse IDs you already have (from list_accounts or earlier calls) instead of calling this again.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Bank name, e.g. "Revolut" (2-100 characters). |

### `create_account` — Create account

**Access:** Write (Read & write keys only)  
**Wraps:** `POST /api/accounts`

Create a manual account (bank, card, savings, brokerage…) in the user's workspace, then use its `id` as accountId when creating transactions or importing. Get bankId from create_bank. currencyCode and countryId must already be enabled for the workspace (get_reference_data → tenant lists them); if not, ask the user to enable them in Settings. Owners default to the admin who connected Bliss; other users can be added in the app. Safe to retry: a second account with the same bank, currency and name is refused with the existing account's id. Bank-synced (Plaid) accounts are connected in the app, not here.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Account name, e.g. "Revolut EUR" (1-100 characters). |
| `bankId` | integer | yes | Bank ID from create_bank. |
| `currencyCode` | string | yes | Account currency, 3-letter ISO 4217 code, e.g. EUR. |
| `countryId` | string | yes | Account country, ISO 3166 alpha-3 code as listed by get_reference_data (e.g. DEU, USA, GBR). |
| `accountNumber` | string | yes | Account number or IBAN. Stored encrypted and never shown back (only the last 4 characters) — use the last 4 digits or a short label if the user prefers not to share it. |
| `ownerIds` | array of string | no | User IDs of the owners. Omit to make the connecting admin the owner. |

## Transactions

### `search_transactions` — Search transactions

**Access:** Read (all keys)  
**Wraps:** `GET /api/transactions`

Search committed transactions, newest first. Amounts are signed: positive = money in (credit), negative = money out (debit), in the transaction's own currency. Filter by date range, account, category, category group/type, tag, currency or source. Descriptions are encrypted at rest and cannot be searched: to find a merchant use get_merchant_history, or narrow by date/category and read the page. `totals` (sum of the whole filtered set) is only returned when `currency` is set.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | string | no | Start date, inclusive (YYYY-MM-DD) |
| `to` | string | no | End date, inclusive (YYYY-MM-DD) |
| `accountId` | integer | no | Account ID from list_accounts. |
| `categoryId` | integer | no | Category ID from list_categories. |
| `categoryGroup` | string | no | Category group, e.g. "Food". |
| `categoryType` | string | no | Category type, e.g. "Essentials" or "Income". |
| `tag` | string | no | Tag name or tag ID. |
| `currency` | string | no | Only transactions in this currency. |
| `source` | `MANUAL` \| `PLAID` \| `CSV` | no |  |
| `limit` | integer | no | Items per page (1-100, default 50). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `get_merchant_history` — Get merchant history

**Access:** Read (all keys)  
**Wraps:** `GET /api/transactions/merchant-history`

Past bank-synced (Plaid) transactions whose merchant or name contains `description`, with the category each was filed under — useful to decide how to categorise a new charge from the same merchant.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `description` | string | yes | Merchant name or part of it. |
| `limit` | integer | no | Max results (default 10). |

### `create_transaction` — Create transaction

**Access:** Write (Read & write keys only)  
**Wraps:** `POST /api/transactions`

Record a manual transaction. Same effect as adding it in the app: analytics and portfolio update and the category choice trains the classifier. Stock, ETF/fund and crypto categories (buys and sells) require assetQuantity and assetPrice (both > 0) and a ticker. Only in the built-in Funds category is the ticker optional (private / unlisted funds have none); ETFs always need one. All three are optional for manually valued investments.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `date` | string | yes | Transaction date (YYYY-MM-DD) |
| `accountId` | integer | yes | Account ID from list_accounts. |
| `categoryId` | integer | yes | Category ID from list_categories. |
| `description` | string | yes |  |
| `amount` | number | yes | Signed amount: positive = money in (credit), negative = money out (debit). |
| `currency` | string | yes | ISO currency of the amount, usually the account currency. |
| `details` | string | no | Free-text note. |
| `tags` | array of string | no | Tag names (created if new). |
| `ticker` | string | no |  |
| `assetQuantity` | number | no |  |
| `assetPrice` | number | no |  |

### `update_transaction` — Update transaction

**Access:** Write (Read & write keys only)  
**Wraps:** `GET /api/transactions`, `PUT /api/transactions`

Change fields of a transaction (only the ones you pass). Re-categorising here is identical to doing it in the app: it teaches the classifier and refreshes analytics. `tags` replaces the whole tag list. A stock, ETF/fund or crypto transaction must end up with assetQuantity and assetPrice (both > 0) and a ticker (optional only in the built-in Funds category).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `transactionId` | integer | yes | Transaction ID from search_transactions. |
| `date` | string | no | New date (YYYY-MM-DD) |
| `accountId` | integer | no | New account ID. |
| `categoryId` | integer | no | New category ID. |
| `description` | string | no |  |
| `details` | string \| null | no |  |
| `amount` | number | no | Signed amount: positive = money in (credit), negative = money out (debit). |
| `currency` | string | no |  |
| `tags` | array of string | no | Full list of tag names (replaces). |
| `ticker` | string | no |  |
| `assetQuantity` | number | no |  |
| `assetPrice` | number | no |  |

### `delete_transaction` — Delete transaction

**Access:** Write (Read & write keys only) · can delete or discard data  
**Wraps:** `DELETE /api/transactions`

Permanently delete a transaction. A bank-synced source item goes back to the review queue.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `transactionId` | integer | yes | Transaction ID from search_transactions. |

## Analytics, insights & notifications

### `get_spending_summary` — Get income and spending summary

**Access:** Read (all keys)  
**Wraps:** `GET /api/analytics`, `GET /api/tenants/settings`

Income and spending totals per period, by category type and category group, from the same pre-computed analytics as the Analytics page (all currencies converted into one). `in` = credits, `out` = debits (positive numbers), `net` = in - out. For a single category (not group), sum search_transactions instead.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `view` | `month` \| `quarter` \| `year` | yes | Period granularity. |
| `from` | string | yes | First period: "YYYY-MM" (month), "YYYY-Qn" (quarter) or "YYYY" (year). |
| `to` | string | yes | Last period, same format as from (inclusive). |
| `currency` | string | no | Currency the totals are expressed in (default: the display currency from get_reference_data). |
| `types` | array of string | no | Only these category types, e.g. ["Essentials"]. |
| `groups` | array of string | no | Only these category groups, e.g. ["Food"]. |
| `countries` | array of string | no | Only accounts in these countries (ISO codes). |
| `limit` | integer | no | Items per page (1-100, default 100). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `get_tag_summary` — Get tag summary

**Access:** Read (all keys)  
**Wraps:** `GET /api/analytics/tags`, `GET /api/tenants/settings`

Income and spending for tagged transactions (e.g. a trip), per tag and period, broken down by category. Amounts in one currency; `out` = spending, `in` = income.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tagIds` | array of integer | yes | Tag IDs from list_tags. |
| `view` | `month` \| `quarter` \| `year` | yes | Period granularity. |
| `from` | string | yes | First period: "YYYY-MM" (month), "YYYY-Qn" (quarter) or "YYYY" (year). |
| `to` | string | yes | Last period, same format as from (inclusive). |
| `currency` | string | no | Currency the totals are expressed in (default: the display currency from get_reference_data). |

### `list_insights` — List insights

**Access:** Read (all keys)  
**Wraps:** `GET /api/insights`

AI-generated financial insights: tiers MONTHLY, QUARTERLY and ANNUAL health checks, and PORTFOLIO notes (generated weekly; there is no WEEKLY tier), most important first. Dismissed insights are hidden unless includeDismissed is true.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tier` | `MONTHLY` \| `QUARTERLY` \| `ANNUAL` \| `PORTFOLIO` | no |  |
| `category` | `SPENDING` \| `INCOME` \| `SAVINGS` \| `PORTFOLIO` \| `DEBT` \| `NET_WORTH` | no |  |
| `severity` | `INFO` \| `WARNING` \| `POSITIVE` \| `CRITICAL` | no |  |
| `periodKey` | string | no | e.g. "2026-03" (MONTHLY), "2026-Q1" (QUARTERLY), "2025" (ANNUAL), "2026-W14" (PORTFOLIO). |
| `includeDismissed` | boolean | no |  |
| `limit` | integer | no | Items per page (1-100, default 20). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `generate_insights` — Generate insights

**Access:** Write (Read & write keys only)  
**Wraps:** `POST /api/insights`

Start AI insight generation for a period (runs in the background; check list_insights in a few minutes). Defaults to the current month/quarter/year. Unchanged data is skipped unless force is true.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tier` | `MONTHLY` \| `QUARTERLY` \| `ANNUAL` \| `PORTFOLIO` | yes |  |
| `year` | integer | no |  |
| `month` | integer | no | MONTHLY only. |
| `quarter` | integer | no | QUARTERLY only. |
| `force` | boolean | no |  |

### `dismiss_insight` — Dismiss or restore an insight

**Access:** Write (Read & write keys only)  
**Wraps:** `PUT /api/insights`

Hide an insight (dismissed: true, the default) or bring it back (dismissed: false).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `insightId` | string | yes | Insight ID from list_insights. |
| `dismissed` | boolean | no |  |

### `get_notifications_summary` — Get notifications summary

**Access:** Read (all keys)  
**Wraps:** `GET /api/notifications/summary`

What needs the user's attention: pending review items (bank sync + imports), failed classifications, bank connections needing action, new insights and onboarding steps.

_No parameters._

### `get_processing_status` — Get background processing status

**Access:** Read (all keys)  
**Wraps:** `GET /api/activity`

Whether derived data is still being recalculated after a change. Writes (transactions, tags, manual values, imports, bank-sync approvals) refresh portfolio values and analytics in the background: poll this until `inFlight` has nothing whose `affects` includes the data you changed (`settled` = nothing in flight at all), then read the summaries. `summary` has one row per activity type (PORTFOLIO_UPDATE, ANALYTICS_UPDATE, BANK_SYNC, IMPORT, SECURITY_DATA, SUBSCRIPTION_SCAN, INSIGHTS) with state queued | running | stalled | failed, stage and progress (0-100). `lastCompletedAt` is per type; `recent` holds the latest finished jobs (last 24 h) with errorCode on failures. `available: false` means status is unknown, not idle; `workerOnline: false` means the background worker is down and queued work will not start.

_No parameters._

## Bank-sync (Plaid) review queue

### `get_plaid_review_queue` — Get bank-sync review queue

**Access:** Read (all keys)  
**Wraps:** `GET /api/plaid/transactions`

Bank-synced transactions waiting for review, each with an AI-suggested category and confidence (0-1). Default status CLASSIFIED = ready to approve. FAILED = classification failed (retry with requeue_plaid_transactions). SKIPPED = the user skipped them. Amounts: negative = money out. `summary` counts items per status. Approve or re-categorise with review_plaid_transactions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | `CLASSIFIED` \| `PENDING` \| `SKIPPED` \| `FAILED` \| `PROMOTED` \| `ALL` | no |  |
| `minConfidence` | number | no |  |
| `maxConfidence` | number | no |  |
| `categoryId` | integer | no | Only items suggested into this category. |
| `uncategorized` | boolean | no | Only items without a suggested category. |
| `limit` | integer | no | Items per page (1-100, default 50). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `review_plaid_transactions` — Review bank-sync items

**Access:** Write (Read & write keys only)  
**Wraps:** `PUT /api/plaid/transactions/[id]`, `POST /api/plaid/transactions/bulk-promote`

Act on review queue items. `items` (max 50): approve (creates the transaction; optional categoryId overrides the suggestion), recategorize (categoryId required, stays in the queue), skip, or unskip. Investment categories need ticker, assetQuantity and assetPrice to approve. `bulkPromote` approves many at once: every CLASSIFIED item with confidence >= minConfidence, or exactly the given ids. Pass either items or bulkPromote.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `items` | array of object { id, action, categoryId, ticker, assetQuantity, assetPrice, details } | no |  |
| `bulkPromote` | object { minConfidence, ids, categoryId, overrideCategoryId } | no |  |

### `requeue_plaid_transactions` — Re-queue bank-sync items

**Access:** Write (Read & write keys only)  
**Wraps:** `POST /api/plaid/transactions/[id]/retry`, `POST /api/plaid/transactions/bulk-requeue`

`failedIds`: retry classification of FAILED items (max 50). `allSkipped: true`: send every SKIPPED item back to the review queue (optionally only for one plaidItemId).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `failedIds` | array of string | no |  |
| `allSkipped` | boolean | no |  |
| `plaidItemId` | string | no | Bank connection ID (plaidItemId from the queue items). |

### `list_plaid_seeds` — List bank-sync seeds

**Access:** Read (all keys)  
**Wraps:** `GET /api/plaid/transactions/seeds`

After a new bank connection, its most frequent merchants are held back as "seeds" for the user to confirm once. Lists them for one plaidItemId (from get_plaid_review_queue items or the notifications summary).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `plaidItemId` | string | yes |  |
| `limit` | integer | no | Max seeds (default 15). |

### `confirm_plaid_seeds` — Confirm bank-sync seeds

**Access:** Write (Read & write keys only)  
**Wraps:** `POST /api/plaid/transactions/confirm-seeds`

Confirm categories for seeds from list_plaid_seeds. Each confirmed seed trains the classifier and releases the held transactions of that merchant.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `plaidItemId` | string | yes |  |
| `seeds` | array of object { description, rawName, categoryId } | yes |  |

## Smart Import review

### `list_imports` — List staged imports

**Access:** Read (all keys)  
**Wraps:** `GET /api/imports/pending`, `GET /api/imports/[id]`

Without importId: imports (uploaded statements) that still have rows to review. With importId: that import's status, row counts per status, category summary and a page of rows. Files are uploaded in the Bliss app — if nothing is pending, ask the user to upload the statement there first. Row statuses: PENDING (needs review), CONFIRMED (will be committed), POTENTIAL_DUPLICATE, DUPLICATE, SKIPPED, ERROR.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `importId` | string | no |  |
| `status` | array of `PENDING` \| `CONFIRMED` \| `POTENTIAL_DUPLICATE` \| `DUPLICATE` \| `SKIPPED` \| `ERROR` \| `STAGED` | no | Only rows with these statuses (importId only). |
| `uncategorized` | boolean | no | Only rows without a suggested category (importId only). |
| `categoryId` | integer | no | Only rows suggested into this category (importId only). |
| `limit` | integer | no | Items per page (1-100, default 50). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `review_import_rows` — Review staged import rows

**Access:** Write (Read & write keys only)  
**Wraps:** `PUT /api/imports/[id]/rows/[rowId]`, `POST /api/imports/[id]/bulk-confirm`

`rows` (max 50): set a row's category, status (CONFIRMED to include it in the commit, SKIPPED to leave it out, PENDING to undo), account, details, tags or investment fields. `bulkConfirm`: confirm every reviewable row at once, or only those suggested into categoryId, or only uncategorised ones. Pass either rows or bulkConfirm. Commit afterwards with finalize_import.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `importId` | string | yes | Import ID from list_imports. |
| `rows` | array of object { rowId, categoryId, status, accountId, details, tags, ticker, assetQuantity, assetPrice } | no |  |
| `bulkConfirm` | object { categoryId, uncategorized } | no |  |

### `list_import_seeds` — List import seeds

**Access:** Read (all keys)  
**Wraps:** `GET /api/imports/[id]/seeds`

The most frequent descriptions in a staged import with their suggested category — confirming these first categorises many rows at once (confirm_import_seeds).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `importId` | string | yes | Import ID from list_imports. |
| `limit` | integer | no | Max seeds (default 15). |

### `confirm_import_seeds` — Confirm import seeds

**Access:** Write (Read & write keys only)  
**Wraps:** `POST /api/imports/[id]/confirm-seeds`

Confirm a category for each seed description: every PENDING/CONFIRMED row with that exact description gets the category and is marked CONFIRMED, and the classifier learns it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `importId` | string | yes | Import ID from list_imports. |
| `seeds` | array of object { description, categoryId } | yes |  |

### `finalize_import` — Commit or cancel a staged import

**Access:** Write (Read & write keys only) · can delete or discard data  
**Wraps:** `POST /api/imports/[id]`

commit: create transactions from the import's CONFIRMED rows (optionally only rowIds); runs in the background — poll list_imports with importId for progress. cancel: discard the import and all its rows.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `importId` | string | yes | Import ID from list_imports. |
| `action` | `commit` \| `cancel` | yes |  |
| `rowIds` | array of string | no | commit only: a subset of rows. |

## Portfolio & passive income

### `get_portfolio_holdings` — Get portfolio holdings

**Access:** Read (all keys)  
**Wraps:** `GET /api/portfolio/items`, `GET /api/portfolio/assets`, `GET /api/portfolio/holdings`

view "positions" (default): current investments, assets and debts with quantity, market value, cost basis and P&L in the holding's currency plus `marketValueDisplay` in the display currency. view "attention": the Manage Assets list with what needs action (stale manual price, missing income or debt terms, lot mismatch). view "snapshots": stored daily holding snapshots (quantity/value/cost) for one ticker or account. Use the `assetId` in the other portfolio tools.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `view` | `positions` \| `attention` \| `snapshots` | no |  |
| `accountId` | integer | no | Only holdings in this account. |
| `categoryType` | `Investments` \| `Asset` \| `Debt` | no | positions only. |
| `search` | string | no | attention only: symbol/name search. |
| `status` | `stale` \| `debtTermsMissing` \| `incomeMissing` \| `lotMismatch` \| `dividendOverride` \| `assetClassOverridden` | no | attention only: filter by status. |
| `ticker` | string | no | snapshots only: symbol. |
| `limit` | integer | no | Items per page (1-100, default 50). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `get_portfolio_history` — Get portfolio value history

**Access:** Read (all keys)  
**Wraps:** `GET /api/portfolio/history`

Total portfolio value over time (net worth of investments, assets and debts) in the display currency, with the split per category type. Prefer resolution "monthly" or "weekly" for long ranges.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | string | no | Start date (YYYY-MM-DD) |
| `to` | string | no | End date (YYYY-MM-DD) |
| `resolution` | `daily` \| `weekly` \| `monthly` | no |  |
| `types` | array of `Investments` \| `Asset` \| `Debt` | no |  |
| `groups` | array of string | no | Only these category groups. |
| `accountId` | integer | no | Only this account. |
| `limit` | integer | no | Items per page (1-100, default 100). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `get_equity_analysis` — Get equity analysis

**Access:** Read (all keys)  
**Wraps:** `GET /api/portfolio/equity-analysis`

Stock and ETF holdings grouped by sector, industry, country or asset class, with weights, weighted P/E and dividend yield. ETFs are looked through into their sectors/countries unless lookThrough is false. `pendingSecurityData` lists fund symbols left out until their security data is fetched.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `groupBy` | `sector` \| `industry` \| `country` \| `assetClass` | no |  |
| `accountId` | integer | no | Only this account. |
| `lookThrough` | boolean | no |  |
| `topHoldings` | integer | no | How many largest holdings to include (default 20). |

### `get_passive_income` — Get passive income projection

**Access:** Read (all keys)  
**Wraps:** `GET /api/portfolio/passive-income`, `GET /api/portfolio/income-terms/detached`, `GET /api/passive-income/streams`

Projected dividends, bond coupons, rent, interest and other income streams for the next 12/24/36 months (display currency), next to the last 12 months of actual passive income. Also lists holdings missing income terms, user-defined income streams and detached terms left over from re-keyed holdings. Every amount is in the display currency (`currency`); the monthly/yearly series are plain numbers in it. `byHolding[].holdingCurrency` is the holding's own currency, for reference only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `horizon` | `12` \| `24` \| `36` | no |  |

### `get_holding_details` — Get holding details

**Access:** Read (all keys)  
**Wraps:** `GET /api/portfolio/items/[assetId]/asset-class`, `GET /api/portfolio/items/[assetId]/income-terms`, `GET /api/portfolio/items/[assetId]/debt-terms`, `GET /api/portfolio/items/[assetId]/manual-values`

Everything about one holding: asset class (and whether it is overridden), income terms (dividends, coupons, rent, interest), debt terms (loans) and the most recent manual valuations (per-unit prices). `incomeTermsKind` (STOCK, ETF, FUND, BOND, REAL_ESTATE, CASH, OTHER) is the income terms form, not the asset class.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `assetId` | integer | yes | Asset (portfolio item) ID from get_portfolio_holdings. |
| `manualValuesLimit` | integer | no | Most recent manual values (default 20). |

### `set_asset_class` — Set asset class

**Access:** Write (Read & write keys only)  
**Wraps:** `PUT /api/portfolio/items/[assetId]/asset-class`

Override the automatic asset class of a holding (null restores the automatic one). applyToSymbol applies it to every holding of the same symbol across accounts.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `assetId` | integer | yes | Asset (portfolio item) ID from get_portfolio_holdings. |
| `assetClass` | `STOCK` \| `INDEX_ETF` \| `SECTOR_ETF` \| `BOND_ETF` \| `REIT` \| `FUND` \| `GOV_BOND` \| `CORP_BOND` \| `REAL_ESTATE` \| `CRYPTO` \| `CASH` \| `OTHER` \| null | yes |  |
| `applyToSymbol` | boolean | no |  |

### `manage_manual_values` — Add, update or delete a manual valuation

**Access:** Write (Read & write keys only) · can delete or discard data  
**Wraps:** `POST /api/portfolio/items/[assetId]/manual-values`, `PUT /api/portfolio/items/[assetId]/manual-values/[valueId]`, `DELETE /api/portfolio/items/[assetId]/manual-values/[valueId]`

Manual valuations price holdings without market data (property, private assets, cash-like accounts); holdings priced from market data (stocks, ETFs, crypto with a ticker) refuse them. value is the PRICE PER UNIT, not the position total: market value = value × quantity. To enter a statement total, divide it by the holding quantity first (get_portfolio_holdings). add: date, value and currency required. update: valueId plus the fields to change. delete: valueId. add/update return currentQuantity and impliedMarketValue so the result can be checked. Each change triggers a portfolio revaluation. valueId comes from get_holding_details.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `assetId` | integer | yes | Asset (portfolio item) ID from get_portfolio_holdings. |
| `action` | `add` \| `update` \| `delete` | yes |  |
| `valueId` | string | no |  |
| `date` | string | no | Valuation date (YYYY-MM-DD) |
| `value` | number | no | Price per unit on that date (NOT the position total; market value = value × quantity). |
| `currency` | string | no |  |
| `notes` | string | no |  |

### `manage_income_and_debt_terms` — Set or remove income / debt terms

**Access:** Write (Read & write keys only) · can delete or discard data  
**Wraps:** `PUT /api/portfolio/items/[assetId]/income-terms`, `DELETE /api/portfolio/items/[assetId]/income-terms`, `DELETE /api/portfolio/income-terms/[id]`, `POST /api/portfolio/income-terms/[id]/attach`, `POST /api/portfolio/items/[assetId]/debt-terms`, `PUT /api/portfolio/items/[assetId]/debt-terms`

target "income": set (assetId + terms; applyToSymbol copies them to every holding of the symbol), delete (assetId), attach (termsId of detached terms + assetId), deleteDetached (termsId). target "debt": set (assetId + debt fields; creates or replaces the loan terms). Terms drive the passive income projection and loan amortisation.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `target` | `income` \| `debt` | yes |  |
| `action` | `set` \| `delete` \| `attach` \| `deleteDetached` | yes |  |
| `assetId` | integer | no | Asset (portfolio item) ID from get_portfolio_holdings. |
| `termsId` | integer | no | Detached income terms ID from get_passive_income. |
| `applyToSymbol` | boolean | no |  |
| `terms` | object { incomeType, isDistributing, frequency, currency, dividendPerUnit, yieldPct, faceValuePerUnit, couponRate, spread, assumedIndexRate, referenceIndex, issuerType, maturityDate, anchorPaymentDate, monthlyRent, annualIndexationPct, leaseEndDate, apyPct } | no | Income terms (replaces the existing terms). Rates are percentages. |
| `initialBalance` | number | no | debt: original loan amount. |
| `interestRate` | number | no | debt: annual interest rate, percent. |
| `termInMonths` | integer | no | debt: loan term. |
| `originationDate` | string | no | debt: loan start (YYYY-MM-DD) |

### `manage_passive_income_streams` — Create, update or delete an income stream

**Access:** Write (Read & write keys only) · can delete or discard data  
**Wraps:** `POST /api/passive-income/streams`, `PUT /api/passive-income/streams/[id]`, `DELETE /api/passive-income/streams/[id]`, `GET /api/passive-income/streams`

Income streams are recurring fixed amounts not produced by a holding (allowance, pension, government benefit). create: categoryId (one of eligibleStreamCategories from get_passive_income), name, amountPerPayment, frequency, currency and startDate. update: streamId plus fields to change. delete: streamId.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `create` \| `update` \| `delete` | yes |  |
| `streamId` | integer | no | Stream ID from get_passive_income. |
| `categoryId` | integer | no | Eligible Passive Income category. |
| `name` | string | no |  |
| `amountPerPayment` | number | no |  |
| `frequency` | `WEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `SEMIANNUAL` \| `ANNUAL` | no |  |
| `currency` | string | no |  |
| `startDate` | string | no | First payment (YYYY-MM-DD) |
| `endDate` | string \| null | no | Last payment (YYYY-MM-DD) |
| `anchorPaymentDate` | string | no | A known payment date (YYYY-MM-DD) |
| `annualIndexationPct` | number | no |  |

## Subscriptions

### `list_subscriptions` — List subscriptions

**Access:** Read (all keys)  
**Wraps:** `GET /api/subscriptions`

Detected recurring charges, one per merchant: cadence, amount, next expected charge and whether it is still ACTIVE or LAPSED. state DETECTED = needs the user's review, CONFIRMED = accepted, DISMISSED = not a subscription. `summary` has the monthly and annual recurring spend in the display currency. view "all" also shows dismissed and merged rows.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `view` | `active` \| `lapsed` \| `all` | no |  |
| `categoryId` | integer | no | Only this category. |
| `limit` | integer | no | Items per page (1-100, default 25). |
| `cursor` | string | no | Opaque cursor from a previous result's nextCursor. Omit for the first page. |

### `update_subscription` — Update a subscription

**Access:** Write (Read & write keys only) · can delete or discard data  
**Wraps:** `POST /api/subscriptions`

confirm (subscriptionId, or transactionId to mark a transaction's merchant as recurring), dismiss (not a subscription), restore (undo dismiss), setCadence (cadence), rename (merchantLabel), merge (subscriptionId folded into targetSubscriptionId, e.g. two descriptors of one merchant), unmerge, refresh (re-run detection; at most every 30 minutes).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `confirm` \| `dismiss` \| `restore` \| `setCadence` \| `rename` \| `merge` \| `unmerge` \| `refresh` | yes |  |
| `subscriptionId` | string | no |  |
| `transactionId` | integer | no | confirm only: a transaction of the merchant. |
| `cadence` | `WEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `ANNUAL` | no |  |
| `merchantLabel` | string | no |  |
| `targetSubscriptionId` | string | no | merge only: the row to keep. |

## Not available over MCP

These REST operations are reachable with an integration key but have no tool, on purpose:

| Operation | Why |
|---|---|
| `POST /api/imports/upload` | File upload stays in the app |
| `POST /api/imports/detect-adapter` | File upload stays in the app |
| `GET /api/imports/adapters` | Import adapter configuration is a UI job |
| `POST /api/imports/adapters` | Import adapter configuration is a UI job |
| `GET /api/imports/similar` | Returns raw classifier embedding matches (no description); staged rows already carry the suggested category |
| `PUT /api/imports/adapters/[id]` | Import adapter configuration is a UI job |
| `DELETE /api/imports/adapters/[id]` | Import adapter configuration is a UI job |
| `GET /api/plaid/items` | Plaid connections are managed in the app |
| `GET /api/plaid/accounts` | Plaid connections are managed in the app |
| `GET /api/plaid/sync-logs` | Plaid connections are managed in the app |
| `POST /api/currency-rates` | Reference-data writes stay in the app |
| `PUT /api/currency-rates` | Reference-data writes stay in the app |
| `DELETE /api/currency-rates` | Reference-data writes stay in the app |
| `GET /api/transactions/export` | CSV export; search_transactions pages the same data |
| `POST /api/analytics` | Analytics cache maintenance, not user data (501 today) |
| `PUT /api/analytics` | Analytics cache maintenance, not user data (501 today) |
| `DELETE /api/analytics` | Analytics cache maintenance, not user data (501 today) |
| `PUT /api/notifications/summary` | Marks the creating admin's notifications as seen |
| `GET /api/onboarding/progress` | Onboarding UI state |
| `PUT /api/onboarding/progress` | Onboarding UI state |
| `POST /api/subscriptions` action `fullScan` | Maintenance (Settings → Maintenance) |

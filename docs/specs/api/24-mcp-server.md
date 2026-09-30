# 24. MCP Server for AI Agents (API)

## 24.1. Overview

`POST /api/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server inside the API app (#89). MCP clients (Claude Code, Claude Desktop via
`mcp-remote`, the MCP Inspector, other agents) connect with a Bliss
**integration API key** (#84, [23-integrations-api.md](./23-integrations-api.md))
and get 39 agent-oriented **tools** covering transactions, analytics, insights,
the Plaid review queue, staged-import review, portfolio & passive income and
subscriptions.

v1 is **tools only**: no resources, prompts, sampling, elicitation or
server-initiated notifications, and no OAuth (claude.ai web connectors are not
supported).

User guide: [`docs/guides/using-bliss-with-claude-mcp.md`](../../guides/using-bliss-with-claude-mcp.md).
Generated tool reference: [`docs/guides/mcp-tool-reference.md`](../../guides/mcp-tool-reference.md).

## 24.2. Architecture

```
MCP client ──POST /api/mcp (JSON-RPC, Bearer bliss_…)──▶ pages/api/mcp.js
                                                          │ withAuth (integration key only)
                                                          ▼
                                   lib/mcp/server.js  new McpServer + StreamableHTTPServerTransport per request
                                                          │ tools filtered by role
                                                          ▼
                                   lib/mcp/tools/*.js  validate (zod) → call REST → reshape
                                                          │ lib/mcp/loopback.js
                                                          ▼
                         http://127.0.0.1:$PORT/api/…  (or MCP_LOOPBACK_URL), same Bearer key
                                                          │ withAuth, denylist, tenant scope, rate limits,
                                                          ▼ decryption, validation, backend events
                                                existing REST handlers (unchanged)
```

- **Transport:** official `@modelcontextprotocol/sdk` (pinned `1.31.0`)
  Streamable HTTP in **stateless JSON mode** (`sessionIdGenerator: undefined`,
  `enableJsonResponse: true`). A new server and transport are built for every
  request and closed when the response closes. No `Mcp-Session-Id`, no SSE, so
  any API replica can answer any request.
- **Execution model:** every tool calls existing REST routes **over loopback**
  with the caller's own key. Authorization, tenant scoping, decryption,
  validation, rate limits and backend events stay in one place; the MCP layer
  adds no business logic and no route handler was changed for it.
- **Module layout (`apps/api/lib/mcp/`):**

| File | Role |
|---|---|
| `server.js` | `createMcpServer(req)`, `wrapTool()` (loopback per call, shaping, error mapping, `mcp_tool_call` log), `handleMcpRequest()` |
| `instructions.js` | Server `instructions`: sign convention, display vs native currency, category type/group, the two review queues, dates, paging |
| `loopback.js` | `createLoopbackClient({ req, tool })`, `LoopbackError`, `optional()` (404 → fallback), `mapWithConcurrency()` |
| `errors.js` | REST status → one-line MCP tool error; `ToolInputError`, `ToolNotFoundError` |
| `shape.js` | Opaque cursors, page/offset helpers, `money()`, `signedAmount()`, `isoDate()`, `omitDeep()`, `capResponse()` |
| `define.js` | `defineTool()` (validation + annotations) and shared zod fields |
| `registry.js` | `ALL_TOOLS`, `READ_TOOLS`, `toolsForRole()`, `getTool()` |
| `exclusions.js` | `EXCLUDED_OPERATIONS` (reachable REST operations with no tool, each with a reason) |
| `reference.js` | Renders the Markdown tool reference from the registry |
| `tools/*.js` | `reference`, `transactions`, `analytics`, `plaid`, `imports`, `portfolio`, `subscriptions` |

## 24.3. Endpoint & authentication

`POST /api/mcp` — body: a JSON-RPC 2.0 message (Next's default 1 MB JSON body
limit). The client must send `Accept: application/json, text/event-stream`
(standard for Streamable HTTP clients).

| Request | Response |
|---|---|
| No `Authorization`, invalid / expired / revoked key | `401` from withAuth (`TOKEN_INVALID` / `TOKEN_EXPIRED` / `TOKEN_REVOKED`), no MCP handling |
| Cookie session or user JWT | `401 { code: 'INTEGRATION_KEY_REQUIRED' }` |
| `GET` / `DELETE` (SSE stream / session end) with a valid key | `405`, `Allow: POST` |
| `POST` with a valid key | MCP JSON-RPC response (`200`, or `202` for notifications) |

**Read-only keys and POST.** withAuth's viewer rule refuses every non-GET for
read-only keys. `utils/integrationPolicy.js` has an **exact-path** allowance,
`VIEWER_POST_ALLOWED = ['/api/mcp']` (`isViewerPostAllowed()`), applied only on
the integration-token path of withAuth. This is safe because the MCP route never
writes by itself: each tool's REST call is checked again by withAuth against its
real route and method. The route matrix classifies `mcp.js` as `POST: A/A`.

## 24.4. Tools and roles

`tools/list` is filtered by the key's role: **Read-only** (`viewer`) → the 22
read tools; **Read & write** (`member`) → all 39. Write tools are not even
registered for read-only keys (calling one by name is a "tool not found" error),
and their REST calls would be refused with `403 READ_ONLY_INTEGRATION` anyway.
Annotations: read tools `readOnlyHint: true`; write tools that delete, discard,
merge or dismiss `destructiveHint: true`.

| Domain | Read tools | Write tools |
|---|---|---|
| Reference data | `list_accounts`, `list_categories`, `get_reference_data`, `search_ticker`, `list_tags` | `manage_tags` |
| Transactions | `search_transactions`, `get_merchant_history` | `create_transaction`, `update_transaction`, `delete_transaction` |
| Analytics, insights, notifications | `get_spending_summary`, `get_tag_summary`, `list_insights`, `get_notifications_summary` | `generate_insights`, `dismiss_insight` |
| Plaid review queue | `get_plaid_review_queue`, `list_plaid_seeds` | `review_plaid_transactions`, `requeue_plaid_transactions`, `confirm_plaid_seeds` |
| Smart Import review | `list_imports`, `find_similar_transactions`, `list_import_seeds` | `review_import_rows`, `confirm_import_seeds`, `finalize_import` |
| Portfolio & passive income | `get_portfolio_holdings`, `get_portfolio_history`, `get_equity_analysis`, `get_passive_income`, `get_holding_details` | `set_asset_class`, `manage_manual_values`, `manage_income_and_debt_terms`, `manage_passive_income_streams` |
| Subscriptions | `list_subscriptions` | `update_subscription` |

Parameters and wrapped routes per tool: the generated
[tool reference](../../guides/mcp-tool-reference.md).

Notable contracts:

- **Tenant ownership pre-checks.** `POST`/`PUT /api/transactions` do not check
  that `accountId`/`categoryId` belong to the tenant, so `create_transaction` and
  `update_transaction` first read them through the tenant-scoped
  `GET /api/accounts?id=` / `GET /api/categories?id=` and answer "not found".
- **`update_transaction`** reads the transaction, merges the given fields and
  sends the full record (the PUT replaces every field, like the app's edit form),
  so the feedback loop and events are identical to an edit in the app.
- **`manage_passive_income_streams` update** merges onto the current stream for
  the same reason.
- **`search_transactions`** has no text or amount filter: descriptions are
  AES-256-GCM encrypted with a per-value PBKDF2 key, so matching would mean
  decrypting (and key-deriving) every row inside the request — seconds of
  blocked event loop per page. Agents narrow by date/account/category/tag and
  use `get_merchant_history` for merchants.
- **`update_subscription`** enum omits `fullScan` (maintenance; action-level
  exclusion). A subscription's ID is its merchant hash (`descriptionHash`),
  exposed as `subscriptionId`.
- **`get_holding_details`** makes `asset-class` the primary (tenant-scoped) read,
  so a foreign asset ID fails the whole tool; income terms, debt terms and manual
  values fail soft on 404.
- **Batch tools** (`review_plaid_transactions` items, `review_import_rows` rows,
  `requeue_plaid_transactions` failedIds) take at most 50 entries, run at most
  10 REST calls at a time and report per-entry `{ ok, error }`.

## 24.5. Response shaping

- Tool results are JSON objects returned as both `structuredContent` and a text
  block with the same JSON. No `outputSchema` is declared (shapes follow the REST
  responses; strict output validation would turn harmless additions into errors).
- **Paging:** every list returns `hasMore` and an opaque base64url `nextCursor`
  (`{page}` for page-based routes, `{offset}` for offset/in-memory lists).
  Default 50 items, max 100 (reference lists default to 100). A tampered cursor
  is an input error.
- **Money** is `{ value, currency }` (2 decimals); **dates** are `YYYY-MM-DD`.
  Transaction, import-row and review-item amounts are **signed**: positive =
  money in, negative = money out (Plaid's positive-outflow amounts are flipped).
- **Hidden fields:** `omitDeep()` removes `rawJson`, `rawData`, `embedding`,
  `hash`, `keyHash`, `accessToken`, `dedupeHash`, `transactionHash`,
  `plaidTransactionId`, `externalId` at any depth. Account numbers are reduced to
  the last 4 digits.
- **Size:** default pages stay under ~25k characters (asserted in tests with a
  5,000-transaction tenant). `capResponse()` is a 50k-character backstop: it
  trims the longest list, sets `truncated: true` and **drops `nextCursor`** so an
  agent is never led past rows it did not receive.

## 24.6. Errors

REST failures become MCP tool results with `isError: true` and one sentence:

| REST | Message |
|---|---|
| `401` | The Bliss API key is invalid, expired or revoked… |
| `403 READ_ONLY_INTEGRATION` | This key is read-only… |
| `403 NOT_AVAILABLE_TO_INTEGRATIONS` | This operation is not available to integrations… |
| `403` (other) / `404` | `Not found: <route message>. <which tool lists the IDs>` — cross-tenant IDs never reveal more |
| `400` / `409` / `422` | The route's `error` (+ `details`) |
| `429` | Rate limited by Bliss. Retry after N seconds (from `Retry-After` or body `retryAfter`) |
| `5xx`, timeout, unreachable | Generic message; 5xx and unexpected errors go to Sentry |

Invalid arguments (zod) are rejected by the SDK before the handler runs.

## 24.7. Loopback

- Base URL: `MCP_LOOPBACK_URL` (optional) or `http://127.0.0.1:${PORT || 3000}`.
  Docker runs `node apps/api/server.js` with `PORT=3000`/`HOSTNAME=0.0.0.0` and
  Railway injects `PORT`, so the default works in both. Set `MCP_LOOPBACK_URL`
  (e.g. the public API URL) only when the API is not reachable on its own
  loopback (Vercel, a proxy that rewrites paths).
- Headers sent: `Authorization` (the caller's key), `x-real-ip` and
  `x-forwarded-for` set to the original client IP (the rate limiters' own
  expression), `x-bliss-mcp-tool: <tool>`, `x-request-id` when present. Cookies
  are never forwarded. Headers and bodies are never logged.
- Timeout 30 s per REST call (`utils/fetchWithTimeout.js`).
- **Rate limits:** because the client IP is forwarded, loopback calls count
  against the same per-IP buckets as a direct REST call — and a tool that fans
  out (e.g. `get_holding_details` = 4 calls) spends several units.

## 24.8. Observability

- #84's `integration_request` line gains `mcpTool` when the request carries a
  well-formed `x-bliss-mcp-tool` (`^[a-z_]{1,64}$`; anything else is dropped).
- One line per tool call from `wrapTool()`:
  `{"event":"mcp_tool_call","tenantId","integrationId","apiKeyId","tool","ok","calls":[{method,route,status,ms}],"ms"}`.
- Sentry: 5xx and unexpected errors only.

## 24.9. Coverage

Every REST operation an integration key can reach must be **wrapped by a tool
xor listed in `lib/mcp/exclusions.js`** — `__tests__/unit/mcp/coverage.test.ts`
derives reachability from the #84 route matrix
(`__tests__/unit/middleware/integrationRouteMatrix.data.ts`, READ_WRITE outcome
`A` or `P`) and fails for any new, unclassified route. `POST /api/mcp` itself is
not counted.

| Domain | Reachable | Covered | Not covered (why) |
|---|---|---|---|
| Reference data (accounts, categories, tags, banks, countries, currencies, FX, ticker, tenant) | 17 | 13 | `banks` POST, `currency-rates` POST/PUT/DELETE: stay in the app |
| Transactions | 6 | 5 | `transactions/export` (CSV): `search_transactions` pages the same data |
| Analytics | 5 | 2 | `analytics` POST/PUT/DELETE: cache maintenance (501 today) |
| Insights, notifications, onboarding | 7 | 4 | `notifications/summary` PUT (marks the creating admin's notifications seen); `onboarding/progress` GET/PUT: UI state |
| Plaid | 10 | 7 | `plaid/items` GET, `plaid/accounts` GET, `plaid/sync-logs` GET: connections are managed in the app |
| Smart Import | 14 | 8 | `upload`, `detect-adapter`: file upload stays in the app; `adapters` ×4: adapter configuration |
| Portfolio & passive income | 25 | 25 | — |
| Subscriptions | 2 | 2 | action `fullScan` only |
| **Total** | **86** | **66 (77%)** | **20** |

The PRD counted 84 reachable operations; the route matrix also classifies
`GET /api/tenants` and `GET /api/tenants/settings` as reachable. Both are
wrapped by `get_reference_data` (`tenant` kind: display currency, enabled
currencies/countries, transaction years, thresholds).

## 24.10. Tests

| Suite | What it proves |
|---|---|
| `unit/mcp/core.test.ts` | Shaping, cursors, `capResponse`, error mapping, loopback headers/timeouts/errors, registry counts and annotations, `isViewerPostAllowed` |
| `unit/mcp/tools.test.ts` | Each tool's exact REST call(s) and output shape (fake loopback) |
| `unit/mcp/auth.test.ts` | withAuth viewer POST allowance (exact path), `mcpTool` sanitisation, `wrapTool` logging |
| `unit/mcp/coverage.test.ts` | 86 reachable / 66 covered / 20 excluded; no upload or Plaid-connection tool |
| `unit/mcp/reference.test.ts` | The committed tool reference matches the registry |
| `integration/api/mcp/protocol.test.ts` | SDK client end to end: 22/39 tools by role, auth 401s, 405s, stateless, IP forwarding, smoke script |
| `integration/api/mcp/workflows.test.ts` | `update_transaction` ≡ REST PUT (DB, events, feedback, logs); Plaid approve + bulk promote; import review/commit/cancel; manual values; subscription merge/unmerge |
| `integration/api/mcp/isolation.test.ts` | Tenant A's key with tenant B's IDs on every ID-taking tool: not found or empty, nothing leaked, B unchanged |
| `integration/api/mcp/pagination.test.ts` | 5,000 transactions: ≤50 items, `hasMore`, < 25k chars, cursor without overlap |

The integration suites serve every Pages Router handler from a real HTTP server
(`__tests__/helpers/mcpServer.ts`) so the loopback runs for real against
`bliss_test`. `pnpm --filter @bliss/api mcp:smoke` runs the same connect → list →
call check against any deployment.

## 24.11. Known limitations

- `GET /api/transactions` orders by one field (date by default) with no
  tiebreaker, so same-day rows have no stable order across pages; an agent paging
  a busy day may see a row twice or miss one. Fix belongs in the REST route.
- Tool names are not a stable contract (decided); the reference is regenerated
  from the registry.

/**
 * Integration-token route matrix data (#84, AC9) — the classification table.
 *
 * Every file under pages/api must be classified here with the outcome an
 * integration token gets for each method it serves, for READ_ONLY and for
 * READ_WRITE tokens. integrationRouteMatrix.test.ts asserts it against the
 * real withAuth / middleware; the MCP coverage test (#89) reuses it to know
 * which operations a token can reach.
 *
 * Outcome codes, written `<READ_ONLY>/<READ_WRITE>`:
 *   A  allowed (reaches the handler, acting as viewer/member)
 *   R  403 READ_ONLY_INTEGRATION (viewer rule)
 *   X  403 admin-only (requireRole or an inline role === 'admin' check)
 *   D  403 NOT_AVAILABLE_TO_INTEGRATIONS (central denylist)
 *   U  not accepted: the route has its own credential (ADMIN_API_KEY, Plaid
 *      signature) that a token never satisfies
 *   P  public route, no auth at all (same answer as an anonymous request)
 *
 * If you add a route: decide whether a token should reach it. If not, add it
 * to INTEGRATION_DENYLIST in utils/integrationPolicy.js, then classify it here.
 */

export type Outcome = 'A' | 'R' | 'X' | 'D' | 'U' | 'P';
export type Pair = `${Outcome}/${Outcome}`;

export interface RouteSpec {
  auth: 'withAuth' | 'public' | 'adminKey' | 'webhook' | 'credential';
  /** withAuth(..., { requireRole: 'admin' }) on the whole route. */
  requireAdmin?: boolean;
  /** Methods gated by an inline `user.role !== 'admin'` check in the handler. */
  inlineAdmin?: string[];
  methods: Record<string, Pair>;
}

const RW_ALL = (methods: string[]): Record<string, Pair> =>
  Object.fromEntries(methods.map((m) => [m, m === 'GET' ? 'A/A' : 'R/A'])) as Record<string, Pair>;
const DENY_ALL = (methods: string[]): Record<string, Pair> =>
  Object.fromEntries(methods.map((m) => [m, 'D/D'])) as Record<string, Pair>;
const WRITES_DENIED = (methods: string[]): Record<string, Pair> =>
  Object.fromEntries(methods.map((m) => [m, m === 'GET' ? 'A/A' : 'D/D'])) as Record<string, Pair>;

export const ROUTE_MATRIX: Record<string, RouteSpec> = {
  // ── Accounts: reads + create (#98) / categories / tenants: reads only ─────
  'accounts.js': { auth: 'withAuth', methods: { GET: 'A/A', POST: 'R/A', PUT: 'D/D', DELETE: 'D/D' } },
  'categories.js': { auth: 'withAuth', methods: WRITES_DENIED(['GET', 'POST', 'PUT', 'DELETE']) },
  'tenants.js': { auth: 'withAuth', methods: WRITES_DENIED(['GET', 'PUT', 'DELETE']) },
  'tenants/settings.js': { auth: 'withAuth', inlineAdmin: ['PUT'], methods: WRITES_DENIED(['GET', 'PUT']) },

  // ── Admin (tenant admin via withAuth) ─────────────────────────────────────
  'admin/rebuild.js': { auth: 'withAuth', requireAdmin: true, inlineAdmin: [], methods: { GET: 'X/X', POST: 'R/X' } },
  'admin/refresh-fundamentals.js': { auth: 'withAuth', requireAdmin: true, inlineAdmin: [], methods: { POST: 'R/X' } },
  // ── Admin (operator ADMIN_API_KEY) ────────────────────────────────────────
  'admin/default-categories/index.js': { auth: 'adminKey', methods: { GET: 'U/U', POST: 'U/U' } },
  'admin/default-categories/[code].js': { auth: 'adminKey', methods: { PUT: 'U/U' } },
  'admin/default-categories/[code]/regenerate-embeddings.js': { auth: 'adminKey', methods: { POST: 'U/U' } },
  'runtime.js': { auth: 'adminKey', methods: { GET: 'U/U' } },
  // Invite allowlist (#99): ADMIN_API_KEY route that is also denylisted, so a
  // token is refused before the key check runs.
  'admin/invites.js': { auth: 'adminKey', methods: DENY_ALL(['GET', 'POST', 'DELETE']) },
  'admin/plaid-webhooks.js': { auth: 'adminKey', methods: DENY_ALL(['GET', 'POST']) },

  // ── Analytics / reference data ────────────────────────────────────────────
  // Processing status (#100): read-only, so agents can wait for derived data to settle.
  'activity.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'analytics.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST', 'PUT', 'DELETE']) },
  'analytics/tags.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'banks.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST']) },
  'currency-rates.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST', 'PUT', 'DELETE']) },
  'countries.js': { auth: 'public', methods: { GET: 'P/P' } },
  'currencies.js': { auth: 'public', methods: { GET: 'P/P' } },
  'ticker/search.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },

  // ── Auth (always denied) ──────────────────────────────────────────────────
  'auth/[...nextauth].js': { auth: 'credential', methods: DENY_ALL(['GET', 'POST']) },
  'auth/change-password.js': { auth: 'withAuth', methods: DENY_ALL(['PUT']) },
  'auth/google-token.js': { auth: 'credential', methods: DENY_ALL(['GET']) },
  'auth/session.js': { auth: 'withAuth', methods: DENY_ALL(['GET']) },
  'auth/signin.js': { auth: 'credential', methods: DENY_ALL(['POST']) },
  'auth/signout.js': { auth: 'credential', methods: DENY_ALL(['POST']) },
  'auth/signup.js': { auth: 'credential', methods: DENY_ALL(['POST']) },
  'auth/signup-mode.js': { auth: 'public', methods: DENY_ALL(['GET']) },

  // ── Users & integrations management (always denied) ───────────────────────
  'users.js': { auth: 'withAuth', inlineAdmin: ['POST', 'PUT', 'DELETE'], methods: DENY_ALL(['GET', 'POST', 'PUT', 'DELETE']) },
  'integrations/index.js': { auth: 'withAuth', requireAdmin: true, methods: DENY_ALL(['GET', 'POST']) },
  'integrations/[id].js': { auth: 'withAuth', requireAdmin: true, methods: DENY_ALL(['PATCH', 'DELETE']) },
  'integrations/[id]/keys/index.js': { auth: 'withAuth', requireAdmin: true, methods: DENY_ALL(['POST']) },
  'integrations/[id]/keys/[keyId].js': { auth: 'withAuth', requireAdmin: true, methods: DENY_ALL(['DELETE']) },

  // ── Smart import ──────────────────────────────────────────────────────────
  'imports/[id].js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST']) },
  'imports/[id]/bulk-confirm.js': { auth: 'withAuth', methods: RW_ALL(['POST']) },
  'imports/[id]/confirm-seeds.js': { auth: 'withAuth', methods: RW_ALL(['POST']) },
  'imports/[id]/rows/[rowId].js': { auth: 'withAuth', methods: RW_ALL(['PUT']) },
  'imports/[id]/seeds.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'imports/adapters.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST']) },
  'imports/adapters/[id].js': { auth: 'withAuth', methods: RW_ALL(['PUT', 'DELETE']) },
  'imports/detect-adapter.js': { auth: 'withAuth', methods: RW_ALL(['POST']) },
  'imports/pending.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'imports/similar.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'imports/upload.js': { auth: 'withAuth', methods: RW_ALL(['POST']) },

  // ── OAuth for the MCP server (#89): tokens can never mint tokens ──────────
  'oauth/protected-resource.js': { auth: 'public', methods: DENY_ALL(['GET']) },
  'oauth/metadata.js': { auth: 'public', methods: DENY_ALL(['GET']) },
  'oauth/register.js': { auth: 'public', methods: DENY_ALL(['POST']) },
  'oauth/authorize.js': { auth: 'public', methods: DENY_ALL(['GET']) },
  'oauth/token.js': { auth: 'public', methods: DENY_ALL(['POST']) },
  'oauth/revoke.js': { auth: 'public', methods: DENY_ALL(['POST']) },
  'oauth/requests/[id]/index.js': { auth: 'withAuth', methods: DENY_ALL(['GET']) },
  'oauth/requests/[id]/approve.js': { auth: 'withAuth', requireAdmin: true, methods: DENY_ALL(['POST']) },
  'oauth/requests/[id]/deny.js': { auth: 'withAuth', methods: DENY_ALL(['POST']) },

  // ── MCP server (#89): JSON-RPC over POST; read-only keys may POST here only ──
  'mcp.js': { auth: 'withAuth', methods: { POST: 'A/A' } },

  // ── Insights, notifications, onboarding, subscriptions, tags ─────────────
  'insights.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'PUT', 'POST']) },
  // The inline admin check only picks the PROCESSING_FAILED link (#100); it gates no method.
  'notifications/summary.js': { auth: 'withAuth', inlineAdmin: [], methods: RW_ALL(['GET', 'PUT']) },
  'onboarding/progress.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'PUT']) },
  'subscriptions.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST']) },
  'tags.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST', 'PUT', 'DELETE']) },

  // ── Passive income & portfolio ────────────────────────────────────────────
  'passive-income/streams/index.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST']) },
  'passive-income/streams/[id].js': { auth: 'withAuth', methods: RW_ALL(['PUT', 'DELETE']) },
  'portfolio/assets.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'portfolio/equity-analysis.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'portfolio/history.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'portfolio/holdings.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'portfolio/items.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'portfolio/passive-income.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'portfolio/income-terms/[id].js': { auth: 'withAuth', methods: RW_ALL(['DELETE']) },
  'portfolio/income-terms/[id]/attach.js': { auth: 'withAuth', methods: RW_ALL(['POST']) },
  'portfolio/income-terms/detached.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'portfolio/items/[assetId]/asset-class.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'PUT']) },
  'portfolio/items/[assetId]/debt-terms.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST', 'PUT']) },
  'portfolio/items/[assetId]/income-terms.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'PUT', 'DELETE']) },
  'portfolio/items/[assetId]/manual-values.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST']) },
  'portfolio/items/[assetId]/manual-values/[valueId].js': { auth: 'withAuth', methods: RW_ALL(['PUT', 'DELETE']) },

  // ── Plaid: review queue + reads allowed; connection lifecycle denied ─────
  'plaid/accounts.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'plaid/sync-logs.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'plaid/items.js': { auth: 'withAuth', methods: WRITES_DENIED(['GET', 'PATCH']) },
  'plaid/create-link-token.js': { auth: 'withAuth', methods: DENY_ALL(['POST']) },
  'plaid/disconnect.js': { auth: 'withAuth', methods: DENY_ALL(['POST']) },
  'plaid/exchange-public-token.js': { auth: 'withAuth', methods: DENY_ALL(['POST']) },
  'plaid/fetch-historical.js': { auth: 'withAuth', methods: DENY_ALL(['POST']) },
  'plaid/resync.js': { auth: 'withAuth', methods: DENY_ALL(['POST']) },
  'plaid/rotate-token.js': { auth: 'withAuth', methods: DENY_ALL(['POST']) },
  'plaid/sync-accounts.js': { auth: 'withAuth', methods: DENY_ALL(['POST']) },
  'plaid/items/hard-delete.js': { auth: 'adminKey', methods: DENY_ALL(['DELETE']) },
  'plaid/webhook.js': { auth: 'webhook', methods: { POST: 'U/U' } },
  'plaid/transactions/index.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'plaid/transactions/seeds.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'plaid/transactions/[id].js': { auth: 'withAuth', methods: RW_ALL(['PUT']) },
  'plaid/transactions/[id]/retry.js': { auth: 'withAuth', methods: RW_ALL(['POST']) },
  'plaid/transactions/bulk-promote.js': { auth: 'withAuth', methods: RW_ALL(['POST']) },
  'plaid/transactions/bulk-requeue.js': { auth: 'withAuth', methods: RW_ALL(['POST']) },
  'plaid/transactions/confirm-seeds.js': { auth: 'withAuth', methods: RW_ALL(['POST']) },

  // ── Transactions ──────────────────────────────────────────────────────────
  'transactions/index.js': { auth: 'withAuth', methods: RW_ALL(['GET', 'POST', 'PUT', 'DELETE']) },
  'transactions/export.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
  'transactions/merchant-history.js': { auth: 'withAuth', methods: RW_ALL(['GET']) },
};

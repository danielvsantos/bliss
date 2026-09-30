/**
 * REST operations an integration key can reach that no MCP tool wraps (#89).
 *
 * The coverage test (__tests__/unit/mcp/coverage.test.ts) holds every
 * reachable (route, method) to "wrapped by a tool" xor "listed here with a
 * reason". A new route therefore fails CI until it gets a tool or an entry.
 * Action-level exclusion (not listed here): `POST /api/subscriptions` with
 * action `fullScan` (maintenance; update_subscription's enum omits it).
 */
export const EXCLUDED_OPERATIONS = Object.freeze([
  { method: 'POST', route: '/api/imports/upload', reason: 'File upload stays in the app' },
  { method: 'POST', route: '/api/imports/detect-adapter', reason: 'File upload stays in the app' },
  { method: 'GET', route: '/api/imports/adapters', reason: 'Import adapter configuration is a UI job' },
  { method: 'POST', route: '/api/imports/adapters', reason: 'Import adapter configuration is a UI job' },
  { method: 'PUT', route: '/api/imports/adapters/[id]', reason: 'Import adapter configuration is a UI job' },
  { method: 'DELETE', route: '/api/imports/adapters/[id]', reason: 'Import adapter configuration is a UI job' },
  { method: 'GET', route: '/api/plaid/items', reason: 'Plaid connections are managed in the app' },
  { method: 'GET', route: '/api/plaid/accounts', reason: 'Plaid connections are managed in the app' },
  { method: 'GET', route: '/api/plaid/sync-logs', reason: 'Plaid connections are managed in the app' },
  { method: 'POST', route: '/api/banks', reason: 'Reference-data writes stay in the app' },
  { method: 'POST', route: '/api/currency-rates', reason: 'Reference-data writes stay in the app' },
  { method: 'PUT', route: '/api/currency-rates', reason: 'Reference-data writes stay in the app' },
  { method: 'DELETE', route: '/api/currency-rates', reason: 'Reference-data writes stay in the app' },
  { method: 'GET', route: '/api/transactions/export', reason: 'CSV export; search_transactions pages the same data' },
  { method: 'POST', route: '/api/analytics', reason: 'Analytics cache maintenance, not user data (501 today)' },
  { method: 'PUT', route: '/api/analytics', reason: 'Analytics cache maintenance, not user data (501 today)' },
  { method: 'DELETE', route: '/api/analytics', reason: 'Analytics cache maintenance, not user data (501 today)' },
  { method: 'PUT', route: '/api/notifications/summary', reason: 'Marks the creating admin\'s notifications as seen' },
  { method: 'GET', route: '/api/onboarding/progress', reason: 'Onboarding UI state' },
  { method: 'PUT', route: '/api/onboarding/progress', reason: 'Onboarding UI state' },
]);

/** Routes that are not REST data operations: the MCP endpoint itself. */
export const NOT_REST_OPERATIONS = Object.freeze([{ method: 'POST', route: '/api/mcp' }]);

/**
 * Default MSW request handlers for bliss-frontend tests.
 *
 * These handlers stub the most common API endpoints so that component
 * and hook tests can run without a live backend. Add new handlers here
 * as you write tests that exercise additional endpoints.
 *
 * Test files can override specific handlers by calling:
 *   server.use(http.get('/api/accounts', () => HttpResponse.json({ accounts: [...] })))
 *
 * @see https://mswjs.io/docs/network-behavior/rest
 */

import { http, HttpResponse } from 'msw';

export const handlers = [
  // Auth
  http.get('/api/auth/session', () =>
    HttpResponse.json({ user: null })
  ),

  // Accounts
  http.get('/api/accounts', () =>
    HttpResponse.json({ accounts: [], total: 0 })
  ),

  // Categories
  http.get('/api/categories', () =>
    HttpResponse.json({ categories: [], total: 0, page: 1, limit: 100 })
  ),

  // Metadata
  http.get('/api/countries', () =>
    HttpResponse.json([])
  ),

  http.get('/api/currencies', () =>
    HttpResponse.json([])
  ),

  http.get('/api/banks', () =>
    HttpResponse.json([])
  ),

  http.get('/api/user/preferences', () =>
    HttpResponse.json({ defaultCurrency: 'USD', defaultCountry: 'US', theme: 'system' })
  ),

  // Transactions
  http.get('/api/transactions', () =>
    HttpResponse.json({ transactions: [], total: 0 })
  ),

  // Analytics
  http.get('/api/analytics', () =>
    HttpResponse.json({ monthly: [], summary: {} })
  ),

  // Portfolio
  http.get('/api/portfolio/items', () =>
    HttpResponse.json({ items: [] })
  ),
];

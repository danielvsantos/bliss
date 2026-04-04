/**
 * Unit tests for GET /api/plaid/accounts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockPlaidClient } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findUnique: vi.fn() },
    tenantCurrency: { findMany: vi.fn() },
    tenantCountry: { findMany: vi.fn() },
    country: { findFirst: vi.fn() },
  },
  mockPlaidClient: {
    accountsGet: vi.fn(),
    institutionsGetById: vi.fn(),
  },
}));

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

vi.mock('../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

vi.mock('../../../services/plaid.service', () => ({
  plaidClient: mockPlaidClient,
}));

import handler from '../../../pages/api/plaid/accounts.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
    headers: {},
    cookies: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res._status = undefined;
  res._body = undefined;
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/plaid/accounts', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns accounts for valid plaidItemId', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      tenantId: 'test-tenant-123',
      accessToken: 'access-sandbox-token',
      institutionId: null,
    });
    mockPrisma.tenantCurrency.findMany.mockResolvedValueOnce([
      { currencyId: 'USD', isDefault: true },
    ]);
    mockPrisma.tenantCountry.findMany.mockResolvedValueOnce([
      { countryId: 'USA', isDefault: true, country: { id: 'USA', iso2: 'US' } },
    ]);
    mockPlaidClient.accountsGet.mockResolvedValueOnce({
      data: {
        accounts: [
          {
            account_id: 'acc-1',
            name: 'Checking',
            mask: '1234',
            type: 'depository',
            subtype: 'checking',
            balances: { current: 5000, iso_currency_code: 'USD' },
          },
        ],
        item: { institution_id: 'ins_1' },
      },
    });

    const req = makeReq({ query: { plaidItemId: 'item-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.accounts).toHaveLength(1);
    expect(res._body.accounts[0]).toEqual(expect.objectContaining({
      accountId: 'acc-1',
      name: 'Checking',
      mask: '1234',
      isCurrencySupported: true,
    }));
  });

  it('returns 400 without plaidItemId', async () => {
    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing plaidItemId' });
  });

  it('returns 404 when PlaidItem not found', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({ query: { plaidItemId: 'nonexistent' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Plaid Item not found' });
  });
});

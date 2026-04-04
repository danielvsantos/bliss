/**
 * Unit tests for POST /api/plaid/sync-accounts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockProduceEvent, mockPlaidClient } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findUnique: vi.fn() },
    country: { findFirst: vi.fn() },
    tenantCountry: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  mockProduceEvent: vi.fn(),
  mockPlaidClient: {
    accountsGet: vi.fn(),
  },
}));

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'tenant-1', role: 'admin', email: 'a@test.com' };

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

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

vi.mock('../../../services/plaid.service.js', () => ({
  plaidClient: mockPlaidClient,
}));

import handler from '../../../pages/api/plaid/sync-accounts.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/plaid/sync-accounts', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('creates Account records, updates PlaidItem, and fires PLAID_INITIAL_SYNC event', async () => {
    const plaidItem = {
      id: 'pi-1',
      tenantId: 'tenant-1',
      accessToken: 'access-token-1',
      bankId: 1,
      bank: { id: 1, name: 'Test Bank' },
    };

    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce(plaidItem);
    mockPlaidClient.accountsGet.mockResolvedValueOnce({
      data: {
        accounts: [
          {
            account_id: 'plaid-acc-1',
            name: 'Checking',
            mask: '1234',
            type: 'depository',
            subtype: 'checking',
            balances: { iso_currency_code: 'USD' },
          },
        ],
      },
    });
    mockPrisma.country.findFirst.mockResolvedValueOnce({ id: 'USA' });
    // $transaction executes the callback
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        bank: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
        currency: { findUnique: vi.fn().mockResolvedValue({ id: 'USD' }), findFirst: vi.fn() },
        account: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
        plaidItem: { update: vi.fn() },
      };
      return fn(tx);
    });
    mockProduceEvent.mockResolvedValue(undefined);

    const req = makeReq({
      body: {
        plaidItemId: 'pi-1',
        selectedAccountIds: ['plaid-acc-1'],
        countryId: 'US',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ success: true, message: 'Accounts linked and sync started' });
    expect(mockProduceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PLAID_INITIAL_SYNC',
        tenantId: 'tenant-1',
        plaidItemId: 'pi-1',
      }),
    );
  });

  it('returns 400 without plaidItemId', async () => {
    const req = makeReq({ body: { selectedAccountIds: ['acc-1'] } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid input' });
  });

  it('returns 400 without selectedAccountIds', async () => {
    const req = makeReq({ body: { plaidItemId: 'pi-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid input' });
  });

  it('returns 404 when PlaidItem not found', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({
      body: { plaidItemId: 'nonexistent', selectedAccountIds: ['acc-1'] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Item not found' });
  });

  it('returns 403 when PlaidItem belongs to a different tenant', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'pi-1',
      tenantId: 'other-tenant',
      bank: null,
    });

    const req = makeReq({
      body: { plaidItemId: 'pi-1', selectedAccountIds: ['acc-1'] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(403);
    expect(res._body).toEqual({ error: 'Access denied' });
  });
});

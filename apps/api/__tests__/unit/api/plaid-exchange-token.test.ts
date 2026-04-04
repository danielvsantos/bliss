/**
 * Unit tests for POST /api/plaid/exchange-public-token
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockPlaidClient } = vi.hoisted(() => ({
  mockPrisma: {
    bank: { upsert: vi.fn() },
    tenantBank: { upsert: vi.fn() },
    plaidItem: { upsert: vi.fn() },
  },
  mockPlaidClient: {
    itemPublicTokenExchange: vi.fn(),
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

import handler from '../../../pages/api/plaid/exchange-public-token.js';

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

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/plaid/exchange-public-token', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('exchanges token and creates PlaidItem', async () => {
    mockPlaidClient.itemPublicTokenExchange.mockResolvedValueOnce({
      data: { access_token: 'access-sandbox-xyz', item_id: 'plaid-item-xyz' },
    });
    mockPrisma.plaidItem.upsert.mockResolvedValueOnce({
      id: 'internal-item-1',
    });

    const req = makeReq({
      body: { public_token: 'public-sandbox-token123' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ plaidItemId: 'internal-item-1' });
    expect(mockPlaidClient.itemPublicTokenExchange).toHaveBeenCalledWith({
      public_token: 'public-sandbox-token123',
    });
    expect(mockPrisma.plaidItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { itemId: 'plaid-item-xyz' },
      }),
    );
  });

  it('returns 400 without public_token', async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing public_token' });
  });

  it('creates Bank record if institution provided', async () => {
    mockPlaidClient.itemPublicTokenExchange.mockResolvedValueOnce({
      data: { access_token: 'access-sandbox-xyz', item_id: 'plaid-item-xyz' },
    });
    mockPrisma.bank.upsert.mockResolvedValueOnce({ id: 'bank-1', name: 'Chase' });
    mockPrisma.tenantBank.upsert.mockResolvedValueOnce({});
    mockPrisma.plaidItem.upsert.mockResolvedValueOnce({ id: 'internal-item-1' });

    const req = makeReq({
      body: {
        public_token: 'public-sandbox-token',
        institutionName: 'Chase',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.bank.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'Chase' },
        create: { name: 'Chase' },
      }),
    );
    expect(mockPrisma.tenantBank.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_bankId: {
            tenantId: 'test-tenant-123',
            bankId: 'bank-1',
          },
        },
      }),
    );
  });
});

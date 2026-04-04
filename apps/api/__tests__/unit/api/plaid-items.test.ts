/**
 * Unit tests for GET/PATCH /api/plaid/items
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockProduceEvent } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

import handler from '../../../pages/api/plaid/items.js';

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

describe('GET /api/plaid/items', () => {
  it('returns all PlaidItems for tenant', async () => {
    const mockItems = [
      {
        id: 'item-1',
        itemId: 'plaid-1',
        status: 'ACTIVE',
        errorCode: null,
        lastSync: new Date(),
        historicalSyncComplete: true,
        earliestTransactionDate: null,
        seedReady: true,
        institutionName: 'Chase',
        institutionId: 'ins_1',
        bankId: 'bank-1',
        consentExpiration: null,
        environment: 'sandbox',
        createdAt: new Date(),
        accounts: [{ id: 'acc-1', name: 'Checking', mask: '1234', type: 'depository', subtype: 'checking' }],
      },
    ];
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce(mockItems);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(mockItems);
    expect(mockPrisma.plaidItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'test-tenant-123' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('returns empty array when no items', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual([]);
  });
});

describe('PATCH /api/plaid/items', () => {
  it('updates status and triggers resync for re-auth', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      tenantId: 'test-tenant-123',
      status: 'LOGIN_REQUIRED',
    });
    mockPrisma.plaidItem.update.mockResolvedValueOnce({
      id: 'item-1',
      status: 'ACTIVE',
      errorCode: null,
      lastSync: null,
      institutionName: 'Chase',
    });

    const req = makeReq({
      method: 'PATCH',
      query: { id: 'item-1' },
      body: { status: 'ACTIVE' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(expect.objectContaining({
      id: 'item-1',
      status: 'ACTIVE',
      errorCode: null,
    }));
    expect(mockPrisma.plaidItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'ACTIVE', errorCode: null },
      select: expect.objectContaining({ id: true, status: true }),
    });
    // Should trigger a post-reconnect sync
    expect(mockProduceEvent).toHaveBeenCalledWith({
      type: 'PLAID_SYNC_UPDATES',
      tenantId: 'test-tenant-123',
      plaidItemId: 'item-1',
      source: 'RECONNECT_SYNC',
    });
  });

  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'DELETE' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'PATCH']);
  });
});

/**
 * Unit tests for /api/banks
 *
 * Mocked handler pattern: withAuth, cors, rateLimit, Sentry, and Prisma
 * are all mocked so we test handler logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

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

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    bank: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    tenantBank: {
      upsert: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/banks.js';

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

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/banks', () => {
  it('returns all banks', async () => {
    const banks = [
      { id: 1, name: 'Bank of America' },
      { id: 2, name: 'Chase' },
    ];
    mockPrisma.bank.findMany.mockResolvedValueOnce(banks);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(banks);
    expect(mockPrisma.bank.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
  });
});

describe('POST /api/banks', () => {
  it('creates bank and links to tenant', async () => {
    const createdBank = { id: 5, name: 'New Bank' };
    mockPrisma.$transaction.mockImplementationOnce(async (fn: any) => {
      // Simulate the transaction callback with a mock tx
      const tx = {
        bank: { upsert: vi.fn().mockResolvedValueOnce(createdBank) },
        tenantBank: { upsert: vi.fn().mockResolvedValueOnce({}) },
      };
      return fn(tx);
    });

    const req = makeReq({ method: 'POST', body: { name: 'New Bank' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(res._body).toEqual(createdBank);
  });

  it('returns 400 for name too short', async () => {
    const req = makeReq({ method: 'POST', body: { name: 'A' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('between');
  });

  it('returns 400 for name too long', async () => {
    const longName = 'A'.repeat(101);
    const req = makeReq({ method: 'POST', body: { name: longName } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('between');
  });

  it('returns 400 for missing name', async () => {
    const req = makeReq({ method: 'POST', body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toBe('Bank name is required');
  });
});

describe('Method validation', () => {
  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'DELETE' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST']);
  });
});

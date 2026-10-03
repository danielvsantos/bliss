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
  function arrangeTx({ exact = null, insensitive = null, upserted = null, link = null }: any = {}) {
    const tx = {
      bank: {
        findUnique: vi.fn().mockResolvedValue(exact),
        findFirst: vi.fn().mockResolvedValue(insensitive),
        upsert: vi.fn().mockResolvedValue(upserted),
      },
      tenantBank: {
        findUnique: vi.fn().mockResolvedValue(link),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    return tx;
  }

  it('creates bank and links to tenant → 201', async () => {
    const createdBank = { id: 5, name: 'New Bank' };
    const tx = arrangeTx({ upserted: createdBank });

    const req = makeReq({ method: 'POST', body: { name: '  New Bank ' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(res._body).toEqual(createdBank);
    expect(tx.bank.upsert).toHaveBeenCalledWith({ where: { name: 'New Bank' }, update: {}, create: { name: 'New Bank' } });
    expect(tx.tenantBank.create).toHaveBeenCalledWith({ data: { tenantId: 'test-tenant-123', bankId: 5 } });
  });

  it('returns 200 with the same bank when it is already linked (#98)', async () => {
    const bank = { id: 5, name: 'New Bank' };
    const tx = arrangeTx({ exact: bank, link: { tenantId: 'test-tenant-123', bankId: 5 } });

    const res = makeRes();
    await handler(makeReq({ method: 'POST', body: { name: 'New Bank' } }), res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(bank);
    expect(tx.bank.upsert).not.toHaveBeenCalled();
    expect(tx.tenantBank.create).not.toHaveBeenCalled();
  });

  it('reuses an existing bank whatever its casing, without a new Bank row (#98)', async () => {
    const bank = { id: 9, name: 'Revolut' };
    const tx = arrangeTx({ insensitive: bank });

    const res = makeRes();
    await handler(makeReq({ method: 'POST', body: { name: 'REVOLUT' } }), res);

    expect(res._status).toBe(201);
    expect(res._body).toEqual(bank);
    expect(tx.bank.findFirst).toHaveBeenCalledWith({
      where: { name: { equals: 'REVOLUT', mode: 'insensitive' } },
      orderBy: { id: 'asc' },
    });
    expect(tx.bank.upsert).not.toHaveBeenCalled();
    expect(tx.tenantBank.create).toHaveBeenCalledWith({ data: { tenantId: 'test-tenant-123', bankId: 9 } });
  });

  it('retries once on a P2002 race and reports the winner\'s link as 200', async () => {
    const bank = { id: 5, name: 'New Bank' };
    let attempt = 0;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      return fn({
        bank: { findUnique: vi.fn().mockResolvedValue(bank), findFirst: vi.fn(), upsert: vi.fn() },
        tenantBank: { findUnique: vi.fn().mockResolvedValue({ bankId: 5 }), create: vi.fn() },
      });
    });

    const res = makeRes();
    await handler(makeReq({ method: 'POST', body: { name: 'New Bank' } }), res);

    expect(attempt).toBe(2);
    expect(res._status).toBe(200);
    expect(res._body).toEqual(bank);
  });

  it('returns 500 when a non-P2002 error occurs', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('boom'));

    const res = makeRes();
    await handler(makeReq({ method: 'POST', body: { name: 'New Bank' } }), res);

    expect(res._status).toBe(500);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
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

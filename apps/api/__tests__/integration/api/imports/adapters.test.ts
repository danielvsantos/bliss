/**
 * Integration tests for GET/POST /api/imports/adapters
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * withAuth, rate limiter, cors, Sentry, and Prisma are all mocked so we can
 * test the handler logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

// Mock rate limiter
vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

// Inject a test user via withAuth mock
const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

// Mock cors to no-op
vi.mock('../../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

// Mock Sentry
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

// Mock Prisma — use vi.hoisted() so the object is available before vi.mock hoisting
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    importAdapter: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../../pages/api/imports/adapters.js';

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
// GET /api/imports/adapters
// ---------------------------------------------------------------------------

describe('GET /api/imports/adapters', () => {
  it('returns 200 with adapters array', async () => {
    const mockAdapters = [
      { id: 1, name: 'Bank A CSV', tenantId: 'test-tenant-123', isActive: true },
      { id: 2, name: 'Global CSV', tenantId: null, isActive: true },
    ];
    mockPrisma.importAdapter.findMany.mockResolvedValueOnce(mockAdapters);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ adapters: mockAdapters });

    expect(mockPrisma.importAdapter.findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        OR: [{ tenantId: 'test-tenant-123' }, { tenantId: null }],
      },
      orderBy: [{ tenantId: 'desc' }, { name: 'asc' }],
    });
  });

  it('returns 405 for PUT method', async () => {
    const req = makeReq({ method: 'PUT' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// POST /api/imports/adapters
// ---------------------------------------------------------------------------

describe('POST /api/imports/adapters', () => {
  it('returns 400 when name is missing', async () => {
    const req = makeReq({
      method: 'POST',
      body: {
        matchSignature: { headers: ['Date', 'Description', 'Amount'] },
        columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
        amountStrategy: 'SINGLE_SIGNED',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('name');
  });

  it('returns 400 when matchSignature.headers is missing', async () => {
    const req = makeReq({
      method: 'POST',
      body: {
        name: 'My Bank CSV',
        matchSignature: {},
        columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
        amountStrategy: 'SINGLE_SIGNED',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('matchSignature.headers');
  });

  it('returns 400 when columnMapping.date is missing', async () => {
    const req = makeReq({
      method: 'POST',
      body: {
        name: 'My Bank CSV',
        matchSignature: { headers: ['Date', 'Description', 'Amount'] },
        columnMapping: { description: 'Description', amount: 'Amount' },
        amountStrategy: 'SINGLE_SIGNED',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('columnMapping.date');
  });

  it('returns 400 when amountStrategy is invalid', async () => {
    const req = makeReq({
      method: 'POST',
      body: {
        name: 'My Bank CSV',
        matchSignature: { headers: ['Date', 'Description', 'Amount'] },
        columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
        amountStrategy: 'INVALID_STRATEGY',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('amountStrategy');
  });

  it('returns 201 with created adapter on valid input', async () => {
    const validBody = {
      name: 'My Bank CSV',
      matchSignature: { headers: ['Date', 'Description', 'Amount'] },
      columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
      amountStrategy: 'SINGLE_SIGNED',
    };

    const createdAdapter = { id: 42, ...validBody, tenantId: 'test-tenant-123' };
    mockPrisma.importAdapter.create.mockResolvedValueOnce(createdAdapter);

    const req = makeReq({ method: 'POST', body: validBody });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(res._body).toEqual({ adapter: createdAdapter });

    expect(mockPrisma.importAdapter.create).toHaveBeenCalledWith({
      data: {
        name: 'My Bank CSV',
        matchSignature: { headers: ['Date', 'Description', 'Amount'] },
        columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
        dateFormat: null,
        amountStrategy: 'SINGLE_SIGNED',
        currencyDefault: null,
        skipRows: 0,
        tenantId: 'test-tenant-123',
      },
    });
  });
});

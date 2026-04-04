/**
 * Integration tests for GET/POST/PUT/DELETE /api/tags
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
vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

// Inject a test user via withAuth mock
const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

// Mock cors to no-op
vi.mock('../../../utils/cors.js', () => ({
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
    tag: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    transactionTag: {
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/tags.js';

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
  mockUser.role = 'admin';
  // Wire $transaction to call the callback with mockPrisma
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

// ---------------------------------------------------------------------------
// GET /api/tags
// ---------------------------------------------------------------------------

describe('GET /api/tags', () => {
  it('returns 200 with tags array', async () => {
    mockPrisma.tag.findMany.mockResolvedValueOnce([{ id: 1, name: 'Travel' }]);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual([{ id: 1, name: 'Travel' }]);
    expect(mockPrisma.tag.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'test-tenant-123' },
      orderBy: { name: 'asc' },
    });
  });

  it('returns 200 with empty array when no tags exist', async () => {
    mockPrisma.tag.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tags
// ---------------------------------------------------------------------------

describe('POST /api/tags', () => {
  it('returns 400 when name is missing', async () => {
    const req = makeReq({ method: 'POST', body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Tag name is required' });
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });

  it('returns 201 with created tag on success', async () => {
    // No conflict
    mockPrisma.tag.findUnique.mockResolvedValueOnce(null);

    const createdTag = { id: 1, name: 'Travel', color: null, emoji: null, tenantId: 'test-tenant-123' };
    mockPrisma.tag.create.mockResolvedValueOnce(createdTag);


    const req = makeReq({ method: 'POST', body: { name: 'Travel' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(res._body).toEqual(createdTag);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.tag.create).toHaveBeenCalledWith({
      data: {
        name: 'Travel',
        color: undefined,
        emoji: undefined,
        tenantId: 'test-tenant-123',
      },
    });
  });

  it('returns 201 with budget, startDate, and endDate', async () => {
    mockPrisma.tag.findUnique.mockResolvedValueOnce(null);

    const createdTag = {
      id: 2, name: 'Japan 2026', color: null, emoji: null,
      budget: 5000, startDate: '2026-04-01T00:00:00.000Z', endDate: '2026-04-14T00:00:00.000Z',
      tenantId: 'test-tenant-123',
    };
    mockPrisma.tag.create.mockResolvedValueOnce(createdTag);


    const req = makeReq({
      method: 'POST',
      body: {
        name: 'Japan 2026',
        budget: '5000',
        startDate: '2026-04-01',
        endDate: '2026-04-14',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(res._body).toEqual(createdTag);
    expect(mockPrisma.tag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Japan 2026',
        budget: 5000,
        startDate: expect.any(Date),
        endDate: expect.any(Date),
        tenantId: 'test-tenant-123',
      }),
    });
  });

  it('handles null budget correctly', async () => {
    mockPrisma.tag.findUnique.mockResolvedValueOnce(null);

    const createdTag = { id: 3, name: 'No Budget', budget: null, tenantId: 'test-tenant-123' };
    mockPrisma.tag.create.mockResolvedValueOnce(createdTag);


    const req = makeReq({
      method: 'POST',
      body: { name: 'No Budget', budget: null },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(mockPrisma.tag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        budget: null,
      }),
    });
  });

  it('returns 409 when tag name already exists', async () => {
    mockPrisma.tag.findUnique.mockResolvedValueOnce({ id: 1, name: 'Travel', tenantId: 'test-tenant-123' });

    const req = makeReq({ method: 'POST', body: { name: 'Travel' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
    expect(res._body).toEqual({ error: 'Tag with name "Travel" already exists' });
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PUT /api/tags
// ---------------------------------------------------------------------------

describe('PUT /api/tags', () => {
  it('returns 400 when id query param is missing or invalid', async () => {
    const req = makeReq({ method: 'PUT', query: {}, body: { name: 'Updated' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid tag ID' });
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('returns 404 when tag does not exist', async () => {
    mockPrisma.tag.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({ method: 'PUT', query: { id: '1' }, body: { name: 'Updated' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Tag not found in this tenant' });
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('returns 200 and updates tag name', async () => {
    const existingTag = { id: 1, name: 'Travel', color: null, emoji: null, tenantId: 'test-tenant-123' };
    const updatedTag = { id: 1, name: 'Updated', color: null, emoji: null, tenantId: 'test-tenant-123' };

    // findUnique for existence check
    mockPrisma.tag.findUnique.mockResolvedValueOnce(existingTag);
    // findUnique for name conflict check (no conflict)
    mockPrisma.tag.findUnique.mockResolvedValueOnce(null);

    mockPrisma.tag.update.mockResolvedValueOnce(updatedTag);


    const req = makeReq({ method: 'PUT', query: { id: '1' }, body: { name: 'Updated' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(updatedTag);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.tag.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: 'Updated' },
    });
  });

  it('returns 200 and updates budget, startDate, endDate', async () => {
    const existingTag = { id: 1, name: 'Travel', budget: null, startDate: null, endDate: null, tenantId: 'test-tenant-123' };
    const updatedTag = {
      id: 1, name: 'Travel', budget: 3000,
      startDate: '2026-04-01T00:00:00.000Z', endDate: '2026-04-14T00:00:00.000Z',
      tenantId: 'test-tenant-123',
    };

    mockPrisma.tag.findUnique.mockResolvedValueOnce(existingTag);
    mockPrisma.tag.update.mockResolvedValueOnce(updatedTag);


    const req = makeReq({
      method: 'PUT',
      query: { id: '1' },
      body: { budget: '3000', startDate: '2026-04-01', endDate: '2026-04-14' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(updatedTag);
    expect(mockPrisma.tag.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        budget: 3000,
        startDate: expect.any(Date),
        endDate: expect.any(Date),
      },
    });
  });

  it('clears budget when set to null', async () => {
    const existingTag = { id: 1, name: 'Travel', budget: 3000, tenantId: 'test-tenant-123' };
    const updatedTag = { id: 1, name: 'Travel', budget: null, tenantId: 'test-tenant-123' };

    mockPrisma.tag.findUnique.mockResolvedValueOnce(existingTag);
    mockPrisma.tag.update.mockResolvedValueOnce(updatedTag);


    const req = makeReq({
      method: 'PUT',
      query: { id: '1' },
      body: { budget: null },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.tag.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { budget: null },
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/tags
// ---------------------------------------------------------------------------

describe('DELETE /api/tags', () => {
  it('returns 204 on successful delete', async () => {
    const existingTag = { id: 1, name: 'Travel', tenantId: 'test-tenant-123' };
    mockPrisma.tag.findUnique.mockResolvedValueOnce(existingTag);
    mockPrisma.transactionTag.count.mockResolvedValueOnce(0);
    mockPrisma.tag.delete.mockResolvedValueOnce(existingTag);


    const req = makeReq({ method: 'DELETE', query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(204);
    expect(res.end).toHaveBeenCalled();
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.tag.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('returns 409 when tag has linked transactions', async () => {
    const existingTag = { id: 1, name: 'Travel', tenantId: 'test-tenant-123' };
    mockPrisma.tag.findUnique.mockResolvedValueOnce(existingTag);
    mockPrisma.transactionTag.count.mockResolvedValueOnce(3);

    const req = makeReq({ method: 'DELETE', query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
    expect(res._body).toEqual({
      error: 'Cannot delete tag',
      details: 'Tag is currently associated with 3 transaction(s). Remove associations first.',
    });
    expect(mockPrisma.tag.delete).not.toHaveBeenCalled();
  });
});

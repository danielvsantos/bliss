/**
 * Unit tests for /api/categories
 * Covers: GET (list + by id), POST create, PUT update, DELETE (simple + merge), 405 guard
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

const mockUser = { id: 1, tenantId: 'tenant-abc', role: 'admin', email: 'admin@test.com' };

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

const { mockPrisma, mockProduceEvent } = vi.hoisted(() => ({
  mockPrisma: {
    category: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    transaction: { count: vi.fn(), updateMany: vi.fn() },
    plaidTransaction: { updateMany: vi.fn() },
    transactionEmbedding: { updateMany: vi.fn() },
    portfolioItem: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../utils/produceEvent.js', () => ({ produceEvent: mockProduceEvent }));

import handler from '../../../pages/api/categories.js';

// ---------------------------------------------------------------------------
// helpers
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
  mockProduceEvent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// GET /api/categories
// ---------------------------------------------------------------------------

describe('GET /api/categories', () => {
  it('returns a paginated list of categories', async () => {
    const cats = [{ id: 1, name: 'Food', type: 'Essentials', group: 'Daily' }];
    mockPrisma.category.findMany.mockResolvedValue(cats);
    mockPrisma.category.count.mockResolvedValue(1);

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.categories).toEqual(cats);
    expect(res._body.total).toBe(1);
    expect(res._body.page).toBe(1);
  });

  it('supports filtering by name, type, group', async () => {
    mockPrisma.category.findMany.mockResolvedValue([]);
    mockPrisma.category.count.mockResolvedValue(0);

    const req = makeReq({
      method: 'GET',
      query: { name: 'Food', type: 'Essentials', group: 'Daily', sortBy: 'type', sortOrder: 'desc' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.filters.name).toBe('Food');
  });

  it('returns a single category when id is provided', async () => {
    const cat = { id: 5, name: 'Rent', tenantId: 'tenant-abc' };
    mockPrisma.category.findFirst.mockResolvedValue(cat);

    const req = makeReq({ method: 'GET', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(cat);
  });

  it('returns 400 for invalid id format', async () => {
    const req = makeReq({ method: 'GET', query: { id: 'abc' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid category id format/i);
  });

  it('returns 404 when category not found by id', async () => {
    mockPrisma.category.findFirst.mockResolvedValue(null);

    const req = makeReq({ method: 'GET', query: { id: '99' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 400 when query fails', async () => {
    mockPrisma.category.findMany.mockRejectedValue(new Error('DB error'));
    mockPrisma.category.count.mockRejectedValue(new Error('DB error'));

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/categories
// ---------------------------------------------------------------------------

describe('POST /api/categories', () => {
  it('creates a new category and returns 201', async () => {
    const created = { id: 10, name: 'Transport', group: 'Commute', type: 'Essentials', tenantId: 'tenant-abc' };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.category.create.mockResolvedValue(created);
      return fn(mockPrisma);
    });

    const req = makeReq({
      method: 'POST',
      body: { name: 'Transport', group: 'Commute', type: 'Essentials' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
  });

  it('returns 400 when required fields are missing', async () => {
    const req = makeReq({ method: 'POST', body: { name: 'Partial' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/missing required fields/i);
  });

  it('returns 400 for invalid category type', async () => {
    const req = makeReq({
      method: 'POST',
      body: { name: 'X', group: 'Y', type: 'InvalidType' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid category type/i);
  });

  it('returns 409 on unique constraint violation', async () => {
    const err: any = new Error('Unique constraint failed');
    err.code = 'P2002';
    mockPrisma.$transaction.mockRejectedValue(err);

    const req = makeReq({
      method: 'POST',
      body: { name: 'Food', group: 'Daily', type: 'Essentials' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/categories
// ---------------------------------------------------------------------------

describe('PUT /api/categories', () => {
  it('updates a category and returns 200', async () => {
    const existing = { id: 3, name: 'Old', tenantId: 'tenant-abc', processingHint: null };
    const updated = { ...existing, name: 'New' };
    mockPrisma.category.findUnique.mockResolvedValue(existing);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.category.update.mockResolvedValue(updated);
      return fn(mockPrisma);
    });

    const req = makeReq({
      method: 'PUT',
      query: { id: '3' },
      body: { name: 'New', type: 'Essentials' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });

  it('returns 400 for invalid id', async () => {
    const req = makeReq({ method: 'PUT', query: { id: 'abc' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid category id/i);
  });

  it('returns 400 for invalid type', async () => {
    const req = makeReq({
      method: 'PUT',
      query: { id: '3' },
      body: { type: 'BadType' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 400 when system-managed fields are included', async () => {
    const req = makeReq({
      method: 'PUT',
      query: { id: '3' },
      body: { processingHint: 'SOMETHING' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/system-managed/i);
  });

  it('returns 404 when category does not belong to tenant', async () => {
    mockPrisma.category.findUnique.mockResolvedValue({ id: 3, tenantId: 'other-tenant' });

    const req = makeReq({
      method: 'PUT',
      query: { id: '3' },
      body: { name: 'New', type: 'Essentials' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 404 when category not found', async () => {
    mockPrisma.category.findUnique.mockResolvedValue(null);

    const req = makeReq({
      method: 'PUT',
      query: { id: '99' },
      body: { name: 'New' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 409 on unique constraint violation during update', async () => {
    mockPrisma.category.findUnique.mockResolvedValue({ id: 3, tenantId: 'tenant-abc' });
    const err: any = new Error('Unique');
    err.code = 'P2002';
    mockPrisma.$transaction.mockRejectedValue(err);

    const req = makeReq({
      method: 'PUT',
      query: { id: '3' },
      body: { name: 'Dupe', type: 'Essentials' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/categories
// ---------------------------------------------------------------------------

describe('DELETE /api/categories', () => {
  it('deletes a category with no transactions and returns 200', async () => {
    const cat = { id: 5, name: 'Food', tenantId: 'tenant-abc', processingHint: null, group: 'Daily' };
    mockPrisma.category.findFirst.mockResolvedValue(cat);
    mockPrisma.transaction.count.mockResolvedValue(0);
    const deleted = { ...cat };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.category.delete.mockResolvedValue(deleted);
      return fn(mockPrisma);
    });

    const req = makeReq({ method: 'DELETE', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.message).toMatch(/deleted successfully/i);
  });

  it('returns 400 for invalid id', async () => {
    const req = makeReq({ method: 'DELETE', query: { id: 'xyz' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 404 when category not found', async () => {
    mockPrisma.category.findFirst.mockResolvedValue(null);

    const req = makeReq({ method: 'DELETE', query: { id: '99' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 400 when category has transactions and no mergeInto', async () => {
    mockPrisma.category.findFirst.mockResolvedValue({
      id: 5, name: 'Food', tenantId: 'tenant-abc', processingHint: null, group: 'Daily',
    });
    mockPrisma.transaction.count.mockResolvedValue(5);

    const req = makeReq({ method: 'DELETE', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.requiresMerge).toBe(true);
    expect(res._body.transactionCount).toBe(5);
  });

  it('returns 400 when mergeInto equals the category id', async () => {
    mockPrisma.category.findFirst.mockResolvedValue({
      id: 5, name: 'Food', tenantId: 'tenant-abc', processingHint: null, group: 'Daily',
    });
    mockPrisma.transaction.count.mockResolvedValue(3);

    const req = makeReq({ method: 'DELETE', query: { id: '5', mergeInto: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/cannot merge.*itself/i);
  });

  it('returns 400 when target merge category not found', async () => {
    mockPrisma.category.findFirst
      .mockResolvedValueOnce({ id: 5, name: 'Food', tenantId: 'tenant-abc', processingHint: null, group: 'Daily' })
      .mockResolvedValueOnce(null); // target not found
    mockPrisma.transaction.count.mockResolvedValue(3);

    const req = makeReq({ method: 'DELETE', query: { id: '5', mergeInto: '10' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/target merge category not found/i);
  });

  it('merges transactions and deletes category', async () => {
    const cat = { id: 5, name: 'Food', tenantId: 'tenant-abc', processingHint: null, group: 'Daily' };
    const targetCat = { id: 10, name: 'Other', tenantId: 'tenant-abc' };
    mockPrisma.category.findFirst
      .mockResolvedValueOnce(cat)
      .mockResolvedValueOnce(targetCat);
    mockPrisma.transaction.count.mockResolvedValue(3);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.transaction.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.plaidTransaction.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.transactionEmbedding.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.portfolioItem.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.category.delete.mockResolvedValue(cat);
      return fn(mockPrisma);
    });

    const req = makeReq({ method: 'DELETE', query: { id: '5', mergeInto: '10' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.message).toMatch(/reassigned/i);
    expect(mockProduceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRANSACTIONS_IMPORTED' })
    );
  });

  it('returns 400 when last system-critical category is deleted', async () => {
    mockPrisma.category.findFirst.mockResolvedValue({
      id: 5, name: 'Income', tenantId: 'tenant-abc', processingHint: 'INCOME', group: 'Income',
    });
    mockPrisma.category.count.mockResolvedValue(0); // last one in group
    mockPrisma.transaction.count.mockResolvedValue(0);

    const req = makeReq({ method: 'DELETE', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/deletion rejected/i);
  });
});

// ---------------------------------------------------------------------------
// 405 guard
// ---------------------------------------------------------------------------

describe('405 Method Not Allowed', () => {
  it('returns 405 for PATCH', async () => {
    const req = makeReq({ method: 'PATCH' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});

/**
 * Unit tests for GET/POST /api/admin/default-categories
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    category: { count: vi.fn(), createMany: vi.fn() },
    tenant: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../../prisma/prisma', () => ({ default: mockPrisma }));
vi.mock('../../../../lib/defaultCategories', () => ({
  DEFAULT_CATEGORIES: [
    { code: 'FOOD', name: 'Food', group: 'Daily', type: 'Essentials', icon: '🍔' },
    { code: 'RENT', name: 'Rent', group: 'Housing', type: 'Essentials' },
  ],
}));

import handler from '../../../pages/api/admin/default-categories/index.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'GET', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

const ADMIN_KEY = 'admin-secret';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

describe('Auth guard', () => {
  it('returns 401 without admin key', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
  });

  it('returns 200 for OPTIONS', async () => {
    const req = makeReq({ method: 'OPTIONS', headers: { 'x-admin-key': ADMIN_KEY } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });
});

describe('GET /api/admin/default-categories', () => {
  it('returns list of default categories with stats', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ defaultCategoryCode: 'FOOD', count: 5 }])
      .mockResolvedValueOnce([{ defaultCategoryCode: 'FOOD', count: 2 }]);

    const req = makeReq({ method: 'GET', headers: { 'x-admin-key': ADMIN_KEY } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(Array.isArray(res._body)).toBe(true);
    const food = res._body.find((c: any) => c.code === 'FOOD');
    expect(food.tenantCount).toBe(5);
    expect(food.globalEmbeddingCount).toBe(2);
  });
});

describe('POST /api/admin/default-categories', () => {
  it('provisions new default category to all tenants', async () => {
    mockPrisma.category.count.mockResolvedValue(0);
    mockPrisma.tenant.findMany.mockResolvedValue([{ id: 'tenant-1' }, { id: 'tenant-2' }]);
    mockPrisma.category.createMany.mockResolvedValue({ count: 2 });

    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      body: { code: 'TRAVEL', name: 'Travel', group: 'Lifestyle', type: 'Lifestyle' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(res._body.provisioned).toBe(2);
  });

  it('returns 400 when required fields missing', async () => {
    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      body: { code: 'TRAVEL' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/required/i);
  });

  it('returns 400 for invalid code format', async () => {
    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      body: { code: 'invalid-code', name: 'X', group: 'Y', type: 'Essentials' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/SNAKE_UPPER_CASE/i);
  });

  it('returns 409 when code already exists', async () => {
    mockPrisma.category.count.mockResolvedValue(3);

    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      body: { code: 'FOOD', name: 'Food', group: 'Daily', type: 'Essentials' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
  });

  it('returns 400 for invalid portfolioItemKeyStrategy', async () => {
    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      body: { code: 'NEW_CAT', name: 'X', group: 'Y', type: 'Essentials', portfolioItemKeyStrategy: 'INVALID' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });
});

describe('405 guard', () => {
  it('returns 405 for PATCH', async () => {
    const req = makeReq({ method: 'PATCH', headers: { 'x-admin-key': ADMIN_KEY } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});

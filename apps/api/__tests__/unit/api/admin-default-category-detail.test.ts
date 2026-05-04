/**
 * Unit tests for PUT /api/admin/default-categories/[code]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    category: { count: vi.fn(), updateMany: vi.fn() },
    globalEmbedding: { updateMany: vi.fn() },
  },
}));

vi.mock('../../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../../prisma/prisma', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/admin/default-categories/[code].js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'PUT',
    headers: {},
    cookies: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

const ADMIN_KEY = 'test-admin-key';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

describe('Admin auth', () => {
  it('returns 401 when x-admin-key is missing', async () => {
    const req = makeReq({ query: { code: 'FOOD' }, body: { name: 'Food' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
  });

  it('returns 401 when x-admin-key is wrong', async () => {
    const req = makeReq({
      headers: { 'x-admin-key': 'wrong-key' },
      query: { code: 'FOOD' },
      body: { name: 'Food' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
  });
});

describe('PUT /api/admin/default-categories/[code]', () => {
  it('updates category metadata and returns 200', async () => {
    mockPrisma.category.count.mockResolvedValue(3);
    mockPrisma.category.updateMany.mockResolvedValue({ count: 3 });

    const req = makeReq({
      method: 'PUT',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
      body: { name: 'Updated Food' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.updatedTenantCategories).toBe(3);
  });

  it('returns 404 when no categories with code exist', async () => {
    mockPrisma.category.count.mockResolvedValue(0);

    const req = makeReq({
      method: 'PUT',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'NONEXISTENT' },
      body: { name: 'Something' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 400 when processingHint is included', async () => {
    const req = makeReq({
      method: 'PUT',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
      body: { processingHint: 'something' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/processingHint/);
  });

  it('returns 400 when no changes provided', async () => {
    const req = makeReq({
      method: 'PUT',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
      body: {},
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/no changes/i);
  });

  it('returns 400 for invalid portfolioItemKeyStrategy', async () => {
    const req = makeReq({
      method: 'PUT',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
      body: { portfolioItemKeyStrategy: 'INVALID' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 400 for invalid newCode format', async () => {
    const req = makeReq({
      method: 'PUT',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
      body: { newCode: 'invalid-code' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/SNAKE_UPPER_CASE/i);
  });

  it('renames code and updates GlobalEmbedding rows', async () => {
    mockPrisma.category.count
      .mockResolvedValueOnce(3)  // existing count
      .mockResolvedValueOnce(0); // conflict check (no conflict)
    mockPrisma.category.updateMany.mockResolvedValue({ count: 3 });
    mockPrisma.globalEmbedding.updateMany.mockResolvedValue({ count: 2 });

    const req = makeReq({
      method: 'PUT',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
      body: { newCode: 'FOOD_NEW' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.renamedTo).toBe('FOOD_NEW');
    expect(res._body.globalEmbeddingsRenamed).toBe(2);
  });

  it('returns 409 when new code is already taken', async () => {
    mockPrisma.category.count
      .mockResolvedValueOnce(3)  // existing count
      .mockResolvedValueOnce(2); // conflict: code already in use
    mockPrisma.category.updateMany.mockResolvedValue({ count: 3 });

    const req = makeReq({
      method: 'PUT',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
      body: { newCode: 'FOOD_CONFLICT' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
  });

  it('returns 405 for GET method', async () => {
    const req = makeReq({
      method: 'GET',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });

  it('returns 200 for OPTIONS', async () => {
    const req = makeReq({
      method: 'OPTIONS',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });
});

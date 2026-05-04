/**
 * Unit tests for POST /api/admin/default-categories/[code]/regenerate-embeddings
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    category: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
  },
}));

vi.mock('../../../../../prisma/prisma', () => ({ default: mockPrisma }));
vi.mock('../../../../../prisma/prisma.js', () => ({ default: mockPrisma }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import handler from '../../../pages/api/admin/default-categories/[code]/regenerate-embeddings.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'POST', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
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
  process.env.INTERNAL_API_KEY = 'test-internal-key';
  mockFetch.mockResolvedValue({ ok: true });
});

describe('Auth guard', () => {
  it('returns 401 without admin key', async () => {
    const req = makeReq({ query: { code: 'FOOD' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
  });

  it('returns 200 for OPTIONS', async () => {
    const req = makeReq({ method: 'OPTIONS', headers: { 'x-admin-key': ADMIN_KEY }, query: { code: 'FOOD' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });
});

describe('POST /api/admin/default-categories/[code]/regenerate-embeddings', () => {
  it('returns 0 regenerated when no categories found', async () => {
    mockPrisma.category.findMany.mockResolvedValue([]);

    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'NONEXISTENT' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.regenerated).toBe(0);
    expect(res._body.message).toMatch(/no categories found/i);
  });

  it('returns 0 regenerated when no transactions found', async () => {
    mockPrisma.category.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    mockPrisma.transaction.findMany.mockResolvedValue([]);

    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.regenerated).toBe(0);
    expect(res._body.message).toMatch(/no transactions found/i);
  });

  it('regenerates embeddings for all unique descriptions', async () => {
    mockPrisma.category.findMany.mockResolvedValue([{ id: 1 }]);
    mockPrisma.transaction.findMany.mockResolvedValue([
      { description: 'Starbucks' },
      { description: 'starbucks' }, // duplicate after normalization
      { description: 'Amazon' },
    ]);
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // Starbucks
      .mockResolvedValueOnce({ ok: true }); // Amazon

    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.regenerated).toBe(2);
    expect(res._body.failed).toBe(0);
  });

  it('counts failures when backend returns error', async () => {
    mockPrisma.category.findMany.mockResolvedValue([{ id: 1 }]);
    mockPrisma.transaction.findMany.mockResolvedValue([
      { description: 'Starbucks' },
      { description: 'Amazon' },
    ]);
    mockFetch
      .mockResolvedValueOnce({ ok: false, text: async () => 'error' })
      .mockResolvedValueOnce({ ok: true });

    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.regenerated).toBe(1);
    expect(res._body.failed).toBe(1);
  });

  it('counts failures on network errors', async () => {
    mockPrisma.category.findMany.mockResolvedValue([{ id: 1 }]);
    mockPrisma.transaction.findMany.mockResolvedValue([{ description: 'Coffee' }]);
    mockFetch.mockRejectedValue(new Error('Network error'));

    const req = makeReq({
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { code: 'FOOD' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.failed).toBe(1);
  });

  it('returns 405 for GET', async () => {
    const req = makeReq({ method: 'GET', headers: { 'x-admin-key': ADMIN_KEY }, query: { code: 'FOOD' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});

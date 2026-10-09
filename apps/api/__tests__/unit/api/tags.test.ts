/**
 * Unit tests for /api/tags color validation (#93 B7).
 *
 * Mocked-handler pattern: withAuth, rate limiter, cors, Sentry and Prisma
 * are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => async (req: any, res: any) => {
    req.user = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };
    return handler(req, res);
  },
}));

vi.mock('../../../utils/cors.js', () => ({
  cors: () => false,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => {
  const tag = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  return {
    mockPrisma: {
      tag,
      $transaction: vi.fn(async (fn: any) => fn({ tag })),
    },
  };
});

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/tags.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'GET', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

const call = async (req: NextApiRequest) => {
  const res = makeRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.tag.findUnique.mockResolvedValue(null);
  mockPrisma.tag.create.mockImplementation(async ({ data }: any) => ({ id: 1, ...data }));
  mockPrisma.tag.update.mockImplementation(async ({ data }: any) => ({ id: 7, name: 'Trip', ...data }));
});

describe('POST /api/tags — color', () => {
  it.each(['notacolor', '#abc', '#12345g', 'ff0000', '#ff00001', 123])('rejects %j with 400', async (color) => {
    const res = await call(makeReq({ method: 'POST', body: { name: 'Trip', color } }));
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/hex color/i);
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });

  it.each(['#6D657A', '#ff0000', null, undefined])('accepts %j', async (color) => {
    const res = await call(makeReq({ method: 'POST', body: { name: 'Trip', color } }));
    expect(res._status).toBe(201);
    expect(mockPrisma.tag.create).toHaveBeenCalled();
  });
});

describe('PUT /api/tags — color', () => {
  it('rejects an invalid color with 400 before touching the tag', async () => {
    const res = await call(makeReq({ method: 'PUT', query: { id: '7' }, body: { color: 'notacolor' } }));
    expect(res._status).toBe(400);
    expect(mockPrisma.tag.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('accepts a hex color and null', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue({ id: 7, name: 'Trip', tenantId: 'test-tenant-123' });
    for (const color of ['#2E8B57', null]) {
      const res = await call(makeReq({ method: 'PUT', query: { id: '7' }, body: { color } }));
      expect(res._status).toBe(200);
      expect(res._body.color).toBe(color);
    }
  });
});

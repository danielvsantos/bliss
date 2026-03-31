/**
 * Integration tests for GET /api/categories
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * Uses the real bliss_test Postgres database via Prisma.
 *
 * Rate limiter is mocked to a no-op.
 * JWT auth is tested end-to-end: withAuth decodes the token and hydrates req.user
 * from the real bliss_test User table.
 *
 * Requires: bliss_test Postgres database with migrations applied.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Mock rate limiter before any handler imports
vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next()
  ),
}));

import handler from '../../../pages/api/categories.js';
import prisma from '../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant } from '../../helpers/tenant.js';

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

interface MockRes extends Partial<NextApiResponse> {
  _status: number | undefined;
  _body: unknown;
}

function makeRes(): MockRes {
  const res: MockRes = {
    _status: undefined,
    _body: undefined,
    status: vi.fn().mockImplementation((code: number) => {
      res._status = code;
      return res;
    }),
    json: vi.fn().mockImplementation((body: unknown) => {
      res._body = body;
      return res;
    }),
    setHeader: vi.fn().mockReturnValue(undefined),
    end: vi.fn(),
  };
  return res;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /api/categories', () => {
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    ({ tenantId, token } = await createIsolatedTenant('categories'));

    // Seed a test category directly via Prisma
    await prisma.category.create({
      data: {
        name: 'Groceries',
        group: 'Living',
        type: 'Expenses',
        tenantId,
      },
    });
  });

  afterAll(async () => {
    await teardownTenant(tenantId);
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
  });

  it('returns 200 with categories array for an authenticated user', async () => {
    const req = makeReq({
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const body = res._body as { categories?: unknown[] } | unknown[];
    // Response may be an array directly or wrapped in an object
    const categories = Array.isArray(body) ? body : (body as { categories?: unknown[] }).categories;
    expect(categories).toBeDefined();
    expect(Array.isArray(categories)).toBe(true);
    // At least the seeded Groceries category should be present
    expect(categories!.length).toBeGreaterThanOrEqual(1);
    expect(categories!.some((c: unknown) => (c as { name: string }).name === 'Groceries')).toBe(true);
  });
});

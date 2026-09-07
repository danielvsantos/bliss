/**
 * Integration tests for GET /api/accounts and POST /api/accounts
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

import handler from '../../../pages/api/accounts.js';
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

describe('GET /api/accounts', () => {
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    ({ tenantId, token } = await createIsolatedTenant('accounts'));
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

  it('returns 401 when Authorization token is invalid', async () => {
    const req = makeReq({
      method: 'GET',
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
  });

  it('returns 200 with an empty accounts array for a new tenant', async () => {
    const req = makeReq({
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      query: {},
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const body = res._body as { accounts: unknown[]; total: number };
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(body.accounts).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

describe('POST /api/accounts', () => {
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    ({ tenantId, token } = await createIsolatedTenant('accounts-post'));
  });

  afterAll(async () => {
    await teardownTenant(tenantId);
  });

  it('returns 400 when required fields are missing', async () => {
    const req = makeReq({
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { name: 'Test Account' }, // missing bankId, currencyCode, countryId, ownerIds
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });
});

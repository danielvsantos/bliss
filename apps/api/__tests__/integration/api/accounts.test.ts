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

describe('POST /api/accounts — isDraft flag', () => {
  let tenantId: string;
  let userId: string;
  let token: string;
  let bankId: number;

  beforeAll(async () => {
    ({ tenantId, userId, token } = await createIsolatedTenant('accounts-isdraft'));
    // Reference data (Currency/Country/Bank) is only present when the DB has been
    // seeded — the api-integration CI job runs `migrate deploy` without a seed,
    // so make this suite self-sufficient by upserting the rows it needs.
    await prisma.currency.upsert({
      where: { id: 'USD' },
      update: {},
      create: { id: 'USD', name: 'US Dollar', symbol: '$' },
    });
    await prisma.country.upsert({
      where: { id: 'USA' },
      update: {},
      create: { id: 'USA', name: 'United States' },
    });
    const bank = await prisma.bank.upsert({
      where: { name: 'isDraft Test Bank' },
      update: {},
      create: { name: 'isDraft Test Bank' },
    });
    bankId = bank.id;
    await prisma.tenantCurrency.create({ data: { tenantId, currencyId: 'USD' } });
    await prisma.tenantCountry.create({ data: { tenantId, countryId: 'USA' } });
    await prisma.tenantBank.create({ data: { tenantId, bankId } });
  });

  afterAll(async () => {
    await prisma.accountOwner.deleteMany({ where: { account: { tenantId } } });
    await prisma.account.deleteMany({ where: { tenantId } });
    await prisma.tenantBank.deleteMany({ where: { tenantId } });
    await prisma.tenantCountry.deleteMany({ where: { tenantId } });
    await prisma.tenantCurrency.deleteMany({ where: { tenantId } });
    await teardownTenant(tenantId);
    // Drop the bank this suite created (no other rows reference it by now).
    // Currency/Country rows are shared reference data — leave them (upsert is idempotent).
    await prisma.tenantBank.deleteMany({ where: { bankId } });
    await prisma.bank.deleteMany({ where: { id: bankId, name: 'isDraft Test Bank' } });
  });

  async function createAccount(body: Record<string, unknown>) {
    const req = makeReq({
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body,
    });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    return res;
  }

  it('persists isDraft: true and GET by id returns it', async () => {
    const res = await createAccount({
      name: 'Chase',
      accountNumber: 'chase-acc-1',
      bankId,
      currencyCode: 'USD',
      countryId: 'USA',
      ownerIds: [userId],
      isDraft: true,
    });

    expect(res._status).toBe(201);
    const created = res._body as { id: number; isDraft: boolean };
    expect(created.isDraft).toBe(true);

    const getReq = makeReq({
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      query: { id: String(created.id) },
    });
    const getRes = makeRes();
    await handler(getReq as NextApiRequest, getRes as unknown as NextApiResponse);

    expect(getRes._status).toBe(200);
    expect((getRes._body as { isDraft: boolean }).isDraft).toBe(true);
  });

  it('defaults isDraft to false when omitted', async () => {
    const res = await createAccount({
      name: 'Chase Real',
      accountNumber: '000123456789',
      bankId,
      currencyCode: 'USD',
      countryId: 'USA',
      ownerIds: [userId],
    });

    expect(res._status).toBe(201);
    expect((res._body as { isDraft: boolean }).isDraft).toBe(false);
  });

  it('PUT with isDraft: false clears the flag on a draft account', async () => {
    const createRes = await createAccount({
      name: 'Ally',
      accountNumber: 'ally-acc-1',
      bankId,
      currencyCode: 'USD',
      countryId: 'USA',
      ownerIds: [userId],
      isDraft: true,
    });
    const draftId = (createRes._body as { id: number }).id;

    const putReq = makeReq({
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      query: { id: String(draftId) },
      body: { accountNumber: '999888777666', isDraft: false },
    });
    const putRes = makeRes();
    await handler(putReq as NextApiRequest, putRes as unknown as NextApiResponse);

    expect(putRes._status).toBe(200);
    expect((putRes._body as { isDraft: boolean }).isDraft).toBe(false);
  });
});

/**
 * Unit tests for /api/accounts — covering branches not hit by integration tests
 * POST (create), PUT (update), DELETE, 405 guard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'tenant-abc', role: 'admin', email: 'admin@test.com' };
const { authState } = vi.hoisted(() => ({ authState: { extra: {} as Record<string, unknown> } }));

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => async (req: any, res: any) => {
    req.user = { ...mockUser, ...authState.extra };
    return handler(req, res);
  },
}));

vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), init: vi.fn() }));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    account: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    tenantCurrency: { findFirst: vi.fn() },
    tenantCountry: { findFirst: vi.fn() },
    tenantBank: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    accountOwner: { deleteMany: vi.fn(), createMany: vi.fn() },
    transaction: { count: vi.fn() },
    plaidTransaction: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/accounts.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  authState.extra = {};
});

describe('GET /api/accounts', () => {
  it('returns paginated accounts list', async () => {
    mockPrisma.account.findMany.mockResolvedValue([]);
    mockPrisma.account.count.mockResolvedValue(0);

    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.accounts).toEqual([]);
  });

  it('returns single account when id provided', async () => {
    const account = { id: 1, tenantId: 'tenant-abc', name: 'Checking' };
    mockPrisma.account.findUnique.mockResolvedValue(account);

    const req = makeReq({ query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.name).toBe('Checking');
  });

  it('returns 404 when account not found by id', async () => {
    mockPrisma.account.findUnique.mockResolvedValue(null);

    const req = makeReq({ query: { id: '99' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 404 when account belongs to different tenant', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({ id: 1, tenantId: 'other-tenant', name: 'Checking' });

    const req = makeReq({ query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });
});

describe('POST /api/accounts', () => {
  it('returns 400 when required fields missing', async () => {
    const req = makeReq({ method: 'POST', body: { name: 'Savings' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/missing required fields/i);
  });

  it('returns 400 for invalid bankId', async () => {
    const req = makeReq({
      method: 'POST',
      body: { name: 'S', accountNumber: '123', bankId: 'not-a-number', currencyCode: 'USD', countryId: 'US', ownerIds: [1] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid bankId/i);
  });

  it('returns 400 when currency/country/bank not available for tenant', async () => {
    mockPrisma.tenantCurrency.findFirst.mockResolvedValue(null);
    mockPrisma.tenantCountry.findFirst.mockResolvedValue(null);
    mockPrisma.tenantBank.findUnique.mockResolvedValue(null);

    const req = makeReq({
      method: 'POST',
      body: { name: 'S', accountNumber: '123', bankId: 1, currencyCode: 'USD', countryId: 'US', ownerIds: [1] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid input/i);
  });

  it('returns 400 when owner ids are invalid', async () => {
    mockPrisma.tenantCurrency.findFirst.mockResolvedValue({ id: 'USD' });
    mockPrisma.tenantCountry.findFirst.mockResolvedValue({ id: 'US' });
    mockPrisma.tenantBank.findUnique.mockResolvedValue({ bankId: 1 });
    mockPrisma.user.findMany.mockResolvedValue([]); // no valid users

    const req = makeReq({
      method: 'POST',
      body: { name: 'S', accountNumber: '123', bankId: 1, currencyCode: 'USD', countryId: 'US', ownerIds: [999] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid owner/i);
  });

  it('creates account successfully', async () => {
    mockPrisma.tenantCurrency.findFirst.mockResolvedValue({ id: 'USD' });
    mockPrisma.tenantCountry.findFirst.mockResolvedValue({ id: 'US' });
    mockPrisma.tenantBank.findUnique.mockResolvedValue({ bankId: 1 });
    mockPrisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    const created = { id: 10, name: 'Savings', tenantId: 'tenant-abc' };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.account.create.mockResolvedValue(created);
      return fn(mockPrisma);
    });

    const req = makeReq({
      method: 'POST',
      body: { name: 'Savings', accountNumber: '123', bankId: 1, currencyCode: 'USD', countryId: 'US', ownerIds: [1] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
  });
});

describe('POST /api/accounts — #98 (MCP create_account)', () => {
  const FULL_NUMBER = 'DE89370400440532013000';
  const body = { name: '  Revolut EUR ', accountNumber: FULL_NUMBER, bankId: 7, currencyCode: 'eur', countryId: 'deu' };

  function arrangeValid() {
    mockPrisma.tenantCurrency.findFirst.mockResolvedValue({ currencyId: 'EUR' });
    mockPrisma.tenantCountry.findFirst.mockResolvedValue({ countryId: 'DEU' });
    mockPrisma.tenantBank.findUnique.mockResolvedValue({ bankId: 7 });
    mockPrisma.account.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.account.create.mockImplementation(async ({ data }: any) => ({
      id: 42,
      name: data.name,
      accountNumber: data.accountNumber,
      bankId: data.bankId,
      currencyCode: data.currencyCode,
      countryId: data.countryId,
      tenantId: data.tenantId,
      owners: data.owners.create.map((o: any) => ({ userId: o.userId, user: { id: o.userId, email: 'admin@test.com' } })),
      bank: { id: 7, name: 'Revolut' },
    }));
  }

  it('names every required field in the 400, accountNumber included', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', body: { ...body, accountNumber: '' } }), res);

    expect(res._status).toBe(400);
    expect(res._body.details).toBe('name, accountNumber, bankId, currencyCode and countryId are required');
  });

  it('rejects a blank or over-long name after trimming', async () => {
    for (const name of ['   ', 'x'.repeat(101)]) {
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { ...body, name } }), res);
      expect(res._status).toBe(400);
    }
    expect(mockPrisma.account.create).not.toHaveBeenCalled();
  });

  it('defaults owners to the acting user without re-reading the User row', async () => {
    arrangeValid();
    const res = makeRes();

    await handler(makeReq({ method: 'POST', body }), res);

    expect(res._status).toBe(201);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    const { data, include } = mockPrisma.account.create.mock.calls[0][0];
    expect(data.owners).toEqual({ create: [{ userId: 1 }] });
    expect(data).toMatchObject({ name: 'Revolut EUR', currencyCode: 'EUR', countryId: 'DEU', bankId: 7 });
    expect(include.owners).toEqual({ include: { user: { select: { id: true, email: true } } } });
  });

  it('validates supplied ownerIds against the tenant', async () => {
    arrangeValid();
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);
    const res = makeRes();

    await handler(makeReq({ method: 'POST', body: { ...body, ownerIds: ['u1', 'foreign'] } }), res);

    expect(res._status).toBe(400);
    expect(res._body.error).toBe('Invalid owner IDs');
    expect(mockPrisma.user.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['u1', 'foreign'] }, tenantId: 'tenant-abc' });
    expect(mockPrisma.account.create).not.toHaveBeenCalled();
  });

  it.each([
    ['currency', 'tenantCurrency', 'findFirst'],
    ['country', 'tenantCountry', 'findFirst'],
    ['bankId', 'tenantBank', 'findUnique'],
  ] as const)('reports a %s that is not enabled for the tenant under its details key', async (key, model, fn) => {
    arrangeValid();
    (mockPrisma as any)[model][fn].mockResolvedValue(null);
    const res = makeRes();

    await handler(makeReq({ method: 'POST', body }), res);

    expect(res._status).toBe(400);
    expect(Object.keys(res._body.details)).toEqual([key]);
  });

  it('integration callers get 409 ACCOUNT_EXISTS for the same bank + currency + name', async () => {
    arrangeValid();
    authState.extra = { authType: 'integration', role: 'member' };
    mockPrisma.account.findFirst.mockResolvedValue({ id: 42 });
    const res = makeRes();

    await handler(makeReq({ method: 'POST', body: { ...body, name: 'REVOLUT eur' } }), res);

    expect(res._status).toBe(409);
    expect(res._body).toEqual({ error: 'ACCOUNT_EXISTS', code: 'ACCOUNT_EXISTS', accountId: 42, details: { accountId: 42 } });
    expect(mockPrisma.account.findFirst.mock.calls[0][0].where).toEqual({
      tenantId: 'tenant-abc',
      bankId: 7,
      currencyCode: 'EUR',
      name: { equals: 'REVOLUT eur', mode: 'insensitive' },
    });
    expect(mockPrisma.account.create).not.toHaveBeenCalled();
  });

  it('session callers are not duplicate-checked (in-app onboarding names accounts after the bank)', async () => {
    arrangeValid();
    mockPrisma.account.findFirst.mockResolvedValue({ id: 42 });
    const res = makeRes();

    await handler(makeReq({ method: 'POST', body }), res);

    expect(res._status).toBe(201);
    expect(mockPrisma.account.findFirst).not.toHaveBeenCalled();
  });

  it('never echoes the full account number in the 201 body', async () => {
    arrangeValid();
    const res = makeRes();

    await handler(makeReq({ method: 'POST', body }), res);

    expect(res._status).toBe(201);
    expect(res._body).not.toHaveProperty('accountNumber');
    expect(res._body.accountNumberLast4).toBe('3000');
    expect(JSON.stringify(res._body)).not.toContain(FULL_NUMBER);
    expect(Object.keys(res._body.owners[0].user).sort()).toEqual(['email', 'id']);
  });
});

describe('PUT /api/accounts', () => {
  it('returns 400 when id missing', async () => {
    const req = makeReq({ method: 'PUT', query: {}, body: { name: 'New' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/id must be provided/i);
  });

  it('returns 400 for invalid id format', async () => {
    const req = makeReq({ method: 'PUT', query: { id: 'abc' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid account id format/i);
  });

  it('returns 404 when account not found', async () => {
    mockPrisma.account.findUnique.mockResolvedValue(null);

    const req = makeReq({ method: 'PUT', query: { id: '99' }, body: { name: 'New' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });
});

describe('DELETE /api/accounts', () => {
  it('returns 400 when id missing', async () => {
    const req = makeReq({ method: 'DELETE', query: {}, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 404 when account not found', async () => {
    mockPrisma.account.findUnique.mockResolvedValue(null);

    const req = makeReq({ method: 'DELETE', query: { id: '99' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 404 when the account belongs to another tenant', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({ id: 5, tenantId: 'other-tenant', plaidItemId: null });

    const req = makeReq({ method: 'DELETE', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(mockPrisma.transaction.count).not.toHaveBeenCalled();
  });

  it('deletes a clean manual account and returns 204', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({
      id: 5, tenantId: 'tenant-abc', plaidItemId: null, plaidAccountId: null, plaidItem: null,
    });
    mockPrisma.transaction.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const req = makeReq({ method: 'DELETE', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(204);
    expect(mockPrisma.accountOwner.deleteMany).toHaveBeenCalledWith({ where: { accountId: 5 } });
    expect(mockPrisma.account.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(mockPrisma.plaidTransaction.deleteMany).not.toHaveBeenCalled();
  });

  it('returns structured 409 HAS_TRANSACTIONS when the account has transactions', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({
      id: 5, tenantId: 'tenant-abc', plaidItemId: null, plaidAccountId: null, plaidItem: null,
    });
    mockPrisma.transaction.count.mockResolvedValue(3);

    const req = makeReq({ method: 'DELETE', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
    expect(res._body.reason).toBe('HAS_TRANSACTIONS');
    expect(res._body.transactionCount).toBe(3);
    expect(mockPrisma.account.delete).not.toHaveBeenCalled();
  });

  it('returns structured 409 PLAID_CONNECTED when the Plaid item is still active', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({
      id: 5, tenantId: 'tenant-abc', plaidItemId: 'pi_1', plaidAccountId: 'acc_x',
      plaidItem: { status: 'ACTIVE' },
    });

    const req = makeReq({ method: 'DELETE', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
    expect(res._body.reason).toBe('PLAID_CONNECTED');
    expect(mockPrisma.transaction.count).not.toHaveBeenCalled();
    expect(mockPrisma.account.delete).not.toHaveBeenCalled();
  });

  it('deletes a disconnected (REVOKED) Plaid account and cleans up its PlaidTransaction rows', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({
      id: 5, tenantId: 'tenant-abc', plaidItemId: 'pi_1', plaidAccountId: 'acc_x',
      plaidItem: { status: 'REVOKED' },
    });
    mockPrisma.transaction.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const req = makeReq({ method: 'DELETE', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(204);
    expect(mockPrisma.plaidTransaction.deleteMany).toHaveBeenCalledWith({
      where: { plaidItemId: 'pi_1', plaidAccountId: 'acc_x' },
    });
    expect(mockPrisma.account.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });
});

describe('405 guard', () => {
  it('returns 405 for PATCH', async () => {
    const req = makeReq({ method: 'PATCH' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});

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
import { ensureReferenceData } from '../../helpers/referenceData.js';

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

describe('DELETE /api/accounts', () => {
  let tenantId: string;
  let userId: string;
  let token: string;
  let countryId: string;
  let currencyCode: string;
  let bankId: number;
  let categoryId: number;

  // Track created rows so we can clean up before teardownTenant — AccountOwner
  // and PlaidItem have no onDelete cascade from Tenant/User.
  const createdAccountIds: number[] = [];
  const createdPlaidItemIds: string[] = [];

  async function makeAccount(overrides: Record<string, unknown> = {}): Promise<number> {
    const acc = await prisma.account.create({
      data: {
        name: 'Test Account',
        accountNumber: `DEL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        bankId,
        countryId,
        currencyCode,
        tenantId,
        owners: { create: [{ userId }] },
        ...overrides,
      },
    });
    createdAccountIds.push(acc.id);
    return acc.id;
  }

  beforeAll(async () => {
    ({ tenantId, userId, token } = await createIsolatedTenant('accounts-delete'));
    ({ countryId, currencyCode, bankId } = await ensureReferenceData());
    const cat = await prisma.category.create({
      data: { name: 'Investments', group: 'Growth', type: 'Investments', tenantId },
    });
    categoryId = cat.id;
  });

  afterAll(async () => {
    // Explicit cleanup — order matters (FKs without cascade).
    await prisma.portfolioItem.deleteMany({ where: { tenantId } });
    await prisma.transaction.deleteMany({ where: { tenantId } });
    for (const id of createdAccountIds) {
      await prisma.accountOwner.deleteMany({ where: { accountId: id } });
      await prisma.account.deleteMany({ where: { id } });
    }
    for (const id of createdPlaidItemIds) {
      await prisma.plaidTransaction.deleteMany({ where: { plaidItemId: id } });
      await prisma.plaidItem.deleteMany({ where: { id } });
    }
    await teardownTenant(tenantId);
  });

  it('AC1 — deletes a clean manual account (204), removing the account and its owners', async () => {
    const accountId = await makeAccount();
    // A portfolio item linked to the account — must survive with a null accountId.
    const item = await prisma.portfolioItem.create({
      data: { tenantId, categoryId, accountId, symbol: 'AAPL', currency: currencyCode, source: 'MANUAL' },
    });

    const req = makeReq({
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      query: { id: String(accountId) },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(204);
    expect(await prisma.account.findUnique({ where: { id: accountId } })).toBeNull();
    expect(await prisma.accountOwner.findMany({ where: { accountId } })).toHaveLength(0);

    // AC7 — PortfolioItem survives, unlinked.
    const afterItem = await prisma.portfolioItem.findUnique({ where: { id: item.id } });
    expect(afterItem).not.toBeNull();
    expect(afterItem!.accountId).toBeNull();
  });

  it('AC3 — refuses to delete an account with transactions (409 HAS_TRANSACTIONS, count)', async () => {
    const accountId = await makeAccount();
    await prisma.transaction.create({
      data: {
        transaction_date: new Date(),
        year: 2026, quarter: 'Q1', month: 1, day: 1,
        description: 'COFFEE', debit: 4.5, currency: currencyCode,
        accountId, categoryId, tenantId,
      },
    });

    const req = makeReq({
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      query: { id: String(accountId) },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
    const body = res._body as { reason: string; transactionCount: number };
    expect(body.reason).toBe('HAS_TRANSACTIONS');
    expect(body.transactionCount).toBe(1);
    expect(await prisma.account.findUnique({ where: { id: accountId } })).not.toBeNull();
  });

  it('AC4 — cannot delete an account belonging to another tenant (404)', async () => {
    const other = await createIsolatedTenant('accounts-delete-other');
    const otherRef = await ensureReferenceData();
    const otherAccount = await prisma.account.create({
      data: {
        name: 'Foreign', accountNumber: `FGN-${Date.now()}`,
        bankId: otherRef.bankId, countryId: otherRef.countryId, currencyCode: otherRef.currencyCode,
        tenantId: other.tenantId,
      },
    });

    const req = makeReq({
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      query: { id: String(otherAccount.id) },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(await prisma.account.findUnique({ where: { id: otherAccount.id } })).not.toBeNull();

    await prisma.account.delete({ where: { id: otherAccount.id } });
    await teardownTenant(other.tenantId);
  });

  it('AC5 — refuses to delete a Plaid account whose bank is still connected (409 PLAID_CONNECTED)', async () => {
    const plaidItem = await prisma.plaidItem.create({
      data: {
        tenantId, userId,
        itemId: `item-active-${Date.now()}`,
        accessToken: 'access-sandbox-active',
        status: 'ACTIVE',
      },
    });
    createdPlaidItemIds.push(plaidItem.id);
    const accountId = await makeAccount({ plaidItemId: plaidItem.id, plaidAccountId: `plaid-acc-${Date.now()}` });

    const req = makeReq({
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      query: { id: String(accountId) },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
    expect((res._body as { reason: string }).reason).toBe('PLAID_CONNECTED');
    expect(await prisma.account.findUnique({ where: { id: accountId } })).not.toBeNull();
  });

  it('AC6 — deletes a disconnected Plaid account (204) and purges its PlaidTransaction rows', async () => {
    const plaidAccountId = `plaid-acc-revoked-${Date.now()}`;
    const plaidItem = await prisma.plaidItem.create({
      data: {
        tenantId, userId,
        itemId: `item-revoked-${Date.now()}`,
        accessToken: 'access-sandbox-revoked',
        status: 'REVOKED',
      },
    });
    createdPlaidItemIds.push(plaidItem.id);
    const accountId = await makeAccount({ plaidItemId: plaidItem.id, plaidAccountId });
    await prisma.plaidTransaction.create({
      data: {
        plaidItemId: plaidItem.id,
        plaidAccountId,
        plaidTransactionId: `ptx-${Date.now()}`,
        amount: 12.34,
        date: new Date(),
        name: 'GROCERY',
      },
    });

    const req = makeReq({
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      query: { id: String(accountId) },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(204);
    expect(await prisma.account.findUnique({ where: { id: accountId } })).toBeNull();
    expect(
      await prisma.plaidTransaction.count({ where: { plaidItemId: plaidItem.id, plaidAccountId } })
    ).toBe(0);
    // The PlaidItem row itself is retained (other sub-accounts may reference it).
    expect(await prisma.plaidItem.findUnique({ where: { id: plaidItem.id } })).not.toBeNull();
  });

  it('returns 400 when no id is provided', async () => {
    const req = makeReq({
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      query: {},
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });
});

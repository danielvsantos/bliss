/**
 * Integration tests — integration tokens end to end (#84).
 *
 * Real bliss_test Postgres and the real withAuth: each request carries
 * `Authorization: Bearer bliss_…` and goes through the unmodified route
 * handlers. Covers AC2–AC4, AC6, AC7, AC10 and AC12.
 *
 * Rate limiter is replaced by a counting pass-through; produceEvent and the
 * backend feedback fetch are stubbed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const { limiterCalls } = vi.hoisted(() => ({ limiterCalls: [] as string[] }));

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => (_req: unknown, _res: unknown, next: () => void) => {
      limiterCalls.push(name);
      next();
    },
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../../../utils/produceEvent.js', () => ({
  produceEvent: vi.fn().mockResolvedValue(undefined),
}));

import transactionsHandler from '../../../../pages/api/transactions/index.js';
import plaidTxHandler from '../../../../pages/api/plaid/transactions/[id].js';
import rebuildHandler from '../../../../pages/api/admin/rebuild.js';
import tenantSettingsHandler from '../../../../pages/api/tenants/settings.js';
import usersHandler from '../../../../pages/api/users.js';
import accountsHandler from '../../../../pages/api/accounts.js';
import categoriesHandler from '../../../../pages/api/categories.js';
import sessionHandler from '../../../../pages/api/auth/session.js';
import integrationItemHandler from '../../../../pages/api/integrations/[id].js';
import integrationKeyHandler from '../../../../pages/api/integrations/[id]/keys/[keyId].js';
import prisma from '../../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../../helpers/tenant.js';
import { ensureReferenceData } from '../../../helpers/referenceData.js';
import { bearer, createIntegrationKey, createTenantUser } from '../../../helpers/integration.js';
import { _resetLastUsedThrottle } from '../../../../utils/apiKeys.js';

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'GET', url: '/api/transactions', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as any;
}

function makeRes() {
  const res: any = { _status: undefined, _body: undefined, statusCode: 200 };
  res.status = vi.fn((code: number) => { res._status = code; res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.setHeader = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

async function call(handler: any, req: any) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

interface Seeded {
  accountId: number;
  categoryId: number;
  transactionIds: number[];
}

let seq = 0;
async function seedTenantData(tenant: IsolatedTenant, label: string): Promise<Seeded> {
  const ref = await ensureReferenceData();
  const category = await prisma.category.create({
    data: { name: `Groceries ${label}`.slice(0, 30), group: 'Food', type: 'Essentials', tenantId: tenant.tenantId },
  });
  const account = await prisma.account.create({
    data: {
      name: `Checking ${label}`.slice(0, 50),
      accountNumber: `0000${label}`,
      bankId: ref.bankId,
      countryId: ref.countryId,
      currencyCode: ref.currencyCode,
      tenantId: tenant.tenantId,
      plaidAccountId: `plaid-acc-${label}-${Date.now()}`,
    },
  });
  const transactionIds: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const tx = await prisma.transaction.create({
      data: {
        transaction_date: new Date('2026-01-15T00:00:00Z'),
        year: 2026, month: 1, day: 15, quarter: 'Q1',
        categoryId: category.id,
        accountId: account.id,
        description: `${label} purchase ${i}`,
        debit: 10 + i,
        currency: 'USD',
        tenantId: tenant.tenantId,
      },
    });
    transactionIds.push(tx.id);
  }
  return { accountId: account.id, categoryId: category.id, transactionIds };
}

async function seedPlaidReviewItem(tenant: IsolatedTenant, seeded: Seeded) {
  const account = await prisma.account.findUnique({ where: { id: seeded.accountId } });
  seq += 1;
  const item = await prisma.plaidItem.create({
    data: {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      itemId: `item-${tenant.tenantId}-${seq}`,
      accessToken: 'access-sandbox-test',
    },
  });
  await prisma.account.update({ where: { id: seeded.accountId }, data: { plaidItemId: item.id } });
  return prisma.plaidTransaction.create({
    data: {
      plaidItemId: item.id,
      plaidAccountId: account!.plaidAccountId!,
      plaidTransactionId: `ptx-${tenant.tenantId}-${seq}`,
      amount: 42.5,
      date: new Date('2026-01-20T00:00:00Z'),
      name: 'COFFEE SHOP',
      isoCurrencyCode: 'USD',
      suggestedCategoryId: seeded.categoryId,
      aiConfidence: 0.8,
      promotionStatus: 'CLASSIFIED',
    },
  });
}

describe('integration tokens — end to end', () => {
  let a: IsolatedTenant;
  let b: IsolatedTenant;
  let seededA: Seeded;
  let seededB: Seeded;
  let readOnly: string;
  let readWrite: string;

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    a = await createIsolatedTenant('tokens-a');
    b = await createIsolatedTenant('tokens-b');
    seededA = await seedTenantData(a, `A${Date.now()}`);
    seededB = await seedTenantData(b, `B${Date.now()}`);
    readOnly = (await createIntegrationKey(a, { accessLevel: 'READ_ONLY', name: 'RO' })).token;
    readWrite = (await createIntegrationKey(a, { accessLevel: 'READ_WRITE', name: 'RW' })).token;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await teardownTenant(a.tenantId);
    await teardownTenant(b.tenantId);
  });

  beforeEach(() => {
    limiterCalls.length = 0;
    _resetLastUsedThrottle();
  });

  describe('AC2 — read with a token', () => {
    it('GET /api/transactions → 200 with only the token tenant rows', async () => {
      const res = await call(transactionsHandler, makeReq({ headers: bearer(readOnly) }));
      expect(res._status).toBe(200);
      const rows = res._body.transactions;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((t: any) => t.tenantId === a.tenantId)).toBe(true);
      expect(rows.map((t: any) => t.id)).toEqual(expect.arrayContaining(seededA.transactionIds));
      expect(rows.some((t: any) => seededB.transactionIds.includes(t.id))).toBe(false);
      // Encrypted fields come back decrypted, same as a session.
      expect(rows.find((t: any) => t.id === seededA.transactionIds[0]).description).toMatch(/purchase 0$/);
    });

    it('records lastUsedAt / lastUsedIp on the key', async () => {
      const { token, apiKeyId } = await createIntegrationKey(a);
      await call(transactionsHandler, makeReq({ headers: { ...bearer(token), 'x-real-ip': '203.0.113.7' } }));
      await new Promise((r) => setTimeout(r, 50));
      const key = await prisma.apiKey.findUnique({ where: { id: apiKeyId } });
      expect(key!.lastUsedAt).not.toBeNull();
      expect(key!.lastUsedIp).toBe('203.0.113.7');
    });
  });

  describe('AC3 — read-only tokens cannot write', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s /api/transactions → 403 and nothing changes', async (method) => {
      const before = await prisma.transaction.count({ where: { tenantId: a.tenantId } });
      const res = await call(transactionsHandler, makeReq({
        method,
        headers: bearer(readOnly),
        query: { id: String(seededA.transactionIds[0]) },
        body: {
          transaction_date: '2026-01-16', categoryId: seededA.categoryId, accountId: seededA.accountId,
          description: 'should not exist', debit: 5, currency: 'USD',
        },
      }));
      expect(res._status).toBe(403);
      expect(res._body.code).toBe('READ_ONLY_INTEGRATION');
      expect(await prisma.transaction.count({ where: { tenantId: a.tenantId } })).toBe(before);
      const untouched = await prisma.transaction.findUnique({ where: { id: seededA.transactionIds[0] } });
      expect(untouched!.description).toMatch(/purchase 0$/);
    });
  });

  describe('AC4 — read-write tokens act as a member', () => {
    it('POST /api/transactions → 201, then PUT → 200', async () => {
      const created = await call(transactionsHandler, makeReq({
        method: 'POST',
        headers: bearer(readWrite),
        body: {
          transaction_date: '2026-01-17', categoryId: seededA.categoryId, accountId: seededA.accountId,
          description: 'Agent-created', debit: 7, currency: 'USD',
        },
      }));
      expect(created._status).toBe(201);
      expect(created._body.tenantId).toBe(a.tenantId);

      const updated = await call(transactionsHandler, makeReq({
        method: 'PUT',
        headers: bearer(readWrite),
        query: { id: String(created._body.id) },
        body: {
          transaction_date: '2026-01-17', categoryId: seededA.categoryId, accountId: seededA.accountId,
          description: 'Agent-updated', debit: 8, currency: 'USD',
        },
      }));
      expect(updated._status).toBe(200);
      const row = await prisma.transaction.findUnique({ where: { id: created._body.id } });
      expect(row!.description).toBe('Agent-updated');
    });

    it('promotes a Plaid review-queue item (PUT /api/plaid/transactions/:id)', async () => {
      const plaidTx = await seedPlaidReviewItem(a, seededA);
      const res = await call(plaidTxHandler, makeReq({
        method: 'PUT',
        url: `/api/plaid/transactions/${plaidTx.id}`,
        headers: bearer(readWrite),
        query: { id: plaidTx.id },
        body: { promotionStatus: 'PROMOTED' },
      }));
      expect(res._status).toBe(200);
      const after = await prisma.plaidTransaction.findUnique({ where: { id: plaidTx.id } });
      expect(after!.promotionStatus).toBe('PROMOTED');
      expect(after!.matchedTransactionId).not.toBeNull();
    });

    it('POST /api/admin/rebuild → 403 (admin only)', async () => {
      const res = await call(rebuildHandler, makeReq({
        method: 'POST', url: '/api/admin/rebuild', headers: bearer(readWrite), body: { scope: 'full-portfolio' },
      }));
      expect(res._status).toBe(403);
    });

    it('PUT /api/tenants/settings → 403 and settings unchanged', async () => {
      const before = await prisma.tenant.findUnique({ where: { id: a.tenantId } });
      const res = await call(tenantSettingsHandler, makeReq({
        method: 'PUT', url: '/api/tenants/settings', headers: bearer(readWrite), body: { reviewThreshold: 0.1 },
      }));
      expect(res._status).toBe(403);
      const after = await prisma.tenant.findUnique({ where: { id: a.tenantId } });
      expect(after!.reviewThreshold).toBe(before!.reviewThreshold);
    });

    it('PUT /api/users (role change) → 403 NOT_AVAILABLE_TO_INTEGRATIONS', async () => {
      const member = await createTenantUser(a.tenantId, 'member');
      const res = await call(usersHandler, makeReq({
        method: 'PUT', url: `/api/users?id=${member.userId}`, headers: bearer(readWrite),
        query: { id: member.userId }, body: { role: 'admin' },
      }));
      expect(res._status).toBe(403);
      expect(res._body.code).toBe('NOT_AVAILABLE_TO_INTEGRATIONS');
      expect((await prisma.user.findUnique({ where: { id: member.userId } }))!.role).toBe('member');
    });

    it.each([
      ['POST', '/api/accounts', () => accountsHandler],
      ['PUT', '/api/accounts', () => accountsHandler],
      ['DELETE', '/api/accounts', () => accountsHandler],
      ['POST', '/api/categories', () => categoriesHandler],
      ['PUT', '/api/categories', () => categoriesHandler],
      ['DELETE', '/api/categories', () => categoriesHandler],
    ])('%s %s → 403 NOT_AVAILABLE_TO_INTEGRATIONS', async (method, url, handler) => {
      const accounts = await prisma.account.count({ where: { tenantId: a.tenantId } });
      const categories = await prisma.category.count({ where: { tenantId: a.tenantId } });
      const res = await call(handler(), makeReq({
        method, url, headers: bearer(readWrite), query: { id: String(seededA.accountId) }, body: { name: 'Hacked' },
      }));
      expect(res._status).toBe(403);
      expect(res._body.code).toBe('NOT_AVAILABLE_TO_INTEGRATIONS');
      expect(await prisma.account.count({ where: { tenantId: a.tenantId } })).toBe(accounts);
      expect(await prisma.category.count({ where: { tenantId: a.tenantId } })).toBe(categories);
    });

    it('GET /api/accounts is still allowed', async () => {
      const res = await call(accountsHandler, makeReq({ url: '/api/accounts', headers: bearer(readWrite) }));
      expect(res._status).toBe(200);
    });
  });

  describe('AC5 — denylisted routes (withAuth)', () => {
    it('GET /api/auth/session → 403 NOT_AVAILABLE_TO_INTEGRATIONS', async () => {
      const res = await call(sessionHandler, makeReq({ url: '/api/auth/session', headers: bearer(readWrite) }));
      expect(res._status).toBe(403);
      expect(res._body.code).toBe('NOT_AVAILABLE_TO_INTEGRATIONS');
    });
  });

  describe('AC6 — tenant isolation', () => {
    it('tenant A token + tenant B transaction id → 404 without leaking data', async () => {
      const res = await call(transactionsHandler, makeReq({
        url: `/api/transactions?id=${seededB.transactionIds[0]}`,
        headers: bearer(readOnly),
        query: { id: String(seededB.transactionIds[0]) },
      }));
      expect(res._status).toBe(404);
      expect(JSON.stringify(res._body)).not.toMatch(/purchase/);
    });

    it('tenant A read-write token cannot update a tenant B transaction', async () => {
      const res = await call(transactionsHandler, makeReq({
        method: 'PUT',
        headers: bearer(readWrite),
        query: { id: String(seededB.transactionIds[0]) },
        body: {
          transaction_date: '2026-01-17', categoryId: seededA.categoryId, accountId: seededA.accountId,
          description: 'cross-tenant', debit: 8, currency: 'USD',
        },
      }));
      expect(res._status).toBe(404);
      const row = await prisma.transaction.findUnique({ where: { id: seededB.transactionIds[0] } });
      expect(row!.description).not.toBe('cross-tenant');
    });

    it('tenant A token + tenant B account filter → no tenant B rows', async () => {
      const res = await call(transactionsHandler, makeReq({
        headers: bearer(readOnly), query: { accountId: String(seededB.accountId) },
      }));
      expect(res._status).toBe(200);
      expect(res._body.transactions).toHaveLength(0);
    });

    it('tenant A token cannot reach tenant B integrations', async () => {
      const foreign = await createIntegrationKey(b);
      const res = await call(integrationItemHandler, makeReq({
        method: 'DELETE', url: `/api/integrations/${foreign.integrationId}`, headers: bearer(readWrite),
        query: { id: foreign.integrationId },
      }));
      expect(res._status).toBe(403);
      expect((await prisma.integration.findUnique({ where: { id: foreign.integrationId } }))!.revokedAt).toBeNull();
    });
  });

  describe('AC7 / AC12 — revocation, expiry and cascade', () => {
    const get = (token: string) => call(transactionsHandler, makeReq({ headers: bearer(token) }));

    it('a key revoked via the endpoint → 401 TOKEN_REVOKED; its sibling keeps working', async () => {
      const first = await createIntegrationKey(a, { accessLevel: 'READ_ONLY' });
      const second = await createIntegrationKey(a, { integrationId: first.integrationId });
      expect((await get(first.token))._status).toBe(200);

      const revoke = await call(integrationKeyHandler, makeReq({
        method: 'DELETE', url: `/api/integrations/${first.integrationId}/keys/${first.apiKeyId}`,
        cookies: { token: a.token }, query: { id: first.integrationId, keyId: first.apiKeyId },
      }));
      expect(revoke._status).toBe(200);

      const denied = await get(first.token);
      expect(denied._status).toBe(401);
      expect(denied._body.code).toBe('TOKEN_REVOKED');
      expect((await get(second.token))._status).toBe(200);

      // The admin's browser session is unaffected.
      expect((await call(transactionsHandler, makeReq({ cookies: { token: a.token } })))._status).toBe(200);
    });

    it('an expired key → 401 TOKEN_EXPIRED', async () => {
      const { token } = await createIntegrationKey(a, { expiresAt: new Date(Date.now() - 1000) });
      const res = await get(token);
      expect(res._status).toBe(401);
      expect(res._body.code).toBe('TOKEN_EXPIRED');
    });

    it('a revoked integration → 401 TOKEN_REVOKED for all its keys', async () => {
      const first = await createIntegrationKey(a);
      const second = await createIntegrationKey(a, { integrationId: first.integrationId });
      const res = await call(integrationItemHandler, makeReq({
        method: 'DELETE', url: `/api/integrations/${first.integrationId}`,
        cookies: { token: a.token }, query: { id: first.integrationId },
      }));
      expect(res._status).toBe(200);
      for (const token of [first.token, second.token]) {
        const denied = await get(token);
        expect(denied._status).toBe(401);
        expect(denied._body.code).toBe('TOKEN_REVOKED');
      }
      expect((await call(transactionsHandler, makeReq({ cookies: { token: a.token } })))._status).toBe(200);
    });

    it('deleting the creating user cascades: the key → 401 TOKEN_INVALID', async () => {
      const creator = await createTenantUser(a.tenantId, 'admin');
      const { token, integrationId } = await createIntegrationKey({ tenantId: a.tenantId, userId: creator.userId });
      expect((await get(token))._status).toBe(200);

      await prisma.user.delete({ where: { id: creator.userId } });

      expect(await prisma.integration.findUnique({ where: { id: integrationId } })).toBeNull();
      const res = await get(token);
      expect(res._status).toBe(401);
      expect(res._body.code).toBe('TOKEN_INVALID');
      expect((await call(transactionsHandler, makeReq({ cookies: { token: a.token } })))._status).toBe(200);
    });

    it('a token whose creator was demoted to viewer can no longer write', async () => {
      const creator = await createTenantUser(a.tenantId, 'admin');
      const { token } = await createIntegrationKey({ tenantId: a.tenantId, userId: creator.userId }, { accessLevel: 'READ_WRITE' });
      await prisma.user.update({ where: { id: creator.userId }, data: { role: 'viewer' } });
      const res = await call(transactionsHandler, makeReq({ method: 'DELETE', headers: bearer(token), query: { id: String(seededA.transactionIds[1]) } }));
      expect(res._status).toBe(403);
      expect(await prisma.transaction.findUnique({ where: { id: seededA.transactionIds[1] } })).not.toBeNull();
    });

    it('an unknown token → 401 TOKEN_INVALID', async () => {
      const res = await get(`bliss_ABCDEFGH_${'a'.repeat(43)}`);
      expect(res._status).toBe(401);
      expect(res._body.code).toBe('TOKEN_INVALID');
    });
  });

  describe('AC10 — same rate limiter as sessions', () => {
    it('a token request passes through the route limiter exactly once, like a session request', async () => {
      await call(transactionsHandler, makeReq({ headers: bearer(readOnly) }));
      expect(limiterCalls).toEqual(['transactions']);

      limiterCalls.length = 0;
      await call(transactionsHandler, makeReq({ cookies: { token: a.token } }));
      expect(limiterCalls).toEqual(['transactions']);
    });
  });
});

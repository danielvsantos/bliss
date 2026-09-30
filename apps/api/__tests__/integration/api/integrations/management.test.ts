/**
 * Integration tests for the integration-token management endpoints (#84).
 *
 *   GET/POST      /api/integrations
 *   PATCH/DELETE  /api/integrations/:id
 *   POST          /api/integrations/:id/keys
 *   DELETE        /api/integrations/:id/keys/:keyId
 *
 * Real bliss_test Postgres; real withAuth (JWT for humans). Rate limiter mocked.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'crypto';

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import listHandler from '../../../../pages/api/integrations/index.js';
import itemHandler from '../../../../pages/api/integrations/[id].js';
import keysHandler from '../../../../pages/api/integrations/[id]/keys/index.js';
import keyHandler from '../../../../pages/api/integrations/[id]/keys/[keyId].js';
import prisma from '../../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../../helpers/tenant.js';
import { bearer, createIntegrationKey, createTenantUser } from '../../../helpers/integration.js';

const TOKEN_RE = /^bliss_[A-Za-z0-9]{8}_[A-Za-z0-9]{43}$/;

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'GET', url: '/api/integrations', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as any;
}

function makeRes() {
  const res: any = { _status: undefined, _body: undefined, _headers: {} };
  res.status = vi.fn((code: number) => { res._status = code; res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.setHeader = vi.fn((k: string, v: unknown) => { res._headers[k] = v; return res; });
  res.end = vi.fn();
  return res;
}

async function call(handler: any, req: any) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

function asAdmin(tenant: IsolatedTenant, overrides: Record<string, unknown> = {}) {
  return makeReq({ cookies: { token: tenant.token }, ...overrides });
}

describe('integration management endpoints', () => {
  let tenant: IsolatedTenant;
  let other: IsolatedTenant;

  beforeAll(async () => {
    tenant = await createIsolatedTenant('integrations-mgmt');
    other = await createIsolatedTenant('integrations-mgmt-other');
  });

  afterAll(async () => {
    await teardownTenant(tenant.tenantId);
    await teardownTenant(other.tenantId);
  });

  describe('AC1 — create returns the token once; only hash + prefix are stored', () => {
    let token: string;
    let integrationId: string;

    it('POST /api/integrations → 201 with a bliss_ token', async () => {
      const res = await call(listHandler, asAdmin(tenant, {
        method: 'POST',
        body: { name: 'Claude agent', description: 'Reads my data', accessLevel: 'READ_ONLY', key: { expiresInDays: 90 } },
      }));

      expect(res._status).toBe(201);
      token = res._body.token;
      integrationId = res._body.integration.id;
      expect(token).toMatch(TOKEN_RE);
      expect(res._body.integration).toMatchObject({
        name: 'Claude agent',
        description: 'Reads my data',
        accessLevel: 'READ_ONLY',
        status: 'active',
        keyCount: 1,
        createdByUserId: tenant.userId,
      });
      expect(res._body.apiKey).toMatchObject({ prefix: token.slice(6, 14), status: 'active', name: 'Default key' });
      expect(res._body.apiKey).not.toHaveProperty('keyHash');

      const expiresAt = new Date(res._body.apiKey.expiresAt).getTime();
      const expected = Date.now() + 90 * 24 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt - expected)).toBeLessThan(60_000);
    });

    it('stores sha256(token) and the prefix, never the plaintext', async () => {
      const row = await prisma.apiKey.findFirst({ where: { integrationId } });
      expect(row!.keyHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(row!.prefix).toBe(token.slice(6, 14));
      expect(row!.tenantId).toBe(tenant.tenantId);

      const secret = token.slice(15);
      const hits = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT id FROM "ApiKey" k WHERE k::text LIKE $1`,
        `%${secret}%`,
      );
      expect(hits).toHaveLength(0);
      const intHits = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT id FROM "Integration" i WHERE i::text LIKE $1`,
        `%${secret}%`,
      );
      expect(intHits).toHaveLength(0);
    });

    it('GET /api/integrations never returns a token or hash', async () => {
      const res = await call(listHandler, asAdmin(tenant));
      expect(res._status).toBe(200);
      const serialized = JSON.stringify(res._body);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(token.slice(15));
      expect(serialized).not.toContain('keyHash');
      expect(serialized).not.toContain('"token"');
      const mine = res._body.integrations.find((i: any) => i.id === integrationId);
      expect(mine.keys[0]).toMatchObject({ prefix: token.slice(6, 14), status: 'active' });
    });

    it('lists only the caller tenant integrations', async () => {
      await createIntegrationKey(other, { name: 'Other tenant integration' });
      const res = await call(listHandler, asAdmin(tenant));
      expect(res._body.integrations.every((i: any) => i.name !== 'Other tenant integration')).toBe(true);
    });
  });

  describe('validation', () => {
    it.each([
      [{ accessLevel: 'READ_ONLY', key: { expiresInDays: 30 } }, 'missing name'],
      [{ name: 'x'.repeat(81), accessLevel: 'READ_ONLY', key: { expiresInDays: 30 } }, 'name too long'],
      [{ name: 'ok', accessLevel: 'ADMIN', key: { expiresInDays: 30 } }, 'bad access level'],
      [{ name: 'ok', accessLevel: 'READ_ONLY', key: { expiresInDays: 7 } }, 'bad expiry'],
      [{ name: 'ok', accessLevel: 'READ_ONLY' }, 'missing key'],
      [{ name: 'ok', accessLevel: 'READ_ONLY', key: { expiresInDays: 30 }, description: 'x'.repeat(281) }, 'description too long'],
    ])('POST %j → 400 (%s)', async (body) => {
      const res = await call(listHandler, asAdmin(tenant, { method: 'POST', body }));
      expect(res._status).toBe(400);
    });

    it('accepts a no-expiry key', async () => {
      const res = await call(listHandler, asAdmin(tenant, {
        method: 'POST',
        body: { name: 'Forever', accessLevel: 'READ_WRITE', key: { name: 'ci', expiresInDays: null } },
      }));
      expect(res._status).toBe(201);
      expect(res._body.apiKey).toMatchObject({ name: 'ci', expiresAt: null });
    });

    it('unsupported methods → 405', async () => {
      expect((await call(listHandler, asAdmin(tenant, { method: 'PUT' })))._status).toBe(405);
    });
  });

  describe('PATCH / DELETE /api/integrations/:id', () => {
    let integrationId: string;

    beforeAll(async () => {
      ({ integrationId } = await createIntegrationKey(tenant, { name: 'To rename' }));
    });

    it('renames and updates the description', async () => {
      const res = await call(itemHandler, asAdmin(tenant, {
        method: 'PATCH', query: { id: integrationId }, body: { name: 'Renamed', description: 'Nightly sync' },
      }));
      expect(res._status).toBe(200);
      expect(res._body.integration).toMatchObject({ name: 'Renamed', description: 'Nightly sync', accessLevel: 'READ_ONLY' });
    });

    it('refuses to change the access level', async () => {
      const res = await call(itemHandler, asAdmin(tenant, {
        method: 'PATCH', query: { id: integrationId }, body: { accessLevel: 'READ_WRITE' },
      }));
      expect(res._status).toBe(400);
      expect(res._body.code).toBe('ACCESS_LEVEL_IMMUTABLE');
      const row = await prisma.integration.findUnique({ where: { id: integrationId } });
      expect(row!.accessLevel).toBe('READ_ONLY');
    });

    it('rejects an empty update', async () => {
      const res = await call(itemHandler, asAdmin(tenant, { method: 'PATCH', query: { id: integrationId }, body: {} }));
      expect(res._status).toBe(400);
    });

    it('another tenant integration → 404', async () => {
      const foreign = await createIntegrationKey(other);
      for (const method of ['PATCH', 'DELETE']) {
        const res = await call(itemHandler, asAdmin(tenant, { method, query: { id: foreign.integrationId }, body: { name: 'hijack' } }));
        expect(res._status).toBe(404);
      }
      const row = await prisma.integration.findUnique({ where: { id: foreign.integrationId } });
      expect(row!.revokedAt).toBeNull();
      expect(row!.name).toBe('Test integration');
    });

    it('DELETE revokes the integration and every key (idempotent)', async () => {
      await createIntegrationKey(tenant, { integrationId });
      const res = await call(itemHandler, asAdmin(tenant, { method: 'DELETE', query: { id: integrationId } }));
      expect(res._status).toBe(200);
      expect(res._body.integration.status).toBe('revoked');
      expect(res._body.integration.keys.every((k: any) => k.status === 'revoked')).toBe(true);

      const again = await call(itemHandler, asAdmin(tenant, { method: 'DELETE', query: { id: integrationId } }));
      expect(again._status).toBe(200);
      expect(again._body.integration.revokedAt).toEqual(res._body.integration.revokedAt);
    });

    it('adding a key to a revoked integration → 409 INTEGRATION_REVOKED', async () => {
      const res = await call(keysHandler, asAdmin(tenant, { method: 'POST', query: { id: integrationId }, body: { expiresInDays: 30 } }));
      expect(res._status).toBe(409);
      expect(res._body.code).toBe('INTEGRATION_REVOKED');
    });
  });

  describe('keys', () => {
    let integrationId: string;

    beforeAll(async () => {
      ({ integrationId } = await createIntegrationKey(tenant, { name: 'Rotating', accessLevel: 'READ_WRITE' }));
    });

    it('POST /keys → 201 with a new one-time token', async () => {
      const res = await call(keysHandler, asAdmin(tenant, {
        method: 'POST', query: { id: integrationId }, body: { name: 'rotation-2', expiresInDays: 365 },
      }));
      expect(res._status).toBe(201);
      expect(res._body.token).toMatch(TOKEN_RE);
      expect(res._body.apiKey).toMatchObject({ name: 'rotation-2', status: 'active' });
      expect(await prisma.apiKey.count({ where: { integrationId } })).toBe(2);
    });

    it('POST /keys validates the expiry', async () => {
      const res = await call(keysHandler, asAdmin(tenant, { method: 'POST', query: { id: integrationId }, body: { expiresInDays: 1 } }));
      expect(res._status).toBe(400);
    });

    it('DELETE /keys/:keyId revokes only that key', async () => {
      const keys = await prisma.apiKey.findMany({ where: { integrationId }, orderBy: { createdAt: 'asc' } });
      const res = await call(keyHandler, asAdmin(tenant, { method: 'DELETE', query: { id: integrationId, keyId: keys[0].id } }));
      expect(res._status).toBe(200);
      expect(res._body.apiKey.status).toBe('revoked');
      const after = await prisma.apiKey.findUnique({ where: { id: keys[1].id } });
      expect(after!.revokedAt).toBeNull();
    });

    it('a key of another tenant or another integration → 404', async () => {
      const foreign = await createIntegrationKey(other);
      const res = await call(keyHandler, asAdmin(tenant, { method: 'DELETE', query: { id: foreign.integrationId, keyId: foreign.apiKeyId } }));
      expect(res._status).toBe(404);
      const mismatch = await call(keyHandler, asAdmin(tenant, { method: 'DELETE', query: { id: integrationId, keyId: foreign.apiKeyId } }));
      expect(mismatch._status).toBe(404);
      expect((await prisma.apiKey.findUnique({ where: { id: foreign.apiKeyId } }))!.revokedAt).toBeNull();
    });
  });

  describe('AC8 — members and viewers cannot manage integrations', () => {
    const endpoints = () => [
      [listHandler, { method: 'GET' }],
      [listHandler, { method: 'POST', body: { name: 'x', accessLevel: 'READ_ONLY', key: { expiresInDays: 30 } } }],
      [itemHandler, { method: 'PATCH', query: { id: 'any' }, body: { name: 'x' } }],
      [itemHandler, { method: 'DELETE', query: { id: 'any' } }],
      [keysHandler, { method: 'POST', query: { id: 'any' }, body: { expiresInDays: 30 } }],
      [keyHandler, { method: 'DELETE', query: { id: 'any', keyId: 'any' } }],
    ] as const;

    it.each(['member', 'viewer'] as const)('%s JWT → 403 on every endpoint', async (role) => {
      const { token } = await createTenantUser(tenant.tenantId, role);
      const before = await prisma.integration.count({ where: { tenantId: tenant.tenantId } });
      for (const [handler, overrides] of endpoints()) {
        const res = await call(handler, makeReq({ cookies: { token }, ...overrides }));
        expect(res._status).toBe(403);
      }
      expect(await prisma.integration.count({ where: { tenantId: tenant.tenantId } })).toBe(before);
    });

    it('an integration token → 403 NOT_AVAILABLE_TO_INTEGRATIONS', async () => {
      const { token } = await createIntegrationKey(tenant, { accessLevel: 'READ_WRITE' });
      const res = await call(listHandler, makeReq({ headers: bearer(token) }));
      expect(res._status).toBe(403);
      expect(res._body.code).toBe('NOT_AVAILABLE_TO_INTEGRATIONS');
    });
  });
});

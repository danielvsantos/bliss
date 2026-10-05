/**
 * Integration tests — processing status `GET /api/activity` (#100).
 *
 *   AC6  tenant isolation: tenant A's in-flight work is invisible to tenant B.
 *   AC7  every role (viewer included) can read it.
 *   AC13 a read-only integration key gets the same payload from the REST route
 *        and from the MCP `get_processing_status` tool (via the real MCP server
 *        and loopback).
 *
 * Real bliss_test Postgres, real withAuth (JWT + integration keys). Redis is
 * the real instance when REDIS_URL is set (local runs) and an in-memory
 * stand-in otherwise — the API integration CI job has no Redis service. The
 * entries are written with the shared key builders, exactly as the backend
 * tracker writes them.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Redis from 'ioredis';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { activityKey, lastKey } from '@bliss/shared/activity';
import handler from '../../../pages/api/activity.js';
import { __setRedisClientForTests } from '../../../utils/redisClient.js';
import { shapeProcessingStatus } from '../../../lib/mcp/tools/analytics.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../helpers/tenant.js';
import { bearer, createIntegrationKey, createTenantUser } from '../../helpers/integration.js';
import { startLoopbackServer, makeFetchStub, connectMcp, callTool, type LoopbackServer } from '../../helpers/mcpServer.js';

/** Minimal ioredis stand-in: just the pipeline the activity store issues. */
function memoryRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const keys = new Set<string>();
  return {
    hashes,
    async hset(key: string, field: string, value: string) {
      hashes.set(key, { ...(hashes.get(key) || {}), [field]: value });
    },
    async del(...ks: string[]) { ks.forEach((k) => hashes.delete(k)); },
    async quit() {},
    pipeline() {
      const ops: Array<() => unknown> = [];
      const p = {
        hgetall: (k: string) => { ops.push(() => ({ ...(hashes.get(k) || {}) })); return p; },
        exists: (k: string) => { ops.push(() => (keys.has(k) ? 1 : 0)); return p; },
        exec: async () => ops.map((op) => [null, op()]),
      };
      return p;
    },
  };
}

const usingRealRedis = Boolean(process.env.REDIS_URL);
let redis: any;

let a: IsolatedTenant;
let b: IsolatedTenant;
let readOnlyKey: string;
let viewerToken: string;

const now = Date.now();
const entry = (overrides: Record<string, unknown>) => JSON.stringify({
  t: 'PORTFOLIO_UPDATE', s: 'valuing_assets', st: 'running', p: 40, tr: 'manual_rebuild',
  af: ['PORTFOLIO_UPDATE'], lg: 1, sa: now - 60_000, ra: now - 50_000, ua: now - 1_000, ...overrides,
});

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'GET', url: '/api/activity', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as any;
}
function makeRes() {
  const res: any = { _status: undefined, _body: undefined, _headers: {} };
  res.status = vi.fn((code: number) => { res._status = code; res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.setHeader = vi.fn((k: string, v: unknown) => { res._headers[k] = v; return res; });
  res.end = vi.fn();
  return res;
}
async function call(req: any) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

/** Strip the per-request clock so two reads can be compared. */
const stable = (payload: any) => ({ ...payload, serverTime: undefined });

beforeAll(async () => {
  redis = usingRealRedis ? new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 }) : memoryRedis();
  __setRedisClientForTests(redis);

  a = await createIsolatedTenant('activity-a');
  b = await createIsolatedTenant('activity-b');
  readOnlyKey = (await createIntegrationKey(a, { accessLevel: 'READ_ONLY' })).token;
  viewerToken = (await createTenantUser(a.tenantId, 'viewer')).token;

  // Tenant A is in the middle of a full portfolio rebuild (AC6).
  await redis.hset(activityKey(a.tenantId), 'portfolio:rebuild-1', entry({}));
  await redis.hset(activityKey(a.tenantId), 'analytics:9', entry({
    t: 'ANALYTICS_UPDATE', s: 'updating_analytics', st: 'completed', p: 100, tr: 'nightly', af: ['ANALYTICS_UPDATE'], fa: now - 120_000,
  }));
  await redis.hset(lastKey(a.tenantId), 'ANALYTICS_UPDATE', new Date(now - 120_000).toISOString());
});

afterAll(async () => {
  await redis.del(activityKey(a.tenantId), lastKey(a.tenantId), activityKey(b.tenantId), lastKey(b.tenantId));
  __setRedisClientForTests(null);
  await redis.quit();
  await teardownTenant(a.tenantId);
  await teardownTenant(b.tenantId);
});

describe('GET /api/activity', () => {
  it('returns the tenant\'s in-flight work, history and lastCompletedAt', async () => {
    const res = await call(makeReq({ cookies: { token: a.token } }));
    expect(res._status).toBe(200);
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(res._body.available).toBe(true);
    expect(res._body.inFlight).toEqual([
      expect.objectContaining({ id: 'portfolio:rebuild-1', type: 'PORTFOLIO_UPDATE', state: 'running', progress: 40, trigger: 'manual_rebuild' }),
    ]);
    expect(res._body.summary.PORTFOLIO_UPDATE).toMatchObject({ state: 'running', count: 1, progress: 40 });
    expect(res._body.recent).toEqual([expect.objectContaining({ id: 'analytics:9', state: 'completed', trigger: 'nightly' })]);
    expect(res._body.lastCompletedAt.ANALYTICS_UPDATE).toBe(new Date(now - 120_000).toISOString());
  });

  it('AC6: tenant B sees nothing of tenant A\'s rebuild', async () => {
    const res = await call(makeReq({ cookies: { token: b.token } }));
    expect(res._status).toBe(200);
    expect(res._body.available).toBe(true);
    expect(res._body.inFlight).toEqual([]);
    expect(res._body.summary).toEqual({});
    expect(res._body.recent).toEqual([]);
    expect(res._body.lastCompletedAt).toEqual({});
  });

  it('AC7: a viewer can read it', async () => {
    const res = await call(makeReq({ cookies: { token: viewerToken } }));
    expect(res._status).toBe(200);
    expect(res._body.inFlight).toHaveLength(1);
  });

  it('refuses anonymous requests and non-GET methods', async () => {
    expect((await call(makeReq()))._status).toBe(401);
    expect((await call(makeReq({ method: 'POST', cookies: { token: a.token } })))._status).toBe(405);
  });

  it('a read-only integration key can read it', async () => {
    const res = await call(makeReq({ headers: bearer(readOnlyKey) }));
    expect(res._status).toBe(200);
    expect(res._body.inFlight).toHaveLength(1);
  });
});

describe('AC13: MCP get_processing_status matches the REST payload', () => {
  let server: LoopbackServer;
  const { stub } = makeFetchStub(globalThis.fetch, () => server.baseUrl);
  let client: any;

  beforeAll(async () => {
    vi.stubGlobal('fetch', stub);
    server = await startLoopbackServer();
    client = await connectMcp(server.baseUrl, readOnlyKey);
  });

  afterAll(async () => {
    await client?.close();
    await server.close();
    vi.unstubAllGlobals();
  });

  it('is listed for a read-only key and returns the shaped REST payload', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t: any) => t.name)).toContain('get_processing_status');

    const rest = await call(makeReq({ headers: bearer(readOnlyKey) }));
    const tool = await callTool(client, 'get_processing_status');
    expect(tool.isError).toBe(false);
    expect(stable(tool.data)).toEqual(stable(shapeProcessingStatus(rest._body)));
    expect(tool.data.settled).toBe(false);
    expect(tool.data.inFlight[0]).toMatchObject({ type: 'PORTFOLIO_UPDATE', affects: ['PORTFOLIO_UPDATE'] });
  });
});

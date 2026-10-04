/**
 * Unit tests for GET /api/activity — processing status (#100).
 *
 * AC11: the route does exactly one Redis pipeline and no Prisma or BullMQ work.
 * Prisma and bullmq are replaced by spies that must never be touched, and the
 * route + store sources are checked not to import them at all.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const { prismaSpy, bullmqSpy } = vi.hoisted(() => ({
  prismaSpy: vi.fn(),
  bullmqSpy: vi.fn(),
}));

// Any property access on Prisma or bullmq is recorded — there must be none.
vi.mock('../../../prisma/prisma.js', () => ({
  default: new Proxy({}, { get: (_t, prop) => { prismaSpy(prop); return () => { throw new Error('no prisma'); }; } }),
}));
vi.mock('bullmq', () => new Proxy({}, { get: (_t, prop) => { bullmqSpy(prop); return undefined; } }));

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

let mockRole = 'viewer';
vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => async (req: any, res: any) => {
    req.user = { id: 7, tenantId: 'tenant-1', role: mockRole };
    return handler(req, res);
  },
}));
vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import handler from '../../../pages/api/activity.js';
import { __setRedisClientForTests } from '../../../utils/redisClient.js';
import { readActivity, countFailuresSince } from '../../../utils/activityStore.js';

const NOW = Date.now();

function fakeRedis(data: { hash?: Record<string, string>; last?: Record<string, string>; worker?: number; fail?: boolean } = {}) {
  const calls: string[][] = [];
  const exec = vi.fn(async () => {
    if (data.fail) throw new Error('ECONNREFUSED');
    return [[null, data.hash || {}], [null, data.last || {}], [null, data.worker ?? 1]];
  });
  const pipeline = vi.fn(() => {
    const p: any = {
      hgetall: (k: string) => { calls.push(['hgetall', k]); return p; },
      exists: (k: string) => { calls.push(['exists', k]); return p; },
      exec,
    };
    return p;
  });
  return { pipeline, exec, calls };
}

function makeRes() {
  const res: any = { _headers: {} };
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.setHeader = vi.fn((k: string, v: unknown) => { res._headers[k] = v; return res; });
  return res;
}

const entry = (o: Record<string, unknown>) => JSON.stringify({
  t: 'PORTFOLIO_UPDATE', s: 'valuing_assets', st: 'running', p: 40, tr: 'user_change', af: ['PORTFOLIO_UPDATE'],
  sa: NOW - 60_000, ra: NOW - 50_000, ua: NOW - 1_000, ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = 'viewer';
});

afterAll(() => __setRedisClientForTests(null));

describe('GET /api/activity', () => {
  it('reads the tenant in one Redis pipeline, with no Prisma and no BullMQ (AC11)', async () => {
    const redis = fakeRedis({ hash: { 'portfolio:1': entry({}) } });
    __setRedisClientForTests(redis);
    const res = makeRes();

    await handler({ method: 'GET', headers: {} } as any, res);

    expect(res._status).toBe(200);
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(redis.pipeline).toHaveBeenCalledTimes(1);
    expect(redis.exec).toHaveBeenCalledTimes(1);
    expect(redis.calls).toEqual([
      ['hgetall', 'activity:v1:tenant-1'],
      ['hgetall', 'activity:v1:tenant-1:last'],
      ['exists', 'bliss:runtime:worker'],
    ]);
    expect(prismaSpy).not.toHaveBeenCalled();
    expect(bullmqSpy).not.toHaveBeenCalled();
    expect(res._body.inFlight).toEqual([expect.objectContaining({ id: 'portfolio:1', state: 'running', progress: 40 })]);
    expect(res._body.workerOnline).toBe(true);
  });

  it('route and store sources never import Prisma or BullMQ (AC11)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    for (const file of ['pages/api/activity.js', 'utils/activityStore.js', 'utils/redisClient.js']) {
      const src = readFileSync(join(root, file), 'utf8');
      expect(src).not.toMatch(/^\s*import\b[^;]*\b(prisma|bullmq)\b/im);
      expect(src).not.toMatch(/\bimport\(\s*['"][^'"]*(prisma|bullmq)/i);
    }
  });

  it('is readable by a viewer (AC7)', async () => {
    __setRedisClientForTests(fakeRedis());
    mockRole = 'viewer';
    const res = makeRes();
    await handler({ method: 'GET', headers: {} } as any, res);
    expect(res._status).toBe(200);
  });

  it('405 for anything but GET', async () => {
    __setRedisClientForTests(fakeRedis());
    const res = makeRes();
    await handler({ method: 'DELETE', headers: {} } as any, res);
    expect(res._status).toBe(405);
    expect(res._headers.Allow).toEqual(['GET']);
  });

  it('answers available:false (not "up to date") when Redis errors', async () => {
    __setRedisClientForTests(fakeRedis({ fail: true }));
    const res = makeRes();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handler({ method: 'GET', headers: {} } as any, res);
    spy.mockRestore();
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ available: false, workerOnline: null, inFlight: [], summary: {} });
  });
});

describe('readActivity', () => {
  it('available:false without a Redis client or tenant', async () => {
    __setRedisClientForTests(null);
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    expect((await readActivity('tenant-1', NOW)).available).toBe(false);
    process.env.REDIS_URL = prev;
    __setRedisClientForTests(fakeRedis());
    expect((await readActivity('', NOW)).available).toBe(false);
  });

  it('reports the worker offline when the heartbeat key is missing', async () => {
    __setRedisClientForTests(fakeRedis({ worker: 0 }));
    expect((await readActivity('tenant-1', NOW)).workerOnline).toBe(false);
  });

  it('available:false when a pipeline command errors', async () => {
    const redis = fakeRedis();
    redis.exec.mockResolvedValueOnce([[new Error('WRONGTYPE'), null], [null, {}], [null, 1]] as any);
    __setRedisClientForTests(redis);
    expect((await readActivity('tenant-1', NOW)).available).toBe(false);
  });
});

describe('countFailuresSince', () => {
  const activity = {
    available: true,
    recent: [
      { state: 'failed', finishedAt: '2026-10-04T10:00:00Z' },
      { state: 'failed', finishedAt: '2026-10-02T10:00:00Z' },
      { state: 'completed', finishedAt: '2026-10-04T11:00:00Z' },
    ],
  };
  it('counts failures after the given time', () => {
    expect(countFailuresSince(activity, new Date('2026-10-03T00:00:00Z'))).toBe(1);
    expect(countFailuresSince(activity, null)).toBe(2);
    expect(countFailuresSince({ available: false, recent: [] }, null)).toBe(0);
  });
});

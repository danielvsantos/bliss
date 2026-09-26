import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import handler from '../../../pages/api/runtime.js';

const ADMIN_KEY = 'a-real-admin-api-key-32-chars-ok!';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY },
    query: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.setHeader = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res as NextApiResponse & { _status?: number; _body?: Record<string, never> };
}

const savedEnv = { ...process.env };

describe('GET /api/runtime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.INTERNAL_API_KEY = 'internal-api-key-of-32-characters';
    process.env.BACKEND_URL = 'http://backend:3001';
    process.env.FRONTEND_URL = 'http://web:8080';
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  /** Stub fetch per-URL so backend and web can be varied independently. */
  function stubFetch(routes: Record<string, { ok?: boolean; status?: number; body?: unknown } | Error>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const match = Object.keys(routes).find((k) => String(url).includes(k));
        const entry = match ? routes[match] : undefined;
        if (!entry) throw new Error(`unstubbed fetch: ${url}`);
        if (entry instanceof Error) throw entry;
        return {
          ok: entry.ok ?? true,
          status: entry.status ?? 200,
          json: async () => entry.body,
        };
      }),
    );
  }

  describe('authentication', () => {
    it.each([
      ['no header', undefined],
      ['a wrong key of the same length', 'a-WRONG-admin-api-key-32-chars!!!'],
      ['a wrong key of a different length', 'x'],
    ])('returns 401 for %s', async (_label, key) => {
      const headers = key === undefined ? {} : { 'x-admin-key': key };
      const res = makeRes();

      await handler(makeReq({ headers } as Partial<NextApiRequest>), res);

      expect(res._status).toBe(401);
      expect(res._body).toEqual({ error: 'Unauthorized' });
    });

    // Version strings are information disclosure; the rejection must not leak
    // any of what it is protecting.
    it('leaks nothing in the 401 body', async () => {
      const res = makeRes();
      await handler(makeReq({ headers: {} } as Partial<NextApiRequest>), res);

      const body = JSON.stringify(res._body);
      expect(body).not.toContain(process.version);
      expect(body).not.toMatch(/node|commit|dependencies/i);
    });

    it('returns 405 for a non-GET method', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'POST' }), res);
      expect(res._status).toBe(405);
    });
  });

  describe('aggregation', () => {
    it('reports all four services as peers', async () => {
      stubFetch({
        '/api/runtime': { body: { role: 'backend-web', node: 'v22.0.0', worker: { status: 'alive', role: 'backend-worker' } } },
        '/version.json': { body: { role: 'web', commit: 'abc123', buildTime: '2026-09-24T00:00:00Z' } },
      });

      const res = makeRes();
      await handler(makeReq(), res);

      expect(res._status).toBe(200);
      expect(Object.keys(res._body!.services).sort()).toEqual([
        'api', 'backendWeb', 'backendWorker', 'web',
      ]);
    });

    it('reports the API process itself without any network call', async () => {
      stubFetch({
        '/api/runtime': { body: {} },
        '/version.json': { body: {} },
      });

      const res = makeRes();
      await handler(makeReq(), res);

      const api = res._body!.services.api;
      expect(api.role).toBe('api');
      expect(api.node).toBe(process.version);
      expect(['glibc', 'musl']).toContain(api.libc);
      expect(api.dependencies.next).toMatch(/^\d+\.\d+\.\d+/);
    });

    // next pins sharp, postcss and nanoid, which the original dependency triage
    // wrongly assumed a next bump would clear. Resolving them proves whether
    // the pnpm.overrides actually applied.
    it('resolves the transitives that next pins', async () => {
      stubFetch({ '/api/runtime': { body: {} }, '/version.json': { body: {} } });

      const res = makeRes();
      await handler(makeReq(), res);

      const deps = res._body!.services.api.dependencies;
      expect(deps.sharp).toMatch(/^\d+\.\d+\.\d+/);
      expect(deps.postcss).toMatch(/^\d+\.\d+\.\d+/);
      // nanoid sits a level deeper (postcss -> nanoid) and is the one the
      // first deployed build reported as null.
      expect(deps.nanoid).toMatch(/^\d+\.\d+\.\d+/);
    });

    // null has to mean "genuinely not installed", not "the lookup failed" —
    // otherwise a vulnerable version and an absent one look identical, which
    // would make the report worse than useless for the packages that carried
    // advisories.
    it('resolves every tracked package present in this tree', async () => {
      stubFetch({ '/api/runtime': { body: {} }, '/version.json': { body: {} } });

      const res = makeRes();
      await handler(makeReq(), res);

      const unresolved = Object.entries(res._body!.services.api.dependencies)
        .filter(([, v]) => v === null)
        .map(([name]) => name);

      expect(unresolved).toEqual([]);
    });

    it('lifts the worker heartbeat out of the backend payload', async () => {
      stubFetch({
        '/api/runtime': { body: { role: 'backend-web', worker: { status: 'alive', node: 'v22.1.0' } } },
        '/version.json': { body: {} },
      });

      const res = makeRes();
      await handler(makeReq(), res);

      expect(res._body!.services.backendWorker).toEqual({ status: 'alive', node: 'v22.1.0' });
      // And is not left duplicated inside backendWeb.
      expect(res._body!.services.backendWeb).not.toHaveProperty('worker');
    });
  });

  // A partial answer during an incident is far more useful than a 500, and
  // "backend unreachable" is itself a finding.
  describe('degrades rather than failing', () => {
    it('still returns 200 when the backend is unreachable', async () => {
      stubFetch({
        '/api/runtime': new Error('ECONNREFUSED'),
        '/version.json': { body: { role: 'web' } },
      });

      const res = makeRes();
      await handler(makeReq(), res);

      expect(res._status).toBe(200);
      expect(res._body!.services.backendWeb.status).toBe('unreachable');
      expect(res._body!.services.api.node).toBe(process.version);
      expect(res._body!.services.web.role).toBe('web');
    });

    it('reports an HTTP error from a downstream service', async () => {
      stubFetch({
        '/api/runtime': { ok: false, status: 401 },
        '/version.json': { body: {} },
      });

      const res = makeRes();
      await handler(makeReq(), res);

      expect(res._status).toBe(200);
      expect(res._body!.services.backendWeb.status).toBe('error');
      expect(res._body!.services.backendWeb.note).toContain('401');
    });

    it.each([
      ['BACKEND_URL', 'backendWeb'],
      ['FRONTEND_URL', 'web'],
    ])('reports not-configured when %s is unset', async (envVar, serviceKey) => {
      delete process.env[envVar];
      stubFetch({ '/api/runtime': { body: {} }, '/version.json': { body: {} } });

      const res = makeRes();
      await handler(makeReq(), res);

      expect(res._status).toBe(200);
      expect(res._body!.services[serviceKey].status).toBe('not-configured');
    });

    it('marks the worker unknown when the backend reports no heartbeat', async () => {
      stubFetch({
        '/api/runtime': { body: { role: 'backend-web' } },
        '/version.json': { body: {} },
      });

      const res = makeRes();
      await handler(makeReq(), res);

      expect(res._body!.services.backendWorker.status).toBe('unknown');
    });
  });
});

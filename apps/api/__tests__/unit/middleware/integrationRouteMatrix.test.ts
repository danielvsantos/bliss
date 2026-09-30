/**
 * Integration-token route matrix (#84, AC9).
 *
 * Every file under pages/api must be classified in integrationRouteMatrix.data.ts
 * with the outcome an integration token gets for each method it serves, for READ_ONLY and for
 * READ_WRITE tokens. The test fails when:
 *   - a route file exists that is not in ROUTE_MATRIX (new route → classify it
 *     in integrationRouteMatrix.data.ts),
 *   - a ROUTE_MATRIX entry has no file (route removed/renamed),
 *   - a file's auth wiring (withAuth / requireRole / inline admin check / admin
 *     key) no longer matches its declared classification,
 *   - the real withAuth + integrationPolicy (or the root middleware.js for
 *     routes without withAuth) produce a different outcome than declared.
 *
 * Outcome codes, written `<READ_ONLY>/<READ_WRITE>`:
 *   A  allowed (reaches the handler, acting as viewer/member)
 *   R  403 READ_ONLY_INTEGRATION (viewer rule)
 *   X  403 admin-only (requireRole or an inline role === 'admin' check)
 *   D  403 NOT_AVAILABLE_TO_INTEGRATIONS (central denylist)
 *   U  not accepted: the route has its own credential (ADMIN_API_KEY, Plaid
 *      signature) that a token never satisfies
 *   P  public route, no auth at all (same answer as an anonymous request)
 *
 * If you add a route: decide whether a token should reach it. If not, add it
 * to INTEGRATION_DENYLIST in utils/integrationPolicy.js, then classify it in
 * integrationRouteMatrix.data.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { NextRequest } from 'next/server';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    apiKey: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../utils/denylist.js', () => ({ isRevoked: vi.fn().mockResolvedValue(false) }));
vi.mock('../../../utils/cors.js', () => ({ cors: vi.fn().mockReturnValue(false) }));

import { withAuth } from '../../../utils/withAuth.js';
import { generateApiKey, _resetLastUsedThrottle } from '../../../utils/apiKeys.js';
import { middleware } from '../../../middleware.js';
import { ROUTE_MATRIX, type Outcome, type RouteSpec } from './integrationRouteMatrix.data.js';

// ---------------------------------------------------------------------------
// Route discovery
// ---------------------------------------------------------------------------

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../pages/api');

function listRouteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listRouteFiles(full);
    return /\.(js|ts)$/.test(name) ? [relative(API_ROOT, full).split('\\').join('/')] : [];
  });
}

/** `portfolio/items/[assetId]/manual-values.js` → `/api/portfolio/items/sample-1/manual-values` */
function urlFor(file: string): string {
  const path = file
    .replace(/\.(js|ts)$/, '')
    .replace(/(^|\/)index$/, '')
    .replace(/\[\.\.\.[^\]]+\]/g, 'callback/google')
    .replace(/\[[^\]]+\]/g, 'sample-1');
  return `/api/${path}`.replace(/\/$/, '');
}

const ROUTE_FILES = listRouteFiles(API_ROOT).sort();

// ---------------------------------------------------------------------------
// Harness: real withAuth / middleware with a mocked key lookup
// ---------------------------------------------------------------------------

const CREATOR = { id: 'user-admin', tenantId: 'tenant-1', email: 'admin@example.com', role: 'admin' };

function arrangeToken(accessLevel: 'READ_ONLY' | 'READ_WRITE') {
  const { token, prefix, keyHash } = generateApiKey();
  mockPrisma.apiKey.findUnique.mockResolvedValue({
    id: 'key-1',
    tenantId: 'tenant-1',
    integrationId: 'int-1',
    prefix,
    keyHash,
    expiresAt: null,
    revokedAt: null,
    integration: { id: 'int-1', tenantId: 'tenant-1', accessLevel, createdByUserId: CREATOR.id, revokedAt: null },
  });
  mockPrisma.user.findUnique.mockResolvedValue(CREATOR);
  return token;
}

function makeRes() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res;
}

async function outcomeThroughWithAuth(spec: RouteSpec, url: string, method: string, token: string): Promise<Outcome> {
  // Stand-in for the route handler: reproduces the route's inline admin gate.
  const handler = vi.fn((req: any, res: any) => {
    if (spec.inlineAdmin?.includes(method) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required', inline: true });
    }
    return res.status(200).json({ ok: true });
  });
  const wrapped = withAuth(handler, spec.requireAdmin ? { requireRole: 'admin' } : {});
  const res = makeRes();
  await wrapped({ method, url, headers: { authorization: `Bearer ${token}` }, cookies: {} } as any, res);

  if (res.statusCode === 200) return 'A';
  if (res.body?.code === 'NOT_AVAILABLE_TO_INTEGRATIONS') return 'D';
  if (res.body?.code === 'READ_ONLY_INTEGRATION') return 'R';
  if (res.statusCode === 403) return 'X';
  throw new Error(`Unexpected outcome ${res.statusCode} ${JSON.stringify(res.body)} for ${method} ${url}`);
}

function outcomeThroughMiddleware(spec: RouteSpec, url: string, method: string, token: string): Outcome {
  const res = middleware(new NextRequest(new URL(url, 'https://api.bliss.test'), {
    method,
    headers: { authorization: `Bearer ${token}` },
  }));
  if (res.status === 403) return 'D';
  return spec.auth === 'public' ? 'P' : 'U';
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetLastUsedThrottle();
  mockPrisma.apiKey.updateMany.mockResolvedValue({ count: 1 });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('integration route matrix', () => {
  it('discovers the API routes', () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(70);
  });

  it('classifies every route file under pages/api', () => {
    const unclassified = ROUTE_FILES.filter((f) => !(f in ROUTE_MATRIX));
    expect(unclassified, 'New route(s): classify them in ROUTE_MATRIX (and the denylist if tokens must not reach them)').toEqual([]);
  });

  it('has no stale entries', () => {
    const stale = Object.keys(ROUTE_MATRIX).filter((f) => !ROUTE_FILES.includes(f));
    expect(stale).toEqual([]);
  });

  describe.each(Object.entries(ROUTE_MATRIX))('%s', (file, spec) => {
    const source = () => readFileSync(join(API_ROOT, file), 'utf8');
    const url = urlFor(file);

    it('auth wiring matches the declared classification', () => {
      const src = source();
      expect(/withAuth\(/.test(src), 'withAuth usage').toBe(spec.auth === 'withAuth');
      expect(/requireRole:\s*'admin'/.test(src), 'requireRole: admin').toBe(Boolean(spec.requireAdmin));

      const hasInlineAdmin = /role\s*(!==|===)\s*'admin'/.test(src.replace(/^\s*\*.*$/gm, ''));
      if (hasInlineAdmin) {
        expect(spec.inlineAdmin, 'inline admin check found: declare inlineAdmin methods').toBeDefined();
      }
      if (spec.auth === 'adminKey') {
        expect(src).toMatch(/isAdminAuthorized|ADMIN_API_KEY/);
      }
    });

    it('declares only methods the handler serves', () => {
      const src = source();
      for (const method of Object.keys(spec.methods)) {
        if (spec.auth === 'credential' && file.includes('[...')) continue; // NextAuth dispatches internally
        expect(src, `${method} not referenced in ${file}`).toContain(`'${method}'`);
      }
    });

    it('does not re-read the user role from the DB when reachable by tokens', () => {
      const reachable = Object.values(spec.methods).some((pair) => pair.includes('A'));
      if (!reachable) return;
      // Token requests act as the creating admin with a capped role. A route
      // that re-reads the caller's own User row (and with it `role`) by
      // req.user.id would undo the cap.
      expect(source()).not.toMatch(/prisma\.user\.find\w*\(\s*\{\s*where:\s*\{\s*id:\s*(req\.)?user\.id\b/);
    });

    it.each(Object.entries(spec.methods))('%s → %s', async (method, expected) => {
      const [expectedRO, expectedRW] = expected.split('/') as [Outcome, Outcome];

      for (const [level, want] of [['READ_ONLY', expectedRO], ['READ_WRITE', expectedRW]] as const) {
        const token = arrangeToken(level);
        const got = spec.auth === 'withAuth'
          ? await outcomeThroughWithAuth(spec, url, method, token)
          : outcomeThroughMiddleware(spec, url, method, token);
        expect(got, `${level} ${method} ${url}`).toBe(want);
      }
    });
  });
});

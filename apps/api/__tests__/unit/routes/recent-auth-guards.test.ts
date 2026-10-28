/**
 * The three key-minting actions require a recent sign-in (#156, R18):
 * POST /api/integrations, POST /api/integrations/:id/keys and
 * POST /api/oauth/requests/:id/approve answer 403 REAUTH_REQUIRED before
 * touching the database when the caller's sign-in is older than 15 minutes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({}, { get: () => (_req: any, _res: any, next: Function) => next() }),
}));
vi.mock('../../../utils/cors.js', () => ({ cors: vi.fn().mockReturnValue(false) }));
vi.mock('../../../lib/oauthHttp.js', () => ({ limit: vi.fn().mockResolvedValue(undefined) }));

const { mockPrisma, mockOauth, authState } = vi.hoisted(() => ({
  mockPrisma: {
    integration: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    apiKey: { create: vi.fn() },
  },
  mockOauth: { loadRequestForUser: vi.fn(), approveRequest: vi.fn(), OAuthError: class extends Error {} },
  authState: { user: null as any },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../services/oauth.service.js', () => mockOauth);
vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => (req: any, res: any) => {
    req.user = authState.user;
    return handler(req, res);
  },
}));

import integrationsHandler from '../../../pages/api/integrations/index.js';
import keysHandler from '../../../pages/api/integrations/[id]/keys/index.js';
import approveHandler from '../../../pages/api/oauth/requests/[id]/approve.js';

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

const routes = [
  ['POST /api/integrations', integrationsHandler, {}],
  ['POST /api/integrations/:id/keys', keysHandler, { id: 'int-1' }],
  ['POST /api/oauth/requests/:id/approve', approveHandler, { id: 'req-1' }],
] as const;

beforeEach(() => vi.clearAllMocks());

describe.each(routes)('%s', (_name, handler, query) => {
  it.each([
    ['a sign-in 16 minutes ago', new Date(Date.now() - 16 * 60_000)],
    ['a legacy token', null],
  ])('answers 403 REAUTH_REQUIRED for %s', async (_label, authenticatedAt) => {
    authState.user = { id: 'u1', tenantId: 't1', role: 'admin', authenticatedAt };
    const res = makeRes();

    await handler({ method: 'POST', headers: {}, query, body: {} } as any, res);

    expect(res._status).toBe(403);
    expect(res._body.code).toBe('REAUTH_REQUIRED');
    expect(mockPrisma.integration.create).not.toHaveBeenCalled();
    expect(mockPrisma.integration.findFirst).not.toHaveBeenCalled();
    expect(mockOauth.loadRequestForUser).not.toHaveBeenCalled();
  });

  it('lets a sign-in 5 minutes ago through to the handler', async () => {
    authState.user = { id: 'u1', tenantId: 't1', role: 'admin', authenticatedAt: new Date(Date.now() - 5 * 60_000) };
    mockPrisma.integration.findFirst.mockResolvedValue(null);
    mockOauth.loadRequestForUser.mockResolvedValue({ status: 404, error: 'not found' });
    const res = makeRes();

    await handler({ method: 'POST', headers: {}, query, body: {} } as any, res);

    expect(res._status).not.toBe(403);
  });
});

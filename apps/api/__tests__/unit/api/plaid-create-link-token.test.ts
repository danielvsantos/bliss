/**
 * Unit tests for POST /api/plaid/create-link-token
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockPlaidClient } = vi.hoisted(() => ({
  mockPrisma: {
    tenantCountry: { findMany: vi.fn() },
    tenant: { findUnique: vi.fn() },
    plaidItem: { findUnique: vi.fn() },
  },
  mockPlaidClient: {
    linkTokenCreate: vi.fn(),
  },
}));

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

vi.mock('../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

vi.mock('../../../services/plaid.service', () => ({
  plaidClient: mockPlaidClient,
}));

import handler from '../../../pages/api/plaid/create-link-token.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
    headers: {},
    cookies: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res._status = undefined;
  res._body = undefined;
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLAID_CLIENT_ID = 'test-client-id';
  process.env.PLAID_SECRET = 'test-secret';
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/plaid/create-link-token', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('creates link token for new connection', async () => {
    mockPrisma.tenantCountry.findMany.mockResolvedValueOnce([
      { country: { iso2: 'US' } },
    ]);
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ plaidHistoryDays: 90 });
    mockPlaidClient.linkTokenCreate.mockResolvedValueOnce({
      data: { link_token: 'link-sandbox-abc123', expiration: '2026-04-05T00:00:00Z' },
    });

    const req = makeReq({ body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ link_token: 'link-sandbox-abc123', expiration: '2026-04-05T00:00:00Z' });
    expect(mockPlaidClient.linkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        products: ['transactions'],
        transactions: { days_requested: 90 },
      }),
    );
  });

  it('creates link token in update mode with accessToken', async () => {
    mockPrisma.tenantCountry.findMany.mockResolvedValueOnce([
      { country: { iso2: 'US' } },
    ]);
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ plaidHistoryDays: 90 });
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      tenantId: 'test-tenant-123',
      accessToken: 'access-sandbox-token',
    });
    mockPlaidClient.linkTokenCreate.mockResolvedValueOnce({
      data: { link_token: 'link-sandbox-update', expiration: '2026-04-05T00:00:00Z' },
    });

    const req = makeReq({ body: { plaidItemId: 'item-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPlaidClient.linkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: 'access-sandbox-token',
      }),
    );
    // Should NOT have products in update mode
    const callArg = mockPlaidClient.linkTokenCreate.mock.calls[0][0];
    expect(callArg.products).toBeUndefined();
  });

  it('returns 500 when Plaid API fails', async () => {
    mockPrisma.tenantCountry.findMany.mockResolvedValueOnce([]);
    mockPrisma.tenant.findUnique.mockResolvedValueOnce(null);
    mockPlaidClient.linkTokenCreate.mockRejectedValueOnce({
      response: {
        data: {
          error_type: 'INVALID_REQUEST',
          error_code: 'INVALID_BODY',
          error_message: 'bad request',
          display_message: null,
        },
      },
    });

    const req = makeReq({ body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(502);
    expect(res._body).toEqual(expect.objectContaining({
      error: 'Plaid API error',
      plaidErrorCode: 'INVALID_BODY',
    }));
  });
});

/**
 * Unit tests for POST /api/plaid/webhook
 *
 * The webhook endpoint is NOT protected by withAuth — Plaid calls it directly.
 * It verifies signatures in production but skips in dev.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockProduceEvent, mockPlaidClient } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
  mockPlaidClient: {
    webhookVerificationKeyGet: vi.fn(),
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

vi.mock('../../../services/plaid.service', () => ({
  plaidClient: mockPlaidClient,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

vi.mock('jose', () => ({
  importJWK: vi.fn(),
  compactVerify: vi.fn(),
}));

import handler from '../../../pages/api/plaid/webhook.js';

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
  process.env.NODE_ENV = 'test';
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/plaid/webhook', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('returns 200 and enqueues PLAID_SYNC_UPDATES for TRANSACTIONS.SYNC_UPDATES_AVAILABLE', async () => {
    const req = makeReq({
      body: {
        webhook_type: 'TRANSACTIONS',
        webhook_code: 'SYNC_UPDATES_AVAILABLE',
        item_id: 'plaid-item-abc',
      },
    });
    const res = makeRes();

    mockPrisma.plaidItem.findFirst.mockResolvedValueOnce({
      id: 'internal-item-1',
      tenantId: 'tenant-123',
      status: 'ACTIVE',
    });

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ received: true });

    expect(mockProduceEvent).toHaveBeenCalledWith({
      type: 'PLAID_SYNC_UPDATES',
      tenantId: 'tenant-123',
      plaidItemId: 'internal-item-1',
      source: 'WEBHOOK_SYNC_UPDATES_AVAILABLE',
    });
  });

  it('updates PlaidItem status for ITEM.ERROR', async () => {
    const req = makeReq({
      body: {
        webhook_type: 'ITEM',
        webhook_code: 'ERROR',
        item_id: 'plaid-item-abc',
        error: { error_code: 'SOME_ERROR', error_type: 'ITEM_ERROR', error_message: 'Something broke' },
      },
    });
    const res = makeRes();

    mockPrisma.plaidItem.findFirst.mockResolvedValueOnce({
      id: 'internal-item-1',
      tenantId: 'tenant-123',
      status: 'ACTIVE',
    });
    mockPrisma.plaidItem.update.mockResolvedValueOnce({});

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.plaidItem.update).toHaveBeenCalledWith({
      where: { id: 'internal-item-1' },
      data: { status: 'ERROR', errorCode: 'SOME_ERROR', updatedAt: expect.any(Date) },
    });
  });

  it('handles LOGIN_REQUIRED webhook', async () => {
    const req = makeReq({
      body: {
        webhook_type: 'ITEM',
        webhook_code: 'LOGIN_REQUIRED',
        item_id: 'plaid-item-abc',
      },
    });
    const res = makeRes();

    mockPrisma.plaidItem.findFirst.mockResolvedValueOnce({
      id: 'internal-item-1',
      tenantId: 'tenant-123',
      status: 'ACTIVE',
    });
    mockPrisma.plaidItem.update.mockResolvedValueOnce({});

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.plaidItem.update).toHaveBeenCalledWith({
      where: { id: 'internal-item-1' },
      data: { status: 'LOGIN_REQUIRED', updatedAt: expect.any(Date) },
    });
  });

  it('skips verification in non-production', async () => {
    // In non-production, the handler should NOT reject requests without plaid-verification header
    const req = makeReq({
      body: {
        webhook_type: 'TRANSACTIONS',
        webhook_code: 'SYNC_UPDATES_AVAILABLE',
        item_id: 'plaid-item-abc',
      },
    });
    const res = makeRes();

    mockPrisma.plaidItem.findFirst.mockResolvedValueOnce({
      id: 'internal-item-1',
      tenantId: 'tenant-123',
      status: 'ACTIVE',
    });

    // No plaid-verification header set — should still succeed in non-production
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ received: true });
  });
});

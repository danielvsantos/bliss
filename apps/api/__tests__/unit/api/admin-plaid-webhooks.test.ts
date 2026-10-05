/**
 * Unit tests for GET|POST /api/admin/plaid-webhooks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPlaidClient } = vi.hoisted(() => ({
  mockPlaidClient: { itemGet: vi.fn(), itemWebhookUpdate: vi.fn() },
}));
vi.mock('../../../services/plaid.service.js', () => ({
  plaidClient: mockPlaidClient,
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { plaidItem: { findMany: vi.fn() } },
}));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/admin/plaid-webhooks.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY },
    cookies: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

const ADMIN_KEY = 'test-admin-key';
const EXPECTED = 'https://api.example.com/api/plaid/webhook';

const item = {
  id: 'pi-1',
  tenantId: 'tenant-abc',
  accessToken: 'access-token-xyz',
  institutionName: 'Chase',
  status: 'ACTIVE',
  lastSync: null,
};

function itemGetResponse(webhook: string | null) {
  return {
    data: {
      item: { webhook, error: null },
      status: {
        last_webhook: { sent_at: '2026-10-04T10:00:00Z', code_sent: 'SYNC_UPDATES_AVAILABLE' },
        transactions: { last_successful_update: '2026-10-04T09:00:00Z', last_failed_update: null },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.PLAID_WEBHOOK_URL = EXPECTED;
  mockPrisma.plaidItem.findMany.mockResolvedValue([item]);
});

describe('auth', () => {
  it('returns 401 without x-admin-key', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: {} }), res as unknown as NextApiResponse);
    expect(res._status).toBe(401);
    expect(mockPrisma.plaidItem.findMany).not.toHaveBeenCalled();
  });

  it('returns 405 for other methods', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'DELETE' }), res as unknown as NextApiResponse);
    expect(res._status).toBe(405);
  });
});

describe('GET', () => {
  it('reports the registered webhook and never echoes the access token', async () => {
    mockPlaidClient.itemGet.mockResolvedValue(itemGetResponse('https://old.example.com/hook'));
    const res = makeRes();

    await handler(makeReq({ query: { tenantId: 'tenant-abc' } }), res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.plaidItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-abc' } }),
    );
    expect(mockPlaidClient.itemGet).toHaveBeenCalledWith({ access_token: 'access-token-xyz' });
    expect(mockPlaidClient.itemWebhookUpdate).not.toHaveBeenCalled();
    expect(res._body.expectedWebhook).toBe(EXPECTED);
    expect(res._body.items[0]).toMatchObject({
      id: 'pi-1',
      registeredWebhook: 'https://old.example.com/hook',
      matches: false,
      lastWebhookSentAt: '2026-10-04T10:00:00Z',
      lastWebhookCode: 'SYNC_UPDATES_AVAILABLE',
      updated: false,
    });
    expect(JSON.stringify(res._body)).not.toContain('access-token-xyz');
  });

  it('reports a Plaid error per item instead of failing the request', async () => {
    mockPlaidClient.itemGet.mockRejectedValue({
      response: { data: { error_code: 'INVALID_ACCESS_TOKEN', error_message: 'bad token' } },
    });
    const res = makeRes();

    await handler(makeReq(), res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.items[0].error).toBe('/item/get failed — INVALID_ACCESS_TOKEN: bad token');
  });
});

describe('POST', () => {
  it('re-points only mismatched items', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValue([item, { ...item, id: 'pi-2', accessToken: 'tok-2' }]);
    mockPlaidClient.itemGet
      .mockResolvedValueOnce(itemGetResponse(null))
      .mockResolvedValueOnce(itemGetResponse(EXPECTED));
    mockPlaidClient.itemWebhookUpdate.mockResolvedValue({ data: {} });
    const res = makeRes();

    await handler(makeReq({ method: 'POST' }), res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPlaidClient.itemWebhookUpdate).toHaveBeenCalledTimes(1);
    expect(mockPlaidClient.itemWebhookUpdate).toHaveBeenCalledWith({
      access_token: 'access-token-xyz',
      webhook: EXPECTED,
    });
    expect(res._body.items.map((i: any) => i.updated)).toEqual([true, false]);
  });

  it('returns 400 when PLAID_WEBHOOK_URL is unset', async () => {
    delete process.env.PLAID_WEBHOOK_URL;
    const res = makeRes();

    await handler(makeReq({ method: 'POST' }), res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(mockPlaidClient.itemWebhookUpdate).not.toHaveBeenCalled();
  });
});

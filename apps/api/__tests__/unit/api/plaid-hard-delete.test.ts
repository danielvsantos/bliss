/**
 * Unit tests for DELETE /api/plaid/items/hard-delete
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPlaidClient } = vi.hoisted(() => ({
  mockPlaidClient: { itemRemove: vi.fn() },
}));
vi.mock('../../../services/plaid.service', () => ({
  plaidClient: mockPlaidClient,
}));
vi.mock('../../../services/plaid.service.js', () => ({
  plaidClient: mockPlaidClient,
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findUnique: vi.fn(), delete: vi.fn() },
    account: { count: vi.fn(), updateMany: vi.fn() },
    plaidTransaction: { count: vi.fn() },
    plaidSyncLog: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../prisma/prisma', () => ({ default: mockPrisma }));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/plaid/items/hard-delete.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'DELETE', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
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
const plaidItem = {
  id: 'pi-1',
  itemId: 'ext-item-1',
  tenantId: 'tenant-abc',
  institutionName: 'Chase',
  accessToken: 'access-token-xyz',
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

describe('Auth guard', () => {
  it('returns 401 when x-admin-key is missing', async () => {
    const req = makeReq({ query: { id: 'pi-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
  });

  it('returns 200 for OPTIONS', async () => {
    const req = makeReq({ method: 'OPTIONS', headers: { 'x-admin-key': ADMIN_KEY } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });
});

describe('DELETE /api/plaid/items/hard-delete', () => {
  it('returns 400 when neither id nor itemId is provided', async () => {
    const req = makeReq({ headers: { 'x-admin-key': ADMIN_KEY }, query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/provide either id/i);
  });

  it('returns 404 when plaid item not found', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValue(null);

    const req = makeReq({
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { id: 'nonexistent' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('hard-deletes item and returns summary', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValue(plaidItem);
    mockPlaidClient.itemRemove.mockResolvedValue({ data: { request_id: 'req-1' } });
    mockPrisma.account.count.mockResolvedValue(2);
    mockPrisma.plaidTransaction.count.mockResolvedValue(10);
    mockPrisma.plaidSyncLog.count.mockResolvedValue(3);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.account.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.plaidItem.delete.mockResolvedValue(plaidItem);
      return fn(mockPrisma);
    });

    const req = makeReq({
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { id: 'pi-1' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.deleted).toBe(true);
    expect(res._body.summary.accountsUnlinked).toBe(2);
    expect(res._body.summary.plaidTransactionsDeleted).toBe(10);
    expect(res._body.summary.transactionsPreserved).toBe(true);
  });

  it('proceeds when Plaid returns ITEM_NOT_FOUND', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValue(plaidItem);
    const plaidErr: any = new Error('Item not found');
    plaidErr.response = { data: { error_code: 'ITEM_NOT_FOUND' } };
    mockPlaidClient.itemRemove.mockRejectedValue(plaidErr);
    mockPrisma.account.count.mockResolvedValue(0);
    mockPrisma.plaidTransaction.count.mockResolvedValue(5);
    mockPrisma.plaidSyncLog.count.mockResolvedValue(1);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.plaidItem.delete.mockResolvedValue(plaidItem);
      return fn(mockPrisma);
    });

    const req = makeReq({
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { id: 'pi-1' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.summary.plaidTokenRevoked).toBe(false);
  });

  it('returns 502 on unexpected Plaid error', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValue(plaidItem);
    const plaidErr: any = new Error('Plaid API down');
    plaidErr.response = { data: { error_code: 'INTERNAL_SERVER_ERROR' } };
    mockPlaidClient.itemRemove.mockRejectedValue(plaidErr);

    const req = makeReq({
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { id: 'pi-1' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(502);
  });

  it('looks up by itemId when id is not provided', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValue(plaidItem);
    mockPlaidClient.itemRemove.mockResolvedValue({ data: {} });
    mockPrisma.account.count.mockResolvedValue(0);
    mockPrisma.plaidTransaction.count.mockResolvedValue(0);
    mockPrisma.plaidSyncLog.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.plaidItem.delete.mockResolvedValue(plaidItem);
      return fn(mockPrisma);
    });

    const req = makeReq({
      headers: { 'x-admin-key': ADMIN_KEY },
      query: { itemId: 'ext-item-1' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.plaidItem.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { itemId: 'ext-item-1' } })
    );
  });
});

describe('405 guard', () => {
  it('returns 405 for POST', async () => {
    const req = makeReq({ method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});

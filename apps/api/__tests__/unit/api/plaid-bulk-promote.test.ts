/**
 * Unit tests for POST /api/plaid/transactions/bulk-promote
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockProduceEvent, mockComputeTransactionHash, mockBuildDuplicateHashSet } = vi.hoisted(() => ({
  mockPrisma: {
    category: { findFirst: vi.fn() },
    plaidItem: { findMany: vi.fn() },
    account: { findMany: vi.fn() },
    plaidTransaction: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    transaction: { findMany: vi.fn(), createMany: vi.fn() },
    tag: { findFirst: vi.fn(), create: vi.fn() },
    transactionTag: { createMany: vi.fn() },
  },
  mockProduceEvent: vi.fn(),
  mockComputeTransactionHash: vi.fn(),
  mockBuildDuplicateHashSet: vi.fn(),
}));

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'tenant-1', role: 'admin', email: 'a@test.com' };

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

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

vi.mock('../../../utils/transactionHash.js', () => ({
  computeTransactionHash: mockComputeTransactionHash,
  buildDuplicateHashSet: mockBuildDuplicateHashSet,
}));

import handler from '../../../pages/api/plaid/transactions/bulk-promote.js';

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
  // Stub global fetch for fire-and-forget feedback calls
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/plaid/transactions/bulk-promote', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('promotes transactions in bulk and fires event', async () => {
    // Tenant has one Plaid item
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([{ id: 'pi-1' }]);
    // One linked account
    mockPrisma.account.findMany.mockResolvedValueOnce([
      { id: 10, plaidAccountId: 'plaid-acc-1' },
    ]);
    // One eligible transaction
    mockPrisma.plaidTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'ptx-1',
        plaidTransactionId: 'ext-1',
        plaidAccountId: 'plaid-acc-1',
        suggestedCategoryId: 5,
        aiConfidence: 0.95,
        merchantName: 'Coffee Shop',
        name: 'COFFEE SHOP',
        amount: 4.5,
        date: '2026-03-01',
        isoCurrencyCode: 'USD',
        requiresEnrichment: false,
      },
    ]);
    // No existing transactions by externalId
    mockPrisma.transaction.findMany
      .mockResolvedValueOnce([])   // existingByExternalId lookup
      .mockResolvedValueOnce([{ id: 100, externalId: 'ext-1' }]); // created lookup
    // Hash dedup returns empty set
    mockBuildDuplicateHashSet.mockResolvedValue(new Set());
    // createMany succeeds
    mockPrisma.transaction.createMany.mockResolvedValueOnce({ count: 1 });
    // PlaidTransaction update succeeds
    mockPrisma.plaidTransaction.update.mockResolvedValue({});
    // produceEvent succeeds
    mockProduceEvent.mockResolvedValue(undefined);

    const req = makeReq({
      body: { transactionIds: ['ptx-1'] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.promoted).toBe(1);
    expect(res._body.errors).toBe(0);
    expect(mockPrisma.transaction.createMany).toHaveBeenCalled();
    expect(mockProduceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRANSACTIONS_IMPORTED' }),
    );
  });

  it('returns OK with promoted:0 when tenant has no Plaid items', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ promoted: 0, skipped: 0, errors: 0 });
  });

  it('returns 400 when overrideCategoryId is invalid', async () => {
    mockPrisma.category.findFirst.mockResolvedValueOnce(null);

    const req = makeReq({ body: { overrideCategoryId: 999 } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid category' });
  });

  // -------------------------------------------------------------------------
  // Tag propagation
  // -------------------------------------------------------------------------

  function setUpBasicPromoteMocks() {
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([{ id: 'pi-1' }]);
    mockPrisma.account.findMany.mockResolvedValueOnce([
      { id: 10, plaidAccountId: 'plaid-acc-1' },
    ]);
    mockPrisma.plaidTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'ptx-1',
        plaidTransactionId: 'ext-1',
        plaidAccountId: 'plaid-acc-1',
        suggestedCategoryId: 5,
        aiConfidence: 0.95,
        merchantName: 'Coffee Shop',
        name: 'COFFEE SHOP',
        amount: 4.5,
        date: '2026-03-01',
        isoCurrencyCode: 'USD',
        requiresEnrichment: false,
      },
    ]);
    mockPrisma.transaction.findMany
      .mockResolvedValueOnce([]) // existingByExternalId lookup
      .mockResolvedValueOnce([{ id: 100, externalId: 'ext-1' }]); // created lookup
    mockBuildDuplicateHashSet.mockResolvedValue(new Set());
    mockPrisma.transaction.createMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.plaidTransaction.update.mockResolvedValue({});
    mockProduceEvent.mockResolvedValue(undefined);
  }

  it('resolves tag names and attaches TransactionTag rows to newly-created transactions', async () => {
    setUpBasicPromoteMocks();
    mockPrisma.tag.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockPrisma.tag.create
      .mockResolvedValueOnce({ id: 101, name: 'Japan 2026' })
      .mockResolvedValueOnce({ id: 102, name: 'Business' });

    const req = makeReq({
      body: { transactionIds: ['ptx-1'], tags: ['Japan 2026', 'Business'] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.promoted).toBe(1);
    expect(res._body.tagsApplied).toBe(true);
    expect(mockPrisma.transactionTag.createMany).toHaveBeenCalledWith({
      data: [
        { transactionId: 100, tagId: 101 },
        { transactionId: 100, tagId: 102 },
      ],
      skipDuplicates: true,
    });
  });

  it('omits tagsApplied and skips all tag work when tags is not provided', async () => {
    setUpBasicPromoteMocks();

    const req = makeReq({ body: { transactionIds: ['ptx-1'] } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.tagsApplied).toBeUndefined();
    expect(mockPrisma.tag.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.transactionTag.createMany).not.toHaveBeenCalled();
  });

  it('still promotes successfully and reports tagsApplied: false when tag attachment fails', async () => {
    setUpBasicPromoteMocks();
    mockPrisma.tag.findFirst.mockResolvedValueOnce({ id: 101, name: 'Japan 2026' });
    mockPrisma.transactionTag.createMany.mockRejectedValueOnce(new Error('DB blip'));

    const req = makeReq({
      body: { transactionIds: ['ptx-1'], tags: ['Japan 2026'] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    // The promote itself is unaffected by the tag-attachment failure.
    expect(res._status).toBe(200);
    expect(res._body.promoted).toBe(1);
    expect(res._body.errors).toBe(0);
    expect(res._body.tagsApplied).toBe(false);
  });

  it('skips tag resolution entirely when there are no transactions to create', async () => {
    // No eligible transactions at all — nothing to promote or tag.
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([{ id: 'pi-1' }]);
    mockPrisma.account.findMany.mockResolvedValueOnce([]);
    mockPrisma.plaidTransaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);

    const req = makeReq({
      body: { transactionIds: ['ptx-1'], tags: ['Brand New Tag'] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.promoted).toBe(0);
    // No transactions were created, so no Tag row should have been created either —
    // proves the resolution step doesn't run (and doesn't create a phantom tag)
    // when there's nothing to attach it to.
    expect(mockPrisma.tag.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });
});

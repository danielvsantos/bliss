import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

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

vi.mock('@prisma/client/runtime/library', () => ({
  Decimal: class MockDecimal {
    value: number;
    constructor(v: any) { this.value = Number(v); }
    minus(other: any) { return new (this.constructor as any)(this.value - (other?.value ?? Number(other))); }
    toString() { return String(this.value); }
    toJSON() { return this.value; }
  }
}));

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../services/transaction.service.js', () => ({
  handleDebtRepayment: vi.fn().mockResolvedValue(null),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    transaction: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      createMany: vi.fn(),
    },
    category: { findUnique: vi.fn() },
    account: { findUnique: vi.fn() },
    tag: { findFirst: vi.fn(), create: vi.fn() },
    transactionTag: { deleteMany: vi.fn() },
    transactionEmbedding: { updateMany: vi.fn() },
    plaidTransaction: { updateMany: vi.fn() },
    portfolioItem: { upsert: vi.fn() },
    debtTerms: { create: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/transactions/index.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
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

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => {
    if (typeof fn === 'function') return fn(mockPrisma);
    return fn;
  });
  global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;
});

describe('Method Not Allowed', () => {
  it('PATCH returns 405', async () => {
    const req = makeReq({ method: 'PATCH' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.end).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
  });
});

describe('GET /api/transactions — single transaction', () => {
  it('returns 200 with transformed transaction (tags mapped to tag.tag)', async () => {
    const dbTransaction = {
      id: 1,
      tenantId: 'test-tenant-123',
      description: 'Coffee',
      credit: null,
      debit: 5.50,
      account: { name: 'Checking', currencyCode: 'USD', country: 'US' },
      category: { name: 'Food', group: 'EXPENSE', type: 'Expense' },
      tags: [
        { tag: { id: 1, name: 'Daily', color: '#ff0000', emoji: null } },
        { tag: { id: 2, name: 'Food', color: '#00ff00', emoji: null } },
      ],
    };
    mockPrisma.transaction.findUnique.mockResolvedValueOnce(dbTransaction);

    const req = makeReq({ method: 'GET', query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.tags).toEqual([
      { id: 1, name: 'Daily', color: '#ff0000', emoji: null },
      { id: 2, name: 'Food', color: '#00ff00', emoji: null },
    ]);
    expect(mockPrisma.transaction.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      include: expect.objectContaining({
        account: expect.any(Object),
        category: expect.any(Object),
        tags: expect.any(Object),
      }),
    });
  });

  it('returns 400 for invalid id (non-numeric)', async () => {
    const req = makeReq({ method: 'GET', query: { id: 'abc' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid transaction ID' });
  });

  it('returns 404 when transaction not found', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({ method: 'GET', query: { id: '999' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Transaction not found in this tenant' });
  });

  it('returns 404 when transaction belongs to different tenant', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValueOnce({
      id: 1,
      tenantId: 'other-tenant',
      tags: [],
    });

    const req = makeReq({ method: 'GET', query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Transaction not found in this tenant' });
  });
});

describe('GET /api/transactions — list', () => {
  it('returns 200 with paginated results, totals, filters, sort', async () => {
    const transactions = [
      {
        id: 1,
        description: 'Salary',
        credit: 5000,
        debit: null,
        tags: [{ tag: { id: 1, name: 'Income', color: '#00ff00', emoji: null } }],
      },
    ];
    mockPrisma.transaction.findMany.mockResolvedValueOnce(transactions);
    mockPrisma.transaction.count.mockResolvedValueOnce(1);
    mockPrisma.transaction.aggregate.mockResolvedValueOnce({
      _sum: { credit: 5000, debit: 0 },
    });

    const req = makeReq({ method: 'GET', query: { page: '1', limit: '10' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.transactions).toHaveLength(1);
    expect(res._body.transactions[0].tags).toEqual([
      { id: 1, name: 'Income', color: '#00ff00', emoji: null },
    ]);
    expect(res._body.total).toBe(1);
    expect(res._body.page).toBe(1);
    expect(res._body.limit).toBe(10);
    expect(res._body.totalPages).toBe(1);
    expect(res._body.totals).toBeDefined();
    expect(res._body.sort).toEqual({ field: 'transaction_date', order: 'desc' });
  });

  it('applies year/month filters', async () => {
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.transaction.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.aggregate.mockResolvedValueOnce({
      _sum: { credit: null, debit: null },
    });

    const req = makeReq({ method: 'GET', query: { year: '2025', month: '6' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'test-tenant-123',
          year: 2025,
          month: 6,
        }),
      }),
    );
  });

  it('returns empty results correctly', async () => {
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.transaction.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.aggregate.mockResolvedValueOnce({
      _sum: { credit: null, debit: null },
    });

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.transactions).toEqual([]);
    expect(res._body.total).toBe(0);
  });
});

describe('POST /api/transactions', () => {
  it('returns 400 for invalid transaction_date', async () => {
    const req = makeReq({
      method: 'POST',
      body: { transaction_date: 'not-a-date', categoryId: 1, accountId: 1 },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid transaction_date format.' });
  });

  it('creates transaction with correct date fields', async () => {
    const createdTx = {
      id: 10,
      tenantId: 'test-tenant-123',
      description: 'Groceries',
      credit: null,
      debit: 45.00,
      transaction_date: new Date('2025-03-15'),
      year: 2025,
      month: 3,
      day: 15,
      quarter: 'Q1',
      portfolioItemId: null,
      currency: 'USD',
    };

    mockPrisma.category.findUnique.mockResolvedValueOnce({ id: 1, name: 'Food', type: 'Expense' });
    mockPrisma.account.findUnique.mockResolvedValueOnce({ id: 1, name: 'Checking', countryId: 'US' });
    mockPrisma.transaction.create.mockResolvedValueOnce(createdTx);

    const req = makeReq({
      method: 'POST',
      body: {
        transaction_date: '2025-03-15',
        categoryId: 1,
        accountId: 1,
        description: 'Groceries',
        debit: 45.00,
        currency: 'USD',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(res._body).toEqual(createdTx);
    expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        year: 2025,
        month: 3,
        day: 15,
        quarter: 'Q1',
        tenantId: 'test-tenant-123',
      }),
    });
  });

  it('returns 201 and auto-creates tags that do not exist', async () => {
    const newTag = { id: 5, name: 'NewTag', color: '#aaaaaa', tenantId: 'test-tenant-123' };

    mockPrisma.category.findUnique.mockResolvedValueOnce({ id: 1, name: 'Food', type: 'Expense' });
    mockPrisma.account.findUnique.mockResolvedValueOnce({ id: 1, name: 'Checking', countryId: 'US' });
    mockPrisma.tag.findFirst.mockResolvedValueOnce(null);
    mockPrisma.tag.create.mockResolvedValueOnce(newTag);
    mockPrisma.auditLog.create.mockResolvedValueOnce({});
    mockPrisma.transaction.create.mockResolvedValueOnce({ id: 11, tags: [] });

    const req = makeReq({
      method: 'POST',
      body: {
        transaction_date: '2025-06-01',
        categoryId: 1,
        accountId: 1,
        description: 'Lunch',
        debit: 15,
        currency: 'USD',
        tags: ['NewTag'],
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(mockPrisma.tag.findFirst).toHaveBeenCalledWith({
      where: { name: 'NewTag', tenantId: 'test-tenant-123' },
    });
    expect(mockPrisma.tag.create).toHaveBeenCalled();
  });
});

describe('PUT /api/transactions', () => {
  it('returns 400 for invalid id', async () => {
    const req = makeReq({ method: 'PUT', query: { id: 'abc' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid transaction ID' });
  });

  it('returns 404 when transaction not found', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({ method: 'PUT', query: { id: '999' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Transaction not found in this tenant' });
  });

  it('returns 400 for missing required fields', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValueOnce({
      id: 1,
      tenantId: 'test-tenant-123',
      categoryId: 1,
      account: {},
      category: {},
    });

    const req = makeReq({
      method: 'PUT',
      query: { id: '1' },
      body: { transaction_date: '2025-01-01' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing required fields for transaction update.' });
  });

  it('returns 400 when both credit and debit are provided', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValueOnce({
      id: 1,
      tenantId: 'test-tenant-123',
      categoryId: 1,
      account: {},
      category: {},
    });

    const req = makeReq({
      method: 'PUT',
      query: { id: '1' },
      body: {
        transaction_date: '2025-01-01',
        categoryId: 1,
        accountId: 1,
        description: 'Test',
        currency: 'USD',
        credit: 100,
        debit: 50,
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Transaction cannot have both credit and debit amounts.' });
  });

  it('returns 400 for invalid transaction_date', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValueOnce({
      id: 1,
      tenantId: 'test-tenant-123',
      categoryId: 1,
      account: {},
      category: {},
    });

    const req = makeReq({
      method: 'PUT',
      query: { id: '1' },
      body: {
        transaction_date: 'not-a-date',
        categoryId: 1,
        accountId: 1,
        description: 'Test',
        currency: 'USD',
        debit: 50,
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid transaction_date format.' });
  });

  it('returns 200 and updates successfully', async () => {
    const existing = {
      id: 1,
      tenantId: 'test-tenant-123',
      categoryId: 1,
      portfolioItemId: null,
      account: { countryId: 'US' },
      category: { type: 'Expense', group: 'EXPENSE' },
    };
    mockPrisma.transaction.findUnique.mockResolvedValueOnce(existing);

    mockPrisma.category.findUnique.mockResolvedValueOnce({
      id: 1,
      name: 'Food',
      type: 'Expense',
      portfolioItemKeyStrategy: 'IGNORE',
    });

    const updatedTx = {
      id: 1,
      tenantId: 'test-tenant-123',
      description: 'Updated desc',
      credit: null,
      debit: 30,
      currency: 'USD',
      portfolioItemId: null,
      transaction_date: new Date('2025-01-15'),
      account: { name: 'Checking', currencyCode: 'USD', country: 'US' },
      category: { name: 'Food', group: 'EXPENSE', type: 'Expense' },
      tags: [{ tag: { id: 1, name: 'Lunch', color: '#ff0000', emoji: null } }],
    };
    mockPrisma.transaction.update.mockResolvedValueOnce(updatedTx);
    mockPrisma.auditLog.create.mockResolvedValueOnce({});

    const req = makeReq({
      method: 'PUT',
      query: { id: '1' },
      body: {
        transaction_date: '2025-01-15',
        categoryId: 1,
        accountId: 1,
        description: 'Updated desc',
        currency: 'USD',
        debit: 30,
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.description).toBe('Updated desc');
    expect(res._body.tags).toEqual([
      { id: 1, name: 'Lunch', color: '#ff0000', emoji: null },
    ]);
    expect(mockPrisma.transaction.update).toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE',
        table: 'Transaction',
        recordId: '1',
        tenantId: 'test-tenant-123',
      }),
    });
  });
});

describe('DELETE /api/transactions', () => {
  it('returns 400 for invalid id', async () => {
    const req = makeReq({ method: 'DELETE', query: { id: 'abc' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid transaction ID' });
  });

  it('returns 404 when not found', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({ method: 'DELETE', query: { id: '999' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Transaction not found in this tenant' });
  });

  it('returns 204 on successful delete with audit log', async () => {
    const existing = {
      id: 1,
      tenantId: 'test-tenant-123',
      portfolioItemId: null,
      transaction_date: new Date('2025-01-01'),
      currency: 'USD',
      account: { countryId: 'US' },
      category: { type: 'Expense', group: 'EXPENSE' },
    };
    mockPrisma.transaction.findUnique.mockResolvedValueOnce(existing);
    mockPrisma.transactionTag.deleteMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.transactionEmbedding.updateMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.plaidTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.transaction.delete.mockResolvedValueOnce(existing);
    mockPrisma.auditLog.create.mockResolvedValueOnce({});

    const req = makeReq({ method: 'DELETE', query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(204);
    expect(res.end).toHaveBeenCalled();
    expect(mockPrisma.transactionTag.deleteMany).toHaveBeenCalledWith({
      where: { transactionId: 1 },
    });
    expect(mockPrisma.transactionEmbedding.updateMany).toHaveBeenCalledWith({
      where: { transactionId: 1 },
      data: { transactionId: null },
    });
    expect(mockPrisma.plaidTransaction.updateMany).toHaveBeenCalledWith({
      where: { matchedTransactionId: 1 },
      data: { matchedTransactionId: null, promotionStatus: 'CLASSIFIED' },
    });
    expect(mockPrisma.transaction.delete).toHaveBeenCalledWith({
      where: { id: 1 },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'admin@test.com',
        action: 'DELETE',
        table: 'Transaction',
        recordId: '1',
        tenantId: 'test-tenant-123',
      },
    });
  });
});

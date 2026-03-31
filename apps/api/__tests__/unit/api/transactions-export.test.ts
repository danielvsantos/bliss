import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come BEFORE handler import
// ---------------------------------------------------------------------------

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'test-tenant-export', role: 'admin', email: 'admin@test.com' };

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

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    transaction: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/transactions/export.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

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
  res._headers = {} as Record<string, string>;
  res._written = [] as string[];
  res._ended = false;
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.end = vi.fn(() => { res._ended = true; return res; });
  res.setHeader = vi.fn((key: string, val: string) => { res._headers[key] = val; return res; });
  res.write = vi.fn((chunk: string) => { res._written.push(chunk); return true; });
  res.headersSent = false;
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/transactions/export', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(405);
  });

  it('streams CSV with BOM and headers for empty dataset', async () => {
    mockPrisma.transaction.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '0');

    // First write should be BOM + headers
    expect(res._written.length).toBe(1);
    expect(res._written[0]).toContain('\uFEFF'); // BOM
    expect(res._written[0]).toContain('id,transactiondate,description,debit,credit,account,category,currency,details,ticker,assetquantity,assetprice,tags');
    expect(res._ended).toBe(true);
  });

  it('streams transaction rows as CSV', async () => {
    const mockTx = {
      id: 42,
      transaction_date: new Date('2026-03-01T00:00:00Z'),
      description: 'Morning Coffee',
      debit: 4.5,
      credit: null,
      account: { name: 'Checking' },
      category: { name: 'Coffee' },
      currency: 'USD',
      details: 'Starbucks',
      ticker: null,
      assetQuantity: null,
      assetPrice: null,
      tags: [{ tag: { name: 'daily' } }, { tag: { name: 'food' } }],
    };

    mockPrisma.transaction.count.mockResolvedValueOnce(1);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([mockTx]);

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '1');

    // Should have BOM+headers + 1 data row
    expect(res._written.length).toBe(2);

    const dataRow = res._written[1];
    expect(dataRow).toContain('42');
    expect(dataRow).toContain('2026-03-01');
    expect(dataRow).toContain('Morning Coffee');
    expect(dataRow).toContain('4.5');
    expect(dataRow).toContain('Checking');
    expect(dataRow).toContain('Coffee');
    expect(dataRow).toContain('USD');
    expect(dataRow).toContain('Starbucks');
    expect(dataRow).toContain('daily|food');
    expect(res._ended).toBe(true);
  });

  it('properly escapes CSV fields with commas and quotes', async () => {
    const mockTx = {
      id: 99,
      transaction_date: new Date('2026-03-05T00:00:00Z'),
      description: 'Item "A", special',
      debit: null,
      credit: 100,
      account: { name: 'My Account, Ltd.' },
      category: { name: 'Shopping' },
      currency: 'EUR',
      details: 'Details with "quotes"',
      ticker: null,
      assetQuantity: null,
      assetPrice: null,
      tags: [],
    };

    mockPrisma.transaction.count.mockResolvedValueOnce(1);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([mockTx]);

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    const dataRow = res._written[1];
    // Fields with commas/quotes should be wrapped in double quotes with escaped inner quotes
    expect(dataRow).toContain('"Item ""A"", special"');
    expect(dataRow).toContain('"My Account, Ltd."');
    expect(dataRow).toContain('"Details with ""quotes"""');
  });

  it('passes date filters to Prisma where clause', async () => {
    mockPrisma.transaction.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);

    const req = makeReq({
      method: 'GET',
      query: { startDate: '2026-01-01', endDate: '2026-03-31' },
    });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(mockPrisma.transaction.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: 'test-tenant-export',
        transaction_date: {
          gte: new Date('2026-01-01'),
          lte: new Date('2026-03-31T23:59:59.999Z'),
        },
      }),
    });
  });

  it('passes accountId filter to Prisma where clause', async () => {
    mockPrisma.transaction.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);

    const req = makeReq({
      method: 'GET',
      query: { accountId: '5' },
    });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(mockPrisma.transaction.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: 'test-tenant-export',
        accountId: 5,
      }),
    });
  });

  it('passes category group filter to Prisma where clause', async () => {
    mockPrisma.transaction.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);

    const req = makeReq({
      method: 'GET',
      query: { group: 'Dining' },
    });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(mockPrisma.transaction.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: 'test-tenant-export',
        category: { group: 'Dining' },
      }),
    });
  });

  it('handles multiple rows in a single batch', async () => {
    const batch = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      transaction_date: new Date('2026-03-01'),
      description: `Tx ${i + 1}`,
      debit: 10,
      credit: null,
      account: { name: 'Acc' },
      category: { name: 'Cat' },
      currency: 'USD',
      details: '',
      ticker: null,
      assetQuantity: null,
      assetPrice: null,
      tags: [],
    }));

    mockPrisma.transaction.count.mockResolvedValueOnce(3);
    mockPrisma.transaction.findMany.mockResolvedValueOnce(batch);

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    // BOM+headers + 3 data rows = 4 writes
    expect(res._written.length).toBe(4);
    expect(res._ended).toBe(true);
    expect(res._written[1]).toContain('Tx 1');
    expect(res._written[3]).toContain('Tx 3');
  });

  it('handles investment fields (ticker, quantity, price)', async () => {
    const mockTx = {
      id: 200,
      transaction_date: new Date('2026-03-02T00:00:00Z'),
      description: 'Buy AAPL',
      debit: 15000,
      credit: null,
      account: { name: 'Brokerage' },
      category: { name: 'Stocks' },
      currency: 'USD',
      details: 'Buy',
      ticker: 'AAPL',
      assetQuantity: 100,
      assetPrice: 150,
      tags: [],
    };

    mockPrisma.transaction.count.mockResolvedValueOnce(1);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([mockTx]);

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    // BOM+headers is _written[0], data row is _written[1]
    expect(res._written.length).toBeGreaterThanOrEqual(2);
    const dataRow = res._written[1] as string;
    expect(dataRow).toContain('AAPL');
    expect(dataRow).toContain('100');
    expect(dataRow).toContain('150');
  });

  it('sets Content-Disposition with today date', async () => {
    mockPrisma.transaction.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    const today = new Date().toISOString().slice(0, 10);
    expect(res._headers['Content-Disposition']).toBe(`attachment; filename="bliss-export-${today}.csv"`);
  });
});

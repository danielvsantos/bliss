/**
 * Unit tests for POST /api/imports/detect-adapter
 *
 * This route uses formidable for multipart parsing. We mock formidable to
 * control parsed output and test the adapter matching logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockFormidableParse } = vi.hoisted(() => ({
  mockPrisma: {
    importAdapter: { findMany: vi.fn() },
  },
  mockFormidableParse: vi.fn(),
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

// Mock formidable
vi.mock('formidable', () => {
  return {
    default: () => ({
      parse: mockFormidableParse,
    }),
  };
});

// Mock fs for file cleanup
vi.mock('fs', () => ({
  default: { readFileSync: vi.fn(), unlinkSync: vi.fn() },
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock papaparse
vi.mock('papaparse', () => ({
  default: {
    parse: vi.fn(),
  },
}));

import handler from '../../../pages/api/imports/detect-adapter.js';
import Papa from 'papaparse';
import fs from 'fs';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data' },
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/imports/detect-adapter', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('returns matched adapter with confidence score', async () => {
    mockFormidableParse.mockImplementation((_req: any, cb: Function) => {
      cb(null, {}, {
        file: [{
          filepath: '/tmp/test.csv',
          originalFilename: 'test.csv',
          mimetype: 'text/csv',
        }],
      });
    });

    (fs.readFileSync as any).mockReturnValue('Date,Description,Amount\n2026-01-01,Coffee,5.00');

    (Papa.parse as any).mockReturnValue({
      meta: { fields: ['Date', 'Description', 'Amount'] },
      data: [{ Date: '2026-01-01', Description: 'Coffee', Amount: '5.00' }],
    });

    mockPrisma.importAdapter.findMany.mockResolvedValueOnce([
      {
        id: 3,
        name: 'Bank CSV',
        tenantId: null,
        matchSignature: { headers: ['Date', 'Description', 'Amount'] },
        columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
        dateFormat: 'YYYY-MM-DD',
        amountStrategy: 'SINGLE',
        currencyDefault: 'USD',
        skipRows: 0,
        isActive: true,
      },
    ]);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.matched).toBe(true);
    expect(res._body.adapter.id).toBe(3);
    expect(res._body.adapter.name).toBe('Bank CSV');
    expect(res._body.confidence).toBeGreaterThan(0);
  });

  it('returns unmatched headers when no adapter matches', async () => {
    mockFormidableParse.mockImplementation((_req: any, cb: Function) => {
      cb(null, {}, {
        file: [{
          filepath: '/tmp/test.csv',
          originalFilename: 'test.csv',
          mimetype: 'text/csv',
        }],
      });
    });

    (fs.readFileSync as any).mockReturnValue('Foo,Bar,Baz\n1,2,3');

    (Papa.parse as any).mockReturnValue({
      meta: { fields: ['Foo', 'Bar', 'Baz'] },
      data: [{ Foo: '1', Bar: '2', Baz: '3' }],
    });

    // No adapters match these headers
    mockPrisma.importAdapter.findMany.mockResolvedValueOnce([
      {
        id: 3,
        name: 'Bank CSV',
        tenantId: null,
        matchSignature: { headers: ['Date', 'Description', 'Amount'] },
        isActive: true,
      },
    ]);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.matched).toBe(false);
    expect(res._body.headers).toEqual(['Foo', 'Bar', 'Baz']);
    expect(res._body.sampleData).toBeDefined();
  });
});

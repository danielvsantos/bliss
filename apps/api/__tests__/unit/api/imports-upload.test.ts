/**
 * Unit tests for POST /api/imports/upload
 *
 * This route uses formidable for multipart parsing, which makes direct
 * handler invocation tricky. We mock formidable to control the parsed output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockProduceEvent, mockFormidableParse, mockStorageAdapter } = vi.hoisted(() => ({
  mockPrisma: {
    importAdapter: { findFirst: vi.fn() },
    account: { findFirst: vi.fn() },
    stagedImport: { create: vi.fn() },
  },
  mockProduceEvent: vi.fn(),
  mockFormidableParse: vi.fn(),
  mockStorageAdapter: {
    uploadFile: vi.fn(),
  },
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

vi.mock('fs', () => ({
  default: { unlinkSync: vi.fn() },
  unlinkSync: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: () => 'mock-uuid',
}));

vi.mock('@bliss/shared/storage', () => ({
  createStorageAdapter: () => mockStorageAdapter,
}));

// Mock formidable: we call the parse callback with controlled args
vi.mock('formidable', () => {
  return {
    default: () => ({
      parse: mockFormidableParse,
    }),
  };
});

import handler from '../../../pages/api/imports/upload.js';

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

describe('POST /api/imports/upload', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('returns 400 without adapterId', async () => {
    // formidable calls back with fields that lack adapterId
    mockFormidableParse.mockImplementation((_req: any, cb: Function) => {
      cb(null, { accountId: ['10'] }, {
        file: [{ filepath: '/tmp/test.csv', originalFilename: 'test.csv', mimetype: 'text/csv' }],
      });
    });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'adapterId is required' });
  });

  it('creates StagedImport and fires event on valid upload', async () => {
    mockFormidableParse.mockImplementation((_req: any, cb: Function) => {
      cb(null, { adapterId: ['5'], accountId: ['10'] }, {
        file: [{ filepath: '/tmp/test.csv', originalFilename: 'test.csv', mimetype: 'text/csv' }],
      });
    });

    mockPrisma.importAdapter.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'Bank CSV',
      matchSignature: { headers: ['Date', 'Amount'] },
    });
    mockPrisma.account.findFirst.mockResolvedValueOnce({ id: 10 });
    mockStorageAdapter.uploadFile.mockResolvedValueOnce(undefined);
    mockPrisma.stagedImport.create.mockResolvedValueOnce({ id: 42 });
    mockProduceEvent.mockResolvedValueOnce(undefined);

    const req = makeReq();
    const res = makeRes();

    handler(req as NextApiRequest, res as unknown as NextApiResponse);

    // The handler uses a formidable callback which is async — wait for it to complete
    await vi.waitFor(() => {
      expect(res._status).toBe(202);
    }, { timeout: 2000 });

    expect(res._body).toEqual(
      expect.objectContaining({
        stagedImportId: 42,
        status: 'PROCESSING',
      }),
    );
    expect(mockPrisma.stagedImport.create).toHaveBeenCalled();
    expect(mockProduceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SMART_IMPORT_REQUESTED' }),
    );
  });

  it('validates accountId belongs to tenant', async () => {
    mockFormidableParse.mockImplementation((_req: any, cb: Function) => {
      cb(null, { adapterId: ['5'], accountId: ['999'] }, {
        file: [{ filepath: '/tmp/test.csv', originalFilename: 'test.csv', mimetype: 'text/csv' }],
      });
    });

    mockPrisma.importAdapter.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'Bank CSV',
      matchSignature: { headers: ['Date', 'Amount'] },
    });
    // Account not found for this tenant
    mockPrisma.account.findFirst.mockResolvedValueOnce(null);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Account not found or does not belong to your tenant' });
  });
});

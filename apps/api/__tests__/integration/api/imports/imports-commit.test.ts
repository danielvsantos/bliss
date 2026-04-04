/**
 * Integration tests for GET/POST /api/imports/[id] (commit + cancel)
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * withAuth, rate limiter, cors, Sentry, Prisma, and produceEvent are all
 * mocked so we can test the handler logic in isolation.
 *
 * The commit endpoint dispatches an async SMART_IMPORT_COMMIT event to the
 * backend worker — actual transaction creation, tag linking, and embedding
 * feedback are tested in the backend commitWorker tests (bliss-backend-service).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

// Mock rate limiter
vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

// Inject a test user via withAuth mock
const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

// Mock cors to no-op
vi.mock('../../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

// Mock Sentry
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

// Mock produceEvent
const { mockProduceEvent } = vi.hoisted(() => ({
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

// Mock Prisma — use vi.hoisted() so the object is available before vi.mock hoisting
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    stagedImport: { findFirst: vi.fn(), update: vi.fn() },
    stagedImportRow: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    transaction: { createMany: vi.fn(), findMany: vi.fn() },
    transactionTag: { createMany: vi.fn() },
    tag: { findFirst: vi.fn(), create: vi.fn() },
    category: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../../pages/api/imports/[id].js';

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
});

// ---------------------------------------------------------------------------
// Method validation
// ---------------------------------------------------------------------------

describe('Method validation', () => {
  it('PATCH returns 405', async () => {
    const req = makeReq({ method: 'PATCH', query: { id: 'import-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// POST without action
// ---------------------------------------------------------------------------

describe('POST without action', () => {
  it('returns 400 with "action query param required"', async () => {
    const req = makeReq({ method: 'POST', query: { id: 'import-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('action query param required');
  });
});

// ---------------------------------------------------------------------------
// POST ?action=commit (async dispatch)
// ---------------------------------------------------------------------------

describe('POST ?action=commit', () => {
  it('returns 404 when import not found', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValueOnce(null);

    const req = makeReq({ method: 'POST', query: { id: 'import-999', action: 'commit' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Import not found' });
  });

  it('returns 400 when import status is not READY', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'import-1',
      tenantId: 'test-tenant-123',
      status: 'PROCESSING',
    });

    const req = makeReq({ method: 'POST', query: { id: 'import-1', action: 'commit' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('PROCESSING');
    expect(res._body.error).toContain('READY');
  });

  it('dispatches SMART_IMPORT_COMMIT event and returns 202', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'import-1',
      tenantId: 'test-tenant-123',
      status: 'READY',
    });
    mockPrisma.stagedImport.update.mockResolvedValue({});

    const req = makeReq({ method: 'POST', query: { id: 'import-1', action: 'commit' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
    expect(res._body).toEqual({
      status: 'COMMITTING',
      message: 'Commit process started. Poll for progress.',
    });

    // Verify status was set to COMMITTING with progress reset
    expect(mockPrisma.stagedImport.update).toHaveBeenCalledWith({
      where: { id: 'import-1' },
      data: { status: 'COMMITTING', progress: 0 },
    });

    // Verify produceEvent was called with the correct event data
    expect(mockProduceEvent).toHaveBeenCalledWith({
      type: 'SMART_IMPORT_COMMIT',
      tenantId: 'test-tenant-123',
      userId: 'admin@test.com',
      stagedImportId: 'import-1',
    });
  });

  it('includes rowIds in event for partial commit', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'import-1',
      tenantId: 'test-tenant-123',
      status: 'READY',
    });
    mockPrisma.stagedImport.update.mockResolvedValue({});

    const req = makeReq({
      method: 'POST',
      query: { id: 'import-1', action: 'commit' },
      body: { rowIds: ['row-1', 'row-2'] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);

    // Verify produceEvent includes rowIds
    expect(mockProduceEvent).toHaveBeenCalledWith({
      type: 'SMART_IMPORT_COMMIT',
      tenantId: 'test-tenant-123',
      userId: 'admin@test.com',
      stagedImportId: 'import-1',
      rowIds: ['row-1', 'row-2'],
    });
  });

  it('does not include rowIds in event when body has no rowIds', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'import-1',
      tenantId: 'test-tenant-123',
      status: 'READY',
    });
    mockPrisma.stagedImport.update.mockResolvedValue({});

    const req = makeReq({
      method: 'POST',
      query: { id: 'import-1', action: 'commit' },
      body: {},
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);

    // Verify produceEvent was called WITHOUT rowIds
    const eventData = mockProduceEvent.mock.calls[0][0];
    expect(eventData).not.toHaveProperty('rowIds');
  });

  it('reverts status to READY if produceEvent fails', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'import-1',
      tenantId: 'test-tenant-123',
      status: 'READY',
    });
    mockPrisma.stagedImport.update.mockResolvedValue({});
    mockProduceEvent.mockRejectedValueOnce(new Error('Event dispatch failed'));

    const req = makeReq({ method: 'POST', query: { id: 'import-1', action: 'commit' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to start commit process' });

    // Verify status was reverted to READY
    const updateCalls = mockPrisma.stagedImport.update.mock.calls;
    const revertCall = updateCalls.find(
      (c: any) => c[0].data.status === 'READY' && c[0].data.progress === 100
    );
    expect(revertCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST ?action=cancel
// ---------------------------------------------------------------------------

describe('POST ?action=cancel', () => {
  it('returns 404 when import not found', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValueOnce(null);

    const req = makeReq({ method: 'POST', query: { id: 'import-999', action: 'cancel' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Import not found' });
  });

  it('returns 400 when import already committed', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'import-1',
      tenantId: 'test-tenant-123',
      status: 'COMMITTED',
    });

    const req = makeReq({ method: 'POST', query: { id: 'import-1', action: 'cancel' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Cannot cancel a committed import' });
  });

  it('returns 200 { cancelled: true } on success', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValueOnce({
      id: 'import-1',
      tenantId: 'test-tenant-123',
      status: 'READY',
    });
    mockPrisma.stagedImport.update.mockResolvedValueOnce({});

    const req = makeReq({ method: 'POST', query: { id: 'import-1', action: 'cancel' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ cancelled: true });

    // Verify status was updated to CANCELLED
    expect(mockPrisma.stagedImport.update).toHaveBeenCalledWith({
      where: { id: 'import-1' },
      data: { status: 'CANCELLED' },
    });
  });
});

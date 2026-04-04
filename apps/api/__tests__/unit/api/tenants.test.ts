/**
 * Unit tests for /api/tenants
 *
 * Mocked handler pattern: withAuth, cors, rateLimit, Sentry, Prisma,
 * and produceEvent are all mocked so we test handler logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

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

const { mockPrisma, mockProduceEvent } = vi.hoisted(() => ({
  mockPrisma: {
    tenant: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    account: { findMany: vi.fn() },
    portfolioItem: { findMany: vi.fn() },
    accountOwner: { deleteMany: vi.fn() },
    debtTerms: { deleteMany: vi.fn() },
    portfolioHolding: { deleteMany: vi.fn() },
    portfolioValueHistory: { deleteMany: vi.fn() },
    transactionEmbedding: { deleteMany: vi.fn() },
    stagedImport: { deleteMany: vi.fn() },
    importAdapter: { deleteMany: vi.fn() },
    tag: { findMany: vi.fn() },
    transactionTag: { deleteMany: vi.fn() },
    transaction: { deleteMany: vi.fn() },
    descriptionMapping: { deleteMany: vi.fn() },
    category: { deleteMany: vi.fn() },
    analyticsCacheMonthly: { deleteMany: vi.fn() },
    insight: { deleteMany: vi.fn() },
    tenantCountry: { deleteMany: vi.fn() },
    tenantCurrency: { deleteMany: vi.fn() },
    tenantBank: { deleteMany: vi.fn() },
    plaidItem: { deleteMany: vi.fn() },
    user: { deleteMany: vi.fn() },
    country: { findMany: vi.fn() },
    currency: { findMany: vi.fn() },
    bank: { findMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

import handler from '../../../pages/api/tenants.js';

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

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTenantWithRelations(overrides: Record<string, any> = {}) {
  return {
    id: 'test-tenant-123',
    name: 'My Tenant',
    plan: 'free',
    portfolioCurrency: 'USD',
    countries: [{ country: { id: 'US', name: 'United States' }, isDefault: true }],
    currencies: [{ currency: { id: 'USD', name: 'US Dollar' }, isDefault: true }],
    tenantBanks: [{ bank: { id: 1, name: 'Chase' } }],
    plaidItems: [{ bankId: 1 }],
    transactionYearsRaw: [{ year: 2025 }, { year: 2026 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/tenants', () => {
  it('returns tenant data with relations', async () => {
    const tenant = makeTenantWithRelations();
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ year: 2025 }, { year: 2026 }]);
    mockPrisma.tenant.findUnique.mockResolvedValueOnce(tenant);

    const req = makeReq({ method: 'GET', query: { id: 'test-tenant-123' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    // Transformed data should have flattened countries, currencies, banks
    expect(res._body.countries).toEqual([{ id: 'US', name: 'United States', isDefault: true }]);
    expect(res._body.currencies).toEqual([{ id: 'USD', name: 'US Dollar', isDefault: true }]);
    expect(res._body.banks).toEqual([{ id: 1, name: 'Chase' }]);
    expect(res._body.transactionYears).toEqual([2025, 2026]);
    expect(res._body.plaidLinkedBankIds).toEqual([1]);
  });
});

describe('PUT /api/tenants', () => {
  it('updates tenant name', async () => {
    // originalTenantState fetch
    mockPrisma.tenant.findUnique
      .mockResolvedValueOnce({ id: 'test-tenant-123', portfolioCurrency: 'USD', currencies: [{ currencyId: 'USD' }] })
      .mockResolvedValueOnce({ id: 'test-tenant-123' }); // exists check

    const updatedTenant = makeTenantWithRelations({ name: 'Updated Name' });
    mockPrisma.$transaction.mockResolvedValueOnce(updatedTenant);

    const req = makeReq({
      method: 'PUT',
      query: { id: 'test-tenant-123' },
      body: { name: 'Updated Name' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.name).toBe('Updated Name');
    // No currency change, so no event
    expect(mockProduceEvent).not.toHaveBeenCalled();
  });

  it('updates currencies and fires TENANT_CURRENCY_SETTINGS_UPDATED event', async () => {
    // originalTenantState fetch — original has USD only
    mockPrisma.tenant.findUnique
      .mockResolvedValueOnce({ id: 'test-tenant-123', portfolioCurrency: 'USD', currencies: [{ currencyId: 'USD' }] })
      .mockResolvedValueOnce({ id: 'test-tenant-123' }); // exists check

    // Validate currencies
    mockPrisma.currency.findMany.mockResolvedValueOnce([
      { id: 'USD' }, { id: 'EUR' },
    ]);
    mockPrisma.country.findMany.mockResolvedValueOnce([]);
    mockPrisma.bank.findMany.mockResolvedValueOnce([]);

    const updatedTenant = makeTenantWithRelations({
      currencies: [
        { currency: { id: 'USD', name: 'US Dollar' }, isDefault: true },
        { currency: { id: 'EUR', name: 'Euro' }, isDefault: false },
      ],
    });
    mockPrisma.$transaction.mockResolvedValueOnce(updatedTenant);

    const req = makeReq({
      method: 'PUT',
      query: { id: 'test-tenant-123' },
      body: { currencies: ['USD', 'EUR'] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    // Currencies changed from [USD] to [EUR, USD], so event should fire
    expect(mockProduceEvent).toHaveBeenCalledWith({
      type: 'TENANT_CURRENCY_SETTINGS_UPDATED',
      tenantId: 'test-tenant-123',
    });
  });
});

describe('DELETE /api/tenants', () => {
  it('cascades tenant deletion', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ id: 'test-tenant-123' });

    // Build a mock tx where every model has findMany/deleteMany/delete
    const mockDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const mockFindMany = vi.fn().mockResolvedValue([]);
    const mockDelete = vi.fn().mockResolvedValue({});
    const txProxy = new Proxy({} as Record<string, any>, {
      get: (_target, prop) => ({
        findMany: mockFindMany,
        deleteMany: mockDeleteMany,
        delete: mockDelete,
      }),
    });

    mockPrisma.$transaction.mockImplementationOnce(async (fn: any) => fn(txProxy));

    const req = makeReq({ method: 'DELETE', query: { id: 'test-tenant-123' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(204);
  });
});

describe('Method validation', () => {
  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'PUT', 'DELETE']);
  });
});

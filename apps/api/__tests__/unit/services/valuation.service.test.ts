import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

// Stable mock refs that survive vi.resetModules() (needed by the tests that
// re-import the service to pick up a different BACKEND_URL).
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('axios', () => ({ default: { get: mockGet } }));
vi.mock('../../../prisma/prisma.js', () => ({ default: {} }));

import { calculateAssetCurrentValue } from '../../../services/valuation.service.js';

describe('valuation.service — calculateAssetCurrentValue', () => {
  beforeEach(() => {
    mockGet.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    delete process.env.BACKEND_URL;
    delete process.env.INTERNAL_BACKEND_API_URL;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('fetches the price from BACKEND_URL/api/pricing/prices with the x-api-key header', async () => {
    mockGet.mockResolvedValue({ data: { price: '123.45' } });

    const value = await calculateAssetCurrentValue({
      id: 1,
      symbol: 'MSFT',
      currency: 'USD',
      category: { processingHint: 'API_STOCK' },
    });

    expect(value.toString()).toBe('123.45');
    expect(mockGet).toHaveBeenCalledOnce();
    const [url, options] = mockGet.mock.calls[0];
    // Default fallback when BACKEND_URL is unset.
    expect(url).toContain('http://localhost:3001/api/pricing/prices');
    expect(url).toContain('symbol=MSFT');
    expect(options.headers['x-api-key']).toBe('test-internal-api-key');
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('targets BACKEND_URL when it is set', async () => {
    vi.resetModules();
    process.env.BACKEND_URL = 'http://bliss-backend-service.railway.internal:8080';
    const { calculateAssetCurrentValue: fn } = await import('../../../services/valuation.service.js');

    mockGet.mockResolvedValue({ data: { price: '10' } });
    await fn({ id: 2, symbol: 'AAPL', category: {} });

    expect(mockGet.mock.calls[0][0]).toContain(
      'http://bliss-backend-service.railway.internal:8080/api/pricing/prices',
    );
  });

  it('ignores the removed INTERNAL_BACKEND_API_URL variable', async () => {
    vi.resetModules();
    process.env.INTERNAL_BACKEND_API_URL = 'http://should-not-be-used:9999';
    const { calculateAssetCurrentValue: fn } = await import('../../../services/valuation.service.js');

    mockGet.mockResolvedValue({ data: { price: '1' } });
    await fn({ id: 3, symbol: 'X', category: {} });

    const url = mockGet.mock.calls[0][0];
    expect(url).toContain('http://localhost:3001/');
    expect(url).not.toContain('should-not-be-used');
  });

  it('returns 1 for cash assets without calling the backend', async () => {
    const value = await calculateAssetCurrentValue({ id: 4, category: { type: 'Cash' } });

    expect(value.toString()).toBe('1');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('falls back to cost basis per unit and reports to Sentry when the backend call fails', async () => {
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const value = await calculateAssetCurrentValue({
      id: 5,
      symbol: 'NFLX',
      category: {},
      costBasis: '1000',
      quantity: 4,
    });

    expect(value.toString()).toBe('250');
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledOnce();
  });

  it('falls back to cost basis without reporting to Sentry when the backend has no price (404)', async () => {
    mockGet.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), {
        isAxiosError: true,
        response: { status: 404, data: { error: 'Price not found for symbol PREIPO' } },
      }),
    );

    const value = await calculateAssetCurrentValue({
      id: 6,
      symbol: 'PREIPO',
      category: { processingHint: 'API_STOCK' },
      costBasis: '300',
      quantity: 3,
    });

    expect(value.toString()).toBe('100');
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
    expect(vi.mocked(Sentry.addBreadcrumb)).toHaveBeenCalledOnce();
  });

  it('still reports to Sentry when the backend answers 5xx', async () => {
    mockGet.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 500'), {
        isAxiosError: true,
        response: { status: 500, data: {} },
      }),
    );

    const value = await calculateAssetCurrentValue({
      id: 7,
      symbol: 'MSFT',
      category: { processingHint: 'API_STOCK' },
      costBasis: '50',
      quantity: 1,
    });

    expect(value.toString()).toBe('50');
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledOnce();
  });

  it('still reports to Sentry when the backend call times out', async () => {
    mockGet.mockRejectedValue(
      Object.assign(new Error('timeout of 10000ms exceeded'), {
        isAxiosError: true,
        code: 'ECONNABORTED',
      }),
    );

    await calculateAssetCurrentValue({ id: 8, symbol: 'MSFT', category: {}, costBasis: '10' });

    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledOnce();
  });
});

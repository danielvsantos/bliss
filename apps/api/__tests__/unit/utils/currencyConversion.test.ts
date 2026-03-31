import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';

vi.mock('../../../prisma/prisma.js', () => ({
  default: {
    currencyRate: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import prisma from '../../../prisma/prisma.js';
import { convertCurrency, batchFetchRates } from '../../../utils/currencyConversion.js';

const mockFindUnique = vi.mocked(prisma.currencyRate.findUnique);
const mockFindMany = vi.mocked(prisma.currencyRate.findMany);

beforeEach(() => {
  mockFindUnique.mockReset();
  mockFindMany.mockReset();
});

describe('convertCurrency()', () => {
  it('returns same amount as Decimal when fromCurrency === toCurrency', async () => {
    const result = await convertCurrency(100, 'USD', 'USD');

    expect(result).toBeInstanceOf(Decimal);
    expect(result!.toNumber()).toBe(100);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('converts using direct rate from DB', async () => {
    const date = new Date(2025, 5, 15); // June 15, 2025

    mockFindUnique.mockResolvedValueOnce({
      value: new Decimal(0.85),
    } as any);

    const result = await convertCurrency(100, 'USD', 'EUR', date);

    expect(result).toBeInstanceOf(Decimal);
    expect(result!.toNumber()).toBe(85);

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: {
        year_month_day_currencyFrom_currencyTo: {
          year: 2025,
          month: 6,
          day: 15,
          currencyFrom: 'USD',
          currencyTo: 'EUR',
        },
      },
    });
  });

  it('returns null when no rate found within lookback window', async () => {
    // findUnique returns null for all 16 calls (8 days x 2 directions)
    mockFindUnique.mockResolvedValue(null as any);

    const date = new Date(2025, 5, 15);
    const result = await convertCurrency(50, 'USD', 'JPY', date);

    expect(result).toBeNull();
    // 8 days (0..7) x 2 calls per day (direct + inverse) = 16 calls
    expect(mockFindUnique).toHaveBeenCalledTimes(16);
  });

  it('uses inverse rate when direct rate not found', async () => {
    const date = new Date(2025, 5, 15);

    // First call: direct USD->EUR — not found
    mockFindUnique.mockResolvedValueOnce(null as any);
    // Second call: inverse EUR->USD — found
    mockFindUnique.mockResolvedValueOnce({
      value: new Decimal(1.18),
    } as any);

    const result = await convertCurrency(100, 'USD', 'EUR', date);

    expect(result).toBeInstanceOf(Decimal);
    // 1 / 1.18 * 100
    const expected = new Decimal(1).dividedBy(new Decimal(1.18)).times(100);
    expect(result!.toFixed(10)).toBe(expected.toFixed(10));

    // Should have called findUnique exactly twice: direct then inverse
    expect(mockFindUnique).toHaveBeenCalledTimes(2);

    // Second call should query inverse pair
    expect(mockFindUnique).toHaveBeenNthCalledWith(2, {
      where: {
        year_month_day_currencyFrom_currencyTo: {
          year: 2025,
          month: 6,
          day: 15,
          currencyFrom: 'EUR',
          currencyTo: 'USD',
        },
      },
    });
  });

  it('finds rate via forward-fill lookback (not exact date, but within 7 days)', async () => {
    const date = new Date(2025, 5, 15); // June 15

    // Day 0 (June 15): direct null, inverse null
    mockFindUnique.mockResolvedValueOnce(null as any); // direct day 0
    mockFindUnique.mockResolvedValueOnce(null as any); // inverse day 0
    // Day 1 (June 14): direct null, inverse null
    mockFindUnique.mockResolvedValueOnce(null as any); // direct day 1
    mockFindUnique.mockResolvedValueOnce(null as any); // inverse day 1
    // Day 2 (June 13): direct found
    mockFindUnique.mockResolvedValueOnce({
      value: new Decimal(0.92),
    } as any);

    const result = await convertCurrency(200, 'USD', 'EUR', date);

    expect(result).toBeInstanceOf(Decimal);
    expect(result!.toNumber()).toBe(184); // 200 * 0.92

    // 5 calls total: 2 per day for days 0-1, then 1 direct hit on day 2
    expect(mockFindUnique).toHaveBeenCalledTimes(5);

    // The 5th call should be for June 13 (date - 2 days)
    expect(mockFindUnique).toHaveBeenNthCalledWith(5, {
      where: {
        year_month_day_currencyFrom_currencyTo: {
          year: 2025,
          month: 6,
          day: 13,
          currencyFrom: 'USD',
          currencyTo: 'EUR',
        },
      },
    });
  });
});

describe('batchFetchRates()', () => {
  it('returns Map with Decimal(1) for all dates when from === to', async () => {
    const dates = ['2025-06-10', '2025-06-11', '2025-06-12'];

    const result = await batchFetchRates('USD', 'USD', dates);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(3);

    for (const ds of dates) {
      const val = result.get(ds);
      expect(val).toBeInstanceOf(Decimal);
      expect(val!.toNumber()).toBe(1);
    }

    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('returns Map with converted rates for multiple dates', async () => {
    const dates = ['2025-06-10', '2025-06-11'];

    mockFindMany.mockResolvedValueOnce([
      {
        year: 2025,
        month: 6,
        day: 10,
        currencyFrom: 'USD',
        currencyTo: 'EUR',
        value: new Decimal(0.85),
      },
      {
        year: 2025,
        month: 6,
        day: 11,
        currencyFrom: 'USD',
        currencyTo: 'EUR',
        value: new Decimal(0.86),
      },
    ] as any);

    const result = await batchFetchRates('USD', 'EUR', dates);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);

    const rate1 = result.get('2025-06-10');
    expect(rate1).toBeInstanceOf(Decimal);
    expect(rate1!.toNumber()).toBe(0.85);

    const rate2 = result.get('2025-06-11');
    expect(rate2).toBeInstanceOf(Decimal);
    expect(rate2!.toNumber()).toBe(0.86);

    expect(mockFindMany).toHaveBeenCalledOnce();
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { currencyFrom: 'USD', currencyTo: 'EUR' },
            { currencyFrom: 'EUR', currencyTo: 'USD' },
          ],
        }),
        orderBy: [{ year: 'desc' }, { month: 'desc' }, { day: 'desc' }],
      }),
    );
  });
});

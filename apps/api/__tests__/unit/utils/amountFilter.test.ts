import { describe, it, expect } from 'vitest';
import { parseAmountRange } from '../../../utils/amountFilter.js';

describe('parseAmountRange (#141)', () => {
  it('returns no clause when neither bound is set', () => {
    expect(parseAmountRange({})).toEqual({ where: null, amountMin: null, amountMax: null });
    expect(parseAmountRange({ amountMin: '', amountMax: undefined })).toEqual({ where: null, amountMin: null, amountMax: null });
  });

  it('turns an exact amount into a half-cent window over credit OR debit', () => {
    const r = parseAmountRange({ amountMin: '2003.76', amountMax: '2003.76' }) as any;
    expect(r.amountMin).toBe(2003.76);
    expect(r.amountMax).toBe(2003.76);
    const [credit, debit] = r.where.OR;
    expect(credit.credit).toEqual(debit.debit);
    expect(credit.credit.gte).toBeCloseTo(2003.755, 6);
    expect(credit.credit.lt).toBeCloseTo(2003.765, 6);
  });

  it('leaves a missing bound open', () => {
    const minOnly = parseAmountRange({ amountMin: '100' }) as any;
    expect(minOnly.where.OR[0].credit).toEqual({ gte: 99.995 });
    const maxOnly = parseAmountRange({ amountMax: '200' }) as any;
    expect(maxOnly.where.OR[1].debit.lt).toBeCloseTo(200.005, 6);
    expect(maxOnly.where.OR[1].debit.gte).toBeUndefined();
  });

  it('never makes the lower bound negative', () => {
    const r = parseAmountRange({ amountMin: '0' }) as any;
    expect(r.where.OR[0].credit).toEqual({ gte: 0 });
  });

  it('rounds inputs half-up to cents', () => {
    expect((parseAmountRange({ amountMin: '10.005' }) as any).amountMin).toBe(10.01);
    expect((parseAmountRange({ amountMin: '10.004' }) as any).amountMin).toBe(10);
  });

  it('takes the first value of a repeated query parameter', () => {
    expect((parseAmountRange({ amountMin: ['5', '9'] }) as any).amountMin).toBe(5);
  });

  it.each([
    [{ amountMin: '-1' }, 'amountMin must be a non-negative number.'],
    [{ amountMax: 'abc' }, 'amountMax must be a non-negative number.'],
    [{ amountMin: '1e3' }, 'amountMin must be a non-negative number.'],
    [{ amountMax: 'Infinity' }, 'amountMax must be a non-negative number.'],
    [{ amountMin: '200', amountMax: '100' }, 'amountMin cannot be greater than amountMax.'],
  ])('rejects %o', (query, error) => {
    expect(parseAmountRange(query)).toEqual({ error });
  });

  it('compares bounds after rounding', () => {
    // 10.004 and 10.001 both round to 10.00, so they are not min > max.
    expect((parseAmountRange({ amountMin: '10.004', amountMax: '10.001' }) as any).error).toBeUndefined();
  });
});

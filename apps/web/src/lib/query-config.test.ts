import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  PORTFOLIO_STALE_TIME_MS,
  PORTFOLIO_PERSIST_MAX_BYTES,
  PORTFOLIO_QUERY_KEY_ROOTS,
  shouldPersistPortfolioQuery,
  invalidatePortfolioQueries,
} from './query-config';

type PersistCandidate = Parameters<typeof shouldPersistPortfolioQuery>[0];

const makeQuery = (
  root: unknown,
  status: string,
  data: unknown,
): PersistCandidate => ({
  queryKey: [root, { some: 'filter' }],
  state: { status, data },
});

describe('query-config constants', () => {
  it('exposes a 3-minute portfolio stale time', () => {
    expect(PORTFOLIO_STALE_TIME_MS).toBe(180_000);
  });

  it('lists exactly the four portfolio query roots', () => {
    expect([...PORTFOLIO_QUERY_KEY_ROOTS]).toEqual([
      'portfolio-items',
      'portfolio-holdings',
      'portfolio-history',
      'equity-analysis',
    ]);
  });
});

describe('shouldPersistPortfolioQuery', () => {
  it('persists a whitelisted, successful, small-payload query', () => {
    expect(
      shouldPersistPortfolioQuery(makeQuery('portfolio-items', 'success', { items: [1, 2, 3] })),
    ).toBe(true);
  });

  it.each([...PORTFOLIO_QUERY_KEY_ROOTS])('persists the "%s" root', (root) => {
    expect(shouldPersistPortfolioQuery(makeQuery(root, 'success', { ok: true }))).toBe(true);
  });

  it('does not persist a non-whitelisted root', () => {
    expect(shouldPersistPortfolioQuery(makeQuery('transactions', 'success', { rows: [] }))).toBe(
      false,
    );
  });

  it('does not persist a query that has not resolved successfully', () => {
    expect(shouldPersistPortfolioQuery(makeQuery('portfolio-items', 'pending', undefined))).toBe(
      false,
    );
    expect(shouldPersistPortfolioQuery(makeQuery('portfolio-items', 'error', undefined))).toBe(
      false,
    );
  });

  it('does not persist a payload over the size cap', () => {
    const huge = { blob: 'x'.repeat(PORTFOLIO_PERSIST_MAX_BYTES + 1) };
    expect(shouldPersistPortfolioQuery(makeQuery('portfolio-history', 'success', huge))).toBe(false);
  });

  it('does not persist a non-serializable payload', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(
      shouldPersistPortfolioQuery(makeQuery('portfolio-items', 'success', circular)),
    ).toBe(false);
  });

  it('ignores a non-string query key root', () => {
    expect(shouldPersistPortfolioQuery(makeQuery(42, 'success', {}))).toBe(false);
  });
});

describe('invalidatePortfolioQueries', () => {
  it('invalidates every portfolio root exactly once', () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');

    invalidatePortfolioQueries(client);

    expect(spy).toHaveBeenCalledTimes(PORTFOLIO_QUERY_KEY_ROOTS.length);
    for (const root of PORTFOLIO_QUERY_KEY_ROOTS) {
      expect(spy).toHaveBeenCalledWith({ queryKey: [root] });
    }
  });
});

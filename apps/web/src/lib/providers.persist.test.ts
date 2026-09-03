import { describe, it, expect } from 'vitest';
import { QueryClient, dehydrate, hydrate } from '@tanstack/react-query';
import {
  PORTFOLIO_PERSIST_MAX_BYTES,
  shouldPersistPortfolioQuery,
} from './query-config';

/**
 * Mirrors the `shouldDehydrateQuery` predicate wired up in `providers.tsx`, so
 * this test exercises the exact persistence gate used in production.
 */
const shouldDehydrateQuery = (query: Parameters<typeof shouldPersistPortfolioQuery>[0]) =>
  query.queryKey[0] === 'metadata' ||
  query.queryKey[0] === 'accounts' ||
  shouldPersistPortfolioQuery(query);

const seedQuery = (client: QueryClient, key: readonly unknown[], data: unknown) => {
  client.setQueryData(key, data);
};

describe('portfolio query persistence (dehydrate → hydrate round-trip)', () => {
  it('restores a small portfolio-items query on cold start (instant paint)', () => {
    const source = new QueryClient();
    const payload = { portfolioCurrency: 'USD', items: [{ id: 1, name: 'Apple' }] };
    seedQuery(source, ['portfolio-items', {}], payload);

    const dehydrated = dehydrate(source, { shouldDehydrateQuery });

    const restored = new QueryClient();
    hydrate(restored, dehydrated);

    expect(restored.getQueryData(['portfolio-items', {}])).toEqual(payload);
  });

  it('persists all four portfolio roots plus metadata / accounts', () => {
    const source = new QueryClient();
    seedQuery(source, ['portfolio-items', {}], { items: [] });
    seedQuery(source, ['portfolio-holdings', {}], []);
    seedQuery(source, ['portfolio-history', {}], { history: [] });
    seedQuery(source, ['equity-analysis'], { groups: [] });
    seedQuery(source, ['metadata'], { ok: true });
    seedQuery(source, ['accounts'], []);
    seedQuery(source, ['transactions', { page: 1 }], { rows: [] });

    const dehydrated = dehydrate(source, { shouldDehydrateQuery });
    const persistedKeys = dehydrated.queries.map((q) => q.queryKey[0]);

    expect(persistedKeys).toEqual(
      expect.arrayContaining([
        'portfolio-items',
        'portfolio-holdings',
        'portfolio-history',
        'equity-analysis',
        'metadata',
        'accounts',
      ]),
    );
    // Non-whitelisted queries stay out of localStorage.
    expect(persistedKeys).not.toContain('transactions');
  });

  it('skips a portfolio payload over the size cap but still hydrates the rest', () => {
    const source = new QueryClient();
    const huge = { blob: 'x'.repeat(PORTFOLIO_PERSIST_MAX_BYTES + 1) };
    seedQuery(source, ['portfolio-holdings', {}], huge);
    seedQuery(source, ['portfolio-items', {}], { items: [{ id: 7 }] });

    const dehydrated = dehydrate(source, { shouldDehydrateQuery });
    const persistedKeys = dehydrated.queries.map((q) => q.queryKey[0]);

    expect(persistedKeys).not.toContain('portfolio-holdings');
    expect(persistedKeys).toContain('portfolio-items');

    const restored = new QueryClient();
    expect(() => hydrate(restored, dehydrated)).not.toThrow();
    expect(restored.getQueryData(['portfolio-items', {}])).toEqual({ items: [{ id: 7 }] });
    expect(restored.getQueryData(['portfolio-holdings', {}])).toBeUndefined();
  });
});

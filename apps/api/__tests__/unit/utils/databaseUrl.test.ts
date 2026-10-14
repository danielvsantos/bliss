import { describe, it, expect } from 'vitest';
import { withPoolDefaults, API_DEFAULT_CONNECTION_LIMIT } from '../../../utils/databaseUrl.js';

describe('withPoolDefaults()', () => {
  it('adds connection_limit and pool_timeout when absent', () => {
    const url = withPoolDefaults('postgresql://u:p@db:5432/bliss', {
      connectionLimit: API_DEFAULT_CONNECTION_LIMIT,
    });
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('connection_limit')).toBe(String(API_DEFAULT_CONNECTION_LIMIT));
    expect(parsed.searchParams.get('pool_timeout')).toBe('20');
    expect(parsed.pathname).toBe('/bliss');
  });

  it('never overrides an explicit value and keeps other params', () => {
    const url = withPoolDefaults('postgres://u:p@db:5432/bliss?sslmode=require&connection_limit=3', {
      connectionLimit: 10,
    });
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('connection_limit')).toBe('3');
    expect(parsed.searchParams.get('sslmode')).toBe('require');
  });

  it('returns non-Postgres and missing URLs unchanged', () => {
    expect(withPoolDefaults(undefined, { connectionLimit: 5 })).toBeUndefined();
    expect(withPoolDefaults('prisma://accelerate.prisma-data.net/?api_key=x', { connectionLimit: 5 }))
      .toBe('prisma://accelerate.prisma-data.net/?api_key=x');
  });
});

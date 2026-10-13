const fs = require('fs');
const path = require('path');
const { withPoolDefaults, defaultBackendConnectionLimit } = require('../../../utils/databaseUrl');

describe('withPoolDefaults', () => {
  it('adds connection_limit and pool_timeout when absent', () => {
    const url = withPoolDefaults('postgresql://u:p@db:5432/bliss', { connectionLimit: 10 });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('connection_limit')).toBe('10');
    expect(parsed.searchParams.get('pool_timeout')).toBe('20');
    expect(parsed.hostname).toBe('db');
    expect(parsed.pathname).toBe('/bliss');
  });

  it('never overrides an explicit value and keeps other params', () => {
    const url = withPoolDefaults(
      'postgres://u:p@db:5432/bliss?sslmode=require&connection_limit=3',
      { connectionLimit: 10, poolTimeout: 30 },
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('connection_limit')).toBe('3');
    expect(parsed.searchParams.get('pool_timeout')).toBe('30');
    expect(parsed.searchParams.get('sslmode')).toBe('require');
  });

  it('keeps an encoded password intact', () => {
    const url = withPoolDefaults('postgresql://u:p%40ss%2Fw@db:5432/bliss', { connectionLimit: 5 });
    expect(new URL(url).password).toBe('p%40ss%2Fw');
  });

  it('returns non-Postgres and missing URLs unchanged', () => {
    expect(withPoolDefaults(undefined, { connectionLimit: 5 })).toBeUndefined();
    expect(withPoolDefaults('', { connectionLimit: 5 })).toBe('');
    expect(withPoolDefaults('prisma://accelerate.prisma-data.net/?api_key=x', { connectionLimit: 5 }))
      .toBe('prisma://accelerate.prisma-data.net/?api_key=x');
  });
});

describe('defaultBackendConnectionLimit', () => {
  it('gives the HTTP-only instance a smaller pool than workers', () => {
    expect(defaultBackendConnectionLimit('web')).toBe(5);
    expect(defaultBackendConnectionLimit('worker')).toBe(10);
    expect(defaultBackendConnectionLimit('all')).toBe(10);
    expect(defaultBackendConnectionLimit(undefined)).toBe(10);
  });
});

// #135: a second PrismaClient in currencyService.js doubled the backend's pool.
describe('one PrismaClient per backend process', () => {
  function listJsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : listJsFiles(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  it('only prisma/prisma.js constructs a PrismaClient', () => {
    const srcDir = path.resolve(__dirname, '../../..');
    const offenders = listJsFiles(srcDir)
      .filter((file) => /new\s+PrismaClient\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcDir, file));
    expect(offenders).toEqual([]);
  });
});
